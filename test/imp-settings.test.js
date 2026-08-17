// `imp settings` — the machine config file (~/.impactus-cli/config.json): a
// reader that never throws, a validator that never turns a hand-edited file
// into a fatal error, and a report that never leaks a webhook url or a token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CONFIG_FILE,
  CONFIG_VERSION,
  configFilePath,
  configFilePathReadOnly,
  describeConfig,
  loadConfigFile,
  saveConfigFile,
  validateConfigData,
} from '../src/lib/config-file.js';
import { DEFAULT_VALUES, collectSettingsReport, runSettings } from '../src/steps/settings.js';
// The RUNTIME TWIN, imported by the TEST only: src/ never imports the stamped
// runtime (the duplication is deliberate), so this is where the two copies are
// held to the same rules.
import { NOTIFY_DEFAULTS, NOTIFY_EVENTS, notifyConfigOf } from '../fia-templates/modules/notify.mjs';

const SETTINGS_PATH = join(import.meta.dirname, '..', 'src', 'steps', 'settings.js');

const fakeHome = (prefix) => mkdtempSync(join(tmpdir(), `${prefix}-`));

test('configFilePath: lives inside the state dir of the given home', () => {
  const home = fakeHome('settings-home');
  const path = configFilePath(home);
  assert.equal(path, join(home, '.impactus-cli', CONFIG_FILE));
  assert.equal(CONFIG_FILE, 'config.json');
  assert.equal(CONFIG_VERSION, 1);
});

test('configFilePathReadOnly: a pre-rebrand state folder is read where it lies, never renamed', () => {
  const home = fakeHome('settings-legacy-path');
  mkdirSync(join(home, '.create-iai'), { recursive: true });
  writeFileSync(join(home, '.create-iai', CONFIG_FILE), JSON.stringify({ version: 1 }));

  assert.equal(configFilePathReadOnly(home), join(home, '.create-iai', CONFIG_FILE));
  assert.equal(existsSync(join(home, '.impactus-cli')), false, 'resolving a path must not create the new folder');
  assert.equal(existsSync(join(home, '.create-iai')), true, 'the legacy folder must stay where it is');

  // A legacy folder WITHOUT a config file gets the current name: that is the
  // only path the writer and the runtime notifier both use.
  const bare = fakeHome('settings-legacy-bare');
  mkdirSync(join(bare, '.create-iai'), { recursive: true });
  assert.equal(configFilePathReadOnly(bare), join(bare, '.impactus-cli', CONFIG_FILE));
  assert.equal(existsSync(join(bare, '.impactus-cli')), false);
  assert.equal(existsSync(join(bare, '.create-iai')), true);

  // The writer path is the one allowed to migrate — that difference is exactly
  // why the read-only resolver exists.
  assert.equal(configFilePath(home), join(home, '.impactus-cli', CONFIG_FILE));
  assert.equal(existsSync(join(home, '.create-iai')), false, 'the writer path migrates the legacy folder');
});

test('loadConfigFile({ readOnly: true }): reads the legacy folder without moving it', async () => {
  const home = fakeHome('settings-legacy-load');
  mkdirSync(join(home, '.create-iai'), { recursive: true });
  writeFileSync(join(home, '.create-iai', CONFIG_FILE), JSON.stringify({ version: 1, notify: { enabled: true } }));
  const res = await loadConfigFile({ home, readOnly: true });
  assert.equal(res.exists, true);
  assert.equal(res.data.notify.enabled, true);
  assert.equal(existsSync(join(home, '.impactus-cli')), false);
});

test('loadConfigFile: a missing file is not an error', async () => {
  const home = fakeHome('settings-missing');
  const res = await loadConfigFile({ home });
  assert.equal(res.exists, false);
  assert.deepEqual(res.data, {});
  assert.equal(res.error, null);
  assert.equal(res.path, configFilePath(home));
});

test('loadConfigFile: reads a valid file', async () => {
  const home = fakeHome('settings-valid');
  const path = configFilePath(home);
  mkdirSync(join(home, '.impactus-cli'), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, notify: { enabled: true } }));
  const res = await loadConfigFile({ home });
  assert.equal(res.exists, true);
  assert.equal(res.error, null);
  assert.equal(res.data.notify.enabled, true);
});

