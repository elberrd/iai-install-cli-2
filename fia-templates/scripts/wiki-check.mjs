#!/usr/bin/env node
/**
 * Wiki freshness checker — deterministic, READ-ONLY report over ai-docs/wiki/.
 *
 * /absorb produces a one-shot as-built snapshot of an existing codebase and
 * nothing keeps it true afterwards. The maintained wiki fixes that: every page
 * declares, in its frontmatter, WHICH source paths it describes plus the sha1
 * digest of those paths at the moment it was written. This script recomputes
 * the digest and reports which pages drifted — zero tokens, no LLM, no git.
 * Agents then read a fresh page instead of re-grepping the repo, which is the
 * whole point: it spends disk instead of the student's subscription.
 *
 * A page looks like:
 *
 *   ---
 *   updated: 2026-08-17
 *   sources: src/auth, src/lib/session.ts
 *   digest: 4f2c…
 *   ---
 *   # Authentication
 *   <!-- human:start -->hand-written note a regenerator must keep<!-- human:end -->
 *
 * Never throws: a missing wiki, an unreadable page, a malformed plan file or a
 * deleted source all degrade into a status, never a crash.
 *
 * Usage:  node imp/scripts/wiki-check.mjs [--dir <root>] [--json] [--strict]
 *         node imp/scripts/wiki-check.mjs --stamp [--dir <root>] [--json]
 *         --strict exits 1 when a page is stale OR declares source paths that
 *         no longer exist in the repo (CI-friendly).
 *         --stamp is the ONE writing mode: it re-records the `digest:` of the
 *         pages it just found stale, touching nothing but that frontmatter line
 *         (so every <!-- human --> block is safe by construction). Whoever
 *         rewrites a page's prose runs it afterwards to close the loop —
 *         computing the rolling sha1 by hand is not a thing an agent can do.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { now, parseFrontmatter } from './decision-log.mjs';
import { activeFdaLock } from './fda-lock.mjs';

export const WIKI_DIR = join('ai-docs', 'wiki');
export const PLAN_FILE = 'wiki-plan.yaml';

const MAX_DEPTH = 8; // a declared directory is hashed 8 levels deep, no more
const MAX_FILES = 2000; // …and 2000 files per digest, so the gate stays cheap
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.next', '_generated']);
const PRESETS = ['architecture', 'product'];
const DETAIL_CAP = 5; // same list formatting as fia-launch-check: 5 then (+N)

/** Report paths with forward slashes, so a finding reads the same on Windows. */
const slash = (p) => String(p).replaceAll('\\', '/');

const WIKI_DIR_POSIX = slash(WIKI_DIR);

// ── small pure helpers ───────────────────────────────────────────────────────

/**
 * Containment check without a real root: a declared source is repo-relative by
 * contract, so `../x`, `a/../../b` and any absolute path escape and are
 * dropped — the same resolve-then-relative test as invalidDocsPaths(), only
 * against a sentinel root (parseWikiPage sees the page text, never the root).
 */
const SENTINEL = resolve('/', '__fia_wiki_root__');

