#!/usr/bin/env node
// Deterministic mirror: harness/.claude/commands → harness/.cursor/commands.
//
// The shared command BODIES live in .claude/commands/; Cursor twins are GENERATED
// with frontmatter + patchlets from scripts/command-overlays.yaml (test/sync-commands.test.js
// guards drift). Editing rule: harness/.claude/commands is the ONLY side a human or
// agent edits for command content — this script regenerates each .cursor twin.
//
//   node scripts/sync-commands.mjs          # write: mirror .claude → .cursor
//   node scripts/sync-commands.mjs --check  # verify only; exit 1 on drift
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'harness', '.claude', 'commands');
const DST = join(ROOT, 'harness', '.cursor', 'commands');
const OVERLAYS_PATH = join(ROOT, 'scripts', 'command-overlays.yaml');
const check = process.argv.includes('--check');

if (!existsSync(SRC)) {
  console.log('harness/ not present (nested repo, absent on fresh checkout) — nothing to sync');
  process.exit(0);
}

const overlaysDoc = parseYaml(readFileSync(OVERLAYS_PATH, 'utf8'));
const { globalReplace = [], commands: commandOverlays = {} } = overlaysDoc;

function splitFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { frontmatter: null, body: text };
  return { frontmatter: m[1], body: text.slice(m[0].length) };
}

function parseFrontmatterMap(raw) {
  if (!raw) return new Map();
  const map = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    map.set(key, value);
  }
  return map;
}

function applyReplacements(text, replacements, { optional = false } = {}) {
  let out = text;
  for (const { from, to } of replacements) {
    if (!out.includes(from)) {
      if (optional) continue;
      throw new Error(`replacement miss — substring not found:\n${from.slice(0, 120)}…`);
    }
    out = out.replaceAll(from, to);
  }
  return out;
}

function buildCursorFrontmatter(name, claudeFm, overlay) {
  const merged = overlay.mergeFrontmatter && claudeFm ? new Map(claudeFm) : new Map();
  merged.set('name', name);
  merged.set('description', overlay.description ?? merged.get('description') ?? `Workflow command /${name} — see AGENTS.md`);
  // Stable key order: name, description, then the rest alphabetically.
  const rest = [...merged.keys()].filter((k) => k !== 'name' && k !== 'description').sort();
  const lines = ['---', `name: ${merged.get('name')}`, `description: ${merged.get('description')}`];
  for (const key of rest) lines.push(`${key}: ${merged.get(key)}`);
  lines.push('---', '');
  return lines.join('\n');
}

function renderCommand(name) {
  const overlay = commandOverlays[name];
  if (!overlay?.description && !overlay?.mergeFrontmatter) {
    throw new Error(`command-overlays.yaml missing entry (or description) for "${name}"`);
  }
  const srcPath = join(SRC, `${name}.md`);
  const { frontmatter: claudeFmRaw, body: rawBody } = splitFrontmatter(readFileSync(srcPath, 'utf8'));
  const claudeFm = parseFrontmatterMap(claudeFmRaw);

  let body = rawBody;
  if (overlay.replace?.length) body = applyReplacements(body, overlay.replace);
  body = applyReplacements(body, globalReplace, { optional: true });
  if (overlay.append) body += overlay.append;

  const header = buildCursorFrontmatter(name, claudeFm, overlay);
  return header + body.replace(/^\n/, '');
}

const srcFiles = readdirSync(SRC)
  .filter((f) => f.endsWith('.md'))
  .sort();
const copied = [];
const removed = [];
let unchanged = 0;

for (const file of srcFiles) {
  const name = basename(file, '.md');
  const rendered = renderCommand(name);
  const twin = join(DST, `${name}.md`);
  if (existsSync(twin) && readFileSync(twin, 'utf8') === rendered) {
    unchanged++;
    continue;
  }
  copied.push(`${name}.md`);
  if (!check) {
    mkdirSync(DST, { recursive: true });
    writeFileSync(twin, rendered);
  }
}

// Orphans: a .cursor command with no .claude counterpart is a leftover rename/delete.
for (const file of readdirSync(DST).filter((f) => f.endsWith('.md')).sort()) {
  if (!existsSync(join(SRC, file))) {
    removed.push(file);
    if (!check) rmSync(join(DST, file));
  }
}

// Overlay keys must match source files (no stale config).
const overlayKeys = Object.keys(commandOverlays).sort();
const srcNames = srcFiles.map((f) => basename(f, '.md')).sort();
const missingOverlay = srcNames.filter((n) => !commandOverlays[n]);
const staleOverlay = overlayKeys.filter((n) => !srcNames.includes(n));
if (missingOverlay.length || staleOverlay.length) {
  console.error('command-overlays.yaml out of sync with harness/.claude/commands/:');
  if (missingOverlay.length) console.error(`  missing overlays: ${missingOverlay.join(', ')}`);
  if (staleOverlay.length) console.error(`  stale overlays: ${staleOverlay.join(', ')}`);
  process.exit(1);
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
