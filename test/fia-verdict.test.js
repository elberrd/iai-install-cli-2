// Bounded continuation: a verdict recorded after a run closes narrows the next
// --resume to the work that is actually missing, instead of "run it again".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import {
  RUN_VERDICT_FILE,
  buildScopeBlock,
  clearRunVerdict,
  readRunVerdict,
  writeRunVerdict,
} from '../fia-templates/modules/continuation.mjs';
import { dataDirOf, main, outcomeOf, renderVerdict, savedPhases } from '../fia-templates/scripts/verdict.mjs';

const SCRIPT = join(import.meta.dirname, '..', 'fia-templates', 'scripts', 'verdict.mjs');

function project(fdaId = 'r_test1', { withSession = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fia-verdict-'));
  mkdirSync(join(root, 'imp', 'data'), { recursive: true });
  if (withSession) mkdirSync(join(root, 'imp', 'data', 'sessions', fdaId, 'phase_results'), { recursive: true });
  return root;
}

const sessionDirOf = (root, fdaId = 'r_test1') => join(root, 'imp', 'data', 'sessions', fdaId);

function cli(args, root) {
  return spawnSync(process.execPath, [SCRIPT, ...args, '--dir', root], { encoding: 'utf8' });
}

// ── the store ────────────────────────────────────────────────────────────────

test('verdict store: round-trips, normalizes and is consumed by clear', () => {
  const root = project();
  const dir = sessionDirOf(root);
  assert.equal(readRunVerdict(dir), null, 'no verdict is not an error');

  const stored = writeRunVerdict(dir, {
    fda_id: 'r_test1',
    outcome: 'verification_failed',
    missing: ['  the empty state is not handled  ', '', 'no test covers the 403 path'],
    redo: ['review', 'review', ' build '],
    note: 'the reviewer accepted everything else',
  });
  assert.deepEqual(stored.missing, ['the empty state is not handled', 'no test covers the 403 path'], 'trimmed, blanks dropped');
  assert.deepEqual(stored.redo, ['review', 'build'], 'de-duplicated and trimmed');
  assert.equal(existsSync(join(dir, RUN_VERDICT_FILE)), true);

  const read = readRunVerdict(dir);
  assert.deepEqual(read.missing, stored.missing);
  assert.equal(read.outcome, 'verification_failed');

  clearRunVerdict(dir);
  assert.equal(readRunVerdict(dir), null, 'cleared');
  clearRunVerdict(dir); // idempotent — a second clear is not an error
});

test('verdict store: a malformed file reads as no verdict, never as a throw', () => {
  const root = project();
  const dir = sessionDirOf(root);
  writeFileSync(join(dir, RUN_VERDICT_FILE), '{ not json');
  assert.equal(readRunVerdict(dir), null);
  writeFileSync(join(dir, RUN_VERDICT_FILE), JSON.stringify({ fda_id: 'x' }));
  assert.equal(readRunVerdict(dir), null, 'missing arrays → not a verdict');
});

test('verdict store: the missing list is capped, so a verdict stays a scope', () => {
  const root = project();
  const many = Array.from({ length: 40 }, (_, i) => `item ${i}`);
  const stored = writeRunVerdict(sessionDirOf(root), { fda_id: 'r_test1', missing: many });
  assert.equal(stored.missing.length, 20);
});

// ── the scope block handed to the agents ─────────────────────────────────────

test('scope block: empty without a verdict, and states the three rules with one', () => {
  assert.equal(buildScopeBlock(null), '');
  assert.equal(buildScopeBlock({ missing: [] }), '', 'a verdict with no missing work narrows nothing');

  const block = buildScopeBlock({
    outcome: 'attempt_cap',
    missing: ['the empty state is not handled'],
    note: 'everything else was accepted',
  });
  assert.match(block, /Bounded continuation/);
  assert.match(block, /attempt_cap/);
  assert.match(block, /1\. the empty state is not handled/);
  assert.match(block, /everything else was accepted/);
  assert.match(block, /Do ONLY the work listed above/);
  assert.match(block, /the workspace is the only authority/);
  assert.match(block, /Do not manufacture a change/);
  assert.ok(block.endsWith('---\n\n\n'), 'ends with the separator the user prompt is appended to');
  // The block must not swallow its own blank lines — an unreadable wall of text
  // is exactly what an agent skims past.
  assert.ok(block.includes('\n\n'), 'keeps its paragraph breaks');
});

// ── the CLI ──────────────────────────────────────────────────────────────────

test('CLI: set → show → clear, with --json staying pure JSON', () => {
  const root = project();
  const set = cli(['set', 'r_test1', '--missing', 'the 403 path has no test', '--redo', 'review', '--json'], root);
  assert.equal(set.status, 0);
  const stored = JSON.parse(set.stdout);
  assert.deepEqual(stored.missing, ['the 403 path has no test']);
  assert.deepEqual(stored.redo, ['review']);

  const show = cli(['show', 'r_test1', '--json'], root);
  assert.equal(show.status, 0);
  assert.equal(JSON.parse(show.stdout).fda_id, 'r_test1');

  const human = cli(['show', 'r_test1'], root);
  assert.match(human.stdout, /Verdict for run r_test1/);
  assert.match(human.stdout, /Phases to re-run: review/);
  assert.match(human.stdout, /--resume/);

  assert.equal(cli(['clear', 'r_test1'], root).status, 0);
  assert.match(cli(['show', 'r_test1'], root).stdout, /No verdict recorded/);
});

test('CLI: set refuses without --missing, refuses an unknown session and rejects a bad id', () => {
  const root = project();
  const noScope = cli(['set', 'r_test1'], root);
  assert.equal(noScope.status, 1);
  assert.match(noScope.stderr, /at least one --missing/);

  const unknown = cli(['set', 'r_nope', '--missing', 'x'], root);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /No session on disk/);
  assert.match(unknown.stderr, /fda:sessions/);

  const bad = cli(['set', '../escape', '--missing', 'x'], root);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Invalid run id/);

  const usage = cli(['nonsense', 'r_test1'], root);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /Usage:/);
});

