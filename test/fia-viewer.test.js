import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { connect } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Tracer } from '../fia-templates/modules/tracer.mjs';
import {
  startViewer,
  resolveViewerPaths,
  shouldReuseViewer,
} from '../fia-templates/scripts/fia-viewer.mjs';

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
    assert.equal(sessions.dbPath, realpathSync(dbPath));
    assert.ok(sessions.projectRoot, 'sessions advertise the project root so a later launch can tell whose page this is');

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

test('viewer page: run_end is reachable from a filter, not only from "All"', async () => {
  const { PAGE } = await import('../fia-templates/scripts/fia-viewer-page.mjs');
  // lessons.md: a new event TYPE needs the dashboard classifiers updated, or it
  // is invisible. `run_end` is the run's closing row — the single most useful
  // event in the stream — so it must ride the lifecycle and the error filters.
  const phaseFilter = /if\(f==='phase'\) return ([^;]+);/.exec(PAGE);
  assert.ok(phaseFilter, 'the page still has a phase filter branch');
  assert.match(phaseFilter[1], /run_end/, "run_end rides the 'phase' filter");

  const errorFilter = /if\(f==='error'\) return ([^;]+);/.exec(PAGE);
  assert.ok(errorFilter, 'the page still has an error filter branch');
  assert.match(errorFilter[1], /run_end/, "run_end rides the 'error' filter");
  // …but only when the run did NOT meet its goal: a filter that always has a row
  // in it stops meaning anything.
  assert.match(errorFilter[1], /name!=='goal_met'/, 'a green run_end stays out of Errors');
  assert.match(PAGE, /function evMatches\(type, name\)/, 'the filter can see the outcome');

  // And it must be styled, not fall through to the generic 'other' bucket.
  assert.match(PAGE, /type==='run_end'\) return \['ty-/, 'run_end has its own style class');
});

test('viewer page: the named outcome is on the sidebar cards, and the reason is visible text', async () => {
  const { PAGE } = await import('../fia-templates/scripts/fia-viewer-page.mjs');
  // One label helper, shared by the sidebar list and the Status KPI.
  assert.match(PAGE, /function outcomeText\(outcome\)/, 'the page has a single outcome-label helper');

  const sidebar = /\nfunction renderSidebar\(\)\{([\s\S]*?)\n\}/.exec(PAGE);
  assert.ok(sidebar, 'the page still has renderSidebar');
  // A list of 20 runs that all say "fail" cannot answer "which ones stalled?".
  assert.match(sidebar[1], /outcomeText\(s\.outcome\)/, 'each card shows the named outcome');
  // …and typing the slug must find them, so it rides the text filter too.
  assert.match(sidebar[1], /\(s\.outcome\|\|''\)/, 'the sidebar filter matches on the outcome');
  assert.match(PAGE, /\.scard \.meta \.oc \{/, 'the card outcome is styled');

  const kpis = /\nfunction renderKpis\(\)\{([\s\S]*?)\n\}/.exec(PAGE);
  assert.ok(kpis, 'the page still has renderKpis');
  // The sentence is the point of the vocabulary — a hover tooltip is invisible
  // on touch and to anyone scanning the KPI row.
  assert.match(kpis[1], /class="why">'\+esc\(s\.outcome_reason\)/, 'the reason renders as text');
  assert.doesNotMatch(kpis[1], /title="'\+esc\(s\.outcome_reason\)/, 'not hidden in a title attribute');
  assert.match(PAGE, /\.kpi \.why \{/, 'the reason line is styled');
});

test('viewer: relative db paths pin to the project root, not later cwd', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-viewer-root-'));
  const paths = resolveViewerPaths({
    projectRoot: root,
    dbPath: 'imp/data/fia.db',
    aiDocsDir: 'ai-docs',
    configPath: 'imp/fia.config.yaml',
  });
  assert.equal(paths.projectRoot, realpathSync(root));
  assert.equal(paths.dbPath, join(realpathSync(root), 'imp/data/fia.db'));
  assert.equal(paths.aiDocsDir, join(realpathSync(root), 'ai-docs'));
});

test('viewer: reuse only the occupant that is this project', () => {
  const ours = { projectRoot: '/proj/a', dbPath: '/proj/a/imp/data/fia.db' };
  assert.equal(shouldReuseViewer({ projectRoot: '/proj/a', dbPath: ours.dbPath, db: true }, ours), true);
  assert.equal(shouldReuseViewer({ projectRoot: '/proj/b', dbPath: '/proj/b/imp/data/fia.db', db: true }, ours), false);
  // Leftover after a folder move: old servers advertised a relative path and
  // often db:false. That is someone else's cwd — never a match.
  assert.equal(shouldReuseViewer({ db: false, dbPath: 'imp/data/fia.db', sessions: [] }, ours), false);
  assert.equal(shouldReuseViewer(null, ours), false);
});

test('viewer page: a missing db is a different empty state than "no runs yet"', async () => {
  const { PAGE } = await import('../fia-templates/scripts/fia-viewer-page.mjs');
  assert.match(PAGE, /Cannot see this project/, 'lost-db hero is distinct from the first-run empty state');
  assert.match(PAGE, /press <code>v<\/code> in the TUI/, 'the recovery is the TUI key that opens a fresh viewer');
  assert.match(PAGE, /renderEmptyMain\(data\.dbPath, data\.db\)/, 'the empty state sees whether the file opened');
});

function waitForViewerUrl(child, ms = 8000) {
  return new Promise((resolveUrl, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`no viewer URL in time:\n${out}`)), ms);
    const onData = (chunk) => {
      out += chunk;
      const m = out.match(/https?:\/\/127\.0\.0\.1:\d+\S*/);
      if (m) {
        clearTimeout(timer);
        resolveUrl(m[0]);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      const m = out.match(/https?:\/\/127\.0\.0\.1:\d+\S*/);
      if (m) {
        clearTimeout(timer);
        resolveUrl(m[0]);
      } else {
        clearTimeout(timer);
        reject(new Error(`viewer exited ${code}:\n${out}`));
      }
    });
  });
}

test('viewer CLI: a stale occupant (other folder / db:false) does not steal this project page', async () => {
  const staleRoot = mkdtempSync(join(tmpdir(), 'fia-stale-'));
  const stale = await startViewer({ dbPath: join(staleRoot, 'missing.db'), projectRoot: staleRoot, port: 0 });
  const port = stale.address().port;
  const root = mkdtempSync(join(tmpdir(), 'fia-live-'));
  const dbPath = seedDb(root);
  const script = fileURLToPath(new URL('../fia-templates/scripts/fia-viewer.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, '--port', String(port), '--db', dbPath, '--no-open'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const url = await waitForViewerUrl(child);
    const usedPort = Number(new URL(url).port);
    assert.notEqual(usedPort, port, 'must not reuse the stale occupant');
    const sessions = await (await fetch(`http://127.0.0.1:${usedPort}/api/sessions`)).json();
    assert.equal(sessions.db, true);
    assert.equal(sessions.sessions[0].fda_id, 'demo1');
    assert.equal(sessions.projectRoot, realpathSync(root));
  } finally {
    child.kill('SIGKILL');
    stale.close();
  }
});

test('viewer CLI: the same project already on the port is reused, not stacked', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-reuse-'));
  const dbPath = seedDb(root);
  const first = await startViewer({ dbPath, projectRoot: root, port: 0 });
  const port = first.address().port;
  const script = fileURLToPath(new URL('../fia-templates/scripts/fia-viewer.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, '--port', String(port), '--db', dbPath, '--no-open'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const url = await waitForViewerUrl(child);
    assert.equal(Number(new URL(url).port), port);
    const exitCode = await new Promise((resolveExit) => {
      if (child.exitCode != null) return resolveExit(child.exitCode);
      child.once('exit', (code) => resolveExit(code ?? 0));
      setTimeout(() => resolveExit('still-running'), 2000).unref();
    });
    assert.notEqual(exitCode, 'still-running', 'the reuse path must exit instead of stacking a second server');
  } finally {
    child.kill('SIGKILL');
    first.close();
  }
});
