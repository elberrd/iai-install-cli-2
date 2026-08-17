import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Tracer } from '../fia-templates/modules/tracer.mjs';
import { fmtDur, fmtAge, fmtTokens, fmtCost, durSec } from '../fia-templates/modules/format.mjs';
import {
  openDb,
  listSessions,
  sessionDetail,
  tailEvents,
  devTotals,
  currentPhase,
  loadPlan,
  loadRoster,
  specTraceability,
  modelUsage,
} from '../fia-templates/scripts/fia-tui-data.mjs';
import { renderMarkdown } from '../fia-templates/scripts/fia-tui-md.mjs';
import { FIA } from '../src/config.js';
import { viewerLaunchSpec, computeHeaderLayout, hitHeaderTab } from '../fia-templates/scripts/fia-tui.mjs';

const REPO = join(fileURLToPath(new URL('..', import.meta.url)));
const TUI = join(REPO, 'fia-templates', 'scripts', 'fia-tui.mjs');

// Same seeding shape as fia-viewer.test.js: one finished-ish session with a
// running last phase, real events and an agent session with a context window.
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
  tracer.event({
    fda_id: 'demo1',
    phase_id: p2.phase_id,
    type: 'tool_call',
    name: 'read: src/app.ts',
    payload: { ok: true },
  });
  tracer.event({
    fda_id: 'demo1',
    phase_id: p2.phase_id,
    type: 'agent_end',
    name: 'planner',
    payload: {},
    tokens: 4200,
  });
  tracer.agentSessionRow(
    'demo1',
    { name: 'planner', coding_agent: 'claude_code', model: 'claude-x' },
    'sess-1',
    4200,
    200000,
  );
  tracer.sessionFinish('demo1', true);
  return dbPath;
}

function seedAiDocs(root) {
  const dir = join(root, 'ai-docs');
  mkdirSync(join(dir, 'todos', 'issues'), { recursive: true });
  mkdirSync(join(dir, 'specs'), { recursive: true });
  writeFileSync(
    join(dir, 'todos', 'task-master.md'),
    [
      '# Tasks',
      '',
      '| # | Task | Status | Blocked by | Priority | Complexity | Milestone |',
      '|---|------|--------|------------|----------|------------|-----------|',
      '| 01 | [First thing](issues/01-first-thing.md) | done | None | high | 3 | M1 |',
      '| 02 | [Second thing](issues/02-second-thing.md) | pending | 01 | medium | 2 | M1 |',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'todos', 'issues', '01-first-thing.md'),
    [
      '# Task 01 — First thing',
      '',
      '**Status:** done',
      '**Blocked by:** None',
      '**Priority:** high',
      '',
      '## Acceptance criteria',
      '- [x] it works',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'todos', 'issues', '02-second-thing.md'),
    [
      '# Task 02 — Second thing',
      '',
      '**Status:** pending',
      '**Blocked by:** 01',
      '',
      '## Acceptance criteria',
      '- [ ] it also works',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'specs', '0001-first-spec.md'),
    [
      '# Spec 0001 — First spec',
      'Status: defined',
      'Created: 2026-08-13 · Updated: 2026-08-13',
      'Tasks: 01',
      '',
      '## Traceability',
      '',
      '| Requirement | Scenario | Test |',
      '|-------------|----------|------|',
      '| FR-1 | S-1 | `tests/first.spec.ts` |',
      '| FR-2 | S-2 | — |',
      '',
      '## Gate log',
      '- Definition Gate: passed — 2026-08-13',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'milestones.md'),
    [
      '# Milestones',
      '',
      '## M1 — First slice',
      'Goal: ship the slice',
      'Status: in-progress',
      'Tasks: 01, 02',
      '',
    ].join('\n'),
  );
  writeFileSync(join(dir, 'inbox.md'), '- [ ] open idea\n- [x] promoted idea\n');
  return dir;
}

