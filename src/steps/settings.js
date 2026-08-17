// `imp settings` — where every machine-level setting comes from.
//
// READ-ONLY by contract: settings never writes, never creates the config file
// and never migrates anything — the machine config is resolved through the
// non-migrating `configFilePathReadOnly` (the default resolver renames a
// pre-rebrand ~/.create-iai on first touch, and a diagnostic must never move a
// folder in $HOME). It answers three questions and stops:
//   1. where is the machine config (~/.impactus-cli/config.json) and is it there,
//   2. which sources are in play (machine file, the project's
//      imp/fia.config.yaml, the env vars that override behaviour),
//   3. for each effective value: what it is and WHERE it came from
//      (default < machine < project < env).
// Anything that needs changing is changed by the student in an editor — the
// human report ends with the exact JSON to paste when the file is missing.
//
// The verb is `settings`, NOT `config`: `imp` forwards unknown verbs to `pi`,
// and `pi config` is a real Pi command that must keep working.
//
// Every printed value goes through the redaction in src/lib/config-file.js
// (a webhook url collapses to its host, a token becomes '(set)') because this
// output is what students paste into a support channel.

import process from 'node:process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pc from 'picocolors';
import { parse as parseYaml } from 'yaml';
import { COMMUNITY } from '../config.js';
import { describeConfig, loadConfigFile, validateConfigData } from '../lib/config-file.js';

// The project file that may override a machine setting (student-owned; never
// touched by --update-runtime).
const PROJECT_CONFIG = 'imp/fia.config.yaml';

// Env vars that change how the CLI behaves. `secret: true` is reported as
// SET/not set only — the value never reaches the report.
const ENV_VARS = [
  { name: 'IMPACTUS_API', note: 'community API base used by the installer (overrides the default).' },
  { name: 'IMPACTUS_TOKEN', secret: true, note: 'CLI token for automation (skips the interactive login).' },
  { name: 'PI_OFFLINE', note: 'skips every network probe (update checks stay quiet).' },
  { name: 'IMP_SKIP_VERSION_CHECK', note: 'skips the post-session update check only.' },
];

// Code defaults for the settings that have one. `imp/fia.config.yaml` and the
// machine config are both optional, so these must be correct on their own.
// RUNTIME TWIN: this table mirrors NOTIFY_DEFAULTS in
// fia-templates/modules/notify.mjs, key by key — keep it in sync by hand (src/
// never imports the stamped runtime; test/imp-settings.test.js compares them).
export const DEFAULT_VALUES = [
  { key: 'notify.enabled', value: false },
  { key: 'notify.events', value: ['run_end'] },
  { key: 'notify.timeout_ms', value: 4000 },
];

// List-valued notify keys are ATOMIC: `notifyConfigOf` in the runtime twin
// picks each top-level key from the winning source WHOLESALE (`pick(key)`), so
// a project list REPLACES the machine list — it never merges with it element by
// element. Reporting them per index would print rows the runtime never uses.
const ATOMIC_NOTIFY_KEYS = ['events', 'targets'];

const isAtomicRow = (key) =>
  ATOMIC_NOTIFY_KEYS.some(
    (name) => key === `notify.${name}` || key.startsWith(`notify.${name}[`) || key.startsWith(`notify.${name}.`),
  );

const notifyBlock = (value) => (value != null && typeof value === 'object' && !Array.isArray(value) ? value : null);

/** Reads the project's fia.config.yaml `notify` block. Never throws. */
async function readProjectNotify(cwd) {
  const path = join(cwd, ...PROJECT_CONFIG.split('/'));
  if (!existsSync(path)) return { path, exists: false, notify: null, warning: null };
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return {
      path,
      exists: true,
      notify: null,
      warning: `${PROJECT_CONFIG} exists but could not be read (permissions?).`,
    };
  }
  let doc;
  try {
    doc = parseYaml(text);
  } catch {
    return {
      path,
      exists: true,
      notify: null,
      warning: `${PROJECT_CONFIG} is not valid YAML — its settings are being ignored.`,
    };
  }
  if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) {
    return {
      path,
      exists: true,
      notify: null,
      warning: `${PROJECT_CONFIG} does not contain a YAML mapping — its settings are being ignored.`,
    };
  }
  // TOP-LEVEL `notify:` ONLY — both runtime readers take that key and nothing
  // else (imp/scripts/notify.mjs reads `parsed.notify`, imp/modules/fda-cli.mjs
  // passes `{ project: cfg?.notify }`), so a block nested anywhere else is dead
  // config and must be reported as such instead of being honoured here.
  const notify = doc.notify ?? null;
  if (notify == null && doc.observability?.notify !== undefined) {
    return {
      path,
      exists: true,
      notify: null,
      warning: `${PROJECT_CONFIG}: "observability.notify" is ignored — the runtime reads the top-level "notify" key only; move the block there.`,
    };
  }
  if (notify != null && (typeof notify !== 'object' || Array.isArray(notify))) {
    return {
      path,
      exists: true,
      notify: null,
      warning: `${PROJECT_CONFIG}: "notify" must be a mapping — it is being ignored.`,
    };
  }
  return { path, exists: true, notify, warning: null };
}

