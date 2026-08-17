/**
 * Run notifications — opt-in, zero-dependency pings for the moment a student is
 * not watching the terminal: a run that ended. `gate_blocked` and
 * `decision_needed` are RESERVED names (see NOTIFY_EVENTS): the config accepts
 * them and `imp notify --test` can send them, but no run emits them yet.
 *
 * Three hard guarantees, in order of importance:
 *   1. A notification can NEVER affect a run. Nothing here throws or rejects:
 *      a malformed config, a dead webhook, a missing `fetch`, a timeout — all
 *      degrade into a warning or a `failures` entry. `notifyRunEnd` is safe to
 *      call from an error boundary with any input, including `undefined`.
 *   2. Off by default. `enabled` must be explicitly `true` AND at least one
 *      valid target must survive validation; anything else stays off and the
 *      reason is reported in `warnings`.
 *   3. No secret ever leaves this module. A target URL usually embeds a token
 *      (Slack/Discord webhook path, Telegram bot token), so every warning,
 *      failure string and rendered line names a target by kind + HOST only.
 *      Fetch/JSON error messages are never interpolated — V8 and undici both
 *      quote input back at you, which would leak the token we just redacted.
 *
 * Config comes from two places, project wins per key:
 *   machine: ~/.impactus-cli/config.json → key `notify` (read here)
 *   project: imp/fia.config.yaml → key `notify` (parsed by the caller and
 *            passed in — this module never reads the YAML)
 * Both are student-owned and may be absent: every key has a code default.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Code defaults — the shape a project with no `notify` block behaves as. */
export const NOTIFY_DEFAULTS = Object.freeze({ enabled: false, events: ['run_end'], timeout_ms: 4000 });

/**
 * The only events that can be notified. Anything else is dropped.
 *
 * `run_end` is the only one a run emits today — `announceRunEnd` in
 * modules/fda-cli.mjs is the single producer in the whole runtime. `gate_blocked`
 * and `decision_needed` are RESERVED: the config accepts them and `imp notify
 * --test --event <name>` sends them, but nothing in a run builds them yet, so a
 * student who subscribes to them alone never receives a ping from a run. Keep
 * NOTIFY_EMITTED_EVENTS in step when a producer for either one lands.
 */
export const NOTIFY_EVENTS = Object.freeze(['run_end', 'gate_blocked', 'decision_needed']);

/** The subset of NOTIFY_EVENTS a run actually emits today; the rest are reserved. */
export const NOTIFY_EMITTED_EVENTS = Object.freeze(['run_end']);

const MACHINE_DIR = '.impactus-cli';
const MACHINE_FILE = 'config.json';
const TARGET_KINDS = Object.freeze(['webhook', 'slack', 'discord', 'telegram']);
const TIMEOUT_MIN = 500;
const TIMEOUT_MAX = 20000;
const TEXT_CAP = 500;

// ── redaction ────────────────────────────────────────────────────────────────

/**
 * Host of a URL, or a neutral placeholder. `URL.host` drops userinfo, the
 * path and the query, so the Slack/Discord secret path and the Telegram bot
 * token can never survive into a message.
 */
function hostOf(url) {
  try {
    return new URL(String(url)).host || '(no host)';
  } catch {
    return '(unreadable url)';
  }
}

/** Echo a config value back to the student ONLY when it is plainly a token-free word. */
function safeWord(value) {
  const s = String(value == null ? '' : value);
  return /^[A-Za-z0-9_-]{1,24}$/.test(s) ? `"${s}"` : '(unreadable value)';
}

