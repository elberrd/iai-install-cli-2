import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NOTIFY_DEFAULTS,
  NOTIFY_EMITTED_EVENTS,
  NOTIFY_EVENTS,
  buildNotification,
  machineConfigPath,
  notifyConfigOf,
  notifyRunEnd,
  readMachineNotify,
  sendNotification,
  targetRequest,
} from '../fia-templates/modules/notify.mjs';
import {
  enableSnippet,
  notifyStatusJson,
  readProjectNotify,
  renderNotifyStatus,
  renderTestResult,
  reservedEventsNote,
  resolveNotify,
  runNotifyTest,
} from '../fia-templates/scripts/notify.mjs';

// Isolate the process home BEFORE any test runs: readMachineNotify() falls back
// to homedir(), so a call that forgets the `home` seam would otherwise read the
// developer's real ~/.impactus-cli/config.json — and on a machine with
// notifications ON that means the suite fires a live webhook. Repo convention,
// see test/keys.test.js. Every call below still passes its own seam; this is the
// second line of defence.
const PROCESS_HOME = mkdtempSync(join(tmpdir(), 'fia-notify-process-home-'));
process.env.HOME = PROCESS_HOME;
process.env.USERPROFILE = PROCESS_HOME; // Windows homedir()

const SCRIPT = join(import.meta.dirname, '..', 'fia-templates', 'scripts', 'notify.mjs');

// The one secret used across the whole file: it must never reach a warning, a
// rendered line or the --json output. Only the HOST may ever be printed.
const TOKEN = 's3cr3t-token';
const SLACK_URL = `https://hooks.slack.com/services/T1/B2/${TOKEN}`;
const TELEGRAM_URL = `https://api.telegram.org/bot${TOKEN}`;

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

/** A fake home with a machine config. `notify` is written verbatim. */
function fakeHome(json) {
  const home = tmpDir('fia-notify-home');
  mkdirSync(join(home, '.impactus-cli'), { recursive: true });
  writeFileSync(machineConfigPath(home), typeof json === 'string' ? json : JSON.stringify(json, null, 2));
  return home;
}

/** Records every call; never touches the network. */
function fetchSpy(reply = { ok: true, status: 200 }) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (typeof reply === 'function') return reply(url, init);
    return reply;
  };
  impl.calls = calls;
  return impl;
}

// ── defaults ─────────────────────────────────────────────────────────────────

test('nothing configured anywhere: notifications resolve off with zero targets', async () => {
  const config = notifyConfigOf();
  assert.equal(config.enabled, false);
  assert.deepEqual(config.targets, []);
  assert.deepEqual(config.events, ['run_end']);
  assert.equal(config.timeout_ms, NOTIFY_DEFAULTS.timeout_ms);
  assert.ok(
    config.warnings.some((w) => /notifications are off/.test(w)),
    'the off reason is reported',
  );

  const spy = fetchSpy();
  const send = await sendNotification(config, buildNotification({ event: 'run_end' }), { fetchImpl: spy });
  assert.deepEqual(
    { attempted: send.attempted, delivered: send.delivered, failures: send.failures },
    {
      attempted: 0,
      delivered: 0,
      failures: [],
    },
  );
  assert.equal(spy.calls.length, 0, 'nothing is ever sent while notifications are off');
});

test('NOTIFY_DEFAULTS and NOTIFY_EVENTS are frozen', () => {
  assert.ok(Object.isFrozen(NOTIFY_DEFAULTS) && Object.isFrozen(NOTIFY_EVENTS));
  assert.equal(NOTIFY_DEFAULTS.enabled, false);
  assert.deepEqual([...NOTIFY_EVENTS], ['run_end', 'gate_blocked', 'decision_needed']);
});

test('NOTIFY_EMITTED_EVENTS names the only event a run emits today', () => {
  assert.ok(Object.isFrozen(NOTIFY_EMITTED_EVENTS));
  assert.deepEqual([...NOTIFY_EMITTED_EVENTS], ['run_end'], 'announceRunEnd is the only producer in the runtime');
  for (const event of NOTIFY_EMITTED_EVENTS) {
    assert.ok(NOTIFY_EVENTS.includes(event), `${event} must also be a valid config value`);
  }
  // The reserved names stay in the vocabulary on purpose: the config accepts
  // them and `--test` can send them, they are just never produced by a run.
  assert.deepEqual(
    NOTIFY_EVENTS.filter((event) => !NOTIFY_EMITTED_EVENTS.includes(event)),
    ['gate_blocked', 'decision_needed'],
  );
});

