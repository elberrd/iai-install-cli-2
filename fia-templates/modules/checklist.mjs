import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { phaseParams } from './fda-cli.mjs';
import { artifactsExist, checkAcceptanceChecklist, checklistDrift, parseChecklistItems } from './gates.mjs';

/**
 * In-process copy of each session's checkbox baseline. The on-disk snapshot
 * lives under the gitignored data dir, where the permission snapshot cannot
 * see writes — so a builder could zero the FILE undetected. The count is
 * therefore also latched in memory the moment it is computed (same process as
 * the gate); the gate trusts whichever claim is LARGER, since honest work
 * never shrinks the count. A --resume in a fresh process falls back to the
 * file — the in-run tampering window is the one this closes.
 */
const BASELINE_MEMO = new Map();

/**
 * How many checkboxes the brief carried when the run started, or 0 when no
 * baseline was recorded (a session from before this snapshot existed, or an
 * unreadable brief). 0 means "no claim" — the gate then behaves exactly as it
 * did before, never inventing a violation out of a missing baseline.
 */
function briefCheckboxBaseline(run) {
  let fromFile = 0;
  try {
    const n = Number(readFileSync(join(run.sessionDir, 'brief_checkboxes'), 'utf8').trim());
    fromFile = Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    fromFile = 0;
  }
  return Math.max(BASELINE_MEMO.get(run.sessionDir) ?? 0, fromFile);
}

/**
 * The brief file behind the run's prompt. `resolvePrompt` inlines the file's
 * CONTENT and drops the path — but the checklist gate must re-read the file
 * DURING the run (the builder ticks boxes on disk, and the gate must see
 * them). The path is persisted with the session because on `--resume` the
 * prompt argument is usually omitted (the text is reloaded from the trace,
 * pathless). Inline prompts return null — there is no file to reconcile.
 */
export function resolveBriefPath(run, promptArg) {
  const marker = join(run.sessionDir, 'brief_path');
  if (promptArg) {
    try {
      const path = resolve(promptArg);
      if (existsSync(path) && statSync(path).isFile()) {
        writeFileSync(marker, path);
        // How many checkboxes the brief carried BEFORE any agent touched it.
        // The gate is skipped for a brief that legitimately has none, so
        // without this snapshot "delete the Acceptance Criteria section" (or
        // fence the boxes, or turn the list into a table) stands the gate down
        // exactly like deleting the file used to. Recorded here — the earliest
        // point in every FDA, before the builder runs.
        //
        // FIRST WRITER WINS. A resumed run is the SAME run, and `--resume` may
        // legitimately re-pass the brief path; re-reading the baseline then
        // would take it from a file the previous attempt already gutted, which
        // is precisely the tampering this snapshot exists to catch. Ticking a
        // box never changes the count, so keeping the original is also correct
        // for an honest resume.
        const baselineFile = join(run.sessionDir, 'brief_checkboxes');
        if (!existsSync(baselineFile)) {
          try {
            const count = parseChecklistItems(readFileSync(path, 'utf8')).length;
            writeFileSync(baselineFile, String(count));
            BASELINE_MEMO.set(run.sessionDir, count);
          } catch {
            /* unreadable at start — the gate falls back to "no baseline known" */
          }
        }
        return path;
      }
    } catch {
      /* not a path — fall through to the marker */
    }
    // No file behind the argument. On `--resume` this is the normal case:
    // runFda reloads the saved request, which is the brief's inlined CONTENT
    // (pathless) — the session marker still knows the file, so the gate keeps
    // enforcing on resumed runs instead of silently skipping.
  }
  try {
    const saved = readFileSync(marker, 'utf8').trim();
    // The recorded path is returned even when the file NO LONGER EXISTS: a
    // brief that vanished mid-run (or between runs) must reach the checklist
    // gate, which fails closed on it — returning null here would read as "the
    // prompt was inline" and silently stand the gate down, making "delete the
    // brief" a way to skip reconciliation.
    if (saved) return saved;
  } catch {
    /* no marker — a pre-checklist session, or an inline prompt */
  }
  return null;
}

/**
 * Deterministic close-out of the brief's checkboxes: check → one builder
 * reconciliation round when boxes were left → check again, failing the run if
 * any survive. The builder is told to tick ONLY what it verified (or annotate
 * `— N/A (<reason>)`); an item that is genuinely not satisfied stays
 * unchecked and fails the run — the honest outcome. This is what makes
 * "announced done while the checklist says otherwise" impossible: code
 * refuses the close, it never ticks a box.
 *
 * Returns the reconciliation envelope (for commit-path inclusion), or null
 * when the gate was skipped or the build had already reconciled everything.
 */
