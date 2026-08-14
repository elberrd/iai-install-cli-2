import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Tracer } from '../fia-templates/modules/tracer.mjs';
import { Run } from '../fia-templates/modules/runner.mjs';
import { phaseParams } from '../fia-templates/modules/fda-cli.mjs';

function makeRun(root, id, opts) {
  const cfg = { defaults: { data_dir: root }, observability: { db: join(root, 'fia.db') } };
  const tracer = new Tracer(cfg.observability.db, join(root, 'sessions', id, 'events.jsonl'));
  tracer.sessionStart(id, 'Tester', 'fda_test');
  return new Run(cfg, id, tracer, 'Tester', opts);
}

test('resume: code phases always re-run — a saved failed suite result is never replayed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-runner-'));

  // First run: the test phase "succeeds" as a phase while carrying passed:false.
  const run1 = makeRun(root, 'c1');
  await run1.runPhase(
    phaseParams('test_1', 'code', 'quality', 'Run the suite against the current tree'),
    async () => ({ passed: false }),
  );
  assert.ok(existsSync(join(root, 'sessions', 'c1', 'phase_results', 'test_1.json')));

  // Resume: replaying that result would make the retry a no-op — it must re-run.
  const run2 = makeRun(root, 'c1', { resume: true });
  let executed = false;
  const result = await run2.runPhase(
    phaseParams('test_1', 'code', 'quality', 'Run the suite against the current tree'),
    async () => {
      executed = true;
      return { passed: true };
    },
  );
  assert.equal(executed, true, 'code phase was replayed instead of re-executed');
  assert.equal(result.passed, true);
});

test('finish: a resume run whose phases were all replayed still reports success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-runner-'));
  const run1 = makeRun(root, 'c2');
  await run1.runPhase(phaseParams('plan', 'engineer', 'engineer', 'Produce the plan payload'), async () => ({ ok: true }));
  assert.equal(run1.finish({ accepted: true }), 0);

  const run2 = makeRun(root, 'c2', { resume: true });
  await run2.runPhase(phaseParams('plan', 'engineer', 'engineer', 'Produce the plan payload'), async () => ({ ok: true }));
  assert.equal(run2.phases.length, 0, 'expected the phase to be replayed, not executed');
  assert.equal(run2.replayed, 1);
  assert.equal(run2.finish({ accepted: true }), 0, 'all-replayed run must not be reported as FAIL');
});

test('phaseParams: agent phases default to 1 gate retry; code phases to 0; explicit wins', () => {
  assert.equal(phaseParams('x', 'agent', 'builder', 'Send the ask to the builder').retries, 1);
  assert.equal(phaseParams('x', 'code', 'quality', 'Run a deterministic command').retries, 0);
  assert.equal(phaseParams('x', 'engineer', 'me', 'Capture the ask').retries, 0);
  assert.equal(phaseParams('x', 'agent', 'builder', 'Send the ask to the builder', { retries: 3 }).retries, 3);
});
