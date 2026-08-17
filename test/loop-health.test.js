import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import {
  DIMENSIONS,
  collectEvidence,
  renderLoopHealth,
  renderLoopHealthHtml,
  runLoopHealth,
  scoreDimensions,
} from '../fia-templates/scripts/loop-health.mjs';

const SCRIPT = join(import.meta.dirname, '..', 'fia-templates', 'scripts', 'loop-health.mjs');
// The launch check otherwise reads the developer's real ~/Documents for backups.
const NO_BACKUPS = join(tmpdir(), 'loop-health-no-such-backups-dir');
const OPTS = { backupsDir: NO_BACKUPS, now: '2026-08-17 10:00' };
// The CLI has no --backups flag: the env overrides are how a child process
// stays away from the developer's home directory and real clock.
const ENV = { ...process.env, FIA_BACKUPS_DIR: NO_BACKUPS, IAI_DECISION_LOG_NOW: '2026-08-17T10:00:00' };

function newRoot() {
  return mkdtempSync(join(tmpdir(), 'loop-health-'));
}

function write(root, rel, text) {
  const file = join(root, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
  return file;
}

function dim(report, id) {
  return report.dimensions.find((d) => d.id === id);
}

/** A project with specs, tasks, a real PRD, decisions and an inbox. */
function seedAiDocs(root) {
  write(
    root,
    join('ai-docs', 'PRD.md'),
    '# PRD — Loop demo\n\nA real product goal, fully written, no placeholders left.\n',
  );
  write(
    root,
    join('ai-docs', 'specs', '0001-first-spec.md'),
    [
      '# Spec 0001 — First spec',
      'Status: defined',
      'Created: 2026-08-17 · Updated: 2026-08-17',
      'Tasks: 01',
      '',
      '## Traceability',
      '',
      '| Requirement | Scenario | Test |',
      '|-------------|----------|------|',
      '| FR-1 | S-1 | `tests/first.spec.ts` |',
      '',
    ].join('\n'),
  );
  write(
    root,
    join('ai-docs', 'todos', 'task-master.md'),
    [
      '# Tasks',
      '',
      '| # | Task | Status | Blocked by |',
      '|---|------|--------|------------|',
      '| 01 | [First thing](issues/01-first-thing.md) | done | None |',
      '',
    ].join('\n'),
  );
  write(
    root,
    join('ai-docs', 'todos', 'issues', '01-first-thing.md'),
    ['# Task 01 — First thing', '', '**Status:** done', '', '## Acceptance criteria', '- [x] it works', ''].join('\n'),
  );
  // A CLOSED decision log whose ANSWER text quotes the frontmatter markers as
  // CONTENT: only the real frontmatter may decide the status.
  write(
    root,
    join('ai-docs', 'decisions', '001-idea-2026-08-17.md'),
    [
      '---',
      'command: idea',
      'topic: the loop',
      'status: closed',
      'opened: 2026-08-17 09:00',
      'closed: 2026-08-17 09:30',
      '---',
      '',
      '# Decision log — /idea',
      '',
      '## Decisions',
      '',
      '### 1. Which status does an unfinished log carry?',
      '- Answer: the frontmatter says `status: open` while the interview runs.',
      '',
      '## Outcome',
      '- Result: decided',
      '',
    ].join('\n'),
  );
  write(root, join('ai-docs', 'inbox.md'), '- [ ] one idea worth keeping\n- [x] promoted idea\n');
  write(root, 'package.json', JSON.stringify({ scripts: { lint: 'x', typecheck: 'x', test: 'x', build: 'x' } }));
}

/** Fresh-schema trace db (with sessions.outcome) holding one finished run. */
function seedDb(root, { outcome = 'goal_met', status = 'success' } = {}) {
  const dbPath = join(root, 'imp', 'data', 'fia.db');
  mkdirSync(join(dbPath, '..'), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE sessions (fda_id TEXT PRIMARY KEY, status TEXT, started_at TEXT, ended_at TEXT, outcome TEXT);
    CREATE TABLE phases (phase_id TEXT PRIMARY KEY, fda_id TEXT, name TEXT, status TEXT);
    CREATE TABLE gate_results (id INTEGER PRIMARY KEY AUTOINCREMENT, fda_id TEXT, gate TEXT, passed INTEGER);
  `);
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run(
    'run1',
    status,
    '2026-08-17T09:00:00Z',
    '2026-08-17T09:20:00Z',
    outcome,
  );
  db.prepare('INSERT INTO phases VALUES (?,?,?,?)').run('run1_01_build', 'run1', 'build', 'success');
  db.prepare('INSERT INTO gate_results (fda_id, gate, passed) VALUES (?,?,?)').run('run1', 'test', 1);
  db.prepare('INSERT INTO gate_results (fda_id, gate, passed) VALUES (?,?,?)').run('run1', 'lint', 1);
  db.close();
  return dbPath;
}

/** OLD-shape trace db: sessions has no `outcome` column at all. */
function seedLegacyDb(root) {
  const dbPath = join(root, 'imp', 'data', 'fia.db');
  mkdirSync(join(dbPath, '..'), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE sessions (fda_id TEXT PRIMARY KEY, status TEXT, started_at TEXT, ended_at TEXT);
    CREATE TABLE phases (phase_id TEXT PRIMARY KEY, fda_id TEXT, name TEXT, status TEXT);
    CREATE TABLE gate_results (id INTEGER PRIMARY KEY AUTOINCREMENT, fda_id TEXT, gate TEXT, passed INTEGER);
  `);
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(
    'old1',
    'fail',
    '2026-08-17T08:00:00Z',
    '2026-08-17T08:10:00Z',
  );
  db.prepare('INSERT INTO phases VALUES (?,?,?,?)').run('old1_02_review', 'old1', 'review', 'fail');
  db.prepare('INSERT INTO gate_results (fda_id, gate, passed) VALUES (?,?,?)').run('old1', 'test', 0);
  db.prepare('INSERT INTO gate_results (fda_id, gate, passed) VALUES (?,?,?)').run('old1', 'test', 0);
  db.prepare('INSERT INTO gate_results (fda_id, gate, passed) VALUES (?,?,?)').run('old1', 'test', 0);
  db.close();
  return dbPath;
}

function initGitRepo(root) {
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'loop@test.dev'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Loop Health'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.gitignore'), 'imp/\n');
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' });
}

