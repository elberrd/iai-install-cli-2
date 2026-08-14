/**
 * Stack research ledger — deterministic tooling research per technology.
 *
 * /stack (and api-docs-researcher, when delegated) must RESEARCH every chosen
 * technology across four dimensions — docs, skills, cli, mcp — instead of
 * trusting hardcoded tables or model memory. This script is the code side of
 * that rule: it owns the record format and, crucially, `close` REFUSES while
 * any dimension lacks an entry with its source. A technology may only be
 * marked documented in ai-docs/stack.md (and equipped) after its record
 * closes. The agent only calls:
 *
 *   open   — before researching (creates/rewrites the record; a re-open
 *            discards previous findings on purpose — the point is fresh
 *            evidence, not history; history lives in git)
 *   log    — after EACH dimension actually checked this session
 *            (--found "…" or --none, always with --source; "I didn't check"
 *            is not a representable state)
 *   close  — the gate: fails listing the missing dimensions, or stamps the
 *            verdict and closes
 *   status — read side: which techs are researched, what is still missing
 *
 * Records live in ai-docs/research/<tech>.md — one file per technology,
 * script-owned (agents read them, never hand-edit them).
 *
 * Usage:
 *   node imp/scripts/stack-research.mjs open <tech> [--json]
 *   node imp/scripts/stack-research.mjs log <tech> --dim <docs|skills|cli|mcp> (--found "…" | --none) --source "<url or verify command>" [--note "…"]
 *   node imp/scripts/stack-research.mjs close <tech> [--json]
 *   node imp/scripts/stack-research.mjs status [<tech>] [--json]
 * All subcommands accept --dir <project root> (default: cwd).
 * Timestamps honor IAI_DECISION_LOG_NOW (same override the decision log uses, for tests).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { now, oneLine, parseFrontmatter } from './decision-log.mjs';

export const RESEARCH_DIR = join('ai-docs', 'research');

/** The four mandatory dimensions, in research order. */
export const DIMENSIONS = ['docs', 'skills', 'cli', 'mcp'];

// ── small pure helpers ───────────────────────────────────────────────────────

/** `Next.js` → null (invalid), `clerk` → `clerk`. Slug: lowercase a-z0-9 and hyphens. */
export function normalizeTech(input) {
  const t = String(input ?? '')
    .trim()
    .toLowerCase();
  return /^[a-z0-9][a-z0-9-]*$/.test(t) ? t : null;
}

/** Parse the `### <dim>` blocks of a record → { docs: "block text", … }. */
export function dimensionEntries(content) {
  const out = {};
  const re = /^### ([a-z]+)\n([\s\S]*?)(?=^### |^## |(?![\s\S]))/gm;
  let m;
  while ((m = re.exec(String(content ?? ''))) !== null) {
    if (DIMENSIONS.includes(m[1])) out[m[1]] = m[2].trim();
  }
  return out;
}

/** Dimensions still without an entry, in canonical order. */
export function missingDimensions(content) {
  const entries = dimensionEntries(content);
  return DIMENSIONS.filter((d) => !entries[d]);
}

function rewriteField(content, key, value) {
  const fm = parseFrontmatter(content);
  if (!fm) return content;
  const head = content.slice(0, fm.bodyStart);
  if (new RegExp(`^${key}:`, 'm').test(head)) {
    return content.replace(new RegExp(`^${key}:.*$`, 'm'), `${key}: ${value}`);
  }
  return content.replace(/\n---\n/, `\n${key}: ${value}\n---\n`);
}

// ── store ────────────────────────────────────────────────────────────────────

function fileFor(root, tech) {
  return join(root, RESEARCH_DIR, `${tech}.md`);
}

/** All parseable records in ai-docs/research/, alphabetical. */
export function readResearch(root) {
  const dir = join(root, RESEARCH_DIR);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.md')) continue;
    let content;
    let fm;
    try {
      content = readFileSync(join(dir, name), 'utf8');
      fm = parseFrontmatter(content);
    } catch {
      continue;
    }
    if (!fm?.fields.tech) continue; // README.md, hand notes, …
    out.push({
      tech: fm.fields.tech,
      file: join(RESEARCH_DIR, name),
      status: fm.fields.status || 'open',
      opened: fm.fields.opened || '',
      closed: fm.fields.closed || '',
      missing: missingDimensions(content),
    });
  }
  return out;
}

// ── lifecycle ────────────────────────────────────────────────────────────────

/** Create (or reset) the record for a tech. Returns the relative path. */
export function openResearch(root, tech) {
  mkdirSync(join(root, RESEARCH_DIR), { recursive: true });
  const content = [
    '---',
    `tech: ${tech}`,
    'status: open',
    `opened: ${now()}`,
    '---',
    '',
    `# Tooling research — ${tech}`,
    '',
    'Ledger written by `imp/scripts/stack-research.mjs` (open → log per dimension',
    '→ close). `close` refuses while any of the four dimensions (docs, skills,',
    'cli, mcp) lacks an entry with its source — /stack only equips the project',
    'and marks the tech documented after this record closes. Script-owned: read',
    'it, never hand-edit it.',
    '',
    '## Findings',
    '',
  ].join('\n');
  writeFileSync(fileFor(root, tech), content);
  return join(RESEARCH_DIR, `${tech}.md`);
}

