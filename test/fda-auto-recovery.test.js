// Tripwire: the orchestrator prompts must carry the recovery policy —
// progress-gated in goal mode (repair each NEW gap without asking, bounded by
// the code-enforced recovery budget in verdict.mjs), one-shot in the
// single-task commands where the engineer is present — never the old
// "stop immediately / never retry" wording as the only policy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PI = join(ROOT, 'pi-templates', '.pi');

const PROGRESS = 'recover automatically while the run is making PROGRESS';
const SURFACES = [
  ['prompts/goal.md', [PROGRESS, 'recovery budget']],
  ['prompts/task.md', ['ONE automatic recovery']],
  ['prompts/bug.md', ['ONE automatic recovery']],
  ['prompts/quick.md', ['ONE automatic recovery']],
  ['skills/fia/cookbooks/harness_bridge.md', [PROGRESS, 'recovery budget']],
  ['skills/fia/cookbooks/run_fda.md', ['Automatic recovery (once)', 'recovery budget']],
];

// A paused flow + "continue" from the engineer = authorization for the
// recommended action; re-asking is the exact behavior this policy removes.
const CONTINUE_AUTHORIZES = [
  'skills/fia/SKILL.md',
  'prompts/goal.md',
  'skills/fia/cookbooks/harness_bridge.md',
  'skills/fia/cookbooks/run_fda.md',
];

const HIDDEN_CYCLE = [
  ['prompts/goal.md', 'impossible/circular dependency'],
  ['prompts/task.md', 'impossible/circular dependency'],
  ['skills/fia/cookbooks/harness_bridge.md', 'Impossible dependency'],
  ['agents/task-sequencer.md', 'Impossible dependency (auto-split once)'],
  ['agents/task-master-generator.md', 'hidden cycle'],
];

test('orchestrator surfaces carry the recovery policy for their mode', () => {
  for (const [rel, needles] of SURFACES) {
    const text = readFileSync(join(PI, rel), 'utf8');
    for (const needle of needles) assert.ok(text.includes(needle), `${rel} lost its "${needle}" clause`);
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

test('a paused flow treats "continue" as authorization, never a reason to re-ask', () => {
  for (const rel of CONTINUE_AUTHORIZES) {
    const text = readFileSync(join(PI, rel), 'utf8');
    assert.ok(text.includes('never re-ask'), `${rel} lost the "continue authorizes the recommendation" clause`);
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
