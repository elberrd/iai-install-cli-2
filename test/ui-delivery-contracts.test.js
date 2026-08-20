import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HARNESS = join(ROOT, 'harness');
const hasHarness = existsSync(join(HARNESS, '.claude'));
const skip = !hasHarness && 'harness/ not present (nested repo, absent on fresh checkout)';
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8');
const readHarness = (...parts) => readFileSync(join(HARNESS, ...parts), 'utf8');

test('UI planning is fail-closed around a versioned applicability contract', { skip }, () => {
  for (const rel of [
    ['.claude', 'commands', 'start.md'],
    ['.claude', 'agents', 'screen-routes-generator.md'],
    ['.claude', 'agents', 'task-master-generator.md'],
    ['.claude', 'agents', 'task-sequencer.md'],
    ['.claude', 'agents', 'component-architect.md'],
  ]) {
    const text = readHarness(...rel);
    assert.match(text, /ai-docs\/ui\/contract\.json/, `${rel.join('/')} lost the UI contract gate`);
    assert.match(text, /ui-contract/i, `${rel.join('/')} lost the UI contract workflow`);
  }
});

test('core kit is capability-driven and owns the professional shell, table, and board', { skip }, () => {
  const text = readHarness('.claude', 'skills', 'design-system', 'references', 'core-kit.md');
  for (const needle of [
    'ai-docs/ui/contract.json',
    'AppShell',
    'PageHeader',
    'Breadcrumb',
    'ThemeToggle',
    'DataTable',
    'Kanban',
    'not_applicable',
    'waived',
  ]) {
    assert.ok(text.includes(needle), `core-kit lost ${needle}`);
  }
  assert.doesNotMatch(
    text,
    /\| Board with drag-and-drop \| `Kanban`[^\n]+\| planned \|/,
    'an applicable Kanban must not be left for a feature agent to improvise',
  );
  assert.doesNotMatch(text, /`ui\.(?:foundation|visualization)\./, 'core-kit must not cite rule ids outside UI_RULES');
  assert.match(
    text,
    /Advanced table controls[^\n]+canonical `DataTable`[^\n]+`data_table\.advanced_controls`/,
    'advanced controls belong to the canonical DataTable, not an automatic licensed grid',
  );
  assert.match(
    text,
    /`optional` \+ `false`|capability boolean as `true`|capability boolean is explicitly set to `true`/i,
  );
});

test('UI briefs carry explicit route depth for deterministic breadcrumb applicability', { skip }, () => {
  const sequencer = readHarness('.claude', 'agents', 'task-sequencer.md');
  assert.match(sequencer, /Route depth: \[N\]/);
  assert.match(sequencer, /Route depth: unknown/);
  assert.match(sequencer, /screens-routes\.md/);
});

test('/ui-contract is distributed to Claude, Cursor, and Pi', { skip }, () => {
  const claude = join(HARNESS, '.claude', 'commands', 'ui-contract.md');
  const cursor = join(HARNESS, '.cursor', 'commands', 'ui-contract.md');
  const pi = join(ROOT, 'pi-templates', '.pi', 'prompts', 'ui-contract.md');
  assert.ok(existsSync(claude), 'Claude /ui-contract command missing');
  assert.ok(existsSync(cursor), 'Cursor /ui-contract command missing');
  assert.ok(existsSync(pi), 'Pi /ui-contract prompt missing');
  assert.match(read('scripts', 'command-overlays.yaml'), /^\s{2}ui-contract:/m);
  assert.match(readFileSync(claude, 'utf8'), /required|not_applicable|waived/);
  const piPrompt = readFileSync(pi, 'utf8');
  const piCookbook = read('pi-templates', '.pi', 'skills', 'fia', 'cookbooks', 'ui-contract.md');
  assert.match(piPrompt, /ui-contract\.mjs/);
  assert.match(piPrompt, /existing\/specified library|custom project component/i);
  assert.match(piCookbook, /implementation --surface/);
  assert.match(piCookbook, /fia-universal/);
  assert.match(piCookbook, /examples.*optional shelf/i);
});

test('UI gate evaluates named rules through the deterministic contract', () => {
  const text = read('fia-templates', 'modules', 'ui-gate.mjs');
  assert.match(text, /loadUiContract|evaluateUiRule/);
  assert.match(text, /rule[_ -]?id/i);
  assert.match(text, /SKIP/i);
  assert.match(text, /reason/i);
  assert.match(text, /data_table\.advanced_controls/);
  assert.match(text, /quality\.overflow_containment/);
});

test('browser QA contract covers geometry, themes, zoom, and accessible alternatives', () => {
  const gate = read('fia-templates', 'modules', 'qa-gate.mjs');
  const playwright = read('fia-templates', 'modules', 'qa-playwright.mjs');
  for (const needle of [
    '100%',
    '125%',
    '200%',
    'light',
    'dark',
    'system',
    'right-click',
    'keyboard',
    'toolbar height',
    'bounding box',
    'DragOverlay',
    'Move to',
  ]) {
    assert.ok(gate.includes(needle), `QA prompt lost ${needle}`);
  }
  assert.match(playwright, /width: 360/);
  assert.match(playwright, /width: 768/);
  assert.match(playwright, /width: 1440/);
});

test(
  'enterprise DataTable behavior is propagated to planning, brownfield audit, and the live catalog demo',
  { skip },
  () => {
    const core = readHarness('.claude', 'skills', 'design-system', 'references', 'core-kit.md');
    const interaction = readHarness('.claude', 'skills', 'design-system', 'references', 'interaction.md');
    const taskMaster = readHarness('.claude', 'agents', 'task-master-generator.md');
    const kit = readHarness('.claude', 'commands', 'kit.md');
    const componentPage = readHarness('.claude', 'agents', 'ui-component-page.md');

    for (const [name, text] of [
      ['core kit', core],
      ['interaction catalog', interaction],
      ['task master', taskMaster],
      ['brownfield kit', kit],
      ['component page', componentPage],
    ]) {
      const normalized = text.replace(/\s+/g, ' ');
      for (const needle of [
        /ordered grouping lane/i,
        /leaf-record count/i,
        /Restore defaults/i,
        /versioned per-user/i,
        /dedicated column-drag handle/i,
        /sticky header/i,
        /server-side sorting, filtering, and pagination/i,
        /many already-loaded rows/i,
      ]) {
        assert.match(normalized, needle, `${name} lost ${needle}`);
      }
    }

    assert.match(core, /ordinary grouping[^\n]+three levels[^\n]+TanStack/i);
    assert.match(core, /pivot[\s\S]+tree[\s\S]+sub-grid[\s\S]+Excel-like/i);
    assert.doesNotMatch(core, /alternative[^\n]+advanced grouping/i);
  },
);

test('professional DataTable base chrome remains available with the explicit compact opt-out', { skip }, () => {
  const core = readHarness('.claude', 'skills', 'design-system', 'references', 'core-kit.md');
  const interaction = readHarness('.claude', 'skills', 'design-system', 'references', 'interaction.md');
  const frontend = readHarness('.claude', 'skills', 'frontend-profissional', 'references', 'tabelas.md');
  const taskMaster = readHarness('.claude', 'agents', 'task-master-generator.md');
  const docs = read('DOCS.md');

  assert.match(core, /Base — column header menu/);
  assert.match(core, /Base — filter chrome/);
  assert.match(interaction, /DataTable base chrome \(`components\.data_table`\)/);
  assert.match(frontend, /base professional\s+filter\/header\/chip chrome/i);
  assert.match(taskMaster, /full professional base contract/i);
  assert.match(docs, /professional base contract/i);

  for (const [name, text] of [
    ['core kit', core],
    ['interaction catalog', interaction],
    ['frontend table reference', frontend],
    ['task master', taskMaster],
    ['DOCS', docs],
  ]) {
    const normalized = text.replace(/\s+/g, ' ');
    assert.match(
      normalized,
      /(?:one|a single) (?:\*\*)?Filter(?:\*\*)? control/i,
      `${name} lost the base Filter control`,
    );
    assert.match(normalized, /Shift\+F10|Context Menu key/i, `${name} lost the keyboard header-menu path`);
    assert.match(normalized, /chips/i, `${name} lost active-filter chips`);
  }
});

test('advancedControls is professional by default with a deterministic compact opt-out', { skip }, () => {
  const sources = [
    ['core kit', readHarness('.claude', 'skills', 'design-system', 'references', 'core-kit.md')],
    ['table wiring', readHarness('.claude', 'skills', 'design-system', 'references', 'tables.md')],
    ['interaction contract', readHarness('.claude', 'skills', 'design-system', 'references', 'interaction.md')],
    ['task master', readHarness('.claude', 'agents', 'task-master-generator.md')],
    ['component architect', readHarness('.claude', 'agents', 'component-architect.md')],
    ['component catalog', readHarness('.claude', 'agents', 'ui-component-page.md')],
    ['brownfield kit', readHarness('.claude', 'commands', 'kit.md')],
    ['DOCS', read('DOCS.md')],
  ];

  for (const [name, text] of sources) {
    const normalized = text.replace(/\s+/g, ' ');
    assert.match(normalized, /advancedControls/i, `${name} lost the explicit advanced prop`);
    assert.match(normalized, /default(?:s to)?\s*`?true/i, `${name} lost the professional default`);
    assert.match(normalized, /base-only[\s\S]{0,220}advancedControls=\{false\}/i, `${name} lost the compact opt-out`);
  }

  const tables = sources.find(([name]) => name === 'table wiring')[1];
  assert.match(tables, /advancedControls=\{true\}/);
  assert.match(tables, /advancedControls[^.]+default `true`/i);
  assert.match(tables, /base-only[^.]+advancedControls=\{false\}/i);
  assert.match(
    tables.replace(/\s+/g, ' '),
    /explicit false[^.]+(?:group|pin)[^.]+(?:resize|density)[^.]+persistence[^.]+sticky/i,
  );
});

test('browser QA carries route applicability explicitly across replayable phases', () => {
  const runtime = read('fia-templates', 'fda_qa.mjs');
  const gate = read('fia-templates', 'modules', 'qa-gate.mjs');

  assert.doesNotMatch(gate, /scopeRouteDepths/, 'route applicability must not depend on module-global prompt history');
  assert.doesNotMatch(runtime, /function loadRoutes/, 'QA must not load every project route into a scoped run');
  assert.match(runtime, /routesForQaScope/);
  assert.ok(
    runtime.match(/routes: resolved\.routes/g)?.length >= 3,
    'author, audit, and report must receive the same resolved route set',
  );
  assert.ok(
    runtime.match(/contract: resolved\.contract/g)?.length >= 3,
    'author, audit, and report must receive the replay-safe validated contract',
  );
});

test('/goal blocks a completed UI milestone on browser QA', () => {
  const goal = read('pi-templates', '.pi', 'prompts', 'goal.md');
  assert.match(goal, /node imp\/fda_qa\.mjs/);
  assert.match(goal, /STOP|block/i);
  assert.doesNotMatch(goal, /do not auto-run it/);
});
