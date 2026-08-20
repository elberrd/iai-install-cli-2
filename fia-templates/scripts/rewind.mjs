#!/usr/bin/env node
/**
 * Rewind — checkpoints of an FDA run, with a preview before anything moves.
 *
 * An FDA run already leaves everything an undo needs on disk: it commits per
 * phase and photographs the tree before it starts. What was missing is a way
 * to SEE those checkpoints and use them. This script is that way:
 *
 *   --list            the runs in the trace db and the commits each one made
 *   --run <fda_id>    the exact file impact of undoing that run, per file,
 *                     with +added/-deleted counts and a total
 *   --run … --yes     restore those files from the checkpoint
 *
 * Restore-only by contract: it writes files with `git restore --worktree` and
 * deletes files the run created from the WORKING TREE only. It NEVER touches
 * the index, never runs `git reset`, never moves HEAD or a branch, never commits
 * and never rewrites history — so a rewind is itself undoable (the commits are
 * all still there) and every change it makes shows up in a plain `git diff`.
 * Nothing is touched without `--yes`; the preview is the default.
 *
 * Usage (students run `imp rewind …`, which passes every flag through to this
 * script — that branded form is what this file's own output names):
 *   node imp/scripts/rewind.mjs [--dir <root>] [--list]
 *   node imp/scripts/rewind.mjs [--dir <root>] --run <fda_id> [--to <sha>]
 *          [--json] [--dry-run] [--yes] [--allow-dirty]
 * Exit 0 = listing/preview printed (or the restore succeeded); 1 = the plan is
 * blocked, the run id is unknown, or a restore failed.
 */
import Database from 'better-sqlite3';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { activeFdaLock } from './fda-lock.mjs';

/** Anything that reaches git's argv is validated against this first. */
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;
const MAX_RUNS = 20;
const MAX_COMMITS = 30;

// ── plumbing (every call degrades, none throws) ───────────────────────────────

/** git stdout (raw) or null when git is missing / the command failed. */
function git(root, args) {
  try {
    const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return r.status === 0 ? r.stdout || '' : null;
  } catch {
    return null; /* no git binary — the caller degrades to "no commits" */
  }
}

function gitLine(root, args) {
  const out = git(root, args);
  return out == null ? null : out.trim() || null;
}

function isGitRepo(root) {
  return gitLine(root, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

/** Where the trace db lives (opts.dbPath > FIA_DB > imp/data/fia.db). */
function traceDbPath(root, opts = {}) {
  const raw = opts.dbPath || process.env.FIA_DB || join('imp', 'data', 'fia.db');
  return isAbsolute(raw) ? raw : resolve(root, raw);
}

/** Read-only handle, or null while the db does not exist yet. */
function openTraceDb(dbPath) {
  if (!existsSync(dbPath)) return null;
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 2000');
    return db;
  } catch {
    return null; /* corrupt or locked beyond the timeout — behave like "no db" */
  }
}

function repoRelative(root, path) {
  return relative(root, path).replaceAll('\\', '/');
}

/** Rename-aware path from a numstat/name-status field, always POSIX slashes. */
function normalizePath(raw) {
  let out = String(raw ?? '').trim();
  const brace = /\{(.*?) => (.*?)\}/;
  if (brace.test(out)) out = out.replace(brace, (_m, _old, next) => next);
  else if (out.includes(' => ')) out = out.split(' => ').pop();
  return out.replaceAll('\\', '/');
}

function parseLogLines(out) {
  if (!out) return [];
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, subject, at] = line.split('\0');
      return sha ? { sha, shortSha: sha.slice(0, 7), subject: subject || '', at: at || null } : null;
    })
    .filter(Boolean);
}

const LOG_FORMAT = '--format=%H%x00%s%x00%cI';

// ── listing ──────────────────────────────────────────────────────────────────

/**
 * Commits that belong to a run. Message matching alone is not reliable (an FDA
 * commit may carry the agent's own commit_message), so the run's time window is
 * the primary filter and subject-matching only ADDS commits the window missed.
 */