test('loadConfigFile: malformed JSON degrades to an English error, never a throw', async () => {
  const dir = fakeHome('settings-bad');
  const path = join(dir, 'config.json');
  writeFileSync(path, '{ "notify": { "url": "https://hooks.example.com/s3cr3t" ');
  const res = await loadConfigFile({ path });
  assert.equal(res.exists, true);
  assert.deepEqual(res.data, {});
  assert.match(res.error, /is not valid JSON/);
  // The parse message must never quote the offending source (tokens live there).
  assert.equal(res.error.includes('s3cr3t'), false);
});

test('loadConfigFile: a JSON array/scalar is reported, not accepted', async () => {
  const dir = fakeHome('settings-array');
  const path = join(dir, 'config.json');
  writeFileSync(path, '[1,2,3]');
  const res = await loadConfigFile({ path });
  assert.deepEqual(res.data, {});
  assert.match(res.error, /must contain a JSON object/);
});

test('saveConfigFile: creates the state dir and writes pretty JSON with a trailing newline', async () => {
  const home = fakeHome('settings-save');
  const { path } = await saveConfigFile({ version: 1, notify: { enabled: false } }, { home });
  assert.equal(path, configFilePath(home));
  const back = await loadConfigFile({ home });
  assert.equal(back.exists, true);
  assert.equal(back.data.notify.enabled, false);
  assert.equal(readFileSync(path, 'utf8'), JSON.stringify({ version: 1, notify: { enabled: false } }, null, 2) + '\n');
});

test(
  'saveConfigFile: file is 0600 inside a 0700 dir',
  { skip: process.platform === 'win32' ? 'POSIX permission bits do not exist on Windows' : false },
  async () => {
    const home = fakeHome('settings-modes');
    const { path } = await saveConfigFile({ version: 1 }, { home });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(home, '.impactus-cli')).mode & 0o777, 0o700);
  },
);

// ── The default table must never drift from the runtime ──────────────────────

test('DEFAULT_VALUES mirrors the runtime NOTIFY_DEFAULTS key by key', () => {
  const byKey = new Map(DEFAULT_VALUES.map((row) => [row.key, row.value]));
  for (const [key, value] of Object.entries(NOTIFY_DEFAULTS)) {
    assert.deepEqual(byKey.get(`notify.${key}`), value, `notify.${key} drifted from the runtime default`);
  }
  // No key on either side only: the report must show every default the runtime has.
  assert.deepEqual(
    [...byKey.keys()].sort(),
    Object.keys(NOTIFY_DEFAULTS)
      .map((key) => `notify.${key}`)
      .sort(),
  );
  // And what the runtime actually resolves for an empty config agrees too.
  const resolved = notifyConfigOf({});
  assert.equal(byKey.get('notify.timeout_ms'), resolved.timeout_ms);
  assert.deepEqual(byKey.get('notify.events'), resolved.events);
  assert.equal(byKey.get('notify.enabled'), resolved.enabled);
});

