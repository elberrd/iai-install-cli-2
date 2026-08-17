// Machine-level configuration file: ~/.impactus-cli/config.json.
//
// Until now the state folder held only the login (auth.json), the keys pasted
// in the web UI (keys/) and the run logs (logs/) — every other knob was an env
// var, which nobody can discover and nobody can persist. This file is the
// home for machine-wide preferences (today: notifications), read by `imp
// settings` and by whoever needs a default that outlives a single shell.
//
// Contract with the student: the file is HAND-EDITABLE. Therefore
//   - a missing file is not an error (defaults win),
//   - a key the CLI does not recognize is a WARNING, never fatal (a newer CLI
//     may have written it — downgrading must not brick the machine),
//   - only a file that exists and cannot be parsed (or holds an invalid
//     recognized value) is reported as a problem.
//
// SECRETS: the notify targets carry webhook URLs (Slack/Discord tokens live
// INSIDE the url) and Telegram chat ids. Nothing in this module ever echoes
// one back: `describeConfig` reduces a url to its host and every other
// sensitive value to '(set)', because `imp settings` output is exactly the
// thing students paste into a support channel. Redaction is by VALUE as well
// as by key name — a token pasted under a mistyped key (`notify.webhook_uri`)
// is still a url, and a url is always collapsed to its host.

import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { LEGACY_STATE_DIR, STATE_DIR } from '../config.js';
import { stateDirPath } from './state-dir.js';

/** File name inside the state folder. */
export const CONFIG_FILE = 'config.json';

/** Schema version written by this CLI (absent `version` means "this one"). */
export const CONFIG_VERSION = 1;

/**
 * Absolute path of the machine config file. Resolving it goes through
 * `stateDirPath`, which RENAMES a pre-rebrand ~/.create-iai on first touch —
 * fine for a writer, wrong for a read-only reporter (use
 * `configFilePathReadOnly` there).
 * @param {string} [home] test seam; defaults to the real home directory.
 */
export function configFilePath(home = homedir()) {
  return join(stateDirPath(home), CONFIG_FILE);
}

/**
 * Same path, resolved WITHOUT touching the disk. `imp settings` (and any other
 * read-only diagnostic) resolves through here, so that merely reporting a path
 * never moves a folder inside $HOME.
 *
 * A config file left in a pre-rebrand state folder is read where it lies; in
 * every other case the CURRENT name wins, even when only the legacy folder is
 * on disk — that is the single path the writer and the runtime notifier
 * (fia-templates/modules/notify.mjs reads ~/.impactus-cli/config.json and
 * nothing else) both use, so it is the only honest answer to "where do I create
 * this file?".
 * @param {string} [home] test seam; defaults to the real home directory.
 */
export function configFilePathReadOnly(home = homedir()) {
  const current = join(home, STATE_DIR, CONFIG_FILE);
  if (existsSync(current)) return current;
  const legacy = join(home, LEGACY_STATE_DIR, CONFIG_FILE);
  return existsSync(legacy) ? legacy : current;
}

/**
 * `opts` is always `{ home?, path?, readOnly? }` — tests never touch the real
 * home. `readOnly: true` resolves the path without migrating the legacy folder.
 */
function resolveTarget(opts = {}) {
  if (opts.path) return opts.path;
  const home = opts.home || homedir();
  return opts.readOnly ? configFilePathReadOnly(home) : configFilePath(home);
}

// A JSON parse error message may quote the offending source (i.e. a webhook
// url with a token in it). Keep only the position hint.
function safeParseHint(message) {
  const m = /position \d+(?: \(line \d+ column \d+\))?/.exec(String(message || ''));
  return m ? ` (at ${m[0]})` : '';
}

/**
 * Reads the machine config. NEVER throws.
 * @param {{home?: string, path?: string, readOnly?: boolean}} [opts]
 *   `readOnly: true` resolves the path without migrating a pre-rebrand state
 *   folder — reading a file must not move a directory in the student's home.
 * @returns {Promise<{path: string, exists: boolean, data: object, error: string|null}>}
 *   missing file → `{ exists: false, data: {} }`;
 *   malformed    → `{ exists: true, data: {}, error: '<English sentence>' }`.
 */
