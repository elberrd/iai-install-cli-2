import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Tracer } from '../fia-templates/modules/tracer.mjs';
import { startViewer } from '../fia-templates/scripts/fia-viewer.mjs';

function seedDb(root) {
  const dbPath = join(root, 'fia.db');
  const tracer = new Tracer(dbPath, join(root, 'sessions', 'demo1', 'events.jsonl'));
  tracer.sessionStart('demo1', 'Tester', 'fda_demo');
  tracer.sessionRequest('demo1', 'build page X');
  const t0 = Date.now() - 30_000;
  const phase = (seq, name, kind, owner, startMs, endMs, status = 'success') => ({
    phase_id: `demo1_${String(seq).padStart(2, '0')}_${name}`,
    fda_id: 'demo1',
    seq,
    params: { name, kind, owner, description: `${name} phase` },
    status,
    attempt: 0,
    error: null,
    started_at: new Date(t0 + startMs).toISOString(),
    ended_at: endMs == null ? null : new Date(t0 + endMs).toISOString(),
  });
  const p2 = phase(2, 'plan', 'agent', 'planner', 5200, 14400);
  tracer.phaseUpsert(phase(1, 'request', 'engineer', 'engineer', 0, 5200));
  tracer.phaseUpsert(p2);
  tracer.phaseUpsert(phase(3, 'commit', 'code', 'git', 14400, null, 'running'));

  tracer.event({ fda_id: 'demo1', phase_id: p2.phase_id, type: 'tool_call', name: 'read: src/app.ts', payload: { ok: true } });
  tracer.event({ fda_id: 'demo1', phase_id: p2.phase_id, type: 'gate_pass', name: 'artifactsExist', payload: { attempt: 1 } });
  tracer.event({ fda_id: 'demo1', phase_id: p2.phase_id, type: 'agent_end', name: 'planner', payload: {}, tokens: 4200 });
  tracer.gateRow(p2, 'artifactsExist', { passed: true, violations: [], checks: [{ item: 'specs/plan.md', ok: true, note: '1.2KB' }] }, 1);
  tracer.envelopeRow(p2, 'planner', 'PlanOutput', JSON.stringify({ status: 'success', summary: 'plan ready' }), true, 1);
  tracer.agentSessionRow('demo1', { name: 'planner', coding_agent: 'claude_code', model: 'claude-x' }, 'sess-1', 4200, 200000);
  tracer.sessionFinish('demo1', true);

  const promptsDir = join(root, 'sessions', 'demo1', 'planner', 'prompts');
  mkdirSync(promptsDir, { recursive: true });
  writeFileSync(join(promptsDir, 'system.md'), 'You are the planner.\nRules...\n');
  writeFileSync(join(promptsDir, 'user.md'), 'Request: X\n');
  return dbPath;
}

test('viewer: page + sessions + full session detail', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-viewer-'));
  const dbPath = seedDb(root);
  const server = await startViewer({ dbPath, port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await (await fetch(base + '/')).text();
    assert.match(page, /the IAI Agent Factory/);

    const sessions = await (await fetch(base + '/api/sessions')).json();
    assert.equal(sessions.db, true);
    assert.equal(sessions.sessions[0].fda_id, 'demo1');

    const detail = await (await fetch(base + '/api/session?fda_id=demo1')).json();
    assert.equal(detail.session.status, 'success');
    assert.equal(detail.phases.length, 3);
    assert.equal(detail.gates.length, 1);
    assert.equal(detail.gates[0].gate, 'artifactsExist');
    assert.equal(detail.envelopes.length, 1);
    assert.equal(detail.envelopes[0].output_type, 'PlanOutput');
    assert.equal(detail.agentSessions[0].context_window, 200000);
    assert.equal(detail.phaseTokens.find((r) => r.phase_id === 'demo1_02_plan').tokens, 4200);
  } finally {
    server.close();
  }
});

test('viewer: incremental event feed via after=rowid', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-viewer-'));
  const dbPath = seedDb(root);
  const server = await startViewer({ dbPath, port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await (await fetch(base + '/api/events?fda_id=demo1&after=0')).json();
    assert.ok(first.events.length >= 2, 'seeded events are returned');
    assert.ok(first.events.some((e) => e.type === 'tool_call'));
    const second = await (await fetch(base + `/api/events?fda_id=demo1&after=${first.last}`)).json();
    assert.equal(second.events.length, 0, 'no new events after the cursor');
    assert.equal(second.last, first.last);
  } finally {
    server.close();
  }
});

test('viewer: prompts endpoint reads session files and rejects traversal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-viewer-'));
  const dbPath = seedDb(root);
  const server = await startViewer({ dbPath, port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await (await fetch(base + '/api/prompts?fda_id=demo1&agent=planner')).json();
    assert.match(ok.system, /planner/);
    assert.match(ok.user, /Request/);

    const bad = await fetch(base + '/api/prompts?fda_id=..%2F..&agent=planner');
    assert.equal(bad.status, 400);
  } finally {
    server.close();
  }
});

// ── orphaned 'running' sessions must not lock the roster save ────────────────

