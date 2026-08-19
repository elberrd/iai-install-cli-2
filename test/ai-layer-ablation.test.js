import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { buildAblationPlan, executeAblation } from '../scripts/ai-layer-ablate.mjs';

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'ai-layer-ablate-'));
  const files = {
    'CLAUDE.md': '# Always loaded\n',
    'packages/api/CLAUDE.md': '# Conditional nested instructions\n',
    '.claude/rules/global.md': '# Global rule\n',
    '.claude/rules/scoped.md': '---\npaths:\n  - "src/**/*.js"\n---\nConditional rule.\n',
    '.agents/skills/demo/SKILL.md': '---\nname: demo\ndescription: demo skill\n---\n',
    '.claude/settings.json': '{"hooks":{}}\n',
    '.pi/extensions/guard.md': '# Deterministic enforcement\n',
    'task.md': 'Create the requested result.\n',
    'runner.mjs': [
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
      "const task = readFileSync(0, 'utf8').trim();",
      "const observed = [`task=${task}`, `claude=${existsSync('CLAUDE.md')}`, `global=${existsSync('.claude/rules/global.md')}`, `scoped=${existsSync('.claude/rules/scoped.md')}`, `nested=${existsSync('packages/api/CLAUDE.md')}`, `enforcement=${existsSync('.claude/settings.json')}`, `extension=${existsSync('.pi/extensions/guard.md')}`];",
      "writeFileSync('observed.txt', observed.join('\\n') + '\\n');",
      "process.stdout.write('runner-ok\\n');",
      '',
    ].join('\n'),
  };
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  git(root, ['init']);
  git(root, ['config', 'user.email', 'ablation@example.test']);
  git(root, ['config', 'user.name', 'Ablation Test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'fixture']);
  return root;
}

test('dry-run plans two arms, preserves enforcement and creates no worktree', () => {
  const root = repository();
  const before = git(root, ['worktree', 'list', '--porcelain']);
  const plan = buildAblationPlan({
    dir: root,
    task: join(root, 'task.md'),
    runnerBin: process.execPath,
    runnerArgs: [join(root, 'runner.mjs')],
    runs: 2,
  });
  assert.equal(plan.mode, 'dry-run');
  assert.equal(plan.arms.length, 2);
  assert.deepEqual(plan.arms[0].stripped, []);
  assert.ok(plan.arms[1].stripped.includes('CLAUDE.md'));
  assert.ok(plan.arms[1].stripped.includes('.claude/rules/global.md'));
  assert.ok(!plan.arms[1].stripped.includes('.claude/rules/scoped.md'));
  assert.ok(!plan.arms[1].stripped.includes('packages/api/CLAUDE.md'));
  assert.ok(!plan.arms[1].stripped.includes('.claude/settings.json'));
  assert.equal(plan.enforcement_preserved, true);
  assert.equal(plan.layer_source, 'committed-head');
  assert.equal(plan.execution_order.strategy, 'deterministic-alternating-blind-labels-v1');
  assert.deepEqual(
    plan.execution_order.trials.map(({ run, position, arm }) => ({ run, position, arm })),
    [
      { run: 1, position: 1, arm: 'arm-a' },
      { run: 1, position: 2, arm: 'arm-b' },
      { run: 2, position: 1, arm: 'arm-b' },
      { run: 2, position: 2, arm: 'arm-a' },
    ],
  );
  assert.equal(git(root, ['worktree', 'list', '--porcelain']), before);
});

test('execute runs both blind arms twice, cleans worktrees and leaves source unchanged', () => {
  const root = repository();
  const out = mkdtempSync(join(tmpdir(), 'ai-layer-results-parent-'));
  const resultDir = join(out, 'results');
  const beforeStatus = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  const beforeWorktrees = git(root, ['worktree', 'list', '--porcelain']);

  const report = executeAblation({
    dir: root,
    task: join(root, 'task.md'),
    runnerBin: process.execPath,
    runnerArgs: [join(root, 'runner.mjs')],
    runs: 2,
    out: resultDir,
    timeoutMs: 30_000,
  });

  assert.equal(report.blind_results.length, 4);
  assert.equal(report.valid, true);
  assert.deepEqual(report.runner_failures, []);
  assert.equal(report.source_unchanged, true);
  assert.deepEqual(new Set(report.blind_results.map((item) => item.run)), new Set([1, 2]));
  assert.ok(report.blind_results.every((item) => item.exit_code === 0));
  assert.deepEqual(
    report.blind_results.map(({ sequence, run, position, arm }) => ({ sequence, run, position, arm })),
    report.execution_order.trials,
  );
  assert.notEqual(report.execution_order.trials[0].arm, report.execution_order.trials[2].arm);
  assert.equal(git(root, ['status', '--porcelain=v1', '--untracked-files=all']), beforeStatus);
  assert.equal(git(root, ['worktree', 'list', '--porcelain']), beforeWorktrees);

  const key = JSON.parse(readFileSync(join(resultDir, 'answer-key.json'), 'utf8'));
  const control = key.labels.control;
  const stripped = key.labels['always-loaded-stripped'];
  assert.deepEqual(
    key.logical_execution_order.trials.map((trial) => key.labels[trial.arm]),
    report.execution_order.trials.map((trial) => trial.arm),
  );
  for (let run = 1; run <= 2; run++) {
    const suffix = `run-${String(run).padStart(2, '0')}.diff`;
    const controlDiff = readFileSync(join(resultDir, 'blind', control, suffix), 'utf8');
    const strippedDiff = readFileSync(join(resultDir, 'blind', stripped, suffix), 'utf8');
    assert.match(controlDiff, /claude=true/);
    assert.match(strippedDiff, /claude=false/);
    assert.match(controlDiff, /global=true/);
    assert.match(strippedDiff, /global=false/);
    assert.match(controlDiff, /scoped=true/);
    assert.match(strippedDiff, /scoped=true/);
    assert.match(controlDiff, /nested=true/);
    assert.match(strippedDiff, /nested=true/);
    assert.match(controlDiff, /enforcement=true/);
    assert.match(strippedDiff, /enforcement=true/);
    assert.match(controlDiff, /extension=true/);
    assert.match(strippedDiff, /extension=true/);
    assert.doesNotMatch(strippedDiff, /deleted file mode.*CLAUDE\.md/s);
  }
  assert.ok(existsSync(join(resultDir, 'manifest.json')));
});

test('execute refuses a dirty source unless the caller explicitly measures HEAD', () => {
  const root = repository();
  writeFileSync(join(root, 'dirty.txt'), 'not committed\n');
  assert.throws(
    () =>
      executeAblation({
        dir: root,
        task: join(root, 'task.md'),
        runnerBin: process.execPath,
        runnerArgs: [join(root, 'runner.mjs')],
        runs: 2,
      }),
    /working tree is dirty/,
  );
});

test('allow-dirty-base records that only committed HEAD is measured', () => {
  const root = repository();
  writeFileSync(join(root, 'dirty.txt'), 'not committed\n');
  const plan = buildAblationPlan({
    dir: root,
    task: join(root, 'task.md'),
    runnerBin: process.execPath,
    runnerArgs: [join(root, 'runner.mjs')],
    runs: 2,
    allowDirtyBase: true,
  });
  assert.equal(plan.dirty, true);
  assert.equal(plan.allow_dirty_base, true);
  assert.deepEqual(plan.limitations, [
    'The source tree is dirty; trials use committed HEAD only and exclude every uncommitted change.',
  ]);
});

test('allow-dirty-base derives the stripped layer from committed HEAD, not dirty instructions', () => {
  const root = repository();
  rmSync(join(root, 'CLAUDE.md'));
  writeFileSync(
    join(root, '.claude/rules/global.md'),
    '---\npaths:\n  - "dirty-only/**"\n---\nLocally changed to conditional.\n',
  );
  const beforeStatus = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  const out = join(mkdtempSync(join(tmpdir(), 'ai-layer-dirty-head-parent-')), 'results');

  const report = executeAblation({
    dir: root,
    task: join(root, 'task.md'),
    runnerBin: process.execPath,
    runnerArgs: [join(root, 'runner.mjs')],
    runs: 2,
    out,
    timeoutMs: 30_000,
    allowDirtyBase: true,
  });

  const key = JSON.parse(readFileSync(join(out, 'answer-key.json'), 'utf8'));
  assert.equal(report.layer_source, 'committed-head');
  assert.ok(key.stripped_paths.includes('CLAUDE.md'));
  assert.ok(key.stripped_paths.includes('.claude/rules/global.md'));
  assert.equal(report.source_unchanged, true);
  assert.equal(git(root, ['status', '--porcelain=v1', '--untracked-files=all']), beforeStatus);
});

test('a symlinked always-loaded directory cannot alias or remove enforcement', () => {
  const root = repository();
  rmSync(join(root, '.claude/rules'), { recursive: true });
  symlinkSync('../.pi/extensions', join(root, '.claude/rules'), 'dir');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'alias rules to enforcement']);
  const out = join(mkdtempSync(join(tmpdir(), 'ai-layer-enforcement-alias-parent-')), 'results');

  const plan = buildAblationPlan({
    dir: root,
    task: join(root, 'task.md'),
    runnerBin: process.execPath,
    runnerArgs: [join(root, 'runner.mjs')],
    runs: 2,
  });
  assert.equal(plan.enforcement_preserved, true);
  assert.ok(!plan.arms[1].stripped.includes('.claude/rules/guard.md'));
  const aliasedRule = plan.layer.engines.claude.always_loaded.find((file) => file.path === '.claude/rules/guard.md');
  assert.equal(aliasedRule.via_symlink, true);
  assert.equal(aliasedRule.canonical_path, '.pi/extensions/guard.md');
  assert.ok(plan.alias_paths_excluded_from_stripping.includes('.claude/rules/guard.md'));
  assert.ok(plan.enforcement_excluded_from_stripping.includes('.claude/rules/guard.md'));
  assert.ok(plan.layer.engines.pi.enforcement.some((file) => file.path === '.pi/extensions/guard.md'));

  const report = executeAblation({
    dir: root,
    task: join(root, 'task.md'),
    runnerBin: process.execPath,
    runnerArgs: [join(root, 'runner.mjs')],
    runs: 2,
    out,
    timeoutMs: 30_000,
  });
  const key = JSON.parse(readFileSync(join(out, 'answer-key.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.enforcement_preserved, true);
  assert.ok(manifest.alias_paths_excluded_from_stripping.includes('.claude/rules/guard.md'));
  assert.ok(manifest.enforcement_excluded_from_stripping.includes('.claude/rules/guard.md'));
  assert.ok(!key.stripped_paths.includes('.claude/rules/guard.md'));
  for (const blind of Object.values(key.labels)) {
    for (let run = 1; run <= 2; run++) {
      const diff = readFileSync(join(out, 'blind', blind, `run-${String(run).padStart(2, '0')}.diff`), 'utf8');
      assert.match(diff, /extension=true/);
    }
  }
  assert.equal(report.source_unchanged, true);
});

test('invalid run counts are rejected before any experiment', () => {
  const root = repository();
  assert.throws(
    () =>
      buildAblationPlan({
        dir: root,
        task: join(root, 'task.md'),
        runnerBin: process.execPath,
        runs: 1,
      }),
    /integer >= 2/,
  );
});

test('execution output cannot dirty the source repository', () => {
  const root = repository();
  assert.throws(
    () =>
      executeAblation({
        dir: root,
        task: join(root, 'task.md'),
        runnerBin: process.execPath,
        runnerArgs: [join(root, 'runner.mjs')],
        runs: 2,
        out: join(root, 'ablation-results'),
      }),
    /outside the source repository/,
  );
  assert.equal(existsSync(join(root, 'ablation-results')), false);
});

test('runner failures invalidate the experiment but keep its evidence', () => {
  const root = repository();
  const out = join(mkdtempSync(join(tmpdir(), 'ai-layer-failed-parent-')), 'results');
  assert.throws(
    () =>
      executeAblation({
        dir: root,
        task: join(root, 'task.md'),
        runnerBin: process.execPath,
        runnerArgs: ['-e', 'process.exit(3)'],
        runs: 2,
        out,
      }),
    /runner trials failed/,
  );
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.valid, false);
  assert.equal(manifest.runner_failures.length, 4);
  assert.ok(manifest.runner_failures.every((failure) => failure.exit_code === 3));
  assert.equal(git(root, ['status', '--porcelain=v1', '--untracked-files=all']), '');
});
