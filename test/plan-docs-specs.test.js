import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseMilestones,
  readPlanMilestones,
  parseSpec,
  normSpecStatus,
  readPlanSpecs,
  countInbox,
  readPlanInbox,
  readPlanOverview,
  listPlanDocs,
  readPlanWorkflow,
} from '../fia-templates/scripts/plan-docs.mjs';

/**
 * Fabricate an imperfect ai-docs/ tree for the milestone/spec/inbox layer:
 * template {{placeholders}}, a pipe-filled Status template line, an unknown
 * task ref and a non-spec file in specs/ — parsers must degrade, never throw.
 */
function seedAiDocs(root) {
  const dir = join(root, 'ai-docs');
  mkdirSync(join(dir, 'todos', 'issues'), { recursive: true });
  mkdirSync(join(dir, 'specs'), { recursive: true });

  writeFileSync(
    join(dir, 'milestones.md'),
    [
      '# Milestones',
      '',
      'Intro line that is not a milestone.',
      '',
      '## M1 — Foundation',
      '',
      'Goal: schema + auth working end to end',
      'Done when:',
      '- login works',
      '- [x] schema deployed',
      '- {{EXIT_CONDITION}}',
      'Tasks: 01, 02',
      'Status: done',
      '',
      '## M2 — MVP',
      '',
      '**Goal:** first usable flow',
      'Done when:',
      '- a task can be created',
      'Tasks: 03, 07 (filled as tasks are created)',
      'Status: pending | in-progress | done',
      '',
      '## M3 — {{NAME}}',
      '',
      'Goal: {{GOAL}}',
      // Exactly what the shipped template writes: placeholder task refs are
      // still placeholders — they must not keep the ghost section alive.
      'Tasks: {{01, 02, 05}}',
      'Status: {{STATUS | pending}}',
      '',
      '## Notes',
      '',
      'Status: this section has no milestone number and is ignored.',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(dir, 'specs', '0001-task-crud.md'),
    [
      '# Spec 0001 — Task CRUD',
      '',
      'Status: defined',
      'Created: 2026-08-01 · Updated: 2026-08-10',
      'Tasks: 01, 02',
      '',
      '## Problem & Outcome',
      'Users cannot manage tasks.',
      '',
      '## Gate log',
      'Definition Gate: passed — 2026-08-02',
      '- Delivery Gate: passed — 2026-08-10 — suite green',
      '',
    ].join('\n'),
  );
  // Legacy/loose spec: no "Spec NNNN" in the H1, template Status line.
  writeFileSync(
    join(dir, 'specs', '0002-billing.md'),
    '# Billing flow\n\nStatus: draft | defined | in-progress | done\n\n## Scope\nIn: charging.\n',
  );
  writeFileSync(join(dir, 'specs', 'README.md'), '# Not a spec\n');
  // The shipped reference example: format documentation, never a live spec.
  writeFileSync(join(dir, 'specs', '0000-example.md'), '# Spec 0000 — Task Creation (reference example)\n\nStatus: done\n');

  writeFileSync(
    join(dir, 'inbox.md'),
    [
      '# Inbox',
      '',
      '- [ ] 2026-08-11 — dark mode toggle (context: asked twice)',
      '- [x] 2026-08-10 — CSV export → spec 0001',
      '- [ ] 2026-08-12 — keyboard shortcuts',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(dir, 'todos', 'task-master.md'),
    [
      '# Task Master',
      '',
      '## Tasks',
      '| # | Task | Status | Blocked by |',
      '|---|------|--------|------------|',
      '| 01 | Setup schema | done | — |',
      '| 02 | Create task flow | pending | 01 |',
      '| 03 | List tasks | in-progress | 01 |',
      '',
    ].join('\n'),
  );
  return dir;
}

test('parseMilestones: C4 sections, declared status, template ghosts dropped', () => {
  const md = [
    '## M1 — Foundation',
    'Goal: base ready',
    'Done when:',
    '- login works',
    '',
    '- [ ] second list after a blank line',
    'Tasks: 01, 02',
    'Status: in-progress',
    '## Milestone 2: Launch',
    'Status: done',
    'Tasks: [Task 3](issues/03-x.md)',
  ].join('\n');
  const ms = parseMilestones(md);
  assert.equal(ms.length, 2);
  assert.equal(ms[0].id, 'M1');
  assert.equal(ms[0].name, 'Foundation');
  assert.equal(ms[0].goal, 'base ready');
  // Checkbox bullets count, blank lines between bullets survive.
  assert.deepEqual(ms[0].doneWhen, ['login works', 'second list after a blank line']);
  assert.deepEqual(ms[0].tasks, ['01', '02']);
  assert.equal(ms[0].status, 'in-progress');
  assert.equal(ms[0].statusRaw, 'in-progress');
  // "Milestone 2:" heading form and markdown-link task refs also parse.
  assert.equal(ms[1].id, 'M2');
  assert.equal(ms[1].name, 'Launch');
  assert.equal(ms[1].status, 'done');
  assert.deepEqual(ms[1].tasks, ['03']);
});

test('readPlanMilestones: refs resolve against tasks, unknown never counts as done', () => {
  const root = mkdtempSync(join(tmpdir(), 'plan-ms-'));
  const dir = seedAiDocs(root);
  const tasks = [
    { num: '01', status: 'done', title: 'Setup schema' },
    { num: '02', status: 'pending', title: 'Create task flow' },
    { num: '03', status: 'in-progress', title: 'List tasks' },
  ];
  const r = readPlanMilestones(dir, tasks);
  assert.equal(r.available, true);
  // M3 is 100% template placeholders → dropped; "## Notes" is not a milestone.
  assert.equal(r.milestones.length, 2);
  const m1 = r.milestones[0];
  assert.equal(m1.id, 'M1');
  assert.equal(m1.statusRaw, 'done');
  assert.deepEqual(m1.progress, { done: 1, total: 2 });
  assert.equal(m1.tasks[0].title, 'Setup schema');
  // Placeholder exit condition dropped, real ones (incl. checked) kept.
  assert.deepEqual(m1.doneWhen, ['login works', 'schema deployed']);
  const m2 = r.milestones[1];
  // The unfilled "pending | in-progress | done" template line is not a declaration…
  assert.equal(m2.status, 'pending');
  // …but the raw text is still surfaced, never auto-flipped by task progress.
  assert.equal(m2.statusRaw, 'pending | in-progress | done');
  // Task 07 does not exist in the index: known:false, not done.
  assert.deepEqual(m2.progress, { done: 0, total: 2 });
  assert.equal(m2.tasks.find((t) => t.num === '07').known, false);

  // Missing file → available:false, never throws.
  assert.equal(readPlanMilestones(join(root, 'nope'), tasks).available, false);
});

test('parseSpec: C1 header, gate log, tasks; loose H1 falls back to title', () => {
  const s = parseSpec(
    [
      '# Spec 3 — Webhook retries',
      '',
      '**Status:** in-progress',
      'Created: 2026-08-05 · Updated: 2026-08-11',
      'Tasks: 07, 08 (task numbers in ai-docs/todos/issues/)',
      '',
      '## Gate log',
      'Definition Gate: passed — 2026-08-06',
      '',
    ].join('\n'),
  );
  assert.equal(s.id, '0003', 'short id is zero-padded');
  assert.equal(s.title, 'Webhook retries');
  assert.equal(s.status, 'in-progress');
  assert.equal(s.created, '2026-08-05');
  assert.equal(s.updated, '2026-08-11');
  assert.deepEqual(s.tasks, ['07', '08'], 'trailing parenthetical adds no refs');
  assert.deepEqual(s.gateLog, ['Definition Gate: passed — 2026-08-06']);

  const loose = parseSpec('# Billing flow\n\nStatus: draft\n');
  assert.equal(loose.id, null);
  assert.equal(loose.title, 'Billing flow');
  assert.deepEqual(loose.gateLog, []);

  assert.equal(normSpecStatus('done'), 'done');
  assert.equal(normSpecStatus('Definid'), 'defined');
  // Template line lists every option → least-finished wins.
  assert.equal(normSpecStatus('draft | defined | in-progress | done'), 'draft');
  assert.equal(normSpecStatus(''), 'draft');
});

test('readPlanSpecs: lists NNNN-slug.md only; missing dir → available:false', () => {
  const root = mkdtempSync(join(tmpdir(), 'plan-sp-'));
  const dir = seedAiDocs(root);
  const r = readPlanSpecs(dir);
  assert.equal(r.available, true);
  assert.equal(r.specs.length, 2, 'README.md is not a spec, and 0000-example.md never counts as one');
  assert.equal(r.specs[0].id, '0001');
  assert.equal(r.specs[0].title, 'Task CRUD');
  assert.equal(r.specs[0].status, 'defined');
  assert.equal(r.specs[0].file, 'specs/0001-task-crud.md');
  assert.deepEqual(r.specs[0].tasks, ['01', '02']);
  assert.equal(r.specs[0].gateLog.length, 2, 'bulleted and bare gate lines both count');
  // H1 without "Spec NNNN" → id from the filename, title from the H1.
  assert.equal(r.specs[1].id, '0002');
  assert.equal(r.specs[1].title, 'Billing flow');
  assert.equal(r.specs[1].status, 'draft');
  // withoutDiagram: neither fixture spec carries a ```mermaid block (the /spec
  // format asks for one under `## Flow`; the launch check warns on the count).
  assert.deepEqual(r.counts, { total: 2, draft: 1, defined: 1, inProgress: 0, done: 0, withoutDiagram: 2 });

  assert.equal(readPlanSpecs(join(root, 'nope')).available, false);
});

test('inbox: unchecked items counted, missing file → available:false', () => {
  assert.deepEqual(countInbox('- [ ] a\n- [x] b\n* [ ] c\nplain line\n'), { open: 2, done: 1, total: 3 });
  assert.deepEqual(countInbox(''), { open: 0, done: 0, total: 0 });

  const root = mkdtempSync(join(tmpdir(), 'plan-in-'));
  const dir = seedAiDocs(root);
  const r = readPlanInbox(dir);
  assert.equal(r.available, true);
  assert.equal(r.open, 2);
  assert.equal(r.done, 1);
  assert.equal(readPlanInbox(join(root, 'nope')).available, false);
});

test('readPlanOverview: carries milestones/specs/inbox and indexes the new docs', () => {
  const root = mkdtempSync(join(tmpdir(), 'plan-ov-'));
  const dir = seedAiDocs(root);
  mkdirSync(join(dir, 'investigations'), { recursive: true });
  writeFileSync(join(dir, 'architecture.md'), '# Architecture\n');
  writeFileSync(join(dir, 'investigations/01-bug-login.md'), '# Investigation\n');
  const o = readPlanOverview(dir, root);
  // Milestone refs resolved against the task index parsed by readPlanTasks.
  assert.equal(o.milestones.available, true);
  assert.deepEqual(o.milestones.milestones[0].progress, { done: 1, total: 2 });
  assert.equal(o.milestones.milestones[1].tasks.find((t) => t.num === '03').status, 'in-progress');
  assert.equal(o.specs.counts.total, 2);
  assert.equal(o.inbox.open, 2);
  assert.equal(o.counts.specs, 2);
  assert.equal(o.counts.inboxOpen, 2);
  const paths = listPlanDocs(dir).map((f) => f.path);
  assert.ok(paths.includes('milestones.md'));
  assert.ok(paths.includes('inbox.md'));
  assert.ok(paths.includes('architecture.md'));
  assert.ok(paths.includes('investigations/01-bug-login.md'));
  assert.ok(paths.includes('specs/0001-task-crud.md'));
});

test('readPlanWorkflow: promotes not_started when the artifact is on disk', () => {
  const root = mkdtempSync(join(tmpdir(), 'plan-wf-'));
  const dir = join(root, 'ai-docs');
  mkdirSync(join(dir, 'todos'), { recursive: true });
  writeFileSync(join(dir, 'PRD.md'), '# PRD\n');
  writeFileSync(join(dir, 'screens-routes.md'), '# Screens\n');
  writeFileSync(join(dir, 'todos/task-master.md'), '# Tasks\n');
  writeFileSync(join(dir, 'map.yaml'), 'project: { name: Demo }\n');
  const map = {
    workflow_progress: {
      workflow_status: 'completed',
      steps: {
        step_1_verify_prd: { name: 'Verify PRD exists', status: 'not_started' },
        step_2_screens_routes: { name: 'Generate screens-routes.md', status: 'not_started' },
        step_3_task_master: { name: 'Generate task breakdown', status: 'not_started' },
        step_4_start_mapper: { name: 'Run start-mapper', status: 'in_progress' },
        step_5_component_architect: { name: 'Run component-architect', status: 'not_started' },
        step_6_ui_component_page: { name: 'Run ui-component-page', status: 'skipped' },
      },
    },
  };
  const wf = readPlanWorkflow(map, dir, { uiPageExists: false });
  assert.equal(wf.steps[0].status, 'completed');
  assert.equal(wf.steps[1].status, 'completed');
  assert.equal(wf.steps[2].status, 'completed');
  assert.equal(wf.steps[3].status, 'in_progress'); // declared in_progress is kept
  assert.equal(wf.steps[4].status, 'not_started'); // no registry yet
  assert.equal(wf.steps[5].status, 'skipped');
});