/** Record one researched dimension (replaces the block on a re-log). */
export function logDimension(root, tech, { dim, found, none, source, note }) {
  if (!DIMENSIONS.includes(dim)) throw new Error(`unknown dimension "${dim}" (use: ${DIMENSIONS.join(', ')})`);
  if (Boolean(found) === Boolean(none)) throw new Error('exactly one of --found "…" or --none is required');
  if (!oneLine(source)) throw new Error('--source is required — every dimension needs evidence (a URL or the exact verify command)');
  const file = fileFor(root, tech);
  if (!existsSync(file)) throw new Error(`no research record for ${tech} — run open first`);
  let content = readFileSync(file, 'utf8');
  if (parseFrontmatter(content)?.fields.status === 'closed') {
    throw new Error(`research for ${tech} is closed — re-open to research again`);
  }
  const lines = [
    `### ${dim}`,
    `- Result: ${none ? 'none' : oneLine(found)}`,
    `- Source: ${oneLine(source)}`,
    `- When: ${now()}`,
  ];
  if (note) lines.push(`- Note: ${oneLine(note)}`);
  const block = lines.join('\n') + '\n';
  const re = new RegExp(`^### ${dim}\\n[\\s\\S]*?(?=^### |^## |(?![\\s\\S]))`, 'm');
  content = re.test(content) ? content.replace(re, block) : content.replace(/\n*$/, '\n\n') + block;
  writeFileSync(file, content);
  return { dim, result: none ? 'none' : 'found' };
}

/** The gate: refuses while a dimension is missing; otherwise stamps the verdict. */
export function closeResearch(root, tech) {
  const file = fileFor(root, tech);
  if (!existsSync(file)) throw new Error(`no research record for ${tech} — run open first`);
  let content = readFileSync(file, 'utf8');
  if (parseFrontmatter(content)?.fields.status === 'closed') throw new Error(`already closed: ${tech}`);
  const missing = missingDimensions(content);
  if (missing.length) {
    throw new Error(
      `research incomplete for ${tech} — missing: ${missing.join(', ')}. ` +
        'Log every dimension (--found or --none, always with --source) before closing.',
    );
  }
  const stamp = now();
  content = rewriteField(content, 'status', 'closed');
  content = rewriteField(content, 'closed', stamp);
  const verdict = ['## Verdict', `- Dimensions: ${DIMENSIONS.map((d) => `${d} ✓`).join(' · ')}`, `- Closed: ${stamp}`, ''];
  writeFileSync(file, content.replace(/\n*$/, '\n\n') + verdict.join('\n'));
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function flagValue(argv, flag) {
  const ix = argv.indexOf(flag);
  return ix !== -1 && argv[ix + 1] !== undefined ? argv[ix + 1] : undefined;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function techArg(argv, cmd) {
  const raw = argv[1];
  if (!raw || raw.startsWith('--')) fail(`usage: stack-research ${cmd} <tech> …`);
  const tech = normalizeTech(raw);
  if (!tech) fail(`invalid tech "${raw}" — use a lowercase slug (a-z, 0-9, hyphens), e.g. nextjs, better-auth`);
  return tech;
}

export function main(argv) {
  const cmd = argv[0];
  const root = resolve(flagValue(argv, '--dir') ?? process.cwd());
  const json = argv.includes('--json');

  if (cmd === 'open') {
    const tech = techArg(argv, 'open');
    const rel = openResearch(root, tech);
    console.log(json ? JSON.stringify({ file: rel }) : rel);
    return;
  }

  if (cmd === 'log') {
    const tech = techArg(argv, 'log');
    try {
      const r = logDimension(root, tech, {
        dim: flagValue(argv, '--dim'),
        found: flagValue(argv, '--found'),
        none: argv.includes('--none'),
        source: flagValue(argv, '--source'),
        note: flagValue(argv, '--note'),
      });
      console.log(json ? JSON.stringify(r) : `logged ${r.dim} (${r.result})`);
    } catch (err) {
      fail(err.message);
    }
    return;
  }

  if (cmd === 'close') {
    const tech = techArg(argv, 'close');
    try {
      closeResearch(root, tech);
    } catch (err) {
      fail(err.message);
    }
    console.log(json ? JSON.stringify({ closed: true }) : 'closed — all four dimensions verified');
    return;
  }

  if (cmd === 'status') {
    const raw = argv[1] && !argv[1].startsWith('--') ? argv[1] : undefined;
    const records = readResearch(root);
    if (raw) {
      const tech = normalizeTech(raw);
      const hit = records.find((r) => r.tech === tech) ?? null;
      if (json) return console.log(JSON.stringify(hit));
      if (!hit) fail(`no research record for ${raw} in ${RESEARCH_DIR}/ — run open first`);
      const state = hit.status === 'closed' ? 'closed (complete)' : `open — missing: ${hit.missing.join(', ') || 'nothing (ready to close)'}`;
      console.log(`${hit.tech}  ${state}`);
      return;
    }
    if (json) return console.log(JSON.stringify(records, null, 2));
    if (!records.length) return console.log(`no research records in ${RESEARCH_DIR}/`);
    for (const r of records) {
      const state = r.status === 'closed' ? 'closed' : `open (missing: ${r.missing.join(', ') || 'none'})`;
      console.log(`${r.tech.padEnd(14)}  ${state.padEnd(38)}  ${r.opened.slice(0, 10)}`);
    }
    return;
  }

  fail('usage: stack-research <open|log|close|status> …  (see the header of this file)');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main(process.argv.slice(2));