export async function loadConfigFile(opts = {}) {
  const path = resolveTarget(opts);
  if (!existsSync(path)) return { path, exists: false, data: {}, error: null };
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return {
      path,
      exists: true,
      data: {},
      error: `${path} exists but could not be read (permissions?) — the defaults are being used.`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      path,
      exists: true,
      data: {},
      error: `${path} is not valid JSON${safeParseHint(err?.message)} — fix it (or delete it) to stop using the defaults.`,
    };
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { path, exists: true, data: {}, error: `${path} must contain a JSON object — the defaults are being used.` };
  }
  return { path, exists: true, data: parsed, error: null };
}

/**
 * Writes the machine config with the state-folder permissions (dir 700, file
 * 600) used by auth.json and the keys files.
 * @returns {Promise<{path: string}>}
 */
export async function saveConfigFile(data, opts = {}) {
  const path = resolveTarget(opts);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(data ?? {}, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600); // guarantees it even when the file already existed
  return { path };
}

// ── Validation ───────────────────────────────────────────────────────────────
// RUNTIME TWIN: fia-templates/modules/notify.mjs validates the same `notify`
// block inside a project. The rules are DUPLICATED here on purpose — src/ (the
// installer) must not import from fia-templates/ (the stamped runtime), and a
// visible duplicate is better than a hidden coupling. If the notifier's rules
// change (a new target kind, a new field), change them here too.
//
// Every constant below has a named twin in that module — being LOOSER than the
// runtime is a bug, because then `imp settings` blesses a config the notifier
// silently throws away:
//   NOTIFY_KINDS       ← TARGET_KINDS
//   NOTIFY_EVENT_NAMES ← NOTIFY_EVENTS      (normalizeEvents drops the rest)
//   TIMEOUT_MIN/MAX_MS ← TIMEOUT_MIN/MAX    (clampTimeout clamps to the range)
//   LOOPBACK_HOSTS     ← localhostOk        (http:// survives nowhere else)
const NOTIFY_KINDS = ['webhook', 'slack', 'discord', 'telegram'];
const NOTIFY_EVENT_NAMES = ['run_end', 'gate_blocked', 'decision_needed'];
// ← NOTIFY_DEFAULTS.events: what normalizeEvents falls back to when nothing
// usable is left. Also mirrored by DEFAULT_VALUES in src/steps/settings.js.
const DEFAULT_EVENT_NAMES = ['run_end'];
const TIMEOUT_MIN_MS = 500;
const TIMEOUT_MAX_MS = 20000;
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const KNOWN_TOP_LEVEL = ['version', 'notify'];
const KNOWN_NOTIFY_KEYS = ['enabled', 'events', 'targets', 'timeout_ms'];

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * Validates the parsed config.
 * @returns {{ok: boolean, errors: string[], warnings: string[], normalized: object}}
 *   Unknown keys are warnings (a hand-edited file must never become fatal).
 *   No message ever contains a url or a token — target problems are reported
 *   by index only.
 */
export function validateConfigData(data) {
  const errors = [];
  const warnings = [];
  const normalized = {};

  if (!isPlainObject(data)) {
    return {
      ok: false,
      errors: ['The config must be a JSON object (for example {"notify": {"enabled": true}}).'],
      warnings,
      normalized: { version: CONFIG_VERSION },
    };
  }

  // version
  if (data.version === undefined) {
    normalized.version = CONFIG_VERSION;
  } else if (typeof data.version !== 'number' || !Number.isFinite(data.version)) {
    errors.push(`"version" must be a number (this CLI writes ${CONFIG_VERSION}).`);
    normalized.version = CONFIG_VERSION;
  } else {
    normalized.version = data.version;
    if (data.version > CONFIG_VERSION) {
      warnings.push(
        `"version" is ${data.version} but this CLI understands ${CONFIG_VERSION} — the file was written by a newer version; update with \`imp update\`.`,
      );
    }
  }

  // Unknown top-level keys are preserved verbatim in `normalized` (they may
  // belong to a newer CLI) and only reported.
  for (const key of Object.keys(data)) {
    if (KNOWN_TOP_LEVEL.includes(key)) continue;
    warnings.push(`Unknown setting "${key}" — ignored by this version (kept in the file).`);
    normalized[key] = data[key];
  }

  if (data.notify !== undefined) {
    const notify = validateNotify(data.notify, errors, warnings);
    if (notify) normalized.notify = notify;
  }

  return { ok: errors.length === 0, errors, warnings, normalized };
}

