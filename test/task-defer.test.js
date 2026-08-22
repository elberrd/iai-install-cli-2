// The defer command (imp/scripts/task-defer.mjs): reversible probe
// quarantine, the two-place status write (issue + index), the ledger + inbox
// trail, and the guards — engineer-only (FIA_FDA_RUN, live .fda.lock),
// done-task refusal, and collision-safe renames. Plus the launch check's
// tasks_deferred warning that keeps an open deferral visible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deferGuard,
  deferState,
  deferTask,
  listQuarantinedProbes,
  probesOfTask,
  quarantineProbes,
  restoreProbes,
  resumeTask,
  runCli,
  setIndexStatus,
  setIssueStatus,
} from '../fia-templates/scripts/task-defer.mjs';

const INDEX = `# Task Master — App

## Tasks

| # | Task | Status | Blocked by | Priority | Complexity | Milestone |
|---|------|--------|------------|----------|------------|-----------|
| 05 | [Other thing](issues/05-other-thing.md) | done | — | high | 2 | MVP |
| 21 | [Benchmark providers](issues/21-benchmark-providers.md) | in-progress | 05 | high | 5 | MVP |
`;

const ISSUE_21 = `# Task 21 — Benchmark providers

**Status:** in-progress
**Blocked by:** 05
**Priority:** high

## What it delivers
A real benchmark.
`;

/** A throwaway project: two probes (tasks 05 and 21), issue 21 + the index. */
function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'task-defer-'));
  const holdout = join(root, 'imp', 'data', 'holdout');
  mkdirSync(holdout, { recursive: true });
  writeFileSync(join(holdout, '21-benchmark-composes.mjs'), 'process.exit(1);\n');
  writeFileSync(join(holdout, '05-other-holds.mjs'), 'process.exit(0);\n');
  const issues = join(root, 'ai-docs', 'todos', 'issues');
  mkdirSync(issues, { recursive: true });
  writeFileSync(join(issues, '21-benchmark-providers.md'), ISSUE_21);
  writeFileSync(
    join(issues, '05-other-thing.md'),
    '# Task 05 — Other thing\n\n**Status:** done\n\n## What it delivers\nDone already.\n',
  );
  writeFileSync(join(root, 'ai-docs', 'todos', 'task-master.md'), INDEX);
  return { root, holdout, dataDir: join(root, 'imp', 'data') };
}

test('probesOfTask matches padded and unpadded numbers, never a neighbour task', () => {
  const { dataDir } = makeProject();
  assert.deepEqual(probesOfTask(dataDir, '21'), { active: ['21-benchmark-composes.mjs'], quarantined: [] });
  assert.deepEqual(probesOfTask(dataDir, '021').active, ['21-benchmark-composes.mjs']);
  assert.deepEqual(probesOfTask(dataDir, '2').active, []);
  assert.deepEqual(probesOfTask(dataDir, '5').active, ['05-other-holds.mjs']);
});

test('quarantine → restore round-trips the exact sealed file, content untouched', () => {
  const { holdout, dataDir } = makeProject();
  const { moved } = quarantineProbes(dataDir, 21);
  assert.deepEqual(moved, ['21-benchmark-composes.mjs']);
  assert.ok(existsSync(join(holdout, '_21-benchmark-composes.mjs')));
  assert.ok(!existsSync(join(holdout, '21-benchmark-composes.mjs')));
  assert.ok(existsSync(join(holdout, '05-other-holds.mjs')), 'other tasks untouched');
  assert.deepEqual(listQuarantinedProbes(dataDir), [{ name: '_21-benchmark-composes.mjs', task: '21' }]);
  const { restored } = restoreProbes(dataDir, 21);
  assert.deepEqual(restored, ['21-benchmark-composes.mjs']);
  assert.equal(readFileSync(join(holdout, '21-benchmark-composes.mjs'), 'utf8'), 'process.exit(1);\n');
});

test('restore refuses to clobber a file that reappeared under the original name', () => {
  const { holdout, dataDir } = makeProject();
  quarantineProbes(dataDir, 21);
  writeFileSync(join(holdout, '21-benchmark-composes.mjs'), 'impostor\n');
  assert.throws(() => restoreProbes(dataDir, 21), /already exists/);
});

test('setIssueStatus rewrites bold and plain Status lines, and reports an absent one', () => {
  assert.equal(setIssueStatus(ISSUE_21, 'deferred').md.includes('**Status:** deferred'), true);
  const plain = setIssueStatus('# T\n\nStatus: pending\n', 'deferred');
  assert.equal(plain.changed, true);
  assert.match(plain.md, /^Status: deferred$/m);
  assert.equal(setIssueStatus('# T\n\nno meta here\n', 'deferred').changed, false);
});

test('setIndexStatus swaps only the Status cell of the named row', () => {
  const { md, changed } = setIndexStatus(INDEX, '21', 'deferred');
  assert.equal(changed, true);
  assert.match(md, /\| 21 \| \[Benchmark providers\]\(issues\/21-benchmark-providers\.md\) \| deferred \| 05 \|/);
  assert.match(md, /\| 05 \| .* \| done \|/, 'other rows keep their status');
  assert.equal(setIndexStatus(INDEX, '99', 'deferred').changed, false);
});

