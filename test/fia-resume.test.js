import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Tracer } from '../fia-templates/modules/tracer.mjs';
import { Run } from '../fia-templates/modules/runner.mjs';
import { phaseParams } from '../fia-templates/modules/fda-cli.mjs';
import { ensure } from '../fia-templates/modules/session.mjs';

function makeRun(root, id, opts) {
  const cfg = { defaults: { data_dir: root }, observability: { db: join(root, 'fia.db') } };
  const tracer = new Tracer(cfg.observability.db, join(root, 'sessions', id, 'events.jsonl'));
  tracer.sessionStart(id, 'Tester', 'fda_test');
  return new Run(cfg, id, tracer, 'Tester', opts);
}

test('resume: succeeded phases replay their saved result; failed phase re-runs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-resume-'));

  // First run: plan succeeds, review fails.
  const run1 = makeRun(root, 'r1');
  const plan = await run1.runPhase(
    phaseParams('plan', 'engineer', 'engineer', 'Produce the plan payload'),
    async () => ({ artifacts: ['specs/x.md'], summary: 'plan' }),
  );
  assert.equal(plan.summary, 'plan');
  await assert.rejects(
    run1.runPhase(phaseParams('review', 'engineer', 'engineer', 'Reject to simulate a failed gate'), async () => {
      throw new Error('simulated PermissionBreach');
    }),
  );
  assert.ok(existsSync(join(root, 'sessions', 'r1', 'phase_results', 'plan.json')));
  assert.equal(existsSync(join(root, 'sessions', 'r1', 'phase_results', 'review.json')), false);

  // Resume: plan must NOT execute again; review runs and passes.
  const run2 = makeRun(root, 'r1', { resume: true });
  let planExecuted = false;
  const planAgain = await run2.runPhase(
    phaseParams('plan', 'engineer', 'engineer', 'Produce the plan payload'),
    async () => {
      planExecuted = true;
      return { summary: 'should not run' };
    },
  );
  assert.equal(planExecuted, false, 'succeeded phase was re-executed on resume');
  assert.deepEqual(planAgain, { artifacts: ['specs/x.md'], summary: 'plan' });
  const review = await run2.runPhase(
    phaseParams('review', 'engineer', 'engineer', 'Approve on the second attempt'),
    async () => ({ approved: true }),
  );
  assert.equal(review.approved, true);
  assert.equal(run2.finish({ accepted: true }), 0);
});

test('resume: a `replay: false` phase re-executes even with a saved result', async () => {
  // ui_verify's contract: its verdict is about the CURRENT tree, so a saved
  // (possibly rejecting) envelope must never be replayed — or a failed UI
  // gate would be a permanent dead end on --resume.
  const root = mkdtempSync(join(tmpdir(), 'fia-resume-'));
  const params = phaseParams('ui_verify', 'engineer', 'engineer', 'Re-audit against the current tree', { replay: false });

  const run1 = makeRun(root, 'r4');
  const first = await run1.runPhase(params, async () => ({ approved: false }));
  assert.equal(first.approved, false);
  assert.ok(existsSync(join(root, 'sessions', 'r4', 'phase_results', 'ui_verify.json')));

  const run2 = makeRun(root, 'r4', { resume: true });
  let executed = false;
  const second = await run2.runPhase(params, async () => {
    executed = true;
    return { approved: true };
  });
  assert.equal(executed, true, 'replay: false phase must re-run on resume');
  assert.equal(second.approved, true);
});

test('resume: fresh run (no flag) executes every phase even with saved results', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-resume-'));
  const run1 = makeRun(root, 'r2');
  await run1.runPhase(phaseParams('plan', 'engineer', 'engineer', 'Produce the plan payload'), async () => ({ v: 1 }));

  const run2 = makeRun(root, 'r2');
  let executed = false;
  const out = await run2.runPhase(phaseParams('plan', 'engineer', 'engineer', 'Produce the plan payload'), async () => {
    executed = true;
    return { v: 2 };
  });
  assert.equal(executed, true);
  assert.equal(out.v, 2);
  assert.equal(JSON.parse(readFileSync(join(root, 'sessions', 'r2', 'phase_results', 'plan.json'), 'utf8')).result.v, 2);
});

test('resume: ensure() rejects resume without an fda_id', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-resume-'));
  const cfg = { defaults: { data_dir: root }, observability: { db: join(root, 'fia.db') } };
  assert.throws(() => ensure(cfg, null, { resume: true }), /resume requires the fda_id/);
});
