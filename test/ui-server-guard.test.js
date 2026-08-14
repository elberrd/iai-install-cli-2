// DNS-rebinding / CSRF guard of the --ui web server (src/steps/ui-server.js):
// a malicious site open in the browser must not be able to reach the local
// API by pointing an odd Host at 127.0.0.1 or by cross-origin fetch.
//
// `runUiServer` blocks until SIGINT and prints its URL, so the server runs in
// a CHILD process (with an empty PATH so the "open the browser" best-effort
// spawn fails silently) and the test talks to the port parsed from its output.
// Requests use node:http directly because fetch() forbids overriding Host.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';

const SERVER_MODULE = new URL('../src/steps/ui-server.js', import.meta.url).href;
// Away from the default 4599 so a manually running `--ui` doesn't collide;
// listenWithFallback walks forward on EADDRINUSE and we parse the real port.
const REQUESTED_PORT = 4700 + (process.pid % 200);

let child;
let port;

before(async () => {
  const code = `const m = await import(${JSON.stringify(SERVER_MODULE)}); await m.runUiServer({ port: ${REQUESTED_PORT} });`;
  child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    // Empty PATH: openBrowser()'s spawn('open'/…) fails with ENOENT, which the
    // server handles by printing a hint instead of opening a real browser.
    env: { ...process.env, PATH: '', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  port = await new Promise((resolve, reject) => {
    let out = '';
    const onData = (chunk) => {
      out += chunk;
      const m = out.match(/http:\/\/localhost:(\d+)/);
      if (m) resolve(Number(m[1]));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (codeNum) => reject(new Error(`ui-server exited early (code ${codeNum}):\n${out}`)));
    setTimeout(() => reject(new Error(`ui-server did not print its URL in time:\n${out}`)), 15000).unref();
  });
});

after(() => {
  child?.kill('SIGKILL');
});

/** Raw HTTP request against 127.0.0.1:port with full header control. */
function rawRequest({ method = 'GET', path = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method, path, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

test('ui-server: local Host reaches the catalog (control case)', async () => {
  const res = await rawRequest({ path: '/api/catalog', headers: { host: `localhost:${port}` } });
  assert.equal(res.status, 200);
  const catalog = JSON.parse(res.body);
  assert.ok(Array.isArray(catalog.groups) && catalog.groups.length > 0, 'catalog lists addon groups');
});

test('ui-server: external Host (DNS rebinding) gets 403 on every route', async () => {
  for (const path of ['/', '/api/catalog', '/api/browse?path=/']) {
    const res = await rawRequest({ path, headers: { host: 'evil.com' } });
    assert.equal(res.status, 403, `${path} with Host: evil.com`);
    assert.equal(res.body, 'Forbidden');
  }
});

test('ui-server: POST /api/keys with a non-local Origin is blocked before writing', async () => {
  const res = await rawRequest({
    method: 'POST',
    path: '/api/keys',
    headers: {
      host: `localhost:${port}`,
      origin: 'https://evil.com',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name: 'pwned', keys: { STRIPE_SECRET_KEY: 'sk_test_x' } }),
  });
  assert.equal(res.status, 403);
  assert.equal(res.body, 'Forbidden');
});

test('ui-server: local Origin (the page itself) is still allowed', async () => {
  const res = await rawRequest({
    path: '/api/catalog',
    headers: { host: `127.0.0.1:${port}`, origin: `http://localhost:${port}` },
  });
  assert.equal(res.status, 200);
});
