// Holdout probes (modules/holdout.mjs): acceptance checks outside the
// builder's optimization loop. Skip is only for a project with NO probes; a
// violation fails the run with no repair round.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listHoldoutProbes, runHoldoutProbes, runHoldoutGate } from '../fia-templates/modules/holdout.mjs';
import { runCli } from '../fia-templates/scripts/holdout.mjs';
import { Tracer } from '../fia-templates/modules/tracer.mjs';
import { Run } from '../fia-templates/modules/runner.mjs';

function freshData(probes = {}) {
  const data = mkdtempSync(join(tmpdir(), 'fia-holdout-'));
  if (Object.keys(probes).length) {
    mkdirSync(join(data, 'holdout'), { recursive: true });
    for (const [name, body] of Object.entries(probes)) writeFileSync(join(data, 'holdout', name), body);
  }
  return data;
}

function makeRun(root, id) {
  const cfg = { defaults: { data_dir: root }, observability: { db: join(root, 'fia.db') } };
  const tracer = new Tracer(cfg.observability.db, join(root, 'sessions', id, 'events.jsonl'));
  tracer.sessionStart(id, 'Tester', 'fda_test');
  return new Run(cfg, id, tracer, 'Tester');
}

test('listHoldoutProbes: sorted, README and _helpers excluded, absence is empty not an error', () => {
  const data = freshData({
    '002-b.mjs': '',
    '001-a.mjs': '',
    '_helper.mjs': '',
    'README.md': '',
  });
  const names = listHoldoutProbes(data).map((f) => f.split(/[\\/]/).pop());
  assert.deepEqual(names, ['001-a.mjs', '002-b.mjs']);
  assert.deepEqual(listHoldoutProbes(mkdtempSync(join(tmpdir(), 'fia-holdout-none-'))), []);
});

test('runHoldoutProbes: exit 0 holds, non-zero violates, and the output is captured for the human', async () => {
  const data = freshData({
    '001-holds.mjs': 'console.log("invariant ok");',
    '002-violated.mjs': 'console.error("cap was raised"); process.exit(1);',
  });
  const report = await runHoldoutProbes({ repoRoot: data, dataDir: data });
  assert.equal(report.scenarios, 2);
  assert.equal(report.passed, false);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].name, '002-violated.mjs');
  assert.match(report.failures[0].output, /cap was raised/);
});

test('gate: no probes → the phase skips itself with a logged reason', async () => {
  const root = freshData();
  const run = makeRun(root, 'h1');
  const result = await runHoldoutGate(run);
  assert.equal(result.skip, true);
  assert.equal(run.phases.at(-1)?.status, 'success');
});

test('gate: a violated probe FAILS the run — and the builder gets no repair round', async () => {
  const root = freshData({ '001-fails.mjs': 'console.error("holdout scenario violated"); process.exit(1);' });
  const run = makeRun(root, 'h2');
  await assert.rejects(runHoldoutGate(run), /holdout violated — 1 of 1/);
  assert.equal(run.outcome, 'failed');
  const names = run.phases.map((p) => p.params.name);
  assert.deepEqual(names, ['holdout'], 'no fix_* phase may follow a holdout violation');
});

test('gate: green probes report the HOLDOUT_PASSED marker into the trace', async () => {
  const root = freshData({ '001-holds.mjs': 'process.exit(0);' });
  const run = makeRun(root, 'h3');
  const result = await runHoldoutGate(run);
  assert.deepEqual(result, { skip: false, scenarios: 1 });
});

test('cli: --require makes an empty holdout a failure; green emits the literal marker', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'fia-holdout-cli-'));
  mkdirSync(join(bare, 'imp', 'data'), { recursive: true });
  assert.equal(await runCli([], { root: bare }), 0, 'empty without --require is a skip');
  assert.equal(await runCli(['--require'], { root: bare }), 1, 'empty with --require is a lowered gate');

  mkdirSync(join(bare, 'imp', 'data', 'holdout'), { recursive: true });
  writeFileSync(join(bare, 'imp', 'data', 'holdout', '001-ok.mjs'), 'process.exit(0);');
  assert.equal(await runCli([], { root: bare }), 0);
  writeFileSync(join(bare, 'imp', 'data', 'holdout', '002-bad.mjs'), 'process.exit(3);');
  assert.equal(await runCli([], { root: bare }), 1);
});