/** Normalise one declared source → repo-relative posix path (null when unusable). */
export function normalizeSourcePath(value) {
  const raw = String(value ?? '')
    .trim()
    .replace(/^["'[]+|["'\]]+$/g, '')
    .trim();
  if (!raw) return null;
  const cleaned = slash(raw).replace(/\/+$/, '');
  if (!cleaned || cleaned === '.') return null;
  const abs = isAbsolute(cleaned) ? resolve(cleaned) : resolve(SENTINEL, cleaned);
  const rel = relative(SENTINEL, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return slash(rel);
}

/** `sources:` as a comma list AND/OR as a YAML block list right below the key. */
function collectSources(block, fields) {
  const values = [];
  const inline = fields.sources ?? '';
  if (inline) values.push(...inline.split(','));
  const lines = block.split('\n');
  const ix = lines.findIndex((l) => /^sources:\s*/.test(l));
  if (ix !== -1) {
    for (let i = ix + 1; i < lines.length; i += 1) {
      const m = /^\s*-\s+(.*)$/.exec(lines[i]);
      if (!m) break; // the block list ends at the first line that is not an item
      values.push(m[1]);
    }
  }
  const out = new Set();
  for (const v of values) {
    const n = normalizeSourcePath(v);
    if (n) out.add(n);
  }
  return [...out].sort();
}

/** Count `<!-- human:start -->…<!-- human:end -->` regions (never overwrite those). */
function countHumanBlocks(text) {
  return (String(text).match(/<!--\s*human:start\s*-->[\s\S]*?<!--\s*human:end\s*-->/g) || []).length;
}

/**
 * Parse a wiki page. Only the FIRST `--- … ---` block is frontmatter, so a
 * `sources:`/`digest:` line or a `---` rule inside the prose is content and is
 * ignored. Returns null when the page has no frontmatter at all.
 */
export function parseWikiPage(text) {
  const content = String(text ?? '').replaceAll('\r\n', '\n');
  const fm = parseFrontmatter(content);
  if (!fm) return null;
  const block = content.slice(0, fm.bodyStart);
  const body = content.slice(fm.bodyStart);
  return {
    fields: fm.fields,
    sources: collectSources(block, fm.fields),
    digest: fm.fields.digest ? fm.fields.digest.trim() : null,
    humanBlocks: countHumanBlocks(content),
    hasBody: body.trim().length > 0,
  };
}

// ── the digest ───────────────────────────────────────────────────────────────

function walk(dir, acc, depth, state) {
  if (depth > MAX_DEPTH) {
    state.truncated = true;
    return;
  }
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    /* unreadable directory — degrade, contribute nothing */
    return;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    if (state.count >= MAX_FILES) {
      state.truncated = true;
      return;
    }
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc, depth + 1, state);
    else if (e.isFile()) {
      acc.push(p);
      state.count += 1;
    }
  }
}

function hashFile(hash, base, abs, files) {
  const rel = slash(relative(base, abs));
  let bytes = null;
  try {
    bytes = readFileSync(abs);
  } catch {
    /* vanished or unreadable between the walk and the read — count it as gone */
  }
  if (bytes == null) hash.update(`${rel}\ndeleted\n`);
  else {
    // Text is hashed line-ending agnostic: a checkout with core.autocrlf=true
    // (the Git for Windows default) must not report every page stale without a
    // single content change. A NUL byte means binary — that keeps raw bytes.
    const binary = bytes.includes(0);
    const payload = binary ? bytes : bytes.toString('utf8').replaceAll('\r\n', '\n');
    const size = binary ? bytes.length : Buffer.byteLength(payload, 'utf8');
    hash.update(`${rel}\n${size},${createHash('sha1').update(payload).digest('hex')}\n`);
  }
  files.push(rel);
}

/**
 * Content digest over the declared sources — git-independent (a project may
 * not even be a repo). A file contributes itself; a directory contributes
 * every file beneath it, sorted; a source that no longer exists contributes
 * the literal `<path>\nmissing\n`, so a DELETION moves the digest instead of
 * being invisible. Same input tree → same hex, always.
 */
export function digestSources(root, sources) {
  const base = resolve(root);
  const hash = createHash('sha1');
  const files = [];
  const missing = [];
  const state = { count: 0, truncated: false };
  const list = [...new Set((sources || []).map(normalizeSourcePath).filter(Boolean))].sort();
  for (const src of list) {
    const abs = resolve(base, src);
    let st = null;
    try {
      st = statSync(abs);
    } catch {
      /* missing source — recorded below, never thrown */
    }
    if (st == null) {
      missing.push(src);
      hash.update(`${src}\nmissing\n`);
      continue;
    }
    if (st.isDirectory()) {
      const found = [];
      walk(abs, found, 0, state);
      for (const f of found) hashFile(hash, base, f, files);
    } else {
      state.count += 1;
      if (state.count > MAX_FILES) state.truncated = true;
      else hashFile(hash, base, abs, files);
    }
  }
  return { digest: hash.digest('hex'), files, missing, truncated: state.truncated };
}

// ── the plan (optional) ──────────────────────────────────────────────────────

function wikiPaths(root, opts = {}) {
  const base = resolve(root);
  // An override is resolved AGAINST THE PROJECT ROOT, never against the process
  // cwd: `FIA_AI_DOCS=docs` must mean `<root>/docs` wherever the script runs.
  const override = opts.aiDocsDir || process.env.FIA_AI_DOCS || null;
  const aiDocsDir = override ? resolve(base, override) : join(base, 'ai-docs');
  const wikiRoot = join(aiDocsDir, 'wiki');
  const rel = slash(relative(base, wikiRoot));
  const dirRel = !rel || rel.startsWith('..') || isAbsolute(rel) ? WIKI_DIR_POSIX : rel;
  return { wikiRoot, dirRel };
}

function strArray(value) {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  return list.map((v) => String(v ?? '').trim()).filter(Boolean);
}

function firstLine(text) {
  return String(text ?? '')
    .split('\n')[0]
    .trim();
}

/**
 * ai-docs/wiki/wiki-plan.yaml is OPTIONAL and only scopes GENERATION (which
 * paths the wiki should cover, which pages are wanted). Absent → defaults with
 * `available: false`. Malformed → defaults plus an English `error`; the gate
 * must keep working when a student mangles a YAML file.
 */
export function readWikiPlan(root, opts = {}) {
  const { wikiRoot } = wikiPaths(root, opts);
  const empty = {
    available: false,
    preset: PRESETS[0],
    include: [],
    exclude: [],
    pages: [],
    guidance: null,
    error: null,
  };
  let raw = null;
  try {
    raw = readFileSync(join(wikiRoot, PLAN_FILE), 'utf8');
  } catch {
    /* no plan file — the defaults are the plan */
    return empty;
  }
  let doc = null;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    return {
      ...empty,
      error: `${WIKI_DIR_POSIX}/${PLAN_FILE} is not valid YAML — using the defaults (${firstLine(err?.message)})`,
    };
  }
  if (doc == null) return { ...empty, available: true };
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    return {
      ...empty,
      error: `${WIKI_DIR_POSIX}/${PLAN_FILE} must be a YAML mapping (preset/include/exclude/pages/guidance) — using the defaults`,
    };
  }
  const presetRaw = doc.preset == null ? '' : String(doc.preset).trim().toLowerCase();
  const known = PRESETS.includes(presetRaw);
  return {
    available: true,
    preset: known ? presetRaw : PRESETS[0],
    include: strArray(doc.include),
    exclude: strArray(doc.exclude),
    pages: strArray(doc.pages),
    guidance: doc.guidance == null ? null : String(doc.guidance).trim() || null,
    error:
      presetRaw && !known
        ? `unknown preset "${presetRaw}" in ${WIKI_DIR_POSIX}/${PLAN_FILE} — using "${PRESETS[0]}"`
        : null,
  };
}

