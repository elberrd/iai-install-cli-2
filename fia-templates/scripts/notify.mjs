#!/usr/bin/env node
/**
 * Notifications — inspect and test the ping that fires when a run ends.
 *
 * Students start a long /goal and walk away; without this nothing tells them it
 * finished. Notifications are OPT-IN and off by default, and a notification
 * failure can never affect a run — all the policy lives in
 * imp/modules/notify.mjs, this file only reports and test-sends.
 *
 * `run_end` is the only event a run emits today. `gate_blocked` and
 * `decision_needed` are reserved: the config accepts them and `--test` sends
 * them, but no run produces them yet, so this command says so out loud rather
 * than leaving a student waiting for a ping that cannot come.
 *
 * Usage (students run `imp notify …`, which passes every flag through to this
 * script — that branded form is what this file's own output names):
 *   node imp/scripts/notify.mjs [--dir <root>] [--json]
 *   node imp/scripts/notify.mjs --test [--event run_end] [--dir <root>] [--json]
 *
 *   (no flags)  print the RESOLVED configuration and, when it is off, the exact
 *               JSON to paste into ~/.impactus-cli/config.json. Always exits 0.
 *   --test      send one synthetic notification. Exit 0 when at least one target
 *               took it, 1 when none did (or notifications are off).
 *   --json      the same information as JSON. NEVER contains a URL or a token —
 *               every target is reported as kind + host.
 *   --home <d>  read the machine config from another home (tests, diagnostics).
 *
 * Config: ~/.impactus-cli/config.json (key "notify") merged with
 * imp/fia.config.yaml (key "notify"), the project winning per key. Both are
 * student-owned and optional.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  NOTIFY_EMITTED_EVENTS,
  NOTIFY_EVENTS,
  buildNotification,
  notifyConfigOf,
  readMachineNotify,
  sendNotification,
} from '../modules/notify.mjs';

const CONFIG_REL = 'imp/fia.config.yaml';

/** Events the config accepts but no run emits yet. */
function reservedEvents() {
  return NOTIFY_EVENTS.filter((event) => !NOTIFY_EMITTED_EVENTS.includes(event));
}

/**
 * The one sentence that tells a student which of the valid events a run really
 * emits. Single source of the wording so the help text, the `--test` note and
 * the comment in imp/fia.config.yaml cannot drift apart.
 */
export function reservedEventsNote() {
  const reserved = reservedEvents();
  const head = `only ${NOTIFY_EMITTED_EVENTS.join(', ')} is emitted by a run today`;
  if (!reserved.length) return head;
  return `${head}; ${reserved.join(' and ')} ${reserved.length > 1 ? 'are' : 'is'} reserved for a future release`;
}

function flagValue(argv, flag) {
  const ix = argv.indexOf(flag);
  return ix !== -1 && argv[ix + 1] !== undefined ? argv[ix + 1] : undefined;
}

/**
 * The `notify` block of imp/fia.config.yaml → `{ data, path, exists, error }`.
 * Absent file is the normal case; a YAML syntax error degrades to `error` (the
 * parser's message is dropped — it quotes the file back, tokens included).
 */
export function readProjectNotify(root, configPath = process.env.FIA_CONFIG) {
  const path = configPath ? resolve(configPath) : join(resolve(root), ...CONFIG_REL.split('/'));
  const rel = configPath ? path.replaceAll('\\', '/') : CONFIG_REL;
  if (!existsSync(path)) return { data: null, path: rel, exists: false, error: null };
  let parsed;
  try {
    parsed = parseYaml(readFileSync(path, 'utf8'));
  } catch {
    return {
      data: null,
      path: rel,
      exists: true,
      error: `${rel} is not valid YAML — the project overrides were ignored`,
    };
  }
  const notify = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.notify : undefined;
  if (notify === undefined) return { data: null, path: rel, exists: true, error: null };
  if (!notify || typeof notify !== 'object' || Array.isArray(notify)) {
    return {
      data: null,
      path: rel,
      exists: true,
      error: `the "notify" key in ${rel} must be a block — it was ignored`,
    };
  }
  return { data: notify, path: rel, exists: true, error: null };
}

/**
 * Resolve everything the renderers need. Read-only: nothing here writes, and a
 * missing/broken config file degrades into an `error` string, never a throw.
 */
export function resolveNotify(opts = {}) {
  const root = resolve(opts.root || process.cwd());
  const machine = readMachineNotify(opts.home || homedir());
  const project = readProjectNotify(root, opts.configPath);
  const config = notifyConfigOf({ project: project.data, machine: machine.data });
  const warnings = [...config.warnings];
  if (machine.error) warnings.unshift(machine.error);
  if (project.error) warnings.unshift(project.error);
  return {
    root,
    project: { name: basename(root), path: project.path, exists: project.exists, error: project.error },
    machine: { path: machine.path, exists: machine.exists, error: machine.error },
    config,
    warnings,
  };
}

/** The snippet a student pastes to switch notifications on. Illustrative values only. */
export function enableSnippet() {
  return JSON.stringify(
    {
      notify: {
        enabled: true,
        events: ['run_end'],
        targets: [{ kind: 'slack', url: 'https://hooks.slack.com/services/T000/B000/replace-with-your-webhook' }],
      },
    },
    null,
    2,
  );
}

/** Public shape: kind + host only, so no URL and no token can ever be printed. */
function publicTargets(config) {
  return config.targets.map((t) =>
    t.chat_id ? { kind: t.kind, host: t.host, chat_id: 'set' } : { kind: t.kind, host: t.host },
  );
}

