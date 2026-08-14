#!/usr/bin/env node
/** FDA Bug — plan → failing reproduction (valid RED) → fix → green suite → commit. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runFda, phaseParams } from './modules/fda-cli.mjs';
import { artifactsExist, filesNonEmpty, validateRedReason, parseSpecLine, checkSpecCoverage } from './modules/gates.mjs';
import { resolveBriefPath, runChecklistGate } from './modules/checklist.mjs';
import { runUiGate } from './modules/ui-gate.mjs';
import { runTests, runFocalTests, asEnvelope } from './modules/quality.mjs';
import * as git from './modules/git-helper.mjs';

/**
 * Files declared by EVERY persisted builder envelope (red_test + build +
 * fix_N). Same reason as fda_plan_build_test: on resume the in-memory
 * envelopes may not cover earlier rounds — phase_results always do.
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
    if (!/^(red_test|build|fix_\d+|fix_checklist|fix_ui)\.json$/.test(name)) continue;
    try {
      const saved = JSON.parse(readFileSync(join(run.phaseResultsDir, name), 'utf8'));
      files.push(...(saved.result?.changed_files || []), ...(saved.result?.artifacts || []));
    } catch {
      /* unreadable phase result — the in-memory envelopes still cover the rest */
    }
  }
  return files;
}

/** A phase that already ran in this fda_id (its result file is on disk). */
function phaseAlreadyRan(run, name) {
  return existsSync(join(run.phaseResultsDir, `${name}.json`));
}

/** The persisted result of an earlier phase of this fda_id, or null. */
function savedPhaseResult(run, name) {
  try {
    return JSON.parse(readFileSync(join(run.phaseResultsDir, `${name}.json`), 'utf8')).result ?? null;
  } catch {
    return null;
  }
}

const MAX_FIX = 3;

await runFda(
  async ({ run, prompt, args }) => {
    const briefPath = resolveBriefPath(run, args.prompt);
    await run.runPhase(phaseParams('request', 'engineer', run.engineer, 'Capture the bug report'), async (ph) => {
      ph.log({ input: prompt });
    });

    const plan = await run.runPhase(
      phaseParams('plan', 'agent', 'planner', 'Locate the defect and plan reproduction + fix'),
      async (ph) => ph.call({ outputType: 'PlanOutput', prompt, gates: [artifactsExist, filesNonEmpty] }),
    );

    // RED first: the reproduction is the proof the bug exists — and later the
    // proof the fix works. Production code stays untouched until it fails.
    const redPrompt = [
      'Write ONLY a failing reproduction test for the bug below. RED rules:',
      '- NO production code changes — test file(s) only, declared in changed_files.',
      '- The test must fail with a test-level assertion (expected vs actual on the buggy behavior).',
      '- A failure from a missing module, a syntax error or a broken environment is NOT a reproduction and will be rejected.',
      '- When the brief cites a `Spec:` line, carry its marker in the test file: `// spec:NNNN covers:<ids>`.',
      '',
      `Bug report:\n${prompt}`,
    ].join('\n');
    const red = await run.runPhase(
      phaseParams('red_test', 'agent', 'builder', 'Write ONLY the failing reproduction test — no production code'),
      async (ph) => ph.call({ outputType: 'BuildOutput', prompt: redPrompt, previous: plan, gates: [artifactsExist] }),
    );
    const redFiles = [...new Set([...(red.changed_files || []), ...(red.artifacts || [])])];

    const redCheck = await run.runPhase(
      phaseParams('red_check', 'code', 'quality', 'Prove the reproduction fails for the right reason before any fix'),
      async (ph) => {
        // `code` phases always re-run on resume — right for suites and commits,
        // wrong here: this is a ONE-WAY gate. Once `build` applied the fix the
        // reproduction PASSES, and re-running would fail the run as "bug not
        // reproduced". The verdict was already proven; replay it.
        if (run.resume && phaseAlreadyRan(run, 'build')) {
          const saved = savedPhaseResult(run, 'red_check');
          ph.log({ reproduced: true, note: 'already proven before the fix — skipped on resume' });
          return saved ?? { passed: false, checks: [], failures: [], artifacts: [] };
        }
        const result = await runFocalTests(run, redFiles);
        if (result.passed) {
          throw new Error('bug not reproduced — the reproduction test PASSED on the current code; write a test that fails on the reported behavior');
        }
        const reason = validateRedReason(result.checks.map((c) => c.output_tail).join('\n'));
        if (!reason.valid) throw new Error(`invalid RED (${reason.classification}): ${reason.note}`);
        ph.log({ reproduced: true, classification: reason.classification, files: redFiles.join(', ') });
        return { ...result, red: reason };
      },
    );

    const fixPrompt = [
      'Fix the bug so the reproduction test (and the whole suite) passes.',
      '- Do NOT weaken, skip or delete the reproduction test — it is the proof.',
      '- Smallest correct fix; no drive-by refactors.',
      '',
      `Bug report:\n${prompt}`,
    ].join('\n');
    let previous = await run.runPhase(
      phaseParams('build', 'agent', 'builder', 'Fix the defect so the reproduction test passes'),
      async (ph) =>
        ph.call({
          outputType: 'BuildOutput',
          prompt: fixPrompt,
          previous: asEnvelope(redCheck, 'reproduction test (failing as intended)'),
          gates: [artifactsExist],
        }),
    );

    const runTestPhase = (n) =>
      run.runPhase(
        phaseParams(`test_${n}`, 'code', 'quality', 'Run the test suite — a known command executed by code, not an agent'),
        async (ph) => {
          const result = await runTests(run);
          ph.log({ passed: result.passed, checks: result.checks.length });
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
            prompt: fixPrompt,
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

      // Acceptance-checklist gate (C8): bug briefs with checkboxes must leave
      // the run reconciled too — free-form bug reports (no boxes) skip it.
      await runChecklistGate(run, briefPath);

      // UI-conformance gate: a bug fix that touched frontend component files
      // must not reintroduce banner errors, native confirms or silent
      // failures — same self-arming rule as the other FDAs (see
      // modules/ui-gate.mjs).
      await runUiGate(run, prompt);

      await run.runPhase(
        phaseParams('commit', 'code', 'git', 'Commit only after the reproduction is fixed and the suite is green'),
        async (ph) => {
          // Commit ONLY what the run itself produced (envelope-declared files) —
          // never `git add -A`, which would sweep the user's parallel WIP. The
          // union covers ALL builder rounds, not just the last envelope in hand.
          const paths = [
            ...new Set([
              ...(plan.artifacts || []),
              ...redFiles,
              ...(previous.changed_files || []),
              ...(previous.artifacts || []),
              ...builderDeclaredFiles(run),
            ]),
          ];
          const message = previous.commit_message || `fia(${run.fdaId}): ${previous.summary}`;
          const { sha, committed, excluded } = git.commitPaths(message, paths, run.repoRoot, { baseline: run.baseline });
          ph.log({ sha: sha || '(nothing to commit)', message, files: committed.length });
          if (excluded.length) ph.log({ excluded_pre_existing: excluded.join(', ') });
        },
      );
    }

    return run.finish({ accepted: Boolean(test.passed), reason: `suite failed after ${MAX_FIX} fix attempt(s)` });
  },
  { agents: ['planner', 'builder', 'reviewer'] },
);
