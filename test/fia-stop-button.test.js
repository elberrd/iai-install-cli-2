// The manual stop button (imp stop): a stop button that has never been used
// is a stop button nobody knows works — these tests press it on purpose, in
// both directions, including the fail-closed reading of an unreadable file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { manualStopState, manualStopPath } from '../fia-templates/modules/stop.mjs';
import { runCli } from '../fia-templates/scripts/fia-stop.mjs';
import { Tracer } from '../fia-templates/modules/tracer.mjs';
import { Run } from '../fia-templates/modules/runner.mjs';
import { phaseParams } from '../fia-templates/modules/fda-cli.mjs';

function freshDir(prefix = 'fia-stop-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeRun(root, id) {
  const cfg = { defaults: { data_dir: root }, observability: { db: join(root, 'fia.db') } };
  const tracer = new Tracer(cfg.observability.db, join(root, 'sessions', id, 'events.jsonl'));
  tracer.sessionStart(id, 'Tester', 'fda_test');
  return new Run(cfg, id, tracer, 'Tester');
}

test('manualStopState: a clean absence is the ONE reading that does not stop', () => {
  assert.equal(manualStopState(freshDir()).stopped, false);
});

test('manualStopState: a JSON stop file stops, carrying its reason', () => {
  const dir = freshDir();
  writeFileSync(join(dir, 'fia-stop'), JSON.stringify({ reason: 'pausing for the demo' }));
  const state = manualStopState(dir);
  assert.equal(state.stopped, true);
  assert.equal(state.reason, 'pausing for the demo');
});

test('manualStopState: a hand-made stop file (touch/echo) stops too', () => {
  const dir = freshDir();
  writeFileSync(join(dir, 'fia-stop'), 'stop please');
  const state = manualStopState(dir);
  assert.equal(state.stopped, true);
  assert.equal(state.reason, 'stop please');
});

test('manualStopState: an UNREADABLE stop file fails closed — it still stops', () => {
  const dir = freshDir();
  mkdirSync(join(dir, 'fia-stop')); // a directory where the file belongs → read error that is not ENOENT
  const state = manualStopState(dir);
  assert.equal(state.stopped, true);
  assert.match(state.reason, /failing closed/);
});

test('runner: an armed stop button ends the run BEFORE the next phase, with the named outcome', async () => {
  const root = freshDir();
  const run = makeRun(root, 's1');
  await run.runPhase(phaseParams('plan', 'engineer', 'engineer', 'Capture the ask'), async () => ({ ok: true }));
  writeFileSync(manualStopPath(root), JSON.stringify({ reason: 'user pressed stop' }));
  await assert.rejects(
    run.runPhase(phaseParams('build', 'agent', 'builder', 'Would spend tokens if it ran'), async () => ({ ok: true })),
    (err) => err.name === 'StopCondition' && err.outcome === 'stopped_by_request',
  );
  assert.equal(run.outcome, 'stopped_by_request');
  assert.equal(run.phases.length, 1, 'the stopped phase must never have been created');
});

test('cli: arm → status → clear round-trips, and clearing verifies the file is really gone', () => {
  const root = freshDir();
  mkdirSync(join(root, 'imp', 'data'), { recursive: true });
  const stopFile = join(root, 'imp', 'data', 'fia-stop');

  assert.equal(runCli(['--reason', 'coffee break'], { root }), 0);
  assert.ok(existsSync(stopFile), 'arming must create the stop file');
  assert.equal(runCli(['--status'], { root }), 0);
  assert.equal(runCli(['--clear'], { root }), 0);
  assert.ok(!existsSync(stopFile), 'clearing must remove the stop file');
  assert.equal(runCli(['--status'], { root }), 0);
});

test('cli: arming without imp/data existing yet still works (mkdir -p semantics)', () => {
  const root = freshDir();
  assert.equal(runCli([], { root }), 0);
  assert.ok(existsSync(join(root, 'imp', 'data', 'fia-stop')));
});

test('a moved data_dir cannot make the button fail OPEN — the canonical path is checked too', () => {
  // `imp stop` is dependency-free and always writes imp/data/fia-stop, while a
  // run reads `defaults.data_dir`. If the reader only looked at the configured
  // directory, a project that moved data_dir would show "ARMED" while the run
  // kept going — a stop button that fails open is worse than none.
  const repo = freshDir('fia-stop-repo-');
  mkdirSync(join(repo, 'imp', 'state'), { recursive: true }); // the moved data_dir
  mkdirSync(join(repo, 'imp', 'data'), { recursive: true });
  const moved = join(repo, 'imp', 'state');

  assert.equal(manualStopState(moved, repo).stopped, false);
  assert.equal(runCli([], { root: repo }), 0); // writes the CANONICAL imp/data/fia-stop
  assert.equal(manualStopState(moved, repo).stopped, true, 'the run must see the button a student actually pressed');
  assert.equal(runCli(['--clear'], { root: repo }), 0);
  assert.equal(manualStopState(moved, repo).stopped, false);
});

test('without a repoRoot the reader still honors the configured directory alone', () => {
  const dir = freshDir();
  writeFileSync(join(dir, 'fia-stop'), '{}');
  assert.equal(manualStopState(dir).stopped, true);
});

test('a moved data_dir: the CLI arms where the RUN reads, and --clear disarms both candidates', () => {
  const repo = freshDir('fia-stop-moved-');
  mkdirSync(join(repo, 'imp'), { recursive: true });
  writeFileSync(join(repo, 'imp', 'fia.config.yaml'), 'defaults:\n  data_dir: imp/state\n');
  const moved = join(repo, 'imp', 'state');

  assert.equal(runCli([], { root: repo }), 0);
  assert.ok(existsSync(join(moved, 'fia-stop')), 'the CLI arms the configured directory');
  assert.equal(manualStopState(moved, repo).stopped, true);

  // A file left in the canonical directory (a hand `touch`, or an older CLI)
  // must also be visible and removable — the runtime reader honors both.
  mkdirSync(join(repo, 'imp', 'data'), { recursive: true });
  writeFileSync(join(repo, 'imp', 'data', 'fia-stop'), '{}');
  assert.equal(runCli(['--clear'], { root: repo }), 0);
  assert.equal(manualStopState(moved, repo).stopped, false, 'nothing may still stop the run after a clean --clear');
  assert.equal(existsSync(join(repo, 'imp', 'data', 'fia-stop')), false);
});
