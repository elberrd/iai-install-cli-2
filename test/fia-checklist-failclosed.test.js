// Escape-hatch audit regression: deleting the brief must never stand the
// checklist gate down. The session marker remembers the file the run started
// from, and a gate whose input disappeared is loud, not absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveBriefPath, runChecklistGate } from '../fia-templates/modules/checklist.mjs';
import { Tracer } from '../fia-templates/modules/tracer.mjs';
import { Run } from '../fia-templates/modules/runner.mjs';

function makeRun(root, id) {
  const cfg = { defaults: { data_dir: root }, observability: { db: join(root, 'fia.db') } };
  const tracer = new Tracer(cfg.observability.db, join(root, 'sessions', id, 'events.jsonl'));
  tracer.sessionStart(id, 'Tester', 'fda_test');
  return new Run(cfg, id, tracer, 'Tester');
}

test('resolveBriefPath: the recorded brief path survives the file being deleted (fail closed downstream)', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-brief-'));
  const brief = join(root, 'brief.md');
  writeFileSync(brief, '# T\n- [ ] box\n');
  const run = makeRun(root, 'b1');
  assert.equal(resolveBriefPath(run, brief), brief);

  rmSync(brief);
  const resumed = makeRun(root, 'b1');
  assert.equal(resolveBriefPath(resumed, ''), brief, 'a vanished brief must still reach the gate, not read as an inline prompt');
});

test('checklist gate: a brief deleted mid-run FAILS the run instead of skipping the gate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-brief-'));
  const brief = join(root, 'tasks', 'brief.md');
  mkdirSync(join(root, 'tasks'), { recursive: true });
  writeFileSync(brief, '# T\n- [ ] unchecked promise\n');
  const run = makeRun(root, 'b2');
  rmSync(brief); // "the builder deleted the brief" — the classic gate escape
  await assert.rejects(runChecklistGate(run, brief), /deleted brief is not a reconciled checklist/);
});

test('checklist gate: an inline prompt (no brief file, no marker) still skips legitimately', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-brief-'));
  const run = makeRun(root, 'b3');
  const result = await runChecklistGate(run, resolveBriefPath(run, 'just an inline ask, not a path'));
  assert.equal(result, null, 'proportionality: prompts that never came from a brief have nothing to reconcile');
});

test('checklist gate: gutting the brief (boxes deleted) is refused, not skipped as "no checklist"', async () => {
  // The deleted-FILE fix left the sibling escape open: keep the file, delete
  // the Acceptance Criteria section, and the gate used to stand down because
  // the brief "has no checkboxes".
  const root = mkdtempSync(join(tmpdir(), 'fia-brief-'));
  const brief = join(root, 'brief.md');
  writeFileSync(brief, '# T\n\n## Acceptance Criteria\n- [ ] the hard one\n- [ ] the other one\n');
  const run = makeRun(root, 'g1');
  resolveBriefPath(run, brief); // records the baseline: 2 boxes

  writeFileSync(brief, '# T\n\nAll done, trust me.\n'); // the boxes are gone
  await assert.rejects(runChecklistGate(run, brief), /checklist disappeared during the run/);
});

test('checklist gate: fencing the boxes in a code block counts as gutting too', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-brief-'));
  const brief = join(root, 'brief.md');
  writeFileSync(brief, '# T\n\n- [ ] the hard one\n');
  const run = makeRun(root, 'g2');
  resolveBriefPath(run, brief);

  writeFileSync(brief, '# T\n\n```\n- [ ] the hard one\n```\n'); // parsed as code, not boxes
  await assert.rejects(runChecklistGate(run, brief), /checklist disappeared during the run/);
});

test('checklist gate: dropping SOME boxes before the first check is refused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-brief-'));
  const brief = join(root, 'brief.md');
  writeFileSync(brief, '# T\n\n- [ ] one\n- [ ] two\n- [ ] three\n');
  const run = makeRun(root, 'g3');
  resolveBriefPath(run, brief);

  writeFileSync(brief, '# T\n\n- [x] one\n');
  await assert.rejects(runChecklistGate(run, brief), /shrank during the run/);
});

test('checklist gate: a brief that NEVER had boxes still skips (proportionality kept)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-brief-'));
  const brief = join(root, 'brief.md');
  writeFileSync(brief, '# T\n\nJust prose, no checklist.\n');
  const run = makeRun(root, 'g4');
  resolveBriefPath(run, brief);
  assert.equal(await runChecklistGate(run, brief), null);
});