function validateNotify(raw, errors, warnings) {
  if (!isPlainObject(raw)) {
    errors.push('"notify" must be an object (for example {"enabled": true, "targets": []}).');
    return null;
  }
  const out = {};

  for (const key of Object.keys(raw)) {
    if (!KNOWN_NOTIFY_KEYS.includes(key)) {
      warnings.push(`Unknown setting "notify.${key}" — ignored by this version (kept in the file).`);
      out[key] = raw[key];
    }
  }

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
    else errors.push('"notify.enabled" must be true or false.');
  }

  if (raw.timeout_ms !== undefined) {
    if (typeof raw.timeout_ms === 'number' && Number.isFinite(raw.timeout_ms) && raw.timeout_ms > 0) {
      // The runtime clamps instead of failing, so a value outside the range is
      // not an error — but it must be reported as CLAMPED, never as effective.
      const rounded = Math.round(raw.timeout_ms);
      const clamped = Math.min(TIMEOUT_MAX_MS, Math.max(TIMEOUT_MIN_MS, rounded));
      out.timeout_ms = clamped;
      if (clamped !== rounded) {
        warnings.push(
          `"notify.timeout_ms" is ${rounded}, outside [${TIMEOUT_MIN_MS}, ${TIMEOUT_MAX_MS}] — the runtime clamps it to ${clamped}ms.`,
        );
      }
    } else {
      errors.push('"notify.timeout_ms" must be a positive number of milliseconds.');
    }
  }

  // `normalizeEvents` in the runtime twin never refuses to run over this key:
  // a name it does not know is DROPPED with a warning, a non-list is ignored
  // with a warning, and when nothing usable is left it falls back to
  // NOTIFY_DEFAULTS.events. Both halves of that are mirrored here — reporting
  // any of it as an error would make `imp settings` exit 1 (and print an empty
  // list as effective) over a config the runtime happily notifies with. Values
  // are still named by index only, never echoed.
  if (raw.events !== undefined) {
    if (!Array.isArray(raw.events)) {
      warnings.push(
        `"notify.events" must be an array of event names (for example ["run_end"]) — the runtime ignores it and uses: ${DEFAULT_EVENT_NAMES.join(', ')}.`,
      );
      out.events = [...DEFAULT_EVENT_NAMES];
    } else {
      const events = [];
      raw.events.forEach((event, i) => {
        const name = typeof event === 'string' ? event.trim() : '';
        if (!name) {
          warnings.push(`"notify.events[${i}]" is not a non-empty event name — the runtime drops it.`);
          return;
        }
        if (!NOTIFY_EVENT_NAMES.includes(name)) {
          warnings.push(
            `"notify.events[${i}]" is not a known event — the runtime drops it; use one of: ${NOTIFY_EVENT_NAMES.join(', ')}.`,
          );
          return;
        }
        if (!events.includes(name)) events.push(name);
      });
      if (events.length === 0) {
        warnings.push(
          `"notify.events" leaves no event the runtime knows — it falls back to: ${DEFAULT_EVENT_NAMES.join(', ')}.`,
        );
        out.events = [...DEFAULT_EVENT_NAMES];
      } else {
        out.events = events;
      }
    }
  }

  if (raw.targets !== undefined) {
    if (!Array.isArray(raw.targets)) {
      errors.push('"notify.targets" must be an array of targets ({ "kind": "slack", "url": "…" }).');
    } else {
      const targets = [];
      raw.targets.forEach((target, i) => {
        const cleaned = validateTarget(target, i, errors, warnings);
        if (cleaned) targets.push(cleaned);
      });
      out.targets = targets;
    }
  }

  return out;
}

/** Parsed http(s) URL, or null (not absolute, or another protocol). */
function parseHttpUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null; // not an absolute url — the caller reports it by index
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
}

