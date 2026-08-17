// `imp fix` — the plan computed by collectFixPlan and the apply() of each
// local fixer (mcp -y, skill dupes, runtime restore, harness classification).
// Machine-level probes (Pi on PATH, ~/.pi settings) are injected off so the
// plan only reflects the fixture project. Network fixers (harness re-download)
// are asserted at the plan level, never applied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectFixPlan } from '../src/steps/fix.js';
import { writeHarnessManifest, sha1 } from '../src/lib/harness-manifest.js';

const NO_PI = { piReady: async () => false };

async function planFor(cwd) {
  const plan = await collectFixPlan({ cwd, probes: NO_PI });
  await plan.cleanup();
  return plan;
}

test('fix: a clean empty folder plans nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fix-clean-'));
  const { items, notes } = await planFor(dir);
  assert.deepEqual(items, []);
  assert.deepEqual(notes, []);
});

test('fix: npx MCP server without -y is planned, applied, and the plan converges to zero', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fix-mcp-'));
  writeFileSync(
    join(dir, '.mcp.json'),
    JSON.stringify(
      {
        mcpServers: {
          playwright: { command: 'npx', args: ['@playwright/mcp@latest'] },
          convex: { command: 'npx', args: ['-y', 'convex@latest', 'mcp', 'start'] },
        },
      },
      null,
      2,
    ) + '\n',
  );
  const { items } = await planFor(dir);
  const item = items.find((i) => i.id === 'mcp-npx-yes');
  assert.ok(item, 'plans the -y fix');
  assert.match(item.label, /playwright/);
  assert.doesNotMatch(item.label, /convex/);

  await item.apply();
  const after = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
  assert.deepEqual(after.mcpServers.playwright.args, ['-y', '@playwright/mcp@latest']);
  assert.deepEqual(after.mcpServers.convex.args, ['-y', 'convex@latest', 'mcp', 'start']);

  const replan = await planFor(dir);
  assert.equal(replan.items.find((i) => i.id === 'mcp-npx-yes'), undefined, 'idempotent');
});

test('fix: broken .mcp.json is a note (hand-edited files are never repaired)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fix-badmcp-'));
  writeFileSync(join(dir, '.mcp.json'), '{ not json');
  const { items, notes } = await planFor(dir);
  assert.equal(items.length, 0);
  assert.match(notes[0], /not valid JSON/);
});

test('fix: duplicated .pi/skills copies are planned and pruned', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fix-dupes-'));
  writeFileSync(join(dir, 'skills-lock.json'), JSON.stringify({ skills: { alpha: {} } }));
  mkdirSync(join(dir, '.agents', 'skills', 'alpha'), { recursive: true });
  mkdirSync(join(dir, '.pi', 'skills', 'alpha'), { recursive: true });
  writeFileSync(join(dir, '.pi', 'skills', 'alpha', 'SKILL.md'), 'copy');

  const { items } = await planFor(dir);
  const item = items.find((i) => i.id === 'pi-skill-dupes');
  assert.ok(item);
  await item.apply();
  assert.equal(existsSync(join(dir, '.pi', 'skills', 'alpha')), false);
  assert.equal(existsSync(join(dir, '.agents', 'skills', 'alpha')), true, 'canonical copy stays');
});

test('fix: skills recorded in the lock but absent from .agents/skills are planned (restore via npx skills)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fix-skillsmiss-'));
  writeFileSync(join(dir, 'skills-lock.json'), JSON.stringify({ skills: { alpha: {}, beta: {} } }));
  mkdirSync(join(dir, '.agents', 'skills', 'alpha'), { recursive: true });
  const { items } = await planFor(dir);
  const item = items.find((i) => i.id === 'skills-missing');
  assert.ok(item);
  assert.match(item.label, /beta/);
  assert.doesNotMatch(item.label, /alpha/);
});