// ── machine config ───────────────────────────────────────────────────────────

test('machine config is read from an overridden home', () => {
  const home = fakeHome({ notify: { enabled: true, targets: [{ kind: 'slack', url: SLACK_URL }] } });
  const read = readMachineNotify(home);
  assert.equal(read.exists, true);
  assert.equal(read.error, null);
  assert.equal(read.data.enabled, true);
  assert.equal(machineConfigPath(home), join(home, '.impactus-cli', 'config.json'));

  const config = notifyConfigOf({ machine: read.data });
  assert.equal(config.enabled, true);
  assert.equal(config.targets.length, 1);
  assert.equal(config.targets[0].host, 'hooks.slack.com');
});

test('a missing machine config is not an error', () => {
  const read = readMachineNotify(tmpDir('fia-notify-empty'));
  assert.deepEqual(
    { data: read.data, exists: read.exists, error: read.error },
    {
      data: null,
      exists: false,
      error: null,
    },
  );
});

test('a malformed machine config degrades to an error that leaks nothing', () => {
  const home = fakeHome(`{ "notify": { "targets": [ { "url": "${SLACK_URL}" `);
  const read = readMachineNotify(home);
  assert.equal(read.data, null);
  assert.equal(read.exists, true);
  assert.match(read.error, /not valid JSON/);
  assert.equal(read.error.includes(TOKEN), false, 'the parser message is never interpolated');
  // And it still resolves to a usable, off config.
  assert.equal(notifyConfigOf({ machine: read.data }).enabled, false);
});

test('a notify key that is not an object is ignored, not fatal', () => {
  const home = fakeHome({ notify: 'yes please' });
  const read = readMachineNotify(home);
  assert.equal(read.data, null);
  assert.match(read.error, /must be an object/);
});

// ── merging + validation ─────────────────────────────────────────────────────

test('the project config wins per key over the machine config', () => {
  const machine = {
    enabled: true,
    events: ['run_end'],
    timeout_ms: 9000,
    targets: [{ kind: 'slack', url: SLACK_URL }],
  };
  const project = {
    events: ['gate_blocked'],
    targets: [{ kind: 'discord', url: 'https://discord.com/api/webhooks/1/2' }],
  };
  const config = notifyConfigOf({ project, machine });
  assert.equal(config.enabled, true, 'enabled still comes from the machine config');
  assert.deepEqual(config.events, ['gate_blocked']);
  assert.equal(config.targets.length, 1);
  assert.equal(config.targets[0].kind, 'discord');
  assert.equal(config.timeout_ms, 9000, 'a key the project does not set keeps the machine value');
});

test('enabled:true with no valid target stays off, with the reason', () => {
  const config = notifyConfigOf({ machine: { enabled: true, targets: [] } });
  assert.equal(config.enabled, false);
  assert.ok(config.warnings.some((w) => /no valid target remains/.test(w)));
});

test('an unknown event is dropped and an empty list falls back to the default', () => {
  const withUnknown = notifyConfigOf({ machine: { events: ['run_end', 'run_started'] } });
  assert.deepEqual(withUnknown.events, ['run_end']);
  assert.ok(withUnknown.warnings.some((w) => /"run_started" is not known/.test(w)));
  assert.deepEqual(notifyConfigOf({ machine: { events: [] } }).events, ['run_end']);
  assert.deepEqual(notifyConfigOf({ machine: { events: 'run_end' } }).events, ['run_end']);
});

