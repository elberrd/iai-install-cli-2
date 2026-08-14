#!/usr/bin/env node
/** FDA Plan Build Test — plan → build → test → commit. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runFda, phaseParams } from './modules/fda-cli.mjs';
import { artifactsExist, filesNonEmpty, parseSpecLine, checkSpecCoverage, isFoundationBrief } from './modules/gates.mjs';
import { resolveBriefPath, runChecklistGate } from './modules/checklist.mjs';
import { runUiGate } from './modules/ui-gate.mjs';
import { runTestsForBrief, asEnvelope } from './modules/quality.mjs';
import * as git from './modules/git-helper.mjs';

/**
 * Files declared by EVERY persisted builder envelope (build + fix_N). On resume
 * the in-memory `previous` can be just the replayed build envelope (test_1
 * re-runs and passes because the fix is already on disk, so the fix loop never
 * executes) — files touched by earlier fix rounds live only in phase_results.
 */
function builderDeclaredFiles(run) {
  const files = [];
  let names = [];
  try {
    names = readdirSync(run.phaseResultsDir);
  } catch {
    /* no phase results dir — nothing persisted */
  }
  for (const name of names) {
    if (!/^(build|fix_\d+|fix_checklist|fix_ui)\.json$/.test(name)) continue;
    try {
      const saved = JSON.parse(readFileSync(join(run.phaseResultsDir, name), 'utf8'));
      files.push(...(saved.result?.changed_files || []), ...(saved.result?.artifacts || []));
    } catch {
      /* unreadable phase result — the in-memory envelopes still cover the rest */
    }
  }
  return files;
}

const MAX_FIX = 3;

await runFda(
  async ({ run, prompt, args }) => {
    const briefPath = resolveBriefPath(run, args.prompt);
    await run.runPhase(phaseParams('request', 'engineer', run.engineer, 'Capture the feature request'), async (ph) => {
      ph.log({ input: prompt });
    });

    const plan = await run.runPhase(
      phaseParams('plan', 'agent', 'planner', 'Produce an implementable plan before any code changes'),
      async (ph) => ph.call({ outputType: 'PlanOutput', prompt, gates: [artifactsExist, filesNonEmpty] }),
    );

    let previous = await run.runPhase(
      phaseParams('build', 'agent', 'builder', 'Implement the approved plan in the repository'),
      async (ph) => ph.call({ outputType: 'BuildOutput', prompt, previous: plan, gates: [artifactsExist] }),
    );

    const runTestPhase = (n) =>
      run.runPhase(
        phaseParams(`test_${n}`, 'code', 'quality', 'Run the test suite — a known command executed by code, not an agent'),
        async (ph) => {
          // Foundation briefs also run `npm run build` (runTestsForBrief) —
          // and the fix loop then repairs build failures like any red test.
          const result = await runTestsForBrief(run, prompt);
          ph.log({ passed: result.passed, checks: result.checks.map((c) => c.name).join('+') });
          return result;
        },
      );

    // Every fix is followed by a test: fix_i is verified by test_{i+1}, so the
    // last repair round is never left untested.
    let test = await runTestPhase(1);
    for (let i = 1; i <= MAX_FIX && !test.passed; i++) {
      previous = await run.runPhase(
        phaseParams(`fix_${i}`, 'agent', 'builder', 'Repair failures reported by the test suite', { retries: 1 }),
        async (ph) =>
          ph.call({
            outputType: 'BuildOutput',
            prompt,
            previous: asEnvelope(test, 'tests'),
            gates: [artifactsExist],
          }),
      );
      test = await runTestPhase(i + 1);
    }

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
        },
      );

      // Acceptance-checklist gate (C8): the brief's checkboxes must all be
      // reconciled — ticked after verification or annotated N/A — before the
      // run may close. One builder round repairs a forgotten checklist; boxes
      // that survive it fail the run (see modules/checklist.mjs).
      await runChecklistGate(run, briefPath);

      // UI-conformance gate: arms itself when the run changed frontend
      // component files (a `Surface:` line without `ui` stands it down); its
      // repair round lands in phase_results, so builderDeclaredFiles commits
      // it (see modules/ui-gate.mjs).
      await runUiGate(run, prompt);

      await run.runPhase(
        phaseParams('commit', 'code', 'git', 'Commit only after the test suite passed'),
        async (ph) => {
          // Commit ONLY what the run itself produced (envelope-declared files) —
          // never `git add -A`, which would sweep the user's parallel WIP. The
          // union covers ALL builder rounds, not just the last envelope in hand.
          const paths = [
            ...new Set([
              ...(plan.artifacts || []),
              ...(previous.changed_files || []),
              ...(previous.artifacts || []),
              ...builderDeclaredFiles(run),
              // A foundation run scaffolds far more files than any envelope can
              // enumerate — widen to everything the RUN itself changed. The
              // baseline diff keeps the engineer's pre-run WIP out either way.
              ...(isFoundationBrief(prompt) ? git.runChangedPaths(run.repoRoot, run.baseline) : []),
            ]),
          ];
          const message = previous.commit_message || `fia(${run.fdaId}): ${previous.summary}`;
          const { sha, committed, excluded } = git.commitPaths(message, paths, run.repoRoot, { baseline: run.baseline });
          ph.log({ sha: sha || '(nothing to commit)', message, files: committed.length });
          if (excluded.length) ph.log({ excluded_pre_existing: excluded.join(', ') });
          const leftover = git.runChangedPaths(run.repoRoot, run.baseline);
          if (leftover.length) ph.log({ changed_by_run_but_uncommitted: leftover.join(', ') });
        },
      );
    }

    return run.finish({ accepted: Boolean(test.passed), reason: `suite failed after ${MAX_FIX} fix attempt(s)` });
  },
  { agents: ['planner', 'builder', 'reviewer'] },
);