test('CLI: a run still holding the FDA lock cannot be judged yet', () => {
  const root = project();
  writeFileSync(
    join(root, 'imp', 'data', '.fda.lock'),
    JSON.stringify({ pid: process.pid, fda_id: 'r_test1', runner: 'fda_sdlc', started_at: new Date(0).toISOString() }),
  );
  const set = cli(['set', 'r_test1', '--missing', 'x'], root);
  assert.equal(set.status, 1);
  assert.match(set.stderr, /still in progress/);
  assert.equal(readRunVerdict(sessionDirOf(root)), null, 'nothing was written');

  // A verdict about a DIFFERENT run is fine while that one runs.
  mkdirSync(sessionDirOf(root, 'r_other'), { recursive: true });
  assert.equal(cli(['set', 'r_other', '--missing', 'x'], root).status, 0);
});

test('CLI: the recorded outcome is read from the trace, and an old db is simply unknown', () => {
  const root = project();
  const db = new Database(join(root, 'imp', 'data', 'fia.db'));
  db.exec(
    'CREATE TABLE sessions (fda_id TEXT PRIMARY KEY, status TEXT, started_at TEXT)',
  );
  db.prepare('INSERT INTO sessions (fda_id, status, started_at) VALUES (?, ?, ?)').run('r_test1', 'fail', 'x');
  db.close();
  // No `outcome` column: an older project must answer "unknown", not throw.
  assert.equal(outcomeOf(root, 'r_test1'), null);
  assert.equal(main(['set', 'r_test1', '--missing', 'x', '--dir', root]), 0);

  const db2 = new Database(join(root, 'imp', 'data', 'fia.db'));
  db2.exec('ALTER TABLE sessions ADD COLUMN outcome TEXT');
  db2.prepare('UPDATE sessions SET outcome=? WHERE fda_id=?').run('attempt_cap', 'r_test1');
  db2.close();
  assert.equal(outcomeOf(root, 'r_test1'), 'attempt_cap');
  const stored = JSON.parse(cli(['set', 'r_test1', '--missing', 'x', '--json'], root).stdout);
  assert.equal(stored.outcome, 'attempt_cap', 'the verdict carries how the run ended');
});

test('dataDirOf: honours the roster, falls back to imp/data, and tolerates a broken roster', () => {
  const root = project();
  assert.equal(dataDirOf(root), join(root, 'imp', 'data'));
  mkdirSync(join(root, 'imp'), { recursive: true });
  writeFileSync(join(root, 'imp', 'fia.config.yaml'), 'defaults:\n  data_dir: custom/here\n');
  assert.equal(dataDirOf(root), join(root, 'custom', 'here'));
  writeFileSync(join(root, 'imp', 'fia.config.yaml'), 'defaults: [not a map\n');
  assert.equal(dataDirOf(root), join(root, 'imp', 'data'), 'a malformed roster degrades to the default');
});

test('renderVerdict: the empty case teaches the command that records one', () => {
  assert.match(renderVerdict(null, 'r_abc'), /No verdict recorded for run r_abc/);
  assert.match(renderVerdict(null, 'r_abc'), /verdict\.mjs set r_abc --missing/);
});

// ── --redo names a phase THIS run saved, or it does nothing ──────────────────

/** Pretend the run got as far as saving these phase results. */
function savePhases(root, fdaId, names) {
  const dir = join(root, 'imp', 'data', 'sessions', fdaId, 'phase_results');
  mkdirSync(dir, { recursive: true });
  for (const n of names) writeFileSync(join(dir, `${n}.json`), JSON.stringify({ status: 'success', result: {} }));
}

