import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, statSync, existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate HOME so we never touch the real ~/.impactus-cli.
const fakeHome = mkdtempSync(join(tmpdir(), 'impactus-home-'));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;

const {
  resolveApiBase,
  saveAuth,
  loadAuth,
  clearAuth,
  deviceStart,
  devicePoll,
  verifyToken,
  downloadTemplate,
} = await import('../src/lib/auth-client.js');

// ── Mock of the /api/cli/* backend ───────────────────────────────────────────
let server;
let base;
const state = { pollCalls: 0 };

before(async () => {
  server = createServer((req, res) => {
    const send = (code, obj, headers = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', ...headers });
      res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
    };
    const auth = req.headers['authorization'];

    if (req.url === '/api/cli/device/start' && req.method === 'POST') {
      return send(200, {
        device_code: 'iadev_test',
        user_code: 'WXYZ-2345',
        verification_uri: `${base}/cli`,
        verification_uri_complete: `${base}/cli?code=WXYZ-2345`,
        expires_in: 600,
        interval: 1,
      });
    }
    if (req.url === '/api/cli/device/poll' && req.method === 'POST') {
      state.pollCalls++;
      // First poll pending, then approved (simulates the student approving).
      return send(200,
        state.pollCalls < 2
          ? { status: 'pending', interval: 1 }
          : { status: 'approved', access_token: 'iacli_ok_token', expires_at: Date.now() + 1000 });
    }
    if (req.url === '/api/cli/verify' && req.method === 'GET') {
      if (auth === 'Bearer iacli_ok_token') {
        return send(200, { ok: true, user: { name: 'Test Student', email: 'a@x.com' } });
      }
      if (auth === 'Bearer iacli_unpaid') {
        return send(403, { ok: false, reason: 'no_active_enrollment' });
      }
      return send(401, { ok: false, reason: 'invalid_token' });
    }
    if (req.url.startsWith('/api/cli/template/hang')) {
      return; // never responds — exercises the download timeout
    }
    if (req.url.startsWith('/api/cli/template/') && req.method === 'GET') {
      if (auth !== 'Bearer iacli_ok_token') return send(401, { ok: false, reason: 'invalid_token' });
      res.writeHead(200, { 'content-type': 'application/gzip' });
      return res.end(Buffer.from('fake-tarball-bytes'));
    }
    send(404, { error: 'not_found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());
beforeEach(() => { state.pollCalls = 0; });

// ── Tests ────────────────────────────────────────────────────────────────────

test('resolveApiBase: --api > env > default; no trailing slash', () => {
  assert.equal(resolveApiBase({ api: 'https://x.com/' }), 'https://x.com');
  const prev = process.env.CREATE_IAI_API;
  process.env.CREATE_IAI_API = 'https://env.example';
  assert.equal(resolveApiBase({}), 'https://env.example');
  // The flag beats the env.
  assert.equal(resolveApiBase({ api: 'https://flag.convex.site' }), 'https://flag.convex.site');
  if (prev == null) delete process.env.CREATE_IAI_API;
  else process.env.CREATE_IAI_API = prev;
});

test('saveAuth/loadAuth/clearAuth: round trip with permission 600', async () => {
  const path = await saveAuth({ token: 'iacli_ok_token', apiBase: base });
  assert.ok(existsSync(path));
  if (process.platform !== 'win32') {
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
  const loaded = await loadAuth();
  assert.equal(loaded.token, 'iacli_ok_token');
  await clearAuth();
  assert.equal(await loadAuth(), null);
});

test('device flow: start → poll (pending→approved) returns the token', async () => {
  const start = await deviceStart(base, 'host (darwin)');
  assert.equal(start.ok, true);
  assert.equal(start.data.device_code, 'iadev_test');

  const p1 = await devicePoll(base, 'iadev_test');
  assert.equal(p1.data.status, 'pending');
  const p2 = await devicePoll(base, 'iadev_test');
  assert.equal(p2.data.status, 'approved');
  assert.equal(p2.data.access_token, 'iacli_ok_token');
});

test('verifyToken: ok for paid, 403 without subscription, 401 invalid', async () => {
  assert.equal((await verifyToken(base, 'iacli_ok_token')).ok, true);
  const unpaid = await verifyToken(base, 'iacli_unpaid');
  assert.equal(unpaid.ok, false);
  assert.equal(unpaid.status, 403);
  assert.equal(unpaid.data.reason, 'no_active_enrollment');
  assert.equal((await verifyToken(base, 'nope')).status, 401);
});

test('downloadTemplate: writes the tarball with a valid token; refuses without one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'create-iai-dl-'));
  const dest = join(dir, 'live1.tar.gz');
  const ok = await downloadTemplate(base, 'iacli_ok_token', 'live1', dest);
  assert.equal(ok.ok, true);
  assert.equal(await readFile(dest, 'utf8'), 'fake-tarball-bytes');

  const bad = await downloadTemplate(base, 'wrong', 'live1', join(dir, 'x.tgz'));
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'invalid_token');
});

test('downloadTemplate: unreachable server → network_error (never throws)', async () => {
  // Grab a port the OS just freed so the connection is refused, not hung.
  const dead = createServer(() => {});
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const deadBase = `http://127.0.0.1:${dead.address().port}`;
  await new Promise((r) => dead.close(r));

  const dir = mkdtempSync(join(tmpdir(), 'create-iai-dl-'));
  const res = await downloadTemplate(deadBase, 'iacli_ok_token', 'live1', join(dir, 'x.tgz'));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'network_error');
});

test('downloadTemplate: a frozen connection aborts with download_timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'create-iai-dl-'));
  const res = await downloadTemplate(base, 'iacli_ok_token', 'hang', join(dir, 'x.tgz'), undefined, 300);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'download_timeout');
});

// ── No legacy migration ──────────────────────────────────────────────────────
// v2 has no ties to the old CLI: ~/.create-live1 is ignored and only
// ~/.impactus-cli/auth.json (or the pre-rebrand ~/.create-iai it gets renamed
// from — see state-dir.test.js) counts as a credential.

test('loadAuth: ignores ~/.create-live1 (no legacy migration)', async () => {
  await clearAuth();
  const legacyDir = join(fakeHome, '.create-live1');
  await mkdir(legacyDir, { recursive: true });
  await writeFile(
    join(legacyDir, 'auth.json'),
    JSON.stringify({ token: 'legacy-tok', user: { name: 'Old Student' } }),
    'utf8',
  );

  assert.equal(await loadAuth(), null, 'legacy token must NOT be adopted');
  assert.equal(existsSync(join(fakeHome, '.impactus-cli', 'auth.json')), false);
});

test('loadAuth: a pre-rebrand ~/.create-iai/auth.json is adopted via the folder rename', async () => {
  await clearAuth();
  // The rename only fires while ~/.impactus-cli does not exist yet — mirror a
  // machine that never ran the rebranded CLI.
  await rm(join(fakeHome, '.impactus-cli'), { recursive: true, force: true });
  const preRebrand = join(fakeHome, '.create-iai');
  await mkdir(preRebrand, { recursive: true });
  await writeFile(
    join(preRebrand, 'auth.json'),
    JSON.stringify({ token: 'rebrand-tok', user: { name: 'Keeps Login' } }),
    'utf8',
  );

  const auth = await loadAuth();
  assert.equal(auth?.token, 'rebrand-tok', 'the saved login must survive the rebrand');
  assert.equal(existsSync(join(fakeHome, '.impactus-cli', 'auth.json')), true, 'folder renamed to the new name');
  assert.equal(existsSync(preRebrand), false, 'old folder is gone (renamed, not copied)');
  await clearAuth();
});
