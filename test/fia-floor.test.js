// The regression floor (modules/floor.mjs): a ratchet with zero slack under
// the test suite. Observed >= floor or the green result turns red; the floor
// only rises, and it rises from CODE — agents cannot edit the file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parsePassedCount, enforceFloor, readFloor, floorPath } from '../fia-templates/modules/floor.mjs';

function freshRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'fia-floor-'));
  return { repo, data: join(repo, 'imp', 'data') };
}

// ── summary parsing ──────────────────────────────────────────────────────────

test('parsePassedCount: recognizes the common runners, refuses to guess otherwise', () => {
  assert.equal(parsePassedCount('Test Files  3 passed (3)\n     Tests  42 passed (42)'), 42); // vitest
  assert.equal(parsePassedCount('Tests:       2 failed, 40 passed, 42 total'), 40); // jest with failures
  assert.equal(parsePassedCount('# tests 12\n# suites 0\n# pass 11\n# fail 1'), 11); // node:test TAP
  assert.equal(parsePassedCount('  37 passing (412ms)\n  1 pending'), 37); // mocha
  assert.equal(parsePassedCount('===== 5 passed, 1 warning in 0.42s ====='), 5); // pytest
  assert.equal(parsePassedCount('all good, trust me'), null); // no summary → no claim
  assert.equal(parsePassedCount(''), null);
});

test('parsePassedCount: a skipped/todo category never demotes the count to the SUITE census', () => {
  // Both runners print a suite census line BEFORE the test line. A pattern
  // that only tolerated a leading "N failed" stopped matching the moment a
  // student wrote it.skip, and the generic fallback then read "10 passed" off
  // the suite line — turning a permanently green suite permanently red.
  const jest = (tests) => `Test Suites: 10 passed, 10 total\nTests:       ${tests}\nSnapshots:   0 total`;
  assert.equal(parsePassedCount(jest('98 passed, 98 total')), 98);
  assert.equal(parsePassedCount(jest('2 skipped, 98 passed, 100 total')), 98);
  assert.equal(parsePassedCount(jest('1 todo, 98 passed, 99 total')), 98);
  assert.equal(parsePassedCount(jest('1 failed, 2 skipped, 95 passed, 98 total')), 95);
  assert.equal(parsePassedCount(' Test Files  12 passed (12)\n      Tests  5 skipped | 340 passed (345)'), 340);
  // A census with no test line at all is NOT a passing-test count.
  assert.equal(parsePassedCount('Test Suites: 10 passed, 10 total'), null);
  assert.equal(parsePassedCount('Test Files  12 passed (12)'), null);
});

// ── the ratchet ──────────────────────────────────────────────────────────────

test('first green run baselines the floor to exactly what was observed (zero slack)', () => {
  const { repo, data } = freshRepo();
  writeFileSync(join(repo, 'a.test.js'), 'x');
  writeFileSync(join(repo, 'b.spec.ts'), 'x');
  const report = enforceFloor({ dataDir: data, repoRoot: repo, testOutput: 'Tests: 7 passed' });
  assert.equal(report.ok, true);
  assert.equal(report.raised, true);
  const { floor } = readFloor(data);
  assert.deepEqual({ test_files: floor.test_files, tests_passed: floor.tests_passed }, { test_files: 2, tests_passed: 7 });
});

test('growth raises the floor; standing still holds it without rewriting', () => {
  const { repo, data } = freshRepo();
  writeFileSync(join(repo, 'a.test.js'), 'x');
  enforceFloor({ dataDir: data, repoRoot: repo, testOutput: 'Tests: 3 passed' });
  const held = enforceFloor({ dataDir: data, repoRoot: repo, testOutput: 'Tests: 3 passed' });
  assert.equal(held.ok, true);
  assert.equal(held.raised, false, 'an unchanged observation must not rewrite the file');
  writeFileSync(join(repo, 'b.test.js'), 'x');
  const grown = enforceFloor({ dataDir: data, repoRoot: repo, testOutput: 'Tests: 5 passed' });
  assert.equal(grown.raised, true);
  assert.equal(readFloor(data).floor.test_files, 2);
});