test('format: durations, ages, tokens and cost match the viewer semantics', () => {
  assert.equal(fmtDur(5.23), '5.2s');
  assert.equal(fmtDur(42), '42s');
  assert.equal(fmtDur(432), '7m 12s');
  assert.equal(fmtDur(8100), '2h 15m');
  assert.equal(fmtDur(null), '—');
  assert.equal(fmtTokens(812), '812');
  assert.equal(fmtTokens(4200), '4.2k');
  assert.equal(fmtTokens(2_340_000), '2.34M');
  assert.equal(fmtTokens(999_960), '1.00M');
  assert.equal(fmtCost(12.4), '$12.40');
  assert.equal(fmtCost(0), '—');
  const now = Date.parse('2026-08-13T12:00:00Z');
  assert.equal(fmtAge('2026-08-13T11:58:30Z', now), '1min');
  assert.equal(durSec('2026-08-13T11:58:30Z', '2026-08-13T12:00:00Z'), 90);
});

test('data: sessions, detail, tail cursor and dev totals from a seeded db', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-tui-'));
  const db = openDb(seedDb(root));
  assert.ok(db);

  const sessions = listSessions(db);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].fda_id, 'demo1');
  assert.equal(sessions[0].status, 'success');

  const detail = sessionDetail(db, 'demo1');
  assert.equal(detail.phases.length, 3);
  assert.equal(currentPhase(detail.phases).name, 'commit');
  assert.equal(detail.agentSessions[0].context_window, 200000);

  const tail1 = tailEvents(db, 'demo1', 0);
  assert.equal(tail1.events.length >= 2, true);
  const tail2 = tailEvents(db, 'demo1', tail1.last);
  assert.equal(tail2.events.length, 0);
  assert.equal(tail2.last, tail1.last);
  assert.equal(sessionDetail(db, '../evil'), null);

  const totals = devTotals(db);
  assert.equal(totals.sessions, 1);
  assert.ok(totals.seconds > 0);
  db.close();
});

test('data: plan side — counts, frontier, milestones and roster defaults', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-tui-plan-'));
  const aiDocs = seedAiDocs(root);
  const { overview, tasks } = loadPlan(aiDocs, root);

  assert.equal(tasks.counts.total, 2);
  assert.equal(tasks.counts.done, 1);
  assert.deepEqual(tasks.frontier, ['02']);
  assert.equal(overview.next.num, '02');
  assert.equal(overview.specs.counts.defined, 1);
  assert.equal(overview.counts.inboxOpen, 1);
  const m1 = overview.milestones.milestones[0];
  assert.equal(m1.id, 'M1');
  assert.deepEqual(m1.progress, { done: 1, total: 2 });

  const cfgPath = join(root, 'fia.config.yaml');
  writeFileSync(
    cfgPath,
    [
      'defaults:',
      '  coding_agent: pi',
      '  model: gpt-x',
      'agents:',
      '  - name: builder',
      '    purpose: writes code',
      '  - name: planner',
      '    coding_agent: claude_code',
      '    model: claude-x',
      '',
    ].join('\n'),
  );
  const roster = loadRoster(cfgPath);
  assert.equal(roster.agents.length, 2);
  assert.equal(roster.agents[0].coding_agent, 'pi');
  assert.equal(roster.agents[0].model, 'gpt-x');
  assert.equal(roster.agents[1].coding_agent, 'claude_code');
  // the default LLM is first-class, and inherited vs explicit is visible
  assert.equal(roster.defaults.coding_agent, 'pi');
  assert.equal(roster.defaults.model, 'gpt-x');
  assert.equal(roster.agents[0].explicit.model, false); // builder inherits
  assert.equal(roster.agents[1].explicit.model, true); // planner overrides
});

