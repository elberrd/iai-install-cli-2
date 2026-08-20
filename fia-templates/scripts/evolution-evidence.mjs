#!/usr/bin/env node
/**
 * Bounded, read-only evidence collector for `/evolve`.
 *
 * Reactive review:
 *   node imp/scripts/evolution-evidence.mjs --run <fda_id> [--dir <root>]
 *
 * Proactive review:
 *   node imp/scripts/evolution-evidence.mjs --since <Nd|YYYY-MM-DD> [--dir <root>]
 *
 * stdout is always one JSON document. Diagnostics go to stderr and failures
 * exit non-zero, which keeps the prompt layer deterministic and scriptable.
 */
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, opendirSync, openSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isMainModule } from '../modules/utils.mjs';
import { parse as parseYaml } from 'yaml';
import { activeFdaLock } from './fda-lock.mjs';
import { piSessionsDirFor } from './pi-sessions.mjs';

const SCHEMA_VERSION = 1;
const SAFE_FDA_ID = /^[A-Za-z0-9_-]+$/;
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TEXT = 20_000;
const MAX_DB_CELL_CHARS = MAX_TEXT;
const MAX_UNINDEXED_ROWS = 10_000;
const MAX_EVENTS = 5_000;
const MAX_ARRAY_ITEMS = 5_000;
const MAX_GAPS = MAX_ARRAY_ITEMS;
const MAX_OBJECT_KEYS = 150;
const MAX_SANITIZE_GAPS = 100;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_PATH_MARKER_BYTES = 4096;
const MAX_PI_BYTES = 16 * 1024 * 1024;
const MAX_PI_EVENTS = 5_000;
const MAX_TELEMETRY_EVENTS = 5_000;
const MAX_PI_SESSIONS = 60;
const MAX_FILES = 120;
const MAX_DISCOVERY_ENTRIES = 512;
const MAX_DISCOVERY_DIRS = 128;
const MAX_PI_DISCOVERY_ENTRIES = 512;
const MAX_RUNS = 200;
const MAX_EXAMPLES = 20;
const MAX_PI_MESSAGES = 100;
const MAX_GIT_COMMITS = 30;
const SANITIZE_STATE = Symbol('evolutionSanitizeState');
const GAP_STATE = Symbol('evolutionGapState');
const TRACE_COLUMNS = Object.freeze({
  sessions: [
    'fda_id',
    'fda_name',
    'request',
    'status',
    'engineer',
    'started_at',
    'ended_at',
    'total_tokens',
    'total_cost',
    'outcome',
    'outcome_reason',
  ],
  phases: [
    'phase_id',
    'fda_id',
    'seq',
    'name',
    'kind',
    'owner',
    'description',
    'status',
    'attempt',
    'error',
    'started_at',
    'ended_at',
  ],
  events: [
    'event_id',
    'fda_id',
    'phase_id',
    'parent_id',
    'type',
    'name',
    'payload_json',
    'tokens',
    'started_at',
    'ended_at',
    'ts',
  ],
  envelopes: [
    'envelope_id',
    'fda_id',
    'phase_id',
    'agent',
    'output_type',
    'payload_json',
    'valid',
    'attempt',
    'created_at',
  ],
  gate_results: [
    'id',
    'fda_id',
    'phase_id',
    'attempt',
    'gate',
    'passed',
    'violations_json',
    'checks_json',
    'created_at',
  ],
  agent_sessions: [
    'fda_id',
    'agent',
    'coding_agent',
    'model',
    'session_id',
    'context_tokens',
    'context_window',
    'created_at',
    'last_used_at',
  ],
});

function asDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid date: ${value}`);
  return date;
}

/** Parse an inclusive review window without locale-dependent dates. */
export function parseSince(value, now = new Date()) {
  const raw = String(value || '').trim();
  const current = asDate(now);
  const duration = /^(\d{1,4})d$/i.exec(raw);
  let since;
  let kind;
  if (duration) {
    const days = Number(duration[1]);
    if (days < 1 || days > 3650) throw new Error('--since duration must be between 1d and 3650d');
    since = new Date(current.getTime() - days * DAY_MS);
    kind = 'duration';
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    since = new Date(`${raw}T00:00:00.000Z`);
    if (Number.isNaN(since.getTime()) || since.toISOString().slice(0, 10) !== raw) {
      throw new Error('--since must be a real calendar date (YYYY-MM-DD)');
    }
    kind = 'date';
  } else {
    throw new Error('--since must be Nd or YYYY-MM-DD');
  }
  if (since.getTime() > current.getTime()) throw new Error('--since cannot be in the future');
  return { raw, kind, since: since.toISOString(), until: current.toISOString() };
}

function normalizedKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-.\s]+/g, '_')
    .toLowerCase();
}

function secretUrlKey(key) {
  const normalized = normalizedKey(key);
  return /(^|_)(url|uri)$/.test(normalized);
}

function redactUrl(value, { alwaysMark = false } = {}) {
  const raw = String(value || '');
  if (/\/\[REDACTED\](?:[),.;!?\]}]*)$/.test(raw)) return raw;
  const trailingMatch = /[),.;!?\]}]+$/.exec(raw);
  const trailing = trailingMatch?.[0] || '';
  const candidate = trailing ? raw.slice(0, -trailing.length) : raw;
  const match = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#\s]*)(.*)$/i.exec(candidate);
  if (!match) return alwaysMark ? '[REDACTED]' : raw;
  const [, scheme, authority, tail] = match;
  const at = authority.lastIndexOf('@');
  const safeAuthority = at >= 0 ? authority.slice(at + 1) : authority;
  if (!safeAuthority) return `${scheme}/[REDACTED]${trailing}`;
  const hasSensitiveTail = tail !== '' && tail !== '/';
  const mark = alwaysMark || at >= 0 || hasSensitiveTail;
  return `${scheme}${safeAuthority}${mark ? '/[REDACTED]' : ''}${trailing}`;
}

function redactAssignment(whole, key, separator, quote, candidate) {
  let replacement;
  if (secretUrlKey(key)) replacement = redactUrl(candidate, { alwaysMark: true });
  else if (secretKey(key) || pluralTokenKey(key)) replacement = '[REDACTED]';
  else return whole;
  return `${key}${separator}${quote}${replacement}${quote}`;
}

/** Best-effort secret redaction used before any persisted trace reaches stdout. */
export function redactText(value) {
  let text = String(value ?? '');
  text = text.replace(/\b((?:Set-Cookie|Cookie)\s*:\s*)[^\r\n]*/gi, '$1[REDACTED]');
  text = text.replace(/\b(Authorization\s*[:=]\s*)[^\r\n]*/gi, '$1[REDACTED]');
  text = text.replace(
    /\b([A-Za-z][A-Za-z0-9_-]*)(["']?\s*[:=]\s*)(")((?:\\.|[^"\\\r\n])*)"/g,
    (whole, key, separator, quote, candidate) => redactAssignment(whole, key, separator, quote, candidate),
  );
  text = text.replace(
    /\b([A-Za-z][A-Za-z0-9_-]*)(["']?\s*[:=]\s*)(')((?:\\.|[^'\\\r\n])*)'/g,
    (whole, key, separator, quote, candidate) => redactAssignment(whole, key, separator, quote, candidate),
  );
  text = text.replace(/\b([A-Za-z][A-Za-z0-9_-]*)(["']?\s*[:=]\s*)([^\s,"'}]+)/g, (whole, key, separator, candidate) =>
    redactAssignment(whole, key, separator, '', candidate),
  );
  text = text.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]');
  text = text.replace(/\b(Authorization\s*[:=]\s*(?:Basic|Token)\s+)[^\s,]+/gi, '$1[REDACTED]');
  text = text.replace(/(--(?:api-key|token|password|secret)(?:\s+|=))[^\s]+/gi, '$1[REDACTED]');
  text = text.replace(
    /\b(sk-(?:proj-)?|sk_|pk_live_|rk_live_|whsec_|xox[baprs]-|gh[pousr]_|github_pat_|npm_)[A-Za-z0-9_-]{8,}/g,
    '[REDACTED]',
  );
  text = text.replace(/\b(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/g, '[REDACTED]');
  text = text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]');
  text = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi, (url) => redactUrl(url));
  text = text.replace(
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    '[REDACTED_PRIVATE_KEY]',
  );
  return text;
}

function truncate(value, limit = MAX_TEXT) {
  const text = redactText(value);
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

function secretKey(key) {
  const normalized = normalizedKey(key);
  return /(^|_)(api_?key|private_?key|token|passwords?|passwds?|secrets?|credentials?|authorization|cookies?)($|_)/i.test(
    normalized,
  );
}

function pluralTokenKey(key) {
  return /(^|_)tokens($|_)/i.test(normalizedKey(key));
}

function sanitizePath(parent, key) {
  if (typeof key === 'number') return `${parent}[${key}]`;
  const segment = String(key);
  return /^[A-Za-z0-9_-]{1,48}$/.test(segment) ? `${parent}.${segment}` : `${parent}.*`;
}

function sanitizeContext(gaps) {
  if (!Array.isArray(gaps)) return null;
  if (!gaps[SANITIZE_STATE]) {
    Object.defineProperty(gaps, SANITIZE_STATE, {
      value: { seen: new Set(), notices: 0, truncations: 0, overflowNoted: false },
    });
  }
  return { gaps, state: gaps[SANITIZE_STATE] };
}

function recordSanitizeGap(context, path, detail) {
  if (!context?.gaps) return;
  const state = context.state || sanitizeContext(context.gaps)?.state;
  if (!state) return;
  state.truncations += 1;
  const message = `${path} sanitized with truncation: ${detail}`;
  if (state.seen.has(message)) return;
  if (state.notices >= MAX_SANITIZE_GAPS) {
    if (!state.overflowNoted) {
      state.overflowNoted = true;
      addGap(context.gaps, `additional sanitization gaps omitted after ${MAX_SANITIZE_GAPS} notices`);
    }
    return;
  }
  state.seen.add(message);
  state.notices += 1;
  addGap(context.gaps, message);
}

function sanitizeValue(value, depth = 0, context = null, path = 'value') {
  if (value === undefined) return null;
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > MAX_TEXT) {
      recordSanitizeGap(context, path, `string length ${value.length} capped at ${MAX_TEXT}`);
    }
    return truncate(value);
  }
  if (depth >= 7) {
    recordSanitizeGap(context, path, 'depth capped at 7');
    return '[DEPTH_LIMIT]';
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) {
      recordSanitizeGap(context, path, `array length ${value.length} capped at ${MAX_ARRAY_ITEMS}`);
    }
    const output = [];
    for (let index = 0; index < Math.min(value.length, MAX_ARRAY_ITEMS); index += 1) {
      output.push(sanitizeValue(value[index], depth + 1, context, sanitizePath(path, index)));
    }
    return output;
  }
  if (typeof value !== 'object') return truncate(String(value));
  const output = {};
  let keys = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (keys >= MAX_OBJECT_KEYS) {
      recordSanitizeGap(context, path, `object keys capped at ${MAX_OBJECT_KEYS}`);
      break;
    }
    keys += 1;
    const item = value[key];
    const itemPath = sanitizePath(path, key);
    output[key] = secretUrlKey(key)
      ? redactUrl(item, { alwaysMark: true })
      : secretKey(key)
        ? '[REDACTED]'
        : pluralTokenKey(key) && typeof item === 'string'
          ? '[REDACTED]'
          : sanitizeValue(item, depth + 1, context, itemPath);
  }
  return output;
}

function addGap(gaps, message) {
  if (!gaps[GAP_STATE]) {
    Object.defineProperty(gaps, GAP_STATE, {
      value: { seen: new Set(gaps), omitted: 0, marker: null },
    });
  }
  const state = gaps[GAP_STATE];
  if (state.seen.has(message)) return;
  if (gaps.length < MAX_GAPS - 1) {
    gaps.push(message);
    state.seen.add(message);
    return;
  }
  state.omitted += 1;
  const marker = `additional evidence gaps omitted by the ${MAX_GAPS}-item cap: ${state.omitted}`;
  if (state.marker == null) {
    gaps.push(marker);
  } else {
    state.seen.delete(state.marker);
    gaps[gaps.length - 1] = marker;
  }
  state.marker = marker;
  state.seen.add(marker);
}

function finalizeEvidence(raw, gaps) {
  const context = sanitizeContext(gaps);
  const output = sanitizeValue(raw, 0, context, 'evidence');
  // `gaps` appears before most evidence fields. Refresh it because sanitizing a
  // later payload may itself add a bounded, contextual gap.
  output.gaps = sanitizeValue(gaps, 0, context, 'evidence.gaps');
  return output;
}

function resolveFrom(root, value) {
  return isAbsolute(value) ? resolve(value) : resolve(root, value);
}

function insideRoot(root, path) {
  const rel = relative(resolve(root), resolve(path));
  if (!(rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)))) return false;
  try {
    let existing = resolve(path);
    while (true) {
      try {
        lstatSync(existing);
        break;
      } catch (error) {
        if (error?.code !== 'ENOENT') return false;
        const parent = dirname(existing);
        if (parent === existing) return false;
        existing = parent;
      }
    }
    const realRel = relative(realpathSync(root), realpathSync(existing));
    return realRel === '' || (!realRel.startsWith(`..${sep}`) && realRel !== '..' && !isAbsolute(realRel));
  } catch {
    return false;
  }
}

function requireLocalStore(root, path, label) {
  if (!insideRoot(root, path)) throw new Error(`${label} path escapes --dir: ${path}`);
}

function displayPath(root, path) {
  const rel = relative(root, path);
  if (rel === '') return '.';
  if (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)) return rel;
  const home = homedir();
  return path === home || path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}

function dotEnvPath(path) {
  const includesDotEnv = (candidate) =>
    resolve(candidate)
      .split(sep)
      .some((part) => part.toLowerCase().startsWith('.env'));
  if (includesDotEnv(path)) return true;
  try {
    return includesDotEnv(realpathSync(path));
  } catch {
    return false;
  }
}

function refuseDotEnv(path, root, gaps, label = 'artifact') {
  if (!dotEnvPath(path)) return false;
  addGap(gaps, `refused .env* ${label}: ${displayPath(root, path)}`);
  return true;
}

function readConfig(configPath, gaps) {
  try {
    lstatSync(configPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      addGap(gaps, `config unavailable: ${configPath}`);
      return {};
    }
    throw new Error(`config exists but is unreadable or invalid: ${error.message}`);
  }
  try {
    if (dotEnvPath(configPath)) throw new Error('.env* paths are forbidden');
    const stat = lstatSync(realpathSync(configPath));
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES)
      throw new Error(`expected a file of at most ${MAX_CONFIG_BYTES} bytes`);
    const config = parseYaml(readFileSlice(configPath, 0, stat.size)) || {};
    if (typeof config !== 'object' || Array.isArray(config)) throw new Error('expected a YAML mapping');
    return config;
  } catch (error) {
    throw new Error(`config exists but is unreadable or invalid: ${error.message}`);
  }
}

/** Resolve the same configurable stores used by the FIA runtime. */
export function resolveEvolutionPaths(rootArg = process.cwd(), env = process.env, gaps = []) {
  const root = resolve(rootArg);
  const configPath = resolveFrom(root, env.FIA_CONFIG || join('imp', 'fia.config.yaml'));
  requireLocalStore(root, configPath, 'config');
  const config = readConfig(configPath, gaps);
  const dataDir = resolveFrom(root, config.defaults?.data_dir || join('imp', 'data'));
  const dbPath = resolveFrom(
    root,
    env.FIA_DB || config.observability?.db || join(config.defaults?.data_dir || 'imp/data', 'fia.db'),
  );
  const telemetryDir = resolveFrom(root, env.FIA_TELEMETRY_DIR || join('imp', 'data', 'telemetry'));
  const derivedPiDir = resolve(piSessionsDirFor(root));
  const piOverride = String(env.PI_SESSIONS_DIR || '').trim();
  const piDir = piOverride ? resolveFrom(root, piOverride) : derivedPiDir;
  for (const [label, path] of [
    ['data', dataDir],
    ['database', dbPath],
    ['telemetry', telemetryDir],
  ]) {
    requireLocalStore(root, path, label);
  }
  if (piOverride && piDir !== derivedPiDir) requireLocalStore(root, piDir, 'Pi sessions');
  for (const [label, path] of [
    ['config', configPath],
    ['data', dataDir],
    ['database', dbPath],
    ['telemetry', telemetryDir],
    ['Pi sessions', piDir],
  ]) {
    if (dotEnvPath(path)) throw new Error(`${label} path targets forbidden .env* content: ${path}`);
  }
  return { root, config, configPath, dataDir, dbPath, telemetryDir, piDir };
}

function assertNoLiveRun(paths) {
  const lockPath = join(paths.dataDir, '.fda.lock');
  let lockStat = null;
  try {
    lockStat = lstatSync(lockPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(`FIA lock exists but is unreadable or invalid: ${lockPath}`);
  }
  if (lockStat) {
    let lock;
    try {
      if (!lockStat.isFile() || lockStat.isSymbolicLink() || lockStat.size < 2 || lockStat.size > 64 * 1024) {
        throw new Error('unsafe lock');
      }
      lock = JSON.parse(readFileSlice(lockPath, 0, lockStat.size));
      if (!lock || !Number.isInteger(lock.pid) || lock.pid <= 0) throw new Error('invalid lock payload');
    } catch {
      throw new Error(`FIA lock exists but is unreadable or invalid: ${lockPath}`);
    }
    if (lock.pid === process.pid) {
      throw new Error(
        `FIA run ${lock.fda_id || 'unknown'} is active (pid ${lock.pid}); /evolve is read-only until the run finishes`,
      );
    }
  }
  const dataArg = relative(paths.root, paths.dataDir) || '.';
  const lock = activeFdaLock(paths.root, dataArg);
  if (lock) {
    throw new Error(
      `FIA run ${lock.fda_id || 'unknown'} is active (pid ${lock.pid}); /evolve is read-only until the run finishes`,
    );
  }
}

function openReadOnlyDb(path, gaps) {
  if (!existsSync(path)) {
    addGap(gaps, `trace database unavailable: ${path}`);
    return null;
  }
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 2000');
    return db;
  } catch (error) {
    addGap(gaps, `trace database unreadable: ${error.message}`);
    return null;
  }
}

function tableExists(db, name) {
  if (!db || !SAFE_IDENT.test(name)) return false;
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

function sqlIdentifier(name) {
  if (!SAFE_IDENT.test(name)) throw new Error(`unsafe SQL identifier: ${name}`);
  return `"${name}"`;
}

function boundedProjection(db, table) {
  const known = TRACE_COLUMNS[table];
  if (!known) throw new Error(`unsupported trace table: ${table}`);
  const columns = new Set(
    db
      .prepare('SELECT name FROM pragma_table_info(?)')
      .all(table)
      .map((row) => String(row.name)),
  );
  const selected = known.filter((column) => columns.has(column));
  if (!selected.length) throw new Error(`${table} has no supported columns`);
  const markers = [];
  const projection = [];
  for (const [index, column] of selected.entries()) {
    const identifier = sqlIdentifier(column);
    const marker = `__fia_bounded_${index}`;
    markers.push({ marker, column });
    projection.push(
      `CASE
         WHEN typeof(${identifier})='blob' THEN printf('[BLOB %d bytes]', length(${identifier}))
         WHEN typeof(${identifier})='text' AND length(${identifier})>${MAX_DB_CELL_CHARS}
           THEN substr(${identifier}, 1, ${MAX_DB_CELL_CHARS - 1}) || '…'
         ELSE ${identifier}
       END AS ${identifier}`,
      `CASE
         WHEN typeof(${identifier})='blob'
           OR (typeof(${identifier})='text' AND length(${identifier})>${MAX_DB_CELL_CHARS})
         THEN 1 ELSE 0
       END AS ${sqlIdentifier(marker)}`,
    );
  }
  return { sql: projection.join(',\n'), markers };
}

function scanOrSortProneQuery(db, table, tail, parameters) {
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM ${sqlIdentifier(table)} ${tail}`).all(...parameters);
  const tableScan = new RegExp(`\\bSCAN\\s+(?:TABLE\\s+)?["']?${table}["']?\\b`, 'i');
  return plan.some((row) => {
    const detail = String(row.detail || '');
    return tableScan.test(detail) || /USE TEMP B-TREE.*ORDER BY/i.test(detail);
  });
}

