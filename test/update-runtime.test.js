// Unit tests for the `--update-runtime` contract: the per-file decision, the
// updatable-path filter, the manifest baseline rules and the plan/apply flow —
// all against fixture template trees (no real project, no network, no agents).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/lib/args.js';
import { FIA } from '../src/config.js';
import {
  GITIGNORE_HEADER,
  applyRuntimePlan,
  backupDirName,
  decideAction,
  ensureFiaGitignore,
  makeModifiedConsent,
  stampManifestFiles,
  isRuntimeUpdatable,
  manifestFilesAfter,
  mergeFiaNpmScripts,
  nextManifestSha,
  planRuntimeUpdate,
  sha1,
} from '../src/steps/update-runtime.js';

const BIN = fileURLToPath(new URL('../bin/create-iai.js', import.meta.url));

async function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'create-iai-runtime-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  return dir;
}

/** Fixture package: a mini fia-templates + pi-templates pair. */
async function fixtureTrees() {
  const pkg = await fixture({
    'fia-tpl/modules/gates.mjs': 'export const gate = 2;\n',
    'fia-tpl/fda_bug.mjs': '// new FDA\n',
    'fia-tpl/scripts/fia-query.mjs': '// query v2\n',
    'fia-tpl/package.json': '{ "name": "fia", "version": "2.0.0" }\n',
    'fia-tpl/fia.config.yaml': 'agents: []\n',
    'fia-tpl/data/prompt_engineering/planner/system.md': '# planner v2\n',
    'pi-tpl/prompts/task.md': '# task v2\n',
    'pi-tpl/agents/planner.md': '# planner agent v2\n',
  });
  return {
    pkg,
    trees: [
      { src: join(pkg, 'fia-tpl'), prefix: 'imp' },
      { src: join(pkg, 'pi-tpl'), prefix: '.pi' },
    ],
  };
}

const byRel = (plan) => Object.fromEntries(plan.map((e) => [e.rel, e]));

// ── flags ────────────────────────────────────────────────────────────────────