test('http:// is rejected while http://localhost is accepted', () => {
  const config = notifyConfigOf({
    machine: {
      enabled: true,
      targets: [
        { kind: 'webhook', url: `http://example.com/hooks/${TOKEN}` },
        { kind: 'webhook', url: 'http://localhost:5055/hook' },
        { kind: 'webhook', url: 'http://127.0.0.1:5055/hook' },
      ],
    },
  });
  assert.equal(config.targets.length, 2);
  assert.deepEqual(
    config.targets.map((t) => t.host),
    ['localhost:5055', '127.0.0.1:5055'],
  );
  const warning = config.warnings.find((w) => /only https:\/\/ is accepted/.test(w));
  assert.ok(warning, 'the rejection is reported');
  assert.match(warning, /example\.com/, 'the target is named by host');
  assert.equal(warning.includes(TOKEN), false);
});

test('a telegram target without chat_id is dropped, with chat_id it is kept', () => {
  const off = notifyConfigOf({ machine: { enabled: true, targets: [{ kind: 'telegram', url: TELEGRAM_URL }] } });
  assert.equal(off.targets.length, 0);
  assert.equal(off.enabled, false);
  const warning = off.warnings.find((w) => /chat_id/.test(w));
  assert.ok(warning);
  assert.equal(warning.includes(TOKEN), false);

  const on = notifyConfigOf({
    machine: { enabled: true, targets: [{ kind: 'telegram', url: TELEGRAM_URL, chat_id: 4242 }] },
  });
  assert.equal(on.targets.length, 1);
  assert.equal(on.targets[0].chat_id, '4242', 'a numeric chat_id becomes a string');
});

test('a malformed target never aborts the resolution', () => {
  const config = notifyConfigOf({
    machine: {
      enabled: true,
      targets: [
        null,
        'https://nope',
        { kind: 'slack' },
        { kind: 'slack', url: 'not a url' },
        { kind: 'slack', url: SLACK_URL },
      ],
    },
  });
  assert.equal(config.targets.length, 1);
  assert.equal(config.enabled, true);
  assert.equal(config.warnings.length >= 4, true);
});

test('timeout_ms is clamped to [500, 20000]', () => {
  assert.equal(notifyConfigOf({ machine: { timeout_ms: 10 } }).timeout_ms, 500);
  assert.equal(notifyConfigOf({ machine: { timeout_ms: 999999 } }).timeout_ms, 20000);
  assert.equal(notifyConfigOf({ machine: { timeout_ms: 7500 } }).timeout_ms, 7500);
  assert.equal(notifyConfigOf({ machine: { timeout_ms: 'soon' } }).timeout_ms, NOTIFY_DEFAULTS.timeout_ms);
  assert.equal(notifyConfigOf({}).timeout_ms, NOTIFY_DEFAULTS.timeout_ms);
  assert.ok(notifyConfigOf({ machine: { timeout_ms: 10 } }).warnings.some((w) => /clamped to 500ms/.test(w)));
});

test('a secret smuggled into the kind field is never echoed back', () => {
  const config = notifyConfigOf({ machine: { enabled: true, targets: [{ kind: SLACK_URL, url: SLACK_URL }] } });
  assert.equal(config.targets.length, 0);
  const joined = config.warnings.join('\n');
  assert.equal(joined.includes(TOKEN), false);
  assert.match(joined, /\(unreadable value\)/);
});

// ── the notification ─────────────────────────────────────────────────────────

test('buildNotification renders a full run_end notification', () => {
  const n = buildNotification({
    event: 'run_end',
    fdaId: 'r_abc12',
    fdaName: 'goal',
    project: 'my-app',
    outcome: 'goal met',
    reason: 'acceptance checklist complete',
    accepted: true,
    tokens: 1234567,
    cost: 1.2345,
    durationSeconds: 754,
    phase: 'review',
  });
  assert.equal(n.event, 'run_end');
  assert.equal(n.title, 'IMPACTUS · my-app · run r_abc12 ended: goal met');
  assert.match(n.text, /^FDA: goal$/m);
  assert.match(n.text, /^Phase: review$/m);
  assert.match(n.text, /^Accepted: yes$/m);
  assert.match(n.text, /^Reason: acceptance checklist complete$/m);
  assert.match(n.text, /^Tokens: 1,234,567$/m);
  assert.match(n.text, /^Cost: \$1\.23$/m);
  assert.match(n.text, /^Duration: 12m 34s$/m);
  assert.equal(n.payload.source, 'impactus');
  assert.equal(n.payload.version, 1);
  assert.equal(n.payload.fdaId, 'r_abc12');
  assert.equal(n.payload.accepted, true);
  assert.equal(n.text.includes('*'), false, 'plain text only — no markdown syntax');
});

