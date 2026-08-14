import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSpecLine, checkSpecCoverage } from '../fia-templates/modules/gates.mjs';

/** Throwaway tree (NOT a git repo → checkSpecCoverage exercises the fallback scan). */
function treeWith(files) {
  const root = mkdtempSync(join(tmpdir(), 'spec-cov-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

// ── parseSpecLine (the C3 brief/issue line) ──────────────────────────────────

test('parseSpecLine: extracts the spec id and the promised ids', () => {
  const ref = parseSpecLine('# Task 07\n\nSpec: 0003 (S-1, S-4)\n\nDo the thing.');
  assert.deepEqual(ref, { specId: '0003', ids: ['S-1', 'S-4'] });
});

test('parseSpecLine: requirement ids are accepted alongside scenarios', () => {
  assert.deepEqual(parseSpecLine('Spec: 0012 (S-2,FR-1,NFR-3)').ids, ['S-2', 'FR-1', 'NFR-3']);
});

test('parseSpecLine: no Spec line → null (the coverage check is skipped)', () => {
  assert.equal(parseSpecLine('just a brief with no spec reference'), null);
  assert.equal(parseSpecLine(''), null);
  assert.equal(parseSpecLine(null), null);
});

test('parseSpecLine: only a line-start Spec: counts, and empty parens are null', () => {
  assert.equal(parseSpecLine('see Spec: 0003 (S-1) for details'), null, 'mid-line mention is not a linkage');
  assert.equal(parseSpecLine('Spec: 0003 ( , )'), null, 'no usable ids');
});

// ── checkSpecCoverage: marker parsing via the fallback scan ──────────────────

test('checkSpecCoverage: every promised id present in covers: lists → pass', () => {
  const root = treeWith({
    'src/vat.test.ts': '// spec:0003 covers:S-1,S-2,FR-2\nimport { test } from "vitest";\n',
  });
  const report = checkSpecCoverage({ specId: '0003', ids: ['S-1', 'FR-2'], repoRoot: root });
  assert.equal(report.passed, true);
  assert.deepEqual(report.violations, []);
});

test('checkSpecCoverage: coverage may be spread across several test files', () => {
  const root = treeWith({
    'src/vat.test.ts': '// spec:0003 covers:S-1\n',
    'src/deep/nested/rounding.spec.js': '/* spec:0003 covers:S-2,FR-2 */\n',
  });
  const report = checkSpecCoverage({ specId: '0003', ids: ['S-1', 'S-2', 'FR-2'], repoRoot: root });
  assert.equal(report.passed, true);
});

test('checkSpecCoverage: a missing id fails and is listed by name', () => {
  const root = treeWith({ 'src/vat.test.ts': '// spec:0003 covers:S-1\n' });
  const report = checkSpecCoverage({ specId: '0003', ids: ['S-1', 'S-9'], repoRoot: root });
  assert.equal(report.passed, false);
  assert.match(report.violations.join('\n'), /S-9/);
  assert.ok(!/S-1:/.test(report.violations.join('\n')), 'the covered id is not a violation');
});

test('checkSpecCoverage: markers for ANOTHER spec do not count', () => {
  const root = treeWith({ 'src/vat.test.ts': '// spec:0004 covers:S-1\n' });
  const report = checkSpecCoverage({ specId: '0003', ids: ['S-1'], repoRoot: root });
  assert.equal(report.passed, false);
  assert.match(report.violations.join('\n'), /no test file carries/);
});

test('checkSpecCoverage: fallback scan reads only *.test.* / *.spec.* files', () => {
  const root = treeWith({
    'notes.md': 'spec:0003 covers:S-1 — quoted in prose, not a test\n',
    'node_modules/pkg/x.test.js': '// spec:0003 covers:S-1\n',
  });
  const report = checkSpecCoverage({ specId: '0003', ids: ['S-1'], repoRoot: root });
  assert.equal(report.passed, false, 'prose and node_modules never count');
});

test('checkSpecCoverage: git grep path — untracked test files in a repo are seen', (t) => {
  const root = treeWith({ 'src/vat.test.ts': '// spec:0003 covers:S-1,S-2\n' });
  try {
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'pipe' });
  } catch {
    t.skip('git unavailable');
    return;
  }
  const report = checkSpecCoverage({ specId: '0003', ids: ['S-1', 'S-2'], repoRoot: root });
  assert.equal(report.passed, true);
});

test('checkSpecCoverage: git grep path counts test files only — shipped docs never cover', (t) => {
  // Every stamped project ships docs that QUOTE the marker (the tdd skill, the
  // specs cookbook). git grep sees them: they must not satisfy the gate.
  const root = treeWith({
    '.claude/skills/tdd/SKILL.md': '// spec:0003 covers:S-1,S-2,FR-2\n',
    'src/vat.ts': '// spec:0003 covers:S-1 — production code, not a test\n',
  });
  try {
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'pipe' });
  } catch {
    t.skip('git unavailable');
    return;
  }
  const report = checkSpecCoverage({ specId: '0003', ids: ['S-1', 'S-2'], repoRoot: root });
  assert.equal(report.passed, false);
  assert.match(report.violations.join('\n'), /no test file carries/);
});