/** Collapse free text to one line and cap it — titles must stay single-line. */
function oneLine(value, cap = TEXT_CAP) {
  const s = String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > cap ? `${s.slice(0, cap - 1)}…` : s;
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

// ── machine config ───────────────────────────────────────────────────────────

/** `<home>/.impactus-cli/config.json`. `home` is a test seam. */
export function machineConfigPath(home = homedir()) {
  return join(home, MACHINE_DIR, MACHINE_FILE);
}

/**
 * The `notify` block of the machine config: `{ data, path, exists, error }`.
 * Absent file → `exists: false`, no error (that is the normal case).
 * Unreadable/invalid JSON → `error` set, `data: null` — never a throw, and
 * never the parser's message (it quotes the file back, tokens included).
 */
export function readMachineNotify(home = homedir()) {
  const path = machineConfigPath(home);
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { data: null, path, exists: false, error: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      data: null,
      path,
      exists: true,
      error: 'the machine config is not valid JSON — notifications stay off until it parses',
    };
  }
  const root = plainObject(parsed);
  if (!root) {
    return {
      data: null,
      path,
      exists: true,
      error: 'the machine config must be a JSON object — notifications stay off',
    };
  }
  if (root.notify === undefined) return { data: null, path, exists: true, error: null };
  const notify = plainObject(root.notify);
  if (!notify) {
    return {
      data: null,
      path,
      exists: true,
      error: 'the machine config key "notify" must be an object — notifications stay off',
    };
  }
  return { data: notify, path, exists: true, error: null };
}

// ── config resolution ────────────────────────────────────────────────────────

function clampTimeout(raw, warnings) {
  if (raw == null) return NOTIFY_DEFAULTS.timeout_ms;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    warnings.push(`notify.timeout_ms ${safeWord(raw)} is not a number — using ${NOTIFY_DEFAULTS.timeout_ms}ms`);
    return NOTIFY_DEFAULTS.timeout_ms;
  }
  const clamped = Math.min(TIMEOUT_MAX, Math.max(TIMEOUT_MIN, Math.round(n)));
  if (clamped !== Math.round(n)) {
    warnings.push(
      `notify.timeout_ms ${Math.round(n)} is outside [${TIMEOUT_MIN}, ${TIMEOUT_MAX}] — clamped to ${clamped}ms`,
    );
  }
  return clamped;
}

function normalizeEvents(raw, warnings) {
  if (raw == null) return [...NOTIFY_DEFAULTS.events];
  if (!Array.isArray(raw)) {
    warnings.push(`notify.events must be a list — using the default (${NOTIFY_DEFAULTS.events.join(', ')})`);
    return [...NOTIFY_DEFAULTS.events];
  }
  const kept = [];
  for (const entry of raw) {
    const name = typeof entry === 'string' ? entry.trim() : '';
    if (!NOTIFY_EVENTS.includes(name)) {
      warnings.push(
        `notify event ${safeWord(entry)} is not known and was dropped (valid: ${NOTIFY_EVENTS.join(', ')})`,
      );
      continue;
    }
    if (!kept.includes(name)) kept.push(name);
  }
  if (!kept.length) {
    warnings.push(`no valid notify event left — using the default (${NOTIFY_DEFAULTS.events.join(', ')})`);
    return [...NOTIFY_DEFAULTS.events];
  }
  return kept;
}

/** http:// is refused except on the loopback host a student uses to test locally. */
function localhostOk(parsed) {
  return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
}

/**
 * One config entry → `{ kind, url, chat_id?, host }` or null (dropped, with an
 * English warning). `host` is precomputed so every renderer can report a
 * target without ever touching the full URL.
 */
