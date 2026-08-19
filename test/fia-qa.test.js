import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  routesForQaScope,
  scopeNeedsUi,
  uiQaRulePlan,
  writeQaReport,
} from '../fia-templates/modules/qa-gate.mjs';
import { defaultContract, saveUiContract } from '../fia-templates/scripts/ui-contract.mjs';
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

function addUiContract(root, profile = 'enterprise-admin') {
  saveUiContract(root, defaultContract(profile));
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

test('scopeNeedsUi: UI task fails closed without a valid UI contract', () => {
  const root = fixtureRoot({ issues: { '01-ui.md': ISSUE_UI } });
  const scope = { kind: 'task', num: '01', label: 'Task 01', taskNums: ['01'] };
  assert.throws(() => scopeNeedsUi(scope, root), /UI contract not found/);
});

test('scopeNeedsUi: UI task with a valid contract needs browser QA', () => {
  const root = addUiContract(fixtureRoot({ issues: { '01-ui.md': ISSUE_UI } }));
  const scope = { kind: 'task', num: '01', label: 'Task 01', taskNums: ['01'] };
  assert.equal(scopeNeedsUi(scope, root), true);
});

// ── report paths ─────────────────────────────────────────────────────────────

test('qaReportRelPath and writeQaReport', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-qa-report-'));
  const scope = { kind: 'milestone', id: 'M1', label: 'M1 — MVP' };
  const reportDate = new Date('2026-08-17T12:00:00Z');
  const rel = qaReportRelPath(scope, reportDate);
  assert.equal(rel, 'ai-docs/qa/2026-08-17-m1.md');
  const body = formatQaReport({
    scope,
    e2ePassed: true,
    auditPassed: true,
    doneWhen: ['Sign in works'],
    artifactDir: 'imp/data/qa/run-1',
    fdaId: 'qa-test',
  });
  assert.match(body, /Status: passed/);
  const written = writeQaReport(root, scope, body, reportDate);
  assert.equal(written, rel);
});

test('formatQaReport preserves deterministic APPLY and SKIP reasons without pre-awarding PASS', () => {
  const root = addUiContract(fixtureRoot({ issues: { '01-ui.md': ISSUE_UI } }));
  const scope = { kind: 'task', num: '01', label: 'Task 01', taskNums: ['01'] };
  assert.equal(scopeNeedsUi(scope, root), true);
  const body = formatQaReport({
    scope,
    e2ePassed: true,
    auditPassed: true,
    fdaId: 'qa-contract-test',
  });
  assert.match(body, /Profile: enterprise-admin/);
  assert.match(body, /APPLY components\.data_table.*data_dense_workflow/);
  assert.match(body, /SKIP components\.kanban.*feature_not_requested/);
  assert.doesNotMatch(body, /PASS components\.data_table/);
});

test('formatQaReport records executable UI-kit verification evidence', () => {
  const body = formatQaReport({
    scope: { kind: 'task', num: '01', label: 'Task 01' },
    e2ePassed: true,
    auditPassed: true,
    kitReceipt: { ok: true },
  });
  assert.match(body, /UI kit receipt: verified/);
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
  assert.match(text, /width: 360/);
  assert.match(text, /width: 768/);
  assert.match(text, /width: 1440/);
});

test('readPackageScripts returns empty object when package.json missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-qa-pkg-'));
  assert.deepEqual(readPackageScripts(root), {});
});

// ── prompts ──────────────────────────────────────────────────────────────────

test('authorPrompt and auditPrompt mention scope and artifacts', () => {
  const scope = { label: 'M1 — MVP', doneWhen: ['Sign in'] };
  const contract = defaultContract('enterprise-admin');
  const authored = authorPrompt(scope, { routes: ['/dashboard'], contract });
  assert.match(authored, /Sign in/);
  assert.match(authored, /100%, 125%, and 200%/);
  assert.match(authored, /system, light, and dark/);
  assert.match(authored, /right-click/);
  assert.match(authored, /keyboard/);
  assert.match(authored, /toolbar height/);
  assert.match(authored, /compact/);
  assert.match(authored, /SKIP components\.kanban.*feature_not_requested/);
  const audit = auditPrompt(scope, {
    artifactDir: 'imp/data/qa/x',
    e2eSummary: 'ok',
    contract,
  });
  assert.match(audit, /imp\/data\/qa\/x/);
  assert.match(audit, /interaction\.md/);
});