test('validateConfigData: a good notify block passes and normalizes', () => {
  const res = validateConfigData({
    notify: {
      enabled: true,
      events: ['run_end', ' gate_blocked '],
      timeout_ms: 2500,
      targets: [
        { kind: 'slack', url: 'https://hooks.slack.com/services/T/B/xyz' },
        { kind: 'telegram', url: 'https://api.telegram.org/bot123/sendMessage', chat_id: '-100' },
      ],
    },
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.warnings, []);
  assert.equal(res.normalized.version, CONFIG_VERSION);
  assert.deepEqual(res.normalized.notify.events, ['run_end', 'gate_blocked']);
  assert.equal(res.normalized.notify.targets.length, 2);
});

test('validateConfigData: an event the runtime drops is reported with the valid set', () => {
  const res = validateConfigData({ notify: { events: ['run_end', 'phase_end'] } });
  // The runtime drops the name with a WARNING and keeps notifying, so this is
  // not a reason to exit 1 — see the parity test below.
  assert.equal(res.ok, true);
  assert.equal(res.errors.length, 0);
  const said = [...res.errors, ...res.warnings].join('\n');
  assert.match(said, /"notify\.events\[1\]"/);
  for (const name of NOTIFY_EVENTS) assert.ok(said.includes(name), `the message must name ${name}`);
  // The dropped name never survives into the effective config.
  assert.deepEqual(res.normalized.notify.events, ['run_end']);
  assert.deepEqual(notifyConfigOf({ project: { events: ['run_end', 'phase_end'] } }).events, ['run_end']);
});

test('validateConfigData: events mirror the runtime normalizer on every input it degrades', () => {
  // The parity DOCS §14.6 promises is about behaviour, not only about key
  // names: for each of these the runtime keeps notifying (with a warning), so
  // the installer must report the same effective list and must NOT exit 1.
  const cases = [
    { events: ['nope'] }, // every name unknown → runtime falls back to the default
    { events: [] }, // nothing supplied → same fallback
    { events: 'run_end' }, // not a list at all → ignored by the runtime
    { events: ['run_end', 'nope'] }, // partially unknown → the bad one is dropped
    { events: ['run_end', 42] }, // a non-string entry is dropped too
  ];
  for (const notify of cases) {
    const label = JSON.stringify(notify);
    const installer = validateConfigData({ notify });
    const runtime = notifyConfigOf({ machine: notify });
    assert.deepEqual(installer.normalized.notify.events, runtime.events, `the effective events drifted for ${label}`);
    assert.equal(installer.ok, true, `${label} is not a reason to exit 1 — the runtime runs it`);
    assert.equal(installer.errors.length, 0, `${label} must not be reported as an error`);
    assert.ok(installer.warnings.length > 0, `${label} must still be reported as a warning`);
  }
  assert.deepEqual(
    validateConfigData({ notify: { events: ['nope'] } }).normalized.notify.events,
    NOTIFY_DEFAULTS.events,
  );
});

test('validateConfigData: http:// is refused unless the host is loopback (the runtime drops it)', () => {
  const remote = validateConfigData({
    notify: { enabled: true, targets: [{ kind: 'slack', url: 'http://hooks.slack.com/services/T/B/s3cr3t' }] },
  });
  assert.equal(remote.ok, false);
  assert.match(remote.errors[0], /"notify\.targets\[0\]\.url" uses http:\/\//);
  assert.match(remote.errors[0], /localhost/);
  assert.equal(JSON.stringify(remote).includes('s3cr3t'), false);
  assert.deepEqual(remote.normalized.notify.targets, []);
  // Exactly what the runtime does with the same input.
  const runtime = notifyConfigOf({
    project: { enabled: true, targets: [{ kind: 'slack', url: 'http://hooks.slack.com/services/T/B/s3cr3t' }] },
  });
  assert.equal(runtime.enabled, false);
  assert.equal(runtime.targets.length, 0);

  for (const url of ['http://localhost:3000/hook', 'http://127.0.0.1:3000/hook']) {
    const local = validateConfigData({ notify: { targets: [{ kind: 'webhook', url }] } });
    assert.equal(local.ok, true, `${url} is the local test loop and must stay valid`);
    assert.equal(local.normalized.notify.targets.length, 1);
  }
});

test('validateConfigData: a timeout outside the runtime clamp is reported as clamped, not as effective', () => {
  const high = validateConfigData({ notify: { timeout_ms: 999999 } });
  assert.equal(high.ok, true);
  assert.match(high.warnings[0], /outside \[500, 20000\]/);
  assert.match(high.warnings[0], /clamps it to 20000ms/);
  assert.equal(high.normalized.notify.timeout_ms, 20000);
  assert.equal(notifyConfigOf({ project: { timeout_ms: 999999 } }).timeout_ms, 20000);

  const low = validateConfigData({ notify: { timeout_ms: 10 } });
  assert.equal(low.ok, true);
  assert.equal(low.normalized.notify.timeout_ms, 500);
  assert.equal(notifyConfigOf({ project: { timeout_ms: 10 } }).timeout_ms, 500);
});

test('validateConfigData: an absent key is never required — an empty object is valid', () => {
  const res = validateConfigData({});
  assert.equal(res.ok, true);
  assert.deepEqual(res.errors, []);
  assert.equal(res.normalized.version, CONFIG_VERSION);
  assert.equal(res.normalized.notify, undefined);
});

test('validateConfigData: an unknown top-level key warns and is kept, never fatal', () => {
  const res = validateConfigData({ theme: 'dark', notify: { enabled: true } });
  assert.equal(res.ok, true);
  assert.equal(res.errors.length, 0);
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0], /Unknown setting "theme"/);
  assert.equal(res.normalized.theme, 'dark');
});

test('validateConfigData: a newer version warns; a non-numeric version errors', () => {
  assert.match(validateConfigData({ version: 99 }).warnings[0], /newer version/);
  const bad = validateConfigData({ version: 'one' });
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /"version" must be a number/);
});

