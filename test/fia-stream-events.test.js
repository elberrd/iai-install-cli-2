import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStreamRecorder, toolSummary, preview } from '../fia-templates/modules/stream-events.mjs';

function fakeRun() {
  const rows = [];
  return {
    rows,
    fdaId: 'fda1',
    tracer: { event: (r) => rows.push(r) },
  };
}
const phase = { phase_id: 'fda1_01_build' };
const agent = { name: 'builder' };

test('recorder: pi tool_execution start/end → one tool_call event with duration', () => {
  const run = fakeRun();
  const on = makeStreamRecorder(run, phase, agent);
  on({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'src/app.ts' } });
  on({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'read', result: 'content', isError: false });
  assert.equal(run.rows.length, 1);
  const ev = run.rows[0];
  assert.equal(ev.type, 'tool_call');
  assert.equal(ev.name, 'read: src/app.ts');
  assert.equal(ev.payload.ok, true);
  assert.equal(ev.payload.agent, 'builder');
  assert.ok(ev.started_at && ev.ended_at);
});

test('recorder: pi tool error → ok=false', () => {
  const run = fakeRun();
  const on = makeStreamRecorder(run, phase, agent);
  on({ type: 'tool_execution_start', toolCallId: 't2', toolName: 'bash', args: { command: 'npm test' } });
  on({ type: 'tool_execution_end', toolCallId: 't2', toolName: 'bash', result: 'exit 1', isError: true });
  assert.equal(run.rows[0].payload.ok, false);
  assert.equal(run.rows[0].name, 'bash: npm test');
});

test('recorder: claude tool_use + tool_result pair', () => {
  const run = fakeRun();
  const on = makeStreamRecorder(run, phase, agent);
  on({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c1', name: 'Read', input: { file_path: 'a.md' } }] } });
  on({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c1', is_error: false, content: [{ type: 'text', text: 'ok' }] }] } });
  assert.equal(run.rows.length, 1);
  assert.equal(run.rows[0].name, 'Read: a.md');
  assert.equal(run.rows[0].payload.ok, true);
});

test('recorder: unmatched/unknown events are ignored', () => {
  const run = fakeRun();
  const on = makeStreamRecorder(run, phase, agent);
  on({ type: 'message_update' });
  on({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'nope' }] } });
  on(null);
  assert.equal(run.rows.length, 0);
});

test('toolSummary + preview helpers', () => {
  assert.equal(toolSummary('read', { path: 'x.ts' }), 'read: x.ts');
  assert.equal(toolSummary('grep', { pattern: 'foo' }), 'grep: foo');
  assert.equal(toolSummary('ls', null), 'ls');
  assert.ok(preview('a'.repeat(500)).length < 400);
  assert.equal(preview(null), '');
});
