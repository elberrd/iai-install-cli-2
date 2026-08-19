// The interaction contracts (pointer cursor, yellow search highlight,
// overlay width = trigger, calendar month/year caption, DataTable filter
// chrome, /ui-components one-component-per-card) live in ONE canonical
// file — harness/.claude/skills/design-system/references/interaction.md —
// and every other runtime carries a POINTER, not a restatement. This test
// is the tripwire that a refactor doesn't orphan one of the pointers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HARNESS = join(ROOT, 'harness');
const hasHarness = existsSync(join(HARNESS, '.claude', 'skills'));
const skip = !hasHarness && 'harness/ not present (nested repo, absent on fresh checkout)';

const CANONICAL = join(HARNESS, '.claude', 'skills', 'design-system', 'references', 'interaction.md');

test('the canonical interaction catalog exists and carries the load-bearing contracts', { skip }, () => {
  assert.ok(existsSync(CANONICAL), 'interaction.md missing from the design-system skill');
  const text = readFileSync(CANONICAL, 'utf8');
  const normalized = text.replace(/\s+/g, ' ');
  for (const needle of [
    'cursor-pointer',
    '--search-highlight',
    '<mark>',
    '--radix-popover-trigger-width',
    'caption',
    'per-column filter buttons',
    'one registry component per card',
    'kitchen-sink',
    'ordered grouping lane',
    'leaf-record count',
    'Restore defaults',
    'dedicated column-drag handle',
    'server-side sorting, filtering, and pagination',
    'many already-loaded rows',
  ]) {
    assert.ok(normalized.includes(needle), `canonical catalog lost its "${needle}" contract`);
  }
});

const POINTERS = [
  ['.claude/skills/design-system/SKILL.md', 'interaction.md'],
  ['.claude/skills/design-system/references/core-kit.md', 'interaction.md'],
  ['.claude/skills/design-system/references/components.md', 'interaction.md'],
  ['.claude/skills/design-system/references/tables.md', 'interaction.md'],
  ['.claude/skills/frontend-profissional/SKILL.md', 'interaction.md'],
  ['.claude/skills/frontend-profissional/references/selects.md', 'interaction.md'],
  ['.claude/skills/frontend-profissional/references/tabelas.md', 'interaction.md'],
  ['.claude/skills/frontend-profissional/references/formularios.md', 'interaction.md'],
  ['.claude/agents/ui-component-page.md', 'interaction.md'],
  ['.claude/agents/component-architect.md', 'interaction.md'],
  ['.claude/commands/kit.md', 'interaction.md'],
  ['.claude/commands/component.md', 'interaction.md'],
  ['.claude/commands/start.md', 'interaction.md'],
  ['.cursor/commands/kit.md', 'interaction.md'],
  ['.cursor/commands/component.md', 'interaction.md'],
  ['.cursor/commands/start.md', 'interaction.md'],
  ['.cursor/rules/react-ui.mdc', 'interaction.md'],
  ['.cursor/skills/workflow-start/SKILL.md', 'interaction.md'],
];

for (const [rel, needle] of POINTERS) {
  test(`${rel} points at the interaction contract`, { skip }, () => {
    const file = join(HARNESS, rel);
    assert.ok(existsSync(file), `${rel} does not exist`);
    assert.ok(readFileSync(file, 'utf8').includes(needle), `${rel} lost its "${needle}" pointer`);
  });
}

test('the Pi cookbook and wrappers carry the interaction hard rule', () => {
  const cookbook = readFileSync(
    join(ROOT, 'pi-templates', '.pi', 'skills', 'fia', 'cookbooks', 'components.md'),
    'utf8',
  );
  assert.ok(cookbook.includes('interaction.md'), 'cookbook lost the pointer to the interaction catalog');
  assert.ok(cookbook.includes('yellow'), 'cookbook lost the yellow-highlight contract');
  const page = readFileSync(join(ROOT, 'pi-templates', '.pi', 'agents', 'ui-component-page.md'), 'utf8');
  assert.ok(
    page.includes('`.claude/agents/ui-component-page.md`'),
    'Pi ui-component-page wrapper must point at the harness agent (isolation contract lives there)',
  );
  const kit = readFileSync(join(ROOT, 'pi-templates', '.pi', 'prompts', 'kit.md'), 'utf8');
  assert.ok(kit.includes('interaction.md'), '/kit prompt lost the interaction audit');
  const architect = readFileSync(join(ROOT, 'pi-templates', '.pi', 'agents', 'component-architect.md'), 'utf8');
  assert.ok(
    architect.includes('`.claude/agents/component-architect.md`'),
    'Pi component-architect wrapper must point at the harness agent',
  );
});

test('the UI-conformance rubric carries the interaction item', () => {
  const text = readFileSync(join(ROOT, 'fia-templates', 'modules', 'ui-gate.mjs'), 'utf8');
  assert.ok(text.includes('interaction.md'), 'UI rubric lost the pointer to the interaction catalog');
  assert.ok(text.includes('kitchen-sink'), 'UI rubric lost the showcase-isolation clause');
  assert.ok(text.includes('per-column filter buttons'), 'UI rubric lost the DataTable chrome clause');
});

test('the QA audit rubric carries the interaction item', () => {
  const text = readFileSync(join(ROOT, 'fia-templates', 'modules', 'qa-gate.mjs'), 'utf8');
  assert.ok(text.includes('interaction.md'), 'QA audit lost the pointer to the interaction catalog');
  assert.ok(text.includes('yellow'), 'QA audit lost the yellow-highlight clause');
});

// Cursor and Pi do not read harness/.claude/skills. In the harness they
// resolve `.agents/skills/<name>` → `.cursor/skills/<name>` (after
// sync:skills) and `.agents/agents/<file>` → `.claude/agents/<file>`.
// Editing only the Claude tree and skipping the sync leaves Cursor blind.
test('the agent-facing .agents paths resolve to the trees Cursor/Pi actually read', { skip }, () => {
  const skillLink = join(HARNESS, '.agents', 'skills', 'design-system');
  const agentLink = join(HARNESS, '.agents', 'agents', 'ui-component-page.md');
  const cursorAgent = join(HARNESS, '.cursor', 'agents', 'ui-component-page.md');
  assert.ok(lstatSync(skillLink).isSymbolicLink(), '.agents/skills/design-system must be a directory symlink');
  assert.match(readlinkSync(skillLink), /\.cursor\/skills\/design-system$/);
  assert.ok(lstatSync(agentLink).isSymbolicLink(), '.agents/agents/ui-component-page.md must be a symlink');
  assert.match(readlinkSync(agentLink), /\.claude\/agents\/ui-component-page\.md$/);
  assert.ok(lstatSync(cursorAgent).isSymbolicLink(), '.cursor/agents/ui-component-page.md must be a symlink');
  assert.match(readlinkSync(cursorAgent), /\.claude\/agents\/ui-component-page\.md$/);
  const viaAgents = readFileSync(join(skillLink, 'references', 'interaction.md'), 'utf8');
  assert.ok(viaAgents.includes('kitchen-sink'), 'Cursor/Pi .agents skill path lost interaction.md');
  assert.ok(
    readFileSync(agentLink, 'utf8').includes('interaction.md'),
    'Cursor/Pi .agents agent path lost the isolation pointer',
  );
});