test('base DataTable QA never inherits advanced grouping, pinning, or reorder requirements', () => {
  const scope = { label: 'Base table only' };
  const contract = defaultContract('operational-saas');
  contract.capabilities.dataTables = true;

  const authored = authorPrompt(scope, { contract });
  assert.match(authored, /Selected shared DataTable\/data grid \(base\)/);
  for (const requirement of [
    /one Filter control/i,
    /visible header button/i,
    /left-click/i,
    /right-click/i,
    /Shift\+F10/i,
    /compact removable filter chips/i,
    /Clear filters/i,
    /sort.*hide.*reset/i,
    /advancedControls.*(?:omitted|default false)/i,
    /no advanced-only/i,
  ]) {
    assert.match(authored, requirement);
  }
  assert.doesNotMatch(authored, /Advanced DataTable:/);
  assert.doesNotMatch(
    authored,
    /ordered grouping lane|dedicated column-drag handle|pinning|versioned per-user|Restore defaults|sticky header|server-side sorting|virtualization/i,
  );

  const audit = auditPrompt(scope, {
    artifactDir: 'imp/data/qa/base-table',
    contract,
  });
  assert.match(audit, /registry-selected shared DataTable\/data-grid/i);
  assert.match(audit, /Canonical preset receipt/i);
  assert.match(audit, /one Filter control/i);
  assert.match(audit, /compact removable filter chips/i);
  assert.match(audit, /Shift\+F10/i);
  assert.match(audit, /advancedControls.*(?:omitted|default false)/i);
  assert.match(audit, /no advanced-only/i);
  assert.doesNotMatch(
    audit,
    /ordered grouping lane|dedicated column-drag handle|pinning|versioned per-user|Restore defaults|sticky header|server-side sorting|virtualization/i,
  );
});

test('QA route applicability is passed explicitly instead of leaking from a prior prompt', () => {
  const scope = { label: 'Route depth isolation' };
  const contract = defaultContract('operational-saas');

  const deep = authorPrompt(scope, { routes: ['/projects/123'], contract });
  assert.match(deep, /APPLY navigation\.breadcrumb.*nested_route_hierarchy/);

  const shallow = auditPrompt(scope, {
    artifactDir: 'imp/data/qa/shallow-route',
    routes: ['/dashboard'],
    contract,
  });
  assert.match(shallow, /SKIP navigation\.breadcrumb.*flat_route/);
  assert.doesNotMatch(shallow, /APPLY navigation\.breadcrumb/);
});

test('a flat QA scope is not contaminated by deeper routes elsewhere in the screen matrix', () => {
  const root = fixtureRoot({
    milestones: MILESTONES,
    issues: {
      '01-ui.md': `${ISSUE_UI}\n**Source:** screen \`/dashboard\`\n`,
    },
  });
  writeFileSync(
    join(root, 'ai-docs', 'screens-routes.md'),
    [
      '# Screens and routes',
      '',
      '| Route | Screen Component |',
      '| --- | --- |',
      '| `/dashboard` | DashboardPage |',
      '| `/projects/:projectId/tasks` | ProjectTasksPage |',
      '',
    ].join('\n'),
  );

  const { scope } = resolveQaScope('01', root);
  assert.deepEqual(routesForQaScope(scope, root), ['/dashboard']);
  assert.deepEqual(scope.routes, ['/dashboard']);

  const contract = defaultContract('operational-saas');
  const prompt = authorPrompt(scope, {
    routes: ['/dashboard', '/projects/:projectId/tasks'],
    contract,
  });
  assert.match(prompt, /SKIP navigation\.breadcrumb.*flat_route/);
  assert.doesNotMatch(prompt, /projects\/:projectId\/tasks/);
});

test('QA route depth stays unknown and fail-closed when the scope names no route', () => {
  const root = fixtureRoot({ milestones: MILESTONES, issues: { '01-ui.md': ISSUE_UI } });
  writeFileSync(
    join(root, 'ai-docs', 'screens-routes.md'),
    '| Route | Screen Component |\n| --- | --- |\n| `/deep/route` | DeepPage |\n',
  );

  const { scope } = resolveQaScope('01', root);
  assert.deepEqual(scope.routes, []);
  const prompt = authorPrompt(scope, { routes: ['/deep/route'], contract: defaultContract('operational-saas') });
  assert.match(prompt, /APPLY navigation\.breadcrumb.*route_depth_unknown_fail_closed/);
  assert.doesNotMatch(prompt, /Routes from ai-docs\/screens-routes\.md/);
});

test('advanced DataTable QA proves enterprise view state, truthful counts, and reload behavior', () => {
  const scope = { label: 'Enterprise table' };
  const contract = defaultContract('enterprise-admin');
  const authored = authorPrompt(scope, { contract });

  for (const requirement of [
    /Advanced DataTable:/,
    /advancedControls=\{true\}/i,
    /ordered grouping lane/i,
    /\+ Level/,
    /maximum of three levels/i,
    /leaf-record count/i,
    /currently expanded leaf DOM rows/i,
    /versioned per-user view/i,
    /Restore defaults/i,
    /reload/i,
    /dedicated column-drag handle/i,
    /insertion indicator/i,
    /cancel/i,
    /menu and keyboard fallback/i,
    /sticky header/i,
    /server-side sorting, filtering, and pagination/i,
    /many already-loaded rows/i,
  ]) {
    assert.match(authored, requirement);
  }

  const audit = auditPrompt(scope, {
    artifactDir: 'imp/data/qa/advanced-table',
    contract,
  });
  assert.match(audit, /Restore defaults.*reload/i);
  assert.match(audit, /leaf-record count/i);
  assert.match(audit, /server-side/i);
});

