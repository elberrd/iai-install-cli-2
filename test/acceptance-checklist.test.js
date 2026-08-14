import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseChecklistItems,
  checkAcceptanceChecklist,
  checklistItemKey,
  checklistDrift,
} from '../fia-templates/modules/gates.mjs';
import { resolveBriefPath, runChecklistGate } from '../fia-templates/modules/checklist.mjs';

const BRIEF = `# Task 01: Scaffold

Kind: foundation

## Objectives

- [ ] App boots locally
- [x] Registry seeded

## Assumptions & Blocking Questions

1. Inputs fit in memory.

## Seams & First Tests

\`\`\`typescript
// a quoted skeleton must never count as a checklist item:
// - [ ] not a real box
\`\`\`

## Acceptance Criteria

- [x] No secret committed
- [ ] Suite green (npm run test)

## Quality Checklist

* [X] Types defined (no any)
`;

// ── parseChecklistItems ──────────────────────────────────────────────────────

test('parseChecklistItems: finds boxes with their section, skipping fenced code', () => {
  const items = parseChecklistItems(BRIEF);
  assert.deepEqual(
    items.map((i) => [i.section, i.checked, i.text]),
    [
      ['Objectives', false, 'App boots locally'],
      ['Objectives', true, 'Registry seeded'],
      ['Acceptance Criteria', true, 'No secret committed'],
      ['Acceptance Criteria', false, 'Suite green (npm run test)'],
      ['Quality Checklist', true, 'Types defined (no any)'],
    ],
  );
});

test('parseChecklistItems: text without boxes → empty', () => {
  assert.deepEqual(parseChecklistItems('# Title\n\n- a plain bullet\n1. numbered'), []);
  assert.deepEqual(parseChecklistItems(''), []);
});

test('parseChecklistItems: a CRLF brief parses the same as LF', () => {
  const crlf = BRIEF.replaceAll('\n', '\r\n');
  assert.deepEqual(parseChecklistItems(crlf), parseChecklistItems(BRIEF));
  assert.equal(parseChecklistItems(crlf).length, 5);
});

test('parseChecklistItems: + bullets and ordered lists are GFM task items too', () => {
  const items = parseChecklistItems('## S\n\n+ [ ] plus bullet\n1. [x] ordered dot\n2) [ ] ordered paren');
  assert.deepEqual(
    items.map((i) => [i.checked, i.text]),
    [
      [false, 'plus bullet'],
      [true, 'ordered dot'],
      [false, 'ordered paren'],
    ],
  );
});

test('parseChecklistItems: a ``` line inside a ~~~ fence neither opens nor closes', () => {
  const text = ['~~~', '- [ ] fenced away', '```', '- [ ] still fenced', '~~~', '- [ ] real box'].join('\n');
  assert.deepEqual(
    parseChecklistItems(text).map((i) => i.text),
    ['real box'],
  );
});

// ── checkAcceptanceChecklist ─────────────────────────────────────────────────

function briefFile(content) {
  const dir = mkdtempSync(join(tmpdir(), 'checklist-'));
  const path = join(dir, '01-task.md');
  writeFileSync(path, content);
  return path;
}

test('checkAcceptanceChecklist: unchecked boxes → violations naming section and item', () => {
  const report = checkAcceptanceChecklist(briefFile(BRIEF));
  assert.equal(report.passed, false);
  assert.equal(report.violations.length, 2);
  assert.match(report.violations[0], /Objectives › App boots locally/);
  assert.match(report.violations[1], /Acceptance Criteria › Suite green/);
});

test('checkAcceptanceChecklist: every box ticked → passes', () => {
  const report = checkAcceptanceChecklist(briefFile(BRIEF.replaceAll('- [ ]', '- [x]')));
  assert.equal(report.passed, true);
});

test('checkAcceptanceChecklist: no boxes or unreadable path → null (gate skips)', () => {
  assert.equal(checkAcceptanceChecklist(briefFile('# Bug report\n\nIt crashes on save.')), null);
  assert.equal(checkAcceptanceChecklist(join(tmpdir(), 'does-not-exist.md')), null);
});

// ── resolveBriefPath ─────────────────────────────────────────────────────────

function fakeSession() {
  const sessionDir = mkdtempSync(join(tmpdir(), 'session-'));
  return { sessionDir };
}

test('resolveBriefPath: file argument → absolute path, persisted for --resume', () => {
  const run = fakeSession();
  const brief = briefFile(BRIEF);
  assert.equal(resolveBriefPath(run, brief), brief);
  // resume: prompt argument omitted → the marker answers
  assert.equal(resolveBriefPath(run, ''), brief);
});