function tableRowidSpan(db, table) {
  try {
    const shadowed = db
      .prepare("SELECT name FROM pragma_table_info(?) WHERE lower(name) IN ('rowid','_rowid_','oid') LIMIT 1")
      .get(table);
    if (shadowed) return null;
    const minimum = db
      .prepare(`SELECT rowid AS boundary FROM ${sqlIdentifier(table)} ORDER BY rowid LIMIT 1`)
      .safeIntegers()
      .get()?.boundary;
    if (minimum == null) return 0n;
    const maximum = db
      .prepare(`SELECT rowid AS boundary FROM ${sqlIdentifier(table)} ORDER BY rowid DESC LIMIT 1`)
      .safeIntegers()
      .get()?.boundary;
    if (maximum == null || maximum < minimum) return null;
    return maximum - minimum + 1n;
  } catch {
    return null;
  }
}

function boundedTableRows(db, table, tail, parameters, gaps, label = table) {
  if (scanOrSortProneQuery(db, table, tail, parameters)) {
    const rowidSpan = tableRowidSpan(db, table);
    if (rowidSpan == null || rowidSpan > BigInt(MAX_UNINDEXED_ROWS)) {
      addGap(
        gaps,
        rowidSpan == null
          ? `${label} skipped: scan/sort-prone legacy ${table} table has no safe rowid-span bound`
          : `${label} skipped: scan/sort-prone legacy ${table} table rowid span ${rowidSpan} exceeds ${MAX_UNINDEXED_ROWS}`,
      );
      const skipped = [];
      Object.defineProperty(skipped, 'skipped', { value: true });
      return skipped;
    }
  }
  const projection = boundedProjection(db, table);
  const rows = db.prepare(`SELECT ${projection.sql} FROM ${sqlIdentifier(table)} ${tail}`).all(...parameters);
  const bounded = new Set();
  for (const row of rows) {
    for (const { marker, column } of projection.markers) {
      if (row[marker]) bounded.add(column);
      delete row[marker];
    }
  }
  if (bounded.size) {
    addGap(gaps, `${label} database cells were bounded to ${MAX_DB_CELL_CHARS} characters: ${[...bounded].join(', ')}`);
  }
  return rows;
}

function rowsForRun(db, table, fdaId, order = '', limit = MAX_EVENTS, gaps = []) {
  if (!tableExists(db, table)) return null;
  try {
    return boundedTableRows(db, table, `WHERE fda_id=?${order} LIMIT ?`, [fdaId, limit + 1], gaps);
  } catch {
    return null;
  }
}

function parseJson(value, label, gaps, status = null) {
  if (value == null || value === '') return null;
  try {
    const context = sanitizeContext(gaps);
    const before = context?.state.truncations || 0;
    const output = sanitizeValue(JSON.parse(value), 0, context, label);
    if (status) status.truncated = (context?.state.truncations || 0) > before;
    return output;
  } catch {
    addGap(gaps, `${label} contains invalid JSON`);
    return { invalid_json: true, raw: truncate(value, 1000) };
  }
}

function normalizeRows(rows, jsonFields, label, gaps) {
  return (rows || []).map((row, index) => {
    const output = sanitizeValue(row, 0, sanitizeContext(gaps), `${label}[${index}]`);
    for (const field of jsonFields) {
      if (Object.hasOwn(row, field)) {
        output[field.replace(/_json$/, '')] = parseJson(row[field], `${label}[${index}].${field}`, gaps);
        delete output[field];
      }
    }
    return output;
  });
}

function readFileSlice(path, start, length) {
  if (dotEnvPath(path)) throw new Error(`refused .env* content read: ${path}`);
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function boundedTailRange(text, maxLines) {
  let end = text.length;
  while (end > 0 && (text.charCodeAt(end - 1) === 10 || text.charCodeAt(end - 1) === 13)) end -= 1;
  if (end === 0) return { start: 0, end: 0, truncated: false };
  let lines = 1;
  for (let index = end - 1; index >= 0; index -= 1) {
    if (text.charCodeAt(index) !== 10) continue;
    if (lines >= maxLines) return { start: index + 1, end, truncated: true };
    lines += 1;
  }
  return { start: 0, end, truncated: false };
}

function visitBoundedTailLines(text, maxLines, visitor) {
  const range = boundedTailRange(text, maxLines);
  let sourceLines = 0;
  let cursor = range.start;
  while (cursor < range.end) {
    const next = text.indexOf('\n', cursor);
    const lineEnd = next < 0 || next > range.end ? range.end : next;
    let line = text.slice(cursor, lineEnd);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    sourceLines += 1;
    visitor(line, sourceLines);
    cursor = lineEnd + 1;
  }
  return { sourceLines, truncated: range.truncated };
}

function readTextFile(path, root, gaps, { limit = MAX_TEXT, allowOutside = false } = {}) {
  if (refuseDotEnv(path, root, gaps)) return null;
  if (!allowOutside && !insideRoot(root, path)) {
    addGap(gaps, `refused artifact outside project: ${path}`);
    return null;
  }
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      addGap(gaps, `refused non-regular artifact: ${path}`);
      return null;
    }
    const byteLimit = Math.min(MAX_SOURCE_BYTES, Math.max(4096, limit * 4));
    const content = readFileSlice(path, 0, Math.min(stat.size, byteLimit));
    return {
      path: displayPath(root, path),
      bytes: stat.size,
      truncated: stat.size > byteLimit || content.length > limit,
      content: truncate(content, limit),
    };
  } catch {
    return null;
  }
}

function metadataFile(path, root, gaps) {
  if (refuseDotEnv(path, root, gaps)) return null;
  if (!insideRoot(root, path)) {
    addGap(gaps, `refused artifact outside project: ${path}`);
    return null;
  }
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return { path: displayPath(root, path), bytes: stat.size, modified_at: stat.mtime.toISOString() };
  } catch {
    return null;
  }
}

function safeSessionDirectory(sessionDir, root, gaps) {
  try {
    const stat = lstatSync(sessionDir);
    if (stat.isDirectory() && !stat.isSymbolicLink() && insideRoot(root, sessionDir)) return true;
  } catch {
    return false;
  }
  addGap(gaps, `refused unsafe session directory: ${sessionDir}`);
  return false;
}

function discoveryBudget(maxEntries = MAX_DISCOVERY_ENTRIES, maxDirs = MAX_DISCOVERY_DIRS) {
  return { entries: 0, dirs: 0, maxEntries, maxDirs, truncated: false, error: null };
}

function boundedDirectoryEntries(dir, budget) {
  if (budget.dirs >= budget.maxDirs || budget.entries >= budget.maxEntries) {
    budget.truncated = true;
    return [];
  }
  let handle;
  try {
    handle = opendirSync(dir);
  } catch (error) {
    if (error?.code !== 'ENOENT' && !budget.error) budget.error = error;
    return [];
  }
  budget.dirs += 1;
  const entries = [];
  try {
    while (budget.entries < budget.maxEntries) {
      const entry = handle.readSync();
      if (!entry) return entries.sort((a, b) => a.name.localeCompare(b.name));
      budget.entries += 1;
      entries.push(entry);
    }
    budget.truncated = true;
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    try {
      handle.closeSync();
    } catch {
      /* already closed or vanished after bounded enumeration */
    }
  }
}

function reportDiscoveryGap(gaps, label, budget) {
  if (budget.error) addGap(gaps, `${label} discovery unreadable: ${budget.error.message}`);
  if (budget.truncated) {
    addGap(gaps, `${label} discovery truncated at ${budget.maxEntries} entries or ${budget.maxDirs} directories`);
  }
}

function listRegularFiles(dir, { recursive = false, max = MAX_FILES, budget = discoveryBudget() } = {}) {
  const found = [];
  const visit = (current) => {
    if (found.length >= max) {
      budget.truncated = true;
      return;
    }
    for (const entry of boundedDirectoryEntries(current, budget)) {
      if (found.length >= max) {
        budget.truncated = true;
        break;
      }
      if (entry.isSymbolicLink()) continue;
      const path = join(current, entry.name);
      if (entry.isFile()) found.push(path);
      else if (recursive && entry.isDirectory()) visit(path);
    }
  };
  visit(dir);
  return found;
}

