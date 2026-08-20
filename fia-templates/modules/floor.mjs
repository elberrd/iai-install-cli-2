/**
 * The regression floor — a ratchet under the test suite.
 *
 * After every GREEN full-suite run the runtime stamps what it observed into
 * imp/data/floor.json: how many test FILES the tree carries and (when the
 * runner's summary is recognizable) how many tests PASSED. The next green run
 * must observe AT LEAST those numbers — a suite that "went green" because
 * tests were deleted or skipped is a violation, and the violation is reported
 * as a failing check so the ordinary repair loop asks the builder to restore
 * the tests instead of silently accepting the loss.
 *
 * Design borrowed from lights-out factory experiments (StrongDM-style
 * ratchets): the floors sit EQUAL to what was last observed — zero slack —
 * because the gap between observed and floor is exactly the number of tests
 * that can be deleted with the gate still green. Two properties keep the
 * number honest here:
 *
 *   1. The file is protected from agents (permissions.mjs ALWAYS_PROTECTED +
 *      `defaults.protected_files`): an agent write to it is rolled back. Only
 *      this module — deterministic code, running in the trusted runner
 *      process — moves the numbers, so unlike a repo where the whole tree is
 *      agent-editable, the ratchet can RISE automatically.
 *   2. It only rises. Lowering it is a human act: edit or delete
 *      imp/data/floor.json in your own commit (deleting re-baselines on the
 *      next green run). If you find yourself lowering it, the question is
 *      what stopped being true.
 *
 * An UNREADABLE floor file fails closed — corrupt state is indistinguishable
 * from tampering, and the fix (restore from git, or delete to re-baseline) is
 * a one-liner that the violation message spells out.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { listTestFiles } from './gates.mjs';

export const FLOOR_FILE = 'floor.json';

export function floorPath(dataDir) {
  return join(dataDir || 'imp/data', FLOOR_FILE);
}

/**
 * Passed-test count from a runner's output, or null when no known summary
 * shape is present (the floor then tracks test files only — never guess).
 * Recognized: vitest/jest (`Tests: 12 passed` / `Tests  12 passed`),
 * node:test TAP (`# pass 12`), mocha (`12 passing`), pytest (`12 passed`).
 *
 * Two traps, both of which produced a WRONG number rather than an honest null:
 *
 *  - jest and vitest print their categories in the order they occurred
 *    (`2 skipped, 98 passed`, `1 todo, 98 passed`), so a pattern that only
 *    tolerated a leading `N failed` stopped matching the moment a student
 *    wrote `it.skip`. The `Tests` line is therefore matched as a LINE and the
 *    first `N passed` on it wins, whatever precedes it.
 *  - Both runners print a SUITE census first (`Test Suites: 10 passed`,
 *    `Test Files 12 passed`). Once the specific pattern missed, the generic
 *    fallback happily read that line and stamped a suite count as the
 *    passing-test floor — turning a permanently green suite permanently red.
 *    The fallback now refuses any line that is a suite census.
 */
