#!/usr/bin/env node
/**
 * Inventory the repository's AI layer without reading application secrets.
 *
 * The result is deliberately structural: it names instruction, skill and
 * enforcement files per engine, but never emits their contents.
 */
import { closeSync, existsSync, lstatSync, opendirSync, openSync, readSync, realpathSync } from 'node:fs';
import { resolve, join, relative, sep, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA_VERSION = 1;
export const ENGINES = Object.freeze(['claude', 'codex', 'cursor', 'pi', 'fia']);
export const CATEGORIES = Object.freeze(['always_loaded', 'on_demand', 'enforcement']);
export const DEFAULT_TRAVERSAL_LIMITS = Object.freeze({
  entries: 100_000,
  directories: 10_000,
  files: 75_000,
});

const slash = (value) => value.split(sep).join('/');

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function deniedDirectory(rel) {
  return (
    /(^|\/)(?:\.git|node_modules|\.next|dist|build|coverage)(?:\/|$)/.test(rel) || /(^|\/)imp\/data(?:\/|$)/.test(rel)
  );
}

function metadataOnlyFileAlias(rel) {
  return /^\.agents\/(?:agents|commands)\/.+\.md$/i.test(rel);
}

function insideNestedRepository(root, candidate) {
  let cursor = candidate;
  try {
    if (!lstatSync(cursor).isDirectory()) cursor = resolve(cursor, '..');
  } catch {
    return true;
  }
  while (inside(root, cursor) && cursor !== root) {
    if (existsSync(join(cursor, '.git'))) return true;
    const parent = resolve(cursor, '..');
    if (parent === cursor) break;
    cursor = parent;
  }
  return false;
}

function traversalLimits(overrides = {}) {
  const limits = {};
  for (const key of Object.keys(DEFAULT_TRAVERSAL_LIMITS)) {
    const value = Number(overrides[key] ?? DEFAULT_TRAVERSAL_LIMITS[key]);
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`traversal limit ${key} must be a positive integer`);
    }
    limits[key] = value;
  }
  return limits;
}

function inventoryFiles(root, overrides) {
  const limits = traversalLimits(overrides);
  const observed = { entries: 0, directories: 0, files: 0 };
  const found = [];

  const consume = (kind, location) => {
    observed[kind] += 1;
    if (observed[kind] > limits[kind]) {
      throw new Error(`AI layer traversal ${kind} limit exceeded (${limits[kind]}) at ${location || '.'}`);
    }
  };

  const visit = (dir, ancestors = new Set(), viaSymlink = false) => {
    let canonicalDir;
    try {
      canonicalDir = realpathSync(dir);
    } catch {
      return;
    }
    if (!inside(root, canonicalDir) || ancestors.has(canonicalDir)) return;
    const lexicalRel = slash(relative(root, dir));
    const canonicalRel = slash(relative(root, canonicalDir));
    if (dir !== root && (deniedDirectory(lexicalRel) || deniedDirectory(canonicalRel))) return;
    // A nested checkout is a different experimental subject. Traversing it
    // would let ignored worktrees and subrepos contaminate (and be deleted by)
    // the stripped arm.
    if (canonicalDir !== root && insideNestedRepository(root, canonicalDir)) return;
    consume('directories', lexicalRel);
    const nextAncestors = new Set(ancestors).add(canonicalDir);
    const entries = [];
    const handle = opendirSync(dir, { bufferSize: 1 });
    try {
      let entry;
      while ((entry = handle.readSync()) !== null) {
        const rel = slash(relative(root, join(dir, entry.name)));
        // Apply the cap before retaining another Dirent in memory.
        consume('entries', rel);
        entries.push(entry);
      }
    } finally {
      handle.closeSync();
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      const rel = slash(relative(root, absolute));
      if (entry.isSymbolicLink()) {
        let canonicalTarget;
        try {
          canonicalTarget = realpathSync(absolute);
        } catch {
          continue;
        }
        // External aliases are never read. Internal directory aliases are
        // inventory-only; file aliases are accepted metadata-only solely on
        // the two shared `.agents` surfaces below. Canonical denylist and
        // nested-repository boundaries apply even for descendant jumps.
        if (!inside(root, canonicalTarget)) continue;
        const canonicalRel = slash(relative(root, canonicalTarget));
        if (deniedDirectory(canonicalRel) || insideNestedRepository(root, canonicalTarget)) continue;
        const targetStat = lstatSync(canonicalTarget);
        if (targetStat.isDirectory()) visit(absolute, nextAncestors, true);
        else if (targetStat.isFile() && metadataOnlyFileAlias(rel)) {
          consume('files', rel);
          found.push({
            absolute,
            path: rel,
            canonicalPath: canonicalRel,
            viaSymlink: true,
          });
        }
        continue;
      }
      if (entry.isDirectory()) visit(absolute, nextAncestors, viaSymlink);
      else if (entry.isFile()) {
        consume('files', rel);
        const canonical = realpathSync(absolute);
        if (!inside(root, canonical)) continue;
        found.push({
          absolute,
          path: rel,
          canonicalPath: slash(relative(root, canonical)),
          viaSymlink,
        });
      }
    }
  };
  visit(root);
  return { files: found, limits, observed };
}

