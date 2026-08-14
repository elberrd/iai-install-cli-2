import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  oneLine,
  parseFrontmatter,
  nextSequence,
  nextEntryNumber,
  openLog,
  logEntry,
  noteEntry,
  closeLog,
  readLogs,
  resolveLog,
  DECISIONS_DIR,
} from '../fia-templates/scripts/decision-log.mjs';

const SCRIPT = join(import.meta.dirname, '..', 'fia-templates', 'scripts', 'decision-log.mjs');
const NOW = { IAI_DECISION_LOG_NOW: '2026-08-13T10:23:00' };

function cli(root, args, env = {}) {
  return execFileSync(process.execPath, [SCRIPT, ...args, '--dir', root], {
    encoding: 'utf8',
    env: { ...process.env, ...NOW, ...env },
  }).trim();
}

function freshRoot() {
  return mkdtempSync(join(tmpdir(), 'decision-log-'));
}

// ── pure helpers ─────────────────────────────────────────────────────────────

test('oneLine: collapses newlines and trims', () => {
  assert.equal(oneLine('  a\n b\tc  '), 'a b c');
  assert.equal(oneLine(null), '');
});

test('parseFrontmatter: fields and absence', () => {
  const fm = parseFrontmatter('---\ncommand: idea\nstatus: open\n---\nbody');
  assert.equal(fm.fields.command, 'idea');
  assert.equal(fm.fields.status, 'open');
  assert.equal(parseFrontmatter('no frontmatter'), null);
});

test('nextSequence: continues from the max, never reuses gaps', () => {
  assert.equal(nextSequence([]), '001');
  assert.equal(nextSequence(['001-idea-x.md', '007-grill-y.md', 'README.md']), '008');
});

test('nextEntryNumber: counts ### entries', () => {
  assert.equal(nextEntryNumber('## Decisions\n'), 1);
  assert.equal(nextEntryNumber('### 1. a\n- Answer: x\n\n### 2. b\n'), 3);
});

test('nextEntryNumber: a pasted ### heading inside an answer never inflates the sequence', () => {
  assert.equal(nextEntryNumber('### 1. a\n- Answer: text with\n### a markdown heading\npasted in\n'), 2);
  // Max+1, not count+1 — a hand-deleted entry cannot cause a duplicate number.
  assert.equal(nextEntryNumber('### 1. a\n\n### 4. d\n'), 5);
});

// ── lifecycle (direct function calls) ────────────────────────────────────────

