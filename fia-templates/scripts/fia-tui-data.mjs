/**
 * Data layer of the FIA TUI (fia-tui.mjs) — everything the dashboard shows,
 * with zero UI dependencies, so tests can exercise it without a terminal.
 *
 * Two sources, both read-only:
 *   - imp/data/fia.db (SQLite, WAL) — sessions, phases, events, gates. WAL
 *     means a reader never blocks a live FDA run.
 *   - ai-docs/ markdown — via the tolerant parsers in plan-docs.mjs (cached
 *     by mtime, never throw).
 *
 * The staleness rule mirrors fia-viewer.mjs: a session stuck on 'running' is
 * `stale` when its newest event is older than STALE_MS and no recorded pid is
 * alive — a crash or Ctrl-C must not animate forever.
 */
import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { readPlanOverview, readPlanTasks, readPlanDoc, parseMdTables } from './plan-docs.mjs';
import { docsStatus as manifestDocsStatus } from './docs-manifest.mjs';
import { durSec } from '../modules/format.mjs';

export { activeFdaLock } from './fda-lock.mjs';
export { readPlanDoc as readDoc };
export { docsStatus } from './docs-manifest.mjs';

export const STALE_MS = 10 * 60_000;
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;
// A pragma name cannot be a bound parameter, so the table name is interpolated —
// it is always a literal here, and this keeps it that way.
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Read-only handle, or null while the db does not exist yet. */
export function openDb(dbPath) {
  if (!existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 2000');
  return db;
}

/**
 * SQLite's own change watermark: moves when ANOTHER connection commits.
 * Only comparable across calls on the SAME long-lived connection — which is
 * exactly how the TUI holds its handle.
 */
export function dataVersion(db) {
  return db.pragma('data_version', { simple: true });
}

/**
 * Does this table carry that column? The trace schema is create-only, so a
 * column added later (sessions.outcome) exists ONLY in databases a new Tracer
 * has opened. A read-only reader must probe instead of naming it in a SELECT:
 * naming a missing column throws, and every reader here answers a throw with an
 * empty shape — which would blank the whole dashboard on an older project.
 */
export function hasColumn(db, table, column) {
  if (!SAFE_IDENT.test(String(table || ''))) return false;
  try {
    return db.pragma(`table_info(${table})`).some((c) => c.name === column);
  } catch {
    return false; /* schema-less db (see listSessions) */
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lastActivity(db, fdaId, startedAt) {
  try {
    const row = db.prepare('SELECT MAX(COALESCE(ended_at, started_at)) AS t FROM events WHERE fda_id=?').get(fdaId);
    return row?.t || startedAt || null;
  } catch {
    return startedAt || null;
  }
}

/** Sessions still marked 'running', each tagged `stale` when orphaned. */
export function runningSessions(db, now = Date.now()) {
  try {
    return db
      .prepare("SELECT fda_id, started_at FROM sessions WHERE status='running'")
      .all()
      .map((s) => {
        const last = lastActivity(db, s.fda_id, s.started_at);
        const ageMs = last ? Math.max(0, now - Date.parse(last)) : Number.POSITIVE_INFINITY;
        let alive = false;
        if (!(ageMs < STALE_MS)) {
          try {
            const proc = db
              .prepare('SELECT pid FROM processes WHERE fda_id=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1')
              .get(s.fda_id);
            alive = pidAlive(proc?.pid);
          } catch {
            /* no processes table — stay stale */
          }
        }
        return { fda_id: s.fda_id, last_activity: last, stale: !(ageMs < STALE_MS) && !alive };
      });
  } catch {
    return [];
  }
}

/** Newest-first session list, running ones tagged stale/last_activity. */
export function listSessions(db, limit = 80) {
  let rows;
  // `outcome`/`outcome_reason` only exist once a new Tracer has opened the db
  // (create-only schema + guarded ALTER). Probe, never assume: naming a missing
  // column would throw into the catch below and render "no runs yet".
  const outcomeCols = hasColumn(db, 'sessions', 'outcome') ? ', outcome, outcome_reason' : '';
  try {
    rows = db
      .prepare(
        `SELECT fda_id, fda_name, status, engineer, substr(request,1,120) AS request,
                started_at, ended_at, total_tokens, total_cost${outcomeCols}
         FROM sessions ORDER BY started_at DESC LIMIT ?`,
      )
      .all(limit);
  } catch {
    // A schema-less db is a real race: the Tracer creates the file BEFORE
    // db.exec(SCHEMA) runs, and the dashboard may catch that window when the
    // first FDA of a project starts. Render "no runs yet", never crash.
    return [];
  }
  const live = new Map(runningSessions(db).map((s) => [s.fda_id, s]));
  return rows.map((s) => {
    const tag = s.status === 'running' ? live.get(s.fda_id) : null;
    return tag ? { ...s, stale: tag.stale, last_activity: tag.last_activity } : s;
  });
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Full drill-down of one session — same shape family as /api/session. */
export function sessionDetail(db, fdaId) {
  if (!SAFE_ID.test(String(fdaId || ''))) return null;
  let session;
  try {
    session = db.prepare('SELECT * FROM sessions WHERE fda_id=?').get(fdaId);
  } catch {
    return null; /* schema-less db (see listSessions) */
  }
  if (!session) return null;
  if (session.status === 'running') {
    const live = runningSessions(db).find((s) => s.fda_id === fdaId);
    if (live) {
      session.stale = live.stale;
      session.last_activity = live.last_activity;
    }
  }
  const phases = db
    .prepare(
      `SELECT phase_id, seq, name, kind, owner, description, status, attempt, error, started_at, ended_at
       FROM phases WHERE fda_id=? ORDER BY seq`,
    )
    .all(fdaId);
  const gates = db
    .prepare('SELECT phase_id, attempt, gate, passed FROM gate_results WHERE fda_id=? ORDER BY id')
    .all(fdaId);
  const agentSessions = db
    .prepare('SELECT agent, coding_agent, model, context_tokens, context_window FROM agent_sessions WHERE fda_id=?')
    .all(fdaId);
  const phaseTokens = db
    .prepare('SELECT phase_id, SUM(tokens) AS tokens FROM events WHERE fda_id=? AND tokens > 0 GROUP BY phase_id')
    .all(fdaId);
  // Engine trouble of this run (fallbacks, mid-run relays, deaths, handovers)
  // so dashboards can show WHICH engine actually did the work and why.
  const engineEvents = db
    .prepare(
      `SELECT started_at, type, name, payload_json FROM events
       WHERE fda_id=? AND type IN ('engine_fallback','engine_relay','engine_error','engine_continuation')
       ORDER BY rowid`,
    )
    .all(fdaId)
    .map((e) => ({ started_at: e.started_at, type: e.type, name: e.name, payload: safeParse(e.payload_json) }));
  return { session, phases, gates, agentSessions, phaseTokens, engineEvents };
}

/** Incremental event tail — `after` is the rowid cursor from the last call. */
export function tailEvents(db, fdaId, after = 0, limit = 200) {
  if (!SAFE_ID.test(String(fdaId || ''))) return { events: [], last: after };
  let events;
  try {
    events = db
      .prepare(
        `SELECT rowid AS rid, type, name, tokens, started_at, ended_at
         FROM events WHERE fda_id=? AND rowid > ? ORDER BY rowid LIMIT ?`,
      )
      .all(fdaId, after, limit);
  } catch {
    return { events: [], last: after }; /* schema-less db (see listSessions) */
  }
  return { events, last: events.length ? events.at(-1).rid : after };
}

/**
 * Lifetime development totals across ALL sessions: wall-clock seconds, tokens
 * and cost. A running session counts up to its LAST ACTIVITY (not `now`), so
 * an orphaned run does not inflate the clock forever.
 */
export function devTotals(db, now = Date.now()) {
  let rows;
  try {
    rows = db.prepare('SELECT fda_id, status, started_at, ended_at, total_tokens, total_cost FROM sessions').all();
  } catch {
    return { sessions: 0, seconds: 0, tokens: 0, cost: 0 }; /* schema-less db (see listSessions) */
  }
  let seconds = 0;
  let tokens = 0;
  let cost = 0;
  for (const s of rows) {
    const end = s.ended_at || (s.status === 'running' ? lastActivity(db, s.fda_id, s.started_at) : null);
    const t0 = Date.parse(s.started_at || '');
    const t1 = Date.parse(end || '');
    if (!Number.isNaN(t0) && !Number.isNaN(t1)) seconds += Math.max(0, Math.min(t1, now) - t0) / 1000;
    tokens += s.total_tokens || 0;
    cost += s.total_cost || 0;
  }
  return { sessions: rows.length, seconds, tokens, cost };
}

/** The phase to point at: the running one, else the last one that started. */
export function currentPhase(phases) {
  if (!Array.isArray(phases) || !phases.length) return null;
  return phases.find((p) => p.status === 'running') || phases.filter((p) => p.started_at).at(-1) || phases[0];
}

/** Planning side, one call: overview (counts, milestones, specs…) + task list. */
export function loadPlan(aiDocsDir, projectRoot = process.cwd()) {
  return { overview: readPlanOverview(aiDocsDir, projectRoot), tasks: readPlanTasks(aiDocsDir) };
}

/**
 * Roster for display — defaults merged into each agent (viewer semantics),
 * plus the defaults themselves and per-agent `explicit` flags so the UI can
 * tell "chosen for this agent" from "inherited from the default LLM".
 */
export function loadRoster(configPath) {
  let cfg = {};
  try {
    cfg = parseYaml(readFileSync(configPath, 'utf8')) || {};
  } catch {
    return { available: false, defaults: null, agents: [] };
  }
  const defaults = cfg.defaults || {};
  const agents = (cfg.agents || []).map((a) => ({
    name: a.name,
    color: a.color || null,
    coding_agent: a.coding_agent ?? defaults.coding_agent ?? 'pi',
    model: a.model ?? defaults.model ?? '',
    thinking: a.thinking ?? defaults.thinking ?? '',
    effort: a.effort ?? defaults.effort ?? '',
    purpose: a.purpose || '',
    fallbacks: Array.isArray(a.fallbacks) ? a.fallbacks : [],
    explicit: { coding_agent: a.coding_agent != null, model: a.model != null },
  }));
  return {
    available: agents.length > 0,
    defaults: {
      coding_agent: defaults.coding_agent ?? 'pi',
      model: defaults.model ?? '',
      effort: defaults.effort ?? '',
      thinking: defaults.thinking ?? '',
    },
    agents,
  };
}

/**
 * Lifetime token/cost ledger per LLM, from the `agent_end` events — each one
 * stamped with (coding_agent, model) AT SPEND TIME by the runner, so a roster
 * edit mid-project never re-attributes history: the old model keeps its
 * totals, the new model starts accumulating from zero. Events recorded before
 * the stamp existed resolve through agent_sessions (the engine each agent
 * actually used in that run); whatever still cannot be resolved is reported
 * as `unattributed`, never silently dropped.
 */
export function modelUsage(db) {
  let events;
  try {
    // agent_end = the phase closed; agent_spend = a FAILED attempt's spend,
    // stamped on the error path so the ledger never loses it. Never both for
    // the same attempt, so summing the two types cannot double-count.
    events = db
      .prepare(
        `SELECT fda_id, name AS agent, tokens, payload_json, COALESCE(ended_at, started_at) AS at
         FROM events WHERE type IN ('agent_end','agent_spend') AND tokens > 0`,
      )
      .all();
  } catch {
    return { rows: [], unattributed: 0 };
  }
  let legacy = null; // built lazily: (fda_id, agent) → engine/model of that run
  const legacyFor = (fdaId, agentName) => {
    if (!legacy) {
      legacy = new Map();
      try {
        for (const r of db.prepare('SELECT fda_id, agent, coding_agent, model FROM agent_sessions').all()) {
          legacy.set(`${r.fda_id} ${r.agent}`, r);
        }
      } catch {
        /* no agent_sessions table — legacy stays empty */
      }
    }
    return legacy.get(`${fdaId} ${agentName}`) || null;
  };
  const byKey = new Map();
  let unattributed = 0;
  for (const e of events) {
    let payload = {};
    try {
      payload = JSON.parse(e.payload_json || '{}');
    } catch {
      /* corrupt payload — treated as unstamped */
    }
    let engine = payload.coding_agent;
    let model = payload.model;
    if (!model) {
      const hit = legacyFor(e.fda_id, e.agent);
      if (hit?.model) {
        engine = hit.coding_agent;
        model = hit.model;
      }
    }
    if (!model) {
      unattributed += e.tokens || 0;
      continue;
    }
    const key = `${engine || '?'} ${model}`;
    let row = byKey.get(key);
    if (!row) {
      byKey.set(
        key,
        (row = {
          coding_agent: engine || '?',
          model,
          tokens: 0,
          cost: 0,
          runs: new Set(),
          first_used: null,
          last_used: null,
        }),
      );
    }
    row.tokens += e.tokens || 0;
    row.cost += payload.cost || 0;
    row.runs.add(e.fda_id);
    if (e.at) {
      if (!row.first_used || e.at < row.first_used) row.first_used = e.at;
      if (!row.last_used || e.at > row.last_used) row.last_used = e.at;
    }
  }
  const rows = [...byKey.values()].map((r) => ({ ...r, runs: r.runs.size })).sort((a, b) => b.tokens - a.tokens);
  return { rows, unattributed };
}

/**
 * Traceability of one spec (ai-docs-relative file): the `| Requirement |
 * Scenario | Test |` table, each row flagged `covered` when the Test cell
 * names something. Uncovered rows are the whole point of the spec layer —
 * the TUI paints them red.
 */
export function specTraceability(aiDocsDir, relFile) {
  const empty = { available: false, rows: [], covered: 0, total: 0 };
  const doc = readPlanDoc(aiDocsDir, relFile);
  if (!doc?.exists) return empty;
  const table = parseMdTables(doc.text).find((t) => t.keys.includes('requirement'));
  if (!table) return empty;
  const rows = table.rows.map((r) => {
    const test = String(r.test ?? r._cells?.[2] ?? '')
      .replace(/`/g, '')
      .trim();
    const covered = Boolean(test) && !/^[—–-]+$/.test(test);
    return {
      requirement: String(r.requirement ?? r._cells?.[0] ?? '').trim(),
      scenario: String(r.scenario ?? r.scenarios ?? r._cells?.[1] ?? '').trim(),
      test,
      covered,
    };
  });
  return { available: true, rows, covered: rows.filter((r) => r.covered).length, total: rows.length };
}

/** Default locations, shared with the other imp/scripts readers. */
export function defaultPaths(env = process.env) {
  return {
    dbPath: env.FIA_DB || join('imp', 'data', 'fia.db'),
    configPath: env.FIA_CONFIG || join('imp', 'fia.config.yaml'),
    aiDocsDir: env.FIA_AI_DOCS || 'ai-docs',
    telemetryDir: env.FIA_TELEMETRY_DIR || join('imp', 'data', 'telemetry'),
  };
}

function telemetryPaths(root, telemetryDir) {
  const base = join(root, telemetryDir);
  return { base, ndjson: join(base, 'commands.ndjson'), live: join(base, 'live.json') };
}

function readJsonFile(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Aggregate interactive Pi command telemetry from NDJSON + live snapshot. */
export function readCommandTelemetry(root, telemetryDir = join('imp', 'data', 'telemetry')) {
  const empty = { available: false, live: null, history: [], totals: null };
  const { ndjson, live: livePath } = telemetryPaths(root, telemetryDir);
  const live = readJsonFile(livePath);
  const history = [];
  const open = new Map();

  if (!existsSync(ndjson) && !live) return { ...empty, available: Boolean(live), live };

  if (existsSync(ndjson)) {
    let text;
    try {
      text = readFileSync(ndjson, 'utf8');
    } catch {
      text = '';
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue; /* tolerate corrupt lines */
      }
      if (row.type === 'command_start') {
        open.set(row.command_id, {
          id: row.command_id,
          command: row.command,
          args: row.args || '',
          session_id: row.session_id || '',
          started_at: row.started_at,
          ended_at: null,
          settled_at: null,
          status: 'running',
          tokens_in: 0,
          tokens_out: 0,
          cache_read: 0,
          cache_write: 0,
          cost: 0,
          docs_written: [],
          phases: [],
          current_activity: null,
        });
      } else if (row.type === 'usage' && open.has(row.command_id)) {
        const rec = open.get(row.command_id);
        rec.tokens_in += row.tokens_in || 0;
        rec.tokens_out += row.tokens_out || 0;
        rec.cache_read += row.cache_read || 0;
        rec.cache_write += row.cache_write || 0;
        rec.cost += row.cost || 0;
      } else if (row.type === 'phase_start' && open.has(row.command_id)) {
        const rec = open.get(row.command_id);
        rec.phases.push({
          id: row.phase_id,
          label: row.label,
          started_at: row.started_at,
          ended_at: null,
          tokens_in: 0,
          tokens_out: 0,
          cost: 0,
        });
        rec.current_activity = row.label;
      } else if (row.type === 'phase_end' && open.has(row.command_id)) {
        const rec = open.get(row.command_id);
        const ph = rec.phases.find((p) => p.id === row.phase_id);
        if (ph) {
          ph.ended_at = row.ended_at;
          ph.tokens_in += row.tokens_in || 0;
          ph.tokens_out += row.tokens_out || 0;
          ph.cost += row.cost || 0;
        }
      } else if (row.type === 'doc_written' && open.has(row.command_id)) {
        const rec = open.get(row.command_id);
        if (!rec.docs_written.includes(row.path)) rec.docs_written.push(row.path);
      } else if (row.type === 'settled' && open.has(row.command_id)) {
        open.get(row.command_id).settled_at = row.settled_at;
      } else if (row.type === 'command_end') {
        const rec = open.get(row.command_id) || {
          id: row.command_id,
          command: row.command,
          args: '',
          session_id: '',
          started_at: row.ended_at,
        };
        history.push({
          id: rec.id,
          command: row.command || rec.command,
          args: rec.args || '',
          session_id: rec.session_id || '',
          started_at: rec.started_at,
          ended_at: row.ended_at,
          settled_at: row.settled_at ?? rec.settled_at,
          status: 'ended',
          tokens_in: row.tokens_in ?? rec.tokens_in ?? 0,
          tokens_out: row.tokens_out ?? rec.tokens_out ?? 0,
          cache_read: row.cache_read ?? rec.cache_read ?? 0,
          cache_write: row.cache_write ?? rec.cache_write ?? 0,
          cost: row.cost ?? rec.cost ?? 0,
          docs_written: row.docs_written || rec.docs_written || [],
          phases: row.phases || rec.phases || [],
          current_activity: null,
        });
        open.delete(row.command_id);
      }
    }
  }

  // Orphaned starts still open — prefer live.json when ids match.
  for (const rec of open.values()) {
    if (live?.id === rec.id) continue;
    history.push({ ...rec, status: 'running' });
  }

  history.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));

  const all = [...history];
  if (live?.id) {
    const idx = all.findIndex((r) => r.id === live.id);
    const merged = {
      ...(idx >= 0 ? all[idx] : {}),
      ...live,
      status: live.status || 'running',
    };
    if (idx >= 0) all[idx] = merged;
    else all.unshift(merged);
  }

  const finished = all.filter((r) => r.ended_at);
  const totals = finished.length
    ? {
        commands: finished.length,
        tokens_in: finished.reduce((n, r) => n + (r.tokens_in || 0), 0),
        tokens_out: finished.reduce((n, r) => n + (r.tokens_out || 0), 0),
        cost: finished.reduce((n, r) => n + (r.cost || 0), 0),
        seconds: finished.reduce((n, r) => n + durSec(r.started_at, r.ended_at), 0),
      }
    : null;

  return {
    available: Boolean(live) || history.length > 0 || existsSync(ndjson),
    live: live || all.find((r) => r.status === 'running') || null,
    history: all.filter((r) => r.status !== 'running' || r.id !== live?.id),
    totals,
  };
}

/** Project documentation checklist (re-export wrapper with root). */
export function loadDocsStatus(root) {
  return manifestDocsStatus(root);
}