export function parsePassedCount(outputText) {
  const text = String(outputText || '');
  const patterns = [
    // vitest / jest summary LINE — any category order. [^\S\n] is horizontal
    // whitespace only, so the match cannot wander onto the next line.
    /^[^\S\n]*Tests[:\s][^\n]*?(\d+)\s+passed\b/im,
    /^#\s*pass\s+(\d+)\b/im, // node:test TAP summary
    /^[^\S\n]*(\d+)\s+passing\b/m, // mocha summary line — anchored so app output ('imported 2026 passing entries') never stamps a garbage floor
    // pytest / generic "N passed" — never a `Test Files`/`Test Suites` census.
    /^(?![^\n]*Test (?:Files|Suites))[^\n]*?(?:^|[\s=])(\d+)\s+passed\b/im,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/** { floor, error } — a missing file is a clean null floor; unreadable is an ERROR (fail closed). */
export function readFloor(dataDir) {
  const path = floorPath(dataDir);
  let raw = null;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { floor: null, path };
    return { floor: null, path, error: `unreadable (${err?.code || 'error'})` };
  }
  try {
    const parsed = JSON.parse(raw);
    const clean = {};
    for (const key of ['test_files', 'tests_passed']) {
      const value = Number(parsed?.[key]);
      if (Number.isFinite(value) && value >= 0) clean[key] = Math.floor(value);
    }
    return { floor: clean, path };
  } catch {
    return { floor: null, path, error: 'not valid JSON' };
  }
}

/** What the tree and the suite output show right now. */
export function observeSuite(repoRoot, testOutput) {
  const observed = { test_files: listTestFiles(repoRoot).length };
  const passed = parsePassedCount(testOutput);
  if (passed !== null) observed.tests_passed = passed;
  return observed;
}

const RESTORE_HINT =
  'restore the deleted/renamed test files (never delete or skip tests to go green). ' +
  'If the reduction is a deliberate human decision, lower or delete imp/data/floor.json in your own commit — ' +
  'agents cannot: the file is protected.';

/**
 * Compare what a green suite observed against the recorded floor →
 * { ok, violations, raised, observed, floor }. When everything holds and
 * something grew, the floor is stamped up in the same call (monotonic — this
 * function never writes a smaller number).
 */
export function enforceFloor({ dataDir, repoRoot, testOutput }) {
  const observed = observeSuite(repoRoot, testOutput);
  const { floor, path, error } = readFloor(dataDir);
  const rel = relative(repoRoot, path) || path;
  if (error) {
    return {
      ok: false,
      observed,
      floor: null,
      raised: false,
      violations: [
        `the regression floor file ${rel} is ${error} — failing closed. ` +
          'Restore it (`git checkout -- ' + rel + '`) or delete it to re-baseline on the next green run.',
      ],
    };
  }
  const violations = [];
  // `tests_passed` is the AUTHORITATIVE measure of coverage; the file census is
  // only a proxy for it, used when the runner's summary cannot be parsed. So
  // when the authoritative number holds, a smaller file count is a
  // reorganization (two suites merged into one, a rename), not a loss — and
  // failing it would block an honest refactor the builder could not even
  // repair, since floor.json is protected from agents.
  const coverageConfirmed =
    Number.isFinite(floor?.tests_passed) &&
    observed.tests_passed !== undefined &&
    observed.tests_passed >= floor.tests_passed;
  if (floor) {
    if (!coverageConfirmed && Number.isFinite(floor.test_files) && observed.test_files < floor.test_files) {
      violations.push(
        `the tree carries ${observed.test_files} test file(s) but the recorded floor is ${floor.test_files} — ${RESTORE_HINT}`,
      );
    }
    if (
      Number.isFinite(floor.tests_passed) &&
      observed.tests_passed !== undefined &&
      observed.tests_passed < floor.tests_passed
    ) {
      violations.push(
        `${observed.tests_passed} test(s) passed but the recorded floor is ${floor.tests_passed} — ${RESTORE_HINT}`,
      );
    }
  }
  if (violations.length) return { ok: false, observed, floor, raised: false, violations };

  // Green and at-or-above the floor: ratchet up whatever grew. Counts the
  // floor never knew (a first run, or a suite whose summary only now became
  // parseable) are adopted as new floors too. The file census may also move
  // DOWN, but only when the authoritative passing-test count confirmed the
  // coverage held — otherwise a merged suite would leave a permanently
  // unreachable proxy floor behind.
  const next = { ...(floor || {}) };
  let raised = false;
  for (const key of ['test_files', 'tests_passed']) {
    if (observed[key] === undefined) continue;
    const mayLower = key === 'test_files' && coverageConfirmed;
    if (!Number.isFinite(next[key]) || observed[key] > next[key] || (mayLower && observed[key] < next[key])) {
      next[key] = observed[key];
      raised = true;
    }
  }
  if (raised) {
    // Write-then-rename: a stamp interrupted by a full disk, a quota or a
    // Ctrl+C must leave the PREVIOUS valid floor in place. A half-written
    // floor.json reads as corrupt and (correctly) fails every later run
    // closed — a recovery the student should never be pushed into by our
    // own crash.
    const tmp = `${path}.tmp`;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        tmp,
        JSON.stringify(
          {
            _what_this_is:
              'The FIA regression floor — a ratchet stamped by imp/modules/floor.mjs after every green suite. ' +
              'The gate asserts observed >= floor. Agents cannot edit this file (protected); ' +
              'only a human commit may lower it, and deleting it re-baselines on the next green run.',
            ...next,
            _stamped_at: new Date().toISOString(),
          },
          null,
          2,
        ) + '\n',
      );
      renameSync(tmp, path);
    } catch {
      raised = false; // stamping is best-effort — a read-only tree never fails a green run
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* best effort */
      }
    }
  }
  return { ok: true, observed, floor: next, raised, violations: [] };
}
