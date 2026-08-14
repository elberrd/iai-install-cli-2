import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  artifactsExist,
  filesNonEmpty,
  diffMatchesClaims,
  verdictConsistent,
  gateReport,
  isFoundationBrief,
} from '../fia-templates/modules/gates.mjs';

function mockRun(files = {}) {
  return {
    fs: {
      existsSync: (p) => Boolean(files[p]),
      statSync: (p) => {
        if (!files[p]) throw new Error(`missing ${p}`);
        return { size: files[p].size ?? 10, isFile: () => files[p].isFile !== false };
      },
    },
  };
}

test('gateReport: tracks violations', () => {
  const r = gateReport().check('a', false, 'bad').check('b', true, 'ok');
  assert.equal(r.passed, false);
  assert.deepEqual(r.violations, ['a: bad']);
});

test('artifactsExist: missing artifact fails gate', () => {
  const report = artifactsExist({ artifacts: ['missing.txt'] }, mockRun());
  assert.equal(report.passed, false);
});

test('artifactsExist: declared artifact present on disk passes', () => {
  const report = artifactsExist({ artifacts: ['out.md'] }, mockRun({ 'out.md': { size: 42 } }));
  assert.equal(report.passed, true);
  assert.deepEqual(report.violations, []);
});

test('artifactsExist: empty artifact list fails instead of passing vacuously', () => {
  const report = artifactsExist({ artifacts: [] }, mockRun());
  assert.equal(report.passed, false);
  assert.match(report.violations[0], /lists no artifacts/);
  const missingField = artifactsExist({}, mockRun());
  assert.equal(missingField.passed, false);
});

test('filesNonEmpty: empty artifact list fails instead of passing vacuously', () => {
  const report = filesNonEmpty({ artifacts: [] }, mockRun());
  assert.equal(report.passed, false);
  assert.match(report.violations[0], /lists no artifacts/);
});

test('filesNonEmpty: zero-byte file fails', () => {
  const report = filesNonEmpty({ artifacts: ['empty.txt'] }, mockRun({ 'empty.txt': { size: 0 } }));
  assert.equal(report.passed, false);
});

test('filesNonEmpty: non-empty file passes', () => {
  const report = filesNonEmpty({ artifacts: ['full.txt'] }, mockRun({ 'full.txt': { size: 128 } }));
  assert.equal(report.passed, true);
  assert.deepEqual(report.violations, []);
});

test('diffMatchesClaims: requires claimed files', () => {
  const ok = diffMatchesClaims({ changed_files: ['src/a.js'] }, mockRun({ 'src/a.js': {} }));
  assert.equal(ok.passed, true);
  const bad = diffMatchesClaims({ changed_files: ['src/b.js'] }, mockRun());
  assert.equal(bad.passed, false);
});

test('verdictConsistent: approved with blocking fails', () => {
  const report = verdictConsistent({
    approved: true,
    blocking: ['missing test'],
    findings: [],
  });
  assert.equal(report.passed, false);
});

test('verdictConsistent: rejection must cite a reason', () => {
  const report = verdictConsistent({ approved: false, blocking: [], findings: [] });
  assert.equal(report.passed, false);
});

test('verdictConsistent: clean approval passes', () => {
  const report = verdictConsistent({
    approved: true,
    blocking: [],
    findings: [{ requirement: 'has tests', met: true }],
  });
  assert.equal(report.passed, true);
  assert.deepEqual(report.violations, []);
});

test('verdictConsistent: approved with unmet findings fails', () => {
  const report = verdictConsistent({
    approved: true,
    blocking: [],
    findings: [{ requirement: 'has tests', met: false }],
  });
  assert.equal(report.passed, false);
  assert.match(report.violations.join('\n'), /unmet while approved=true/);
});

test('isFoundationBrief: plain meta line at line start arms the build check', () => {
  assert.equal(isFoundationBrief('# Task 01\n\nKind: foundation\n\n## Overview'), true);
  assert.equal(isFoundationBrief('Milestone: M1\nkind: Foundation\n'), true); // tolerant of case
  // The greenfield core-component-kit task (Task 02) arms the build the same way.
  assert.equal(isFoundationBrief('# Task 02\n\nKind: kit\n\n## Overview'), true);
  assert.equal(isFoundationBrief('Milestone: M1\nKind: Kit\n'), true);
});

test('isFoundationBrief: bold, inline mentions and absence do not arm it', () => {
  assert.equal(isFoundationBrief('**Kind: foundation** is the meta line'), false);
  assert.equal(isFoundationBrief('the issue carries a Kind: foundation line'), false);
  assert.equal(isFoundationBrief('Kind: foundational-work\n'), false);
  assert.equal(isFoundationBrief('Kind: kitchen-sink\n'), false);
  assert.equal(isFoundationBrief('**Kind: kit** is the meta line'), false);
  assert.equal(isFoundationBrief('# Task 02\n\nSpec: 0001 (S-1)\n'), false);
  assert.equal(isFoundationBrief(null), false);
});