test('fix: runtime files recorded in the stamp manifest and gone from disk are restored from the bundled template', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fix-runtime-'));
  mkdirSync(join(dir, 'imp'), { recursive: true });
  writeFileSync(
    join(dir, 'imp', '.runtime-manifest.json'),
    JSON.stringify({
      files: {
        'imp/scripts/fia-tui.mjs': 'whatever-sha',
        'imp/no-longer-shipped.mjs': 'stale-sha',
      },
    }),
  );
  const { items } = await planFor(dir);
  const item = items.find((i) => i.id === 'runtime-missing');
  assert.ok(item, 'plans the runtime restore');
  const outcome = await item.apply();
  assert.equal(existsSync(join(dir, 'imp', 'scripts', 'fia-tui.mjs')), true, 'restored from fia-templates');
  assert.match(outcome, /file\(s\) restored/);
  assert.match(outcome, /no-longer-shipped/, 'a manifest entry the template no longer ships is reported, not invented');

  // A restored runtime file arrives with the SIBLINGS IT IMPORTS. The manifest
  // belongs to the version that stamped the project, so trusting it alone can
  // restore a file whose imports were added later — and a half-restored runtime
  // does not load at all (ERR_MODULE_NOT_FOUND on every FDA) while this command
  // reports success. fia-tui.mjs imports ../modules/format.mjs and
  // ./fia-tui-data.mjs, neither of which the manifest above lists.
  assert.equal(existsSync(join(dir, 'imp', 'modules', 'format.mjs')), true, 'sibling module restored too');
  assert.equal(existsSync(join(dir, 'imp', 'scripts', 'fia-tui-data.mjs')), true, 'sibling script restored too');
  // Prose is NOT completed here — no import graph to keep consistent, and new
  // prompts belong to --update-runtime.
  assert.equal(existsSync(join(dir, '.pi', 'prompts')), false, 'prose is left to --update-runtime');

  const replan = await planFor(dir);
  const again = replan.items.find((i) => i.id === 'runtime-missing');
  assert.ok(again, 'still pending: the manifest entry the template no longer ships');
  assert.match(again.label, /no-longer-shipped/);
});

test('fix: harness manifest → missing files planned for restore, modified ones only noted, AGENTS.md block planned', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fix-harness-'));
  writeFileSync(join(dir, 'kept.md'), 'the project version\n');
  await writeHarnessManifest(dir, {
    'deleted.md': sha1('harness content'),
    'kept.md': sha1('harness version'),
  });
  const { items, notes } = await planFor(dir);
  const missing = items.find((i) => i.id === 'harness-missing');
  assert.ok(missing, 'plans the harness restore');
  assert.match(missing.label, /deleted\.md/);
  assert.match(notes[0], /kept\.md/);
  assert.match(notes[0], /left alone/);
  assert.ok(items.find((i) => i.id === 'agents-md-block'), 'no marker in AGENTS.md → plans the block merge');
});

test('fix: a project with NO runtime manifest still gets its missing runtime code planned', async () => {
  // The gate this pins: `imp doctor` reports the incomplete runtime from
  // src/lib/runtime-health.js, which only requires imp/ to exist — while
  // `imp fix` used to wrap the repair in `if (runtimeManifest)`. A project whose
  // manifest is missing or unparseable got a ✖ naming `imp fix` and an
  // `imp fix` answering "Nothing to fix".
  const dir = mkdtempSync(join(tmpdir(), 'fix-nomanifest-'));
  mkdirSync(join(dir, 'imp', 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'imp', 'scripts', 'fia-tui.mjs'), '// stub');
  // No imp/.runtime-manifest.json at all.
  const { items } = await planFor(dir);
  const item = items.find((i) => i.id === 'runtime-missing');
  assert.ok(item, 'the repair is planned without a manifest');
  await item.apply();
  assert.equal(existsSync(join(dir, 'imp', 'modules', 'outcome.mjs')), true, 'runtime code restored');

  const replan = await planFor(dir);
  assert.equal(
    replan.items.find((i) => i.id === 'runtime-missing'),
    undefined,
    'and it converges — a second fix finds nothing',
  );
});

test('fix: a version-MIXED runtime is reported, never silently patched over', async () => {
  // Restore-only means fix may not overwrite an old-but-present sibling. What it
  // must not do is stay quiet: installing a current-version file next to a stale
  // one leaves exactly the unloadable tree the repair was meant to cure.
  const dir = mkdtempSync(join(tmpdir(), 'fix-mixed-'));
  mkdirSync(join(dir, 'imp', 'modules'), { recursive: true });
  mkdirSync(join(dir, 'imp', 'scripts'), { recursive: true });
  // Present but at another version, and one genuinely missing.
  writeFileSync(join(dir, 'imp', 'modules', 'continuation.mjs'), '// an older continuation.mjs\n');
  writeFileSync(join(dir, 'imp', 'scripts', 'fia-tui.mjs'), '// stub');

  const { items, notes } = await planFor(dir);
  assert.ok(
    items.find((i) => i.id === 'runtime-missing'),
    'the missing files are still planned',
  );
  const note = notes.find((n) => /older version than impactus ships/.test(n));
  assert.ok(note, 'the version mix is reported');
  assert.match(note, /continuation\.mjs/);
  assert.match(note, /--update-runtime/, 'and points at the command that resolves it');

  // Restore-only: the stale file keeps the student's bytes.
  assert.equal(
    readFileSync(join(dir, 'imp', 'modules', 'continuation.mjs'), 'utf8'),
    '// an older continuation.mjs\n',
  );
});
