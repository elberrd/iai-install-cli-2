import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync, existsSync, mkdtempSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate HOME: defaultKeysPath goes through stateDirPath(), which migrates a
// real ~/.create-iai when it finds one — tests must never touch the real home.
const fakeHome = mkdtempSync(join(tmpdir(), 'impactus-keys-home-'));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;

const { defaultKeysPath, generateToken, loadKeysFile, saveKeysFile } = await import('../src/lib/keys.js');

test('saveKeysFile/loadKeysFile: round trip with permission 600', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'create-iai-keys-'));
  const path = join(dir, 'proj.env');
  try {
    const saved = await saveKeysFile(path, {
      STRIPE_SECRET_KEY: 'sk_test_abc',
      RESEND_API_KEY: ' re_x ', // whitespace gets trimmed
      EMPTY_ONE: '',
    });
    assert.equal(saved, path);
    // POSIX permissions; on Windows Node's chmod does not produce 0600.
    if (process.platform !== 'win32') {
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }

    const { keys, unknown } = await loadKeysFile(path);
    assert.deepEqual(keys, { STRIPE_SECRET_KEY: 'sk_test_abc', RESEND_API_KEY: 're_x' });
    assert.deepEqual(unknown, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('saveKeysFile: empty object deletes the file and returns null', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'create-iai-keys-'));
  const path = join(dir, 'proj.env');
  try {
    await saveKeysFile(path, { STRIPE_SECRET_KEY: 'sk_test_abc' });
    assert.ok(existsSync(path));
    const cleared = await saveKeysFile(path, {});
    assert.equal(cleared, null);
    assert.ok(!existsSync(path));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadKeysFile: unknown keys go to unknown (they do not enter the result)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'create-iai-keys-'));
  const path = join(dir, 'proj.env');
  try {
    await writeFile(
      path,
      ['# comment', 'RESEND_API_KEY=re_1', 'MADE_UP_KEY=oops', 'ANOTHER_UNKNOWN="x"', ''].join('\n'),
      'utf8',
    );
    const { keys, unknown } = await loadKeysFile(path);
    assert.deepEqual(keys, { RESEND_API_KEY: 're_1' });
    assert.deepEqual(unknown, ['MADE_UP_KEY', 'ANOTHER_UNKNOWN']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadKeysFile: accepts the documentation extras (EMAIL_FROM, RESEND_TEST_MODE)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'create-iai-keys-'));
  const path = join(dir, 'proj.env');
  try {
    await writeFile(path, 'EMAIL_FROM=Acme <no@acme.com>\nRESEND_TEST_MODE=false\n', 'utf8');
    const { keys, unknown } = await loadKeysFile(path);
    assert.deepEqual(keys, { EMAIL_FROM: 'Acme <no@acme.com>', RESEND_TEST_MODE: 'false' });
    assert.deepEqual(unknown, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('defaultKeysPath: sanitized slug inside ~/.impactus-cli/keys', () => {
  assert.ok(defaultKeysPath('My App!').endsWith(join('.impactus-cli', 'keys', 'my-app.env')));
  // A name with no usable characters degrades to the safe fallback.
  assert.ok(defaultKeysPath('--éÀ  ').endsWith(join('.impactus-cli', 'keys', 'project.env')));
  assert.ok(defaultKeysPath('__ Store 2 __').endsWith(join('.impactus-cli', 'keys', 'store-2.env')));
});

test('generateToken: urlsafe and reasonably long', () => {
  const t = generateToken();
  assert.ok(t.length >= 24);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(t));
  assert.notEqual(generateToken(), generateToken());
});