function runCommits(root, { fdaId, startedAt, endedAt }) {
  const windowArgs = ['log', LOG_FORMAT, '-n', String(MAX_COMMITS * 4)];
  if (startedAt) windowArgs.push(`--since=${startedAt}`);
  windowArgs.push(`--until=${endedAt || new Date().toISOString()}`);
  const byWindow = parseLogLines(git(root, windowArgs));

  let bySubject = [];
  if (SAFE_ID.test(String(fdaId || ''))) {
    const grepped = parseLogLines(
      git(root, ['log', LOG_FORMAT, '-n', String(MAX_COMMITS * 4), '--fixed-strings', `--grep=${fdaId}`]),
    );
    bySubject = grepped.filter((c) => c.subject.includes(fdaId));
  }

  const seen = new Set();
  const all = [];
  for (const c of [...byWindow, ...bySubject]) {
    if (seen.has(c.sha)) continue;
    seen.add(c.sha);
    all.push(c);
  }
  all.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return all.slice(0, MAX_COMMITS);
}

/** The commit that was HEAD when the run started — null when undeterminable. */
function baselineFor(root, startedAt) {
  if (!startedAt) return null;
  return gitLine(root, ['log', '-n', '1', '--format=%H', `--until=${startedAt}`]);
}

/**
 * Every run in the trace db (newest first, capped), each with the commits it
 * produced and the pre-run HEAD. Read-only: never writes, never throws.
 */
export function listCheckpoints(root = process.cwd(), opts = {}) {
  root = resolve(root);
  const dbPath = traceDbPath(root, opts);
  const db = openTraceDb(dbPath);
  if (!db) return { available: false, dbPath: repoRelative(root, dbPath), runs: [] };

  let rows = [];
  try {
    // SELECT * on purpose: columns added later (outcome…) flow through without
    // this reader knowing their names.
    rows = db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?').all(MAX_RUNS);
  } catch {
    rows = []; /* schema-less db (the Tracer creates the file before the schema) */
  }
  try {
    db.close();
  } catch {
    /* already gone — nothing to release */
  }

  const repo = isGitRepo(root);
  const runs = rows.map((row) => {
    const fdaId = row.fda_id;
    const startedAt = row.started_at || null;
    const endedAt = row.ended_at || null;
    return {
      fdaId,
      fdaName: row.fda_name || null,
      status: row.status || null,
      outcome: row.outcome ?? null,
      startedAt,
      endedAt,
      commits: repo ? runCommits(root, { fdaId, startedAt, endedAt }) : [],
      baselineSha: repo ? baselineFor(root, startedAt) : null,
    };
  });
  return { available: true, dbPath: repoRelative(root, dbPath), runs };
}

// ── plan ─────────────────────────────────────────────────────────────────────

function parseNumstat(out) {
  const map = new Map();
  for (const line of String(out || '').split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const path = normalizePath(parts.slice(2).join('\t'));
    if (!path) continue;
    const added = parts[0] === '-' ? null : Number.parseInt(parts[0], 10);
    const deleted = parts[1] === '-' ? null : Number.parseInt(parts[1], 10);
    map.set(path, {
      path,
      added: Number.isFinite(added) ? added : null,
      deleted: Number.isFinite(deleted) ? deleted : null,
    });
  }
  return map;
}

/**
 * Letters are read in git's own direction (target → working tree), i.e. they
 * describe what the RUN did: 'added' = the run created the path (so a restore
 * removes it), 'deleted' = the run deleted it (so a restore brings it back).
 */
function statusOf(letter) {
  const l = String(letter || '').charAt(0);
  if (l === 'A') return 'added';
  if (l === 'D') return 'deleted';
  return 'modified';
}

function parseNameStatus(out) {
  const map = new Map();
  for (const line of String(out || '').split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const path = normalizePath(parts[parts.length - 1]);
    if (path) map.set(path, statusOf(parts[0]));
  }
  return map;
}

