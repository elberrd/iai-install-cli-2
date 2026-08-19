#!/usr/bin/env node
/**
 * Gate probes — deliberate defects that must make each FIA gate go RED.
 *
 * This is the only check in the harness that measures the HARNESS rather than
 * the student's code: until a defect has been injected and caught, there is
 * no evidence any gate here can fail at all. Each red probe fabricates one
 * violation (an unchecked brief box, a rubber-stamp N/A, a lowered regression
 * floor, an approved verdict with blockers…) against a THROWAWAY fixture in
 * the OS temp directory — the project tree is never touched — and asserts the
 * gate refuses it. Control probes do the opposite: they hand each gate a
 * clean case and assert it passes, so "all red probes caught" can never be
 * satisfied by a gate that simply always fails.
 *
 *   npm run gates:probe          human report, exit 1 when any probe misses
 *   npm run gates:probe -- --json  machine-readable report
 *   imp doctor --gates           the same run, from the doctor
 *
 * A MISSED probe is a class of defect that can currently slip through the
 * gates of this project unseen. Treat it like a red suite: something in
 * imp/modules/ regressed (restore it via --update-runtime) — do not delete
 * the probe.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  artifactsExist,
  checkAcceptanceChecklist,
  checklistDrift,
  parseChecklistItems,
  checkSpecCoverage,
  validateRedReason,
  verdictConsistent,
} from '../modules/gates.mjs';
import { enforceFloor, parsePassedCount } from '../modules/floor.mjs';
import { manualStopState } from '../modules/stop.mjs';
import { isProtectedPath } from '../modules/permissions.mjs';
import { runHoldoutProbes } from '../modules/holdout.mjs';
import { isMainModule } from '../modules/utils.mjs';

const runStub = { fs };

// ONE throwaway root per invocation, removed in a finally block. Probes used
// to mkdtemp individually and leave ~13 directories behind on every
// `imp doctor --gates`.
let scratchRoot = null;
let scratchSeq = 0;

function scratch(prefix) {
  scratchRoot = scratchRoot || mkdtempSync(join(tmpdir(), 'fia-gate-probes-'));
  const dir = join(scratchRoot, `${String(++scratchSeq).padStart(2, '0')}-${prefix}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The probe catalog. `kind: 'red'` probes inject a defect and are CAUGHT when
 * the gate refuses it; `kind: 'control'` probes hand the gate a clean case
 * and are OK when it passes. Every probe returns true for "behaved correctly".
 */
