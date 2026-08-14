// The semantic-fields contract ("known-domain data never becomes free text":
// UF → Combobox, country → flag picker, CEP → ViaCEP lookup…) lives in ONE
// canonical file — harness/.claude/skills/design-system/references/
// semantic-fields.md — and every other runtime carries a POINTER, not a
// restatement. This test is the tripwire that a refactor doesn't orphan one
// of the pointers: if any consumer loses its reference, the rule silently
// stops reaching that runtime (Claude skill, Cursor rule, brief → C8 gate,
// registry seeding, Pi cookbook).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HARNESS = join(ROOT, 'harness');
const hasHarness = existsSync(join(HARNESS, '.claude', 'skills'));
const skip = !hasHarness && 'harness/ not present (nested repo, absent on fresh checkout)';

const CANONICAL = join(HARNESS, '.claude', 'skills', 'design-system', 'references', 'semantic-fields.md');

test('the canonical semantic-fields catalog exists and carries the load-bearing contracts', { skip }, () => {
  assert.ok(existsSync(CANONICAL), 'semantic-fields.md missing from the design-system skill');
  const text = readFileSync(CANONICAL, 'utf8');
  // The facts other files deliberately do NOT restate — losing one here
  // loses it everywhere, so pin them.
  for (const needle of ['ViaCEP', 'BrasilAPI', 'ISO 3166', 'UF_VALUES', 'E.164', 'integer cents', 'never blocking']) {
    assert.ok(text.includes(needle), `canonical catalog lost its "${needle}" contract`);
  }
});

// Every consumer runtime must point at the canonical file (by its name).
// harness/.cursor twins are covered by the byte-identical mirror test.
const POINTERS = [
  ['.claude/skills/design-system/SKILL.md', 'semantic-fields'],
  ['.claude/skills/design-system/references/components.md', 'semantic-fields'],
  ['.claude/skills/frontend-profissional/SKILL.md', 'semantic-fields'],
  ['.claude/skills/frontend-profissional/references/formularios.md', 'semantic-fields'],
  ['.claude/agents/task-sequencer.md', 'semantic-fields'],
  ['.claude/agents/component-architect.md', 'semantic-fields'],
  ['.claude/commands/component.md', 'semantic-fields'],
  ['.cursor/commands/component.md', 'semantic-fields'],
  ['.cursor/rules/react-ui.mdc', 'semantic-fields'],
  ['ai-docs/components/registry.md', 'semantic-fields'],
  ['ai-docs/PRD.md', 'semantic type'],
  ['ai-docs/ui/patterns.md', 'semantic-fields'],
];

for (const [rel, needle] of POINTERS) {
  test(`${rel} points at the semantic-fields contract`, { skip }, () => {
    const file = join(HARNESS, rel);
    assert.ok(existsSync(file), `${rel} does not exist`);
    assert.ok(readFileSync(file, 'utf8').includes(needle), `${rel} lost its "${needle}" pointer`);
  });
}

test('the brief Quality Checklist carries the no-free-text gate line (feeds the C8 gate)', { skip }, () => {
  const text = readFileSync(join(HARNESS, '.claude', 'agents', 'task-sequencer.md'), 'utf8');
  // The line must be a checkbox inside the brief template — that is what
  // makes checkAcceptanceChecklist (fia-templates/modules/gates.mjs) refuse
  // to close a run that ignored it.
  assert.match(
    text,
    /- \[ \] No known-domain field .* free-text input/,
    'task-sequencer Quality Checklist lost the semantic-fields checkbox',
  );
});

// The Pi/FDA runtime never sees harness skills — its knowledge rides in the
// cookbook, so the cookbook must carry the rule AND the pointer.
test('the Pi cookbook carries the semantic-fields hard rule', () => {
  const text = readFileSync(join(ROOT, 'pi-templates', '.pi', 'skills', 'fia', 'cookbooks', 'components.md'), 'utf8');
  assert.ok(text.includes('semantic-fields'), 'cookbook lost the pointer to the canonical catalog');
  assert.ok(text.includes('ViaCEP'), 'cookbook lost the CEP-lookup contract');
  const idea = readFileSync(join(ROOT, 'pi-templates', '.pi', 'prompts', 'idea.md'), 'utf8');
  assert.ok(idea.includes('semantic type'), '/idea wrap-up no longer asks for semantic types in the data model');
  const wrapper = readFileSync(join(ROOT, 'pi-templates', '.pi', 'agents', 'task-sequencer.md'), 'utf8');
  assert.ok(wrapper.includes('semantic-fields'), 'Pi task-sequencer wrapper lost the Semantic fields mandate');
});

// The deterministic UI gate must audit the semantic-fields rule too — this
// is the join between the two defenses: the catalog says WHAT, the gate
// refuses to close a run that shipped a free-text input for known-domain data.
test('the UI-conformance rubric carries the semantic-field item', () => {
  const text = readFileSync(join(ROOT, 'fia-templates', 'modules', 'ui-gate.mjs'), 'utf8');
  assert.ok(text.includes('semantic component'), 'UI rubric lost the semantic-field item');
  assert.ok(text.includes('semantic-fields.md'), 'UI gate prompt lost the pointer to the canonical catalog');
});