test('parseArgs: --update-runtime with --dir/--force/--json/--yes', () => {
  const { flags, errors, warnings } = parseArgs(['--update-runtime', '--dir', '.', '--force', '--json', '--yes']);
  assert.equal(flags.updateRuntime, true);
  assert.equal(flags.force, true);
  assert.equal(flags.json, true);
  assert.equal(flags.yes, true);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('parseArgs: --json/--force outside their commands warn (non-fatal)', () => {
  const json = parseArgs(['--json']);
  assert.deepEqual(json.errors, []);
  assert.ok(json.warnings.some((w) => w.includes('--json')));

  const force = parseArgs(['--force']);
  assert.deepEqual(force.errors, []);
  assert.ok(force.warnings.some((w) => w.includes('--force')));

  const verifyJson = parseArgs(['--verify', '--json']);
  assert.deepEqual(verifyJson.warnings, []);
});

// ── pure decision logic ──────────────────────────────────────────────────────

test('isRuntimeUpdatable: runtime paths in, user material out', () => {
  assert.equal(isRuntimeUpdatable('imp/modules/gates.mjs'), true);
  assert.equal(isRuntimeUpdatable('imp/fda_bug.mjs'), true);
  assert.equal(isRuntimeUpdatable('imp/scripts/fia-viewer.mjs'), true);
  assert.equal(isRuntimeUpdatable('imp/package.json'), true);
  assert.equal(isRuntimeUpdatable('.pi/skills/fia/SKILL.md'), true);
  assert.equal(isRuntimeUpdatable('.pi/prompts/task.md'), true);
  assert.equal(isRuntimeUpdatable('.pi/extensions/fia-guard.ts'), true);

  assert.equal(isRuntimeUpdatable('imp/fia.config.yaml'), false, "the roster is the student's");
  assert.equal(isRuntimeUpdatable('imp/data/prompt_engineering/planner/system.md'), false, 'editable prompts stay');
  assert.equal(isRuntimeUpdatable('.pi/agents/planner.md'), false);
  assert.equal(isRuntimeUpdatable('.pi/settings.json'), false);
  // The * in imp/fda_*.mjs must not cross a path segment.
  assert.equal(isRuntimeUpdatable('imp/fda_x/nested.mjs'), false);
});

test('decideAction: the four cases of the contract', () => {
  const t = 'aaa';
  assert.equal(decideAction({ templateSha: t, diskSha: null, manifestSha: null }), 'add');
  assert.equal(decideAction({ templateSha: t, diskSha: 'aaa', manifestSha: 'zzz' }), 'unchanged');
  assert.equal(decideAction({ templateSha: t, diskSha: 'bbb', manifestSha: 'bbb' }), 'update');
  assert.equal(decideAction({ templateSha: t, diskSha: 'bbb', manifestSha: 'ccc' }), 'modified');
  // No manifest → conservative: treated as locally modified, never clobbered.
  assert.equal(decideAction({ templateSha: t, diskSha: 'bbb', manifestSha: null }), 'modified');
});

test('backupDirName: imp/.runtime-backup-YYYYMMDD-HHmmss', () => {
  assert.equal(backupDirName(new Date(2026, 7, 12, 9, 5, 3)), 'imp/.runtime-backup-20260812-090503');
  assert.match(backupDirName(), /^imp\/\.runtime-backup-\d{8}-\d{6}$/);
});

test('nextManifestSha: overwritten → template; skipped-modified → keeps the stamp baseline', () => {
  const t = 'tpl';
  assert.equal(
    nextManifestSha({ action: 'update', wrote: true, templateSha: t, diskSha: 'old', manifestSha: 'old' }),
    t,
  );
  assert.equal(nextManifestSha({ action: 'add', wrote: true, templateSha: t, diskSha: null, manifestSha: null }), t);
  assert.equal(nextManifestSha({ action: 'unchanged', templateSha: t, diskSha: t, manifestSha: 'stale' }), t);
  // Kept local edit: the OLD sha survives, so the next run still sees it as modified.
  assert.equal(
    nextManifestSha({ action: 'modified', templateSha: t, diskSha: 'edited', manifestSha: 'stamp' }),
    'stamp',
  );
  // Modified with no baseline: stays unlisted (null) — still modified next run.
  assert.equal(nextManifestSha({ action: 'modified', templateSha: t, diskSha: 'edited', manifestSha: null }), null);
  // Preserved (non-updatable) paths keep the recorded baseline, else disk.
  assert.equal(
    nextManifestSha({ action: 'preserved', templateSha: t, diskSha: 'disk', manifestSha: 'stamp' }),
    'stamp',
  );
  assert.equal(nextManifestSha({ action: 'preserved', templateSha: t, diskSha: 'disk', manifestSha: null }), 'disk');
});

// ── plan + apply on fixture trees ────────────────────────────────────────────

test('planRuntimeUpdate: fresh project → updatable files add, user material preserved', async () => {
  const { trees } = await fixtureTrees();
  const dir = await fixture({});
  const plan = byRel(await planRuntimeUpdate({ dir, trees }));

  assert.equal(plan['imp/modules/gates.mjs'].action, 'add');
  assert.equal(plan['imp/fda_bug.mjs'].action, 'add');
  assert.equal(plan['.pi/prompts/task.md'].action, 'add');
  assert.equal(plan['imp/fia.config.yaml'].action, 'preserved');
  assert.equal(plan['imp/data/prompt_engineering/planner/system.md'].action, 'preserved');
  assert.equal(plan['.pi/agents/planner.md'].action, 'preserved');
});

test('applyRuntimePlan: add + update overwrite with backup; modified is skipped by default', async () => {
  const { trees } = await fixtureTrees();
  const dir = await fixture({
    // Identical to the template → unchanged.
    'imp/package.json': '{ "name": "fia", "version": "2.0.0" }\n',
    // Old stamped version (manifest matches) → safe overwrite.
    'imp/modules/gates.mjs': 'export const gate = 1;\n',
    // Locally edited after the stamp (manifest has another sha) → needs consent.
    // PROSE on purpose: runtime code (imp/modules, imp/scripts, imp/fda_*) is
    // never kept at the old version — see the forced-runtime test below.
    '.pi/prompts/task.md': 'my local tweak\n',
    // Never touched by the update, even though the template differs.
    'imp/fia.config.yaml': 'agents: [mine]\n',
  });
  const manifest = {
    files: {
      'imp/modules/gates.mjs': sha1('export const gate = 1;\n'),
      '.pi/prompts/task.md': sha1('task v1\n'),
    },
  };

  const plan = await planRuntimeUpdate({ dir, trees, manifest });
  const result = await applyRuntimePlan({ dir, plan, now: new Date(2026, 7, 12, 9, 5, 3) });

  assert.deepEqual(result.updated, ['imp/modules/gates.mjs']);
  assert.deepEqual(result.skippedModified, ['.pi/prompts/task.md']);
  assert.deepEqual(result.unchanged, ['imp/package.json']);
  assert.ok(result.added.includes('imp/fda_bug.mjs'));

  // Overwritten with the new bytes; the old bytes live in the backup.
  assert.equal(await readFile(join(dir, 'imp/modules/gates.mjs'), 'utf8'), 'export const gate = 2;\n');
  assert.equal(result.backupDir, 'imp/.runtime-backup-20260812-090503');
  assert.equal(
    await readFile(join(dir, result.backupDir, 'imp/modules/gates.mjs'), 'utf8'),
    'export const gate = 1;\n',
  );
  // The skipped prose file and the roster kept the student's bytes.
  assert.equal(await readFile(join(dir, '.pi/prompts/task.md'), 'utf8'), 'my local tweak\n');
  assert.equal(await readFile(join(dir, 'imp/fia.config.yaml'), 'utf8'), 'agents: [mine]\n');
  // Preserved template files are never created out of thin air either.
  assert.equal(existsSync(join(dir, '.pi/agents/planner.md')), false);
});

test('applyRuntimePlan: consent hook overwrites a modified PROSE file (with backup)', async () => {
  const { trees } = await fixtureTrees();
  const dir = await fixture({ '.pi/prompts/task.md': 'my local tweak\n' });
  const plan = await planRuntimeUpdate({ dir, trees, manifest: null });
  const asked = [];
  const result = await applyRuntimePlan({
    dir,
    plan,
    overwriteModified: async (entry) => {
      asked.push(entry.rel);
      return true;
    },
  });

  assert.deepEqual(asked, ['.pi/prompts/task.md']);
  assert.ok(result.updated.includes('.pi/prompts/task.md'));
  assert.equal(await readFile(join(dir, '.pi/prompts/task.md'), 'utf8'), '# task v2\n');
  assert.equal(await readFile(join(dir, result.backupDir, '.pi/prompts/task.md'), 'utf8'), 'my local tweak\n');
});

test('applyRuntimePlan: edited runtime CODE is updated anyway — a mixed-version imp/ cannot load', async () => {
  // Keeping one edited module behind while its siblings move forward does not
  // preserve the student's edit: it produces `SyntaxError: does not provide an
  // export named …` on every FDA, under a "Runtime updated ✅" banner. The
  // student's bytes are still recoverable from the backup folder.
  const { trees } = await fixtureTrees();
  const dir = await fixture({ 'imp/scripts/fia-query.mjs': '// my local tweak\n' });
  const plan = await planRuntimeUpdate({ dir, trees, manifest: null });
  const asked = [];
  const result = await applyRuntimePlan({
    dir,
    plan,
    overwriteModified: async (entry) => {
      asked.push(entry.rel);
      return false; // the student says NO — and it must not matter for code
    },
  });

  assert.deepEqual(asked, [], 'runtime code is never even offered as a choice');
  assert.ok(result.updated.includes('imp/scripts/fia-query.mjs'));
  assert.deepEqual(result.skippedModified, []);
  assert.deepEqual(result.forcedRuntime, ['imp/scripts/fia-query.mjs'], 'and the student is told which');
  assert.equal(await readFile(join(dir, 'imp/scripts/fia-query.mjs'), 'utf8'), '// query v2\n');
  assert.equal(
    await readFile(join(dir, result.backupDir, 'imp/scripts/fia-query.mjs'), 'utf8'),
    '// my local tweak\n',
    'their version is in the backup, not lost',
  );
});

test('manifestFilesAfter: new baselines for written files, stamp sha kept for skipped ones', async () => {
  const { trees } = await fixtureTrees();
  // PROSE for the skipped case: runtime code is never kept behind (see the
  // forced-runtime test), so only prose can still be "skipped-modified".
  const stampSha = sha1('task v1\n');
  const dir = await fixture({
    'imp/modules/gates.mjs': 'export const gate = 1;\n',
    '.pi/prompts/task.md': 'my local tweak\n',
    'imp/fia.config.yaml': 'agents: [mine]\n',
  });
  const manifest = {
    files: {
      'imp/modules/gates.mjs': sha1('export const gate = 1;\n'),
      '.pi/prompts/task.md': stampSha,
      'imp/fia.config.yaml': sha1('agents: []\n'),
    },
  };
  const plan = await planRuntimeUpdate({ dir, trees, manifest });
  await applyRuntimePlan({ dir, plan });
  const files = manifestFilesAfter(plan);

  assert.equal(files['imp/modules/gates.mjs'], sha1('export const gate = 2;\n'), 'overwritten → template sha');
  assert.equal(files['imp/fda_bug.mjs'], sha1('// new FDA\n'), 'added → template sha');
  assert.equal(files['.pi/prompts/task.md'], stampSha, 'skipped-modified → stamp sha survives');
  assert.equal(files['imp/fia.config.yaml'], sha1('agents: []\n'), 'preserved → recorded baseline survives');
});

test('stampManifestFiles: records the TEMPLATE sha, so pre-existing files stay "modified"', async () => {
  const { trees } = await fixtureTrees();
  const dir = await fixture({
    // Pre-existing file the stamp skipped: the manifest still holds the
    // TEMPLATE sha, so the difference is visible as a local edit.
    'imp/modules/gates.mjs': 'export const gate = 0; // mine\n',
    '.pi/prompts/task.md': '# task v2\n',
  });
  const files = await stampManifestFiles(dir, trees);
  assert.equal(files['imp/modules/gates.mjs'], sha1('export const gate = 2;\n'));
  assert.equal(files['.pi/prompts/task.md'], sha1('# task v2\n'), 'stamped copy: template sha == disk sha');
  assert.equal(files['imp/fda_bug.mjs'], undefined, 'missing on disk → not in the manifest');

  // The whole point: `--update-runtime` must ASK before replacing that file.
  const plan = await planRuntimeUpdate({ dir, trees, manifest: { files } });
  assert.equal(byRel(plan)['imp/modules/gates.mjs'].action, 'modified');
  assert.equal(byRel(plan)['.pi/prompts/task.md'].action, 'unchanged');
});

// ── npm script merge ─────────────────────────────────────────────────────────

test('mergeFiaNpmScripts: adds every missing FIA script (updated projects get npm run tui)', async () => {
  const dir = await fixture({
    'package.json': '{\n  "name": "app",\n  "scripts": {\n    "dev": "next dev"\n  }\n}\n',
  });
  const { added, aliased } = await mergeFiaNpmScripts(dir);
  assert.deepEqual(added.sort(), Object.keys(FIA.npmScripts).sort());
  assert.deepEqual(aliased, []);
  const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.dev, 'next dev', 'project scripts untouched');
  assert.equal(pkg.scripts.tui, FIA.npmScripts.tui);
  assert.equal(pkg.scripts['env:check'], FIA.npmScripts['env:check']);
});

test('mergeFiaNpmScripts: conflicting name keeps the project version, ships ours as :fia', async () => {
  const dir = await fixture({
    'package.json': JSON.stringify({ name: 'app', scripts: { plan: 'echo mine' } }, null, 2) + '\n',
  });
  const { aliased } = await mergeFiaNpmScripts(dir);
  assert.deepEqual(aliased, ['plan → plan:fia']);
  const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.plan, 'echo mine');
  assert.equal(pkg.scripts['plan:fia'], FIA.npmScripts.plan);
});