test('data: per-LLM ledger keeps history when the model switches mid-project', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-tui-usage-'));
  const dbPath = join(root, 'fia.db');
  const tr = new Tracer(dbPath, join(root, 'sessions', 'r1', 'events.jsonl'));
  // run 1: builder on claude-opus-5 — the spend is stamped with the model
  tr.sessionStart('r1', 'Dev', 'fda_sdlc');
  tr.event({
    fda_id: 'r1',
    phase_id: 'p1',
    type: 'agent_end',
    name: 'builder',
    tokens: 1000,
    payload: { cost: 0.5, model: 'claude-opus-5', coding_agent: 'claude_code' },
  });
  tr.sessionFinish('r1', true);
  // the student switches the LLM and keeps building the app → run 2 on codex
  tr.sessionStart('r2', 'Dev', 'fda_sdlc');
  for (const [tokens, cost] of [
    [700, 0.2],
    [300, 0.1],
  ]) {
    tr.event({
      fda_id: 'r2',
      phase_id: 'p',
      type: 'agent_end',
      name: 'builder',
      tokens,
      payload: { cost, model: 'gpt-5.2-codex', coding_agent: 'pi' },
    });
  }
  tr.sessionFinish('r2', true);
  // run 0: data recorded BEFORE stamping — resolves through agent_sessions;
  // plus one event nothing can resolve, which must surface, not vanish
  tr.sessionStart('r0', 'Dev', 'fda_quick');
  tr.agentSessionRow('r0', { name: 'scout', coding_agent: 'pi', model: 'gpt-old' }, 's0', 0, 0);
  tr.event({ fda_id: 'r0', phase_id: 'p1', type: 'agent_end', name: 'scout', tokens: 50, payload: {} });
  tr.event({ fda_id: 'r0', phase_id: 'p2', type: 'agent_end', name: 'ghost', tokens: 5, payload: {} });
  tr.sessionFinish('r0', true);

  const db = openDb(dbPath);
  const usage = modelUsage(db);
  const byModel = Object.fromEntries(usage.rows.map((r) => [r.model, r]));
  assert.equal(byModel['claude-opus-5'].tokens, 1000); // old model keeps its log
  assert.equal(byModel['claude-opus-5'].runs, 1);
  assert.equal(byModel['gpt-5.2-codex'].tokens, 1000); // new model accumulates apart
  assert.equal(byModel['gpt-5.2-codex'].runs, 1);
  assert.ok(Math.abs(byModel['gpt-5.2-codex'].cost - 0.3) < 1e-9);
  assert.equal(byModel['gpt-old'].tokens, 50); // pre-stamp data still attributed
  assert.equal(usage.unattributed, 5);
  db.close();
});

test('data: spec traceability flags requirements with no test', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-tui-trace-'));
  const aiDocs = seedAiDocs(root);
  const trace = specTraceability(aiDocs, 'specs/0001-first-spec.md');
  assert.equal(trace.available, true);
  assert.equal(trace.total, 2);
  assert.equal(trace.covered, 1);
  assert.equal(trace.rows[0].covered, true);
  assert.equal(trace.rows[0].test, 'tests/first.spec.ts');
  assert.equal(trace.rows[1].covered, false);
  assert.equal(specTraceability(aiDocs, 'specs/missing.md').available, false);
});

test('markdown: renders headings and lists to terminal lines', () => {
  const lines = renderMarkdown('# Title\n\nSome **bold** text\n\n- item one\n- item two', 60);
  assert.ok(lines.length >= 3);
  assert.ok(lines.some((l) => l.includes('Title')));
  assert.ok(lines.some((l) => l.includes('item two')));
  // degrades to raw text on garbage input, never throws
  assert.ok(Array.isArray(renderMarkdown(null, 60)));
});

test('registration: npm script, stamped script and runtime deps all in place', () => {
  assert.equal(FIA.npmScripts.tui, 'node imp/scripts/fia-tui.mjs');
  assert.ok(existsSync(TUI));
  assert.ok(existsSync(join(REPO, 'fia-templates', 'scripts', 'fia-tui-data.mjs')));
  assert.ok(existsSync(join(REPO, 'fia-templates', 'modules', 'format.mjs')));
  const pkg = JSON.parse(readFileSync(join(REPO, 'fia-templates', 'package.json'), 'utf8'));
  for (const dep of ['ink', 'react', 'chokidar', 'marked', 'marked-terminal'])
    assert.ok(pkg.dependencies[dep], `${dep} missing from fia-templates deps`);
});

test('tui: DocView and TestsPane mount through React with real props', async () => {
  const { Writable } = await import('node:stream');
  const { DocView, TestsPane } = await import('../fia-templates/scripts/fia-tui.mjs');
  const React = (await import('react')).default;
  const { render } = await import('ink');
  const chunks = [];
  const fakeStdout = () => {
    const s = new Writable({
      write(c, _enc, cb) {
        chunks.push(String(c));
        cb();
      },
    });
    s.columns = 80;
    s.rows = 24;
    return s;
  };
  const doc = { title: 'Spec 0001 — Payment', path: 'specs/0001.md', lines: ['heading', 'line two'], scroll: 0 };
  const a = render(React.createElement(DocView, { doc, height: 12 }), { stdout: fakeStdout(), patchConsole: false });
  a.unmount();
  const tests = { running: false, code: 0, lines: ['ok 1 - first', 'suite passed'] };
  const b = render(React.createElement(TestsPane, { tests, height: 12, width: 80 }), {
    stdout: fakeStdout(),
    patchConsole: false,
  });
  b.unmount();
  const out = chunks.join('');
  assert.match(out, /Spec 0001 — Payment/);
  assert.match(out, /line two/);
  assert.match(out, /1–2\/2/); // scroll position footer
  assert.match(out, /Tests/);
  assert.match(out, /✓ passed/);
  assert.match(out, /suite passed/);
});

