// Pure translation layer: a plain "choices" object (as posted by the web UI)
// → the argv/flags of the `impactus` CLI. No I/O, fully unit-testable.
//
// The web UI (src/steps/ui-server.js) only *builds a command* — the install
// itself runs in the student's own terminal. So this module's whole job is:
// given what the user ticked in the browser, produce the exact
// `npx impactus …` line that reproduces it.

import { ADDON_GROUPS } from '../config.js';

/**
 * @typedef {Object} Choices
 * @property {'harness'|'full'} [mode]      Install mode.
 * @property {string} [name]                Project name.
 * @property {string} [dir]                 Target folder.
 * @property {string} [preset]              Addon preset (only meaningful in full mode).
 * @property {Object<string,string[]|string>} [groups]
 *   Per-group selection keyed by the group's `flag`. Multiselect groups map to
 *   an array of ids; `single` groups map to one id (or 'none').
 * @property {'convex'|'r2'} [storage]      File storage backend (full mode).
 * @property {boolean} [push]               Create the GitHub repo + push.
 * @property {boolean} [deploy]             Deploy to Vercel at the end.
 * @property {boolean} [privateRepo]        Repo visibility when pushing.
 * @property {boolean} [yes]                Non-interactive (safe defaults).
 */

const GROUP_BY_FLAG = new Map(ADDON_GROUPS.map((g) => [g.flag, g]));

/**
 * Build the CLI invocation from the UI choices.
 * @param {Choices} choices
 * @param {{api?: string}} [opts]
 *   Server-side extras: `api` appends `--api <url>` so the copied command
 *   validates the token against the SAME backend the page used
 *   (only shows up in dev/test; in production the flag does not exist).
 * @returns {{ argv: string[], command: string }}
 *   `argv` = tokens after `impactus`; `command` = the copy-pasteable line.
 */
export function buildCommand(choices = {}, opts = {}) {
  const argv = [];
  const mode = choices.mode === 'harness' ? 'harness' : 'full';

  // Positional project name (kept first, like the CLI's own grammar).
  if (choices.name && String(choices.name).trim()) {
    argv.push(String(choices.name).trim());
  }
  if (choices.dir && String(choices.dir).trim()) {
    argv.push('--dir', String(choices.dir).trim());
  }

  if (mode === 'harness') {
    // Harness only: template/addons/storage/deploy are all irrelevant.
    // With a stack path chosen on the page, `--stack` already carries the mode
    // (mode.js) — without it, keep the classic `--harness-only` (older pages).
    const stackToken = harnessStackToken(choices);
    if (stackToken) argv.push('--stack', stackToken);
    else argv.push('--harness-only');
    if (choices.yes) argv.push('--yes');
    return finalize(argv, opts);
  }

  // ── full mode ──────────────────────────────────────────────────────────────
  argv.push('--mode', 'full');

  // Template: ALWAYS explicit — without the flag, the interactive wizard asks
  // "which template?" again, ignoring what was clicked on the page.
  // `tenancy: 'multi'` is accepted as a legacy form (older pages).
  const templateId = choices.templateId
    ? String(choices.templateId)
    : choices.tenancy === 'multi'
      ? 'live2'
      : 'live1';
  argv.push('--template-id', templateId);

  // Preset first, then explicit group flags override it (matches the CLI's
  // precedence: group flags > --preset > default).
  if (choices.preset) argv.push('--preset', String(choices.preset));

  const groups = choices.groups || {};
  for (const [flag, raw] of Object.entries(groups)) {
    const group = GROUP_BY_FLAG.get(flag);
    if (!group) continue; // ignore unknown groups defensively
    argv.push(...groupTokens(group, raw));
  }

  if (choices.storage) argv.push('--storage', String(choices.storage));

  // Keys pasted into the UI → saved to a LOCAL file (600); the command only
  // carries the path, never the values (no secrets in shell history).
  if (choices.keysPath && String(choices.keysPath).trim()) {
    argv.push('--keys', String(choices.keysPath).trim());
  }

  // An unchecked checkbox is a decision, not an omission: it becomes --no-push/
  // --no-deploy so the terminal does not ask again (and preflight does not
  // prepare gh/vercel login for nothing). `undefined` (older page) stays omitted.
  if (choices.push) {
    argv.push('--push');
    argv.push(choices.privateRepo === false ? '--public' : '--private');
  } else if (choices.push === false) {
    argv.push('--no-push');
  }
  if (choices.deploy) argv.push('--deploy');
  else if (choices.deploy === false) argv.push('--no-deploy');
  if (choices.yes) argv.push('--yes');

  return finalize(argv, opts);
}

/**
 * Value of the --stack flag in harness mode, from the path chosen on the
 * page (`stackPath` + `stackChoices`). null = older page without the stack
 * section (keeps --harness-only).
 *   - 'discover' → `depois` (everything pending; decide with Pi);
 *   - 'custom' → `category=option` pairs INCLUDING `category=depois` — leaving
 *     it pending was also the person's decision, and the explicit pair stops
 *     the terminal wizard from re-asking that layer;
 *   - 'custom' with no choice at all (or all `depois`) → `propria`/`depois`.
 */
function harnessStackToken(choices) {
  if (choices.stackPath === 'discover') return 'depois';
  if (choices.stackPath !== 'custom') return null;
  const entries = Object.entries(choices.stackChoices || {}).filter(([, v]) => v);
  if (!entries.length) return 'propria';
  if (entries.every(([, v]) => v === 'depois')) return 'depois';
  return entries.map(([k, v]) => `${k}=${v}`).join(',');
}

/**
 * Turn one group's selection into flag tokens.
 * `single` groups → `--flag value` (omitted when 'none'/empty, unless a preset
 * is in play — see note below). Multiselect groups → `--flag a,b`, `--flag none`
 * when explicitly cleared, or nothing when left at the preset/default.
 */
function groupTokens(group, raw) {
  if (group.single) {
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value || value === 'none') return [`--${group.flag}`, 'none'];
    return [`--${group.flag}`, String(value)];
  }
  // multiselect
  const values = (Array.isArray(raw) ? raw : raw ? [raw] : [])
    .map((v) => String(v).trim())
    .filter(Boolean);
  if (values.length === 0) return [`--${group.flag}`, 'none'];
  return [`--${group.flag}`, values.join(',')];
}

function finalize(argv, opts = {}) {
  if (opts.api && String(opts.api).trim()) argv.push('--api', String(opts.api).trim());
  return { argv, command: `npx impactus ${argv.map(quote).join(' ')}`.trimEnd() };
}

/** Quote a token for a copy-pasteable shell command (only when needed). */
function quote(token) {
  return /[^\w./@,=-]/.test(token) ? `'${token.replace(/'/g, `'\\''`)}'` : token;
}
