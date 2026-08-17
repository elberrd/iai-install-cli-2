import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCommand } from '../src/lib/command.js';

test('buildCommand: --template-id is ALWAYS explicit (otherwise the terminal asks again)', () => {
  const live2 = buildCommand({ mode: 'full', name: 'app', templateId: 'live2' });
  assert.equal(live2.argv[live2.argv.indexOf('--template-id') + 1], 'live2');
  const live1 = buildCommand({ mode: 'full', name: 'app', templateId: 'live1' });
  assert.equal(live1.argv[live1.argv.indexOf('--template-id') + 1], 'live1');

  // Legacy form (older pages): tenancy multi → live2; anything else → live1.
  const legacy = buildCommand({ mode: 'full', name: 'app', tenancy: 'multi' });
  assert.equal(legacy.argv[legacy.argv.indexOf('--template-id') + 1], 'live2');
  const legacySingle = buildCommand({ mode: 'full', name: 'app', tenancy: 'single' });
  assert.equal(legacySingle.argv[legacySingle.argv.indexOf('--template-id') + 1], 'live1');
  const none = buildCommand({ mode: 'full', name: 'app' });
  assert.equal(none.argv[none.argv.indexOf('--template-id') + 1], 'live1');

  // Harness mode has no template.
  const harness = buildCommand({ mode: 'harness', name: 'app' });
  assert.ok(!harness.argv.includes('--template-id'));
});

test('buildCommand: stack path in harness mode becomes --stack', () => {
  // Older page (no stack section) → classic behavior.
  const antiga = buildCommand({ mode: 'harness', name: 'app' });
  assert.ok(antiga.argv.includes('--harness-only'));
  assert.ok(!antiga.argv.includes('--stack'));

  // Decide with Pi → --stack depois (no --harness-only: --stack already carries the mode).
  const discover = buildCommand({ mode: 'harness', name: 'app', stackPath: 'discover' });
  assert.equal(discover.argv[discover.argv.indexOf('--stack') + 1], 'depois');
  assert.ok(!discover.argv.includes('--harness-only'));

  // Layer by layer → pairs, INCLUDING explicit 'depois' (leaving it pending
  // was also a decision — the terminal wizard does not re-ask that layer).
  const custom = buildCommand({
    mode: 'harness',
    name: 'app',
    stackPath: 'custom',
    stackChoices: { frontend: 'nextjs', backend: 'hono', database: 'neon', orm: 'depois', auth: 'clerk' },
  });
  assert.equal(
    custom.argv[custom.argv.indexOf('--stack') + 1],
    'frontend=nextjs,backend=hono,database=neon,orm=depois,auth=clerk',
  );

  // Custom with no choice at all → propria (the terminal wizard asks);
  // everything 'depois' → the depois shortcut.
  const vazio = buildCommand({ mode: 'harness', stackPath: 'custom', stackChoices: {} });
  assert.equal(vazio.argv[vazio.argv.indexOf('--stack') + 1], 'propria');
  const tudoDepois = buildCommand({
    mode: 'harness',
    stackPath: 'custom',
    stackChoices: { frontend: 'depois', backend: 'depois' },
  });
  assert.equal(tudoDepois.argv[tudoDepois.argv.indexOf('--stack') + 1], 'depois');

  // In full mode the stack section does not exist — no --stack.
  const full = buildCommand({ mode: 'full', name: 'app', stackPath: 'custom', stackChoices: { backend: 'hono' } });
  assert.ok(!full.argv.includes('--stack'));
});

test('buildCommand: keysPath becomes --keys <path> (full mode only)', () => {
  const path = '/Users/x/.impactus-cli/keys/meu-app.env';
  const full = buildCommand({ mode: 'full', name: 'app', keysPath: path });
  assert.equal(full.argv[full.argv.indexOf('--keys') + 1], path);
  assert.ok(full.command.includes(`--keys ${path}`));

  const harness = buildCommand({ mode: 'harness', keysPath: path });
  assert.ok(!harness.argv.includes('--keys'));

  const none = buildCommand({ mode: 'full', name: 'app' });
  assert.ok(!none.argv.includes('--keys'));
});

test('buildCommand: harness mode becomes --harness-only', () => {
  const { argv, command } = buildCommand({ mode: 'harness', name: 'meu-app' });
  assert.deepEqual(argv, ['meu-app', '--harness-only']);
  assert.equal(command, 'npx impactus meu-app --harness-only');
});