test('validateConfigData: a bad target kind errors and the target is dropped', () => {
  const res = validateConfigData({
    notify: { targets: [{ kind: 'carrier-pigeon', url: 'https://hooks.example.com/abc' }] },
  });
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /notify\.targets\[0\]\.kind/);
  assert.match(res.errors[0], /webhook, slack, discord, telegram/);
  assert.deepEqual(res.normalized.notify.targets, []);
});

test('validateConfigData: non-array events / non-array targets / non-object notify all error', () => {
  // events is the exception: the runtime ignores a non-list and uses its
  // default instead of refusing, so this side warns rather than errors.
  const events = validateConfigData({ notify: { events: 'run_end' } });
  assert.equal(events.ok, true);
  assert.match(events.warnings[0], /"notify\.events" must be an array/);
  assert.match(validateConfigData({ notify: { targets: {} } }).errors[0], /"notify\.targets" must be an array/);
  assert.match(validateConfigData({ notify: [] }).errors[0], /"notify" must be an object/);
  assert.match(validateConfigData({ notify: { enabled: 'yes' } }).errors[0], /must be true or false/);
  assert.match(validateConfigData({ notify: { timeout_ms: -1 } }).errors[0], /positive number/);
  assert.match(validateConfigData(null).errors[0], /must be a JSON object/);
});

test('validateConfigData: a missing url errors without echoing anything, and events entries are indexed', () => {
  const res = validateConfigData({ notify: { events: ['run_end', 42], targets: [{ kind: 'slack' }] } });
  assert.equal(res.ok, false);
  assert.match(res.warnings.join('\n'), /"notify\.events\[1\]" is not a non-empty event name/);
  assert.match(res.errors.join('\n'), /"notify\.targets\[0\]\.url" must be an http\(s\) URL/);
  assert.deepEqual(res.normalized.notify.events, ['run_end']);
});

test('validateConfigData: a telegram target without chat_id warns (delivery would fail) but stays valid', () => {
  const res = validateConfigData({ notify: { targets: [{ kind: 'telegram', url: 'https://api.telegram.org/botX' }] } });
  assert.equal(res.ok, true);
  assert.match(res.warnings[0], /without "chat_id"/);
});

test('validateConfigData: no message ever contains a token or a full url', () => {
  const res = validateConfigData({
    notify: {
      events: 'nope',
      targets: [
        { kind: 'not-a-kind', url: 'https://hooks.example.com/s3cr3t', chat_id: 's3cr3t-chat' },
        { kind: 'slack', url: 'ftp://hooks.example.com/s3cr3t' },
      ],
    },
  });
  assert.equal(res.ok, false);
  // The whole serialized report — errors, warnings AND normalized: an invalid
  // target is dropped, so its url never survives into the output either.
  const serialized = JSON.stringify(res);
  assert.equal(serialized.includes('s3cr3t'), false);
  assert.equal(serialized.includes('hooks.example.com'), false);
});

test('describeConfig: dotted keys, urls reduced to the host, other secrets to (set)', () => {
  const rows = describeConfig({
    version: 1,
    notify: {
      enabled: true,
      events: ['run_end'],
      targets: [{ kind: 'slack', url: 'https://hooks.slack.com/services/T/B/s3cr3t', chat_id: 12345 }],
      api_key: 's3cr3t-key',
    },
  });
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  assert.equal(byKey['version'], 1);
  assert.equal(byKey['notify.enabled'], true);
  assert.equal(byKey['notify.events[0]'], 'run_end');
  assert.equal(byKey['notify.targets[0].kind'], 'slack');
  assert.equal(byKey['notify.targets[0].url'], 'hooks.slack.com (path hidden)');
  assert.equal(byKey['notify.targets[0].chat_id'], '(set)');
  assert.equal(byKey['notify.api_key'], '(set)');
  assert.equal(JSON.stringify(rows).includes('s3cr3t'), false);
  const redacted = rows.filter((r) => r.note);
  assert.ok(redacted.length >= 3);
  assert.match(redacted[0].note, /redacted/);
});