test('mergeFiaNpmScripts: re-run is a no-op that never rewrites the file', async () => {
  const dir = await fixture({ 'package.json': '{ "name": "app" }\n' });
  await mergeFiaNpmScripts(dir);
  const once = await readFile(join(dir, 'package.json'), 'utf8');
  // Sabotage detection: hand-format the file — an idempotent re-run must not
  // reformat it back.
  const custom = once.replace(/\n$/, '\n\n');
  await writeFile(join(dir, 'package.json'), custom, 'utf8');
  const { added, aliased } = await mergeFiaNpmScripts(dir);
  assert.deepEqual({ added, aliased }, { added: [], aliased: [] });
  assert.equal(await readFile(join(dir, 'package.json'), 'utf8'), custom, 'no write on a no-op run');
});

test('mergeFiaNpmScripts: no package.json (harness-only folder) → minimal one is created', async () => {
  const dir = await fixture({});
  const { added } = await mergeFiaNpmScripts(dir);
  assert.ok(added.includes('fda:viewer'));
  const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.private, true);
  assert.equal(pkg.scripts['fda:viewer'], FIA.npmScripts['fda:viewer']);
});

// ── bin dispatch ─────────────────────────────────────────────────────────────

test('bin: --update-runtime --json on a folder without imp/ exits 1 with a JSON error', async () => {
  const dir = await fixture({});
  const res = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, '--update-runtime', '--json', '--dir', dir],
      { timeout: 30000, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
    );
  });
  assert.equal(res.code, 1);
  const report = JSON.parse(res.stdout);
  assert.equal(report.ok, false);
  assert.match(report.error, /imp\//);
});

