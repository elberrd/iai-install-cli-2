// The run baseline: a pre-flight photo of the working tree that keeps
// pre-existing dirt (docs and WIP another session left behind) OUT of FIA
// commits — the registry.md/stack.md contamination case — while everything
// the run itself touched still gets committed, foundation scaffolds included.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  treeFingerprints,
  loadOrCreateBaseline,
  runChangedPaths,
  commitPaths,
} from '../fia-templates/modules/git-helper.mjs';

const DOCS_COMMIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fia-templates', 'scripts', 'docs-commit.mjs');

function initGitRepo(root) {
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'fia@test.dev'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'FIA Test'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, 'README.md'), '# test\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' });
}

function commitFile(root, rel, content, message = `add ${rel}`) {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), content);
  execFileSync('git', ['add', rel], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', message], { cwd: root, stdio: 'ignore' });
}

function lastCommitFiles(root) {
  return execFileSync('git', ['show', '--name-only', '--format='], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .sort();
}

test('treeFingerprints: dirty tracked, untracked and deleted paths, clean tree empty', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-base-'));
  initGitRepo(root);
  assert.deepEqual(treeFingerprints(root), {});
  commitFile(root, 'stack.md', 'v1\n');
  writeFileSync(join(root, 'stack.md'), 'v2\n'); // tracked, modified
  mkdirSync(join(root, 'ai-docs'), { recursive: true });
  writeFileSync(join(root, 'ai-docs', 'registry.md'), 'rows\n'); // untracked (inside untracked dir)
  rmSync(join(root, 'README.md')); // tracked, deleted
  const map = treeFingerprints(root);
  assert.ok(map['stack.md']);
  assert.ok(map['ai-docs/registry.md'], 'untracked files inside untracked dirs are listed individually');
  assert.equal(map['README.md'], 'deleted');
});

test('commitPaths with baseline: pre-existing dirt is excluded, run work is committed', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-base-'));
  initGitRepo(root);
  commitFile(root, 'stack.md', 'v1\n');
  // Pre-run dirt: an untracked doc and a modified tracked doc (another session's leftovers).
  mkdirSync(join(root, 'ai-docs'), { recursive: true });
  writeFileSync(join(root, 'ai-docs', 'registry.md'), 'rows\n');
  writeFileSync(join(root, 'stack.md'), 'v2 dirty\n');
  const baseline = treeFingerprints(root);
  // The run creates one file and never touches the dirt — but the builder
  // declares everything it saw in git status (the contamination bug).
  writeFileSync(join(root, 'globals.css'), ':root{}\n');
  const { sha, committed, excluded } = commitPaths(
    'feat: promote theme',
    ['ai-docs/registry.md', 'stack.md', 'globals.css'],
    root,
    { baseline },
  );
  assert.ok(sha);
  assert.deepEqual(committed, ['globals.css']);
  assert.deepEqual(excluded.sort(), ['ai-docs/registry.md', 'stack.md']);
  assert.deepEqual(lastCommitFiles(root), ['globals.css']);
  // The dirt is still in the tree, untouched — not lost, just not swept.
  assert.equal(readFileSync(join(root, 'ai-docs', 'registry.md'), 'utf8'), 'rows\n');
});

test('commitPaths with baseline: a pre-dirty file the run DID modify stays in the commit', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-base-'));
  initGitRepo(root);
  commitFile(root, 'globals.css', 'old\n');
  writeFileSync(join(root, 'globals.css'), 'pre-run edit\n'); // dirty before the run
  const baseline = treeFingerprints(root);
  writeFileSync(join(root, 'globals.css'), 'run rewrote it\n'); // the run owns this change
  const { committed, excluded } = commitPaths('feat: theme', ['globals.css'], root, { baseline });
  assert.deepEqual(committed, ['globals.css']);
  assert.deepEqual(excluded, []);
});

test('commitPaths with baseline: run deletions are committed, pre-existing deletions excluded', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-base-'));
  initGitRepo(root);
  commitFile(root, 'preview.tsx', 'route\n');
  commitFile(root, 'old.txt', 'gone before the run\n');
  rmSync(join(root, 'old.txt')); // deleted BEFORE the baseline
  const baseline = treeFingerprints(root);
  rmSync(join(root, 'preview.tsx')); // deleted BY the run
  const { committed, excluded } = commitPaths('chore: remove preview', ['preview.tsx', 'old.txt'], root, { baseline });
  assert.deepEqual(committed, ['preview.tsx']);
  assert.deepEqual(excluded, ['old.txt']);
  assert.equal(existsSync(join(root, 'old.txt')), false, 'the pre-existing deletion is left as-is in the tree');
});