test('describeConfig: a url is redacted by VALUE, whatever the key is called', () => {
  const rows = describeConfig({
    notify: {
      webhook_uri: 'https://hooks.slack.com/services/T/B/s3cr3t',
      targets: [
        { kind: 'slack', url: 'https://hooks.slack.com/services/T/B/s3cr3t', label: 'https://x.example.com/s3cr3t' },
      ],
    },
  });
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  assert.equal(byKey['notify.webhook_uri'], 'hooks.slack.com (path hidden)');
  // Inside a target every field but "kind" is a secret by default.
  assert.equal(byKey['notify.targets[0].kind'], 'slack');
  assert.equal(byKey['notify.targets[0].label'], 'x.example.com (path hidden)');
  assert.equal(JSON.stringify(rows).includes('s3cr3t'), false);
  assert.match(rows.find((r) => r.key === 'notify.webhook_uri').note, /redacted/);
});

test('describeConfig: an empty list is still shown as a key', () => {
  const rows = describeConfig({ notify: { events: [], targets: [] } });
  assert.deepEqual(
    rows.map((r) => [r.key, r.value]),
    [
      ['notify.events', '(empty list)'],
      ['notify.targets', '(empty list)'],
    ],
  );
});

// ── The report ───────────────────────────────────────────────────────────────

function project(root, yamlBody) {
  mkdirSync(join(root, 'imp'), { recursive: true });
  writeFileSync(join(root, 'imp', 'fia.config.yaml'), yamlBody);
  return root;
}

test('collectSettingsReport: no file anywhere → defaults only, ok, and the machine source is listed', async () => {
  const home = fakeHome('settings-report-empty');
  const cwd = fakeHome('settings-report-cwd');
  const report = await collectSettingsReport({ home, cwd, env: {} });
  assert.equal(report.ok, true);
  assert.equal(report.exists, false);
  assert.equal(report.path, configFilePath(home));
  assert.deepEqual(
    report.sources.filter((s) => s.scope === 'machine').map((s) => s.exists),
    [false],
  );
  assert.equal(
    report.sources.some((s) => s.scope === 'project'),
    false,
  );
  assert.ok(report.sources.filter((s) => s.scope === 'env').length >= 4);
  const byKey = Object.fromEntries(report.values.map((v) => [v.key, v]));
  assert.equal(byKey['notify.enabled'].value, false);
  assert.equal(byKey['notify.enabled'].origin, 'default');
  assert.equal(byKey['notify.timeout_ms'].origin, 'default');
  assert.equal(byKey['notify.timeout_ms'].value, NOTIFY_DEFAULTS.timeout_ms);
  assert.deepEqual(byKey['notify.events'].value, NOTIFY_DEFAULTS.events);
  assert.equal(byKey['notify.events'].origin, 'default');
  assert.equal(byKey['api.base'].origin, 'default');
  assert.equal(byKey['auth.token'].value, '(not set in the environment)');
  assert.equal(byKey['update.check'].value, 'enabled');
});

test('collectSettingsReport: the project YAML overrides the machine file and the origin says so', async () => {
  const home = fakeHome('settings-merge-home');
  const cwd = project(
    fakeHome('settings-merge-cwd'),
    ['defaults:', '  coding_agent: pi', 'notify:', '  enabled: false', '  timeout_ms: 9000', ''].join('\n'),
  );
  await saveConfigFile(
    {
      version: 1,
      notify: {
        enabled: true,
        timeout_ms: 1000,
        targets: [{ kind: 'slack', url: 'https://hooks.slack.com/services/T/B/s3cr3t' }],
      },
    },
    { home },
  );
  const report = await collectSettingsReport({ home, cwd, env: {} });
  assert.equal(report.ok, true);
  assert.equal(report.exists, true);
  const byKey = Object.fromEntries(report.values.map((v) => [v.key, v]));
  assert.equal(byKey['notify.enabled'].value, false);
  assert.equal(byKey['notify.enabled'].origin, 'project');
  assert.equal(byKey['notify.timeout_ms'].value, 9000);
  assert.equal(byKey['notify.timeout_ms'].origin, 'project');
  assert.equal(byKey['notify.targets[0].kind'].origin, 'machine');
  assert.equal(byKey['notify.targets[0].url'].value, 'hooks.slack.com (path hidden)');
  assert.equal(JSON.stringify(report).includes('s3cr3t'), false);
  assert.equal(
    report.sources.some((s) => s.scope === 'project' && s.exists),
    true,
  );
});