function readHead(file, maxBytes = 4096) {
  const handle = openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const bytesRead = readSync(handle, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    closeSync(handle);
  }
}

function cursorRuleCategory(file) {
  try {
    const head = readHead(file);
    return /(?:^|\n)alwaysApply:\s*true\s*(?:\n|$)/i.test(head) ? 'always_loaded' : 'on_demand';
  } catch {
    return 'on_demand';
  }
}

function claudeRuleCategory(file) {
  try {
    const head = readHead(file).replace(/^\uFEFF/, '');
    if (!/^---[ \t]*\r?\n/.test(head)) return 'always_loaded';
    const frontmatter = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(head);
    // An incomplete or malformed header is not proven global, so keep it out
    // of the destructive arm.
    if (!frontmatter) return 'on_demand';
    return /^[ \t]*paths[ \t]*:/m.test(frontmatter[1]) ? 'on_demand' : 'always_loaded';
  } catch {
    return 'on_demand';
  }
}

function emptyEngine() {
  return { always_loaded: [], on_demand: [], enforcement: [] };
}

/** Return a stable, per-engine structural inventory for `root`. */
export function mapAiLayer(root = process.cwd(), options = {}) {
  const projectRoot = realpathSync(resolve(root));
  const traversal = inventoryFiles(projectRoot, options.traversalLimits);
  const engines = Object.fromEntries(ENGINES.map((engine) => [engine, emptyEngine()]));
  const seen = new Map(ENGINES.map((engine) => [engine, new Set()]));
  const inventoryByPath = new Map(traversal.files.map((file) => [file.absolute, file]));

  const filesUnder = (relDir, predicate = () => true) => {
    const prefix = relDir === '.' ? '' : `${relDir.replace(/\/$/, '')}/`;
    return traversal.files
      .filter((file) => (!prefix || file.path.startsWith(prefix)) && predicate(file.absolute))
      .map((file) => file.absolute);
  };

  const add = (engine, category, absolute, reason) => {
    if (!existsSync(absolute) || !inside(projectRoot, absolute)) return;
    const stat = lstatSync(absolute);
    const inventoryFile = inventoryByPath.get(absolute);
    if (stat.isSymbolicLink() && !inventoryFile?.viaSymlink) return;
    let canonical;
    try {
      canonical = realpathSync(absolute);
    } catch {
      canonical = absolute;
    }
    if (!inside(projectRoot, canonical)) return;
    const key = `${category}:${canonical}`;
    if (seen.get(engine).has(key)) return;
    seen.get(engine).add(key);
    engines[engine][category].push({
      path: slash(relative(projectRoot, absolute)),
      canonical_path: inventoryFile?.canonicalPath ?? slash(relative(projectRoot, canonical)),
      via_symlink: Boolean(inventoryFile?.viaSymlink),
      reason,
      symlink: stat.isSymbolicLink(),
    });
  };

  // Always-loaded instruction surfaces.
  for (const file of filesUnder('.', (path) => basename(path) === 'CLAUDE.md')) {
    const rel = slash(relative(projectRoot, file));
    const global = rel === 'CLAUDE.md' || rel === '.claude/CLAUDE.md';
    add(
      'claude',
      global ? 'always_loaded' : 'on_demand',
      file,
      global ? 'Claude project instructions' : 'Claude path-scoped project instructions',
    );
  }
  for (const file of filesUnder('.claude/rules', (p) => /\.md$/i.test(p))) {
    const category = claudeRuleCategory(file);
    add(
      'claude',
      category,
      file,
      category === 'always_loaded' ? 'Claude global project rule' : 'Claude conditional project rule',
    );
  }
  for (const file of filesUnder('.', (path) => basename(path) === 'AGENTS.md')) {
    const scoped = relative(projectRoot, file) !== 'AGENTS.md';
    add(
      'codex',
      scoped ? 'on_demand' : 'always_loaded',
      file,
      scoped ? 'Codex path-scoped project instructions' : 'Codex root project instructions',
    );
  }
  add('cursor', 'always_loaded', join(projectRoot, '.cursorrules'), 'Cursor project instructions');
  for (const file of filesUnder('.cursor/rules', (p) => /\.mdc$/i.test(p))) {
    add('cursor', cursorRuleCategory(file), file, 'Cursor rule');
  }
  add('pi', 'always_loaded', join(projectRoot, '.pi/APPEND_SYSTEM.md'), 'Pi appended system instructions');

  // On-demand workflows, agents and shared skills.
  const skillFiles = filesUnder('.agents/skills', (p) => /[/\\]SKILL\.md$/i.test(p));
  for (const file of skillFiles) {
    for (const engine of ['codex', 'cursor', 'pi']) add(engine, 'on_demand', file, 'Shared agent skill');
  }
  for (const [dir, reason] of [
    ['.agents/agents', 'Shared agent definition'],
    ['.agents/commands', 'Shared slash command'],
  ]) {
    for (const file of filesUnder(dir, (p) => /\.md$/i.test(p))) {
      // Local runtime contracts expose these two shared surfaces to Cursor
      // and Pi. Codex is intentionally omitted without an equivalent local
      // discoverability contract.
      for (const engine of ['cursor', 'pi']) add(engine, 'on_demand', file, reason);
    }
  }
  for (const file of filesUnder('.claude/skills', (p) => /[/\\]SKILL\.md$/i.test(p))) {
    add('claude', 'on_demand', file, 'Claude skill');
  }
  for (const file of filesUnder('.claude/commands', (p) => /\.md$/i.test(p))) {
    add('claude', 'on_demand', file, 'Claude slash command');
  }
  for (const file of filesUnder('.cursor/commands', (p) => /\.md$/i.test(p))) {
    add('cursor', 'on_demand', file, 'Cursor command');
  }
  for (const file of filesUnder('.pi/prompts', (p) => /\.md$/i.test(p))) {
    add('pi', 'on_demand', file, 'Pi slash prompt');
  }
  for (const file of filesUnder('.pi/skills', (p) => /[/\\]SKILL\.md$/i.test(p))) {
    add('pi', 'on_demand', file, 'Pi runtime skill');
  }
  for (const [engine, dir] of [
    ['claude', '.claude/agents'],
    ['cursor', '.cursor/agents'],
    ['pi', '.pi/agents'],
  ]) {
    for (const file of filesUnder(dir, (p) => /\.md$/i.test(p))) {
      add(engine, 'on_demand', file, `${engine} agent definition`);
    }
  }

  // Enforcement is inventoried but is never eligible for ablation.
  for (const name of ['.claude/settings.json', '.claude/settings.local.json']) {
    add('claude', 'enforcement', join(projectRoot, name), 'Claude hooks and permissions');
  }
  for (const file of filesUnder('.claude/hooks')) {
    add('claude', 'enforcement', file, 'Claude hook');
  }
  add('cursor', 'enforcement', join(projectRoot, '.cursor/hooks.json'), 'Cursor hooks');
  for (const file of filesUnder('.pi/extensions')) {
    add('pi', 'enforcement', file, 'Pi runtime extension');
  }
  for (const name of [
    'imp/fia.config.yaml',
    'imp/modules/gates.mjs',
    'imp/modules/permissions.mjs',
    'imp/modules/quality.mjs',
    'imp/modules/stop.mjs',
  ]) {
    add('fia', 'enforcement', join(projectRoot, name), 'FIA deterministic enforcement');
  }

  for (const engine of ENGINES) {
    for (const category of CATEGORIES) {
      engines[engine][category].sort((a, b) => a.path.localeCompare(b.path));
    }
  }

  const totals = Object.fromEntries(
    ENGINES.map((engine) => [
      engine,
      Object.fromEntries(CATEGORIES.map((category) => [category, engines[engine][category].length])),
    ]),
  );
  return {
    schema_version: SCHEMA_VERSION,
    root: projectRoot,
    traversal: { limits: traversal.limits, observed: traversal.observed },
    engines,
    totals,
  };
}