test('deferTask: probes quarantined, both status places written, ledger + inbox trail', () => {
  const { root, holdout, dataDir } = makeProject();
  const r = deferTask({ root, env: {} }, '21', { reason: 'provider API keys come later' });
  assert.equal(r.num, '21');
  assert.deepEqual(r.probes, ['21-benchmark-composes.mjs']);
  assert.deepEqual(r.status, { issue: true, index: true });
  assert.ok(existsSync(join(holdout, '_21-benchmark-composes.mjs')));
  assert.match(readFileSync(join(root, 'ai-docs', 'todos', 'issues', '21-benchmark-providers.md'), 'utf8'), /\*\*Status:\*\* deferred/);
  assert.match(readFileSync(join(root, 'ai-docs', 'todos', 'task-master.md'), 'utf8'), /\| 21 \|.*\| deferred \|/);
  const ledger = JSON.parse(readFileSync(join(dataDir, 'deferrals.json'), 'utf8'));
  assert.equal(ledger.deferred['21'].reason, 'provider API keys come later');
  assert.deepEqual(ledger.deferred['21'].probes, ['21-benchmark-composes.mjs']);
  assert.match(readFileSync(join(root, 'ai-docs', 'inbox.md'), 'utf8'), /- \[ \] Task 21 deferred — provider API keys come later/);
  const state = deferState({ root });
  assert.deepEqual(state.deferredTasks.map((t) => t.num), ['21']);
});

test('resumeTask brings everything back: probe name, pending status, closed ledger, ticked inbox', () => {
  const { root, holdout, dataDir } = makeProject();
  deferTask({ root, env: {} }, 21, { reason: 'later' });
  const r = resumeTask({ root, env: {} }, 21);
  assert.deepEqual(r.probes, ['21-benchmark-composes.mjs']);
  assert.ok(existsSync(join(holdout, '21-benchmark-composes.mjs')));
  assert.match(readFileSync(join(root, 'ai-docs', 'todos', 'issues', '21-benchmark-providers.md'), 'utf8'), /\*\*Status:\*\* pending/);
  assert.match(readFileSync(join(root, 'ai-docs', 'todos', 'task-master.md'), 'utf8'), /\| 21 \|.*\| pending \|/);
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'deferrals.json'), 'utf8')).deferred, {});
  assert.match(readFileSync(join(root, 'ai-docs', 'inbox.md'), 'utf8'), /- \[x\] Task 21 deferred/);
  assert.throws(() => resumeTask({ root, env: {} }, 21), /not deferred/);
});

test('a done task and an unknown task both refuse to defer', () => {
  const { root } = makeProject();
  assert.throws(() => deferTask({ root, env: {} }, 5), /done/);
  assert.throws(() => deferTask({ root, env: {} }, 77), /nothing to defer/);
});

test('the engineer-only guards: FIA_FDA_RUN and a live .fda.lock both refuse', async () => {
  const { root, dataDir } = makeProject();
  assert.match(deferGuard(root, { FIA_FDA_RUN: '1' }), /engineer's call/);
  assert.throws(() => deferTask({ root, env: { FIA_FDA_RUN: '1' } }, 21), /engineer's call/);
  // A lock naming a LIVE pid (another process) blocks; task-defer never bypasses it.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  try {
    writeFileSync(join(dataDir, '.fda.lock'), JSON.stringify({ pid: child.pid, fda_id: 'run-x' }));
    assert.throws(() => deferTask({ root, env: {} }, 21), /FDA run is active/);
    assert.throws(() => resumeTask({ root, env: {} }, 21), /FDA run is active/);
  } finally {
    child.kill('SIGKILL');
  }
});

test('runCli: off-TTY without --yes refuses; --yes defers; list --json reports the state', async () => {
  const { root } = makeProject();
  const errors = [];
  const logs = [];
  const origError = console.error;
  const origLog = console.log;
  console.error = (m) => errors.push(String(m));
  console.log = (m) => logs.push(String(m));
  try {
    assert.equal(await runCli(['21'], { root, env: {} }), 1, 'no TTY and no --yes must refuse');
    assert.match(errors.join('\n'), /--yes/);
    assert.equal(await runCli(['21', '--yes', '--reason', 'keys later'], { root, env: {} }), 0);
    assert.match(logs.join('\n'), /Task 21 .*deferred/);
    logs.length = 0;
    assert.equal(await runCli(['list', '--json'], { root, env: {} }), 0);
    const state = JSON.parse(logs.join('\n'));
    assert.equal(state.quarantined[0].name, '_21-benchmark-composes.mjs');
    assert.equal(await runCli(['resume', '21', '--yes'], { root, env: {} }), 0);
    assert.equal(await runCli(['nonsense'], { root, env: {} }), 1, 'a non-number is refused');
  } finally {
    console.error = origError;
    console.log = origLog;
  }
});