test('browser QA honors an explicit table library while retaining the universal enterprise behavior', () => {
  const scope = { label: 'Enterprise alternate grid' };
  const contract = defaultContract('enterprise-admin');
  contract.implementation.surfaces.data_table = {
    mode: 'existing-library',
    package: 'ag-grid-enterprise',
    path: 'src/components/data-table/ag-grid.tsx',
    reason: 'user_explicit_existing_library',
  };

  const authored = authorPrompt(scope, { contract });
  assert.match(authored, /data_table: existing-library ag-grid-enterprise/i);
  assert.match(authored, /canonical source installation is forbidden/i);
  assert.match(authored, /semantic accessible table\/grid structure/i);
  assert.match(authored, /explicit advanced-mode configuration/i);
  assert.match(authored, /ordered grouping lane/i);
  assert.doesNotMatch(authored, /require advancedControls=\{true\}|Canonical preset receipt/i);

  const audit = auditPrompt(scope, {
    artifactDir: 'imp/data/qa/alternate-grid',
    contract,
  });
  assert.match(audit, /registry-selected shared DataTable\/data-grid/i);
  assert.match(audit, /selected implementation's explicit advanced configuration/i);
  assert.doesNotMatch(audit, /FIA TanStack DataTable|advancedControls=\{true\}/i);
});

test('uiQaRulePlan separates applicable rules from reasoned skips', () => {
  const plan = uiQaRulePlan(defaultContract('enterprise-admin'));
  assert.deepEqual(
    plan.find((item) => item.ruleId === 'components.data_table'),
    {
      ruleId: 'components.data_table',
      status: 'required',
      reason: 'data_dense_workflow',
      applicable: true,
      label: 'APPLY',
    },
  );
  assert.deepEqual(
    plan.find((item) => item.ruleId === 'components.kanban'),
    {
      ruleId: 'components.kanban',
      status: 'optional',
      reason: 'feature_not_requested',
      applicable: false,
      label: 'SKIP',
    },
  );
});

test('immersive profile keeps quality zoom checks but skips theme and enterprise widgets', () => {
  const scope = { label: 'Game' };
  const prompt = authorPrompt(scope, { contract: defaultContract('immersive-game') });
  assert.match(prompt, /100%, 125%, and 200%/);
  assert.match(prompt, /SKIP theme\.user_switcher.*art_directed_fixed_theme/);
  assert.doesNotMatch(prompt, /Exercise system, light, and dark/);
  assert.doesNotMatch(prompt, /right-click each table header/);
  assert.doesNotMatch(prompt, /DragOverlay alignment/);
});

// ── launch-check integration ─────────────────────────────────────────────────

test('qaEvidenceGaps: done milestone without report', () => {
  const root = addUiContract(fixtureRoot({ milestones: MILESTONES, issues: { '01-ui.md': ISSUE_UI } }));
  assert.deepEqual(qaEvidenceGaps(root), ['M1']);
});

test('runLaunchChecks: warns when done milestone lacks QA report', () => {
  const root = addUiContract(fixtureRoot({ milestones: MILESTONES, issues: { '01-ui.md': ISSUE_UI } }));
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

test('runLaunchChecks: missing UI contract is reported and never thrown before QA evidence', () => {
  const root = fixtureRoot({ milestones: MILESTONES, issues: { '01-ui.md': ISSUE_UI } });
  writeFileSync(
    join(root, 'ai-docs', 'stack.md'),
    '# Stack\n\n| Layer | Choice |\n| --- | --- |\n| Frontend | next |\n',
  );

  let report;
  assert.doesNotThrow(() => {
    report = runLaunchChecks(root, { inRepo: false });
  });
  const byId = Object.fromEntries(report.checks.map((row) => [row.id, row]));
  assert.equal(byId.ui_contract.status, 'fail');
  assert.match(byId.ui_contract.detail, /contract\.json is missing/);
  assert.ok(byId.qa_evidence, 'qa_evidence row should still be emitted');
  assert.equal(byId.qa_evidence.detail, 'QA applicability could not be resolved from the validated UI contract');
});

test('browser QA verifies the executable UI-kit receipt before authoring tests', () => {
  const source = readFileSync(new URL('../fia-templates/fda_qa.mjs', import.meta.url), 'utf8');
  assert.match(source, /verifyUiKitReceipt\(run\.repoRoot, contract\)/);
  assert.match(source, /ui kit receipt incomplete before browser QA/);
  assert.ok(
    source.indexOf('verifyUiKitReceipt(run.repoRoot, contract)') < source.indexOf("phaseParams('author'"),
    'receipt verification must run before the browser-test author agent',
  );
});
