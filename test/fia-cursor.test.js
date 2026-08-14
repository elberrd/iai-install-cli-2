import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCursorArgs } from '../fia-templates/modules/agent-cursor.mjs';
import { loadConfig, validate } from '../fia-templates/modules/agents.mjs';
import { makeStreamRecorder } from '../fia-templates/modules/stream-events.mjs';

test('buildCursorArgs: headless flags, model, and resume only with a session', () => {
  const fresh = buildCursorArgs({ prompt: 'do X', model: 'sonnet-4.5' });
  assert.deepEqual(fresh, ['-p', '--force', '--output-format', 'stream-json', '--model', 'sonnet-4.5', 'do X']);

  const resumed = buildCursorArgs({ prompt: 'continue', model: 'gpt-5', sessionId: 'chat-42' });
  assert.ok(resumed.includes('--resume'));
  assert.equal(resumed[resumed.indexOf('--resume') + 1], 'chat-42');

  const noModel = buildCursorArgs({ prompt: 'x' });
  assert.ok(!noModel.includes('--model'));
});

test('validate: accepts coding_agent cursor and rejects unknown engines', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-cfg-'));
  mkdirSync(join(root, 'pe'), { recursive: true });
  writeFileSync(join(root, 'pe', 'system.md'), 'sys');
  writeFileSync(join(root, 'pe', 'user.md'), 'user {{prompt}}');
  const cfgPath = join(root, 'fia.config.yaml');
  writeFileSync(
    cfgPath,
    [
      'defaults:',
      '  coding_agent: pi',
      '  model: openai/gpt-5-codex',
      'agents:',
      '  - name: cursorzinho',
      '    coding_agent: cursor',
      '    model: sonnet-4.5',
      '    prompt_engineering:',
      `      system: ${join(root, 'pe', 'system.md')}`,
      `      user: ${join(root, 'pe', 'user.md')}`,
      '  - name: quebrado',
      '    coding_agent: gemini_cli',
      '    prompt_engineering:',
      `      system: ${join(root, 'pe', 'system.md')}`,
      `      user: ${join(root, 'pe', 'user.md')}`,
    ].join('\n'),
  );
  const cfg = loadConfig(cfgPath);
  validate(cfg, ['cursorzinho']); // does not throw
  assert.throws(() => validate(cfg, ['quebrado']), /gemini_cli not supported/);
});

test('recorder: cursor tool_call started/completed pair with duration', () => {
  const rows = [];
  const run = { fdaId: 'f1', tracer: { event: (r) => rows.push(r) } };
  const on = makeStreamRecorder(run, { phase_id: 'f1_01_build' }, { name: 'builder' });
  on({ type: 'tool_call', subtype: 'started', call_id: 'c9', tool_call: { readToolCall: { args: { path: 'src/a.ts' } } } });
  on({ type: 'tool_call', subtype: 'completed', call_id: 'c9', tool_call: { readToolCall: { args: { path: 'src/a.ts' }, result: { content: 'ok' } } } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'tool_call');
  assert.equal(rows[0].name, 'read: src/a.ts');
  assert.equal(rows[0].payload.ok, true);
  assert.ok(rows[0].started_at && rows[0].ended_at);
});