// ── the check ────────────────────────────────────────────────────────────────

/**
 * Plan-declared pages that have no `.md` under the wiki yet. A plan entry is a
 * name (`auth`), a name with the suffix (`auth.md`) or a path (`areas/auth.md`);
 * it counts as present when it matches a page's path under the wiki — or just
 * its file name — with or without the suffix, case-insensitively. Never a
 * failure, only a named gap: /absorb is what writes the page.
 */
function missingPlannedPages(planPages, relPaths) {
  if (!planPages?.length) return [];
  const have = new Set();
  const add = (key) => {
    if (!key) return;
    have.add(key);
    if (key.endsWith('.md')) have.add(key.slice(0, -3));
  };
  for (const rel of relPaths) {
    const lower = slash(rel).toLowerCase();
    add(lower);
    add(lower.split('/').pop());
  }
  const out = [];
  for (const name of planPages) {
    const key = slash(name)
      .replace(/^\.?\/+/, '')
      .toLowerCase();
    if (!key) continue;
    if (!have.has(key) && !have.has(key.endsWith('.md') ? key.slice(0, -3) : `${key}.md`)) out.push(name);
  }
  return out;
}

function listPages(dir, acc = [], depth = 0) {
  if (depth > MAX_DEPTH) return acc;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    /* unreadable wiki subtree — report what we could read */
    return acc;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) listPages(p, acc, depth + 1);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) acc.push(p);
  }
  return acc;
}

