// Unit tests for migrateLegacyFiaLayout — the one-shot fia/ → imp/ layout
// migration: folder rename, root-file moves (HARNESS.md, iai.config.json),
// path fixes in package.json scripts / .gitignore / imp/** / .pi/**, and the
// manifest rekey with sha preservation for files WE rewrote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIA } from '../src/config.js';
import { fixLegacyFiaRefs, migrateLegacyFiaLayout, readRuntimeManifest, sha1 } from '../src/steps/update-runtime.js';

async function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'create-iai-migrate-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  return dir;
}

test('fixLegacyFiaRefs: rewrites runtime children, never the fia skill or fia-templates', () => {
  assert.equal(fixLegacyFiaRefs('node fia/fda_quick.mjs'), 'node imp/fda_quick.mjs');
  assert.equal(fixLegacyFiaRefs('db: fia/data/fia.db'), 'db: imp/data/fia.db');
  assert.equal(fixLegacyFiaRefs('fia/scripts/fia-viewer.mjs'), 'imp/scripts/fia-viewer.mjs');
  assert.equal(fixLegacyFiaRefs('edit fia/fia.config.yaml'), 'edit imp/fia.config.yaml');
  assert.equal(fixLegacyFiaRefs('"/fia/modules/"'), '"/imp/modules/"');
  assert.equal(fixLegacyFiaRefs('fia/.runtime-manifest.json'), 'imp/.runtime-manifest.json');
  // Must NOT touch: the fia skill folder, the template dir, other fia/ children.
  assert.equal(fixLegacyFiaRefs('.pi/skills/fia/cookbooks/run_fda.md'), '.pi/skills/fia/cookbooks/run_fda.md');
  assert.equal(fixLegacyFiaRefs('fia-templates/modules/x.mjs'), 'fia-templates/modules/x.mjs');
  assert.equal(fixLegacyFiaRefs('see fia/cookbooks/x.md'), 'see fia/cookbooks/x.md');
});

