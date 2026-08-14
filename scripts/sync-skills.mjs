#!/usr/bin/env node
// Deterministic mirror: harness/.claude/skills → harness/.cursor/skills.
//
// The shared skills MUST be byte-identical in the two trees
// (test/consistency.test.js guards it); keeping them in sync by hand is
// exactly the class of duplicated-information error that has bitten before.
// Editing rule: harness/.claude/skills is the ONLY side a human or agent
// edits — this script regenerates each .cursor twin. Cursor-only skills
// (project-workflow, workflow-*) exist only in .cursor and are never touched.
//
//   node scripts/sync-skills.mjs          # write: mirror .claude → .cursor
//   node scripts/sync-skills.mjs --check  # verify only; exit 1 on drift
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'harness', '.claude', 'skills');
const DST = join(ROOT, 'harness', '.cursor', 'skills');
const check = process.argv.includes('--check');

if (!existsSync(SRC)) {
  console.log('harness/ not present (nested repo, absent on fresh checkout) — nothing to sync');
  process.exit(0);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry);
    const s = statSync(p, { throwIfNoEntry: false });
    if (!s) continue; // dangling symlink
    if (s.isDirectory()) walk(p, out);
    else if (entry !== '.gitkeep') out.push(p);
  }
  return out;
}

const copied = [];
const removed = [];
let unchanged = 0;

// Forward pass: every .claude file exists byte-identical in .cursor.
for (const file of walk(SRC)) {
  const rel = relative(SRC, file);
  const twin = join(DST, rel);
  if (existsSync(twin) && readFileSync(file).equals(readFileSync(twin))) {
    unchanged++;
    continue;
  }
  copied.push(rel);
  if (!check) {
    mkdirSync(dirname(twin), { recursive: true });
    copyFileSync(file, twin);
  }
}

// Reverse pass: inside SHARED skill dirs only, a .cursor file with no
// .claude counterpart is a leftover from a rename/delete — remove it.
// Cursor-only skill dirs (no .claude counterpart) are left alone.
const sharedSkills = readdirSync(SRC).filter((n) => statSync(join(SRC, n)).isDirectory());
for (const skill of sharedSkills) {
  const dstSkill = join(DST, skill);
  if (!existsSync(dstSkill)) continue; // forward pass created it (or will)
  for (const file of walk(dstSkill)) {
    const rel = relative(DST, file);
    if (!existsSync(join(SRC, rel))) {
      removed.push(rel);
      if (!check) rmSync(file);
    }
  }
}

const drift = copied.length + removed.length;
const verb = check ? 'would sync' : 'synced';
if (drift === 0) {
  console.log(`in sync — ${unchanged} files identical`);
} else {
  for (const rel of copied) console.log(`${check ? 'drift' : 'copied'}: ${rel}`);
  for (const rel of removed) console.log(`${check ? 'orphan' : 'removed'}: ${rel}`);
  console.log(`${verb}: ${copied.length} copied, ${removed.length} removed, ${unchanged} unchanged`);
}
process.exit(check && drift > 0 ? 1 : 0);
