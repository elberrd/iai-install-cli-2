import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function repoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Content fingerprint of one working-tree path. Content (size + sha1), never
 * mtime or numstat: two different edits to the same line must never collide,
 * and HEAD moving mid-run (an earlier commit phase) must not change the
 * reading. 'deleted' when the path is gone; 'dir' is never fingerprintable.
 */
function fingerprint(cwd, path) {
  const abs = resolve(cwd, path);
  try {
    if (statSync(abs).isDirectory()) return 'dir';
    const content = readFileSync(abs);
    return `${content.length},${createHash('sha1').update(content).digest('hex')}`;
  } catch {
    return 'deleted';
  }
}

/**
 * Fingerprint every path that currently differs from HEAD — staged, unstaged
 * and untracked (individually, even inside untracked directories), deletions
 * included. Empty map outside a git repository.
 */
export function treeFingerprints(cwd) {
  const map = {};
  let out = '';
  try {
    out = git(['status', '--porcelain', '-z', '--untracked-files=all'], cwd);
  } catch {
    return map; // not a repo — nothing to fingerprint
  }
  const records = out.split('\0');
  for (let i = 0; i < records.length; i++) {
    const entry = records[i];
    if (!entry) continue;
    const path = entry.slice(3);
    if (!path) continue;
    map[path] = fingerprint(cwd, path);
    // Rename/copy records carry the ORIGIN path as the next NUL field — it has
    // no status prefix of its own and must not be misread as another entry.
    if (/[RC]/.test(entry.slice(0, 2))) i += 1;
  }
  return map;
}

/**
 * The run's pre-flight photo of the working tree, persisted with the session.
 * Taken ONCE when the run first starts; reloaded verbatim on --resume (by then
 * the tree already contains the run's own work — retaking it would make that
 * work look pre-existing and silently drop it from the commit). Commit phases
 * use it to tell the run's work apart from changes that were ALREADY sitting
 * in the tree before the run began.
 */
export function loadOrCreateBaseline(sessionDir, cwd) {
  const file = join(sessionDir, 'baseline.json');
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    /* unreadable snapshot → retake below (worst case: this run filters less) */
  }
  const baseline = treeFingerprints(cwd);
  try {
    writeFileSync(file, JSON.stringify(baseline, null, 2));
  } catch {
    /* session dir not writable — the in-memory baseline still covers this run */
  }
  return baseline;
}

/**
 * Paths this RUN actually touched: dirty right now AND different from what the
 * baseline recorded. Pre-existing dirt the run never modified stays out.
 */
export function runChangedPaths(cwd, baseline = {}) {
  const current = treeFingerprints(cwd);
  return Object.keys(current)
    .filter((p) => baseline[p] !== current[p])
    .sort();
}

function normalize(path) {
  return String(path)
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

/**
 * A declared directory would `git add` everything under it — pre-run dirt
 * included. With a baseline in hand, expand it to the individual dirty paths
 * beneath it so each one faces the same untouched-since-baseline filter.
 */
function expandDirectories(cwd, paths, current) {
  const expanded = [];
  for (const path of paths) {
    const abs = resolve(cwd, path);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      /* gone from disk (a deletion) — keep the path itself */
    }
    if (!isDir) {
      expanded.push(path);
      continue;
    }
    const prefix = `${path}/`;
    expanded.push(...Object.keys(current).filter((p) => p.startsWith(prefix)));
  }
  return expanded;
}

/**
 * Commit ONLY the given paths — never `git add -A`, which would sweep the
 * user's WIP (and rejected agent code) into a FIA commit. Paths that do not
 * exist and are not tracked are silently skipped; deletions of tracked files
 * are staged normally.
 *
 * With `baseline` (the run's pre-flight tree photo), a declared path whose
 * content is IDENTICAL to what the baseline recorded is dropped before
 * staging: it was already dirty before the run started and the run never
 * touched it — committing it would sweep another session's work into this
 * change. A pre-dirty file the run DID modify stays in: the agent owned that
 * change and the two edits cannot be split.
 *
 * Returns { sha, committed, excluded }; sha is null when nothing was staged.
 */
export function commitPaths(message, paths, cwd, { baseline } = {}) {
  const unique = [...new Set((paths || []).filter((p) => typeof p === 'string' && p.trim()).map(normalize))];
  const excluded = [];
  let candidates = unique;
  if (baseline) {
    const current = treeFingerprints(cwd);
    candidates = [];
    for (const path of [...new Set(expandDirectories(cwd, unique, current))]) {
      if (path in baseline && baseline[path] !== 'dir' && baseline[path] === fingerprint(cwd, path)) {
        excluded.push(path);
        continue;
      }
      candidates.push(path);
    }
  }
  const staged = [];
  for (const path of candidates) {
    try {
      execFileSync('git', ['add', '--', path], { cwd, stdio: 'pipe' });
      staged.push(path);
    } catch {
      /* path neither on disk nor tracked — skip */
    }
  }
  if (!staged.length) return { sha: null, committed: [], excluded };
  // "Anything to commit?" restricted to OUR paths — inspecting the whole index
  // would see the user's pre-existing staging and let it leak into the commit.
  const status = execFileSync('git', ['status', '--porcelain', '--', ...staged], { cwd, encoding: 'utf8' });
  if (!status.trim()) return { sha: null, committed: [], excluded };
  // Pathspec-limited commit: ONLY the given paths enter the commit, even when
  // the user had other files staged before the run.
  execFileSync('git', ['commit', '-m', message, '--', ...staged], { cwd, encoding: 'utf8', stdio: 'pipe' });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  return { sha, committed: staged, excluded };
}
