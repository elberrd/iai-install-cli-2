import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

test('/task and /goal route the explicit prototype marker to the guarded runner', () => {
  const task = read('../pi-templates/.pi/prompts/task.md');
  const goal = read('../pi-templates/.pi/prompts/goal.md');
  const sequencer = read('../pi-templates/.pi/agents/task-sequencer.md');
  const runner = read('../fia-templates/fda_prototype.mjs');

  for (const surface of [task, goal]) {
    assert.match(surface, /Mode: prototype/);
    assert.match(surface, /fda_prototype/);
  }
  assert.match(sequencer, /copy it verbatim into the brief/);
  assert.match(runner, /isPrototypeBrief\(prompt\)/);
  assert.match(runner, /requires an explicit `Mode: prototype` line/);
});
