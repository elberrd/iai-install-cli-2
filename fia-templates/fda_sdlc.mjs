#!/usr/bin/env node
/** FDA SDLC — plan → build → test → review → document. */
import { runFda, phaseParams } from './modules/fda-cli.mjs';
import { artifactsExist, filesNonEmpty, verdictConsistent, parseSpecLine, checkSpecCoverage, checkSpecDiagram, isFoundationBrief } from './modules/gates.mjs';
import { resolveBriefPath, runChecklistGate } from './modules/checklist.mjs';
import { runUiGate } from './modules/ui-gate.mjs';
import { runTestsForBrief } from './modules/quality.mjs';
import { floorPath } from './modules/floor.mjs';
import { runHoldoutGate } from './modules/holdout.mjs';
import { runSpecDeliveryClose } from './modules/spec-lifecycle.mjs';
import * as git from './modules/git-helper.mjs';

await runFda(
  async ({ run, prompt, args }) => {
    const briefPath = resolveBriefPath(run, args.prompt);
    await run.runPhase(phaseParams('request', 'engineer', run.engineer, 'Capture the SDLC feature request'), async (ph) => {
      ph.log({ input: prompt });
    });

    const plan = await run.runPhase(
      phaseParams('plan', 'agent', 'planner', 'Define scope and steps before implementation'),
      async (ph) => ph.call({ outputType: 'PlanOutput', prompt, gates: [artifactsExist, filesNonEmpty] }),
    );

    const build = await run.runPhase(
      phaseParams('build', 'agent', 'builder', 'Implement according to the plan'),
      async (ph) => ph.call({ outputType: 'BuildOutput', prompt, previous: plan, gates: [artifactsExist] }),
    );

    const test = await run.runPhase(
      phaseParams('test', 'code', 'quality', 'Verify the suite passes before review'),
      async (ph) => {
        // Foundation briefs also run `npm run build` here — deterministic,
        // before review ever sees the work (see runTestsForBrief).
        const result = await runTestsForBrief(run, prompt);
        ph.log({ passed: result.passed, checks: result.checks.map((c) => c.name).join('+') });
        return result;
      },
    );

    let reconcile = null;
    let uiFix = null;
    if (test.passed) {
      // Spec-coverage gate (C7): active only when the brief carries a
      // `Spec: NNNN (…)` line — briefs without one skip it, by design.
      const ref = parseSpecLine(prompt);
      await run.runPhase(
        phaseParams('spec_coverage', 'code', 'quality', 'Verify every promised spec id has a test marker covering it'),
        async (ph) => {
          if (!ref) {
            ph.log({ skipped: 'no Spec: line in the brief' });
            return;
          }
          const report = checkSpecCoverage({ specId: ref.specId, ids: ref.ids, repoRoot: run.repoRoot });
          if (!report.passed) throw new Error(`spec coverage incomplete:\n- ${report.violations.join('\n- ')}`);
          ph.log({ spec: ref.specId, covered: ref.ids.join(',') });
          // A spec with no `## Flow` diagram is a documentation gap, not a broken
          // build: it is recorded in the trace here and enforced (warn) by the
          // launch check, so a missing diagram never blocks an otherwise green run.
          const diagram = checkSpecDiagram({
            specId: ref.specId,
            aiDocsDir: process.env.FIA_AI_DOCS || 'ai-docs',
            repoRoot: run.repoRoot,
          });
          if (!diagram.passed) ph.log({ diagram: `missing — ${diagram.violations[0]}` });
        },
      );

      // Acceptance-checklist gate (C8): the brief's checkboxes must all be
      // reconciled before REVIEW — the reviewer audits the ticks against the
      // diff (a false tick is grounds for rejection), and the run cannot
      // close with boxes left unchecked (see modules/checklist.mjs).
      reconcile = await runChecklistGate(run, briefPath);

      // UI-conformance gate: runs whenever this run changed frontend
      // component files (a `Surface:` line without `ui` stands it down) —
      // before review, so the reviewer sees conformance already settled
      // (see modules/ui-gate.mjs).
      uiFix = await runUiGate(run, prompt);

      // Holdout probes: acceptance checks written with the brief, stored where
      // agents cannot write, run with NO repair round (modules/holdout.mjs).
      // Skips itself when imp/data/holdout/ carries no probes.
      await runHoldoutGate(run);
    }

    const review = await run.runPhase(
      // retries: 1 — an inconsistent verdict (approved=true with unmet findings)
      // gets one correction round: the reviewer re-emits either a clean approval or
      // a rejection with findings, instead of crashing the run on the gate.
      phaseParams('review', 'agent', 'reviewer', 'Confirm the build matches the original ask', { retries: 1 }),
      async (ph) =>
        ph.call({
          outputType: 'ReviewOutput',
          prompt,
          previous: build,
          gates: [verdictConsistent],
        }),
    );

    // Commit and document ONLY approved, green work: a rejected build must not
    // be swept into git (commitPaths never uses `git add -A`, so the user's
    // parallel WIP stays out of FIA commits either way).
    if (test.passed && review.approved) {
      // Planning close-out is code, not agent memory: the last successful
      // task linked to a spec stamps its Delivery Gate and Status: done.
      const specClose = await runSpecDeliveryClose(run, prompt, briefPath);

      await run.runPhase(phaseParams('commit_code', 'code', 'git', 'Commit implementation after green tests and approval'), async (ph) => {
        let paths = [
          ...(plan.artifacts || []),
          ...(build.changed_files || []),
          ...(build.artifacts || []),
          // The checklist reconciliation ticks the brief itself — the run's
          // own change, committed with the work it certifies.
          ...(reconcile?.changed_files || []),
          ...(reconcile?.artifacts || []),
          // The UI repair round is the run's own change too.
          ...(uiFix?.changed_files || []),
          ...(uiFix?.artifacts || []),
          ...(specClose.changed_files || []),
          // The regression floor rises on a green suite (modules/floor.mjs) and
          // rides the SAME commit as the work that raised it — unchanged or
          // pre-run-dirty it is filtered out by commitPaths' baseline.
          floorPath(run.cfg?.defaults?.data_dir),
        ];
        // A foundation run scaffolds far more files than any envelope can
        // enumerate — widen to everything the RUN itself changed. The baseline
        // diff keeps the engineer's pre-run WIP out either way.
        if (isFoundationBrief(prompt)) paths = [...paths, ...git.runChangedPaths(run.repoRoot, run.baseline)];
        const { sha, committed, excluded } = git.commitPaths(
          build.commit_message || `fia(${run.fdaId}): ${build.summary}`,
          paths,
          run.repoRoot,
          { baseline: run.baseline },
        );
        ph.log({ sha: sha || '(nothing to commit)', files: committed.length });
        if (excluded.length) ph.log({ excluded_pre_existing: excluded.join(', ') });
        const leftover = git.runChangedPaths(run.repoRoot, run.baseline);
        if (leftover.length) ph.log({ changed_by_run_but_uncommitted: leftover.join(', ') });
      });

      const doc = await run.runPhase(
        phaseParams('document', 'agent', 'documenter', 'Document what shipped'),
        async (ph) => ph.call({ outputType: 'DocumentOutput', prompt, previous: build, gates: [artifactsExist] }),
      );

      if (doc.document_path) {
        await run.runPhase(phaseParams('commit_docs', 'code', 'git', 'Commit documentation as its own change'), async (ph) => {
          const paths = [doc.document_path, ...(doc.documented_files || [])];
          const { sha, excluded } = git.commitPaths(doc.commit_message || `docs: ${doc.summary}`, paths, run.repoRoot, {
            baseline: run.baseline,
          });
          ph.log({ sha: sha || '(nothing to commit)' });
          if (excluded.length) ph.log({ excluded_pre_existing: excluded.join(', ') });
        });
      }
    }

    // A red suite or a rejected review is exactly "verification failed" — the
    // outcome finish() derives on its own. There is nothing more precise to
    // name here, so no explicit outcome is passed; only the reason gets
    // sharper, saying WHICH of the two verifications refused the work.
    return run.finish({
      accepted: Boolean(test.passed && review.approved),
      reason: test.passed ? 'the reviewer did not approve the build' : 'the test suite did not pass',
    });
  },
  { agents: ['planner', 'builder', 'reviewer', 'documenter'] },
);