export function notifyStatusJson(report) {
  return {
    enabled: report.config.enabled,
    events: report.config.events,
    timeout_ms: report.config.timeout_ms,
    targets: publicTargets(report.config),
    machine: { path: report.machine.path, exists: report.machine.exists },
    project: { path: report.project.path, exists: report.project.exists },
    warnings: report.warnings,
  };
}

export function renderNotifyStatus(report) {
  const { config } = report;
  const lines = ['Notifications — resolved configuration (nothing was sent by this command)', ''];
  lines.push(`Status:   ${config.enabled ? 'ON' : 'OFF'}`);
  lines.push(`Events:   ${config.events.join(', ')}`);
  lines.push(`Timeout:  ${config.timeout_ms}ms per target`);
  lines.push(`Machine:  ${report.machine.path}${report.machine.exists ? '' : '  (not found)'}`);
  lines.push(`Project:  ${report.project.path}${report.project.exists ? '' : '  (not found)'}`);
  lines.push('', config.targets.length ? `Targets (${config.targets.length}):` : 'Targets:  none');
  for (const t of config.targets) {
    lines.push(`  · ${t.kind} → ${t.host}${t.chat_id ? ' (chat_id set)' : ''}`);
  }
  if (config.targets.length) lines.push('', 'Only the host is ever shown — the rest of each URL is a secret.');
  if (report.warnings.length) {
    lines.push('', 'Notes:');
    for (const w of report.warnings) lines.push(`  ! ${w}`);
  }
  if (!config.enabled) {
    lines.push('', `To switch notifications on, add this to ${report.machine.path}:`, '', enableSnippet());
    lines.push(
      '',
      `Targets: webhook (any https endpoint) · slack · discord · telegram (needs "chat_id").`,
      `Events: ${NOTIFY_EVENTS.join(', ')} — ${reservedEventsNote()}.`,
      `Then check it with: imp notify --test`,
    );
  } else {
    lines.push('', 'Send a real test with: imp notify --test');
  }
  return lines.join('\n');
}

/**
 * Send one synthetic notification and report per-target delivery. Never
 * throws; `fetchImpl` is a seam so the test suite makes zero network calls.
 */
export async function runNotifyTest(report, opts = {}) {
  const requested = opts.event;
  const event = NOTIFY_EVENTS.includes(requested) ? requested : 'run_end';
  const notification = buildNotification({
    event,
    fdaId: 'r_test000',
    fdaName: 'notify --test',
    project: report.project.name,
    outcome: 'test notification',
    // This lands verbatim in the team's Slack/Discord channel, so it names the
    // branded verb — the internal script path is not the product's public face.
    reason: 'sent by `imp notify --test` — no run was involved',
    durationSeconds: 0,
  });
  const send = await sendNotification(report.config, notification, { fetchImpl: opts.fetchImpl });
  const notes = [];
  if (requested && !NOTIFY_EVENTS.includes(requested)) {
    notes.push(`unknown --event value — used "${event}" instead (valid: ${NOTIFY_EVENTS.join(', ')})`);
  }
  if (!NOTIFY_EMITTED_EVENTS.includes(event)) {
    notes.push(`"${event}" is a reserved event — no run emits it yet, so nothing beyond this test send will arrive`);
  }
  if (!report.config.enabled) notes.push('notifications are off — nothing was sent');
  else if (!report.config.events.includes(event)) {
    notes.push(`"${event}" is not in notify.events (${report.config.events.join(', ')}) — nothing was sent`);
  }
  return { mode: 'test', event, enabled: report.config.enabled, ...send, notes, warnings: report.warnings };
}

export function renderTestResult(result, report) {
  const lines = [`Notifications — test send (event: ${result.event})`, ''];
  for (const r of result.results)
    lines.push(`  ${r.ok ? '✓' : '✗'} ${r.kind} → ${r.host}${r.ok ? '' : ` — ${r.error}`}`);
  if (!result.results.length) lines.push('  (no target was contacted)');
  lines.push('', `Result: ${result.delivered} of ${result.attempted} target(s) delivered`);
  for (const note of result.notes) lines.push(`  ! ${note}`);
  for (const failure of result.failures) lines.push(`  ! ${failure}`);
  if (!result.delivered) {
    lines.push(
      '',
      report && !report.config.enabled
        ? `Nothing is configured yet — run: imp notify   (it prints the JSON to paste into ${report.machine.path})`
        : 'No target took the notification. Check the URL in the machine/project config, then re-run this test.',
    );
  }
  return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

// realpath both sides: Node realpaths the ESM entry for import.meta.url, so a
// symlinked invocation path would otherwise make the CLI a silent no-op.
const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  }
})();
if (isMain) {
  const argv = process.argv.slice(2);
  const root = resolve(flagValue(argv, '--dir') || process.cwd());
  const json = argv.includes('--json');
  const report = resolveNotify({ root, home: flagValue(argv, '--home') });
  if (argv.includes('--test')) {
    const result = await runNotifyTest(report, { event: flagValue(argv, '--event') });
    console.log(json ? JSON.stringify(result, null, 2) : renderTestResult(result, report));
    if (!result.delivered) process.exit(1);
  } else {
    console.log(json ? JSON.stringify(notifyStatusJson(report), null, 2) : renderNotifyStatus(report));
  }
}