const CONFIG_YAML = [
  'defaults:',
  '  coding_agent: pi',
  '  model: openai/gpt-5',
  'agents:',
  '  - name: planner',
  '    coding_agent: pi',
  '    model: openai/gpt-5',
  '',
].join('\n');

/** A session stuck on status='running' whose last event is `ageMs` old. */
function seedRunning(root, fdaId, ageMs) {
  const dbPath = join(root, 'fia.db');
  const tracer = new Tracer(dbPath, join(root, 'sessions', fdaId, 'events.jsonl'));
  tracer.sessionStart(fdaId, 'Tester', 'fda_demo');
  const at = new Date(Date.now() - ageMs).toISOString();
  tracer.event({ fda_id: fdaId, type: 'tool_call', name: 'read: x', payload: {}, started_at: at, ended_at: at });
  return dbPath;
}

test('viewer: stale orphan (old events) is flagged and does NOT lock the roster save', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-viewer-'));
  const dbPath = seedRunning(root, 'orphan1', 20 * 60_000); // 20 min silent, no live pid
  const configPath = join(root, 'fia.config.yaml');
  writeFileSync(configPath, CONFIG_YAML);
  const server = await startViewer({ dbPath, configPath, port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const sessions = await (await fetch(base + '/api/sessions')).json();
    assert.equal(sessions.sessions[0].status, 'running');
    assert.equal(sessions.sessions[0].stale, true, 'orphan is marked stale');

    const detail = await (await fetch(base + '/api/session?fda_id=orphan1')).json();
    assert.equal(detail.session.stale, true);
    assert.ok(detail.session.last_activity, 'last activity exposed so the UI can stop the timeline');

    const save = await fetch(base + '/api/roster', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agents: [{ name: 'planner', coding_agent: 'pi', model: 'openai/gpt-5.2' }] }),
    });
    assert.equal(save.status, 200, 'stale orphan must not lock the save');
    assert.equal((await save.json()).ok, true);
    assert.match(readFileSync(configPath, 'utf8'), /gpt-5\.2/);
  } finally {
    server.close();
  }
});

test('viewer: genuinely live run still locks the save — 409 carries fda_id and age', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-viewer-'));
  const dbPath = seedRunning(root, 'live1', 5_000); // active 5s ago
  const configPath = join(root, 'fia.config.yaml');
  writeFileSync(configPath, CONFIG_YAML);
  const server = await startViewer({ dbPath, configPath, port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const save = await fetch(base + '/api/roster', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agents: [{ name: 'planner', coding_agent: 'pi', model: 'openai/gpt-5.2' }] }),
    });
    assert.equal(save.status, 409);
    const body = await save.json();
    assert.equal(body.error, 'fda-running');
    assert.equal(body.fda_id, 'live1');
    assert.ok(body.age_s != null && body.age_s < 600, 'age of the last activity is included');
  } finally {
    server.close();
  }
});

test('viewer: malformed request URL answers 400 and the server survives', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-viewer-'));
  const server = await startViewer({ dbPath: join(root, 'missing.db'), port: 0 });
  const port = server.address().port;
  try {
    const raw = await new Promise((resolve, reject) => {
      const sock = connect(port, '127.0.0.1', () => {
        // absolute-form target that new URL() rejects
        sock.write('GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      });
      let buf = '';
      sock.on('data', (d) => { buf += d; });
      sock.on('end', () => resolve(buf));
      sock.on('error', reject);
    });
    assert.match(raw, /HTTP\/1\.1 400/);
    const sessions = await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json();
    assert.equal(sessions.db, false, 'server still answers after the bad request');
  } finally {
    server.close();
  }
});

test('viewer CLI: --detach reports a child that fails to start (no fake success URL)', () => {
  const script = fileURLToPath(new URL('../fia-templates/scripts/fia-viewer.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script, '--detach', '--port', '99999999', '--no-open'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(r.status, 1, 'parent exits 1 when the background child dies');
  assert.ok(r.stderr.trim().length > 0, 'child error is surfaced');
  assert.ok(!/FIA viewer in the background/.test(r.stdout), 'no success URL printed');
});

test('viewer: no db yet → sessions list empty, page still serves', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-viewer-'));
  const server = await startViewer({ dbPath: join(root, 'missing.db'), port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const sessions = await (await fetch(base + '/api/sessions')).json();
    assert.equal(sessions.db, false);
    assert.deepEqual(sessions.sessions, []);
  } finally {
    server.close();
  }
});

test('agents editor: the fallback cap comes from MAX_FALLBACKS (server and page agree)', async () => {
  const { MAX_FALLBACKS } = await import('../fia-templates/modules/engines.mjs');
  const { PAGE } = await import('../fia-templates/scripts/fia-viewer-page.mjs');
  // The page's "+ add fallback" affordance must use the shared constant — a
  // hardcoded smaller number silently hides chain slots the server accepts.
  assert.match(PAGE, new RegExp(`fallbacks\\.length < ${MAX_FALLBACKS} \\?`));
  assert.doesNotMatch(PAGE, /fallbacks\.length < 3 \?/);
});