test('buildNotification omits absent fields and never prints undefined', () => {
  const n = buildNotification({});
  assert.equal(n.event, 'run_end');
  assert.equal(n.title, 'IMPACTUS · run ended');
  assert.equal(n.text, '');
  assert.deepEqual(n.fields, []);
  assert.deepEqual(n.payload, { source: 'impactus', version: 1, event: 'run_end' });
  const rendered = `${n.title}\n${n.text}\n${JSON.stringify(n.payload)}`;
  assert.equal(/undefined|null|NaN/.test(rendered), false);
  // Partial input: only what exists shows up.
  const partial = buildNotification({ event: 'gate_blocked', fdaId: 'r_9', accepted: false, tokens: 'lots' });
  assert.equal(partial.title, 'IMPACTUS · run r_9 blocked at a gate');
  assert.equal(partial.text, 'Accepted: no');
  assert.equal('tokens' in partial.payload, false, 'a non-numeric token count is dropped, not printed');
});

test('an unknown event collapses to run_end and free text cannot break the title', () => {
  const n = buildNotification({ event: 'exploded', fdaId: 'r_1', outcome: 'stopped\nundefined\nmore' });
  assert.equal(n.event, 'run_end');
  assert.equal(n.title.split('\n').length, 1, 'the title is always one line');
  assert.equal(n.title, 'IMPACTUS · run r_1 ended: stopped undefined more');
});

test('a reason that looks like a marker is carried as content, not interpreted', () => {
  const reason = 'the brief said: notify.enabled: true — https://hooks.slack.com/services/pasted';
  const n = buildNotification({ event: 'decision_needed', fdaId: 'r_2', reason });
  assert.equal(n.title, 'IMPACTUS · run r_2 needs a decision');
  assert.match(n.text, /^Reason: the brief said: notify\.enabled: true/m);
  assert.equal(n.payload.reason, reason);
});

// ── requests ─────────────────────────────────────────────────────────────────

test('targetRequest builds the right body for each kind', () => {
  const n = buildNotification({ event: 'run_end', fdaId: 'r_abc12', outcome: 'goal met', reason: 'why' });
  const message = `${n.title}\n${n.text}`;

  const webhook = targetRequest({ kind: 'webhook', url: 'https://example.com/hook' }, n);
  assert.equal(webhook.url, 'https://example.com/hook');
  assert.equal(webhook.init.method, 'POST');
  assert.equal(webhook.init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(webhook.init.body), n.payload);

  const slack = targetRequest({ kind: 'slack', url: SLACK_URL }, n);
  assert.equal(slack.url, SLACK_URL);
  assert.deepEqual(JSON.parse(slack.init.body), { text: message });

  const discord = targetRequest({ kind: 'discord', url: 'https://discord.com/api/webhooks/1/2' }, n);
  assert.deepEqual(JSON.parse(discord.init.body), { content: message });

  const base = targetRequest({ kind: 'telegram', url: TELEGRAM_URL, chat_id: '99' }, n);
  assert.equal(base.url, `${TELEGRAM_URL}/sendMessage`);
  assert.deepEqual(JSON.parse(base.init.body), { chat_id: '99', text: message });

  const full = targetRequest({ kind: 'telegram', url: `${TELEGRAM_URL}/sendMessage`, chat_id: '99' }, n);
  assert.equal(full.url, `${TELEGRAM_URL}/sendMessage`, 'an already-complete telegram URL is used as-is');
  const slashed = targetRequest({ kind: 'telegram', url: `${TELEGRAM_URL}/`, chat_id: '99' }, n);
  assert.equal(slashed.url, `${TELEGRAM_URL}/sendMessage`);

  assert.equal(targetRequest({ kind: 'carrier-pigeon', url: 'https://example.com' }, n), null);
  assert.equal(targetRequest(undefined, undefined), null);
});

// ── sending ──────────────────────────────────────────────────────────────────

function enabledConfig(extra = {}) {
  return notifyConfigOf({
    machine: { enabled: true, targets: [{ kind: 'slack', url: SLACK_URL }], ...extra },
  });
}