/**
 * `unverifiable` has TWO causes, and only one of them is benign:
 *
 *   - the page declares no `sources:` at all — it was never wired up, and
 *     /absorb is what fixes that;
 *   - the page declares sources whose every path is gone. That is drift, not a
 *     gap: the code was renamed or moved after the page was stamped, which is
 *     the exact lifecycle the wiki exists to catch. Such a page is checked
 *     against nothing and would otherwise read as healthy forever.
 *
 * Every unverifiable page therefore carries `reason` — `'sources_gone'` or
 * `'no_sources'` — and the report counts the first as `summary.sourcesGone`.
 * That count, not `summary.unverifiable`, is what makes a report fail; a page
 * nobody has wired up yet is a gap for /absorb, not drift.
 * `reason` is null on any page that is fresh or stale.
 */
export const SOURCES_GONE = 'sources_gone';
export const NO_SOURCES = 'no_sources';

/** True for an unverifiable page whose every declared path is gone from disk. */
export const hasSourcesGone = (page) => page?.reason === SOURCES_GONE;

/**
 * Freshness report for every page under ai-docs/wiki/. Reads disk, writes
 * nothing. No wiki directory → `available: false` and `passed: true` (there is
 * nothing to be stale about yet — /absorb creates it).
 */
export function runWikiCheck(root = process.cwd(), opts = {}) {
  const base = resolve(root);
  const { wikiRoot, dirRel } = wikiPaths(base, opts);
  const plan = readWikiPlan(base, opts);
  let isDir = false;
  try {
    isDir = statSync(wikiRoot).isDirectory();
  } catch {
    /* no wiki yet — reported as unavailable, never thrown */
  }
  if (!isDir) {
    return {
      available: false,
      dir: dirRel,
      plan,
      pages: [],
      summary: { total: 0, fresh: 0, stale: 0, unverifiable: 0, sourcesGone: 0, plannedMissing: [] },
      passed: true,
    };
  }

  const pages = [];
  const relPaths = [];
  /**
   * The ABSOLUTE path rides along with every entry so the writer never has to
   * rebuild it from `file` (a display string rooted at `dir`, which is only a
   * fallback when the wiki lives outside the project). Non-enumerable: the
   * report shape — `--json`, fia-launch-check — stays exactly as it was.
   */
  const pushPage = (abs, entry) => {
    Object.defineProperty(entry, 'abs', { value: abs, enumerable: false });
    pages.push(entry);
  };
  for (const abs of listPages(wikiRoot)) {
    const relFromWiki = slash(relative(wikiRoot, abs));
    // README.md at the wiki root is the shipped explainer, not a page.
    if (relFromWiki.toLowerCase() === 'readme.md') continue;
    let text = null;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      /* unreadable page — unverifiable, never a crash */
    }
    const page = text == null ? null : parseWikiPage(text);
    const file = `${dirRel}/${relFromWiki}`;
    relPaths.push(relFromWiki);
    const sources = page?.sources ?? [];
    const recordedDigest = page?.digest ?? null;
    const humanBlocks = page?.humanBlocks ?? 0;
    if (!sources.length) {
      pushPage(abs, {
        file,
        sources,
        status: 'unverifiable',
        reason: NO_SOURCES,
        recordedDigest,
        actualDigest: null,
        missing: [],
        humanBlocks,
        truncated: false,
      });
      continue;
    }
    const d = digestSources(base, sources);
    // Every declared source gone → nothing left to compare against. One of
    // several gone is NOT unverifiable: the digest moved, so the page is stale.
    const allGone = d.missing.length === sources.length;
    const status = allGone ? 'unverifiable' : recordedDigest && recordedDigest === d.digest ? 'fresh' : 'stale';
    pushPage(abs, {
      file,
      sources,
      status,
      reason: allGone ? SOURCES_GONE : null,
      recordedDigest,
      actualDigest: d.digest,
      missing: d.missing,
      humanBlocks,
      truncated: d.truncated,
    });
  }
  pages.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  const summary = {
    total: pages.length,
    fresh: pages.filter((p) => p.status === 'fresh').length,
    stale: pages.filter((p) => p.status === 'stale').length,
    unverifiable: pages.filter((p) => p.status === 'unverifiable').length,
    sourcesGone: pages.filter(hasSourcesGone).length,
    plannedMissing: missingPlannedPages(plan.pages, relPaths),
  };
  // A page pointing only at paths that no longer exist is NOT a pass: it is
  // checked against nothing, so it can never go stale again.
  return {
    available: true,
    dir: dirRel,
    plan,
    pages,
    summary,
    passed: summary.stale === 0 && summary.sourcesGone === 0,
  };
}

