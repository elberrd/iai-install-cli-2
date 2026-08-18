// Tripwire: the orchestrator prompts must tell the agent to try ONE
// automatic recovery before asking the engineer — never the old
// "stop immediately / never retry" wording as the only policy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PI = join(ROOT, 'pi-templates', '.pi');

const SURFACES = [
  ['prompts/goal.md', 'ONE automatic recovery'],
  ['prompts/task.md', 'ONE automatic recovery'],
  ['prompts/bug.md', 'ONE automatic recovery'],
  ['prompts/quick.md', 'ONE automatic recovery'],
  ['skills/fia/cookbooks/harness_bridge.md', 'ONE automatic recovery'],
  ['skills/fia/cookbooks/run_fda.md', 'Automatic recovery (once)'],
];

const HIDDEN_CYCLE = [
  ['prompts/goal.md', 'impossible/circular dependency'],
  ['prompts/task.md', 'impossible/circular dependency'],
  ['skills/fia/cookbooks/harness_bridge.md', 'Impossible dependency'],
  ['agents/task-sequencer.md', 'Impossible dependency (auto-split once)'],
  ['agents/task-master-generator.md', 'hidden cycle'],
];

test('orchestrator surfaces share the one-shot recovery policy', () => {
  for (const [rel, needle] of SURFACES) {
    const text = readFileSync(join(PI, rel), 'utf8');
    assert.ok(text.includes(needle), `${rel} lost its "${needle}" clause`);
    assert.equal(
      text.includes('without retrying on your own'),
      false,
      `${rel} reintroduced the old "never retry" stop`,
    );
    assert.equal(
      text.includes('never retry blindly'),
      false,
      `${rel} reintroduced "never retry blindly" as the only policy`,
    );
  }
});

test('sequencer surfaces auto-split a hidden cycle instead of asking first', () => {
  const harnessAgents = new Set(['agents/task-sequencer.md', 'agents/task-master-generator.md']);
  for (const [rel, needle] of HIDDEN_CYCLE) {
    const text = readFileSync(join(PI, rel), 'utf8');
    if (harnessAgents.has(rel)) {
      const name = rel.replace('agents/', '').replace('.md', '');
      assert.ok(
        text.includes('`.claude/agents/' + name + '.md`'),
        `${rel} must point at the harness agent (canonical auto-split lives there)`,
      );
      continue;
    }
    assert.ok(text.includes(needle), `${rel} lost its "${needle}" clause`);
  }
});

const HARNESS = join(ROOT, 'harness');
const hasHarness = existsSync(join(HARNESS, '.claude', 'agents'));
const skipHarness = !hasHarness && 'harness/ not present (nested repo, absent on fresh checkout)';

test('harness sequencer and planner share the hidden-cycle auto-split', { skip: skipHarness }, () => {
  const sequencer = readFileSync(join(HARNESS, '.claude', 'agents', 'task-sequencer.md'), 'utf8');
  assert.ok(sequencer.includes('Impossible dependency (auto-split once)'), 'harness task-sequencer lost the auto-split');
  assert.ok(sequencer.includes('8d. **Respect hidden cycles**'), 'harness task-sequencer lost rule 8d');
  const planner = readFileSync(join(HARNESS, '.claude', 'agents', 'task-master-generator.md'), 'utf8');
  assert.ok(planner.includes('No hidden cycles'), 'harness task-master-generator lost the hidden-cycle rule');
});