const PROBES = [
  {
    id: 'checklist-open-box',
    kind: 'red',
    what: 'a brief with an unchecked acceptance box must not close',
    run() {
      const dir = scratch('brief');
      const brief = join(dir, 'brief.md');
      writeFileSync(brief, '# T\n\n## Acceptance Criteria\n- [x] done thing\n- [ ] forgotten thing\n');
      return checkAcceptanceChecklist(brief)?.passed === false;
    },
  },
  {
    id: 'checklist-bare-na',
    kind: 'red',
    what: 'a box ticked `— N/A` WITHOUT a reason is a rubber stamp, not a claim',
    run() {
      const dir = scratch('brief');
      const brief = join(dir, 'brief.md');
      writeFileSync(brief, '# T\n\n- [x] responsive layout — N/A\n');
      return checkAcceptanceChecklist(brief)?.passed === false;
    },
  },
  {
    id: 'checklist-replaced-box',
    kind: 'red',
    what: 'swapping a hard box for a trivial ticked one keeps the count but reconciles nothing',
    run() {
      const before = parseChecklistItems('- [ ] hard requirement about auth\n- [ ] easy one\n');
      const after = parseChecklistItems('- [x] trivial substitute\n- [x] easy one\n');
      return checklistDrift(before, after).length > 0;
    },
  },
  {
    id: 'empty-envelope',
    kind: 'red',
    what: 'an agent that declared NO artifacts must not sail through vacuously',
    run: () => artifactsExist({ artifacts: [] }, runStub).passed === false,
  },
  {
    id: 'ghost-artifact',
    kind: 'red',
    what: 'a declared artifact that does not exist on disk is an unbacked claim',
    run() {
      const dir = scratch('ghost');
      return artifactsExist({ artifacts: [join(dir, 'never-written.js')] }, runStub).passed === false;
    },
  },
  {
    id: 'red-not-a-red',
    kind: 'red',
    what: 'a reproduction failing on a missing module proves nothing about the bug',
    run: () => validateRedReason("Error: Cannot find module './missing'").valid === false,
  },
  {
    id: 'spec-uncovered',
    kind: 'red',
    what: 'a promised spec id with no covering test marker must fail coverage',
    run() {
      const dir = scratch('spec');
      writeFileSync(join(dir, 'app.js'), 'export const x = 1;\n');
      return checkSpecCoverage({ specId: '0042', ids: ['FR-1'], repoRoot: dir }).passed === false;
    },
  },
  {
    id: 'verdict-approved-with-blockers',
    kind: 'red',
    what: 'approved=true while blocking findings exist is an inconsistent verdict',
    run: () => verdictConsistent({ approved: true, blocking: ['auth bypass'], findings: [] }).passed === false,
  },
  {
    id: 'floor-lowered',
    kind: 'red',
    what: 'a green suite over a tree that LOST test files must trip the regression floor',
    run() {
      const repo = scratch('repo');
      const data = join(repo, 'imp', 'data');
      mkdirSync(data, { recursive: true });
      writeFileSync(join(data, 'floor.json'), JSON.stringify({ test_files: 5 }));
      return enforceFloor({ dataDir: data, repoRoot: repo, testOutput: 'Tests: 9 passed' }).ok === false;
    },
  },
  {
    id: 'floor-unreadable',
    kind: 'red',
    what: 'a corrupt/unreadable floor file fails CLOSED — tampering must never read as "no floor"',
    run() {
      const repo = scratch('repo');
      const data = join(repo, 'imp', 'data');
      mkdirSync(join(data, 'floor.json'), { recursive: true }); // a directory where the file belongs
      return enforceFloor({ dataDir: data, repoRoot: repo, testOutput: '' }).ok === false;
    },
  },
  {
    id: 'floor-not-json',
    kind: 'red',
    what: 'a floor file that is not valid JSON fails closed too',
    run() {
      const repo = scratch('repo');
      const data = join(repo, 'imp', 'data');
      mkdirSync(data, { recursive: true });
      writeFileSync(join(data, 'floor.json'), 'not json {');
      return enforceFloor({ dataDir: data, repoRoot: repo, testOutput: '' }).ok === false;
    },
  },
  {
    id: 'protected-judge-paths',
    kind: 'red',
    what: 'the floor and the holdout dir are agent-write-protected even with an empty config list',
    run: () =>
      isProtectedPath('imp/data/floor.json', []) === true &&
      isProtectedPath('imp/data/holdout/001-probe.mjs', []) === true,
  },
  {
    id: 'protected-follows-data-dir',
    kind: 'red',
    what: 'moving defaults.data_dir must not unprotect the two files that judge the agent',
    run: () => {
      const moved = { defaults: { data_dir: '.fia/state' } };
      return (
        isProtectedPath('.fia/state/floor.json', [], moved) === true &&
        isProtectedPath('.fia/state/holdout/001.mjs', [], moved) === true
      );
    },
  },
  {
    id: 'suite-census-is-not-a-test-count',
    kind: 'red',
    what: 'a runner census line (`Test Suites: 10 passed`) must never be stamped as the passing-test floor',
    run: () =>
      parsePassedCount('Test Suites: 10 passed, 10 total') === null &&
      parsePassedCount('Test Suites: 10 passed, 10 total\nTests: 2 skipped, 98 passed, 100 total') === 98,
  },
  {
    id: 'stop-unreadable',
    kind: 'red',
    what: 'an unreadable stop file still stops the run — the button fails closed',
    run() {
      const data = scratch('stop');
      mkdirSync(join(data, 'fia-stop')); // a directory where the file belongs → read error, not ENOENT
      return manualStopState(data).stopped === true;
    },
  },
  {
    id: 'holdout-violation',
    kind: 'red',
    what: 'a failing holdout probe must fail the holdout run',
    async run() {
      const data = scratch('holdout');
      mkdirSync(join(data, 'holdout'), { recursive: true });
      writeFileSync(join(data, 'holdout', '001-fails.mjs'), 'console.error("invariant violated"); process.exit(1);\n');
      const report = await runHoldoutProbes({ repoRoot: data, dataDir: data });
      return report.scenarios === 1 && report.passed === false;
    },
  },

  // ── controls: clean cases each gate must PASS (an always-red gate is no gate) ──
  {
    id: 'checklist-reconciled',
    kind: 'control',
    what: 'a fully reconciled checklist (ticks + reasoned N/A) closes cleanly',
    run() {
      const dir = scratch('brief');
      const brief = join(dir, 'brief.md');
      writeFileSync(brief, '# T\n\n- [x] done thing\n- [x] mobile layout — N/A (backend-only task)\n');
      return checkAcceptanceChecklist(brief)?.passed === true;
    },
  },
  {
    id: 'red-valid-assertion',
    kind: 'control',
    what: 'an expected-vs-actual assertion failure is a VALID red',
    run: () => validateRedReason('AssertionError: expected 3 to equal 4').valid === true,
  },
  {
    id: 'floor-allows-a-merge',
    kind: 'control',
    what: 'merging test files while the passing count holds is a reorganization, not a violation',
    run() {
      const repo = scratch('repo');
      const data = join(repo, 'imp', 'data');
      mkdirSync(data, { recursive: true });
      writeFileSync(join(data, 'floor.json'), JSON.stringify({ test_files: 2, tests_passed: 20 }));
      writeFileSync(join(repo, 'ab.test.js'), 'x');
      return enforceFloor({ dataDir: data, repoRoot: repo, testOutput: 'Tests: 22 passed' }).ok === true;
    },
  },
  {
    id: 'floor-raises',
    kind: 'control',
    what: 'a first green suite baselines the floor and later growth raises it',
    run() {
      const repo = scratch('repo');
      const data = join(repo, 'imp', 'data');
      writeFileSync(join(repo, 'a.test.js'), 'test');
      const first = enforceFloor({ dataDir: data, repoRoot: repo, testOutput: 'Tests: 3 passed' });
      writeFileSync(join(repo, 'b.test.js'), 'test');
      const second = enforceFloor({ dataDir: data, repoRoot: repo, testOutput: 'Tests: 5 passed' });
      return first.ok && first.raised && second.ok && second.raised && second.floor.test_files === 2;
    },
  },
  {
    id: 'holdout-green',
    kind: 'control',
    what: 'a passing holdout probe reports HOLDOUT_PASSED',
    async run() {
      const data = scratch('holdout');
      mkdirSync(join(data, 'holdout'), { recursive: true });
      writeFileSync(join(data, 'holdout', '001-holds.mjs'), 'process.exit(0);\n');
      const report = await runHoldoutProbes({ repoRoot: data, dataDir: data });
      return report.scenarios === 1 && report.passed === true;
    },
  },
  {
    id: 'stop-absent',
    kind: 'control',
    what: 'no stop file means run — a clean ENOENT is the one reading that does not stop',
    run: () => manualStopState(scratch('stop')).stopped === false,
  },
];

