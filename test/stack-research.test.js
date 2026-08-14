import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DIMENSIONS,
  RESEARCH_DIR,
  closeResearch,
  dimensionEntries,
  logDimension,
  missingDimensions,
  normalizeTech,
  openResearch,
  readResearch,
} from '../fia-templates/scripts/stack-research.mjs';

const SCRIPT = join(import.meta.dirname, '..', 'fia-templates', 'scripts', 'stack-research.mjs');
const NOW = { IAI_DECISION_LOG_NOW: '2026-08-13T10:23:00' };

function cli(root, args, env = {}) {
  return execFileSync(process.execPath, [SCRIPT, ...args, '--dir', root], {
    encoding: 'utf8',
    env: { ...process.env, ...NOW, ...env },
  }).trim();
}

function cliFails(root, args) {
  try {
    cli(root, args);
  } catch (err) {
    return { status: err.status, stderr: String(err.stderr) };
  }
  throw new Error(`expected failure: stack-research ${args.join(' ')}`);
}

function freshRoot() {
  return mkdtempSync(join(tmpdir(), 'stack-research-'));
}

function logAll(root, tech) {
  for (const dim of DIMENSIONS) {
    logDimension(root, tech, { dim, found: `official ${dim}`, source: `https://example.com/${dim}` });
  }
}

// ── pure helpers ─────────────────────────────────────────────────────────────

test('normalizeTech: slugs pass, everything else is rejected', () => {
  assert.equal(normalizeTech(' Clerk '), 'clerk');
  assert.equal(normalizeTech('better-auth'), 'better-auth');
  assert.equal(normalizeTech('Next.js'), null);
  assert.equal(normalizeTech('a b'), null);
  assert.equal(normalizeTech(''), null);
});

test('dimensionEntries/missingDimensions: parse ### blocks, canonical order', () => {
  const content = '## Findings\n\n### cli\n- Result: x\n\n### docs\n- Result: y\n';
  assert.deepEqual(Object.keys(dimensionEntries(content)).sort(), ['cli', 'docs']);
  assert.deepEqual(missingDimensions(content), ['skills', 'mcp']);
});

// ── lifecycle (direct function calls) ────────────────────────────────────────

test('openResearch: record with open status and all four dimensions missing', () => {
  const root = freshRoot();
  const rel = openResearch(root, 'clerk');
  assert.equal(rel, join(RESEARCH_DIR, 'clerk.md'));
  const [rec] = readResearch(root);
  assert.equal(rec.tech, 'clerk');
  assert.equal(rec.status, 'open');
  assert.deepEqual(rec.missing, DIMENSIONS);
});

test('logDimension: records evidence; a re-log replaces the block', () => {
  const root = freshRoot();
  openResearch(root, 'neon');
  logDimension(root, 'neon', { dim: 'cli', found: 'npm i -g neon', source: 'https://neon.com/docs/cli' });
  logDimension(root, 'neon', { dim: 'cli', found: 'npm i -g neonctl', source: 'https://neon.com/docs/cli/v2', note: 'renamed' });
  const content = readFileSync(join(root, RESEARCH_DIR, 'neon.md'), 'utf8');
  assert.equal((content.match(/^### cli$/gm) || []).length, 1);
  assert.match(content, /npm i -g neonctl/);
  assert.match(content, /- Note: renamed/);
  assert.doesNotMatch(content, /npm i -g neon\n/);
});

test('logDimension: --none needs a source too; found XOR none; open first', () => {
  const root = freshRoot();
  openResearch(root, 'hono');
  logDimension(root, 'hono', { dim: 'mcp', none: true, source: 'https://hono.dev/docs' });
  assert.match(readFileSync(join(root, RESEARCH_DIR, 'hono.md'), 'utf8'), /### mcp\n- Result: none/);
  assert.throws(() => logDimension(root, 'hono', { dim: 'cli', none: true, source: '' }), /--source is required/);
  assert.throws(() => logDimension(root, 'hono', { dim: 'cli', found: 'x', none: true, source: 's' }), /exactly one/);
  assert.throws(() => logDimension(root, 'hono', { dim: 'nope', found: 'x', source: 's' }), /unknown dimension/);
  assert.throws(() => logDimension(root, 'ghost', { dim: 'cli', found: 'x', source: 's' }), /run open first/);
});

test('closeResearch: refuses listing missing dimensions; closes when complete', () => {
  const root = freshRoot();
  openResearch(root, 'vercel');
  logDimension(root, 'vercel', { dim: 'docs', found: 'https://vercel.com/docs', source: 'https://vercel.com/docs' });
  assert.throws(() => closeResearch(root, 'vercel'), /missing: skills, cli, mcp/);
  logAll(root, 'vercel');
  closeResearch(root, 'vercel');
  const [rec] = readResearch(root);
  assert.equal(rec.status, 'closed');
  assert.deepEqual(rec.missing, []);
  const content = readFileSync(join(root, RESEARCH_DIR, 'vercel.md'), 'utf8');
  assert.match(content, /## Verdict/);
  assert.throws(() => closeResearch(root, 'vercel'), /already closed/);
  assert.throws(() => logDimension(root, 'vercel', { dim: 'cli', found: 'x', source: 's' }), /re-open/);
});

test('re-open discards previous findings (fresh evidence, not history)', () => {
  const root = freshRoot();
  openResearch(root, 'clerk');
  logAll(root, 'clerk');
  closeResearch(root, 'clerk');
  openResearch(root, 'clerk');
  const [rec] = readResearch(root);
  assert.equal(rec.status, 'open');
  assert.deepEqual(rec.missing, DIMENSIONS);
});

// ── CLI ──────────────────────────────────────────────────────────────────────

test('cli: open → log ×4 → close → status happy path', () => {
  const root = freshRoot();
  assert.equal(cli(root, ['open', 'convex']), join(RESEARCH_DIR, 'convex.md'));
  for (const dim of DIMENSIONS) {
    assert.equal(cli(root, ['log', 'convex', '--dim', dim, '--found', `x-${dim}`, '--source', 'https://docs.convex.dev']), `logged ${dim} (found)`);
  }
  assert.match(cli(root, ['close', 'convex']), /closed — all four dimensions verified/);
  assert.match(cli(root, ['status', 'convex']), /convex {2}closed \(complete\)/);
  const all = JSON.parse(cli(root, ['status', '--json']));
  assert.equal(all.length, 1);
  assert.equal(all[0].status, 'closed');
});

test('cli: close refuses while incomplete (exit 1, missing dims on stderr)', () => {
  const root = freshRoot();
  cli(root, ['open', 'neon']);
  cli(root, ['log', 'neon', '--dim', 'skills', '--none', '--source', 'https://skills.sh/neondatabase']);
  const r = cliFails(root, ['close', 'neon']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing: docs, cli, mcp/);
});

test('cli: invalid tech and missing record fail loudly', () => {
  const root = freshRoot();
  assert.match(cliFails(root, ['open', 'Next.js']).stderr, /invalid tech/);
  assert.match(cliFails(root, ['log', 'ghost', '--dim', 'cli', '--found', 'x', '--source', 's']).stderr, /run open first/);
  assert.match(cliFails(root, ['status', 'ghost']).stderr, /no research record/);
  assert.equal(JSON.parse(cli(root, ['status', 'ghost', '--json'])), null);
});
