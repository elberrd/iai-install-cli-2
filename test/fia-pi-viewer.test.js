import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startViewer } from '../fia-templates/scripts/fia-viewer.mjs';
import { piSessionsDirFor, agentFromSessionName, listPiSessions } from '../fia-templates/scripts/pi-sessions.mjs';

const T0 = '2026-08-04T15:00:00.000Z';
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

/** Fabricate a pi sessions dir: one interactive session with one subagent run. */
function seedPiDir(root) {
  const dir = join(root, 'pi-sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sess1.jsonl'), jsonl([
    { type: 'session', id: 's1', timestamp: T0, cwd: '/tmp/projeto', version: 3 },
    { type: 'model_change', id: 'm1', timestamp: T0, provider: 'openai-codex', modelId: 'gpt-5.6-sol' },
    { type: 'thinking_level_change', id: 't1', timestamp: T0, thinkingLevel: 'high' },
    { type: 'message', id: 'u1', timestamp: '2026-08-04T15:00:05.000Z', message: { role: 'user', content: [{ type: 'text', text: 'map the whole project' }] } },
    { type: 'message', id: 'a1', timestamp: '2026-08-04T15:00:09.000Z', message: { role: 'assistant', model: 'gpt-5.6-sol', usage: { input: 1200, output: 80 }, content: [
      { type: 'thinking', thinking: '...' },
      { type: 'toolCall', id: 'call_1', name: 'subagent', arguments: { agent: 'start-mapper', async: true } },
    ] } },
    { type: 'message', id: 'r1', timestamp: '2026-08-04T15:00:12.000Z', message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'subagent', isError: false, content: [{ type: 'text', text: 'spawned' }] } },
    { type: 'message', id: 'a2', timestamp: '2026-08-04T15:00:20.000Z', message: { role: 'assistant', model: 'gpt-5.6-sol', usage: { input: 900, output: 40 }, content: [
      { type: 'text', text: 'Subagent dispatched, waiting.' },
    ] } },
  ]));
  const runDir = join(dir, 'sess1', 'ab12cd34', 'run-0');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'session.jsonl'), jsonl([
    { type: 'session', id: 'c1', timestamp: '2026-08-04T15:00:10.000Z', cwd: '/tmp/projeto', version: 3 },
    { type: 'model_change', id: 'cm1', timestamp: '2026-08-04T15:00:10.000Z', provider: 'openai-codex', modelId: 'gpt-5.6-sol' },
    { type: 'session_info', id: 'ci1', timestamp: '2026-08-04T15:00:10.100Z', name: 'subagent-start-mapper-5e8a33b2-02c5-44fa-8ed8-f8fccd67bdd1' },
    { type: 'message', id: 'cu1', timestamp: '2026-08-04T15:00:11.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Task: map the codebase' }] } },
    { type: 'message', id: 'ca1', timestamp: '2026-08-04T15:00:15.000Z', message: { role: 'assistant', model: 'gpt-5.6-sol', usage: { input: 300, output: 25 }, content: [
      { type: 'toolCall', id: 'call_x', name: 'read', arguments: { path: 'ai-docs/PRD.md' } },
    ] } },
    { type: 'message', id: 'cr1', timestamp: '2026-08-04T15:00:16.000Z', message: { role: 'toolResult', toolCallId: 'call_x', toolName: 'read', isError: true, content: [{ type: 'text', text: 'ENOENT: file does not exist' }] } },
  ]));
  return dir;
}

