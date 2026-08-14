// Smoke tests for the bin entry point (bin/create-iai.js) as a real child
// process: --help/--version exit paths, and the parseArgs regression where
// `--name=--test` made the old parser reprocess the same token forever
// (growing `errors` until OOM) instead of failing fast with a readable error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/create-iai.js', import.meta.url));

function runBin(args, { timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { timeout, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ code: error ? (error.code ?? 1) : 0, killed: Boolean(error?.killed), stdout, stderr });
      },
    );
  });
}

test('bin: --help exits 0 and prints the usage', async () => {
  const res = await runBin(['--help']);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /impactus/);
  assert.match(res.stdout, /Usage:/);
  assert.match(res.stdout, /npx impactus/);
});

test('bin: --version prints the package.json version', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const res = await runBin(['--version']);
  assert.equal(res.code, 0);
  assert.equal(res.stdout.trim(), pkg.version);
});

test('bin: --name=--test fails fast with a readable error (parser loop regression)', async () => {
  const started = Date.now();
  const res = await runBin(['--name=--test'], { timeout: 10000 });
  const elapsed = Date.now() - started;

  // The old bug rewound argv forever and died by OOM/timeout; the fix rejects
  // the flag-looking value immediately.
  assert.equal(res.killed, false, 'process should exit on its own, not be killed by the timeout');
  assert.ok(elapsed < 5000, `should exit fast (took ${elapsed}ms)`);
  assert.notEqual(res.code, 0);
  // Cause + recovery, in plain language (non-technical audience).
  assert.match(res.stderr, /--name flag needs a value/);
  assert.match(res.stderr, /--help/);
});

test('bin: unknown flag aborts with a pointer to --help', async () => {
  const res = await runBin(['--definitely-not-a-flag']);
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /Unknown flag: --definitely-not-a-flag/);
  assert.match(res.stderr, /--help/);
});