test('tui: the named outcome reaches both LIST surfaces, and its reason the detail', async () => {
  const { Writable } = await import('node:stream');
  const { RunPanel, RunsList, RunDetail } = await import('../fia-templates/scripts/fia-tui.mjs');
  const React = (await import('react')).default;
  const { render } = await import('ink');
  const chunks = [];
  const fakeStdout = (columns) => {
    const s = new Writable({
      write(c, _enc, cb) {
        chunks.push(String(c));
        cb();
      },
    });
    s.columns = columns;
    s.rows = 40;
    return s;
  };
  const t0 = new Date(Date.now() - 13_000).toISOString();
  const t1 = new Date().toISOString();
  const run = (fda_id, status, outcome, outcome_reason) => ({
    fda_id,
    fda_name: 'quick',
    status,
    outcome,
    outcome_reason,
    started_at: t0,
    ended_at: t1,
    total_tokens: 12300,
    total_cost: 0.42,
    request: 'Add a settings page',
  });
  const capped = run('r1', 'fail', 'attempt_cap', 'suite failed after 3 fix attempt(s)');
  const gated = run('r2', 'fail', 'blocked_by_gate', 'the ui gate refused the diff');
  const legacy = run('r3', 'success', undefined, undefined); // recorded before outcomes existed

  // Home card: the very first line a student reads after a run.
  const home = render(React.createElement(RunPanel, { run: { session: capped, phases: [] }, now: Date.now() }), {
    stdout: fakeStdout(130),
    patchConsole: false,
  });
  home.unmount();
  // Runs tab: the screen used to pick WHICH run to open.
  const list = render(
    React.createElement(RunsList, { sessions: [capped, gated, legacy], sel: 0, height: 20, width: 120 }),
    { stdout: fakeStdout(130), patchConsole: false },
  );
  list.unmount();
  // Detail: the sentence that says why, not just the category.
  const detail = render(
    React.createElement(RunDetail, {
      detail: { session: capped, phases: [], gates: [], agentSessions: [], phaseTokens: [], engineEvents: [] },
      now: Date.now(),
      height: 20,
      width: 100,
    }),
    { stdout: fakeStdout(110), patchConsole: false },
  );
  detail.unmount();

  const out = chunks.join('');
  assert.match(out, /last run: r1/);
  assert.match(out, /attempt cap reached/); // Home card + Runs row
  assert.match(out, /blocked by a gate/); // two failed runs are told apart in the list
  assert.match(out, /success/); // a row with no outcome keeps the bare status
  assert.match(out, /suite failed after 3 fix attempt\(s\)/); // the reason, on screen
});

test('tui: header layout keeps all six tabs hittable when the FDA badge is long', () => {
  const status = '● FDA running (e6e64a6e) — read-only';
  const name = 'Gestor Pessoal de Projetos';
  // The screenshot width: title + 6 tabs + badge overflowed and ate Agents/Pi.
  const layout = computeHeaderLayout({ cols: 110, projectName: name, status });
  assert.equal(layout.tabs.length, 6);
  assert.ok(layout.tabs.every((t) => t.x1 <= 110), 'no tab is drawn past the right edge');
  assert.ok(layout.tabs[4].x1 <= 110 - 1, 'Agents stays on-screen instead of under the badge');
  assert.match(layout.tabs[4].label, /Agents/);
  assert.match(layout.tabs[5].label, /Pi/);
  // Click where the user SEES "2 Work" — not where an untruncated title would have put it.
  const work = layout.tabs[1];
  assert.equal(hitHeaderTab(layout, work.x0, 0), 1);
  assert.equal(hitHeaderTab(layout, work.x1 - 1, 0), 1);
  assert.equal(hitHeaderTab(layout, work.x0, 1), -1, 'body clicks are not tab clicks');
  // Tight terminal: tabs still win over the project name and the badge.
  const tight = computeHeaderLayout({ cols: 70, projectName: name, status });
  assert.equal(tight.tabs.length, 6);
  assert.ok(tight.tabs.every((t) => t.x1 <= 70));
  assert.ok(tight.status.length < status.length, 'the badge shrinks before a tab disappears');
});