function normalizeTarget(entry, index, warnings) {
  const at = `notify target #${index + 1}`;
  const obj = plainObject(entry);
  if (!obj) {
    warnings.push(`${at} was dropped — each target must be an object like { "kind": "slack", "url": "https://…" }`);
    return null;
  }
  const kind = typeof obj.kind === 'string' ? obj.kind.trim().toLowerCase() : '';
  if (!TARGET_KINDS.includes(kind)) {
    warnings.push(`${at} was dropped — kind ${safeWord(obj.kind)} is unknown (valid: ${TARGET_KINDS.join(', ')})`);
    return null;
  }
  const rawUrl = typeof obj.url === 'string' ? obj.url.trim() : '';
  if (!rawUrl) {
    warnings.push(`${at} (${kind}) was dropped — "url" is missing`);
    return null;
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    warnings.push(`${at} (${kind}) was dropped — "url" is not a valid absolute URL`);
    return null;
  }
  const host = parsed.host || '(no host)';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && localhostOk(parsed))) {
    warnings.push(
      `${at} (${kind}, ${host}) was dropped — only https:// is accepted, because the URL carries a token that must not cross the network in the clear (http:// is allowed for localhost and 127.0.0.1 only)`,
    );
    return null;
  }
  const target = { kind, url: rawUrl, host };
  if (kind === 'telegram') {
    const chatId = obj.chat_id == null ? '' : String(obj.chat_id).trim();
    if (!chatId) {
      warnings.push(
        `${at} (telegram, ${host}) was dropped — telegram also needs "chat_id" (the chat the bot posts to)`,
      );
      return null;
    }
    target.chat_id = chatId;
  }
  return target;
}

function normalizeTargets(raw, warnings) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    warnings.push('notify.targets must be a list of targets — none were used');
    return [];
  }
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const target = normalizeTarget(raw[i], i, warnings);
    if (target) out.push(target);
  }
  return out;
}

/**
 * Resolve the effective notification config from the two sources, project
 * winning per key. Returns `{ enabled, events, targets, timeout_ms, warnings }`.
 * `enabled` is true only when it was explicitly `true` AND a valid target
 * survived; every other outcome is reported in `warnings` (never fatal).
 */
export function notifyConfigOf({ project = null, machine = null } = {}) {
  const warnings = [];
  const collect = (value, label) => {
    if (value == null) return {};
    const obj = plainObject(value);
    if (!obj) {
      warnings.push(`the ${label} "notify" block must be an object — it was ignored`);
      return {};
    }
    return obj;
  };
  const m = collect(machine, 'machine config');
  const p = collect(project, 'project config');
  const pick = (key) => (p[key] !== undefined ? p[key] : m[key]);

  const events = normalizeEvents(pick('events'), warnings);
  const targets = normalizeTargets(pick('targets'), warnings);
  const timeout_ms = clampTimeout(pick('timeout_ms'), warnings);
  const requested = pick('enabled') === true;

  let enabled = false;
  if (!requested) {
    warnings.push('notifications are off — set notify.enabled to true (and add at least one target) to switch them on');
  } else if (!targets.length) {
    warnings.push('notify.enabled is true but no valid target remains — nothing will be sent');
  } else {
    enabled = true;
  }
  return { enabled, events, targets, timeout_ms, warnings };
}

// ── the notification ─────────────────────────────────────────────────────────

const EVENT_HEAD = Object.freeze({
  run_end: 'ended',
  gate_blocked: 'blocked at a gate',
  decision_needed: 'needs a decision',
});