// Never echoes the url or the chat id: a bad target is named by its index.
function validateTarget(target, i, errors, warnings) {
  const at = `notify.targets[${i}]`;
  if (!isPlainObject(target)) {
    errors.push(`"${at}" must be an object with "kind" and "url".`);
    return null;
  }
  const out = {};
  let fatal = false;

  if (typeof target.kind !== 'string' || !NOTIFY_KINDS.includes(target.kind)) {
    errors.push(`"${at}.kind" is not supported — use one of: ${NOTIFY_KINDS.join(', ')}.`);
    fatal = true;
  } else {
    out.kind = target.kind;
  }

  const url = typeof target.url === 'string' ? target.url.trim() : '';
  const parsedUrl = url ? parseHttpUrl(url) : null;
  if (!parsedUrl) {
    errors.push(`"${at}.url" must be an http(s) URL (the value is not shown here on purpose).`);
    fatal = true;
  } else if (parsedUrl.protocol === 'http:' && !LOOPBACK_HOSTS.includes(parsedUrl.hostname)) {
    // The runtime drops plain http:// on a remote host (the url carries a
    // token), so accepting it here would report a target that never fires.
    errors.push(
      `"${at}.url" uses http:// on a remote host — the runtime drops it, because the url carries a token. Use https:// (http:// is accepted for ${LOOPBACK_HOSTS.join(', ')} only).`,
    );
    fatal = true;
  } else {
    out.url = url;
  }

  if (target.chat_id !== undefined) {
    if (typeof target.chat_id === 'string' || typeof target.chat_id === 'number') out.chat_id = target.chat_id;
    else errors.push(`"${at}.chat_id" must be a string or a number.`);
  } else if (out.kind === 'telegram') {
    warnings.push(`"${at}" is a telegram target without "chat_id" — Telegram cannot deliver without it.`);
  }

  for (const key of Object.keys(target)) {
    if (['kind', 'url', 'chat_id'].includes(key)) continue;
    warnings.push(`Unknown setting "${at}.${key}" — ignored by this version.`);
  }

  return fatal ? null : out;
}

// ── Human description (safe to paste anywhere) ───────────────────────────────

const REDACT_SUFFIXES = ['url', 'token', 'key', 'secret', 'chat_id'];

// Inside a target only "kind" is safe to print: the url embeds the webhook
// token, chat_id names a private chat, and an unknown field is by definition a
// field we cannot vouch for. Everything else there is redacted by default.
const TARGET_FIELD = /^notify\.targets\[\d+\]\.(.+)$/;

/** True when a dotted key path points at something that must not be printed. */
function isSensitive(key) {
  const path = String(key);
  const targetField = TARGET_FIELD.exec(path);
  if (targetField) return targetField[1] !== 'kind';
  const last = path
    .split('.')
    .pop()
    .replace(/\[\d+\]$/, '')
    .toLowerCase();
  return REDACT_SUFFIXES.some((suffix) => last.endsWith(suffix));
}

/** Host of a url, or null when it does not parse. */
function hostOf(value) {
  try {
    return new URL(String(value)).host || null;
  } catch {
    return null;
  }
}

/**
 * True for a value that is plainly a url, whatever its key is called. A token
 * pasted under a key we do not recognize (a mistyped `notify.webhook_uri`) must
 * not be printed just because the key name gave no hint.
 */
function looksLikeUrl(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9+.-]*:\/\/\S/i.test(value.trim());
}

/**
 * Redacted rendering of one value. Urls collapse to their host (enough to tell
 * "the right Slack workspace" from "the wrong one") whether the key looked
 * sensitive or not; anything else sensitive becomes '(set)'.
 */
export function redactValue(key, value) {
  const host = hostOf(value);
  if (!isSensitive(key)) {
    if (!looksLikeUrl(value)) return value;
    return host ? `${host} (path hidden)` : '(url hidden)';
  }
  return host ? `${host} (path hidden)` : '(set)';
}

/**
 * Flattens the config into dotted keys with every secret redacted — the shape
 * `imp settings` prints and students paste into support channels.
 * @returns {{key: string, value: unknown, note: string}[]}
 */
export function describeConfig(data) {
  const rows = [];
  walk(data, '', rows);
  return rows;
}

function walk(value, path, rows) {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      rows.push({ key: path, value: '(empty list)', note: '' });
      return;
    }
    value.forEach((item, i) => walk(item, `${path}[${i}]`, rows));
    return;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0 && path) {
      rows.push({ key: path, value: '(empty)', note: '' });
      return;
    }
    for (const [key, child] of entries) walk(child, path ? `${path}.${key}` : key, rows);
    return;
  }
  if (!path) return; // a bare primitive has no key — nothing to describe
  const sensitive = isSensitive(path) || looksLikeUrl(value);
  rows.push({
    key: path,
    value: sensitive ? redactValue(path, value) : value,
    note: sensitive ? 'redacted — safe to share' : '',
  });
}