test('openLog → logEntry → closeLog writes the full versioned record', () => {
  process.env.IAI_DECISION_LOG_NOW = NOW.IAI_DECISION_LOG_NOW;
  const root = freshRoot();
  const rel = openLog(root, 'idea', 'CRM for dental clinics');
  assert.equal(rel, join(DECISIONS_DIR, '001-idea-2026-08-13.md'));

  const file = join(root, rel);
  const n1 = logEntry(file, {
    question: 'Which situations create contact opportunities in v1?',
    recommendation: 'three queues: missed, preventive overdue, pending budget',
    answer: 'yes',
  });
  const n2 = logEntry(file, { question: 'Who uses the CRM?', answer: 'admin + attendant' });
  assert.equal(n1, 1);
  assert.equal(n2, 2);

  closeLog(file, { outcome: 'PRD written', artifacts: ['ai-docs/PRD.md', 'ai-docs/stack.md'] });
  const content = readFileSync(file, 'utf8');
  assert.match(content, /^command: idea$/m);
  assert.match(content, /^status: closed$/m);
  assert.match(content, /^closed: 2026-08-13 10:23$/m);
  assert.match(content, /^artifacts: ai-docs\/PRD\.md, ai-docs\/stack\.md$/m);
  assert.match(content, /### 1\. Which situations create contact opportunities in v1\?/);
  assert.match(content, /- Recommendation: three queues/);
  assert.match(content, /### 2\. Who uses the CRM\?/);
  assert.match(content, /## Outcome\n- Result: PRD written\n- Artifacts: ai-docs\/PRD\.md, ai-docs\/stack\.md/);
  // The entry without --rec has no Recommendation line.
  assert.doesNotMatch(content.split('### 2.')[1], /Recommendation:/);

  assert.throws(() => closeLog(file, {}), /already closed/);
  delete process.env.IAI_DECISION_LOG_NOW;
});

test('openLog supersedes a previous open log of the SAME command only', () => {
  process.env.IAI_DECISION_LOG_NOW = NOW.IAI_DECISION_LOG_NOW;
  const root = freshRoot();
  openLog(root, 'idea', 'first try');
  openLog(root, 'grill', 'other command');
  openLog(root, 'idea', 'second try');
  const logs = readLogs(root);
  assert.deepEqual(
    logs.map((l) => [l.seq, l.command, l.status]),
    [
      [1, 'idea', 'superseded'],
      [2, 'grill', 'open'],
      [3, 'idea', 'open'],
    ],
  );
  delete process.env.IAI_DECISION_LOG_NOW;
});

test('noteEntry appends a timestamped free-form note', () => {
  process.env.IAI_DECISION_LOG_NOW = NOW.IAI_DECISION_LOG_NOW;
  const root = freshRoot();
  const file = join(root, openLog(root, 'spec', null));
  noteEntry(file, 'auth stays out of scope');
  assert.match(readFileSync(file, 'utf8'), /- Note \(2026-08-13 10:23\): auth stays out of scope/);
  delete process.env.IAI_DECISION_LOG_NOW;
});

test('readLogs skips README and malformed files; resolveLog accepts id and path', () => {
  process.env.IAI_DECISION_LOG_NOW = NOW.IAI_DECISION_LOG_NOW;
  const root = freshRoot();
  const rel = openLog(root, 'theme', 'blue');
  mkdirSync(join(root, DECISIONS_DIR), { recursive: true });
  writeFileSync(join(root, DECISIONS_DIR, 'README.md'), '# about this folder');
  writeFileSync(join(root, DECISIONS_DIR, '099-broken.md'), 'no frontmatter at all');
  assert.equal(readLogs(root).length, 1);
  assert.equal(resolveLog(root, '1'), join(root, rel));
  assert.equal(resolveLog(root, '001'), join(root, rel));
  assert.equal(resolveLog(root, rel), join(root, rel));
  assert.equal(resolveLog(root, '42'), null);
  delete process.env.IAI_DECISION_LOG_NOW;
});

// ── CLI ──────────────────────────────────────────────────────────────────────

test('CLI: open → log → close → latest/list round-trip', () => {
  const root = freshRoot();
  const rel = cli(root, ['open', 'idea', '--topic', 'CRM for clinics']);
  assert.equal(rel, join(DECISIONS_DIR, '001-idea-2026-08-13.md'));

  assert.equal(cli(root, ['log', '1', '--q', 'Scope of v1?', '--rec', 'three queues', '--a', 'yes']), 'logged #1');
  assert.equal(cli(root, ['close', '1', '--outcome', 'PRD written', '--artifact', 'ai-docs/PRD.md']), 'closed');

  const latest = JSON.parse(cli(root, ['latest', 'idea', '--json']));
  assert.equal(latest.status, 'closed');
  assert.equal(latest.topic, 'CRM for clinics');
  assert.equal(latest.artifacts, 'ai-docs/PRD.md');

  const all = JSON.parse(cli(root, ['list', '--json']));
  assert.equal(all.length, 1);
  assert.equal(all[0].command, 'idea');
});

test('CLI: unknown ref and empty latest fail with exit 1', () => {
  const root = freshRoot();
  assert.throws(() => cli(root, ['log', '9', '--q', 'x', '--a', 'y']), /decision log not found/);
  assert.throws(() => cli(root, ['latest']), /no decision logs/);
  // --json latest stays scripting-friendly: null, exit 0.
  assert.equal(cli(root, ['latest', '--json']), 'null');
});

test('CLI: open refuses a slashed or spaced command name with a clean error', () => {
  const root = freshRoot();
  for (const bad of ['/idea', 'my command', 'Idea']) {
    try {
      cli(root, ['open', bad, '--topic', 't']);
      assert.fail(`open "${bad}" should exit 1`);
    } catch (err) {
      assert.match(String(err.stderr), /invalid command name/);
      assert.ok(!String(err.stderr).includes('at '), 'clean message, not a stack trace');
    }
  }
});