function capList(list) {
  const arr = list || [];
  return arr.slice(0, DETAIL_CAP).join(', ') + (arr.length > DETAIL_CAP ? ` (+${arr.length - DETAIL_CAP})` : '');
}

export function renderWikiCheck(report) {
  const lines = ['Repo wiki — freshness report (nothing was rewritten by this command)'];
  if (!report.available) {
    lines.push(`○ no ${report.dir}/ yet — run /absorb to map the codebase and create the wiki.`);
    return lines.join('\n');
  }
  const s = report.summary;
  lines.push(`Directory: ${report.dir}`, '');
  if (!s.total) lines.push('○ the wiki directory exists but has no pages — run /absorb to write them.');
  for (const p of report.pages) {
    const glyph = p.status === 'fresh' ? '✓' : p.status === 'stale' ? '✗' : '–';
    lines.push(`  ${glyph} ${p.file}${p.humanBlocks ? ` · ${p.humanBlocks} human block(s)` : ''}`);
    if (p.status === 'stale') {
      lines.push(`      sources changed: ${capList(p.sources)}`);
      if (p.missing.length) lines.push(`      gone from disk: ${capList(p.missing)}`);
      if (!p.recordedDigest) lines.push('      no digest recorded — this page was never stamped');
    }
    if (p.status === 'unverifiable') {
      lines.push(
        p.sources.length
          ? `      every declared source is gone: ${capList(p.sources)}`
          : '      declares no sources: — add one so freshness can be verified',
      );
    }
    if (p.truncated) lines.push(`      source tree too large — the digest covers the first ${MAX_FILES} files only`);
  }
  lines.push(
    '',
    `Result: ${s.fresh} fresh · ${s.stale} stale · ${s.unverifiable} unverifiable (of ${s.total} page(s))`,
  );
  if (s.plannedMissing?.length) {
    lines.push(
      `! the plan declares page(s) with no file yet: ${capList(s.plannedMissing)} — run /absorb to write them.`,
    );
  }
  if (report.plan.error) lines.push(`! ${report.plan.error}`);
  // Zero pages must NOT claim "every page matches": that reads as a green
  // light for a wiki nobody has written yet, and it is the state EVERY fresh
  // install starts in (the harness ships the directory with its README).
  if (!s.total) {
    lines.push('Nothing is being checked yet — the wiki starts paying off once /absorb writes its first page.');
    return lines.join('\n');
  }
  if (s.stale) {
    lines.push('Rewrite the stale pages with /absorb — it keeps every <!-- human:start --> block and re-stamps the digest.');
  }
  // The two causes of `unverifiable` need OPPOSITE advice. Telling the owner of
  // a page whose sources were renamed to "add a sources: list" sends them to
  // look at a list that is already there, and the page stays unchecked forever.
  const vanished = report.pages.filter(hasSourcesGone);
  if (vanished.length) {
    const gone = [...new Set(vanished.flatMap((p) => p.sources))].sort();
    lines.push(
      `${vanished.length} page(s) declare source paths that do not exist in this repo: ${capList(gone)} — nothing is being compared, ` +
        'so they can never go stale. Point their sources: at where the code moved to (then `--stamp` re-records the digest), or delete the page.',
    );
  }
  const undeclared = s.unverifiable - vanished.length;
  if (undeclared) {
    lines.push(`${undeclared} page(s) declare no sources: at all — give each one a sources: list so it can be checked next time.`);
  }
  if (!s.stale && !s.unverifiable) {
    lines.push('Every page matches its sources — agents can read the wiki instead of re-reading the code.');
  }
  return lines.join('\n');
}

// ── stamping (the only writing path) ─────────────────────────────────────────

/**
 * Re-record `digest:` (and `updated:`) on every page this run found stale.
 *
 * Rewrites ONLY those two frontmatter lines: the body is sliced off untouched
 * and concatenated back byte-for-byte, so a `<!-- human:start -->` block cannot
 * be disturbed even in principle. The page's own line endings are preserved.
 * Refuses entirely while an FDA holds the run lock — a write during a run gets
 * rolled back by the permission gate (same rule as docs-commit.mjs).
 */