test('resolveBriefPath: inline prompt → null, and resume without a marker → null', () => {
  const run = fakeSession();
  assert.equal(resolveBriefPath(run, 'Fix the login bug'), null);
  assert.equal(resolveBriefPath(run, ''), null);
});

test('resolveBriefPath: --resume passes the brief CONTENT, the marker still answers', () => {
  // runFda reloads the saved request on --resume — the brief's inlined text,
  // not its path. The marker written on the first run must keep the gate armed.
  const run = fakeSession();
  const brief = briefFile(BRIEF);
  assert.equal(resolveBriefPath(run, brief), brief);
  assert.equal(resolveBriefPath(run, BRIEF), brief);
});

// ── runChecklistGate ─────────────────────────────────────────────────────────

/**
 * A minimal Run double: executes phases inline, records their names, and lets
 * the test script what the "builder" does in the fix_checklist round.
 */
function fakeRun({ onBuilderCall }) {
  const phases = [];
  return {
    repoRoot: tmpdir(),
    phases,
    runPhase: async (params, fn) => {
      phases.push(params.name);
      return fn({
        log: () => {},
        call: async (call) => onBuilderCall(call),
      });
    },
  };
}

test('runChecklistGate: fully ticked brief → single check phase, no builder round', async () => {
  const brief = briefFile(BRIEF.replaceAll('- [ ]', '- [x]'));
  const run = fakeRun({ onBuilderCall: () => assert.fail('builder must not be called') });
  assert.equal(await runChecklistGate(run, brief), null);
  assert.deepEqual(run.phases, ['checklist_1']);
});

test('runChecklistGate: no brief file → skip', async () => {
  const run = fakeRun({ onBuilderCall: () => assert.fail('builder must not be called') });
  assert.equal(await runChecklistGate(run, null), null);
  assert.deepEqual(run.phases, ['checklist_1']);
});

test('runChecklistGate: unchecked boxes → builder reconciles → gate passes', async () => {
  const brief = briefFile(BRIEF);
  const envelope = { status: 'success', changed_files: [brief], artifacts: [brief] };
  const run = fakeRun({
    onBuilderCall: (call) => {
      assert.match(call.prompt, /App boots locally/); // the round names the open items
      writeFileSync(brief, readFileSync(brief, 'utf8').replaceAll('- [ ]', '- [x]'));
      return envelope;
    },
  });
  assert.equal(await runChecklistGate(run, brief), envelope);
  assert.deepEqual(run.phases, ['checklist_1', 'fix_checklist', 'checklist_2']);
});

test('runChecklistGate: builder leaves boxes unchecked → the close is refused', async () => {
  const brief = briefFile(BRIEF);
  const run = fakeRun({
    onBuilderCall: () => ({ status: 'success', changed_files: [], artifacts: [brief] }),
  });
  await assert.rejects(() => runChecklistGate(run, brief), /acceptance checklist incomplete/);
  assert.deepEqual(run.phases, ['checklist_1', 'fix_checklist', 'checklist_2']);
});

test('runChecklistGate: builder deletes the checklist → refused (a removed box is not a tick)', async () => {
  const brief = briefFile(BRIEF);
  const run = fakeRun({
    onBuilderCall: () => {
      writeFileSync(brief, '# Task 01: Scaffold\n\nAll done, trust me.\n');
      return { status: 'success', changed_files: [brief], artifacts: [brief] };
    },
  });
  await assert.rejects(() => runChecklistGate(run, brief), /disappeared during reconciliation/);
});

test('runChecklistGate: builder fences the checklist away → refused', async () => {
  const brief = briefFile(BRIEF);
  const run = fakeRun({
    onBuilderCall: () => {
      writeFileSync(brief, '```\n' + readFileSync(brief, 'utf8') + '\n```\n');
      return { status: 'success', changed_files: [brief], artifacts: [brief] };
    },
  });
  await assert.rejects(() => runChecklistGate(run, brief), /disappeared during reconciliation/);
});

test('runChecklistGate: builder deletes only the unchecked items → refused (shrank)', async () => {
  const brief = briefFile(BRIEF);
  const run = fakeRun({
    onBuilderCall: () => {
      const ticked = readFileSync(brief, 'utf8')
        .split('\n')
        .filter((l) => !/\[ \]/.test(l))
        .join('\n');
      writeFileSync(brief, ticked);
      return { status: 'success', changed_files: [brief], artifacts: [brief] };
    },
  });
  await assert.rejects(() => runChecklistGate(run, brief), /shrank from 5 to 3 items/);
});

// ── checklistItemKey / checklistDrift ────────────────────────────────────────