function jsonArtifact(path, root, gaps, label) {
  if (refuseDotEnv(path, root, gaps, label)) return null;
  if (!insideRoot(root, path)) {
    addGap(gaps, `refused artifact outside project: ${path}`);
    return null;
  }
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      addGap(gaps, `refused non-regular artifact: ${path}`);
      return null;
    }
    const metadata = {
      path: displayPath(root, path),
      bytes: stat.size,
      modified_at: stat.mtime.toISOString(),
    };
    if (stat.size > MAX_JSON_BYTES) {
      addGap(gaps, `${label} exceeds the ${MAX_JSON_BYTES}-byte JSON artifact cap`);
      return { ...metadata, truncated: true, data: null };
    }
    const status = { truncated: false };
    const data = parseJson(readFileSlice(path, 0, stat.size), label, gaps, status);
    return { ...metadata, truncated: status.truncated, data };
  } catch {
    return null;
  }
}

function collectArtifacts(sessionDir, root, gaps) {
  if (!existsSync(sessionDir)) return null;
  if (!safeSessionDirectory(sessionDir, root, gaps)) return null;
  const discovery = discoveryBudget();
  const artifacts = {
    brief: null,
    baseline: null,
    agent_map: null,
    current_verdict: null,
    engine_errors: {},
    phase_results: [],
    context_handoffs: [],
    prompts: [],
    raw_outputs: [],
  };

  artifacts.current_verdict = jsonArtifact(join(sessionDir, 'run_verdict.json'), root, gaps, 'run_verdict.json')?.data;

  const briefMarker = join(sessionDir, 'brief_path');
  try {
    const stat = lstatSync(briefMarker);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PATH_MARKER_BYTES) {
      addGap(gaps, `refused unsafe or oversized brief_path marker: ${displayPath(root, briefMarker)}`);
    } else {
      const briefPath = readFileSlice(briefMarker, 0, stat.size).trim();
      if (briefPath) artifacts.brief = readTextFile(resolve(root, briefPath), root, gaps);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') addGap(gaps, `brief_path marker unreadable: ${error.message}`);
  }
  artifacts.baseline = jsonArtifact(join(sessionDir, 'baseline.json'), root, gaps, 'baseline.json');
  artifacts.agent_map = jsonArtifact(join(sessionDir, 'agent_map.json'), root, gaps, 'agent_map.json');

  for (const path of listRegularFiles(join(sessionDir, 'phase_results'), { budget: discovery })) {
    const record = jsonArtifact(path, root, gaps, `phase_results/${basename(path)}`);
    if (record) artifacts.phase_results.push(record);
  }
  for (const path of listRegularFiles(join(sessionDir, 'context_handoff'), {
    recursive: true,
    budget: discovery,
  })) {
    const record = readTextFile(path, root, gaps, { limit: 8000 });
    if (record) artifacts.context_handoffs.push(record);
  }

  const entries = boundedDirectoryEntries(sessionDir, discovery);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || ['phase_results', 'context_handoff'].includes(entry.name))
      continue;
    const agentDir = join(sessionDir, entry.name);
    for (const path of listRegularFiles(join(agentDir, 'prompts'), { budget: discovery })) {
      const record = readTextFile(path, root, gaps);
      if (record) artifacts.prompts.push({ agent: entry.name, ...record });
    }
    const engineError = jsonArtifact(
      join(agentDir, 'engine_error.json'),
      root,
      gaps,
      `${entry.name}/engine_error.json`,
    );
    if (engineError?.data) artifacts.engine_errors[entry.name] = engineError.data;
    for (const name of ['raw_output.jsonl', 'pi_session.jsonl']) {
      const record = metadataFile(join(agentDir, name), root, gaps);
      if (record) artifacts.raw_outputs.push({ agent: entry.name, ...record });
    }
  }
  reportDiscoveryGap(gaps, 'artifact', discovery);
  return artifacts;
}

function readFallbackEvents(sessionDir, fdaId, gaps, root) {
  if (!safeSessionDirectory(sessionDir, root, gaps)) return [];
  const path = join(sessionDir, 'events.jsonl');
  if (!existsSync(path)) return [];
  if (refuseDotEnv(path, root, gaps, 'events fallback')) return [];
  let text;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || !insideRoot(root, path)) {
      addGap(gaps, `refused unsafe events fallback: ${path}`);
      return [];
    }
    const start = Math.max(0, stat.size - MAX_SOURCE_BYTES);
    text = readFileSlice(path, start, stat.size - start);
    if (start > 0) {
      const firstBreak = text.indexOf('\n');
      text = firstBreak >= 0 ? text.slice(firstBreak + 1) : '';
      addGap(gaps, `events fallback exceeded ${MAX_SOURCE_BYTES} bytes; only its bounded tail was read`);
    }
  } catch (error) {
    addGap(gaps, `events fallback unreadable: ${error.message}`);
    return [];
  }
  const events = [];
  let invalidLines = 0;
  const tail = visitBoundedTailLines(text, MAX_EVENTS, (line, lineNumber) => {
    if (!line.trim()) return;
    try {
      const row = JSON.parse(line);
      if (!row.fda_id || row.fda_id === fdaId) {
        events.push(sanitizeValue(row, 0, sanitizeContext(gaps), `events_fallback[${lineNumber - 1}]`));
      }
    } catch {
      invalidLines += 1;
    }
  });
  if (tail.truncated) addGap(gaps, `events fallback truncated to its last ${MAX_EVENTS} physical lines`);
  if (invalidLines) addGap(gaps, `events fallback contains ${invalidLines} invalid JSONL line(s) in its bounded tail`);
  return events;
}

function derivedPayload(event) {
  if (event?.payload && typeof event.payload === 'object') return event.payload;
  try {
    return JSON.parse(event?.payload_json || 'null');
  } catch {
    return null;
  }
}

function deriveFallbackSession(fdaId, events, gaps, source = 'events_jsonl') {
  if (!events.length) return null;
  const first = events[0];
  const last = events.at(-1);
  const inputEvent = events.find((event) => event.type === 'log' && derivedPayload(event)?.input);
  const input = derivedPayload(inputEvent)?.input || null;
  const end = [...events].reverse().find((event) => event.type === 'run_end');
  const endPayload = derivedPayload(end);
  return sanitizeValue(
    {
      fda_id: fdaId,
      request: input,
      status: end
        ? endPayload?.accepted === true
          ? 'success'
          : endPayload?.accepted === false
            ? 'fail'
            : 'unknown'
        : 'unknown',
      outcome: endPayload?.outcome || end?.name || null,
      outcome_reason: endPayload?.reason || null,
      started_at: first.started_at || first.ts || null,
      ended_at: end?.ended_at || end?.started_at || end?.ts || last.ended_at || last.ts || null,
      source,
    },
    0,
    sanitizeContext(gaps),
    'run.session',
  );
}

function eventPayload(event, gaps, index) {
  if (Object.hasOwn(event, 'payload')) {
    return sanitizeValue(event.payload, 0, sanitizeContext(gaps), `events[${index}].payload`);
  }
  return parseJson(event.payload_json, `events[${index}].payload_json`, gaps);
}

function summarizeEvents(rows, phaseMap, gaps) {
  const lifecycleTypes = new Set(['phase_start', 'phase_end', 'agent_start', 'agent_end', 'run_end']);
  const failureTypes = new Set(['error', 'gate_fail']);
  const engineTypes = new Set(['engine_fallback', 'engine_relay', 'engine_error', 'engine_continuation']);
  const lifecycle = [];
  const failures = [];
  const engines = [];
  const logs = [];
  const continuations = [];
  const toolSamples = [];
  const toolCounts = new Map();
  const attempts = [];
  const normalized = [];

  for (const [index, row] of rows.entries()) {
    const payload = eventPayload(row, gaps, index);
    const event = sanitizeValue(
      {
        event_id: row.event_id,
        phase_id: row.phase_id || '',
        phase: phaseMap.get(row.phase_id)?.name || null,
        type: row.type,
        name: row.name,
        payload,
        tokens: row.tokens,
        started_at: row.started_at || row.ts,
        ended_at: row.ended_at,
      },
      0,
      sanitizeContext(gaps),
      `events[${index}]`,
    );
    normalized.push(event);
    if (lifecycleTypes.has(row.type) && lifecycle.length < 250) lifecycle.push(event);
    if (failureTypes.has(row.type) && failures.length < 100) failures.push(event);
    if (engineTypes.has(row.type) && engines.length < 100) engines.push(event);
    if (row.type === 'log' && logs.length < 250) logs.push(event);
    if (
      (row.type === 'bounded_continuation' || (row.type === 'log' && row.name === 'bounded_continuation')) &&
      continuations.length < 100
    ) {
      continuations.push(event);
    }
    if (row.type === 'run_end') attempts.push(event);
    if (row.type === 'tool_call') {
      const name = String(row.name || 'unknown').split(':')[0];
      const current = toolCounts.get(name) || { tool: name, calls: 0, failures: 0 };
      current.calls += 1;
      if (payload?.ok === false || payload?.passed === false || payload?.is_error === true) current.failures += 1;
      toolCounts.set(name, current);
      if (toolSamples.length < MAX_EXAMPLES) toolSamples.push(event);
    }
  }
  return {
    normalized,
    attempts,
    summary: {
      lifecycle,
      failures,
      engines,
      logs,
      continuations,
      tools: [...toolCounts.values()].sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool)),
      tool_samples: toolSamples,
    },
  };
}