test('savedPhases: the saved results of the run, and [] when the run saved nothing', () => {
  const root = project();
  assert.deepEqual(savedPhases(sessionDirOf(root)), []);
  savePhases(root, 'r_test1', ['build', 'plan', 'test_1']);
  writeFileSync(join(sessionDirOf(root), 'phase_results', 'notes.txt'), 'not a phase');
  assert.deepEqual(savedPhases(sessionDirOf(root)), ['build', 'plan', 'test_1']);
  assert.deepEqual(savedPhases(join(root, 'nowhere')), [], 'a vanished session is [], never a throw');
});

test('CLI: set refuses a --redo phase this run never saved, and names the ones it did', () => {
  const root = project();
  savePhases(root, 'r_test1', ['build', 'plan', 'test_1']);

  // `review` is an fda_sdlc phase; this run is a plan/build/test one. Recording
  // it would echo the name back and drop nothing.
  const bad = cli(['set', 'r_test1', '--missing', 'the empty state', '--redo', 'review'], root);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /No saved result for phase\(s\) review/);
  assert.match(bad.stderr, /Phases this run saved: build, plan, test_1/);
  assert.equal(readRunVerdict(sessionDirOf(root)), null, 'no half-true verdict was written');

  // The counter-suffixed id is the real one — a bare `test` drops nothing.
  const suffix = cli(['set', 'r_test1', '--missing', 'x', '--redo', 'test'], root);
  assert.equal(suffix.status, 1);
  assert.match(suffix.stderr, /test_1/);

  const good = cli(['set', 'r_test1', '--missing', 'the empty state', '--redo', 'build', '--json'], root);
  assert.equal(good.status, 0);
  assert.deepEqual(JSON.parse(good.stdout).redo, ['build']);
});

test('CLI: a run that saved no phase result says --redo drops nothing instead of promising it', () => {
  const root = project();
  const set = cli(['set', 'r_test1', '--missing', 'x', '--redo', 'build'], root);
  assert.equal(set.status, 0, 'there is no list to check against — this is not a typo, it is an empty run');
  assert.match(set.stderr, /saved no phase result/);

  const show = cli(['show', 'r_test1'], root);
  assert.match(show.stdout, /Phases to re-run: build \(no saved result — nothing to drop\)/);
  assert.match(show.stdout, /the resume drops nothing/);
  assert.doesNotMatch(show.stdout, /their saved results are dropped/);
});

test('renderVerdict: only a phase with a saved result is promised as re-run', () => {
  const verdict = { fda_id: 'r_abc', at: 'now', missing: ['x'], redo: ['build', 'review'], note: '' };
  const text = renderVerdict(verdict, 'r_abc', { saved: ['build', 'plan'] });
  assert.match(text, /Phases to re-run: build, review \(no saved result — nothing to drop\)/);
  assert.match(text, /dropped on the next resume/, 'build really will be dropped');

  const none = renderVerdict({ ...verdict, redo: ['review'] }, 'r_abc', { saved: ['build', 'plan'] });
  assert.match(none, /None of those phases has a saved result/);
  assert.match(none, /This run saved: build, plan\./);
});

// ── the run bootstrap consuming it ───────────────────────────────────────────

test('ensure(): a resumed run is narrowed by the verdict, drops the named phase results, and consumes it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-verdict-ensure-'));
  const dataDir = join(root, 'data');
  const fdaId = 'r_bound1';
  const sessionDir = join(dataDir, 'sessions', fdaId);
  mkdirSync(join(sessionDir, 'phase_results'), { recursive: true });
  writeFileSync(join(sessionDir, 'phase_results', 'review.json'), JSON.stringify({ status: 'success', result: {} }));
  writeFileSync(join(sessionDir, 'phase_results', 'plan.json'), JSON.stringify({ status: 'success', result: {} }));
  // A verdict may not name a path — only a phase name.
  writeRunVerdict(sessionDir, {
    fda_id: fdaId,
    outcome: 'verification_failed',
    missing: ['the 403 path has no test'],
    redo: ['review', '../../escape'],
  });

  const { ensure } = await import('../fia-templates/modules/session.mjs');
  const cfg = { defaults: { data_dir: dataDir }, observability: { db: join(dataDir, 'fia.db') }, agents: [] };
  const run = ensure(cfg, fdaId, { resume: true });

  assert.deepEqual(run.verdict.missing, ['the 403 path has no test'], 'the scope reached the Run');
  assert.equal(
    existsSync(join(sessionDir, 'phase_results', 'review.json')),
    false,
    'the named phase will re-execute (its saved result is gone)',
  );
  assert.equal(
    existsSync(join(sessionDir, 'phase_results', 'plan.json')),
    true,
    'every other succeeded phase still replays — that is the whole point of BOUNDED',
  );
  assert.equal(readRunVerdict(sessionDir), null, 'the verdict is one-shot and was consumed');

  // The decision is in the trace, not only on stdout.
  const events = readFileSync(join(sessionDir, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const logged = events.find((e) => e.name === 'bounded_continuation');
  assert.ok(logged, 'a bounded_continuation event is recorded');
  assert.deepEqual(logged.payload.redo, ['review'], 'the path-shaped entry was refused');
  assert.deepEqual(logged.payload.missing, ['the 403 path has no test']);
});
