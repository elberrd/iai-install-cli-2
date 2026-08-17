import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FIA } from '../src/config.js';
import {
  auditPrompt,
  authorPrompt,
  formatQaReport,
  parseQaCli,
  qaEvidenceGaps,
  qaReportRelPath,
  resolveQaScope,
  resolveVideoPolicy,
  scopeNeedsUi,
  writeQaReport,
} from '../fia-templates/modules/qa-gate.mjs';
import {
  playwrightConfigTemplate,
  preflightInstallHint,
  preflightPlaywright,
  readPackageScripts,
} from '../fia-templates/modules/qa-playwright.mjs';
import { runLaunchChecks } from '../fia-templates/scripts/fia-launch-check.mjs';

function fixtureRoot({ milestones, issues = {}, specs = {}, qaReports = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fia-qa-'));
  mkdirSync(join(root, 'ai-docs', 'todos', 'issues'), { recursive: true });
  mkdirSync(join(root, 'ai-docs', 'specs'), { recursive: true });
  mkdirSync(join(root, 'ai-docs', 'qa'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'qa-fixture', scripts: { dev: 'echo dev', test: 'node -e "process.exit(0)"' } }) + '\n',
  );
  if (milestones) writeFileSync(join(root, 'ai-docs', 'milestones.md'), milestones);
  for (const [name, body] of Object.entries(issues)) {
    writeFileSync(join(root, 'ai-docs', 'todos', 'issues', name), body);
  }
  for (const [name, body] of Object.entries(specs)) {
    writeFileSync(join(root, 'ai-docs', 'specs', name), body);
  }
  writeFileSync(
    join(root, 'ai-docs', 'todos', 'task-master.md'),
    '| Task | Status |\n| --- | --- |\n| [01](issues/01-ui.md) | done |\n',
  );
  for (const report of qaReports) {
    writeFileSync(join(root, 'ai-docs', 'qa', report.name), report.body);
  }
  return root;
}

const MILESTONES = `# Milestones

## M1 — MVP

Goal: First usable slice
Done when:
- User can sign in
- Dashboard loads
Tasks: 01
Status: done
`;

const ISSUE_UI = `# Task 01 — Dashboard

Status: done
Surface: ui

## Acceptance Criteria
- [x] Dashboard renders
`;

const ISSUE_API = `# Task 02 — Webhook

Status: done
Surface: api

## Acceptance Criteria
- [x] Signature verified
`;

// ── video policy ─────────────────────────────────────────────────────────────

test('resolveVideoPolicy: default and invalid values', () => {
  assert.equal(resolveVideoPolicy(undefined), 'retain-on-failure');
  assert.equal(resolveVideoPolicy('on'), 'on');
  assert.equal(resolveVideoPolicy('off'), 'off');
  assert.equal(resolveVideoPolicy('bogus'), 'retain-on-failure');
});

test('parseQaCli: strips --video and reads config default', () => {
  const out = parseQaCli('M1 --video on', { qa: { video: 'off' } });
  assert.equal(out.scopeRaw, 'M1');
  assert.equal(out.video, 'on');
  const cfg = parseQaCli('spec 0003', { qa: { video: 'off' } });
  assert.equal(cfg.video, 'off');
});

// ── scope resolution ─────────────────────────────────────────────────────────

test('resolveQaScope: milestone M1', () => {
  const root = fixtureRoot({ milestones: MILESTONES, issues: { '01-ui.md': ISSUE_UI } });
  const { scope } = resolveQaScope('M1', root);
  assert.equal(scope.kind, 'milestone');
  assert.equal(scope.id, 'M1');
  assert.ok(scope.doneWhen.includes('User can sign in'));
});

test('resolveQaScope: task number', () => {
  const root = fixtureRoot({ milestones: MILESTONES, issues: { '01-ui.md': ISSUE_UI } });
  const { scope } = resolveQaScope('01', root);
  assert.equal(scope.kind, 'task');
  assert.equal(scope.num, '01');
});

test('resolveQaScope: infer single milestone when tasks done and no report', () => {
  const root = fixtureRoot({ milestones: MILESTONES, issues: { '01-ui.md': ISSUE_UI } });
  const { scope, inferred } = resolveQaScope('', root);
  assert.equal(inferred, true);
  assert.equal(scope.id, 'M1');
});