test('dimensions: the five ids are fixed and in order', () => {
  assert.deepEqual(
    DIMENSIONS.map((d) => d.id),
    ['task_understanding', 'controlled_execution', 'change_validation', 'reliable_delivery', 'learning_capture'],
  );
  for (const d of DIMENSIONS) assert.ok(d.title && d.what);
});

test('empty dir: available:false, nothing scored, and the renderer says so', () => {
  const root = newRoot();
  const report = runLoopHealth(root, OPTS);
  assert.equal(report.available, false);
  assert.equal(report.summary.max, 0);
  assert.equal(report.summary.score, 0);
  assert.equal(report.summary.percent, null);
  assert.equal(report.summary.unknown, 5);
  for (const d of report.dimensions) {
    assert.equal(d.status, 'unknown');
    assert.deepEqual(d.findings, []);
  }
  assert.match(renderLoopHealth(report), /Nothing to score/);
  assert.ok(report.gaps.some((g) => /no work loop|nothing could be scored/i.test(g)));
});

test('specs + tasks + decisions score above zero on the right dimensions', () => {
  const root = newRoot();
  seedAiDocs(root);
  const report = runLoopHealth(root, OPTS);
  assert.equal(report.available, true);

  const understanding = dim(report, 'task_understanding');
  assert.equal(understanding.max, 4);
  assert.equal(understanding.score, 4);
  assert.equal(understanding.status, 'strong');
  assert.deepEqual(understanding.findings, []);

  const learning = dim(report, 'learning_capture');
  assert.ok(learning.score >= 2, `learning score was ${learning.score}`);
  // The answer text quoting "status: open" must NOT make the log look open.
  assert.equal(report.evidence.decisions.open, 0);
  assert.equal(report.evidence.decisions.closed, 1);

  // Quality scripts are present, so change_validation earns that point.
  assert.ok(dim(report, 'change_validation').score >= 1);
  assert.equal(report.summary.percent, Math.round((report.summary.score / report.summary.max) * 100));
  assert.deepEqual(
    scoreDimensions(collectEvidence(root, OPTS)).map((d) => d.id),
    DIMENSIONS.map((d) => d.id),
  );
});