test('pi viewer: sessions list + detail with subruns and tool durations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-pi-'));
  const piDir = seedPiDir(root);
  const server = await startViewer({ dbPath: join(root, 'missing.db'), piDir, port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await (await fetch(base + '/')).text();
    assert.match(page, /Pi interativo|Interactive Pi/);

    const list = await (await fetch(base + '/api/pi-sessions')).json();
    assert.equal(list.available, true);
    assert.equal(list.sessions.length, 1);
    const s = list.sessions[0];
    assert.equal(s.id, 'sess1');
    assert.equal(s.model, 'gpt-5.6-sol');
    assert.equal(s.thinking, 'high');
    assert.equal(s.msgCount, 3);
    assert.equal(s.subagents, 1);
    assert.equal(s.request, 'map the whole project');
    assert.equal(s.tokensOut, 120);

    const detail = await (await fetch(base + '/api/pi-session?id=sess1')).json();
    assert.equal(detail.meta.provider, 'openai-codex');
    const call = detail.events.find((e) => e.type === 'tool_call');
    assert.match(call.name, /subagent: start-mapper/);
    assert.equal(call.ok, true);
    assert.equal(call.ended_at, '2026-08-04T15:00:12.000Z');
    assert.ok(detail.events.some((e) => e.type === 'assistant'));
    assert.equal(detail.subruns.length, 1);
    assert.equal(detail.subruns[0].agent, 'start-mapper');
    assert.equal(detail.subruns[0].path, 'ab12cd34/run-0');
    assert.equal(detail.subruns[0].task, 'Task: map the codebase');
  } finally {
    server.close();
  }
});

test('pi viewer: run detail surfaces tool errors; unsafe ids are rejected', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-pi-'));
  const piDir = seedPiDir(root);
  const server = await startViewer({ dbPath: join(root, 'missing.db'), piDir, port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const run = await (await fetch(base + '/api/pi-run?id=sess1&path=ab12cd34/run-0')).json();
    assert.equal(run.agent, 'start-mapper');
    const failed = run.events.find((e) => e.type === 'tool_call');
    assert.equal(failed.ok, false);
    assert.ok(run.events.some((e) => e.type === 'error'));

    const traversal = await fetch(base + '/api/pi-session?id=..%2Fsess1');
    assert.equal(traversal.status, 404);
    const badRun = await fetch(base + '/api/pi-run?id=sess1&path=..%2F..%2Fetc');
    assert.equal(badRun.status, 404);
  } finally {
    server.close();
  }
});

test('pi viewer: missing sessions dir → available:false, empty list', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-pi-'));
  const server = await startViewer({ dbPath: join(root, 'missing.db'), piDir: join(root, 'nope'), port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const list = await (await fetch(base + '/api/pi-sessions')).json();
    assert.equal(list.available, false);
    assert.deepEqual(list.sessions, []);
  } finally {
    server.close();
  }
});

test('pi sessions: quiet-but-recent is idle, only real silence is finished', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-pi-state-'));
  const dir = join(root, 'pi-sessions');
  mkdirSync(dir, { recursive: true });
  const row = { type: 'message', id: 'u1', timestamp: T0, message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } };
  for (const name of ['fresh', 'quiet', 'old']) writeFileSync(join(dir, `${name}.jsonl`), jsonl([row]));
  const at = (agoMs) => new Date(Date.now() - agoMs);
  utimesSync(join(dir, 'quiet.jsonl'), at(90_000), at(90_000)); // 90s quiet — the engineer may just be thinking
  utimesSync(join(dir, 'old.jsonl'), at(10 * 60_000), at(10 * 60_000)); // 10 min → really finished

  const byId = Object.fromEntries(listPiSessions(dir).map((s) => [s.id, s]));
  assert.equal(byId.fresh.state, 'running');
  assert.equal(byId.fresh.running, true);
  assert.equal(byId.quiet.state, 'idle', 'a 90s pause is not "finished"');
  assert.equal(byId.quiet.running, false);
  assert.equal(byId.old.state, 'finished');
});

test('pi helpers: project slug dir and subagent name parsing', () => {
  assert.equal(
    piSessionsDirFor('/Users/x/proj', '/home/u'),
    '/home/u/.pi/agent/sessions/--Users-x-proj--',
  );
  assert.equal(agentFromSessionName('subagent-start-mapper-5e8a33b2-02c5-44fa-8ed8-f8fccd67bdd1'), 'start-mapper');
  assert.equal(agentFromSessionName('subagent-task-sequencer-67add438-e6c2-4136-b6f7-049a9513e41e-1'), 'task-sequencer');
  assert.equal(agentFromSessionName('my-session'), null);
});