test('buildCommand: harness + --yes', () => {
  const { argv } = buildCommand({ mode: 'harness', yes: true });
  assert.deepEqual(argv, ['--harness-only', '--yes']);
});

test('buildCommand: full with preset and groups', () => {
  const { argv } = buildCommand({
    mode: 'full',
    name: 'app',
    preset: 'padrao',
    groups: {
      addons: ['commitlint', 'knip'],
      observability: ['sentry'],
      analytics: 'posthog',
      security: [],
    },
  });
  assert.ok(argv.includes('--mode') && argv[argv.indexOf('--mode') + 1] === 'full');
  assert.ok(argv.includes('--preset') && argv[argv.indexOf('--preset') + 1] === 'padrao');
  assert.equal(argv[argv.indexOf('--addons') + 1], 'commitlint,knip');
  assert.equal(argv[argv.indexOf('--observability') + 1], 'sentry');
  assert.equal(argv[argv.indexOf('--analytics') + 1], 'posthog');
  // empty multiselect group → explicitly "none"
  assert.equal(argv[argv.indexOf('--security') + 1], 'none');
});

test('buildCommand: empty/none single group becomes --flag none', () => {
  const { argv } = buildCommand({ mode: 'full', groups: { payments: 'none', emails: '' } });
  assert.equal(argv[argv.indexOf('--payments') + 1], 'none');
  assert.equal(argv[argv.indexOf('--emails') + 1], 'none');
});

test('buildCommand: storage, push/visibility and deploy', () => {
  const pub = buildCommand({ mode: 'full', storage: 'r2', push: true, privateRepo: false, deploy: true });
  assert.equal(pub.argv[pub.argv.indexOf('--storage') + 1], 'r2');
  assert.ok(pub.argv.includes('--push'));
  assert.ok(pub.argv.includes('--public'));
  assert.ok(pub.argv.includes('--deploy'));

  const priv = buildCommand({ mode: 'full', push: true, privateRepo: true });
  assert.ok(priv.argv.includes('--private'));
  assert.ok(!priv.argv.includes('--public'));
});

test('buildCommand: unchecked checkbox becomes --no-push/--no-deploy (decision, not omission)', () => {
  const off = buildCommand({ mode: 'full', name: 'app', push: false, deploy: false });
  assert.ok(off.argv.includes('--no-push'));
  assert.ok(off.argv.includes('--no-deploy'));
  assert.ok(!off.argv.includes('--push'));
  assert.ok(!off.argv.includes('--deploy'));

  // Older page (fields missing): omitted — the terminal asks, as before.
  const legacy = buildCommand({ mode: 'full', name: 'app' });
  assert.ok(!legacy.argv.includes('--no-push'));
  assert.ok(!legacy.argv.includes('--no-deploy'));
});

test('buildCommand: dir with special characters is quoted', () => {
  const { command } = buildCommand({ mode: 'harness', dir: './pasta com espaço' });
  assert.ok(command.includes(`'./pasta com espaço'`), command);
});

test('buildCommand: unknown group is ignored', () => {
  const { argv } = buildCommand({ mode: 'full', groups: { inexistente: ['x'] } });
  assert.ok(!argv.includes('--inexistente'));
});

test('buildCommand: missing mode defaults to full', () => {
  const { argv } = buildCommand({ name: 'x' });
  assert.ok(argv.includes('--mode'));
  assert.equal(argv[argv.indexOf('--mode') + 1], 'full');
});

test('buildCommand: opts.api appends --api to the copied command (dev/test)', () => {
  // The command the student pastes into the terminal must validate the token
  // against the SAME backend the page used — otherwise "your session expired" out of nowhere.
  const harness = buildCommand({ mode: 'harness' }, { api: 'http://127.0.0.1:8787' });
  assert.deepEqual(harness.argv, ['--harness-only', '--api', 'http://127.0.0.1:8787']);
  assert.ok(harness.command.includes('--api'));

  const full = buildCommand({ mode: 'full', name: 'app' }, { api: 'http://127.0.0.1:8787' });
  assert.equal(full.argv[full.argv.indexOf('--api') + 1], 'http://127.0.0.1:8787');

  // Without the flag on the server, nothing changes.
  const none = buildCommand({ mode: 'full', name: 'app' });
  assert.ok(!none.argv.includes('--api'));
});
