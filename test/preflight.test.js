import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkEngines, installPlan } from '../src/steps/preflight.js';

// The engines probe is informational by contract: with NOTHING on PATH it must
// still resolve (no prompt, no process.exit) and record the status in ctx.
// A reintroduced gate would hang or kill this run — that's the guard.
test('checkEngines: never blocks — resolves and records status even with no engine on PATH', async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = '';
  const ctx = {};
  try {
    await checkEngines(ctx);
  } finally {
    process.env.PATH = originalPath;
  }
  assert.equal(ctx.engines.claude, false);
  assert.equal(typeof ctx.engines.codex, 'boolean');
});

// `installPlan` depends on the OS via osKind() (reads process.platform), so we
// pin the platform in each case.
function onPlatform(value, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

test('installPlan: gh on apt uses the official repository, not `apt-get install gh`', () => {
  const plan = onPlatform('linux', () => installPlan('gh', { 'apt-get': true }));
  assert.equal(plan.bin, 'bash');
  const script = plan.args[1];
  // The bug was exactly this command — `gh` doesn't exist in the Debian repos.
  assert.ok(!/apt-get install -y gh\s*$/m.test(script) || /cli\.github\.com/.test(script));
  assert.match(script, /cli\.github\.com\/packages/, 'must register the GitHub CLI source');
  assert.match(script, /githubcli-archive-keyring\.gpg/, 'must register the signed key');
  assert.match(script, /apt-get update/, 'update before install');
  assert.match(script, /apt-get install -y gh/);
});

test('installPlan: git on apt runs update before install', () => {
  const plan = onPlatform('linux', () => installPlan('git', { 'apt-get': true }));
  assert.equal(plan.bin, 'bash');
  assert.match(plan.args[1], /apt-get update;\s*sudo apt-get install -y git/);
});

test('installPlan: git on windows uses winget (Git.Git) or choco as fallback', () => {
  assert.deepEqual(
    onPlatform('win32', () => installPlan('git', { winget: true })),
    {
      bin: 'winget',
      args: ['install', '--id', 'Git.Git', '-e', '--source', 'winget'],
    },
  );
  assert.deepEqual(
    onPlatform('win32', () => installPlan('git', { choco: true })),
    {
      bin: 'choco',
      args: ['install', 'git', '-y'],
    },
  );
  // gh on winget has its own id.
  assert.equal(onPlatform('win32', () => installPlan('gh', { winget: true })).args[2], 'GitHub.cli');
});

test('installPlan: git on mac without brew → null (manual path suggests xcode-select)', () => {
  // The step then instructs `xcode-select --install` via manualHint — a Mac
  // without Homebrew still has the native CLT route for git.
  assert.equal(
    onPlatform('darwin', () => installPlan('git', {})),
    null,
  );
});

test('installPlan: non-apt paths stay unchanged', () => {
  assert.deepEqual(
    onPlatform('darwin', () => installPlan('gh', { brew: true })),
    {
      bin: 'brew',
      args: ['install', 'gh'],
    },
  );
  assert.deepEqual(
    onPlatform('linux', () => installPlan('gh', { dnf: true })),
    {
      bin: 'sudo',
      args: ['dnf', 'install', '-y', 'gh'],
    },
  );
  // vercel has no formula: npm global on every OS.
  assert.deepEqual(
    onPlatform('linux', () => installPlan('vercel', { 'apt-get': true })),
    {
      bin: 'npm',
      args: ['install', '-g', 'vercel'],
    },
  );
  // No known package manager → null (the step instructs manually).
  assert.equal(
    onPlatform('linux', () => installPlan('gh', {})),
    null,
  );
});