export async function runCli(argv) {
  const json = argv.includes('--json');
  const results = [];
  try {
    for (const probe of PROBES) {
      let ok = false;
      let error = '';
      try {
        ok = Boolean(await probe.run());
      } catch (err) {
        // A probe that cannot RUN is a miss, loudly — a check that cannot
        // execute has to be red, never silently absent.
        error = String(err?.message || err);
        ok = false;
      }
      results.push({ id: probe.id, kind: probe.kind, what: probe.what, ok, error });
    }
  } finally {
    if (scratchRoot) {
      try {
        rmSync(scratchRoot, { recursive: true, force: true });
      } catch {
        /* a leftover temp dir is untidy, never a failure */
      }
      scratchRoot = null;
    }
  }
  const red = results.filter((r) => r.kind === 'red');
  const controls = results.filter((r) => r.kind === 'control');
  const caught = red.filter((r) => r.ok);
  const controlsOk = controls.filter((r) => r.ok);
  const healthy = results.length > 0 && caught.length === red.length && controlsOk.length === controls.length;

  if (json) {
    console.log(JSON.stringify({ healthy, total: results.length, red: red.length, caught: caught.length, controls: controls.length, controls_ok: controlsOk.length, results }, null, 2));
    return healthy ? 0 : 1;
  }
  for (const r of results) {
    const mark = r.ok ? '✓' : '✗';
    const verb = r.kind === 'red' ? (r.ok ? 'caught' : 'MISSED') : r.ok ? 'passes clean' : 'BROKEN';
    console.log(`${mark} [${r.kind}] ${r.id} — ${verb}`);
    if (!r.ok) {
      console.log(`    ${r.what}`);
      if (r.error) console.log(`    probe error: ${r.error}`);
    }
  }
  console.log(`\nGATE_PROBES total=${results.length} caught=${caught.length}/${red.length} controls=${controlsOk.length}/${controls.length}`);
  if (!healthy) {
    console.error(
      'A missed probe is a class of defect that can currently merge through this gate unseen.\n' +
        'The runtime under imp/modules/ has probably been modified — restore it with `npx impactus --update-runtime`.',
    );
    return 1;
  }
  return 0;
}

const isMain = isMainModule(import.meta.url);
if (isMain) process.exit(await runCli(process.argv.slice(2)));