test('collectSettingsReport: a notify block nested under observability is NOT honoured, and is named', async () => {
  const home = fakeHome('settings-obs-home');
  const cwd = project(
    fakeHome('settings-obs-cwd'),
    ['observability:', '  db: imp/data/fia.db', '  notify:', '    enabled: true', ''].join('\n'),
  );
  const report = await collectSettingsReport({ home, cwd, env: {} });
  const row = report.values.find((v) => v.key === 'notify.enabled');
  // The runtime reads the top-level key only, so this block is dead config.
  assert.equal(row.value, false);
  assert.equal(row.origin, 'default');
  assert.equal(report.ok, true);
  assert.match(report.warnings.join('\n'), /"observability\.notify" is ignored/);
  assert.match(report.warnings.join('\n'), /top-level "notify" key/);
  // The runtime agrees: nothing from that nesting reaches it.
  assert.equal(notifyConfigOf({ project: null }).enabled, false);
});

test('collectSettingsReport: list-valued notify keys are atomic — the winning source replaces the whole list', async () => {
  const home = fakeHome('settings-atomic-home');
  const cwd = project(
    fakeHome('settings-atomic-cwd'),
    [
      'notify:',
      '  enabled: true',
      '  events: [decision_needed]',
      '  targets:',
      "    - { kind: slack, url: 'https://hooks.slack.com/services/T/B/proj' }",
      '',
    ].join('\n'),
  );
  const machineNotify = {
    enabled: true,
    events: ['run_end', 'gate_blocked'],
    targets: [
      { kind: 'discord', url: 'https://discord.com/api/webhooks/1/mach' },
      { kind: 'telegram', url: 'https://api.telegram.org/bot1/sendMessage', chat_id: '-100' },
    ],
  };
  await saveConfigFile({ version: 1, notify: machineNotify }, { home });
  const report = await collectSettingsReport({ home, cwd, env: {} });

  const keys = report.values.map((v) => v.key);
  // The project list wins WHOLE: one target, one event, no machine leftovers.
  assert.deepEqual(
    report.values.filter((v) => v.key.startsWith('notify.events')).map((v) => [v.key, v.value, v.origin]),
    [['notify.events[0]', 'decision_needed', 'project']],
  );
  assert.equal(keys.includes('notify.targets[1].kind'), false);
  assert.equal(report.values.find((v) => v.key === 'notify.targets[0].kind').value, 'slack');
  assert.equal(report.values.find((v) => v.key === 'notify.targets[0].kind').origin, 'project');
  assert.equal(
    report.values.some((v) => v.origin === 'machine' && v.key.startsWith('notify.targets')),
    false,
  );

  // Exactly what the runtime resolves from the same two sources.
  const resolved = notifyConfigOf({
    project: {
      enabled: true,
      events: ['decision_needed'],
      targets: [{ kind: 'slack', url: 'https://hooks.slack.com/services/T/B/proj' }],
    },
    machine: machineNotify,
  });
  assert.deepEqual(resolved.events, ['decision_needed']);
  assert.deepEqual(
    resolved.targets.map((t) => t.kind),
    ['slack'],
  );
});

test('collectSettingsReport: a malformed project YAML is a warning, ok stays true', async () => {
  const home = fakeHome('settings-badyaml-home');
  const cwd = project(fakeHome('settings-badyaml-cwd'), 'notify:\n  enabled: true\n : : broken\n\t- x\n');
  const report = await collectSettingsReport({ home, cwd, env: {} });
  assert.equal(report.ok, true);
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /imp\/fia\.config\.yaml/);
  assert.equal(report.values.find((v) => v.key === 'notify.enabled').origin, 'default');
});

test('collectSettingsReport: an invalid machine file makes ok false and reports the error', async () => {
  const dir = fakeHome('settings-invalid');
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ notify: { enabled: 'maybe' } }));
  const report = await collectSettingsReport({ path, cwd: dir, env: {} });
  assert.equal(report.ok, false);
  assert.equal(report.exists, true);
  assert.match(report.errors[0], /must be true or false/);
  // The machine SOURCE carries the verdict too, so the printer can mark it ✖.
  assert.equal(report.sources.find((s) => s.scope === 'machine').ok, false);
});

test('collectSettingsReport: the machine source is ok when the file is valid', async () => {
  const home = fakeHome('settings-source-ok');
  const cwd = fakeHome('settings-source-ok-cwd');
  await saveConfigFile({ version: 1, notify: { enabled: false } }, { home });
  const report = await collectSettingsReport({ home, cwd, env: {} });
  assert.equal(report.sources.find((s) => s.scope === 'machine').ok, true);
});