test('a dimension with no evidence is unknown and listed in gaps — never scored 0', () => {
  const root = newRoot();
  seedAiDocs(root); // ai-docs only: no trace db, no stack manifest
  const report = runLoopHealth(root, OPTS);
  const execution = dim(report, 'controlled_execution');
  assert.equal(execution.status, 'unknown');
  assert.equal(execution.max, 0);
  assert.equal(execution.score, 0);
  assert.deepEqual(execution.findings, []);
  assert.ok(report.gaps.some((g) => /no FDA run has ever been traced/.test(g)));
  assert.ok(report.gaps.some((g) => /stack was not judged/.test(g)));
  // The unknown dimension contributes nothing to either side of the ratio.
  const scored = report.dimensions.filter((d) => d.status !== 'unknown');
  assert.equal(
    report.summary.max,
    scored.reduce((n, d) => n + d.max, 0),
  );
});

test('missing PRD, specs and tasks are findings with real repair commands', () => {
  const root = newRoot();
  mkdirSync(join(root, 'ai-docs'), { recursive: true });
  const report = runLoopHealth(root, OPTS);
  const understanding = dim(report, 'task_understanding');
  assert.equal(understanding.score, 0);
  assert.equal(understanding.status, 'weak');
  const ids = understanding.findings.map((f) => f.id);
  assert.deepEqual(ids, ['specs_exist', 'tasks_index', 'prd_real']);
  const allowed = new Set([
    '/spec',
    '/feature',
    '/bug',
    '/task',
    '/quick',
    '/stack',
    '/kit',
    '/theme',
    '/component',
    '/design',
    '/launch',
    '/grill',
    '/absorb',
    '/onboarding',
    '/guide',
    '/map',
    '/note',
    '/status',
    '/goal',
    '/idea',
    '/prd',
    '/example',
    'npm run launch:check',
    'npm run env:check',
    'npm run docs:commit',
    'npm run tui',
  ]);
  for (const d of report.dimensions) {
    for (const f of d.findings) {
      assert.ok(allowed.has(f.repair), `unknown repair command: ${f.repair}`);
      assert.ok(['high', 'medium', 'low'].includes(f.severity));
      assert.ok(f.summary && f.evidence);
    }
  }
  // A PRD still full of {{placeholders}} is the installed template, not a goal.
  write(root, join('ai-docs', 'PRD.md'), '# PRD — {{project_name}}\n\n{{one_liner}}\n');
  const templated = dim(runLoopHealth(root, OPTS), 'task_understanding').findings.find((f) => f.id === 'prd_real');
  assert.match(templated.evidence, /\{\{placeholder\}\}/);
  assert.equal(templated.repair, '/prd');
});

test('a healthy trace db scores controlled_execution and change_validation', () => {
  const root = newRoot();
  seedAiDocs(root);
  seedDb(root);
  const report = runLoopHealth(root, OPTS);
  assert.equal(report.evidence.db.available, true);
  assert.equal(report.evidence.db.hasSchema, true);
  assert.equal(report.evidence.db.hasOutcomeColumn, true);
  assert.deepEqual(report.evidence.db.byOutcome, { goal_met: 1 });
  const execution = dim(report, 'controlled_execution');
  assert.equal(execution.score, 3);
  assert.equal(execution.max, 3); // stack_decided stays unknown (no manifest)
  const validation = dim(report, 'change_validation');
  assert.ok(validation.findings.every((f) => f.id !== 'quality_gates_passed'));
  assert.ok(report.evidence.db.gatePasses.test === 1);
});