export function renderAiLayerMap(report) {
  const lines = [`AI layer map — ${report.root}`, ''];
  for (const engine of ENGINES) {
    lines.push(`${engine}:`);
    for (const category of CATEGORIES) {
      const files = report.engines[engine][category];
      lines.push(`  ${category.replaceAll('_', '-')}: ${files.length}`);
      for (const file of files) lines.push(`    - ${file.path} — ${file.reason}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const opts = { dir: process.cwd(), json: false, traversalLimits: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dir') opts.dir = argv[++i];
    else if (arg === '--json') opts.json = true;
    else if (arg === '--max-entries' || arg === '--max-dirs' || arg === '--max-files') {
      const value = argv[++i];
      if (value == null) throw new Error(`${arg} requires a value`);
      const key = arg === '--max-entries' ? 'entries' : arg === '--max-dirs' ? 'directories' : 'files';
      opts.traversalLimits[key] = value;
    } else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.dir) throw new Error('--dir requires a path');
  return opts;
}

function usage() {
  return [
    'Usage: node scripts/ai-layer-map.mjs [--dir <repo>] [--json]',
    '  [--max-entries <n>] [--max-dirs <n>] [--max-files <n>]',
    '',
  ].join('\n');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) process.stdout.write(usage());
    else {
      const report = mapAiLayer(opts.dir, { traversalLimits: opts.traversalLimits });
      process.stdout.write(opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderAiLayerMap(report));
    }
  } catch (error) {
    process.stderr.write(`ai-layer-map: ${error.message}\n${usage()}`);
    process.exitCode = 1;
  }
}