test('tui: v launches the viewer with this project absolute db path and cwd', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-tui-viewer-'));
  const spec = viewerLaunchSpec({ root, dbPath: 'imp/data/fia.db', aiDocsDir: 'ai-docs' }, 2);
  assert.equal(spec.cwd, resolve(root));
  const dbFlag = spec.args.indexOf('--db');
  assert.ok(dbFlag >= 0, 'passes --db so the viewer does not inherit a leftover cwd');
  assert.equal(spec.args[dbFlag + 1], join(root, 'imp/data/fia.db'));
  assert.equal(spec.args[spec.args.indexOf('--ai-docs') + 1], join(root, 'ai-docs'));
  assert.ok(spec.args.includes('--detach'));
});

test('tui: --help prints usage without a terminal', () => {
  const r = spawnSync(process.execPath, [TUI, '--help'], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /FIA TUI/);
  assert.match(r.stdout, /--once/);
});

test('tui: --once renders one dashboard frame over a seeded project', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-tui-smoke-'));
  const dbPath = seedDb(root);
  const aiDocs = seedAiDocs(root);
  const r = spawnSync(process.execPath, [TUI, '--once'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, FIA_DB: dbPath, FIA_AI_DOCS: aiDocs, CI: '1' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /impactus/);
  assert.match(r.stdout, /Tasks/);
  assert.match(r.stdout, /1\/2/); // task counts from the seeded plan
  assert.match(r.stdout, /Pi/);
});

test('tui: PiCommandPanel shows live tokens and activity', async () => {
  const { PiCommandPanel } = await import('../fia-templates/scripts/fia-tui.mjs');
  const React = (await import('react')).default;
  const { render } = await import('ink');
  const { Writable } = await import('node:stream');
  const chunks = [];
  const fakeStdout = () => {
    const s = new Writable({
      write(c, _enc, cb) {
        chunks.push(String(c));
        cb();
      },
    });
    s.columns = 120;
    s.rows = 30;
    return s;
  };
  const started = new Date(Date.now() - 120_000).toISOString();
  const inst = render(
    React.createElement(PiCommandPanel, {
      cmd: {
        command: 'map',
        started_at: started,
        tokens_in: 38000,
        tokens_out: 7200,
        cost: 0.42,
        current_activity: 'subagent: task-master-generator',
        phases: [{ id: 'p1', label: 'start-mapper', started_at: started, ended_at: new Date().toISOString(), tokens_in: 1000, tokens_out: 200, cost: 0.1 }],
        docs_written: ['ai-docs/map.yaml'],
        status: 'running',
      },
      now: Date.now(),
      width: 100,
    }),
    { stdout: fakeStdout(), patchConsole: false },
  );
  inst.unmount();
  const out = chunks.join('');
  assert.match(out, /live command/);
  assert.match(out, /\/map/);
  assert.match(out, /in 38\.0k/);
  assert.match(out, /subagent: task-master-generator/);
});

test('tui: --tab 6 renders Pi telemetry sections', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-tui-pi-'));
  seedDb(root);
  const aiDocs = seedAiDocs(root);
  const tel = join(root, 'imp/data/telemetry');
  mkdirSync(tel, { recursive: true });
  writeFileSync(
    join(tel, 'live.json'),
    `${JSON.stringify({ id: 'x', command: 'stack', started_at: new Date().toISOString(), tokens_in: 100, tokens_out: 20, cost: 0, docs_written: [], phases: [], status: 'running' })}\n`,
  );
  const r = spawnSync(process.execPath, [TUI, '--once', '--tab', '6'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, FIA_DB: join(root, 'fia.db'), FIA_AI_DOCS: aiDocs, CI: '1' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Live interactive command/);
  assert.match(r.stdout, /\/stack/);
});