test('checklistItemKey: tick and N/A annotation do not change identity, rewording does', () => {
  const plain = { section: 'AC', checked: false, text: 'Suite green (npm run test)' };
  const done = { section: 'AC', checked: true, text: 'Suite green (npm run test) — N/A (no runtime code changed)' };
  assert.equal(checklistItemKey(plain), checklistItemKey(done));
  assert.notEqual(checklistItemKey(plain), checklistItemKey({ ...plain, text: 'Suite green' }));
  assert.notEqual(checklistItemKey(plain), checklistItemKey({ ...plain, section: 'Other' }));
});

test('checklistDrift: ticking and annotating is not drift; a swapped box is', () => {
  const before = parseChecklistItems(BRIEF);
  const ticked = parseChecklistItems(BRIEF.replaceAll('- [ ]', '- [x]'));
  assert.deepEqual(checklistDrift(before, ticked), []);

  const swapped = parseChecklistItems(
    BRIEF.replace('- [ ] Suite green (npm run test)', '- [x] Something trivial instead'),
  );
  assert.deepEqual(checklistDrift(before, swapped), ['Acceptance Criteria › Suite green (npm run test)']);
});

test('checklistDrift: duplicate boxes need one survivor each (multiset)', () => {
  const two = [
    { section: 'S', checked: false, text: 'Do it' },
    { section: 'S', checked: false, text: 'Do it' },
  ];
  assert.deepEqual(checklistDrift(two, two.slice(0, 1)), ['S › Do it']);
  assert.deepEqual(checklistDrift(two, two), []);
});

// ── the N/A-with-reason rule ─────────────────────────────────────────────────

test('checkAcceptanceChecklist: a bare N/A tick fails, a reasoned one passes', () => {
  const bare = checkAcceptanceChecklist(briefFile('## AC\n\n- [x] Load test — N/A\n'));
  assert.equal(bare.passed, false);
  assert.match(bare.violations[0], /N\/A without a reason/);

  const reasoned = checkAcceptanceChecklist(
    briefFile('## AC\n\n- [x] Load test — N/A (no perf-sensitive path in this task)\n'),
  );
  assert.equal(reasoned.passed, true);

  // A decorated but honest annotation (models love bolding) also passes.
  const bold = checkAcceptanceChecklist(briefFile('## AC\n\n- [x] Load test — **N/A** (no perf path)\n'));
  assert.equal(bold.passed, true);

  // N/A as CONTENT is never flagged: no dash, a hyphenated word (`non-N/A`),
  // or an N/A mid-sentence — only the trailing `— N/A` annotation is a claim.
  for (const text of [
    '- [x] Show N/A for missing values',
    '- [x] Table renders non-N/A rows only',
    '- [x] Status shows Active/Inactive - N/A for deleted rows appears last',
  ]) {
    const content = checkAcceptanceChecklist(briefFile(`## AC\n\n${text}\n`));
    assert.equal(content.passed, true, text);
  }
});

test('checklistItemKey: only the trailing annotation is stripped — prefix-sharing boxes stay distinct', () => {
  // An unanchored strip would collapse both to "Empty cells render non" and
  // hand the builder a free swap.
  const a = { section: 'AC', checked: true, text: 'Empty cells render non-N/A placeholders' };
  const b = { section: 'AC', checked: true, text: 'Empty cells render non-N/A tooltips' };
  assert.notEqual(checklistItemKey(a), checklistItemKey(b));
  assert.deepEqual(checklistDrift([a, b], [a, b]), []);

  // Decorated annotation still reads as the same box (no false drift).
  const plain = { section: 'AC', checked: false, text: 'Load test done' };
  const decorated = { section: 'AC', checked: true, text: 'Load test done — **N/A** (no perf path)' };
  assert.equal(checklistItemKey(plain), checklistItemKey(decorated));
});

test('runChecklistGate: builder swaps a hard box for a trivial ticked one → refused', async () => {
  const brief = briefFile(BRIEF);
  const run = fakeRun({
    onBuilderCall: () => {
      const swapped = readFileSync(brief, 'utf8')
        .replace('- [ ] Suite green (npm run test)', '- [x] Trivial replacement')
        .replaceAll('- [ ]', '- [x]');
      writeFileSync(brief, swapped);
      return { status: 'success', changed_files: [brief], artifacts: [brief] };
    },
  });
  // Same COUNT as before (5 boxes), so only the identity check can catch it.
  await assert.rejects(() => runChecklistGate(run, brief), /rewritten or replaced/);
  assert.deepEqual(run.phases, ['checklist_1', 'fix_checklist', 'checklist_2']);
});