function fileImpact(root, sha, tip) {
  // Scoped to the RUN's own commits (`baseline..tip`), never to the working
  // tree. Diffing against the tree folded in everything committed AFTER the run
  // — a later FDA run, a hand-fix, a teammate's merge — and presented it as
  // "created by the run", then deleted it on --yes.
  const range = [sha, tip];
  const counts = parseNumstat(git(root, ['diff', '--numstat', ...range, '--', '.']));
  const statuses = parseNameStatus(git(root, ['diff', '--name-status', ...range, '--', '.']));
  const files = [];
  for (const [path, entry] of counts) {
    files.push({ path, added: entry.added, deleted: entry.deleted, status: statuses.get(path) || 'modified' });
  }
  for (const [path, status] of statuses) {
    if (!counts.has(path)) files.push({ path, added: null, deleted: null, status });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

/**
 * What restoring `fdaId` back to `to` (default: the run's pre-run HEAD) would
 * do to the working tree. Reads only — the answer is the preview a human wants
 * BEFORE consenting. Refusals are collected in `blocked` as English lines.
 */
export function planRewind(root, { fdaId, to } = {}, opts = {}) {
  root = resolve(root);
  const blocked = [];
  const id = String(fdaId ?? '');
  if (!SAFE_ID.test(id)) {
    blocked.push(`invalid run id "${id}" — a run id looks like FDA-1a2b3c (letters, digits, dash, underscore)`);
    return { ok: false, fdaId: id, target: null, files: [], summary: { files: 0, added: 0, deleted: 0 }, blocked };
  }

  const repo = isGitRepo(root);
  if (!repo)
    blocked.push('not a git repository — rewind restores files from git history, so there is nothing to restore from');

  const listing = listCheckpoints(root, opts);
  const run = listing.runs.find((r) => r.fdaId === id) || null;
  if (!run) {
    blocked.push(
      listing.available
        ? `run ${id} is not in the trace db (${listing.dbPath}) — list the runs with: imp rewind --list`
        : `no trace db yet (${listing.dbPath}) — no run has been recorded in this project`,
    );
  }

  const lock = activeFdaLock(root, opts.dataDir || join('imp', 'data'));
  if (lock) {
    blocked.push(
      `an FDA run is active (fda_id ${lock.fda_id || 'unknown'}, pid ${lock.pid || '?'}) — it is writing to this tree; ` +
        'wait for it to finish and rewind afterwards',
    );
  }

  if (repo && !opts.allowDirty) {
    const dirty = (git(root, ['status', '--porcelain']) || '').trim();
    if (dirty) {
      blocked.push(
        'the working tree has uncommitted changes — a rewind overwrites files in place, so commit or stash them first, ' +
          'or re-run with --allow-dirty to accept losing them',
      );
    }
  }

  let target = null;
  const wanted = to || run?.baselineSha || null;
  if (repo && wanted) {
    if (!SAFE_ID.test(String(wanted))) {
      blocked.push(`invalid commit "${wanted}" — pass a commit sha (short or full)`);
    } else {
      const sha = gitLine(root, ['rev-parse', '--verify', `${wanted}^{commit}`]);
      if (!sha)
        blocked.push(`commit ${wanted} does not resolve in this repository — check the sha with: git log --oneline`);
      else
        target = {
          sha,
          shortSha: sha.slice(0, 7),
          subject: gitLine(root, ['log', '-n', '1', '--format=%s', sha]) || '',
        };
    }
  } else if (repo && run && !wanted) {
    blocked.push(
      `run ${id} has no baseline commit on record (it started before the first commit, or the history was rewritten) — ` +
        'pass an explicit --to <sha>',
    );
  }

  // The run's own newest commit is the far end of the diff. Without it the run
  // changed nothing that git can undo, and any "preview" would describe someone
  // else's work.
  const notes = [];
  const runTip = run?.commits?.[0]?.sha || null;
  if (repo && run && !runTip) {
    blocked.push(
      `run ${id} left no commits — there is nothing to undo. ` +
        'Its work (if any) is still uncommitted; `git status` shows it, and `git restore <path>` discards it.',
    );
  }
  if (repo && runTip) {
    const head = gitLine(root, ['rev-parse', 'HEAD']);
    if (head && head !== runTip) {
      const after = gitLine(root, ['rev-list', '--count', `${runTip}..HEAD`]);
      if (after && after !== '0') {
        notes.push(
          `${after} commit(s) landed after this run — they are NOT part of this rewind and stay exactly as they are.`,
        );
      }
    }
  }

  const files = target && runTip ? fileImpact(root, target.sha, runTip) : [];
  const summary = {
    files: files.length,
    added: files.reduce((n, f) => n + (f.added || 0), 0),
    deleted: files.reduce((n, f) => n + (f.deleted || 0), 0),
  };
  return {
    ok: blocked.length === 0 && target != null && runTip != null,
    fdaId: id,
    target,
    runTip,
    files,
    summary,
    notes,
    blocked,
  };
}

// ── renderers (pure) ─────────────────────────────────────────────────────────

export function renderCheckpoints(listing) {
  const lines = ['FIA checkpoints — the commits each FDA run left behind', ''];
  if (!listing?.available || !listing.runs.length) {
    lines.push(
      `No FDA runs recorded yet${listing?.dbPath ? ` (${listing.dbPath})` : ''} — watch runs as they happen with: imp tui`,
    );
    return lines.join('\n');
  }
  for (const run of listing.runs) {
    const tags = [run.status || 'unknown', run.outcome ? `outcome ${run.outcome}` : null].filter(Boolean).join(', ');
    lines.push(`${run.fdaId}  ${run.fdaName || '(unnamed)'}  [${tags}]`);
    lines.push(`  window: ${run.startedAt || '?'} → ${run.endedAt || 'still open'}`);
    lines.push(`  baseline (pre-run HEAD): ${run.baselineSha ? run.baselineSha.slice(0, 7) : 'unknown'}`);
    if (!run.commits.length) lines.push('  commits: none found in this run window');
    else {
      lines.push('  commits:');
      for (const c of run.commits) lines.push(`    ${c.shortSha}  ${c.subject}${c.at ? `  (${c.at})` : ''}`);
    }
    // A run with no commits has nothing to undo — offering a preview for it
    // is how the tool ended up describing somebody else's work.
    if (run.commits.length) lines.push(`  preview an undo: imp rewind --run ${run.fdaId} --dry-run`);
    else lines.push('  nothing to undo: this run left no commits');
    lines.push('');
  }
  lines.push('Nothing is ever restored without --yes. Live runs: imp tui');
  return lines.join('\n');
}

function countCell(file) {
  if (file.added == null && file.deleted == null) return 'binary';
  return `+${file.added ?? 0} -${file.deleted ?? 0}`;
}

const STATUS_NOTE = {
  added: 'created by the run — the restore REMOVES it',
  deleted: 'deleted by the run — the restore brings it back',
  modified: 'changed by the run — the restore rewrites it',
};

export function renderRewindPlan(plan) {
  if (!plan) return 'No rewind plan.';
  const lines = [`Rewind preview — run ${plan.fdaId}`, ''];
  if (plan.target) lines.push(`target checkpoint: ${plan.target.shortSha}  ${plan.target.subject}`, '');
  if (plan.blocked?.length) {
    lines.push('Blocked — nothing was touched:');
    for (const reason of plan.blocked) lines.push(`  ✗ ${reason}`);
    return lines.join('\n');
  }
  if (!plan.files.length) {
    lines.push('No file differs from that checkpoint — the working tree already matches it, nothing to restore.');
    return lines.join('\n');
  }
  const width = Math.min(60, Math.max(...plan.files.map((f) => f.path.length)));
  for (const f of plan.files) {
    const mark = f.status === 'added' ? 'A' : f.status === 'deleted' ? 'D' : 'M';
    lines.push(`  ${mark}  ${f.path.padEnd(width)}  ${countCell(f).padStart(9)}   ${STATUS_NOTE[f.status]}`);
  }
  lines.push('', `  total: ${plan.summary.files} file(s), +${plan.summary.added} -${plan.summary.deleted}`);
  for (const note of plan.notes || []) lines.push(`  ! ${note}`);
  lines.push('', 'Restore-only: no commit, no branch move, no git reset — the run commits all stay in history.');
  return lines.join('\n');
}

// ── apply ────────────────────────────────────────────────────────────────────

function reasonOf(err) {
  const raw = err?.stderr ? String(err.stderr) : err?.message || 'git failed';
  return raw.replace(/\s+/g, ' ').trim() || 'git failed';
}

/**
 * A real path, turned into a pathspec that means only itself. A bare pathspec is
 * a wildmatch PATTERN, so a legitimate file named `a*.js` would also match
 * `abc.js` and the apply would hit files the preview never listed. `:(literal)`
 * disables pathspec magic for that entry.
 */
function literalPathspec(path) {
  return `:(literal)${path}`;
}

/**
 * Apply a plan, path by path. Requires `yes: true` — consent lives with the
 * caller, never with this function. Never throws: every failure lands in
 * `failed` so the caller can report a partial restore honestly.
 */
export function applyRewind(root, plan, opts = {}) {
  root = resolve(root);
  if (!plan?.ok) {
    const reason = plan?.blocked?.length
      ? `plan is blocked: ${plan.blocked.join(' | ')}`
      : 'plan is not applicable — build it again with planRewind and check `blocked`';
    return { restored: [], failed: [{ path: '(all)', reason }] };
  }
  if (opts.yes !== true) {
    return {
      restored: [],
      failed: [
        { path: '(all)', reason: 'refused without consent — re-run with --yes to actually restore these files' },
      ],
    };
  }

  const restored = [];
  const failed = [];
  for (const file of plan.files) {
    try {
      if (file.status === 'added') {
        // Worktree-only removal: `git rm` would also drop the index entry, which
        // stages a deletion the student never asked for (and that a plain
        // `git diff` does not even show). Unlinking leaves the index alone, so
        // `git status` reports ` D` and `git restore <path>` undoes the rewind.
        rmSync(join(root, file.path), { force: true });
      } else {
        // Paths are separate argv entries after `--`: never a shell string, so a
        // path with a space, a quote or a leading dash cannot become an option.
        // `:(literal)` additionally stops `*`, `?` and `[` in a real filename
        // from matching other tracked files.
        const args = ['restore', `--source=${plan.target.sha}`, '--worktree', '--', literalPathspec(file.path)];
        execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], timeout: 20000 });
      }
      restored.push(file.path);
    } catch (err) {
      failed.push({ path: file.path, reason: reasonOf(err) });
    }
  }
  return { restored, failed };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function flagValue(argv, flag) {
  const ix = argv.indexOf(flag);
  return ix !== -1 && argv[ix + 1] !== undefined ? argv[ix + 1] : undefined;
}