/** Flattened, redacted `notify.*` rows of one source (missing block → none). */
function notifyRows(notify) {
  if (notify == null) return [];
  return describeConfig({ notify }).filter((row) => row.key.startsWith('notify.'));
}

/**
 * Probe every source and return the report (no printing — unit-testable).
 * @param {{home?: string, path?: string, cwd?: string, env?: object}} [opts]
 *   `home`/`path` point the machine config elsewhere (tests never touch the
 *   real home); `env` is the environment seam.
 */
export async function collectSettingsReport(opts = {}) {
  const cwd = resolve(opts.cwd || process.cwd());
  const env = opts.env || process.env;
  const machine = await loadConfigFile({ ...opts, readOnly: true });
  const validation = machine.exists
    ? validateConfigData(machine.data)
    : { ok: true, errors: [], warnings: [], normalized: {} };
  const project = await readProjectNotify(cwd);

  const errors = [...(machine.error ? [machine.error] : []), ...validation.errors];
  const warnings = [...validation.warnings, ...(project.warning ? [project.warning] : [])];

  // `ok` is per-source so the printer can mark the machine file ✖ instead of ✅
  // when it exists but is broken — a green line above twenty lines of red is
  // the one thing the report must not do.
  const sources = [
    {
      scope: 'machine',
      path: machine.path,
      exists: machine.exists,
      ok: errors.length === 0,
      note: 'machine-wide settings for every project on this computer.',
    },
  ];
  if (project.exists) {
    sources.push({
      scope: 'project',
      path: project.path,
      exists: true,
      note: 'this project only — overrides the machine settings.',
    });
  }
  for (const spec of ENV_VARS) {
    const set = Boolean(env[spec.name]);
    sources.push({
      scope: 'env',
      path: spec.name,
      exists: set,
      note: spec.secret && set ? `SET (value never shown) — ${spec.note}` : spec.note,
    });
  }

  // The machine side is reported from the VALIDATED block, not from the raw
  // file: a dropped target must not be printed as effective, a clamped timeout
  // must be printed clamped, and nothing unvalidated reaches the printer.
  const machineNotify = notifyBlock(validation.normalized?.notify);
  const projectNotify = notifyBlock(project.notify);

  // default < machine < project (env values are appended separately below).
  const values = new Map();
  for (const row of DEFAULT_VALUES) values.set(row.key, { key: row.key, value: row.value, origin: 'default' });
  for (const [origin, notify] of [
    ['machine', machineNotify],
    ['project', projectNotify],
  ]) {
    for (const row of notifyRows(notify)) {
      if (isAtomicRow(row.key)) continue; // resolved whole, per key, right below
      values.set(row.key, { key: row.key, value: row.value, origin });
    }
  }
  for (const name of ATOMIC_NOTIFY_KEYS) {
    const winner =
      projectNotify && projectNotify[name] !== undefined
        ? { origin: 'project', value: projectNotify[name] }
        : machineNotify && machineNotify[name] !== undefined
          ? { origin: 'machine', value: machineNotify[name] }
          : null;
    if (!winner) continue; // no source defines it — the code default stands
    values.delete(`notify.${name}`); // the winning source replaces the whole list
    for (const row of notifyRows({ [name]: winner.value }))
      values.set(row.key, { key: row.key, value: row.value, origin: winner.origin });
  }

  const list = [...values.values()];
  list.push({
    key: 'api.base',
    value: env.IMPACTUS_API || env.CREATE_IAI_API || COMMUNITY.apiBase,
    origin: env.IMPACTUS_API || env.CREATE_IAI_API ? 'env' : 'default',
  });
  list.push({
    key: 'auth.token',
    value: env.IMPACTUS_TOKEN || env.CREATE_IAI_TOKEN ? '(set)' : '(not set in the environment)',
    origin: env.IMPACTUS_TOKEN || env.CREATE_IAI_TOKEN ? 'env' : 'default',
  });
  list.push({
    key: 'update.check',
    value: env.PI_OFFLINE || env.IMP_SKIP_VERSION_CHECK ? 'skipped' : 'enabled',
    origin: env.PI_OFFLINE || env.IMP_SKIP_VERSION_CHECK ? 'env' : 'default',
  });

  return {
    ok: errors.length === 0,
    path: machine.path,
    exists: machine.exists,
    sources,
    values: list,
    errors,
    warnings,
  };
}