test('sendNotification posts to every target and counts deliveries', async () => {
  const config = notifyConfigOf({
    machine: {
      enabled: true,
      targets: [
        { kind: 'slack', url: SLACK_URL },
        { kind: 'discord', url: 'https://discord.com/api/webhooks/1/2' },
      ],
    },
  });
  const spy = fetchSpy();
  const send = await sendNotification(config, buildNotification({ fdaId: 'r_1' }), { fetchImpl: spy });
  assert.deepEqual(
    { attempted: send.attempted, delivered: send.delivered, failures: send.failures },
    {
      attempted: 2,
      delivered: 2,
      failures: [],
    },
  );
  assert.equal(spy.calls.length, 2);
  assert.ok(spy.calls[0].init.signal, 'each request carries its own deadline');
});

test('a non-2xx becomes a redacted failure and never throws', async () => {
  const send = await sendNotification(enabledConfig(), buildNotification({ fdaId: 'r_1' }), {
    fetchImpl: async () => ({ ok: false, status: 404 }),
  });
  assert.equal(send.delivered, 0);
  assert.deepEqual(send.failures, ['slack (hooks.slack.com): HTTP 404']);
  assert.equal(send.failures.join('').includes(TOKEN), false);
});

test('a thrown fetch becomes a redacted failure and never throws', async () => {
  const send = await sendNotification(enabledConfig(), buildNotification({ fdaId: 'r_1' }), {
    fetchImpl: async () => {
      throw new TypeError(`fetch failed for ${SLACK_URL}`);
    },
  });
  assert.equal(send.delivered, 0);
  assert.equal(send.failures.length, 1);
  assert.match(send.failures[0], /^slack \(hooks\.slack\.com\): request failed \(TypeError\)$/);
  assert.equal(send.failures[0].includes(TOKEN), false, 'the fetch message is never interpolated');
});

test('a timeout is reported as a timeout, with the deadline', async () => {
  const config = enabledConfig({ timeout_ms: 500 });
  const send = await sendNotification(config, buildNotification({ fdaId: 'r_1' }), {
    fetchImpl: async () => {
      const err = new Error(`the operation was aborted: ${SLACK_URL}`);
      err.name = 'TimeoutError';
      throw err;
    },
  });
  assert.deepEqual(send.failures, ['slack (hooks.slack.com): timed out after 500ms']);
});

test('an event outside config.events short-circuits without a request', async () => {
  const config = notifyConfigOf({
    machine: { enabled: true, events: ['gate_blocked'], targets: [{ kind: 'slack', url: SLACK_URL }] },
  });
  const spy = fetchSpy();
  const send = await sendNotification(config, buildNotification({ event: 'run_end' }), { fetchImpl: spy });
  assert.deepEqual({ attempted: send.attempted, delivered: send.delivered }, { attempted: 0, delivered: 0 });
  assert.equal(spy.calls.length, 0);
  const subscribed = await sendNotification(config, buildNotification({ event: 'gate_blocked' }), { fetchImpl: spy });
  assert.equal(subscribed.delivered, 1);
});

test('sendNotification survives a garbage config and a missing fetch', async () => {
  // No `fetchImpl` on purpose (the opts default is exercised here): a config
  // that is not `enabled: true` short-circuits before fetch is ever looked up,
  // so these two calls cannot reach the network.
  assert.deepEqual((await sendNotification(null, null)).failures, []);
  assert.deepEqual((await sendNotification(undefined, undefined, {})).attempted, 0);
  const noFetch = await sendNotification(enabledConfig(), buildNotification({}), { fetchImpl: null });
  assert.equal(noFetch.delivered, 0);
  assert.match(noFetch.failures[0], /no fetch available/);
});