/**
 * Where a reported page really lives. `page.abs` is what runWikiCheck carried;
 * a report rebuilt by a caller (a spread, a JSON round-trip) loses it, so the
 * path is recomputed from the WIKI ROOT — never from `page.file`, which falls
 * back to the literal `ai-docs/wiki` display prefix when the wiki sits outside
 * the project root. Returns null when the entry cannot be located at all.
 */
function pageAbsPath(base, opts, page) {
  if (page.abs) return page.abs;
  const { wikiRoot, dirRel } = wikiPaths(base, opts);
  const file = slash(page.file ?? '');
  if (!file.startsWith(`${dirRel}/`)) return null;
  return join(wikiRoot, file.slice(dirRel.length + 1));
}

export function stampWikiPages(root = process.cwd(), opts = {}) {
  const base = resolve(root);
  const report = opts.report ?? runWikiCheck(base, opts);
  const lock = opts.lock === undefined ? activeFdaLock(base) : opts.lock;
  if (lock) {
    return {
      blocked: `an FDA is running in this repo (${lock.fda_id}) — stamp after it finishes, or its permission gate will roll the write back`,
      stamped: [],
      skipped: [],
      report,
    };
  }
  const stamped = [];
  const skipped = [];
  for (const page of report.pages) {
    if (page.status !== 'stale') continue;
    if (!page.actualDigest) {
      skipped.push({ file: page.file, reason: 'nothing to hash — every declared source is gone from disk' });
      continue;
    }
    const abs = pageAbsPath(base, opts, page);
    if (!abs) {
      skipped.push({ file: page.file, reason: 'cannot be located on disk' });
      continue;
    }
    let raw;
    try {
      raw = readFileSync(abs, 'utf8');
    } catch {
      skipped.push({ file: page.file, reason: 'unreadable' });
      continue;
    }
    const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
    if (!m) {
      skipped.push({ file: page.file, reason: 'no frontmatter block to stamp' });
      continue;
    }
    // The inserts below reuse each match's own captured line ending, so a CRLF
    // page stays CRLF and an LF page stays LF without a normalization pass.
    const updates = { digest: page.actualDigest, updated: now().slice(0, 10) };
    let block = m[0];
    for (const [key, value] of Object.entries(updates)) {
      const line = new RegExp(`^${key}:.*$`, 'm');
      if (line.test(block)) block = block.replace(line, `${key}: ${value}`);
      // No such field yet — insert it just above the closing delimiter.
      else block = block.replace(/(\r?\n)---(\r?\n?)$/, `$1${key}: ${value}$1---$2`);
    }
    try {
      writeFileSync(abs, block + raw.slice(m[0].length));
      stamped.push({ file: page.file, digest: page.actualDigest });
    } catch {
      skipped.push({ file: page.file, reason: 'not writable' });
    }
  }
  return { blocked: null, stamped, skipped, report };
}

export function renderStamp(result) {
  if (result.blocked) return `✗ ${result.blocked}`;
  const lines = ['Wiki digest stamp', ''];
  if (!result.stamped.length && !result.skipped.length) {
    lines.push('✓ nothing to stamp — every page already matches its sources.');
    return lines.join('\n');
  }
  for (const s of result.stamped) lines.push(`  ✓ ${s.file} · digest ${s.digest.slice(0, 12)}…`);
  for (const s of result.skipped) lines.push(`  – ${s.file} · ${s.reason}`);
  lines.push('', `Stamped ${result.stamped.length} page(s), skipped ${result.skipped.length}.`);
  return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const dirIx = argv.indexOf('--dir');
  const root = dirIx !== -1 && argv[dirIx + 1] ? resolve(argv[dirIx + 1]) : process.cwd();
  if (argv.includes('--stamp')) {
    const result = stampWikiPages(root);
    if (argv.includes('--json')) {
      console.log(
        JSON.stringify({ blocked: result.blocked, stamped: result.stamped, skipped: result.skipped }, null, 2),
      );
    } else {
      console.log(renderStamp(result));
    }
    process.exit(result.blocked ? 1 : 0);
  }
  const report = runWikiCheck(root);
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else console.log(renderWikiCheck(report));
  if (argv.includes('--strict') && !report.passed) process.exit(1);
}