function git(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 8_000,
    maxBuffer: 5 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

function traceCommitShas(events) {
  const commitPhases = new Set(['commit', 'commit_code', 'commit_docs']);
  const shas = [];
  const add = (candidate) => {
    const value = String(candidate || '').trim();
    if (/^[0-9a-f]{7,40}$/i.test(value) && !shas.includes(value)) shas.push(value);
  };
  for (const event of events) {
    if (event.type !== 'log') continue;
    if (!commitPhases.has(event.phase) && !(event.phase == null && commitPhases.has(event.name))) continue;
    const payload = event.payload;
    if (!payload || typeof payload !== 'object') continue;
    add(payload.sha);
    add(payload.logCommit);
  }
  return shas;
}

function commitRecord(root, sha, attribution, confidence, gaps) {
  const verified = git(root, ['rev-parse', '--verify', `${sha}^{commit}`]);
  if (!verified) return null;
  const fullSha = verified.trim();
  const meta = git(root, ['show', '-s', '--format=%H%x00%h%x00%aI%x00%an%x00%s', fullSha]);
  if (!meta) return null;
  const [full, short, authoredAt, author, subject] = meta.trimEnd().split('\0');
  const nameStatus = git(root, [
    '-c',
    'core.quotepath=false',
    'show',
    '--format=',
    '--name-status',
    '--find-renames',
    fullSha,
  ]);
  const numstat = git(root, [
    '-c',
    'core.quotepath=false',
    'show',
    '--format=',
    '--numstat',
    '--find-renames',
    fullSha,
  ]);
  if (nameStatus == null) {
    addGap(gaps, `commit ${short} git show --name-status failed, timed out, or exceeded its output cap`);
  }
  if (numstat == null) {
    addGap(
      gaps,
      `commit ${short} git show --numstat failed, timed out, or exceeded its output cap; counts unavailable`,
    );
  }
  const files = [];
  for (const line of (nameStatus || '').split('\n')) {
    if (!line) continue;
    if (files.length >= MAX_FILES) {
      addGap(gaps, `commit ${short} files truncated to ${MAX_FILES} entries`);
      break;
    }
    const [status, ...paths] = line.split('\t');
    const path = paths.at(-1);
    if (path) files.push({ status, path });
  }
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  // --numstat prints renames in brace form ('src/{old.js => new.js}' or
  // 'old => new'), which never equals the --name-status new path — expand to
  // the post-rename path before the lookup so renamed files keep their counts.
  const numstatPath = (raw) => {
    const withBraces = raw.replace(/\{([^{}]*) => ([^{}]*)\}/g, (_m, _from, to) => to);
    const collapsed = withBraces.replace(/\/\//g, '/');
    const arrow = /^(.*) => (.*)$/.exec(collapsed);
    return arrow ? arrow[2] : collapsed;
  };
  for (const line of (numstat || '').split('\n')) {
    if (!line) continue;
    const [added, deleted, ...pathParts] = line.split('\t');
    const file = filesByPath.get(numstatPath(pathParts.join('\t')));
    if (!file) continue;
    file.additions = added === '-' ? null : Number(added);
    file.deletions = deleted === '-' ? null : Number(deleted);
  }
  return sanitizeValue(
    {
      sha: full,
      short_sha: short,
      authored_at: authoredAt,
      author,
      subject,
      attribution,
      confidence,
      files,
    },
    0,
    sanitizeContext(gaps),
    `commits.${short}`,
  );
}

function collectCommits(root, session, events, gaps) {
  if (git(root, ['rev-parse', '--is-inside-work-tree'])?.trim() !== 'true') {
    addGap(gaps, 'git repository unavailable; commit attribution skipped');
    return { available: false, commits: [] };
  }
  const traced = [];
  for (const sha of traceCommitShas(events)) {
    const record = commitRecord(root, sha, 'trace', 'high', gaps);
    if (record) traced.push(record);
    else addGap(gaps, `trace named commit ${sha}, but git could not resolve it`);
  }
  if (traced.length) return { available: true, commits: traced };

  const since = session?.started_at;
  const until = session?.ended_at;
  if (!since || !until || Number.isNaN(Date.parse(since)) || Number.isNaN(Date.parse(until))) {
    addGap(gaps, 'no traced commit and no closed run window; commit attribution unavailable');
    return { available: true, commits: [] };
  }
  const output = git(root, [
    'log',
    `--since=${since}`,
    `--until=${until}`,
    `--max-count=${MAX_GIT_COMMITS}`,
    '--format=%H',
  ]);
  if (output == null) {
    addGap(gaps, 'git time-window query failed');
    return { available: true, commits: [] };
  }
  const inferred = output
    .split('\n')
    .filter(Boolean)
    .map((sha) => commitRecord(root, sha, 'run_time_window', 'low', gaps))
    .filter(Boolean);
  if (inferred.length)
    addGap(gaps, 'commits are inferred from the run time window; unrelated concurrent commits may be present');
  else addGap(gaps, 'run has no attributable commit');
  return { available: true, commits: inferred };
}

function sourceDescriptor(paths, sessionDir, db) {
  return {
    config: { available: existsSync(paths.configPath), path: displayPath(paths.root, paths.configPath) },
    db: { available: Boolean(db), path: displayPath(paths.root, paths.dbPath) },
    session_dir: { available: existsSync(sessionDir), path: displayPath(paths.root, sessionDir) },
  };
}

function runRowsFromDb(db, fdaId, gaps) {
  let session = null;
  if (tableExists(db, 'sessions')) {
    try {
      session = boundedTableRows(db, 'sessions', 'WHERE fda_id=? LIMIT 1', [fdaId], gaps, 'sessions')[0] || null;
    } catch (error) {
      addGap(gaps, `sessions table unreadable: ${error.message}`);
    }
  } else if (db) addGap(gaps, 'legacy trace has no sessions table');

  let rawPhases = rowsForRun(db, 'phases', fdaId, ' ORDER BY seq, rowid', MAX_EVENTS, gaps);
  let rawEvents = rowsForRun(db, 'events', fdaId, ' ORDER BY rowid DESC', MAX_EVENTS, gaps);
  let rawEnvelopes = rowsForRun(db, 'envelopes', fdaId, ' ORDER BY created_at, rowid', MAX_EVENTS, gaps);
  let rawGates = rowsForRun(db, 'gate_results', fdaId, ' ORDER BY id', MAX_EVENTS, gaps);
  let rawAgents = rowsForRun(db, 'agent_sessions', fdaId, ' ORDER BY agent', MAX_EVENTS, gaps);
  for (const [table, rows] of [
    ['phases', rawPhases],
    ['events', rawEvents],
    ['envelopes', rawEnvelopes],
    ['gate_results', rawGates],
    ['agent_sessions', rawAgents],
  ]) {
    if (db && rows == null) addGap(gaps, `legacy trace has no readable ${table} table`);
  }
  for (const [table, rows] of [
    ['phases', rawPhases],
    ['events', rawEvents],
    ['envelopes', rawEnvelopes],
    ['gate_results', rawGates],
    ['agent_sessions', rawAgents],
  ]) {
    if (rows?.length > MAX_EVENTS) addGap(gaps, `${table} truncated to ${MAX_EVENTS} rows`);
  }
  rawPhases = rawPhases?.slice(0, MAX_EVENTS) ?? null;
  rawEvents = rawEvents?.slice(0, MAX_EVENTS).reverse() ?? null;
  rawEnvelopes = rawEnvelopes?.slice(0, MAX_EVENTS) ?? null;
  rawGates = rawGates?.slice(0, MAX_EVENTS) ?? null;
  rawAgents = rawAgents?.slice(0, MAX_EVENTS) ?? null;
  return {
    session: sanitizeValue(session, 0, sanitizeContext(gaps), 'run.session'),
    phases: normalizeRows(rawPhases, [], 'phases', gaps),
    events: rawEvents || [],
    envelopes: normalizeRows(rawEnvelopes, ['payload_json'], 'envelopes', gaps),
    gates: normalizeRows(rawGates, ['violations_json', 'checks_json'], 'gate_results', gaps),
    agent_sessions: normalizeRows(rawAgents, [], 'agent_sessions', gaps),
  };
}

/** Collect the evidence needed for a factual report of one FDA run. */
export function collectRunEvidence(rootArg, fdaIdArg, options = {}) {
  const fdaId = String(fdaIdArg || '').trim();
  if (!SAFE_FDA_ID.test(fdaId) || fdaId.includes('..')) throw new Error('invalid --run fda_id');
  const gaps = [];
  const paths = resolveEvolutionPaths(rootArg, options.env || process.env, gaps);
  assertNoLiveRun(paths);
  const now = asDate(options.now || new Date());
  const sessionDir = join(paths.dataDir, 'sessions', fdaId);
  const db = openReadOnlyDb(paths.dbPath, gaps);
  const dbAvailable = Boolean(db);
  let rows;
  try {
    rows = runRowsFromDb(db, fdaId, gaps);
  } finally {
    db?.close();
  }

  let fallbackEvents = [];
  if (!rows.session || !rows.events.length) fallbackEvents = readFallbackEvents(sessionDir, fdaId, gaps, paths.root);
  if (!rows.session) rows.session = deriveFallbackSession(fdaId, fallbackEvents, gaps);
  if (!rows.events.length && fallbackEvents.length) rows.events = fallbackEvents;
  if (!rows.session && rows.events.length) {
    rows.session = deriveFallbackSession(fdaId, rows.events, gaps, 'events_table');
  }
  if (!rows.session && !rows.events.length && !existsSync(sessionDir)) throw new Error(`unknown FIA run: ${fdaId}`);
  if (!rows.session) addGap(gaps, 'session directory exists, but no session record or usable events were found');
  else if (rows.session.status === 'running') {
    addGap(gaps, 'session is still marked running without a live FDA lock; treat this run as stale or incomplete');
  }

  const phaseMap = new Map(rows.phases.map((phase) => [phase.phase_id, phase]));
  const events = summarizeEvents(rows.events, phaseMap, gaps);
  if (!events.attempts.length) addGap(gaps, 'run has no run_end event; attempt history is incomplete');
  const commits = collectCommits(paths.root, rows.session, events.normalized, gaps);
  const sources = sourceDescriptor(paths, sessionDir, dbAvailable);
  sources.events_jsonl = {
    available: existsSync(join(sessionDir, 'events.jsonl')),
    used: fallbackEvents.length > 0,
    path: displayPath(paths.root, join(sessionDir, 'events.jsonl')),
  };
  sources.git = { available: commits.available };

  return finalizeEvidence(
    {
      schema_version: SCHEMA_VERSION,
      mode: 'reactive',
      generated_at: now.toISOString(),
      target: { fda_id: fdaId },
      sources,
      limits: {
        max_text_chars: MAX_TEXT,
        max_db_cell_chars: MAX_DB_CELL_CHARS,
        max_unindexed_rows: MAX_UNINDEXED_ROWS,
        max_events: MAX_EVENTS,
        max_array_items: MAX_ARRAY_ITEMS,
        max_gaps: MAX_GAPS,
        max_object_keys: MAX_OBJECT_KEYS,
        max_depth: 7,
        max_sanitization_gap_notices: MAX_SANITIZE_GAPS,
        max_json_artifact_bytes: MAX_JSON_BYTES,
        max_source_bytes: MAX_SOURCE_BYTES,
        max_files_per_directory: MAX_FILES,
        max_discovery_entries: MAX_DISCOVERY_ENTRIES,
        max_discovery_directories: MAX_DISCOVERY_DIRS,
        max_git_commits: MAX_GIT_COMMITS,
        raw_transcripts_included: false,
      },
      gaps,
      run: {
        session: rows.session,
        attempts: events.attempts,
        phases: rows.phases,
        envelopes: rows.envelopes,
        gates: rows.gates,
        agent_sessions: rows.agent_sessions,
        events: events.summary,
        artifacts: collectArtifacts(sessionDir, paths.root, gaps),
        commits: commits.commits,
      },
    },
    gaps,
  );
}

function timeOf(row) {
  const value = row?.ended_at || row?.lastAt || row?.started_at || row?.startedAt;
  const time = Date.parse(value || '');
  return Number.isNaN(time) ? null : time;
}

function inWindow(row, since, until) {
  const time = timeOf(row);
  return time != null && time >= since.getTime() && time <= until.getTime();
}

function countBy(rows, pick, { entity, distinctField = 'distinct_entities' } = {}) {
  const counts = new Map();
  for (const row of rows) {
    const key = String(pick(row) || 'unknown');
    const current = counts.get(key) || { count: 0, entities: new Set() };
    current.count += 1;
    const entityId = entity?.(row);
    if (entityId != null && entityId !== '') current.entities.add(String(entityId));
    counts.set(key, current);
  }
  return [...counts.entries()]
    .map(([name, record]) => ({
      name,
      count: record.count,
      ...(entity ? { [distinctField]: record.entities.size } : {}),
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function rowsForIds(db, table, ids, order = '', limit = MAX_EVENTS, gaps = []) {
  if (!tableExists(db, table)) return null;
  if (!ids.length) return [];
  try {
    const rows = [];
    for (const id of ids) {
      const remaining = limit + 1 - rows.length;
      if (remaining <= 0) break;
      const selected = boundedTableRows(
        db,
        table,
        `WHERE fda_id=?${order} LIMIT ?`,
        [id, remaining],
        gaps,
        `window ${table}`,
      );
      if (selected.skipped) return [];
      rows.push(...selected);
    }
    return rows;
  } catch {
    return null;
  }
}

function relevantEventRows(db, ids, gaps) {
  if (!tableExists(db, 'events')) return null;
  if (!ids.length) return [];
  try {
    const rows = [];
    for (const id of ids) {
      for (const query of [
        {
          where:
            "type IN ('engine_fallback','engine_relay','engine_error','engine_continuation','bounded_continuation')",
          order: 'type, name, rowid',
        },
        { where: "type='log' AND name='bounded_continuation'", order: 'rowid' },
      ]) {
        const remaining = MAX_EVENTS + 1 - rows.length;
        if (remaining <= 0) return rows;
        const selected = boundedTableRows(
          db,
          'events',
          `WHERE fda_id=? AND ${query.where} ORDER BY ${query.order} LIMIT ?`,
          [id, remaining],
          gaps,
          'window events',
        );
        if (selected.skipped) return [];
        rows.push(...selected);
      }
    }
    return rows;
  } catch {
    return null;
  }
}

function collectWindowDb(db, since, until, gaps) {
  if (!db || !tableExists(db, 'sessions'))
    return {
      available: false,
      runs: [],
      outcomes: [],
      failed_phases: [],
      gate_failures: [],
      engine_events: [],
      continuations: [],
    };
  let allRuns = [];
  try {
    allRuns = boundedTableRows(
      db,
      'sessions',
      `WHERE COALESCE(ended_at, started_at) >= ? AND started_at <= ?
       ORDER BY COALESCE(ended_at, started_at) DESC, started_at DESC LIMIT ?`,
      [since.toISOString(), until.toISOString(), MAX_RUNS + 1],
      gaps,
      'window sessions',
    );
  } catch (error) {
    addGap(gaps, `sessions table unreadable: ${error.message}`);
    return {
      available: false,
      runs: [],
      outcomes: [],
      failed_phases: [],
      gate_failures: [],
      engine_events: [],
      continuations: [],
    };
  }
  const selected = allRuns.filter((row) => inWindow(row, since, until));
  if (selected.length > MAX_RUNS) addGap(gaps, `run window truncated to newest ${MAX_RUNS} sessions`);
  const runs = selected.slice(0, MAX_RUNS);
  const ids = runs.map((row) => row.fda_id);
  let phases = rowsForIds(db, 'phases', ids, ' ORDER BY seq, rowid', MAX_EVENTS, gaps);
  let gates = rowsForIds(db, 'gate_results', ids, ' ORDER BY id', MAX_EVENTS, gaps);
  let events = relevantEventRows(db, ids, gaps);
  for (const [table, rows] of [
    ['phases', phases],
    ['gate_results', gates],
    ['events', events],
  ]) {
    if (rows == null) addGap(gaps, `window trace has no readable ${table} table`);
  }
  phases ||= [];
  gates ||= [];
  events ||= [];
  for (const [table, rows] of [
    ['window phases', phases],
    ['window gates', gates],
    ['window engine/continuation events', events],
  ]) {
    if (rows.length > MAX_EVENTS) addGap(gaps, `${table} truncated to ${MAX_EVENTS} rows`);
  }
  phases = phases.slice(0, MAX_EVENTS);
  gates = gates.slice(0, MAX_EVENTS);
  events = events.slice(0, MAX_EVENTS);
  const failedPhases = phases.filter((row) => row.status === 'fail' || row.error);
  const failedGates = gates.filter((row) => Number(row.passed) === 0);
  const engineEvents = events.filter((row) =>
    ['engine_fallback', 'engine_relay', 'engine_error', 'engine_continuation'].includes(row.type),
  );
  const continuations = events.filter(
    (row) => row.type === 'bounded_continuation' || (row.type === 'log' && row.name === 'bounded_continuation'),
  );
  return {
    available: true,
    runs: sanitizeValue(runs, 0, sanitizeContext(gaps), 'window.trace.runs'),
    outcomes: countBy(runs, (row) => row.outcome || (row.status === 'running' ? 'running' : 'unknown'), {
      entity: (row) => row.fda_id,
      distinctField: 'distinct_runs',
    }),
    failed_phases: countBy(failedPhases, (row) => row.name, {
      entity: (row) => row.fda_id,
      distinctField: 'distinct_runs',
    }),
    failed_phase_examples: sanitizeValue(
      failedPhases.slice(0, MAX_EXAMPLES),
      0,
      sanitizeContext(gaps),
      'window.trace.failed_phase_examples',
    ),
    gate_failures: countBy(failedGates, (row) => row.gate, {
      entity: (row) => row.fda_id,
      distinctField: 'distinct_runs',
    }),
    gate_failure_examples: normalizeRows(
      failedGates.slice(0, MAX_EXAMPLES),
      ['violations_json', 'checks_json'],
      'window.gates',
      gaps,
    ),
    engine_events: countBy(engineEvents, (row) => row.type, {
      entity: (row) => row.fda_id,
      distinctField: 'distinct_runs',
    }),
    engine_event_examples: normalizeRows(engineEvents.slice(0, MAX_EXAMPLES), ['payload_json'], 'window.events', gaps),
    continuations: normalizeRows(continuations.slice(0, MAX_EXAMPLES), ['payload_json'], 'window.continuations', gaps),
  };
}

function collectTelemetryRow(row, open, history) {
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
    return;
  }
  const rec = open.get(row.command_id);
  if (row.type === 'usage' && rec) {
    rec.tokens_in += row.tokens_in || 0;
    rec.tokens_out += row.tokens_out || 0;
    rec.cache_read += row.cache_read || 0;
    rec.cache_write += row.cache_write || 0;
    rec.cost += row.cost || 0;
  } else if (row.type === 'phase_start' && rec) {
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
  } else if (row.type === 'phase_end' && rec) {
    const phase = rec.phases.find((candidate) => candidate.id === row.phase_id);
    if (phase) {
      phase.ended_at = row.ended_at;
      phase.tokens_in += row.tokens_in || 0;
      phase.tokens_out += row.tokens_out || 0;
      phase.cost += row.cost || 0;
    }
  } else if (row.type === 'doc_written' && rec) {
    if (!rec.docs_written.includes(row.path)) rec.docs_written.push(row.path);
  } else if (row.type === 'settled' && rec) {
    rec.settled_at = row.settled_at;
  } else if (row.type === 'command_end') {
    const started = rec || {
      id: row.command_id,
      command: row.command,
      args: '',
      session_id: '',
      started_at: row.ended_at,
    };
    history.push({
      id: started.id,
      command: row.command || started.command,
      args: started.args || '',
      session_id: started.session_id || '',
      started_at: started.started_at,
      ended_at: row.ended_at,
      settled_at: row.settled_at ?? started.settled_at,
      status: 'ended',
      tokens_in: row.tokens_in ?? started.tokens_in ?? 0,
      tokens_out: row.tokens_out ?? started.tokens_out ?? 0,
      cache_read: row.cache_read ?? started.cache_read ?? 0,
      cache_write: row.cache_write ?? started.cache_write ?? 0,
      cost: row.cost ?? started.cost ?? 0,
      docs_written: row.docs_written || started.docs_written || [],
      phases: row.phases || started.phases || [],
      current_activity: null,
    });
    open.delete(row.command_id);
  }
}

function readEvolutionTelemetry(paths, gaps) {
  const ndjsonPath = join(paths.telemetryDir, 'commands.ndjson');
  const livePath = join(paths.telemetryDir, 'live.json');
  let live = null;
  if (existsSync(livePath)) {
    try {
      const stat = lstatSync(livePath);
      if (stat.size > MAX_JSON_BYTES) {
        addGap(gaps, `command telemetry live.json exceeds the ${MAX_JSON_BYTES}-byte JSON cap`);
      } else {
        live = parseJson(readFileSlice(livePath, 0, stat.size), 'command telemetry live.json', gaps);
      }
    } catch (error) {
      addGap(gaps, `command telemetry live.json unreadable: ${error.message}`);
    }
  }

  const history = [];
  const open = new Map();
  let sourceLines = 0;
  let invalidLines = 0;
  if (existsSync(ndjsonPath)) {
    const stat = lstatSync(ndjsonPath);
    const text = readFileSlice(ndjsonPath, 0, stat.size);
    const tail = visitBoundedTailLines(text, MAX_TELEMETRY_EVENTS, (line) => {
      if (!line.trim()) return;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        invalidLines += 1;
        return;
      }
      collectTelemetryRow(row, open, history);
    });
    sourceLines = tail.sourceLines;
    if (tail.truncated) {
      addGap(gaps, `command telemetry truncated to its last ${MAX_TELEMETRY_EVENTS} physical lines`);
    }
  }
  if (invalidLines) {
    addGap(gaps, `command telemetry contains ${invalidLines} invalid JSONL line(s) in its bounded tail`);
  }

  for (const rec of open.values()) {
    if (live?.id === rec.id) continue;
    history.push({ ...rec, status: 'running' });
  }
  history.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
  const all = [...history];
  if (live?.id) {
    const index = all.findIndex((row) => row.id === live.id);
    const merged = { ...(index >= 0 ? all[index] : {}), ...live, status: live.status || 'running' };
    if (index >= 0) all[index] = merged;
    else all.unshift(merged);
    live = merged;
  } else {
    live = all.find((row) => row.status === 'running') || null;
  }
  return {
    available: existsSync(ndjsonPath) || Boolean(live),
    live,
    history: all.filter((row) => row.status !== 'running' || row.id !== live?.id),
    sourceLines,
  };
}

function collectTelemetry(paths, since, until, gaps) {
  for (const sourcePath of [join(paths.telemetryDir, 'commands.ndjson'), join(paths.telemetryDir, 'live.json')]) {
    if (!existsSync(sourcePath)) continue;
    try {
      const stat = lstatSync(sourcePath);
      if (!stat.isFile() || stat.isSymbolicLink() || !insideRoot(paths.root, sourcePath)) {
        addGap(gaps, `refused unsafe command telemetry: ${sourcePath}`);
        return { available: false, commands: [], command_counts: [] };
      }
      if (stat.size > MAX_SOURCE_BYTES) {
        addGap(gaps, `command telemetry source ${basename(sourcePath)} exceeds the ${MAX_SOURCE_BYTES}-byte cap`);
        return { available: false, commands: [], command_counts: [] };
      }
    } catch (error) {
      addGap(gaps, `command telemetry unreadable: ${error.message}`);
      return { available: false, commands: [], command_counts: [] };
    }
  }
  let telemetry;
  try {
    telemetry = readEvolutionTelemetry(paths, gaps);
  } catch (error) {
    addGap(gaps, `command telemetry unreadable: ${error.message}`);
    return { available: false, commands: [], command_counts: [] };
  }
  if (!telemetry.available) {
    addGap(gaps, 'interactive command telemetry unavailable');
    return { available: false, commands: [], command_counts: [] };
  }
  const candidates = [...(telemetry.history || [])];
  if (telemetry.live) candidates.push({ ...telemetry.live, status: 'running' });
  const inRange = candidates.filter((row) => inWindow(row, since, until));
  if (inRange.length > MAX_RUNS) addGap(gaps, `command telemetry truncated to ${MAX_RUNS} records`);
  const commands = inRange.slice(0, MAX_RUNS);
  const finished = commands.filter((row) => row.ended_at);
  return {
    available: true,
    commands: sanitizeValue(commands, 0, sanitizeContext(gaps), 'window.commands.commands'),
    command_counts: countBy(commands, (row) => row.command, {
      entity: (row) => row.session_id,
      distinctField: 'distinct_sessions',
    }),
    totals: {
      commands: finished.length,
      tokens_in: finished.reduce((sum, row) => sum + (row.tokens_in || 0), 0),
      tokens_out: finished.reduce((sum, row) => sum + (row.tokens_out || 0), 0),
      cost: finished.reduce((sum, row) => sum + (row.cost || 0), 0),
    },
    budget: {
      source_lines_read: telemetry.sourceLines,
      max_source_lines: MAX_TELEMETRY_EVENTS,
    },
  };
}

function piToolName(name) {
  return (
    String(name || 'unknown')
      .split(':')[0]
      .trim() || 'unknown'
  );
}

function firstPiText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.find((block) => block?.type === 'text')?.text || '';
}

function parsePiEvidenceFile(file, maxEvents) {
  const text = readFileSlice(file.path, 0, file.size);
  const meta = {
    name: '',
    cwd: '',
    startedAt: null,
    lastAt: null,
    provider: '',
    model: '',
    thinking: '',
    msgCount: 0,
    toolCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    ended: false,
  };
  const evidence = [];
  let cursor = 0;
  let sourceEvents = 0;
  let invalidLines = 0;
  while (cursor < text.length && sourceEvents < maxEvents) {
    const end = text.indexOf('\n', cursor);
    const line = text.slice(cursor, end < 0 ? text.length : end);
    cursor = end < 0 ? text.length : end + 1;
    if (!line.trim()) continue;
    sourceEvents += 1;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      invalidLines += 1;
      continue;
    }
    const timestamp = row.timestamp || null;
    if (timestamp) {
      meta.lastAt = timestamp;
      if (!meta.startedAt) meta.startedAt = timestamp;
    }
    if (row.type === 'session_info') {
      if (row.name) meta.name = row.name;
      continue;
    }
    if (row.type === 'session') {
      meta.cwd = row.cwd || '';
      continue;
    }
    if (row.type === 'session_end' || row.type === 'shutdown') {
      meta.ended = true;
      continue;
    }
    if (row.type === 'model_change') {
      meta.provider = row.provider || meta.provider;
      meta.model = row.modelId || meta.model;
      continue;
    }
    if (row.type === 'thinking_level_change') {
      meta.thinking = row.thinkingLevel || meta.thinking;
      continue;
    }
    if (row.type !== 'message' || !row.message) continue;
    const message = row.message;
    if (message.role === 'user' || message.role === 'assistant') meta.msgCount += 1;
    if (message.role === 'user') {
      const content = firstPiText(message.content);
      evidence.push({ type: 'user', at: timestamp, text: content });
      continue;
    }
    if (message.role === 'toolResult') {
      if (message.isError) {
        evidence.push({ type: 'error', at: message.timestamp || timestamp, text: firstPiText(message.content) });
      }
      continue;
    }
    if (message.role !== 'assistant') continue;
    const usage = message.usage || {};
    meta.tokensIn += usage.input || 0;
    meta.tokensOut += usage.output || 0;
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type !== 'toolCall') continue;
      meta.toolCalls += 1;
      evidence.push({ type: 'tool_call', at: timestamp, name: block.name || 'unknown' });
    }
  }
  return {
    meta,
    evidence,
    sourceEvents,
    invalidLines,
    sourceCapped: cursor < text.length,
  };
}

