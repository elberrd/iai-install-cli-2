// Smoke tests for the `imp` launcher (bin/imp.js) as a real child process:
// help/version exit paths, init forwarding to the installer, and the
// pass-everything-else-to-Pi contract (exercised against a fake `pi` binary
// on PATH so no real agent ever starts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/imp.js', import.meta.url));

function runImp(args, { env = process.env, timeout = 30000, cwd } = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { timeout, env, cwd, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 },
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
  assert.match(res.stdout, /imp health/);
  assert.match(res.stdout, /imp llm/);
  assert.match(res.stdout, /imp defer/);
  assert.match(res.stdout, /imp rewind/);
  assert.match(res.stdout, /imp notify/);
  assert.match(res.stdout, /imp settings/);
  assert.match(res.stdout, /login openai-codex/);
});

// The four verbs added on top of the original five must be intercepted BEFORE
// the pass-everything-to-Pi fallthrough. `settings` in particular is deliberately
// not called `config`: `pi config` is a real Pi command and must keep working.
test('imp: the project-stamped reporters refuse outside a project instead of reaching Pi', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'imp-no-runtime-'));
  for (const [verb, script] of [
    ['health', 'loop-health.mjs'],
    ['llm', 'fia-llm.mjs'],
    ['defer', 'task-defer.mjs'],
    ['rewind', 'rewind.mjs'],
    ['notify', 'notify.mjs'],
  ]) {
    const res = await runImp([verb], { env: { ...process.env, PI_OFFLINE: '1' }, cwd: empty });
    assert.equal(res.code, 1, `${verb} should exit 1 without a runtime`);
    assert.match(res.stderr, new RegExp(`imp/scripts/${script.replace('.', '\\.')}`), `${verb} names the missing script`);
    assert.match(res.stderr, /imp init|--update-runtime/, `${verb} names the fix`);
  }
});

test('imp: a stamped reporter that dies on an INCOMPLETE runtime gets a diagnosis, not just a stack', async () => {
  // The runtime imports itself, so one missing sibling kills the child at module
  // resolution. The existsSync guard cannot see that — the hint has to come
  // after the failure, and only when files really are missing.
  const { listTemplateFiles, isRuntimeCode } = await import('../src/lib/runtime-health.js');
  const files = (await listTemplateFiles()).filter(isRuntimeCode);
  const root = mkdtempSync(join(tmpdir(), 'imp-partial-'));
  const PKG = fileURLToPath(new URL('..', import.meta.url));
  for (const rel of files) {
    if (rel.endsWith('/wiki-check.mjs')) continue; // the sibling fia-launch-check imports
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    // The REAL bytes, not a stub: a stub would exit 0 and prove nothing.
    copyFileSync(join(PKG, rel.replace(/^imp\//, 'fia-templates/')), join(root, rel));
  }
  const res = await runImp(['health'], { env: { ...process.env, PI_OFFLINE: '1' }, cwd: root });
  assert.equal(res.code, 1, "the child's exit code is preserved");
  assert.match(res.stderr, /runtime file\(s\) are missing/, 'the student is told what is wrong');
  assert.match(res.stderr, /imp fix/, 'and which command repairs it');
  assert.match(res.stderr, /--update-runtime/);
});

test('imp: settings is read-only, machine-scoped and never shadows `pi config`', async () => {
  const home = mkdtempSync(join(tmpdir(), 'imp-settings-home-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, PI_OFFLINE: '1' };
  const res = await runImp(['settings', '--path'], { env });
  assert.equal(res.code, 0);
  // --path is the scriptable form: ONLY the path, no banner.
  assert.equal(res.stdout.trim(), join(home, '.impactus-cli', 'config.json'));

  const asJson = await runImp(['settings', '--json'], { env });
  assert.equal(asJson.code, 0);
  const report = JSON.parse(asJson.stdout);
  assert.equal(report.exists, false, 'no config file on a fresh home');
  assert.ok(Array.isArray(report.values) && report.values.length > 0);
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