// ── Consent for locally modified files (Yes / Yes to all / No / No to all) ───

/** io seam: canned select answers, recorded calls. */
function fakeIo(answers) {
  const calls = { warns: 0, selects: 0 };
  let i = 0;
  return {
    calls,
    warn: () => calls.warns++,
    select: async () => {
      calls.selects++;
      return answers[i++];
    },
  };
}

const ENTRIES = [{ rel: 'a.md' }, { rel: 'b.md' }, { rel: 'c.md' }];

test('makeModifiedConsent: --force overwrites everything without asking', async () => {
  const io = fakeIo([]);
  const consent = makeModifiedConsent({ force: true, interactive: true, version: 'x', io });
  for (const entry of ENTRIES) assert.equal(await consent(entry), true);
  assert.equal(io.calls.selects, 0);
  assert.equal(io.calls.warns, 0);
});

test('makeModifiedConsent: non-interactive without --force keeps every file', async () => {
  const io = fakeIo([]);
  const consent = makeModifiedConsent({ force: false, interactive: false, version: 'x', io });
  for (const entry of ENTRIES) assert.equal(await consent(entry), false);
  assert.equal(io.calls.selects, 0);
});

test('makeModifiedConsent: per-file answers, one warning for the whole run', async () => {
  const io = fakeIo(['yes', 'no', 'yes']);
  const consent = makeModifiedConsent({ force: false, interactive: true, version: 'x', io });
  assert.equal(await consent(ENTRIES[0]), true);
  assert.equal(await consent(ENTRIES[1]), false);
  assert.equal(await consent(ENTRIES[2]), true);
  assert.equal(io.calls.selects, 3);
  assert.equal(io.calls.warns, 1);
});