function incrementPiTool(map, name, sessionId) {
  const key = piToolName(name);
  const record = map.get(key) || { name: key, count: 0, sessions: new Set() };
  record.count += 1;
  record.sessions.add(sessionId);
  map.set(key, record);
}

function piToolCounts(map) {
  return [...map.values()]
    .map((record) => ({ name: record.name, count: record.count, distinct_sessions: record.sessions.size }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function sameProjectRoot(root, cwd) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return false;
  try {
    return realpathSync(resolve(cwd)) === realpathSync(root);
  } catch {
    return false;
  }
}

function collectPi(paths, since, until, gaps) {
  if (!existsSync(paths.piDir)) {
    addGap(gaps, 'project Pi sessions unavailable');
    return { available: false, sessions: [], tool_counts: [], user_messages: [], errors: [] };
  }
  const files = [];
  try {
    const discovery = discoveryBudget(MAX_PI_DISCOVERY_ENTRIES, 1);
    for (const entry of boundedDirectoryEntries(paths.piDir, discovery)) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.jsonl')) continue;
      try {
        const path = join(paths.piDir, entry.name);
        const stat = lstatSync(path);
        files.push({ id: entry.name.slice(0, -'.jsonl'.length), path, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        /* vanished during bounded discovery */
      }
    }
    if (discovery.error) throw discovery.error;
    if (discovery.truncated) {
      addGap(gaps, `Pi session discovery truncated at ${MAX_PI_DISCOVERY_ENTRIES} entries`);
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
  } catch (error) {
    addGap(gaps, `Pi sessions unreadable: ${error.message}`);
    return { available: false, sessions: [], tool_counts: [], user_messages: [], errors: [] };
  }
  if (files.length > MAX_PI_SESSIONS)
    addGap(gaps, `Pi session source was truncated to its newest ${MAX_PI_SESSIONS} files`);
  const sessions = [];
  const toolCounts = new Map();
  const userMessages = [];
  const errors = [];
  let omittedUserMessages = 0;
  let omittedErrors = 0;
  let bytesRead = 0;
  let sourceEventsRead = 0;
  let stopForBudget = false;
  for (const [index, file] of files.slice(0, MAX_PI_SESSIONS).entries()) {
    if (refuseDotEnv(file.path, paths.root, gaps, 'Pi session')) continue;
    if (bytesRead + file.size > MAX_PI_BYTES) {
      addGap(
        gaps,
        `Pi byte budget exhausted after ${bytesRead} bytes; ${Math.min(files.length, MAX_PI_SESSIONS) - index} session file(s) were not read`,
      );
      break;
    }
    const remainingEvents = MAX_PI_EVENTS - sourceEventsRead;
    if (remainingEvents <= 0) {
      addGap(gaps, `Pi event budget exhausted at ${MAX_PI_EVENTS} source events`);
      break;
    }
    try {
      const parsed = parsePiEvidenceFile(file, remainingEvents);
      bytesRead += file.size;
      sourceEventsRead += parsed.sourceEvents;
      if (parsed.invalidLines)
        addGap(gaps, `Pi session ${file.id} contains ${parsed.invalidLines} invalid JSONL line(s)`);
      if (parsed.sourceCapped) {
        addGap(gaps, `Pi event budget exhausted while reading session ${file.id}`);
        stopForBudget = true;
      }
      if (!sameProjectRoot(paths.root, parsed.meta.cwd)) {
        addGap(gaps, `Pi session ${file.id} has no matching project cwd and was ignored`);
        if (stopForBudget) break;
        continue;
      }
      const firstUser = parsed.evidence.find((event) => event.type === 'user');
      const summary = {
        id: file.id,
        name: parsed.meta.name || truncate(firstUser?.text || file.id, 70),
        request: truncate(firstUser?.text || '', 160),
        startedAt: parsed.meta.startedAt,
        lastAt: parsed.meta.lastAt,
        provider: parsed.meta.provider,
        model: parsed.meta.model,
        thinking: parsed.meta.thinking,
        msgCount: parsed.meta.msgCount,
        toolCalls: parsed.meta.toolCalls,
        tokensIn: parsed.meta.tokensIn,
        tokensOut: parsed.meta.tokensOut,
        state: parsed.meta.ended ? 'finished' : 'unknown',
      };
      if (inWindow(summary, since, until)) {
        sessions.push(summary);
        for (const event of parsed.evidence) {
          if (event.type === 'tool_call') incrementPiTool(toolCounts, event.name, file.id);
          else if (event.type === 'user' && userMessages.length < MAX_PI_MESSAGES) {
            userMessages.push({ session_id: file.id, at: event.at, text: truncate(event.text, 1000) });
          } else if (event.type === 'user') omittedUserMessages += 1;
          else if (event.type === 'error' && errors.length < MAX_EXAMPLES) {
            errors.push({ session_id: file.id, at: event.at, text: truncate(event.text, 1000) });
          } else if (event.type === 'error') omittedErrors += 1;
        }
      }
    } catch (error) {
      addGap(gaps, `Pi session ${file.id} could not be read: ${error.message}`);
    }
    if (stopForBudget) break;
  }
  if (omittedUserMessages)
    addGap(gaps, `${omittedUserMessages} Pi user-message sample(s) omitted by the ${MAX_PI_MESSAGES}-message cap`);
  if (omittedErrors) addGap(gaps, `${omittedErrors} Pi error sample(s) omitted by the ${MAX_EXAMPLES}-example cap`);
  return {
    available: true,
    sessions: sanitizeValue(sessions, 0, sanitizeContext(gaps), 'window.pi.sessions'),
    tool_counts: piToolCounts(toolCounts),
    user_messages: sanitizeValue(userMessages, 0, sanitizeContext(gaps), 'window.pi.user_messages'),
    errors: sanitizeValue(errors, 0, sanitizeContext(gaps), 'window.pi.errors'),
    budget: {
      bytes_read: bytesRead,
      source_events_read: sourceEventsRead,
      max_bytes: MAX_PI_BYTES,
      max_source_events: MAX_PI_EVENTS,
    },
    assistant_messages_included: false,
  };
}

/** Aggregate bounded opportunity signals across FDA and interactive work. */
export function collectWindowEvidence(rootArg, sinceArg, options = {}) {
  const gaps = [];
  const paths = resolveEvolutionPaths(rootArg, options.env || process.env, gaps);
  assertNoLiveRun(paths);
  const window = parseSince(sinceArg, options.now || new Date());
  const since = asDate(window.since);
  const until = asDate(window.until);
  const db = openReadOnlyDb(paths.dbPath, gaps);
  let trace;
  try {
    trace = collectWindowDb(db, since, until, gaps);
  } finally {
    db?.close();
  }
  const commands = collectTelemetry(paths, since, until, gaps);
  const pi = collectPi(paths, since, until, gaps);
  return finalizeEvidence(
    {
      schema_version: SCHEMA_VERSION,
      mode: 'proactive',
      generated_at: window.until,
      target: { since: window.since, until: window.until, input: window.raw, kind: window.kind },
      sources: {
        config: { available: existsSync(paths.configPath), path: displayPath(paths.root, paths.configPath) },
        db: { available: trace.available, path: displayPath(paths.root, paths.dbPath) },
        command_telemetry: { available: commands.available, path: displayPath(paths.root, paths.telemetryDir) },
        pi_sessions: { available: pi.available, path: displayPath(paths.root, paths.piDir) },
      },
      limits: {
        max_runs: MAX_RUNS,
        max_examples_per_category: MAX_EXAMPLES,
        max_pi_sessions: MAX_PI_SESSIONS,
        max_pi_discovery_entries: MAX_PI_DISCOVERY_ENTRIES,
        max_pi_bytes: MAX_PI_BYTES,
        max_pi_source_events: MAX_PI_EVENTS,
        max_telemetry_source_events: MAX_TELEMETRY_EVENTS,
        max_pi_user_messages: MAX_PI_MESSAGES,
        max_text_chars: MAX_TEXT,
        max_db_cell_chars: MAX_DB_CELL_CHARS,
        max_unindexed_rows: MAX_UNINDEXED_ROWS,
        max_array_items: MAX_ARRAY_ITEMS,
        max_gaps: MAX_GAPS,
        max_object_keys: MAX_OBJECT_KEYS,
        max_depth: 7,
        max_sanitization_gap_notices: MAX_SANITIZE_GAPS,
        max_source_bytes: MAX_SOURCE_BYTES,
        assistant_messages_included: false,
      },
      gaps,
      window: { trace, commands, pi },
    },
    gaps,
  );
}

function parseArgs(argv) {
  const parsed = { run: null, since: null, dir: process.cwd(), help: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--json') continue;
    else if (['--run', '--since', '--dir'].includes(arg)) {
      if (seen.has(arg)) throw new Error(`duplicate argument: ${arg}`);
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      parsed[arg.slice(2)] = value;
      seen.add(arg);
      index += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

export const USAGE = `Usage:
  node imp/scripts/evolution-evidence.mjs --run <fda_id> [--dir <root>]
  node imp/scripts/evolution-evidence.mjs --since <Nd|YYYY-MM-DD> [--dir <root>]`;

/** CLI body, exported for contract tests. */
export function runCli(argv, options = {}) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    (options.stdout || process.stdout).write(`${USAGE}\n`);
    return 0;
  }
  if (Boolean(parsed.run) === Boolean(parsed.since)) throw new Error('choose exactly one of --run or --since');
  const evidence = parsed.run
    ? collectRunEvidence(parsed.dir, parsed.run, options)
    : collectWindowEvidence(parsed.dir, parsed.since, options);
  (options.stdout || process.stdout).write(`${JSON.stringify(evidence, null, 2)}\n`);
  return 0;
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`evolution-evidence: ${error.message}`);
    process.exitCode = 1;
  }
}
