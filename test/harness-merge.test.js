import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mergeSkips, ownedPathsToDiscard } from '../src/steps/harness.js';
import { HARNESS } from '../src/config.js';

const SKILLS = ['frontend-profissional', 'design-system', 'security', 'backend-profissional'];

function tmpProject() {
  return mkdtempSync(join(tmpdir(), 'harness-merge-'));
}

test('template without .cursor/: no .cursor/skills/* path is discarded', () => {
  const dest = tmpProject();
  // Template shipped only the Claude side of the four skills.
  for (const skill of SKILLS) {
    mkdirSync(join(dest, '.claude', 'skills', skill), { recursive: true });
  }
  const discard = ownedPathsToDiscard(HARNESS.templateOwnedPaths, dest);
  assert.deepEqual(
    discard.sort(),
    SKILLS.map((s) => `.claude/skills/${s}`).sort(),
  );
  assert.ok(!discard.some((rel) => rel.startsWith('.cursor/')), 'harness must still cover Cursor');
});

test('template with only .claude/skills/security: only that path is discarded', () => {
  const dest = tmpProject();
  mkdirSync(join(dest, '.claude', 'skills', 'security'), { recursive: true });
  assert.deepEqual(ownedPathsToDiscard(HARNESS.templateOwnedPaths, dest), ['.claude/skills/security']);
});

test('template with all shared paths: the 8 are discarded', () => {
  const dest = tmpProject();
  for (const rel of HARNESS.templateOwnedPaths) {
    mkdirSync(join(dest, rel), { recursive: true });
  }
  const discard = ownedPathsToDiscard(HARNESS.templateOwnedPaths, dest);
  assert.equal(discard.length, 8);
  assert.deepEqual(discard.sort(), [...HARNESS.templateOwnedPaths].sort());
});

test('nonexistent destDir: nothing is discarded', () => {
  const dest = join(tmpProject(), 'does-not-exist');
  assert.deepEqual(ownedPathsToDiscard(HARNESS.templateOwnedPaths, dest), []);
});

test('empty/undefined templateOwnedPaths: nothing is discarded', () => {
  const dest = tmpProject();
  assert.deepEqual(ownedPathsToDiscard(undefined, dest), []);
  assert.deepEqual(ownedPathsToDiscard([], dest), []);
});

// ── mergeSkips — which collisions the force:false merge keeps ────────────────

/** Writes `files` (rel paths, forward slashes) as empty files under `root`. */
function seed(root, files) {
  for (const rel of files) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), '');
  }
  return root;
}

test('mergeSkips: empty destination — nothing is skipped', () => {
  const src = seed(tmpProject(), ['.claude/commands/dev.md', 'imp/HARNESS.md']);
  assert.deepEqual(mergeSkips(src, tmpProject()), []);
});

test('mergeSkips: only real file collisions are listed, sorted; shared dirs are not', () => {
  const src = seed(tmpProject(), [
    '.claude/commands/dev.md',
    '.claude/commands/start.md',
    '.cursor/rules/tdd.mdc',
    'imp/HARNESS.md',
  ]);
  const dest = seed(tmpProject(), [
    '.claude/commands/dev.md', // collision — the project's version wins
    '.claude/commands/mine.md', // project-only ⇒ irrelevant
    'imp/HARNESS.md', // collision
  ]);
  assert.deepEqual(mergeSkips(src, dest), ['.claude/commands/dev.md', 'imp/HARNESS.md']);
});

test('mergeSkips: dest dir exists but is empty — merged, not a skip', () => {
  const src = seed(tmpProject(), ['.claude/skills/tdd/SKILL.md']);
  const dest = tmpProject();
  mkdirSync(join(dest, '.claude', 'skills'), { recursive: true });
  assert.deepEqual(mergeSkips(src, dest), []);
});

test('mergeSkips: symlinks collide as files, and a broken dest symlink counts as existing', () => {
  const src = seed(tmpProject(), ['.claude/agents/reviewer.md']);
  mkdirSync(join(src, '.agents'), { recursive: true });
  symlinkSync(join('..', '.claude', 'agents'), join(src, '.agents', 'agents')); // dir symlink: leaf, never recursed
  const dest = tmpProject();
  mkdirSync(join(dest, '.agents'), { recursive: true });
  symlinkSync(join(dest, 'does-not-exist'), join(dest, '.agents', 'agents')); // broken on purpose
  assert.deepEqual(mergeSkips(src, dest), ['.agents/agents']);
});

test('mergeSkips: src dir vs dest file — listed once, subtree not recursed', () => {
  const src = seed(tmpProject(), ['.claude/commands/dev.md']);
  const dest = tmpProject();
  writeFileSync(join(dest, '.claude'), ''); // a FILE where the harness has a folder
  assert.deepEqual(mergeSkips(src, dest), ['.claude']);
});

test('injectable exists: decision is pure and follows the predicate', () => {
  const seen = [];
  const exists = (p) => {
    seen.push(p);
    return p.endsWith(join('.cursor', 'skills', 'design-system'));
  };
  const discard = ownedPathsToDiscard(HARNESS.templateOwnedPaths, '/virtual/project', exists);
  assert.deepEqual(discard, ['.cursor/skills/design-system']);
  assert.equal(seen.length, HARNESS.templateOwnedPaths.length);
});