test('makeModifiedConsent: "Yes to all" sticks — no further prompts, everything overwritten', async () => {
  const io = fakeIo(['yes-all']);
  const consent = makeModifiedConsent({ force: false, interactive: true, version: 'x', io });
  assert.equal(await consent(ENTRIES[0]), true); // the answer that set the sticky also overwrites
  assert.equal(await consent(ENTRIES[1]), true);
  assert.equal(await consent(ENTRIES[2]), true);
  assert.equal(io.calls.selects, 1);
});

test('makeModifiedConsent: "No to all" sticks — no further prompts, everything kept', async () => {
  const io = fakeIo(['no-all']);
  const consent = makeModifiedConsent({ force: false, interactive: true, version: 'x', io });
  assert.equal(await consent(ENTRIES[0]), false);
  assert.equal(await consent(ENTRIES[1]), false);
  assert.equal(io.calls.selects, 1);
});

// ── .gitignore merge ─────────────────────────────────────────────────────────

const readIgnore = (dir) => readFile(join(dir, '.gitignore'), 'utf8');
const headerCount = (text) => text.split('\n').filter((l) => l.trim() === GITIGNORE_HEADER).length;

test('ensureFiaGitignore: writes one block when the project has no .gitignore yet', async () => {
  const dir = await fixture({ 'keep.txt': 'x\n' });
  await ensureFiaGitignore(dir);
  const text = await readIgnore(dir);
  assert.equal(headerCount(text), 1);
  for (const entry of FIA.gitignoreEntries) assert.ok(text.includes(`${entry}\n`), `${entry} is ignored`);
});

test('ensureFiaGitignore: a new runtime entry joins the existing block — never a second header', async () => {
  // Exactly the upgrade path: a project stamped by the previous release, whose
  // block predates the newest entry.
  const older = FIA.gitignoreEntries.slice(0, -1);
  const dir = await fixture({ '.gitignore': `${GITIGNORE_HEADER}\n${older.join('\n')}\n` });
  await ensureFiaGitignore(dir);

  const text = await readIgnore(dir);
  assert.equal(headerCount(text), 1, 'the header is emitted once, ever');
  const lines = text.split('\n').filter(Boolean);
  assert.deepEqual(lines, [GITIGNORE_HEADER, ...older, FIA.gitignoreEntries.at(-1)]);
  assert.ok(text.endsWith('\n'), 'the file still ends with a newline');
});

test('ensureFiaGitignore: keeps the student sections around ours and is idempotent', async () => {
  const older = FIA.gitignoreEntries.slice(0, -1);
  const dir = await fixture({
    '.gitignore': `node_modules/\n.env\n\n${GITIGNORE_HEADER}\n${older.join('\n')}\n\n# my stuff\nscratch/\n`,
  });
  await ensureFiaGitignore(dir);
  const text = await readIgnore(dir);
  assert.equal(headerCount(text), 1);
  assert.match(text, /node_modules\/\n\.env\n/, 'the student block above ours is untouched');
  assert.match(text, /# my stuff\nscratch\/\n/, 'the student block below ours is untouched');
  // The new entry landed inside our block, before the blank line that ends it.
  assert.match(text, new RegExp(`${FIA.gitignoreEntries.at(-1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n\\n# my stuff`));

  await ensureFiaGitignore(dir);
  assert.equal(await readIgnore(dir), text, 'a second run changes nothing');
});