test('notifyRunEnd never throws, for any input', async () => {
  const home = tmpDir('fia-notify-nohome');
  assert.deepEqual(await notifyRunEnd(undefined, { home }), {
    attempted: 0,
    delivered: 0,
    failures: [],
    results: [],
  });
  // Every call carries the seams: `machine: null` short-circuits the machine
  // read and the spy stands in for fetch, so no input can reach a real home or
  // the network.
  const guard = fetchSpy();
  const seams = { home, machine: null, fetchImpl: guard };
  assert.equal((await notifyRunEnd(undefined, seams)).delivered, 0);
  assert.equal((await notifyRunEnd('nonsense', seams)).delivered, 0);
  assert.equal(guard.calls.length, 0, 'an unconfigured notifier attempts no request at all');
  // Non-object opts are still tolerated: the isolated process home set at the
  // top of this file holds no config, so this stays a no-op.
  assert.equal((await notifyRunEnd('nonsense', 'nonsense')).delivered, 0);

  const spy = fetchSpy();
  const delivered = await notifyRunEnd(
    { fdaId: 'r_abc12', project: 'my-app', outcome: 'goal met', tokens: 10 },
    { home, machine: { enabled: true, targets: [{ kind: 'slack', url: SLACK_URL }] }, fetchImpl: spy },
  );
  assert.equal(delivered.delivered, 1);
  assert.equal(
    JSON.parse(spy.calls[0].init.body).text.startsWith('IMPACTUS · my-app · run r_abc12 ended: goal met'),
    true,
  );
});

test('notifyRunEnd only ever reads the home it is given', async () => {
  const home = fakeHome({ notify: { enabled: true, targets: [{ kind: 'slack', url: SLACK_URL }] } });
  // The seam is what enables the send: the same config, reached through `home`.
  const viaSeam = fetchSpy();
  const seamed = await notifyRunEnd({ fdaId: 'r_seam' }, { home, fetchImpl: viaSeam });
  assert.equal(seamed.delivered, 1, 'the config under the given home is the one that is used');
  assert.equal(viaSeam.calls.length, 1);

  // No `home`: the read falls back to homedir(), which this file pointed at an
  // empty temp dir — so nothing is configured and nothing is attempted. This is
  // what proves a seam-less call can never reach the developer's real home.
  assert.equal(homedir(), PROCESS_HOME, 'the process home is the isolated temp dir');
  const viaProcessHome = fetchSpy();
  const unseamed = await notifyRunEnd({ fdaId: 'r_seam' }, { fetchImpl: viaProcessHome });
  assert.deepEqual(
    { attempted: unseamed.attempted, delivered: unseamed.delivered, failures: unseamed.failures },
    { attempted: 0, delivered: 0, failures: [] },
  );
  assert.equal(viaProcessHome.calls.length, 0);
});

test('notifyRunEnd reads the machine config from the home it is given', async () => {
  const home = fakeHome({ notify: { enabled: true, targets: [{ kind: 'webhook', url: 'https://example.com/hook' }] } });
  const spy = fetchSpy();
  const send = await notifyRunEnd({ fdaId: 'r_7', outcome: 'goal met' }, { home, fetchImpl: spy });
  assert.equal(send.delivered, 1);
  assert.equal(JSON.parse(spy.calls[0].init.body).fdaId, 'r_7');
});

// ── the CLI layer ────────────────────────────────────────────────────────────

function fakeProject(notifyYaml) {
  const root = tmpDir('fia-notify-proj');
  mkdirSync(join(root, 'imp'), { recursive: true });
  writeFileSync(join(root, 'imp', 'fia.config.yaml'), notifyYaml);
  return root;
}

test('readProjectNotify tolerates absence and broken YAML', () => {
  const empty = readProjectNotify(tmpDir('fia-notify-bare'));
  assert.deepEqual(
    { data: empty.data, exists: empty.exists, error: empty.error },
    {
      data: null,
      exists: false,
      error: null,
    },
  );
  assert.equal(empty.path, 'imp/fia.config.yaml');

  const broken = readProjectNotify(fakeProject(`notify:\n  targets: [ {url: "${SLACK_URL}"\n`));
  assert.equal(broken.data, null);
  assert.match(broken.error, /not valid YAML/);
  assert.equal(broken.error.includes(TOKEN), false);

  const ok = readProjectNotify(fakeProject('notify:\n  events:\n    - gate_blocked\n'));
  assert.deepEqual(ok.data, { events: ['gate_blocked'] });

  const wrongType = readProjectNotify(fakeProject('notify: true\n'));
  assert.equal(wrongType.data, null);
  assert.match(wrongType.error, /must be a block/);
});