export async function runChecklistGate(run, briefPath) {
  const first = await run.runPhase(
    phaseParams('checklist_1', 'code', 'quality', 'Verify the build left no brief checkbox unchecked'),
    async (ph) => {
      if (!briefPath) {
        ph.log({ skipped: 'the prompt did not come from a brief file' });
        return { skip: true };
      }
      // FAIL CLOSED on a vanished brief: the run STARTED from this file (the
      // session marker says so), and a gate whose input disappeared must be
      // loud, never silently absent — "delete the brief" cannot be a way to
      // skip the checklist.
      if (!existsSync(briefPath)) {
        const gone = relative(run.repoRoot, briefPath);
        // The commonest cause is not tampering: the task-sequencer ARCHIVES the
        // active brief to ai-docs/todos/done/ when it prepares the next task,
        // so an older run resumed afterwards finds it missing. `git checkout`
        // is the wrong advice there — it either fails (the path no longer
        // exists at HEAD) or resurrects an unticked duplicate. Name the file
        // where it actually went.
        const archived = join(dirname(dirname(briefPath)), 'todos', 'done', basename(briefPath));
        const how = existsSync(archived)
          ? `The task sequencer archived it to ${relative(run.repoRoot, archived)} — move it back (mv ${relative(run.repoRoot, archived)} ${gone}) and resume.`
          : `Restore it (git checkout -- ${gone}) and resume.`;
        throw new Error(
          `the brief file this run started from is gone (${gone}) — a deleted brief is not a reconciled checklist. ${how}`,
        );
      }
      const report = checkAcceptanceChecklist(briefPath);
      if (!report) {
        // No checkboxes NOW. Proportionality says a brief that never had any
        // is nothing to reconcile — but a brief that HAD them and lost them is
        // the same escape hatch as a deleted file, wearing a different hat.
        const had = briefCheckboxBaseline(run);
        if (had > 0) {
          throw new Error(
            `the brief's acceptance checklist disappeared during the run (${relative(run.repoRoot, briefPath)} started with ${had} checkbox(es) and now parses none) — ` +
              'restore it; deleting, fencing or reformatting the boxes is not reconciling them',
          );
        }
        ph.log({ skipped: 'the brief has no checkboxes' });
        return { skip: true };
      }
      // Same rule for a checklist that merely SHRANK before the first check:
      // checklist_2 already guards the reconciliation window, this guards the
      // build window that precedes it.
      const had = briefCheckboxBaseline(run);
      if (had > report.items.length) {
        throw new Error(
          `the brief's acceptance checklist shrank during the run (${relative(run.repoRoot, briefPath)}: ${had} checkbox(es) at the start, ${report.items.length} now) — ` +
            'restore the missing boxes; a removed box is not a ticked box',
        );
      }
      ph.log({ unchecked: report.violations.length, of: report.items.length });
      // `items` (not just the count) rides along so checklist_2 can compare
      // IDENTITIES: same count is not the same list.
      return {
        skip: false,
        passed: report.passed,
        violations: report.violations,
        total: report.items.length,
        items: report.items,
      };
    },
  );
  if (first.skip || first.passed) return null;

  const rel = relative(run.repoRoot, briefPath);
  const reconcile = await run.runPhase(
    phaseParams('fix_checklist', 'agent', 'builder', 'Reconcile the brief checkboxes honestly against the delivered work', { retries: 1 }),
    async (ph) =>
      ph.call({
        outputType: 'BuildOutput',
        prompt: [
          `The implementation is done and the test suite is green, but the brief \`${rel}\` still has unchecked checkboxes:`,
          ...first.violations.map((v) => `- ${v}`),
          '',
          'For EACH item: verify it against the repository and the test results, then tick it `[x]` in the brief.',
          'An item that does not apply to this task: tick it and append `— N/A (<reason>)` — the reason is mandatory, a bare N/A fails the gate.',
          'An item that is genuinely NOT satisfied: leave it unchecked and explain in `notes_for_next_agent` — the run will fail, which is the honest outcome. NEVER tick a box you did not verify.',
          `Change nothing besides the checkboxes of \`${rel}\`, and declare the file in \`changed_files\`.`,
          'Do NOT reword, move or replace checklist items: the gate compares them by text and refuses the close on any rewritten or missing box.',
        ].join('\n'),
        gates: [artifactsExist],
      }),
  );

  await run.runPhase(
    phaseParams('checklist_2', 'code', 'quality', 'Refuse to close the run while brief checkboxes remain unchecked'),
    async (ph) => {
      const report = checkAcceptanceChecklist(briefPath);
      // A checklist that shrank or vanished between the two checks is a
      // refusal, not a pass — deleting (or fencing away) boxes must never
      // count as reconciling them.
      if (!report || report.items.length < first.total) {
        throw new Error(
          `the brief's acceptance checklist ${report ? `shrank from ${first.total} to ${report.items.length} items` : 'disappeared'} during reconciliation in ${rel} — restore the checklist; a removed box is not a ticked box`,
        );
      }
      // Same count is NOT the same list: swapping a hard box for a trivial
      // ticked one keeps the length while reconciling nothing. Identity =
      // section + text (the trailing `— N/A (…)` annotation is the one
      // sanctioned edit, so it is ignored). checklist_1 is a code phase and
      // re-runs on --resume, so `items` is present in practice — the guard is
      // defense in depth, with the count check above as the floor.
      if (Array.isArray(first.items)) {
        const removed = checklistDrift(first.items, report.items);
        if (removed.length) {
          throw new Error(
            `checkboxes were rewritten or replaced during reconciliation in ${rel}:\n- ${removed.join('\n- ')}\n` +
              'Restore them — the only allowed edits are ticking `[x]` and appending `— N/A (<reason>)`; a rewritten box is not the promised box',
          );
        }
      }
      if (!report.passed) {
        throw new Error(`acceptance checklist incomplete in ${rel}:\n- ${report.violations.join('\n- ')}`);
      }
      ph.log({ checklist: 'fully reconciled' });
    },
  );
  return reconcile;
}
