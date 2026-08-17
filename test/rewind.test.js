import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyRewind,
  listCheckpoints,
  planRewind,
  renderCheckpoints,
  renderRewindPlan,
} from '../fia-templates/scripts/rewind.mjs';

const SCRIPT = join(import.meta.dirname, '..', 'fia-templates', 'scripts', 'rewind.mjs');

// A run window in the PAST on purpose: an open-ended run is capped at "now",
// so future-dated fixture commits would drop out of the window.
const T_INIT = '2026-08-10T10:00:00Z';
const T_START = '2026-08-10T10:05:00Z';
const T_PHASE1 = '2026-08-10T10:10:00Z';
const T_PHASE2 = '2026-08-10T10:15:00Z';
const T_END = '2026-08-10T10:20:00Z';
const T_LATE = '2026-08-10T11:00:00Z';

function git(root, args, env = {}) {
  execFileSync('git', args, { cwd: root, stdio: 'ignore', env: { ...process.env, ...env } });
}

function initRepo(prefix) {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  git(root, ['init']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['config', 'user.email', 'fia@test.dev']);
  git(root, ['config', 'user.name', 'FIA Rewind']);
  // Real installs gitignore imp/ — without it the trace db shows up as an
  // untracked file and every plan would look "dirty".
  writeFileSync(join(root, '.gitignore'), 'imp/\n');
  return root;
}