const ICONS = { ok: '✅', info: '○', warn: '⚠', error: '✖' };
const ORIGIN_TAG = {
  default: pc.dim('[default]'),
  machine: pc.cyan('[machine]'),
  project: pc.green('[project]'),
  env: pc.yellow('[env]'),
};

// Printed when the machine config does not exist yet — and when it exists but
// is invalid, which is exactly when a student needs to see a correct file. The
// whole file, ready to paste; notifications are the only thing it configures
// today.
function exampleBlock(path, { broken = false } = {}) {
  return [
    '',
    pc.bold(
      broken
        ? 'A valid machine config looks like this (yours is reported above):'
        : 'No machine config yet. To enable notifications, create it by hand:',
    ),
    pc.dim(`  file: ${path}`),
    '',
    '  {',
    '    "version": 1,',
    '    "notify": {',
    '      "enabled": true,',
    '      "events": ["run_end"],',
    '      "targets": [{ "kind": "slack", "url": "https://hooks.slack.com/services/…" }]',
    '    }',
    '  }',
    '',
    pc.dim('  Supported target kinds: webhook, slack, discord, telegram (telegram also needs "chat_id").'),
    pc.dim('  `imp settings` never writes this file — it is yours.'),
  ].join('\n');
}

/**
 * Entry point of `imp settings`.
 * @param {{json?: boolean, path?: boolean}} [flags]
 * @param {{home?: string, path?: string, cwd?: string, env?: object}} [opts] test seam only —
 *   the launcher calls `runSettings(flags)` and lets the real home/cwd/env win.
 * @returns {Promise<boolean>} true = nothing invalid (the launcher's exit code).
 */
export async function runSettings(flags = {}, opts = {}) {
  const report = await collectSettingsReport(opts);

  if (flags.path) {
    // Scriptable form (think `git rev-parse`): the path and nothing else.
    console.log(report.path);
    return true;
  }
  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
    return report.ok;
  }

  console.log(pc.bold('imp settings — machine configuration (read-only; nothing is written)'));
  console.log('');
  // A file that exists but does not validate is NOT a ✅: the marker follows
  // `ok`, so the first status line already says what the summary says.
  console.log(
    report.exists
      ? report.ok
        ? `${ICONS.ok} ${report.path}`
        : pc.red(`${ICONS.error} ${report.path} ${pc.dim('(has problems — defaults are in use; see below)')}`)
      : `${ICONS.info} ${report.path} ${pc.dim('(does not exist — defaults are in use)')}`,
  );

  console.log('');
  console.log(pc.bold(pc.cyan('Sources')));
  for (const source of report.sources) {
    const icon = source.exists ? (source.ok === false ? ICONS.error : ICONS.ok) : ICONS.info;
    const line = `  ${icon} ${pc.dim(`[${source.scope}]`)} ${source.path}`;
    console.log(source.exists ? line : pc.dim(line));
    console.log(pc.dim(`      ${source.note}`));
  }

  console.log('');
  console.log(pc.bold(pc.cyan('Effective values')));
  for (const row of report.values) {
    console.log(`  ${row.key} = ${String(row.value)} ${ORIGIN_TAG[row.origin] ?? ''}`);
  }

  for (const message of report.errors) console.log(pc.red(`\n${ICONS.error} ${message}`));
  for (const message of report.warnings) console.log(pc.yellow(`\n${ICONS.warn} ${message}`));

  if (!report.exists || !report.ok) console.log(exampleBlock(report.path, { broken: report.exists }));
  console.log('');
  console.log(
    report.ok
      ? pc.dim(
          'Values marked [default] come from the code — no file needed. Secrets are redacted, so this output is safe to paste.',
        )
      : pc.red('The machine config has problems — fix the file above; until then the defaults are used.'),
  );
  return report.ok;
}