// realpath both sides: Node realpaths the ESM entry for import.meta.url, so a
// symlinked invocation path would otherwise make the CLI a silent no-op.
const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  }
})();
if (isMain) {
  const argv = process.argv.slice(2);
  const root = resolve(flagValue(argv, '--dir') ?? process.cwd());
  const json = argv.includes('--json');
  const runId = flagValue(argv, '--run');
  const opts = { allowDirty: argv.includes('--allow-dirty') };

  if (!runId) {
    const listing = listCheckpoints(root, opts);
    console.log(json ? JSON.stringify(listing, null, 2) : renderCheckpoints(listing));
    process.exit(0);
  }

  const plan = planRewind(root, { fdaId: runId, to: flagValue(argv, '--to') }, opts);
  if (json) {
    console.log(JSON.stringify(plan, null, 2));
    process.exit(plan.ok ? 0 : 1);
  }
  console.log(renderRewindPlan(plan));
  if (!plan.ok) process.exit(1);
  if (argv.includes('--dry-run')) process.exit(0);
  if (!argv.includes('--yes')) {
    console.log('', 'Nothing was touched. Re-run the same command with --yes to apply this restore.');
    process.exit(0);
  }

  const result = applyRewind(root, plan, { yes: true });
  console.log('');
  for (const path of result.restored) console.log(`  restored: ${path}`);
  for (const f of result.failed) console.log(`  FAILED:   ${f.path} — ${f.reason}`);
  console.log(
    '',
    `${result.restored.length} path(s) restored from ${plan.target.shortSha}${result.failed.length ? `, ${result.failed.length} failed` : ''}.`,
  );
  console.log('Review with `git status` / `git diff` — nothing was committed.');
  process.exit(result.failed.length ? 1 : 0);
}