test('collectSettingsReport: reading the report never migrates the pre-rebrand state folder', async () => {
  const home = fakeHome('settings-legacy-report');
  const cwd = fakeHome('settings-legacy-report-cwd');
  mkdirSync(join(home, '.create-iai'), { recursive: true });
  writeFileSync(join(home, '.create-iai', CONFIG_FILE), JSON.stringify({ version: 1, notify: { enabled: true } }));
  const report = await collectSettingsReport({ home, cwd, env: {} });
  assert.equal(report.exists, true);
  assert.equal(report.path, join(home, '.create-iai', CONFIG_FILE));
  assert.equal(report.values.find((v) => v.key === 'notify.enabled').origin, 'machine');
  assert.equal(existsSync(join(home, '.impactus-cli')), false, '`imp settings` must not move a folder in $HOME');
  assert.equal(existsSync(join(home, '.create-iai')), true);
});

test('collectSettingsReport: env vars are reported as origin env, and the token only as SET', async () => {
  const home = fakeHome('settings-env-home');
  const cwd = fakeHome('settings-env-cwd');
  const report = await collectSettingsReport({
    home,
    cwd,
    env: { IMPACTUS_API: 'https://dev.example.convex.site', IMPACTUS_TOKEN: 's3cr3t-token', PI_OFFLINE: '1' },
  });
  const byKey = Object.fromEntries(report.values.map((v) => [v.key, v]));
  assert.equal(byKey['api.base'].value, 'https://dev.example.convex.site');
  assert.equal(byKey['api.base'].origin, 'env');
  assert.equal(byKey['auth.token'].value, '(set)');
  assert.equal(byKey['auth.token'].origin, 'env');
  assert.equal(byKey['update.check'].value, 'skipped');
  assert.equal(byKey['update.check'].origin, 'env');
  assert.equal(JSON.stringify(report).includes('s3cr3t-token'), false);
});

// ── The command ──────────────────────────────────────────────────────────────

async function capture(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const value = await fn();
    return { value, out: lines.join('\n') };
  } finally {
    console.log = original;
  }
}

test('runSettings({ json: true }): prints pure parseable JSON and nothing else', async () => {
  const home = fakeHome('settings-json-home');
  const cwd = fakeHome('settings-json-cwd');
  const { value, out } = await capture(() => runSettings({ json: true }, { home, cwd, env: {} }));
  assert.equal(value, true);
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.exists, false);
  assert.equal(parsed.path, configFilePath(home));
  assert.ok(Array.isArray(parsed.sources) && Array.isArray(parsed.values));
  assert.deepEqual(parsed.errors, []);
});

test('runSettings({ path: true }): prints only the path and returns true even when invalid', async () => {
  const dir = fakeHome('settings-pathflag');
  const path = join(dir, 'config.json');
  writeFileSync(path, 'not json at all');
  const { value, out } = await capture(() => runSettings({ path: true }, { path, cwd: dir, env: {} }));
  assert.equal(value, true);
  assert.equal(out, path);
});

test('runSettings(): the human report shows the sources, the origins and the how-to block', async () => {
  const home = fakeHome('settings-human-home');
  const cwd = fakeHome('settings-human-cwd');
  const { value, out } = await capture(() => runSettings({}, { home, cwd, env: {} }));
  assert.equal(value, true);
  assert.match(out, /machine configuration \(read-only/);
  assert.match(out, /notify\.enabled = false/);
  assert.match(out, /\[default\]/);
  assert.match(out, /No machine config yet/);
  assert.match(out, /"kind": "slack"/);
});

test('runSettings(): a token pasted under an UNKNOWN key never reaches the output it calls safe to paste', async () => {
  const home = fakeHome('settings-typo-home');
  const cwd = fakeHome('settings-typo-cwd');
  // The likeliest typo: the webhook under a misspelled key, with no targets at
  // all. The key name gives redaction no hint — the VALUE has to give it one.
  await saveConfigFile(
    { version: 1, notify: { enabled: true, webhook_uri: 'https://hooks.slack.com/services/T/B/s3cr3t-token' } },
    { home },
  );
  const human = await capture(() => runSettings({}, { home, cwd, env: {} }));
  assert.equal(human.out.includes('s3cr3t-token'), false);
  assert.match(human.out, /hooks\.slack\.com \(path hidden\)/);
  const json = await capture(() => runSettings({ json: true }, { home, cwd, env: {} }));
  assert.equal(json.out.includes('s3cr3t-token'), false);
  assert.equal(JSON.parse(json.out).ok, true);
});

test('runSettings(): an invalid file prints the error and returns false', async () => {
  const dir = fakeHome('settings-human-bad');
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ notify: { targets: 'nope' } }));
  const { value, out } = await capture(() => runSettings({}, { path, cwd: dir, env: {} }));
  assert.equal(value, false);
  assert.match(out, /must be an array of targets/);
});