test('migrate: full legacy project → renamed, moved, path-fixed, manifest rekeyed', async () => {
  const promptOld = 'Run `node fia/fda_prompt.mjs` and read fia/data/fia.db.\n';
  const moduleOld = "const DEFAULT = 'fia/data';\n";
  const editedOld = '// the student rewrote this file entirely\n';
  const dir = await fixture({
    'fia/fia.config.yaml': 'defaults:\n  data_dir: fia/data\n  protected_files:\n    - fia/modules/\n',
    'fia/modules/session.mjs': moduleOld,
    'fia/fda_prompt.mjs': '// fda\n',
    'fia/scripts/fia-query.mjs': editedOld,
    'fia/.runtime-manifest.json': JSON.stringify({
      impactus: '2.0.0-alpha.1',
      stamped_at: '2026-08-01T00:00:00.000Z',
      files: {
        'fia/modules/session.mjs': sha1(moduleOld),
        'fia/scripts/fia-query.mjs': sha1('// the template version\n'), // student edited it
        '.pi/prompts/task.md': sha1(promptOld),
      },
    }),
    '.pi/prompts/task.md': promptOld,
    '.pi/skills/fia/cookbooks/run_fda.md': 'The cookbook lives at .pi/skills/fia/cookbooks/.\nRun node fia/fda_prompt.mjs.\n',
    'HARNESS.md': '# guide\n',
    'iai.config.json': '{ "addons": [] }\n',
    'package.json': JSON.stringify({
      name: 'proj',
      scripts: {
        'fda:viewer': 'node fia/scripts/fia-viewer.mjs',
        custom: 'node fia/fda_quality.mjs "mine"',
        unrelated: 'echo fia is a nice acronym',
      },
    }),
    '.gitignore': 'node_modules/\n# fia runtime\nfia/node_modules/\nfia/data/sessions/\nfia/.runtime-backup-*/\n',
  });

  const result = await migrateLegacyFiaLayout(dir, { quiet: true });
  assert.equal(result.migrated, true);
  assert.equal(result.renamed, true);

  // Folder + root files moved.
  assert.ok(!existsSync(join(dir, 'fia')));
  assert.ok(existsSync(join(dir, 'imp', 'fda_prompt.mjs')));
  assert.ok(!existsSync(join(dir, 'HARNESS.md')));
  assert.equal(await readFile(join(dir, 'imp', 'HARNESS.md'), 'utf8'), '# guide\n');
  assert.ok(!existsSync(join(dir, 'iai.config.json')));
  assert.ok(existsSync(join(dir, 'imp', 'iai.config.json')));

  // Path fixes.
  const yaml = await readFile(join(dir, 'imp', 'fia.config.yaml'), 'utf8');
  assert.match(yaml, /data_dir: imp\/data/);
  assert.match(yaml, /- imp\/modules\//);
  assert.equal(await readFile(join(dir, 'imp', 'modules', 'session.mjs'), 'utf8'), "const DEFAULT = 'imp/data';\n");
  const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['fda:viewer'], 'node imp/scripts/fia-viewer.mjs');
  assert.equal(pkg.scripts.custom, 'node imp/fda_quality.mjs "mine"');
  assert.equal(pkg.scripts.unrelated, 'echo fia is a nice acronym');
  const gitignore = await readFile(join(dir, '.gitignore'), 'utf8');
  assert.match(gitignore, /imp\/node_modules\//);
  assert.match(gitignore, /imp\/\.runtime-backup-\*\//);
  assert.doesNotMatch(gitignore, /fia\/node_modules/);
  const prompt = await readFile(join(dir, '.pi', 'prompts', 'task.md'), 'utf8');
  assert.equal(prompt, 'Run `node imp/fda_prompt.mjs` and read imp/data/fia.db.\n');
  // The fia SKILL keeps its name; only runtime refs inside it are fixed.
  const cookbook = await readFile(join(dir, '.pi', 'skills', 'fia', 'cookbooks', 'run_fda.md'), 'utf8');
  assert.match(cookbook, /\.pi\/skills\/fia\/cookbooks\//);
  assert.match(cookbook, /node imp\/fda_prompt\.mjs/);

  // Manifest: rekeyed to imp/*, sha preserved through OUR rewrite for files
  // that were unmodified, kept (stale) for the student-edited one.
  const manifest = await readRuntimeManifest(dir);
  assert.ok(existsSync(join(dir, FIA.runtimeManifest)));
  assert.equal(manifest.files['imp/modules/session.mjs'], sha1("const DEFAULT = 'imp/data';\n"));
  assert.equal(manifest.files['imp/scripts/fia-query.mjs'], sha1('// the template version\n'));
  assert.equal(manifest.files['.pi/prompts/task.md'], sha1('Run `node imp/fda_prompt.mjs` and read imp/data/fia.db.\n'));
  assert.ok(!('fia/modules/session.mjs' in manifest.files));

  // Idempotent: a second run changes nothing.
  const again = await migrateLegacyFiaLayout(dir, { quiet: true });
  assert.equal(again.migrated, false);
  assert.equal(again.renamed, false);
  assert.deepEqual(again.moved, []);
});

test('migrate: fia/ AND a real imp/ RUNTIME present → skipped (never merged automatically)', async () => {
  const dir = await fixture({
    'fia/fia.config.yaml': 'agents: []\n',
    'imp/fia.config.yaml': 'agents: []\n',
  });
  const result = await migrateLegacyFiaLayout(dir, { quiet: true });
  assert.equal(result.migrated, false);
  assert.ok(existsSync(join(dir, 'fia')));
  assert.ok(existsSync(join(dir, 'imp')));
});

test('migrate: imp/ holding only non-runtime files (addons wrote first) → runtime merged in', async () => {
  // Full-mode pipeline order: applyAddons creates imp/iai.config.json BEFORE
  // setupFia migrates — the rename must merge instead of bailing out.
  const dir = await fixture({
    'fia/fia.config.yaml': 'defaults:\n  data_dir: fia/data\n',
    'fia/fda_prompt.mjs': '// fda\n',
    'imp/iai.config.json': '{ "addons": [] }\n',
  });
  const result = await migrateLegacyFiaLayout(dir, { quiet: true });
  assert.equal(result.migrated, true);
  assert.equal(result.renamed, true);
  assert.ok(!existsSync(join(dir, 'fia')));
  assert.ok(existsSync(join(dir, 'imp', 'iai.config.json')));
  assert.ok(existsSync(join(dir, 'imp', 'fda_prompt.mjs')));
  assert.match(await readFile(join(dir, 'imp', 'fia.config.yaml'), 'utf8'), /data_dir: imp\/data/);
});

test('migrate: legacy guard bare "fia" token comparison gets the targeted fix', async () => {
  const guard = 'return tokens.find((t) => (/[/.]/.test(t) && isProtected(t)) || toProjectRelative(t) === "fia");\n';
  const dir = await fixture({
    'fia/fia.config.yaml': 'agents: []\n',
    '.pi/extensions/fia-guard.ts': `const SEGS = ["/fia/modules/"];\n${guard}`,
  });
  await migrateLegacyFiaLayout(dir, { quiet: true });
  const fixed = await readFile(join(dir, '.pi', 'extensions', 'fia-guard.ts'), 'utf8');
  assert.match(fixed, /"\/imp\/modules\/"/);
  assert.match(fixed, /=== "imp"\)/);
});

test('migrate: legacy guard PROTECTED regex literals (escaped slashes) are fixed too', async () => {
  // The real legacy guard writes its paths inside regex literals, so the char
  // after `fia` is `\`, not `/` — the enumerated rewrite cannot see it and the
  // guard would silently stop protecting the migrated runtime.
  const dir = await fixture({
    'fia/fia.config.yaml': 'agents: []\n',
    '.pi/extensions/fia-guard.ts':
      'const PROTECTED = [/^fia\\/modules(\\/|$)/, /^fia\\/fia\\.config\\.yaml$/, /^fia\\/fda_[^/]+\\.mjs$/];\n',
  });
  await migrateLegacyFiaLayout(dir, { quiet: true });
  const fixed = await readFile(join(dir, '.pi', 'extensions', 'fia-guard.ts'), 'utf8');
  assert.match(fixed, /\/\^imp\\\/modules/);
  assert.match(fixed, /\/\^imp\\\/fia\\\.config\\\.yaml\$\//, 'the FILE is still named fia.config.yaml');
  assert.match(fixed, /\/\^imp\\\/fda_/);
  assert.ok(!fixed.includes('fia\\/'), 'no escaped fia\\/ left behind');
});

test('migrate: crash BETWEEN rename and rewrites → next run finishes (marker travels with the folder)', async () => {
  // Simulate the post-crash state the OLD code could produce only transiently:
  // fia/ already renamed to imp/ (marker inside — it was written into fia/
  // BEFORE the rename), process died before any path rewrite.
  const dir = await fixture({
    'imp/.fia-migration-pending': 'fia -> imp migration in progress\n',
    'imp/fia.config.yaml': 'defaults:\n  data_dir: fia/data\n',
    'package.json': '{\n  "scripts": { "fda:demo": "node fia/fda_prompt.mjs" }\n}\n',
  });
  const result = await migrateLegacyFiaLayout(dir, { quiet: true });
  assert.equal(result.migrated, true);
  assert.match(await readFile(join(dir, 'imp', 'fia.config.yaml'), 'utf8'), /data_dir: imp\/data/);
  assert.match(await readFile(join(dir, 'package.json'), 'utf8'), /node imp\/fda_prompt\.mjs/);
  assert.ok(!existsSync(join(dir, 'imp', '.fia-migration-pending')), 'marker removed when the pass completes');
});

test('migrate: crash mid MERGE loop → next run resumes the merge instead of refusing', async () => {
  // Interrupted merge: imp/ already got modules/ (looks like a runtime), fia/
  // still holds fia.config.yaml (also looks like a runtime) — but the marker
  // proves it is OUR half-done merge, not a human-made two-runtimes state.
  const dir = await fixture({
    'fia/fia.config.yaml': 'defaults:\n  data_dir: fia/data\n',
    'imp/.fia-migration-pending': 'fia -> imp migration in progress\n',
    'imp/modules/gates.mjs': '// moved before the crash\n',
    'imp/iai.config.json': '{ "addons": [] }\n',
  });
  const result = await migrateLegacyFiaLayout(dir, { quiet: true });
  assert.equal(result.migrated, true);
  assert.ok(!existsSync(join(dir, 'fia')), 'merge completed');
  assert.match(await readFile(join(dir, 'imp', 'fia.config.yaml'), 'utf8'), /data_dir: imp\/data/);
  assert.ok(!existsSync(join(dir, 'imp', '.fia-migration-pending')));
});

test('migrate: two runtimes WITHOUT a marker still refuse (human-made state)', async () => {
  const dir = await fixture({
    'fia/fia.config.yaml': 'agents: []\n',
    'imp/modules/gates.mjs': '// a real runtime\n',
  });
  const result = await migrateLegacyFiaLayout(dir, { quiet: true });
  assert.equal(result.migrated, false);
  assert.ok(existsSync(join(dir, 'fia')));
});

test('migrate: legacy harness copies in .claude/ and .cursor/ are path-fixed too', async () => {
  const cmd = 'If `fia/scripts/fia-launch-check.mjs` exists, run\n`node fia/scripts/fia-launch-check.mjs --json`.\n';
  const dir = await fixture({
    'fia/fia.config.yaml': 'agents: []\n',
    '.claude/commands/launch.md': cmd,
    '.cursor/commands/launch.md': cmd,
  });
  await migrateLegacyFiaLayout(dir, { quiet: true });
  for (const engine of ['.claude', '.cursor']) {
    const text = await readFile(join(dir, engine, 'commands', 'launch.md'), 'utf8');
    assert.match(text, /node imp\/scripts\/fia-launch-check\.mjs/);
    assert.doesNotMatch(text, /fia\/scripts/);
  }
});

test('migrate: crash mid-rewrite → pending marker makes the next run finish the job', async () => {
  // Simulate the post-crash state: folder already renamed (imp/ exists, no
  // fia/), marker still present, one file still carrying legacy paths.
  const dir = await fixture({
    'imp/fia.config.yaml': 'defaults:\n  data_dir: fia/data\n',
    'imp/.fia-migration-pending': 'fia -> imp migration in progress\n',
    '.pi/prompts/task.md': 'Run node fia/fda_prompt.mjs.\n',
  });
  const result = await migrateLegacyFiaLayout(dir, { quiet: true });
  assert.equal(result.migrated, true);
  assert.equal(result.renamed, false);
  assert.match(await readFile(join(dir, 'imp', 'fia.config.yaml'), 'utf8'), /data_dir: imp\/data/);
  assert.match(await readFile(join(dir, '.pi', 'prompts', 'task.md'), 'utf8'), /node imp\/fda_prompt\.mjs/);
  assert.ok(!existsSync(join(dir, 'imp', '.fia-migration-pending')), 'marker removed when done');
});

test('migrate: unrelated fia/ folder (not our runtime) is left alone', async () => {
  const dir = await fixture({ 'fia/index.ts': 'export {};\n' });
  const result = await migrateLegacyFiaLayout(dir, { quiet: true });
  assert.equal(result.migrated, false);
  assert.ok(existsSync(join(dir, 'fia', 'index.ts')));
  assert.ok(!existsSync(join(dir, 'imp')));
});

test('migrate: harness-only legacy project (no fia/) still moves the root files', async () => {
  const dir = await fixture({ 'HARNESS.md': '# guide\n', '.claude/settings.json': '{}\n' });
  const result = await migrateLegacyFiaLayout(dir, { quiet: true });
  assert.equal(result.migrated, true);
  assert.equal(result.renamed, false);
  assert.deepEqual(result.moved, ['HARNESS.md → imp/HARNESS.md']);
  assert.equal(await readFile(join(dir, 'imp', 'HARNESS.md'), 'utf8'), '# guide\n');
});

test('migrate: fia-guard extension segments are fixed (.ts files included)', async () => {
  const dir = await fixture({
    'fia/fia.config.yaml': 'agents: []\n',
    '.pi/extensions/fia-guard.ts': 'const SEGS = ["/fia/modules/", "/fia/fda_"];\n',
  });
  const result = await migrateLegacyFiaLayout(dir, { quiet: true });
  assert.equal(result.migrated, true);
  assert.equal(
    await readFile(join(dir, '.pi', 'extensions', 'fia-guard.ts'), 'utf8'),
    'const SEGS = ["/imp/modules/", "/imp/fda_"];\n',
  );
});
