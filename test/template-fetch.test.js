import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { downloadErrorMessage, fetchTemplateToDir } = await import('../src/lib/template-fetch.js');

// Builds a tarball in the GitHub format (root dir <owner>-<repo>-<sha>/…) and
// serves its bytes — proves the extraction does strip-components=1 right.
let server;
let base;
let tarballBytes;

before(async () => {
  const work = mkdtempSync(join(tmpdir(), 'create-iai-tar-'));
  const top = join(work, 'elberrd-live1-abc123');
  mkdirSync(join(top, 'convex'), { recursive: true });
  writeFileSync(join(top, 'package.json'), '{"name":"live1"}\n');
  writeFileSync(join(top, 'convex', 'schema.ts'), 'export default {}\n');
  const tgz = join(work, 'repo.tar.gz');
  execFileSync('tar', ['-czf', tgz, '-C', work, 'elberrd-live1-abc123']);
  tarballBytes = readFileSync(tgz);

  server = createServer((req, res) => {
    // The harness is the free tier: served WITHOUT any Authorization header
    // (mirrors PUBLIC_TEMPLATES on the community server). A `Bearer null`
    // string would fall through to 403 — proving the header is truly absent.
    if (req.url.startsWith('/api/cli/template/harness') && !req.headers['authorization']) {
      res.writeHead(200, { 'content-type': 'application/gzip' });
      return res.end(tarballBytes);
    }
    if (req.url.startsWith('/api/cli/template/') && req.headers['authorization'] === 'Bearer good') {
      res.writeHead(200, { 'content-type': 'application/gzip' });
      return res.end(tarballBytes);
    }
    if (req.url.startsWith('/api/cli/template/') && req.headers['authorization'] === 'Bearer corrupt') {
      res.writeHead(200, { 'content-type': 'application/gzip' });
      return res.end(Buffer.from('this is not a tarball'));
    }
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, reason: 'no_active_enrollment' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

test('fetchTemplateToDir: downloads and extracts without the tarball root directory', async () => {
  const dest = mkdtempSync(join(tmpdir(), 'create-iai-out-'));
  const res = await fetchTemplateToDir(base, 'good', 'live1', dest);
  assert.equal(res.ok, true);
  // Content directly, without the elberrd-live1-abc123 folder.
  assert.ok(existsSync(join(dest, 'package.json')));
  assert.ok(existsSync(join(dest, 'convex', 'schema.ts')));
  assert.equal(JSON.parse(await readFile(join(dest, 'package.json'), 'utf8')).name, 'live1');
});

test('fetchTemplateToDir: null token sends NO Authorization header (guest harness download)', async () => {
  const dest = mkdtempSync(join(tmpdir(), 'create-iai-out-'));
  const res = await fetchTemplateToDir(base, null, 'harness', dest);
  assert.equal(res.ok, true);
  assert.ok(existsSync(join(dest, 'package.json')));
});

test('downloadErrorMessage: missing sign-in → says how to sign in, never "just retry"', () => {
  const m = downloadErrorMessage('template', 'missing_token');
  assert.match(m, /requires the community sign-in/);
  assert.match(m, /impactus --login/);
  assert.doesNotMatch(m, /Try again in a moment/);
  assert.match(downloadErrorMessage('harness', 'http_401'), /sign-in/);
});

test('fetchTemplateToDir: token without access → reason passed through', async () => {
  const dest = mkdtempSync(join(tmpdir(), 'create-iai-out-'));
  const res = await fetchTemplateToDir(base, 'bad', 'live1', dest);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no_active_enrollment');
});

test('downloadErrorMessage: separates "wait" from "retrying won\'t help"', () => {
  // Inactive subscription: it's on the student.
  assert.match(downloadErrorMessage('template', 'no_active_enrollment'), /subscription is no longer active/);

  // server_misconfigured = missing env on the server (e.g. TEMPLATE_GITHUB_TOKEN).
  // Saying "try again in a moment" would make the student retry forever.
  const mis = downloadErrorMessage('harness', 'server_misconfigured');
  assert.match(mis, /pending configuration/);
  assert.match(mis, /repeating the command won't help/);
  assert.doesNotMatch(mis, /Try again in a moment/);

  // A generic/transient error keeps suggesting a retry.
  assert.match(downloadErrorMessage('template', 'http_503'), /Try again in a moment/);
  assert.match(downloadErrorMessage('template', undefined), /Try again in a moment/);
});

test('fetchTemplateToDir: corrupted tarball → extract_failed (tar is present)', async () => {
  const dest = mkdtempSync(join(tmpdir(), 'create-iai-out-'));
  const res = await fetchTemplateToDir(base, 'corrupt', 'live1', dest);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'extract_failed');
});

test('downloadErrorMessage: tar missing vs corrupted download vs stalled connection', () => {
  // Missing tar is not transient — the message says how to install it.
  const missing = downloadErrorMessage('template', 'tar_missing');
  assert.match(missing, /"tar" program was not found/);
  assert.match(missing, /xcode-select --install/);
  assert.doesNotMatch(missing, /Try again in a moment/);

  // Corrupted download → suggest ONE re-download, then support.
  const corrupt = downloadErrorMessage('template', 'extract_failed');
  assert.match(corrupt, /corrupted/);
  assert.match(corrupt, /Run the same command again/);
  assert.match(corrupt, /support/);
  assert.doesNotMatch(corrupt, /Try again in a moment/);

  // Stalled connection → check the internet and rerun.
  const stalled = downloadErrorMessage('harness', 'download_timeout');
  assert.match(stalled, /dropped mid-download/);
  assert.match(stalled, /Check your internet/);

  // Unreachable server (DNS, refused, offline) → same recovery, own cause.
  const net = downloadErrorMessage('template', 'network_error');
  assert.match(net, /could not reach the server/);
  assert.match(net, /Check your internet/);
  assert.match(net, /run the same command again/);
});