test('commitPaths with baseline: a declared DIRECTORY is expanded and filtered per file', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-base-'));
  initGitRepo(root);
  mkdirSync(join(root, 'app'), { recursive: true });
  writeFileSync(join(root, 'app', 'leftover.ts'), 'another session\n'); // pre-run dirt inside the dir
  const baseline = treeFingerprints(root);
  writeFileSync(join(root, 'app', 'page.tsx'), 'run work\n');
  const { committed, excluded } = commitPaths('feat: page', ['app/'], root, { baseline });
  assert.deepEqual(committed, ['app/page.tsx']);
  assert.deepEqual(excluded, ['app/leftover.ts']);
});

test('commitPaths without baseline keeps the legacy behavior (everything declared, pathspec-limited)', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-base-'));
  initGitRepo(root);
  writeFileSync(join(root, 'a.txt'), 'a\n');
  writeFileSync(join(root, 'wip.txt'), 'user wip\n'); // dirty but NOT declared
  const { sha, committed } = commitPaths('feat: a', ['a.txt', 'missing.txt'], root);
  assert.ok(sha);
  assert.deepEqual(committed, ['a.txt']);
  assert.deepEqual(lastCommitFiles(root), ['a.txt'], 'undeclared WIP never enters the commit');
});

test('runChangedPaths: only what the run touched — the foundation widening source', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-base-'));
  initGitRepo(root);
  mkdirSync(join(root, 'ai-docs'), { recursive: true });
  writeFileSync(join(root, 'ai-docs', 'PRD.md'), 'pre-run doc\n');
  const baseline = treeFingerprints(root);
  // The "scaffold": many files no envelope enumerates.
  mkdirSync(join(root, 'app'), { recursive: true });
  writeFileSync(join(root, 'app', 'layout.tsx'), 'x\n');
  writeFileSync(join(root, 'app', 'page.tsx'), 'y\n');
  writeFileSync(join(root, 'package.json'), '{}\n');
  assert.deepEqual(runChangedPaths(root, baseline), ['app/layout.tsx', 'app/page.tsx', 'package.json']);
});

test('loadOrCreateBaseline: taken once, reloaded verbatim on resume', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-base-'));
  initGitRepo(root);
  const sessionDir = mkdtempSync(join(tmpdir(), 'fia-sess-'));
  writeFileSync(join(root, 'dirty.txt'), 'before\n');
  const first = loadOrCreateBaseline(sessionDir, root);
  assert.ok(first['dirty.txt']);
  // The tree changes (the run worked); a resume must NOT retake the photo —
  // retaking would make the run's own work look pre-existing.
  writeFileSync(join(root, 'run-work.txt'), 'work\n');
  const reloaded = loadOrCreateBaseline(sessionDir, root);
  assert.deepEqual(reloaded, first);
  assert.equal(reloaded['run-work.txt'], undefined);
});

// ── docs-commit.mjs — the deterministic docs committer ──────────────────────

function runDocsCommit(root, args) {
  return execFileSync(process.execPath, [DOCS_COMMIT, '--dir', root, ...args], { encoding: 'utf8' });
}

test('docs-commit: commits ai-docs paths, idempotent when clean', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-docs-'));
  initGitRepo(root);
  mkdirSync(join(root, 'ai-docs'), { recursive: true });
  writeFileSync(join(root, 'ai-docs', 'stack.md'), 'manifest\n');
  writeFileSync(join(root, 'code.ts'), 'not docs\n'); // must stay out
  const out = runDocsCommit(root, ['--message', 'docs(stack): decide backend', '--json']);
  const { sha, committed } = JSON.parse(out);
  assert.ok(sha);
  assert.deepEqual(committed, ['ai-docs']);
  assert.deepEqual(lastCommitFiles(root), ['ai-docs/stack.md']);
  const again = runDocsCommit(root, ['--message', 'docs: again']);
  assert.match(again, /nothing to commit/);
});

test('docs-commit: refuses paths outside ai-docs/ (escapes included)', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-docs-'));
  initGitRepo(root);
  for (const bad of ['src/app.ts', 'ai-docs/../secret.env']) {
    assert.throws(
      () => runDocsCommit(root, ['--message', 'docs: smuggle', bad]),
      /only commits ai-docs/,
      `must refuse ${bad}`,
    );
  }
});

test('docs-commit: refuses while a FIA run is active, allows a stale lock', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-docs-'));
  initGitRepo(root);
  mkdirSync(join(root, 'ai-docs'), { recursive: true });
  writeFileSync(join(root, 'ai-docs', 'x.md'), 'doc\n');
  mkdirSync(join(root, 'imp', 'data'), { recursive: true });
  const lockPath = join(root, 'imp', 'data', '.fda.lock');
  // Live pid (this very test process) → refuse.
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, fda_id: 'abc123' }));
  assert.throws(() => runDocsCommit(root, ['--message', 'docs: x']), /FIA run is active/);
  // Stale pid → proceed.
  writeFileSync(lockPath, JSON.stringify({ pid: 999999999, fda_id: 'dead' }));
  const out = runDocsCommit(root, ['--message', 'docs: x']);
  assert.match(out, /docs: x/);
});