test('losing test files with NO parseable count is a violation — the census is the only signal left', () => {
  const { repo, data } = freshRepo();
  mkdirSync(data, { recursive: true });
  writeFileSync(floorPath(data), JSON.stringify({ test_files: 3, tests_passed: 10 }));
  writeFileSync(join(repo, 'only-one.test.js'), 'x');
  const report = enforceFloor({ dataDir: data, repoRoot: repo, testOutput: 'exotic runner, no summary' });
  assert.equal(report.ok, false);
  assert.match(report.violations[0], /1 test file\(s\).*floor is 3/);
});

test('merging test files is a REORGANIZATION, not a loss, when the passing count holds', () => {
  // The authoritative signal is how many tests passed; the file census is only
  // a proxy for it. Two suites merged into one (or a rename) must not fail a
  // run the builder could not repair anyway — floor.json is protected.
  const { repo, data } = freshRepo();
  mkdirSync(data, { recursive: true });
  writeFileSync(floorPath(data), JSON.stringify({ test_files: 2, tests_passed: 20 }));
  writeFileSync(join(repo, 'ab.test.js'), 'x');
  const report = enforceFloor({ dataDir: data, repoRoot: repo, testOutput: 'Tests: 22 passed' });
  assert.equal(report.ok, true, report.violations[0]);
  assert.equal(readFloor(data).floor.test_files, 1, 'the proxy re-baselines down so it cannot become unreachable');
  assert.equal(readFloor(data).floor.tests_passed, 22, 'the authoritative floor still only rises');
});

test('deleting tests is caught by the authoritative count even when the file census would allow it', () => {
  const { repo, data } = freshRepo();
  mkdirSync(data, { recursive: true });
  writeFileSync(floorPath(data), JSON.stringify({ test_files: 1, tests_passed: 20 }));
  writeFileSync(join(repo, 'a.test.js'), 'x');
  const report = enforceFloor({ dataDir: data, repoRoot: repo, testOutput: 'Tests: 12 passed' });
  assert.equal(report.ok, false);
  assert.match(report.violations[0], /12 test\(s\) passed.*floor is 20/);
});

test('the floor stamp is atomic — an interrupted write never leaves a corrupt file behind', () => {
  const { repo, data } = freshRepo();
  writeFileSync(join(repo, 'a.test.js'), 'x');
  enforceFloor({ dataDir: data, repoRoot: repo, testOutput: 'Tests: 3 passed' });
  // The temp file used for the rename must not survive a successful stamp.
  assert.equal(existsSync(`${floorPath(data)}.tmp`), false);
  assert.doesNotThrow(() => JSON.parse(readFileSync(floorPath(data), 'utf8')));
});

test('fewer passing tests than the floor is a violation even with the same files', () => {
  const { repo, data } = freshRepo();
  mkdirSync(data, { recursive: true });
  writeFileSync(floorPath(data), JSON.stringify({ test_files: 1, tests_passed: 10 }));
  writeFileSync(join(repo, 'a.test.js'), 'x');
  const report = enforceFloor({ dataDir: data, repoRoot: repo, testOutput: 'Tests: 4 passed' });
  assert.equal(report.ok, false);
  assert.match(report.violations[0], /4 test\(s\) passed.*floor is 10/);
});

test('an unparseable suite summary never trips the tests_passed floor (files still guard)', () => {
  const { repo, data } = freshRepo();
  mkdirSync(data, { recursive: true });
  writeFileSync(floorPath(data), JSON.stringify({ test_files: 1, tests_passed: 10 }));
  writeFileSync(join(repo, 'a.test.js'), 'x');
  const report = enforceFloor({ dataDir: data, repoRoot: repo, testOutput: 'exotic runner output' });
  assert.equal(report.ok, true, 'no parsed count → no count claim, only the file census applies');
});

