import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nextQuickId, quickLogEntry, appendQuickLog, setQuickLogCommit } from '../fia-templates/modules/quicklog.mjs';
import { focalSpec } from '../fia-templates/modules/quality.mjs';

// ── quick-log helpers (C6 audit trail) ───────────────────────────────────────

test('nextQuickId: starts at Q-001 and continues from the highest entry', () => {
  assert.equal(nextQuickId(''), 'Q-001');
  assert.equal(nextQuickId(null), 'Q-001');
  assert.equal(nextQuickId('## Q-002 — a (2026-08-01)\n## Q-012 — b (2026-08-10)\n'), 'Q-013');
});

test('nextQuickId: only line-start entry headings count', () => {
  assert.equal(nextQuickId('see Q-099 in the notes\n## Q-003 — real (2026-08-01)\n'), 'Q-004');
});

test('quickLogEntry: renders the exact C6 two-line format', () => {
  const entry = quickLogEntry({
    id: 'Q-012',
    title: 'Fix header overflow on mobile',
    date: '2026-08-12',
    files: ['app/page.tsx', 'app/globals.css'],
    verified: ['lint', 'typecheck'],
    commit: 'abc1234',
  });
  assert.equal(
    entry,
    '## Q-012 — Fix header overflow on mobile (2026-08-12)\nFiles: app/page.tsx, app/globals.css · Verified: lint/typecheck · Commit: abc1234\n',
  );
});

test('quickLogEntry: unknowns render as — (commit happens after the append)', () => {
  const entry = quickLogEntry({ id: 'Q-001', title: 't', date: '2026-08-12' });
  assert.match(entry, /Files: — · Verified: — · Commit: —/);
});

test('appendQuickLog: creates the file (and folder) with a header on first use', () => {
  const root = mkdtempSync(join(tmpdir(), 'quicklog-'));
  const path = join(root, 'ai-docs', 'todos', 'quick-log.md');
  const id = appendQuickLog(path, { title: 'First change', date: '2026-08-12', files: ['a.ts'], verified: ['lint'] });
  assert.equal(id, 'Q-001');
  assert.equal(existsSync(path), true);
  const text = readFileSync(path, 'utf8');
  assert.match(text, /^# Quick log/);
  assert.match(text, /## Q-001 — First change \(2026-08-12\)/);
});

test('appendQuickLog: appends and renumbers, preserving previous entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'quicklog-'));
  const path = join(root, 'quick-log.md');
  appendQuickLog(path, { title: 'First', date: '2026-08-12' });
  const id2 = appendQuickLog(path, { title: 'Second', date: '2026-08-12', files: ['b.ts'], verified: ['lint', 'focal'] });
  assert.equal(id2, 'Q-002');
  const text = readFileSync(path, 'utf8');
  assert.ok(text.indexOf('## Q-001 — First') < text.indexOf('## Q-002 — Second'), 'append-only order');
  assert.match(text, /Files: b\.ts · Verified: lint\/focal · Commit: —/);
});

test('setQuickLogCommit: fills only its own entry, once', () => {
  const root = mkdtempSync(join(tmpdir(), 'quicklog-'));
  const path = join(root, 'quick-log.md');
  const id1 = appendQuickLog(path, { title: 'First', date: '2026-08-12', files: ['a.ts'], verified: ['lint'] });
  const id2 = appendQuickLog(path, { title: 'Second', date: '2026-08-12', files: ['b.ts'], verified: ['lint'] });

  assert.equal(setQuickLogCommit(path, id2, 'abc1234def'), true);
  const text = readFileSync(path, 'utf8');
  assert.match(text, /## Q-002 — Second[\s\S]*Commit: abc1234def/);
  assert.match(text, /## Q-001 — First[\s\S]*?Commit: —/, 'the earlier entry is untouched');

  assert.equal(setQuickLogCommit(path, id2, 'other'), false, 'an already-filled field is never rewritten');
  assert.equal(setQuickLogCommit(path, 'Q-099', 'abc'), false, 'unknown entry → no-op');
  assert.equal(setQuickLogCommit(join(root, 'nope.md'), id1, 'abc'), false, 'missing file → no-op');
});

// ── focal spec (quality.mjs support for red_check and /quick) ────────────────

test('focalSpec: hands the file list to the project test script verbatim', () => {
  const spec = focalSpec(['src/vat.test.ts', 'src/cart.test.ts']);
  assert.equal(spec.name, 'focal');
  assert.deepEqual(spec.argv, ['npm', 'run', 'test', '--', 'src/vat.test.ts', 'src/cart.test.ts']);
  assert.ok(spec.timeoutSeconds > 0);
});