/** Commit the current tree with a fixed date, so windows are deterministic. */
function commit(root, message, at) {
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', message], { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

function writeDb(root, { outcomeColumn = false, rows = [] } = {}) {
  const dir = join(root, 'imp', 'data');
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, 'fia.db'));
  db.exec(
    `CREATE TABLE sessions (
       fda_id TEXT PRIMARY KEY, fda_name TEXT, request TEXT, status TEXT, engineer TEXT,
       started_at TEXT, ended_at TEXT, total_tokens INTEGER DEFAULT 0, total_cost REAL DEFAULT 0${
         outcomeColumn ? ', outcome TEXT' : ''
       }
     )`,
  );
  const cols = ['fda_id', 'fda_name', 'request', 'status', 'engineer', 'started_at', 'ended_at'];
  if (outcomeColumn) cols.push('outcome');
  const stmt = db.prepare(`INSERT INTO sessions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
  for (const row of rows) stmt.run(cols.map((c) => row[c] ?? null));
  db.close();
}

/**
 * A repo with one FDA run: init (baseline) → phase commit that modifies a.txt
 * and adds new.txt → phase commit that deletes gone.txt.
 */
function scenario(prefix, dbOpts = {}) {
  const root = initRepo(prefix);
  writeFileSync(join(root, 'a.txt'), 'old a\n');
  writeFileSync(join(root, 'keep.txt'), 'keep\n');
  writeFileSync(join(root, 'gone.txt'), 'gone\n');
  const initSha = commit(root, 'chore: init', T_INIT);

  writeFileSync(join(root, 'a.txt'), 'new a\n');
  writeFileSync(join(root, 'new.txt'), 'created by the run\n');
  const phase1 = commit(root, 'fia(FDA-abc): build phase', T_PHASE1);

  execFileSync('git', ['rm', '-q', 'gone.txt'], { cwd: root, stdio: 'ignore' });
  const phase2 = commit(root, 'refactor: drop the dead module', T_PHASE2);

  writeDb(root, {
    ...dbOpts,
    rows: [
      {
        fda_id: 'FDA-abc',
        fda_name: 'task-01-users',
        status: 'done',
        started_at: T_START,
        ended_at: T_END,
        ...(dbOpts.outcomeColumn ? { outcome: 'success' } : {}),
      },
    ],
  });
  return { root, initSha, phase1, phase2 };
}

test('listCheckpoints finds the run, its window commits and the pre-run baseline', () => {
  const { root, initSha, phase1, phase2 } = scenario('rewind-list');
  const listing = listCheckpoints(root);
  assert.equal(listing.available, true);
  assert.equal(listing.runs.length, 1);
  const run = listing.runs[0];
  assert.equal(run.fdaId, 'FDA-abc');
  assert.equal(run.fdaName, 'task-01-users');
  assert.equal(run.status, 'done');
  assert.equal(run.outcome, null); // column absent → defensive null, no crash
  const shas = run.commits.map((c) => c.sha);
  assert.deepEqual(shas, [phase2, phase1]); // newest first, window-filtered
  assert.ok(!shas.includes(initSha), 'the pre-run commit is not part of the run');
  assert.equal(run.baselineSha, initSha);
  assert.match(renderCheckpoints(listing), /FDA-abc/);
});

test('an outcome column, once another lane adds it, flows through untouched', () => {
  const { root } = scenario('rewind-outcome', { outcomeColumn: true });
  const listing = listCheckpoints(root);
  assert.equal(listing.runs[0].outcome, 'success');
  assert.match(renderCheckpoints(listing), /outcome success/);
});

test('a commit outside the window counts only when the fda_id is in its SUBJECT, never in file content', () => {
  const { root, phase1, phase2 } = scenario('rewind-grep');
  // Outside the window, subject names the run → belongs to it.
  writeFileSync(join(root, 'late.txt'), 'late\n');
  const late = commit(root, 'fia(FDA-abc): late docs sweep', T_LATE);
  // Outside the window, the id appears only as CONTENT → must NOT be picked up.
  writeFileSync(join(root, 'notes.md'), 'FDA-abc did this and that\n');
  const noise = commit(root, 'docs: notes', T_LATE);

  const run = listCheckpoints(root).runs[0];
  const shas = run.commits.map((c) => c.sha);
  assert.ok(shas.includes(late), 'subject match outside the window is included');
  assert.ok(!shas.includes(noise), 'the id inside a FILE is not a run commit');
  assert.equal(new Set(shas).size, shas.length, 'no duplicated sha');
  assert.ok(shas.includes(phase1) && shas.includes(phase2));
});

test('no trace db → available:false and the renderer points at imp tui', () => {
  const root = initRepo('rewind-nodb');
  commit(root, 'chore: init', T_INIT);
  const listing = listCheckpoints(root);
  assert.equal(listing.available, false);
  assert.deepEqual(listing.runs, []);
  const text = renderCheckpoints(listing);
  assert.match(text, /imp tui/);
  assert.match(text, /No FDA runs recorded yet/);
});

test('planRewind previews the per-file impact against the pre-run baseline', () => {
  const { root, initSha } = scenario('rewind-plan');
  const plan = planRewind(root, { fdaId: 'FDA-abc' });
  assert.deepEqual(plan.blocked, []);
  assert.equal(plan.ok, true);
  assert.equal(plan.target.sha, initSha);
  assert.equal(plan.target.shortSha, initSha.slice(0, 7));
  const byPath = Object.fromEntries(plan.files.map((f) => [f.path, f]));
  assert.deepEqual(byPath['a.txt'], { path: 'a.txt', added: 1, deleted: 1, status: 'modified' });
  assert.deepEqual(byPath['new.txt'], { path: 'new.txt', added: 1, deleted: 0, status: 'added' });
  assert.deepEqual(byPath['gone.txt'], { path: 'gone.txt', added: 0, deleted: 1, status: 'deleted' });
  assert.equal(byPath['keep.txt'], undefined);
  assert.deepEqual(plan.summary, { files: 3, added: 2, deleted: 2 });

  const text = renderRewindPlan(plan);
  assert.match(text, /a\.txt\s+\+1 -1/);
  assert.match(text, /new\.txt\s+\+1 -0/);
  assert.match(text, /total: 3 file\(s\), \+2 -2/);
  assert.match(text, /REMOVES it/);
});

test('a dirty working tree blocks in English, and allowDirty unblocks it', () => {
  const { root } = scenario('rewind-dirty');
  writeFileSync(join(root, 'keep.txt'), 'uncommitted edit\n');
  const blockedPlan = planRewind(root, { fdaId: 'FDA-abc' });
  assert.equal(blockedPlan.ok, false);
  assert.equal(blockedPlan.blocked.length, 1);
  assert.match(blockedPlan.blocked[0], /uncommitted changes/);
  assert.match(renderRewindPlan(blockedPlan), /Blocked — nothing was touched/);

  const allowed = planRewind(root, { fdaId: 'FDA-abc' }, { allowDirty: true });
  assert.equal(allowed.ok, true);
  assert.deepEqual(allowed.blocked, []);
});

test('a live FDA lock blocks the plan and names the fda_id', () => {
  const { root } = scenario('rewind-lock');
  // process.ppid is alive and is NOT this process — activeFdaLock ignores a
  // lock held by the caller itself.
  writeFileSync(
    join(root, 'imp', 'data', '.fda.lock'),
    JSON.stringify({ pid: process.ppid, fda_id: 'FDA-live', runner: 'session.mjs', started_at: T_START }),
  );
  const plan = planRewind(root, { fdaId: 'FDA-abc' });
  assert.equal(plan.ok, false);
  assert.ok(
    plan.blocked.some((r) => r.includes('FDA-live') && /active/.test(r)),
    `expected a lock refusal naming the fda_id, got ${JSON.stringify(plan.blocked)}`,
  );
});

test('an unresolvable --to blocks, and an unknown run id blocks', () => {
  const { root } = scenario('rewind-badsha');
  const plan = planRewind(root, { fdaId: 'FDA-abc', to: 'deadbeef' });
  assert.equal(plan.ok, false);
  assert.equal(plan.target, null);
  assert.ok(plan.blocked.some((r) => r.includes('deadbeef') && r.includes('does not resolve')));

  const unknown = planRewind(root, { fdaId: 'FDA-nope' });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.blocked.some((r) => r.includes('FDA-nope')));

  const invalid = planRewind(root, { fdaId: '../../etc/passwd' });
  assert.equal(invalid.ok, false);
  assert.match(invalid.blocked[0], /invalid run id/);
});

test('applyRewind refuses without consent and leaves the disk untouched', () => {
  const { root } = scenario('rewind-noyes');
  const plan = planRewind(root, { fdaId: 'FDA-abc' });
  const result = applyRewind(root, plan, {});
  assert.deepEqual(result.restored, []);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].path, '(all)');
  assert.match(result.failed[0].reason, /--yes/);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'new a\n');
  assert.equal(existsSync(join(root, 'new.txt')), true);
});

test('applyRewind with yes restores the old content, removes what the run created, and never commits', () => {
  const { root, phase2 } = scenario('rewind-apply');
  const plan = planRewind(root, { fdaId: 'FDA-abc' });
  const result = applyRewind(root, plan, { yes: true });
  assert.deepEqual(result.failed, []);
  assert.deepEqual([...result.restored].sort(), ['a.txt', 'gone.txt', 'new.txt']);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'old a\n');
  assert.equal(readFileSync(join(root, 'gone.txt'), 'utf8'), 'gone\n');
  assert.equal(existsSync(join(root, 'new.txt')), false);
  // HEAD never moved: restore-only, no reset, no commit.
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), phase2);
});

test('applyRewind on a blocked plan reports one (all) failure and touches nothing', () => {
  const { root } = scenario('rewind-blockedapply');
  const plan = planRewind(root, { fdaId: 'FDA-abc', to: 'deadbeef' });
  const result = applyRewind(root, plan, { yes: true });
  assert.deepEqual(result.restored, []);
  assert.equal(result.failed[0].path, '(all)');
  assert.match(result.failed[0].reason, /blocked/);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'new a\n');
});

test('CLI: --list exits 0, --dry-run exits 0 and writes nothing, --json is pure JSON', () => {
  const { root, initSha } = scenario('rewind-cli');
  const env = { ...process.env, FIA_DB: '' };

  const list = spawnSync(process.execPath, [SCRIPT, '--dir', root, '--list'], { encoding: 'utf8', env });
  assert.equal(list.status, 0);
  assert.match(list.stdout, /FDA-abc/);

  const dry = spawnSync(process.execPath, [SCRIPT, '--dir', root, '--run', 'FDA-abc', '--dry-run'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /total: 3 file\(s\)/);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'new a\n');

  const preview = spawnSync(process.execPath, [SCRIPT, '--dir', root, '--run', 'FDA-abc'], { encoding: 'utf8', env });
  assert.equal(preview.status, 0);
  assert.match(preview.stdout, /Re-run the same command with --yes/);

  const json = spawnSync(process.execPath, [SCRIPT, '--dir', root, '--run', 'FDA-abc', '--json'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(json.status, 0);
  const plan = JSON.parse(json.stdout);
  assert.equal(plan.ok, true);
  assert.equal(plan.target.sha, initSha);
  assert.equal(plan.summary.files, 3);

  const listJson = spawnSync(process.execPath, [SCRIPT, '--dir', root, '--list', '--json'], { encoding: 'utf8', env });
  assert.equal(listJson.status, 0);
  assert.equal(JSON.parse(listJson.stdout).runs[0].fdaId, 'FDA-abc');
});

test('CLI: exit 1 for an unknown run, and for a plan blocked by a live lock', () => {
  const { root } = scenario('rewind-cli-blocked');
  const env = { ...process.env, FIA_DB: '' };

  const unknown = spawnSync(process.execPath, [SCRIPT, '--dir', root, '--run', 'FDA-nope'], { encoding: 'utf8', env });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stdout, /FDA-nope/);

  // The child sees this test process as a live foreign pid holding the lock.
  writeFileSync(
    join(root, 'imp', 'data', '.fda.lock'),
    JSON.stringify({ pid: process.pid, fda_id: 'FDA-live', runner: 'session.mjs', started_at: T_START }),
  );
  const locked = spawnSync(process.execPath, [SCRIPT, '--dir', root, '--run', 'FDA-abc', '--yes'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(locked.status, 1);
  assert.match(locked.stdout, /FDA-live/);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'new a\n', 'a blocked plan never applies');

  const lockedJson = spawnSync(process.execPath, [SCRIPT, '--dir', root, '--run', 'FDA-abc', '--json'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(lockedJson.status, 1);
  assert.equal(JSON.parse(lockedJson.stdout).ok, false);
});

test('a binary file is listed with null counts and rendered as binary', () => {
  const { root } = scenario('rewind-binary');
  writeFileSync(join(root, 'logo.bin'), Buffer.from([0, 1, 2, 0, 255, 250, 0]));
  commit(root, 'fia(FDA-abc): drop in the logo', T_PHASE2);
  const plan = planRewind(root, { fdaId: 'FDA-abc' });
  const bin = plan.files.find((f) => f.path === 'logo.bin');
  assert.ok(bin, 'the binary path is still listed');
  assert.equal(bin.added, null);
  assert.equal(bin.deleted, null);
  assert.equal(bin.status, 'added');
  assert.match(renderRewindPlan(plan), /logo\.bin\s+binary/);
  // Counting skips the unknowns instead of poisoning the total with NaN.
  assert.equal(Number.isFinite(plan.summary.added), true);
});

// A pathspec is a wildmatch PATTERN, so a real filename holding `*`, `?` or `[`
// used to reach other tracked files. Windows cannot even hold such a name.
const GLOB_NAME_SKIP =
  process.platform === 'win32' ? 'Windows forbids "*" in a filename, so this path cannot exist' : false;

test(
  'applyRewind treats every path as a literal, so a glob-shaped name spares its neighbours',
  { skip: GLOB_NAME_SKIP },
  () => {
    const root = initRepo('rewind-literal');
    writeFileSync(join(root, 'abc.js'), 'abc baseline\n');
    writeFileSync(join(root, 'a b.js'), 'old space\n');
    writeFileSync(join(root, '-lead.js'), 'old dash\n');
    commit(root, 'chore: init', T_INIT);

    // The run creates ONLY `a*.js` and rewrites the space/dash paths. `abc.js` is
    // untouched by the run, so it must not appear in the plan nor be harmed.
    writeFileSync(join(root, 'a*.js'), 'created by the run\n');
    writeFileSync(join(root, 'a b.js'), 'new space\n');
    writeFileSync(join(root, '-lead.js'), 'new dash\n');
    commit(root, 'fia(FDA-abc): build phase', T_PHASE1);

    writeDb(root, {
      rows: [{ fda_id: 'FDA-abc', fda_name: 'task-01-glob', status: 'done', started_at: T_START, ended_at: T_END }],
    });

    const plan = planRewind(root, { fdaId: 'FDA-abc' });
    assert.deepEqual(plan.blocked, []);
    assert.deepEqual(
      plan.files.map((f) => f.path).sort(),
      ['-lead.js', 'a b.js', 'a*.js'],
      'abc.js is not part of the run, so the preview never lists it',
    );

    const result = applyRewind(root, plan, { yes: true });
    assert.deepEqual(result.failed, []);
    assert.equal(existsSync(join(root, 'a*.js')), false, 'the run-created path is gone');
    // The pathspec `a*.js` would also match `abc.js` — the literal one must not.
    assert.equal(existsSync(join(root, 'abc.js')), true, 'a path the preview never listed still exists');
    assert.equal(readFileSync(join(root, 'abc.js'), 'utf8'), 'abc baseline\n');
    assert.equal(readFileSync(join(root, 'a b.js'), 'utf8'), 'old space\n', 'a path with a space restores');
    assert.equal(readFileSync(join(root, '-lead.js'), 'utf8'), 'old dash\n', 'a path with a leading dash restores');
  },
);

test('applyRewind deletes run-created paths from the worktree only, staging nothing', () => {
  const { root, phase2 } = scenario('rewind-unstaged');
  const plan = planRewind(root, { fdaId: 'FDA-abc' });
  const result = applyRewind(root, plan, { yes: true });
  assert.deepEqual(result.failed, []);
  assert.equal(existsSync(join(root, 'new.txt')), false, 'the run-created file left the worktree');

  const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(staged, '', 'a rewind never stages anything — the index is untouched');
  // The deletion is therefore visible to a plain `git diff`, exactly as the
  // closing CLI line promises, and `git restore new.txt` undoes it.
  const status = execFileSync('git', ['status', '--porcelain', '--', 'new.txt'], { cwd: root, encoding: 'utf8' });
  assert.match(status, /^ D new\.txt$/m, 'an unstaged deletion the student can inspect and undo');
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), phase2);
});

test('a non-git directory degrades: listing works, the plan refuses', () => {
  const root = mkdtempSync(join(tmpdir(), 'rewind-nogit-'));
  writeDb(root, {
    rows: [{ fda_id: 'FDA-abc', fda_name: 'task', status: 'done', started_at: T_START, ended_at: T_END }],
  });
  const listing = listCheckpoints(root);
  assert.equal(listing.available, true);
  assert.deepEqual(listing.runs[0].commits, []);
  assert.equal(listing.runs[0].baselineSha, null);
  const plan = planRewind(root, { fdaId: 'FDA-abc' });
  assert.equal(plan.ok, false);
  assert.ok(plan.blocked.some((r) => r.includes('not a git repository')));
});

// ── the plan is bounded to the RUN, never to the working tree ────────────────

test('a rewind never touches work committed AFTER the run, and says so', () => {
  // The failure this pins: the plan used to be `git diff <baseline> -- .`, i.e.
  // baseline vs the CURRENT tree, so every later commit — a second FDA run, a
  // student's hand-fix, a teammate's merge — was folded in, labelled "created by
  // the run" and deleted by --yes.
  const { root, initSha } = scenario('rewind-scope');
  writeFileSync(join(root, 'my-own-work.txt'), 'hand written, precious\n');
  writeFileSync(join(root, 'keep.txt'), 'edited by the student after the run\n');
  commit(root, 'my own manual work after the FDA run', T_LATE);

  const plan = planRewind(root, { fdaId: 'FDA-abc' });
  assert.equal(plan.ok, true);
  assert.equal(plan.target.sha, initSha, 'the target is still the pre-run HEAD');
  const paths = plan.files.map((f) => f.path);
  assert.ok(!paths.includes('my-own-work.txt'), 'the student’s later file is NOT in the plan');
  assert.ok(!paths.includes('keep.txt'), 'a file only the student touched afterwards is NOT in the plan');
  assert.deepEqual(paths.sort(), ['a.txt', 'gone.txt', 'new.txt'], 'only what the run itself changed');
  assert.match(plan.notes.join('\n'), /1 commit\(s\) landed after this run/);
  assert.match(renderRewindPlan(plan), /landed after this run/);

  const result = applyRewind(root, plan, { yes: true });
  assert.deepEqual(result.failed, []);
  assert.equal(existsSync(join(root, 'my-own-work.txt')), true, 'the student’s file survives the rewind');
  assert.equal(
    readFileSync(join(root, 'keep.txt'), 'utf8'),
    'edited by the student after the run\n',
    'and their edit survives untouched',
  );
  assert.equal(existsSync(join(root, 'new.txt')), false, 'while the file the run created is gone');
});

test('a run that committed nothing is refused, and --list does not offer to undo it', () => {
  const root = initRepo('rewind-nocommits');
  writeFileSync(join(root, 'a.txt'), 'a\n');
  commit(root, 'chore: init', T_INIT);
  writeDb(root, {
    rows: [{ fda_id: 'FDA-empty', fda_name: 'task-x', status: 'fail', started_at: T_START, ended_at: T_END }],
  });

  const listing = listCheckpoints(root);
  assert.deepEqual(listing.runs[0].commits, [], 'the run left no commits');
  assert.match(renderCheckpoints(listing), /nothing to undo: this run left no commits/);
  assert.doesNotMatch(renderCheckpoints(listing), /preview an undo/);

  const plan = planRewind(root, { fdaId: 'FDA-empty' });
  assert.equal(plan.ok, false);
  assert.match(plan.blocked.join('\n'), /left no commits — there is nothing to undo/);
  assert.deepEqual(plan.files, [], 'and it describes nobody else’s work');
});

test('every next step this command prints names the branded verb, not the script path', () => {
  const { root } = scenario('rewind-branding');
  const listing = renderCheckpoints(listCheckpoints(root));
  assert.match(listing, /preview an undo: imp rewind --run FDA-abc --dry-run/);
  assert.doesNotMatch(listing, /node imp\/scripts\//, 'the internal path is not what a student memorizes');

  const unknown = planRewind(root, { fdaId: 'FDA-nope' });
  assert.match(unknown.blocked.join('\n'), /list the runs with: imp rewind --list/);
  assert.doesNotMatch(unknown.blocked.join('\n'), /node imp\/scripts\//);
});

test('rewind.mjs and notify.mjs never hand a student a `node imp/scripts/` command', () => {
  // The verbs `imp rewind` / `imp notify` shipped in the same release as these
  // scripts and pass every flag through, so a printed `node imp/scripts/…` is
  // the one form a student should never learn — the notify one even lands
  // verbatim in the team's Slack channel. Header comments document the script
  // itself and keep the raw form.
  const isComment = (line) => /^\s*(\*|\/\/|\/\*)/.test(line);
  for (const name of ['rewind.mjs', 'notify.mjs']) {
    const source = readFileSync(join(import.meta.dirname, '..', 'fia-templates', 'scripts', name), 'utf8');
    const offenders = source
      .split('\n')
      .filter((line) => line.includes('node imp/scripts/') && !isComment(line));
    assert.deepEqual(offenders, [], `${name} names the branded verb in every student-facing line`);
  }
});