test('a corrupt floor file FAILS CLOSED, and the message names both recoveries', () => {
  const { repo, data } = freshRepo();
  mkdirSync(data, { recursive: true });
  writeFileSync(floorPath(data), '{ not json');
  const report = enforceFloor({ dataDir: data, repoRoot: repo, testOutput: '' });
  assert.equal(report.ok, false);
  assert.match(report.violations[0], /not valid JSON/);
  assert.match(report.violations[0], /git checkout|delete it to re-baseline/);
});

test('node_modules and dist never inflate the census', () => {
  const { repo, data } = freshRepo();
  mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'dep', 'x.test.js'), 'x');
  writeFileSync(join(repo, 'real.test.js'), 'x');
  const report = enforceFloor({ dataDir: data, repoRoot: repo, testOutput: '' });
  assert.equal(report.observed.test_files, 1);
});

test('the stamped file explains itself — a student opening it learns the contract', () => {
  const { repo, data } = freshRepo();
  writeFileSync(join(repo, 'a.test.js'), 'x');
  enforceFloor({ dataDir: data, repoRoot: repo, testOutput: '' });
  const raw = readFileSync(floorPath(data), 'utf8');
  assert.match(raw, /ratchet/i);
  assert.match(raw, /human commit/i);
});

test('the floor is stamped inside the RUN\'s repo, never the process cwd', async () => {
  // Regression: a run whose cfg carries no `data_dir` used to resolve the
  // relative default against process.cwd(), stamping the floor into whatever
  // directory the process happened to be in — including this repo, during its
  // own test suite.
  const { runTestsForBrief } = await import('../fia-templates/modules/quality.mjs');
  const repo = mkdtempSync(join(tmpdir(), 'fia-floor-cwd-'));
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { test: 'node -e "process.exit(0)"' } }) + '\n',
  );
  writeFileSync(join(repo, 'a.test.js'), 'x');
  const run = {
    repoRoot: repo,
    cfg: {}, // no defaults.data_dir — the fallback path is what regressed
    fdaId: 'floor-cwd',
    env: process.env,
    console: { note: () => {} },
    tracer: { event: () => {} },
    contextHandoffDir: mkdtempSync(join(tmpdir(), 'fia-floor-handoff-')),
    phases: [{ phase_id: 'p', seq: 1 }],
  };
  const result = await runTestsForBrief(run, 'plain brief, no Kind: line');
  assert.equal(result.passed, true);
  assert.equal(readFloor(join(repo, 'imp', 'data')).floor.test_files, 1, 'the floor belongs to the run\'s repo');
  assert.equal(readFloor(join(process.cwd(), 'imp', 'data')).floor, null, 'nothing may be written next to the process cwd');
});

test('the floor reads STDOUT, so stderr noise can never evict the runner summary', async () => {
  // vitest prints its summary at the end of stdout while React Testing Library
  // warnings go to stderr; output_tail tails stdout+stderr together, so a noisy
  // suite used to hide the count — making the same tree pass on a quiet run and
  // fail on a noisy one.
  const { readFileSync } = await import('node:fs');
  const quality = readFileSync(join(import.meta.dirname, '..', 'fia-templates', 'modules', 'quality.mjs'), 'utf8');
  assert.match(quality, /stdout_tail: stdout\.slice\(-TAIL_CHARS\)/, 'runSpec keeps stdout on its own');
  assert.match(quality, /testOutput: testCheck\?\.stdout_tail \?\? testCheck\?\.output_tail/, 'the floor prefers it');

  // And the parser still finds the summary at the end of a noisy stdout.
  const noisyStderr = 'Warning: An update to X inside a test was not wrapped in act(...)\n'.repeat(200);
  const stdout = 'RUN v3\n' + ' PASS  src/a.test.ts\n'.repeat(50) + '\n Test Files  12 passed (12)\n      Tests  340 passed (340)\n';
  assert.equal(parsePassedCount(stdout.slice(-4000)), 340, 'stdout tail alone carries the count');
  assert.equal(parsePassedCount((stdout + noisyStderr).slice(-4000)), null, 'and the old combined tail did not');
});