test('runSettings(): a file that exists but is invalid is marked ✖ and gets the example block', async () => {
  // Both flavours of "broken": unparseable, and parseable with a bad value.
  for (const [name, body] of [
    ['trailing comma', '{ "notify": { "enabled": true, "events": ["run_end"], } }'],
    ['bad value', JSON.stringify({ notify: { enabled: 'yes' } })],
  ]) {
    const dir = fakeHome('settings-broken-marker');
    const path = join(dir, 'config.json');
    writeFileSync(path, body);
    const { value, out } = await capture(() => runSettings({}, { path, cwd: dir, env: {} }));
    assert.equal(value, false, `${name}: the exit code must say it is broken`);
    const withPath = out.split('\n').filter((line) => line.includes(path));
    assert.match(withPath[0], /✖/, `${name}: the first status line must not be green`);
    assert.equal(withPath[0].includes('✅'), false, `${name}: the first status line must not be green`);
    assert.match(withPath[1], /✖/, `${name}: the Sources row must agree with the summary`);
    // The one state where a correct file is most needed is the one that had it hidden.
    assert.match(out, /A valid machine config looks like this/, `${name}: the example must be shown`);
    assert.match(out, /"kind": "slack"/, `${name}: the example must be the whole file`);
  }
});

test('runSettings({ path: true }): printing the path leaves the pre-rebrand folder where it is', async () => {
  const home = fakeHome('settings-legacy-pathflag');
  const cwd = fakeHome('settings-legacy-pathflag-cwd');
  mkdirSync(join(home, '.create-iai'), { recursive: true });
  writeFileSync(join(home, '.create-iai', CONFIG_FILE), '{}');
  const { value, out } = await capture(() => runSettings({ path: true }, { home, cwd, env: {} }));
  assert.equal(value, true);
  assert.equal(out, join(home, '.create-iai', CONFIG_FILE));
  assert.equal(existsSync(join(home, '.impactus-cli')), false, '--path must not move a folder in $HOME');
});

// Child process: pins the exit codes the launcher maps from the boolean and
// proves the --json payload survives a real process boundary.
function runChild(home, extraFlag) {
  const driver = [
    `const { runSettings } = await import(${JSON.stringify(pathToFileURL(SETTINGS_PATH).href)});`,
    `const ok = await runSettings({ json: ${extraFlag === '--json'} }, { home: ${JSON.stringify(home)}, cwd: ${JSON.stringify(home)}, env: {} });`,
    'process.exit(ok ? 0 : 1);',
  ].join('\n');
  try {
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', driver], { encoding: 'utf8' });
    return { status: 0, stdout };
  } catch (err) {
    return { status: err.status, stdout: String(err.stdout || '') };
  }
}

test('child process: exit 0 with a valid config, exit 1 with a broken one, --json stays parseable', async () => {
  const good = fakeHome('settings-child-good');
  await saveConfigFile({ version: 1, notify: { enabled: true, targets: [] } }, { home: good });
  const okRun = runChild(good, '--json');
  assert.equal(okRun.status, 0);
  const parsed = JSON.parse(okRun.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.exists, true);

  const bad = fakeHome('settings-child-bad');
  mkdirSync(join(bad, '.impactus-cli'), { recursive: true });
  writeFileSync(configFilePath(bad), '{ broken');
  const badRun = runChild(bad, '--json');
  assert.equal(badRun.status, 1);
  assert.match(JSON.parse(badRun.stdout).errors[0], /is not valid JSON/);
});

test('runtime-health: its template trees cannot drift from the installer’s', async () => {
  // src/lib/runtime-health.js re-derives the template trees instead of importing
  // src/steps/update-runtime.js, because the launcher must not pull the
  // installer's prompt layer in for a guard. This is the guard on that copy.
  const { runtimeTrees } = await import('../src/lib/runtime-health.js');
  const { templateTrees } = await import('../src/steps/update-runtime.js');
  assert.deepEqual(runtimeTrees(), templateTrees(), 'runtime-health and update-runtime must walk the same trees');
});
