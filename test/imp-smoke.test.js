// Smoke tests for the `imp` launcher (bin/imp.js) as a real child process:
// help/version exit paths, init forwarding to the installer, and the
// pass-everything-else-to-Pi contract (exercised against a fake `pi` binary
// on PATH so no real agent ever starts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/imp.js', import.meta.url));

function runImp(args, { env = process.env, timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { timeout, env, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
      },
    );
  });
}

test('imp: help exits 0 and prints the brand + usage', async () => {
  const res = await runImp(['help']);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /IMPACTUS Academy/);
  assert.match(res.stdout, /Usage:/);
  assert.match(res.stdout, /imp init/);
  assert.match(res.stdout, /imp update/);
  assert.match(res.stdout, /imp doctor/);
  assert.match(res.stdout, /imp fix/);
  assert.match(res.stdout, /login openai-codex/);
});

test('imp: --help and -h are the same help path', async () => {
  for (const flag of ['--help', '-h']) {
    const res = await runImp([flag]);
    assert.equal(res.code, 0);
    assert.match(res.stdout, /Usage:/);
  }
});

test('imp: --version prints the package.json version, nothing else', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const res = await runImp(['--version']);
  assert.equal(res.code, 0);
  assert.equal(res.stdout.trim(), pkg.version);
});

test('imp: init forwards args to the installer (init --help shows installer usage)', async () => {
  const res = await runImp(['init', '--help']);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /impactus/);
  assert.match(res.stdout, /Usage:/);
  assert.match(res.stdout, /npx impactus/);
});

test('imp: everything else is passed straight to pi, stdout untouched', { skip: process.platform === 'win32' }, async () => {
  // Fake `pi` first on PATH: prints its argv and exits 7 — proves both the
  // pass-through args and the exit-code forwarding without a real agent.
  const dir = mkdtempSync(join(tmpdir(), 'imp-fake-pi-'));
  const fakePi = join(dir, 'pi');
  writeFileSync(fakePi, '#!/bin/sh\necho "FAKE-PI:$@"\nexit 7\n');
  chmodSync(fakePi, 0o755);
  const env = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` };

  const res = await runImp(['--continue', '--no-color'], { env });
  assert.equal(res.code, 7);
  // Piped stdout (non-TTY, as here) must carry ONLY Pi's output — no banner —
  // so scripts and other processes can parse `imp -p …` exactly like `pi -p …`.
  assert.equal(res.stdout.trim(), 'FAKE-PI:--continue --no-color');
});