test('a db without the outcome column is a gap, not a crash', () => {
  const root = newRoot();
  seedAiDocs(root);
  seedLegacyDb(root);
  const report = runLoopHealth(root, OPTS);
  assert.equal(report.evidence.db.hasSchema, true);
  assert.equal(report.evidence.db.hasOutcomeColumn, false);
  assert.equal(report.evidence.db.byOutcome, null);
  assert.ok(report.gaps.some((g) => /no sessions\.outcome column/.test(g)));
  // Statuses still readable: the failed run and the repeated gate failure show up.
  assert.equal(report.evidence.db.runs, 1);
  const execution = dim(report, 'controlled_execution');
  assert.ok(execution.findings.some((f) => f.id === 'runs_reach_their_goal'));
  assert.match(execution.findings.find((f) => f.id === 'runs_reach_their_goal').evidence, /no outcome column/);
  const validation = dim(report, 'change_validation');
  assert.ok(validation.findings.some((f) => f.id === 'no_dominant_gate_failure'));
  assert.ok(validation.findings.some((f) => f.id === 'quality_gates_passed'));
});

test('a db file with no schema at all degrades without throwing', () => {
  const root = newRoot();
  seedAiDocs(root);
  mkdirSync(join(root, 'imp', 'data'), { recursive: true });
  writeFileSync(join(root, 'imp', 'data', 'fia.db'), ''); // created before the schema is applied
  const report = runLoopHealth(root, OPTS);
  assert.equal(report.available, true);
  assert.equal(report.evidence.db.available, true);
  assert.equal(report.evidence.db.hasSchema, false);
  assert.equal(report.evidence.db.runs, 0);
  assert.equal(dim(report, 'controlled_execution').status, 'unknown');
  assert.ok(report.gaps.some((g) => /has no FIA schema yet/.test(g)));
  assert.ok(renderLoopHealth(report).includes('Gaps — what could not be observed'));
});