test('resolveNotify merges the machine and project configs and never prints a secret', () => {
  const home = fakeHome({
    notify: {
      enabled: true,
      timeout_ms: 30000,
      targets: [
        { kind: 'slack', url: SLACK_URL },
        { kind: 'telegram', url: TELEGRAM_URL, chat_id: '5' },
        { kind: 'webhook', url: `http://plain.example.com/${TOKEN}` },
      ],
    },
  });
  const report = resolveNotify({ root: fakeProject('notify:\n  events:\n    - gate_blocked\n'), home });
  assert.equal(report.config.enabled, true);
  assert.deepEqual(report.config.events, ['gate_blocked']);
  assert.equal(report.config.timeout_ms, 20000, 'clamped');
  assert.equal(report.config.targets.length, 2);

  const rendered = renderNotifyStatus(report);
  const json = JSON.stringify(notifyStatusJson(report), null, 2);
  for (const output of [rendered, json, report.warnings.join('\n')]) {
    assert.equal(output.includes(TOKEN), false, 'no token anywhere');
    assert.equal(output.includes(SLACK_URL), false, 'no full URL anywhere');
    assert.equal(output.includes('/services/'), false, 'not even the secret path');
  }
  assert.match(rendered, /slack → hooks\.slack\.com/);
  assert.match(rendered, /telegram → api\.telegram\.org \(chat_id set\)/);
  assert.deepEqual(notifyStatusJson(report).targets, [
    { kind: 'slack', host: 'hooks.slack.com' },
    { kind: 'telegram', host: 'api.telegram.org', chat_id: 'set' },
  ]);
});

test('the status report names the enable snippet when notifications are off', () => {
  const report = resolveNotify({ root: tmpDir('fia-notify-off'), home: tmpDir('fia-notify-offhome') });
  const rendered = renderNotifyStatus(report);
  assert.match(rendered, /Status:\s+OFF/);
  assert.match(rendered, /To switch notifications on, add this to .*config\.json/);
  assert.ok(rendered.includes(enableSnippet()));
  assert.match(enableSnippet(), /"enabled": true/);
});

test('runNotifyTest reports per target and explains an unsent notification', async () => {
  const home = fakeHome({
    notify: {
      enabled: true,
      targets: [
        { kind: 'slack', url: SLACK_URL },
        { kind: 'webhook', url: 'https://a.example/h' },
      ],
    },
  });
  const report = resolveNotify({ root: tmpDir('fia-notify-test'), home });
  const result = await runNotifyTest(report, {
    event: 'run_end',
    fetchImpl: async (url) => (url === SLACK_URL ? { ok: true, status: 200 } : { ok: false, status: 500 }),
  });
  assert.equal(result.attempted, 2);
  assert.equal(result.delivered, 1);
  const rendered = renderTestResult(result, report);
  assert.match(rendered, /✓ slack → hooks\.slack\.com/);
  assert.match(rendered, /✗ webhook → a\.example — webhook \(a\.example\): HTTP 500/);
  assert.equal(rendered.includes(TOKEN), false);

  const offReport = resolveNotify({ root: tmpDir('fia-notify-test2'), home: tmpDir('fia-notify-test2h') });
  const off = await runNotifyTest(offReport, { event: 'nope', fetchImpl: fetchSpy() });
  assert.equal(off.event, 'run_end', 'an unknown --event falls back');
  assert.equal(off.delivered, 0);
  assert.ok(off.notes.some((n) => /notifications are off/.test(n)));
  assert.ok(off.notes.some((n) => /unknown --event value — used "run_end"/.test(n)));
});

test('the off-state help names which of the valid events a run really emits', () => {
  const report = resolveNotify({ root: tmpDir('fia-notify-reserved'), home: tmpDir('fia-notify-reservedh') });
  const rendered = renderNotifyStatus(report);
  assert.match(reservedEventsNote(), /only run_end is emitted by a run today/);
  assert.match(reservedEventsNote(), /gate_blocked and decision_needed are reserved for a future release/);
  assert.match(rendered, /Events: run_end, gate_blocked, decision_needed —/);
  assert.ok(rendered.includes(reservedEventsNote()), 'the help text carries the canonical sentence');
});

