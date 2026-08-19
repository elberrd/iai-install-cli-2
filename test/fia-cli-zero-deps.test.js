// The gate self-test and the holdout runner must work in a project whose
// imp/node_modules was never installed — that is exactly the state
// `imp doctor` exists to diagnose, so a self-test that needs a native module
// to report "your project is broken" is no self-test at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEMPLATES = join(import.meta.dirname, '..', 'fia-templates');

/** A stamped project with imp/modules + imp/scripts and NO imp/node_modules. */
function stampWithoutDeps() {
  const root = mkdtempSync(join(tmpdir(), 'fia-nodeps-'));
  mkdirSync(join(root, 'imp'), { recursive: true });
  cpSync(join(TEMPLATES, 'modules'), join(root, 'imp', 'modules'), { recursive: true });
  cpSync(join(TEMPLATES, 'scripts'), join(root, 'imp', 'scripts'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'p', type: 'module' }) + '\n');
  return root;
}

function runScript(root, script, args = []) {
  return execFileSync(process.execPath, [join(root, 'imp', 'scripts', script), ...args], {
    cwd: root,
    encoding: 'utf8',
    // A dependency error would surface on stderr and as a non-zero exit.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('gate-probes runs with no imp/node_modules — no native dependency in its graph', () => {
  const root = stampWithoutDeps();
  const out = runScript(root, 'gate-probes.mjs');
  assert.match(out, /GATE_PROBES total=\d+ caught=\d+\/\d+/);
});

test('the holdout runner runs with no imp/node_modules', () => {
  const root = stampWithoutDeps();
  const out = runScript(root, 'holdout.mjs');
  assert.match(out, /HOLDOUT_EMPTY/);
  // The empty-state message must stand on its own: an upgraded project never
  // receives imp/data/, so it cannot point at a README that is not there.
  assert.doesNotMatch(out, /README/);
});

test('the stop button runs with no imp/node_modules', () => {
  const root = stampWithoutDeps();
  assert.match(runScript(root, 'fia-stop.mjs', ['--status']), /stop button not armed/);
});

test('fda-lock.mjs stays self-contained — it is copied ALONE into hook contexts', () => {
  // The Claude and Cursor hooks import imp/scripts/fda-lock.mjs from a project
  // that may not have imp/modules/ reachable. A cross-directory import here
  // turns the write guard into a silent no-op, so the contract is asserted
  // rather than remembered.
  const src = readFileSync(join(TEMPLATES, 'scripts', 'fda-lock.mjs'), 'utf8');
  const imports = [...src.matchAll(/^import[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  const external = imports.filter((i) => !i.startsWith('node:'));
  assert.deepEqual(external, [], `fda-lock.mjs must import only node: builtins, found: ${external.join(', ')}`);
});