test('resolveQaScope: ambiguous when multiple scopes qualify', () => {
  const milestones = `${MILESTONES}

## M2 — Beta

Goal: More
Done when:
- Reports export
Tasks: 02
Status: done
`;
  const root = fixtureRoot({
    milestones,
    issues: {
      '01-ui.md': ISSUE_UI,
      '02-ui.md': ISSUE_UI.replace('01', '02').replace('Dashboard', 'Reports'),
    },
  });
  writeFileSync(
    join(root, 'ai-docs', 'todos', 'task-master.md'),
    '| Task | Status |\n| --- | --- |\n| [01](issues/01-ui.md) | done |\n| [02](issues/02-ui.md) | done |\n',
  );
  const out = resolveQaScope('', root);
  assert.equal(out.ambiguous, true);
  assert.ok(out.candidates.length >= 2);
});

test('scopeNeedsUi: API-only task does not need browser QA', () => {
  const root = fixtureRoot({ issues: { '02-api.md': ISSUE_API } });
  const scope = { kind: 'task', num: '02', label: 'Task 02', taskNums: ['02'] };
  assert.equal(scopeNeedsUi(scope, root), false);
});

test('scopeNeedsUi: UI task needs browser QA', () => {
  const root = fixtureRoot({ issues: { '01-ui.md': ISSUE_UI } });
  const scope = { kind: 'task', num: '01', label: 'Task 01', taskNums: ['01'] };
  assert.equal(scopeNeedsUi(scope, root), true);
});

// ── report paths ─────────────────────────────────────────────────────────────

test('qaReportRelPath and writeQaReport', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-qa-report-'));
  const scope = { kind: 'milestone', id: 'M1', label: 'M1 — MVP' };
  const rel = qaReportRelPath(scope, new Date('2026-08-17T12:00:00Z'));
  assert.match(rel, /ai-docs\/qa\/2026-08-17-m1\.md/);
  const body = formatQaReport({
    scope,
    e2ePassed: true,
    auditPassed: true,
    doneWhen: ['Sign in works'],
    artifactDir: 'imp/data/qa/run-1',
    fdaId: 'qa-test',
  });
  assert.match(body, /Status: passed/);
  const written = writeQaReport(root, scope, body);
  assert.equal(written, rel);
});

test('gitignore lists imp/data/qa/', () => {
  assert.ok(FIA.gitignoreEntries.includes('imp/data/qa/'));
});

// ── preflight messaging ──────────────────────────────────────────────────────

test('preflightPlaywright: missing deps names install command', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-qa-pf-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: {} }) + '\n');
  const check = await preflightPlaywright(root);
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((p) => /playwright/i.test(p)));
  assert.match(check.installHint, /npm install -D @playwright\/test/);
  assert.match(preflightInstallHint(), /playwright install chromium/);
});

test('playwrightConfigTemplate mentions FIA_QA_VIDEO and webServer', () => {
  const text = playwrightConfigTemplate();
  assert.match(text, /FIA_QA_VIDEO/);
  assert.match(text, /webServer/);
  assert.match(text, /iPhone 13/);
});

test('readPackageScripts returns empty object when package.json missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-qa-pkg-'));
  assert.deepEqual(readPackageScripts(root), {});
});

// ── prompts ──────────────────────────────────────────────────────────────────

test('authorPrompt and auditPrompt mention scope and artifacts', () => {
  const scope = { label: 'M1 — MVP', doneWhen: ['Sign in'] };
  assert.match(authorPrompt(scope, { routes: ['/dashboard'] }), /Sign in/);
  const audit = auditPrompt(scope, { artifactDir: 'imp/data/qa/x', e2eSummary: 'ok' });
  assert.match(audit, /imp\/data\/qa\/x/);
  assert.match(audit, /interaction\.md/);
});

// ── launch-check integration ─────────────────────────────────────────────────

test('qaEvidenceGaps: done milestone without report', () => {
  const root = fixtureRoot({ milestones: MILESTONES, issues: { '01-ui.md': ISSUE_UI } });
  assert.deepEqual(qaEvidenceGaps(root), ['M1']);
});

test('runLaunchChecks: warns when done milestone lacks QA report', () => {
  const root = fixtureRoot({ milestones: MILESTONES, issues: { '01-ui.md': ISSUE_UI } });
  writeFileSync(
    join(root, 'ai-docs', 'stack.md'),
    '# Stack\n\n| Layer | Choice |\n| --- | --- |\n| Frontend | next |\n',
  );
  const report = runLaunchChecks(root, { inRepo: false });
  const row = report.checks.find((r) => r.id === 'qa_evidence');
  assert.ok(row, 'qa_evidence row missing from launch check');
  assert.equal(row.status, 'fail');
  assert.match(row.detail || '', /M1/);
});