/** 1234567 → "1,234,567" (no ICU dependency, identical on every machine). */
function formatInt(n) {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatCost(n) {
  const abs = Math.abs(n);
  return `$${n.toFixed(abs > 0 && abs < 0.01 ? 4 : 2)}`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (v) => String(v).padStart(2, '0');
  if (h) return `${h}h ${pad(m)}m ${pad(s)}s`;
  if (m) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build the notification from whatever the runtime happens to know. EVERY
 * field is optional: an absent field is omitted from title/text/payload — it
 * is never rendered as "undefined". Title and text stay plain text (no
 * markdown) so a webhook, Slack, Discord and Telegram all render them.
 */
export function buildNotification(input) {
  const src = plainObject(input) || {};
  const event = NOTIFY_EVENTS.includes(src.event) ? src.event : 'run_end';
  const fdaId = oneLine(src.fdaId, 80);
  const fdaName = oneLine(src.fdaName, 80);
  const project = oneLine(src.project, 80);
  const outcome = oneLine(src.outcome, 120);
  const phase = oneLine(src.phase, 80);
  const reason = oneLine(src.reason);
  const accepted = src.accepted == null ? null : Boolean(src.accepted);
  const tokens = finiteOrNull(src.tokens);
  const cost = finiteOrNull(src.cost);
  const durationSeconds = finiteOrNull(src.durationSeconds);

  let head = `${fdaId ? `run ${fdaId}` : 'run'} ${EVENT_HEAD[event]}`;
  if (event === 'run_end' && outcome) head += `: ${outcome}`;
  const title = ['IMPACTUS', project, head].filter(Boolean).join(' · ');

  const fields = [];
  const add = (label, value) => fields.push({ label, value });
  if (fdaName) add('FDA', fdaName);
  if (phase) add('Phase', phase);
  if (event !== 'run_end' && outcome) add('Outcome', outcome);
  if (accepted != null) add('Accepted', accepted ? 'yes' : 'no');
  if (reason) add('Reason', reason);
  if (tokens != null) add('Tokens', formatInt(tokens));
  if (cost != null) add('Cost', formatCost(cost));
  if (durationSeconds != null) add('Duration', formatDuration(durationSeconds));

  const payload = { source: 'impactus', version: 1, event };
  const put = (key, value) => {
    if (value !== null && value !== '') payload[key] = value;
  };
  put('fdaId', fdaId);
  put('fdaName', fdaName);
  put('outcome', outcome);
  put('reason', reason);
  put('project', project);
  put('phase', phase);
  put('tokens', tokens);
  put('cost', cost);
  put('durationSeconds', durationSeconds);
  if (accepted != null) payload.accepted = accepted;

  return { event, title, text: fields.map((f) => `${f.label}: ${f.value}`).join('\n'), fields, payload };
}

// ── sending ──────────────────────────────────────────────────────────────────

function messageOf(notification) {
  const title = oneLine(notification?.title, 300);
  const text = String(notification?.text == null ? '' : notification.text);
  return [title, text].filter(Boolean).join('\n');
}

/**
 * Telegram accepts either shape for `url`, because students copy both from the
 * Bot API docs:
 *   https://api.telegram.org/bot<token>                → /sendMessage appended
 *   https://api.telegram.org/bot<token>/sendMessage    → used as-is
 * A trailing slash is tolerated in both.
 */
function telegramUrl(url) {
  const base = String(url).replace(/\/+$/, '');
  return /\/sendMessage$/i.test(base) ? base : `${base}/sendMessage`;
}

/**
 * The HTTP request for one target: `{ url, init }`, pure — so every body shape
 * is unit-testable with no network. Returns null for a target this module does
 * not know how to post to (never throws).
 */
export function targetRequest(target, notification) {
  const kind = target?.kind;
  const message = messageOf(notification);
  const post = (url, body) => ({
    url,
    init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  });
  if (kind === 'webhook') return post(String(target.url), notification?.payload ?? {});
  if (kind === 'slack') return post(String(target.url), { text: message });
  if (kind === 'discord') return post(String(target.url), { content: message });
  if (kind === 'telegram') return post(telegramUrl(target.url), { chat_id: target.chat_id, text: message });
  return null;
}

/**
 * Why a fetch failed, in words that can never contain the URL. Undici and V8
 * both put the offending input into `err.message`, so the message is dropped
 * on purpose and only the error's NAME is used.
 */
function describeFetchError(err, timeoutMs) {
  const name = String(err?.name || '');
  if (name === 'TimeoutError' || name === 'AbortError') return `timed out after ${timeoutMs}ms`;
  return `request failed (${/^[A-Za-z]{1,32}$/.test(name) ? name : 'Error'})`;
}

async function deliver(target, notification, fetchImpl, timeoutMs) {
  const label = `${target?.kind || 'target'} (${target?.host || hostOf(target?.url)})`;
  const base = { kind: target?.kind || 'target', host: target?.host || hostOf(target?.url) };
  const request = targetRequest(target, notification);
  if (!request) return { ...base, ok: false, error: `${label}: unsupported target — nothing was sent` };
  let signal;
  try {
    signal = AbortSignal.timeout(timeoutMs);
  } catch {
    /* no AbortSignal.timeout in this runtime — send without a deadline */
  }
  try {
    const res = await fetchImpl(request.url, signal ? { ...request.init, signal } : request.init);
    const status = Number(res?.status);
    if (res?.ok === true || (Number.isFinite(status) && status >= 200 && status < 300)) return { ...base, ok: true };
    return { ...base, ok: false, error: `${label}: HTTP ${Number.isFinite(status) ? status : 'no status'}` };
  } catch (err) {
    return { ...base, ok: false, error: `${label}: ${describeFetchError(err, timeoutMs)}` };
  }
}

/**
 * Post the notification to every target, in parallel, each with its own
 * deadline. Resolves ALWAYS — a non-2xx, a thrown fetch or a timeout becomes
 * one redacted English line in `failures`. Short-circuits (attempting nothing)
 * when notifications are off or the event is not subscribed.
 *
 * `results` is the per-target detail (kind + host + ok, no URL) the `imp
 * notify --test` report renders; callers that only care about the totals read
 * `attempted` / `delivered` / `failures`.
 */
export async function sendNotification(config, notification, opts = {}) {
  const { fetchImpl = globalThis.fetch } = plainObject(opts) || {};
  const result = { attempted: 0, delivered: 0, failures: [], results: [] };
  try {
    const cfg = plainObject(config) || {};
    const targets = Array.isArray(cfg.targets) ? cfg.targets : [];
    const events = Array.isArray(cfg.events) && cfg.events.length ? cfg.events : NOTIFY_DEFAULTS.events;
    if (cfg.enabled !== true || !notification || !events.includes(notification.event)) return result;
    if (typeof fetchImpl !== 'function') {
      result.failures.push('no fetch available in this runtime — notifications need Node >= 22.12');
      return result;
    }
    const timeoutMs = Number.isFinite(Number(cfg.timeout_ms))
      ? Math.min(TIMEOUT_MAX, Math.max(TIMEOUT_MIN, Math.round(Number(cfg.timeout_ms))))
      : NOTIFY_DEFAULTS.timeout_ms;
    result.attempted = targets.length;
    const outcomes = await Promise.all(targets.map((t) => deliver(t, notification, fetchImpl, timeoutMs)));
    for (const outcome of outcomes) {
      result.results.push(outcome);
      if (outcome.ok) result.delivered++;
      else result.failures.push(outcome.error);
    }
  } catch {
    /* the notifier itself must never surface an error into the run */
    if (!result.failures.length) result.failures.push('the notifier failed before it could send anything');
  }
  return result;
}

/**
 * The one call the runtime makes when a run ends: resolve the config, build
 * the `run_end` notification, send it, return the send result. Never throws
 * for any input — `notifyRunEnd()` with no arguments is valid and is a no-op
 * on a machine that never configured notifications.
 *
 * opts: `{ project, machine, home, fetchImpl }` — `machine` short-circuits the
 * machine-config read (tests, or a caller that already read it), `home`
 * redirects that read.
 */
export async function notifyRunEnd(input, opts = {}) {
  try {
    const o = plainObject(opts) || {};
    const machine = o.machine !== undefined ? o.machine : readMachineNotify(o.home || homedir()).data;
    const config = notifyConfigOf({ project: o.project ?? null, machine });
    const notification = buildNotification({ ...(plainObject(input) || {}), event: 'run_end' });
    return await sendNotification(config, notification, o);
  } catch {
    return {
      attempted: 0,
      delivered: 0,
      failures: ['the notifier failed before it could send anything'],
      results: [],
    };
  }
}