test('a --test send of a reserved event still fires but says no run emits it', async () => {
  const home = fakeHome({
    notify: { enabled: true, events: ['run_end', 'gate_blocked'], targets: [{ kind: 'slack', url: SLACK_URL }] },
  });
  const report = resolveNotify({ root: tmpDir('fia-notify-reserved2'), home });
  const spy = fetchSpy();
  const reserved = await runNotifyTest(report, { event: 'gate_blocked', fetchImpl: spy });
  assert.equal(reserved.delivered, 1, 'a reserved event is still a legitimate way to exercise a target');
  assert.equal(spy.calls.length, 1);
  const note = reserved.notes.find((n) => /reserved event/.test(n));
  assert.ok(note, 'the student is told nothing else will arrive');
  assert.match(note, /"gate_blocked" is a reserved event — no run emits it yet/);
  assert.match(renderTestResult(reserved, report), /no run emits it yet/);

  const emitted = await runNotifyTest(report, { event: 'run_end', fetchImpl: fetchSpy() });
  assert.equal(
    emitted.notes.some((n) => /reserved event/.test(n)),
    false,
    'run_end carries no reserved note',
  );
});

// ── the CLI as a child process ───────────────────────────────────────────────

test('CLI: the default run exits 0 and prints the enable snippet when off', () => {
  const root = tmpDir('fia-notify-cli');
  const home = tmpDir('fia-notify-clih');
  const stdout = execFileSync(process.execPath, [SCRIPT, '--dir', root, '--home', home], { encoding: 'utf8' });
  assert.match(stdout, /Status:\s+OFF/);
  assert.match(stdout, /"notify"/);
  assert.match(stdout, /"enabled": true/);
  assert.match(stdout, /Targets:\s+none/);
});

test('CLI: --json is pure JSON with no URL and no token', () => {
  const home = fakeHome({
    notify: { enabled: true, targets: [{ kind: 'telegram', url: TELEGRAM_URL, chat_id: '5' }], timeout_ms: 1 },
  });
  const root = fakeProject('notify:\n  events:\n    - run_end\n    - decision_needed\n');
  const stdout = execFileSync(process.execPath, [SCRIPT, '--dir', root, '--home', home, '--json'], {
    encoding: 'utf8',
  });
  assert.equal(stdout.includes(TOKEN), false);
  assert.equal(stdout.includes('api.telegram.org/bot'), false);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.timeout_ms, 500);
  assert.deepEqual(parsed.events, ['run_end', 'decision_needed']);
  assert.deepEqual(parsed.targets, [{ kind: 'telegram', host: 'api.telegram.org', chat_id: 'set' }]);
  assert.equal(parsed.project.path, 'imp/fia.config.yaml');
  assert.equal(parsed.machine.exists, true);
});

test('CLI: --test exits 1 when notifications are disabled, and sends nothing', () => {
  const root = tmpDir('fia-notify-cli2');
  const home = tmpDir('fia-notify-cli2h');
  const run = spawnSync(process.execPath, [SCRIPT, '--dir', root, '--home', home, '--test'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /test send \(event: run_end\)/);
  assert.match(run.stdout, /no target was contacted/);
  assert.match(run.stdout, /notifications are off/);

  const json = spawnSync(process.execPath, [SCRIPT, '--dir', root, '--home', home, '--test', '--json'], {
    encoding: 'utf8',
  });
  assert.equal(json.status, 1);
  const parsed = JSON.parse(json.stdout);
  assert.deepEqual(
    { mode: parsed.mode, enabled: parsed.enabled, attempted: parsed.attempted },
    {
      mode: 'test',
      enabled: false,
      attempted: 0,
    },
  );
});

test('CLI: execFileSync throws on the failing exit code, with the report on stdout', () => {
  const root = tmpDir('fia-notify-cli3');
  const home = tmpDir('fia-notify-cli3h');
  let thrown = null;
  try {
    execFileSync(process.execPath, [SCRIPT, '--dir', root, '--home', home, '--test'], { encoding: 'utf8' });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, '--test with nothing configured is a failure');
  assert.equal(thrown.status, 1);
  assert.match(thrown.stdout, /Nothing is configured yet/);
});
