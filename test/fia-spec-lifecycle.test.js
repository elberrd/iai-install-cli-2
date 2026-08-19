import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { briefIssueNumber, reconcileSpecDelivery } from '../fia-templates/modules/spec-lifecycle.mjs';

function fixture({ specStatus = 'in-progress', tasks = '01, 02', issue01 = 'done', issue02 = 'in-progress' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fia-spec-close-'));
  const specs = join(root, 'ai-docs', 'specs');
  const issues = join(root, 'ai-docs', 'todos', 'issues');
  mkdirSync(specs, { recursive: true });
  mkdirSync(issues, { recursive: true });
  writeFileSync(
    join(specs, '0007-checkout.md'),
    [
      '# Spec 0007 — Checkout',
      '',
      `Status: ${specStatus}`,
      'Created: 2026-08-01 · Updated: 2026-08-10',
      `Tasks: ${tasks}`,
      '',
      '## Gate log',
      '',
      '- Definition Gate: passed — 2026-08-01',
      '',
      '## Decisions',
      '',
      '- 2026-08-01 — Keep checkout lean.',
      '',
    ].join('\n'),
  );
  writeFileSync(join(issues, '01-cart.md'), `# Task 01\n\n**Status:** ${issue01}\n`);
  writeFileSync(join(issues, '02-payment.md'), `# Task 02\n\nStatus: ${issue02}\n`);
  return root;
}

function prompt(issue = '02-payment.md') {
  return [
    '# Task 02: Payment',
    '',
    `> Issue: \`ai-docs/todos/issues/${issue}\``,
    '',
    'Spec: 0007 (S-2, FR-2)',
    '',
    '## Acceptance Criteria',
    '- [x] Payment works',
    '',
  ].join('\n');
}

test('briefIssueNumber: reads the canonical Issue link and falls back to the brief filename', () => {
  assert.equal(briefIssueNumber(prompt(), null), '02');
  assert.equal(briefIssueNumber('no issue link', '/tmp/09-an-ad-hoc-brief.md'), '09');
  assert.equal(briefIssueNumber('no issue link', '/tmp/free-form.md'), null);
});

test('reconcileSpecDelivery: the successful current task closes the final linked spec deterministically', () => {
  const root = fixture();
  const result = reconcileSpecDelivery({
    repoRoot: root,
    prompt: prompt(),
    fdaId: 'abc12345',
    date: '2026-08-18',
  });
  assert.equal(result.status, 'closed');
  assert.equal(result.spec, '0007');
  assert.deepEqual(result.tasks, ['01', '02']);
  assert.deepEqual(result.changed_files, ['ai-docs/specs/0007-checkout.md']);

  const spec = readFileSync(join(root, result.changed_files[0]), 'utf8');
  assert.match(spec, /^Status: done$/m);
  assert.match(spec, /Created: 2026-08-01 · Updated: 2026-08-18/);
  assert.match(spec, /Delivery Gate: passed — 2026-08-18 — FDA abc12345: suite green, coverage check ok/);
  assert.match(spec, /## Decisions\n\n- 2026-08-01/, 'the following section is preserved');
});

test('reconcileSpecDelivery: another unfinished linked task keeps the spec open with a traceable reason', () => {
  const root = fixture({ issue01: 'pending' });
  const before = readFileSync(join(root, 'ai-docs/specs/0007-checkout.md'), 'utf8');
  const result = reconcileSpecDelivery({ repoRoot: root, prompt: prompt(), date: '2026-08-18' });
  assert.equal(result.status, 'pending');
  assert.deepEqual(result.pending, ['01']);
  assert.match(result.reason, /tasks not done: 01/);
  assert.equal(readFileSync(join(root, 'ai-docs/specs/0007-checkout.md'), 'utf8'), before);
});

test('reconcileSpecDelivery: missing task metadata fails closed instead of guessing completion', () => {
  const root = fixture({ tasks: '02, 03' });
  const result = reconcileSpecDelivery({ repoRoot: root, prompt: prompt(), date: '2026-08-18' });
  assert.equal(result.status, 'pending');
  assert.deepEqual(result.unknown, ['03']);
  assert.match(result.reason, /task files not found: 03/);

  const noTasks = fixture({ tasks: '—' });
  const noTasksResult = reconcileSpecDelivery({ repoRoot: noTasks, prompt: prompt(), date: '2026-08-18' });
  assert.equal(noTasksResult.status, 'pending');
  assert.match(noTasksResult.reason, /no linked Tasks/);
});

test('reconcileSpecDelivery: a missing or unlisted current issue fails closed', () => {
  const root = fixture();
  const noIssue = reconcileSpecDelivery({
    repoRoot: root,
    prompt: 'Spec: 0007 (S-2)\n',
    date: '2026-08-18',
  });
  assert.equal(noIssue.status, 'pending');
  assert.match(noIssue.reason, /cannot be identified/);

  const unlisted = reconcileSpecDelivery({
    repoRoot: root,
    prompt: prompt('03-unlisted.md'),
    date: '2026-08-18',
  });
  assert.equal(unlisted.status, 'pending');
  assert.match(unlisted.reason, /current task 03 is not listed/);
});

test('reconcileSpecDelivery: repeated close-out is idempotent and never duplicates Delivery Gate evidence', () => {
  const root = fixture();
  const args = { repoRoot: root, prompt: prompt(), fdaId: 'abc12345', date: '2026-08-18' };
  assert.equal(reconcileSpecDelivery(args).status, 'closed');
  assert.equal(reconcileSpecDelivery(args).status, 'already-done');
  const spec = readFileSync(join(root, 'ai-docs/specs/0007-checkout.md'), 'utf8');
  assert.equal((spec.match(/Delivery Gate: passed/g) || []).length, 1);
});

test('reconcileSpecDelivery: free-form work without a Spec line is a quiet no-op', () => {
  const root = fixture();
  const result = reconcileSpecDelivery({ repoRoot: root, prompt: 'Fix the typo.' });
  assert.deepEqual(result, {
    status: 'skipped',
    reason: 'the brief has no Spec: line',
    changed_files: [],
  });
});

test('tested task FDAs wire spec_close before commit and include its changed spec', () => {
  for (const name of ['fda_build_test.mjs', 'fda_plan_build_test.mjs', 'fda_sdlc.mjs', 'fda_bug.mjs']) {
    const source = readFileSync(join(import.meta.dirname, '..', 'fia-templates', name), 'utf8');
    assert.match(source, /await runSpecDeliveryClose\(run, prompt, briefPath\)/, `${name} must run deterministic spec close-out`);
    assert.match(source, /\.\.\.\(specClose\.changed_files \|\| \[\]\)/, `${name} must commit the changed spec`);
    assert.ok(
      source.indexOf('runSpecDeliveryClose(run, prompt, briefPath)') < source.indexOf('specClose.changed_files'),
      `${name} must close before constructing its commit paths`,
    );
  }
});