test('html: self-contained, theme-aware, and every interpolated value escaped', () => {
  const root = newRoot();
  seedAiDocs(root);
  // A path that LOOKS like markup must come out escaped, never as a tag.
  write(root, join('ai-docs', 'inbox.md'), '- [ ] a\n- [ ] b\n- [ ] c\n- [ ] <script>alert("x")</script>\n');
  const report = runLoopHealth(root, OPTS);
  report.gaps.push('a gap mentioning <script>alert("x")</script> & "quotes"');
  const html = renderLoopHealthHtml(report);

  assert.match(html, /^<!doctype html>\n<html lang="en">/);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<\/body>\n<\/html>$/);
  assert.match(html, /<title>Loop health — /);
  assert.match(html, /@media \(prefers-color-scheme: dark\)/);
  assert.match(html, /body\{[^}]*background:var\(--bg\)/);
  assert.equal(/(?:src|href)\s*=\s*["']?https?:/i.test(html), false);
  assert.equal(/<script/i.test(html), false);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&amp;'));
  assert.ok(html.includes('Gaps — what could not be observed'));
  assert.equal(html.includes('http://'), false);
  assert.equal(html.includes('https://'), false);
});

test('CLI: --json shape, --strict exit code and the exit codes of an empty project', () => {
  const root = newRoot();
  seedAiDocs(root);
  const run = (args) => spawnSync(process.execPath, [SCRIPT, '--dir', root, ...args], { encoding: 'utf8', env: ENV });

  const json = run(['--json']);
  assert.equal(json.status, 0);
  const report = JSON.parse(json.stdout);
  assert.equal(report.available, true);
  assert.equal(report.dimensions.length, 5);
  assert.ok(Array.isArray(report.gaps));
  assert.ok(report.evidence.db);
  assert.equal(report.evidence.generatedAt, '2026-08-17 10:00'); // clock override honored

  // Not a git repo → the launch check reports a blocker → reliable_delivery weak.
  const strict = run(['--strict']);
  assert.equal(strict.status, 1);
  assert.match(strict.stdout, /Loop health/);

  // execFileSync throws on a non-zero exit — read err.status/err.stdout.
  let threw = null;
  try {
    execFileSync(process.execPath, [SCRIPT, '--dir', root, '--strict', '--json'], { encoding: 'utf8', env: ENV });
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, 'expected --strict to exit non-zero');
  assert.equal(threw.status, 1);
  assert.equal(JSON.parse(threw.stdout).available, true);

  // A committed git repo with no weak dimension left → exit 0 under --strict.
  const clean = newRoot();
  seedAiDocs(clean);
  seedDb(clean);
  initGitRepo(clean);
  const ok = spawnSync(process.execPath, [SCRIPT, '--dir', clean, '--strict'], { encoding: 'utf8', env: ENV });
  assert.ok(ok.status === 0 || ok.status === 1, `unexpected exit ${ok.status}`);
  assert.match(ok.stdout, /Score: \d+\/\d+/);
});

test('CLI: --html writes one self-contained file and names it', () => {
  const root = newRoot();
  seedAiDocs(root);
  const r = spawnSync(process.execPath, [SCRIPT, '--dir', root, '--html'], { encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0);
  const written = join(root, 'imp', 'reports', 'loop-health.html');
  assert.equal(existsSync(written), true);
  assert.match(r.stdout, /HTML report written to imp\/reports\/loop-health\.html/);
  assert.match(readFileSync(written, 'utf8'), /prefers-color-scheme/);

  // Explicit path + --json: stdout stays pure JSON, the notice goes to stderr.
  const custom = join(root, 'reports', 'custom.html');
  const j = spawnSync(process.execPath, [SCRIPT, '--dir', root, '--json', '--html', custom], {
    encoding: 'utf8',
    env: ENV,
  });
  assert.equal(j.status, 0);
  assert.equal(existsSync(custom), true);
  assert.equal(JSON.parse(j.stdout).available, true);
  assert.match(j.stderr, /HTML report written to/);
});

test('CLI: a live FDA lock refuses the write, exits 1 and creates nothing', () => {
  const root = newRoot();
  seedAiDocs(root);
  // The lock's pid is THIS process: alive, and different from the child's own.
  write(
    root,
    join('imp', 'data', '.fda.lock'),
    JSON.stringify({
      pid: process.pid,
      fda_id: 'fda_demo_42',
      runner: 'loop-health-test',
      started_at: '2026-08-17T09:00:00Z',
    }),
  );
  const r = spawnSync(process.execPath, [SCRIPT, '--dir', root, '--html'], { encoding: 'utf8', env: ENV });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fda_demo_42/);
  assert.match(r.stderr, /Nothing was written/);
  assert.equal(r.stdout, '');
  assert.equal(existsSync(join(root, 'imp', 'reports', 'loop-health.html')), false);

  // Without --html the report is read-only, so the lock never blocks it.
  const readOnly = spawnSync(process.execPath, [SCRIPT, '--dir', root], { encoding: 'utf8', env: ENV });
  assert.equal(readOnly.status, 0);
  assert.match(readOnly.stdout, /Loop health/);
});

test('a dimension that could only judge SOME of its criteria says so, in text and in HTML', () => {
  // ai-docs present but no trace db at all: the run-based criteria of
  // controlled_execution are unjudged, so its remaining criterion must not read
  // as an unqualified "strong" — the coverage has to be on the badge.
  const root = newRoot();
  seedAiDocs(root);
  const report = runLoopHealth(root, OPTS);
  const partiallyJudged = report.dimensions.filter((d) => d.max > 0 && d.criteria > d.max);
  assert.ok(partiallyJudged.length > 0, 'with no trace db some criteria are necessarily unjudged');
  for (const d of partiallyJudged) {
    assert.ok(d.criteria > d.max, `${d.id} reports its total criteria count`);
  }

  const text = renderLoopHealth(report);
  assert.match(text, /only \d+ of \d+ criteria could be judged/);

  const html = renderLoopHealthHtml(report);
  assert.match(html, /\d+\/\d+ criteria judged/);

  // A fully-judged dimension must NOT carry the note.
  const fully = report.dimensions.find((d) => d.max > 0 && d.criteria === d.max);
  if (fully) {
    const line = text.split('\n').find((l) => l.includes(fully.title));
    assert.ok(line && !/criteria could be judged/.test(line), 'no coverage note when everything was judged');
  }
});
