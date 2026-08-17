import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PLAN_FILE,
  WIKI_DIR,
  digestSources,
  hasSourcesGone,
  normalizeSourcePath,
  parseWikiPage,
  readWikiPlan,
  renderStamp,
  renderWikiCheck,
  runWikiCheck,
  stampWikiPages,
} from '../fia-templates/scripts/wiki-check.mjs';

const SCRIPT = join(import.meta.dirname, '..', 'fia-templates', 'scripts', 'wiki-check.mjs');

/** A throwaway project. Nothing is cleaned up — deliberate, mirrors the suite. */
function makeProject(prefix = 'wiki-check') {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  mkdirSync(join(root, WIKI_DIR), { recursive: true });
  return root;
}

function write(root, rel, text) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  return p;
}

/** Page text with a frontmatter digest that matches the sources right now. */
function stampedPage(root, sources, body = '# Page\n\nProse.\n') {
  const { digest } = digestSources(root, sources);
  return `---\nupdated: 2026-08-17\nsources: ${sources.join(', ')}\ndigest: ${digest}\n---\n${body}`;
}

test('no wiki directory → unavailable, passing, and the renderer points at /absorb', () => {
  const root = mkdtempSync(join(tmpdir(), 'wiki-check-empty-'));
  const report = runWikiCheck(root);
  assert.equal(report.available, false);
  assert.equal(report.passed, true);
  assert.equal(report.dir, 'ai-docs/wiki');
  assert.deepEqual(report.pages, []);
  assert.deepEqual(report.summary, {
    total: 0,
    fresh: 0,
    stale: 0,
    unverifiable: 0,
    sourcesGone: 0,
    plannedMissing: [],
  });
  const text = renderWikiCheck(report);
  assert.match(text, /\/absorb/);
  assert.match(text, /no ai-docs\/wiki\/ yet/);
});

test('a page whose recorded digest matches its sources is fresh', () => {
  const root = makeProject();
  write(root, 'src/auth.ts', 'export const auth = 1;\n');
  write(root, join(WIKI_DIR, 'auth.md'), stampedPage(root, ['src/auth.ts']));
  const report = runWikiCheck(root);
  assert.equal(report.available, true);
  assert.equal(report.passed, true);
  assert.equal(report.summary.fresh, 1);
  assert.equal(report.pages[0].file, 'ai-docs/wiki/auth.md');
  assert.equal(report.pages[0].status, 'fresh');
  assert.equal(report.pages[0].recordedDigest, report.pages[0].actualDigest);
  assert.equal(report.pages[0].reason, null, 'reason is only set on an unverifiable page');
  assert.match(renderWikiCheck(report), /1 fresh · 0 stale/);
});

test('touching one declared source turns the page stale and names that source', () => {
  const root = makeProject();
  write(root, 'src/auth.ts', 'export const auth = 1;\n');
  write(root, 'src/lib/session.ts', 'export const session = 1;\n');
  write(root, join(WIKI_DIR, 'auth.md'), stampedPage(root, ['src/auth.ts', 'src/lib/session.ts']));
  assert.equal(runWikiCheck(root).summary.fresh, 1);

  write(root, 'src/lib/session.ts', 'export const session = 2; // changed\n');
  const report = runWikiCheck(root);
  assert.equal(report.passed, false);
  assert.equal(report.summary.stale, 1);
  assert.equal(report.pages[0].status, 'stale');
  assert.notEqual(report.pages[0].recordedDigest, report.pages[0].actualDigest);
  assert.deepEqual(report.pages[0].sources, ['src/auth.ts', 'src/lib/session.ts']);
  const text = renderWikiCheck(report);
  assert.match(text, /ai-docs\/wiki\/auth\.md/);
  assert.match(text, /src\/lib\/session\.ts/);
  assert.match(text, /0 fresh · 1 stale/);
});

test('a deleted source is stale, never silently fresh', () => {
  const root = makeProject();
  write(root, 'src/keep.ts', 'export const keep = 1;\n');
  write(root, 'src/gone.ts', 'export const gone = 1;\n');
  write(root, join(WIKI_DIR, 'mod.md'), stampedPage(root, ['src/keep.ts', 'src/gone.ts']));
  rmSync(join(root, 'src/gone.ts'));
  const report = runWikiCheck(root);
  assert.equal(report.pages[0].status, 'stale');
  assert.deepEqual(report.pages[0].missing, ['src/gone.ts']);
  assert.match(renderWikiCheck(report), /gone from disk: src\/gone\.ts/);
});

test('a directory source notices a new file below it', () => {
  const root = makeProject();
  write(root, 'src/app/page.tsx', 'export default function P() {}\n');
  write(root, join(WIKI_DIR, 'app.md'), stampedPage(root, ['src/app']));
  assert.equal(runWikiCheck(root).summary.fresh, 1);
  write(root, 'src/app/layout.tsx', 'export default function L() {}\n');
  assert.equal(runWikiCheck(root).summary.stale, 1);
});

test('a page with no sources is unverifiable, and a page with no digest is stale', () => {
  const root = makeProject();
  write(root, 'src/a.ts', 'a\n');
  write(root, join(WIKI_DIR, 'no-sources.md'), '---\nupdated: 2026-08-17\n---\n# Overview\n');
  write(root, join(WIKI_DIR, 'no-digest.md'), '---\nsources: src/a.ts\n---\n# A\n');
  const report = runWikiCheck(root);
  const byFile = Object.fromEntries(report.pages.map((p) => [p.file, p]));
  assert.equal(byFile['ai-docs/wiki/no-sources.md'].status, 'unverifiable');
  assert.deepEqual(byFile['ai-docs/wiki/no-sources.md'].sources, []);
  assert.equal(byFile['ai-docs/wiki/no-digest.md'].status, 'stale');
  assert.equal(byFile['ai-docs/wiki/no-digest.md'].recordedDigest, null);
  assert.equal(report.summary.unverifiable, 1);
  const text = renderWikiCheck(report);
  assert.match(text, /declares no sources/);
  assert.match(text, /never stamped/);
});

test('every declared source missing → unverifiable, not stale, and NOT a pass', () => {
  const root = makeProject();
  write(root, join(WIKI_DIR, 'ghost.md'), '---\nsources: src/ghost.ts, src/other.ts\ndigest: deadbeef\n---\n# Ghost\n');
  const report = runWikiCheck(root);
  assert.equal(report.pages[0].status, 'unverifiable');
  assert.equal(hasSourcesGone(report.pages[0]), true);
  assert.equal(report.summary.sourcesGone, 1);
  // A page compared against nothing can never go stale again — reporting it as
  // healthy is the exact failure the wiki was built to prevent.
  assert.equal(report.passed, false);
  assert.match(renderWikiCheck(report), /every declared source is gone/);
});

test('a page whose sources were renamed away is diagnosed by cause, not as a missing sources: list', () => {
  // The realistic trigger is not a typo: it is an ordinary move after /absorb
  // stamped the page.
  const root = makeProject();
  write(root, 'src/payments.ts', 'export const pay = 1;\n');
  write(root, join(WIKI_DIR, 'payments.md'), stampedPage(root, ['src/payments.ts']));
  assert.equal(runWikiCheck(root).summary.fresh, 1);

  rmSync(join(root, 'src'), { recursive: true, force: true }); // the code moved to lib/
  const report = runWikiCheck(root);
  assert.equal(report.summary.unverifiable, 1);
  assert.equal(report.summary.sourcesGone, 1);

  const out = renderWikiCheck(report);
  assert.match(out, /declare source paths that do not exist in this repo/);
  assert.match(out, /src\/payments\.ts/, 'the paths that are gone are named');
  assert.doesNotMatch(out, /Give each unverifiable page a sources: list/, 'the page HAS a sources: list');
  assert.doesNotMatch(out, /Every page matches its sources/, 'no false green');
});

test('the two causes of unverifiable get their own advice line in the same report', () => {
  const root = makeProject();
  write(root, join(WIKI_DIR, 'ghost.md'), '---\nsources: src/ghost.ts\ndigest: deadbeef\n---\n# Ghost\n');
  write(root, join(WIKI_DIR, 'blank.md'), '---\nupdated: 2026-08-17\n---\n# Blank\n');
  const report = runWikiCheck(root);
  assert.equal(report.summary.unverifiable, 2);
  assert.equal(report.summary.sourcesGone, 1);
  // page.reason is the contract fia-launch-check reads to tell the causes apart.
  const byFile = Object.fromEntries(report.pages.map((p) => [p.file, p]));
  assert.equal(byFile['ai-docs/wiki/ghost.md'].reason, 'sources_gone');
  assert.equal(byFile['ai-docs/wiki/blank.md'].reason, 'no_sources');
  const out = renderWikiCheck(report);
  assert.match(out, /1 page\(s\) declare source paths that do not exist in this repo/);
  assert.match(out, /1 page\(s\) declare no sources: at all/);
});

test('a page that never declared sources is a gap, not a failure', () => {
  const root = makeProject();
  write(root, join(WIKI_DIR, 'blank.md'), '---\nupdated: 2026-08-17\n---\n# Blank\n');
  const report = runWikiCheck(root);
  assert.equal(report.summary.sourcesGone, 0);
  assert.equal(report.passed, true, '/absorb is what wires a new page up — that is not drift');
});

test('CLI: --strict exits 1 when every declared source of a page is gone', () => {
  const root = makeProject();
  write(root, 'src/a.ts', 'a\n');
  write(root, join(WIKI_DIR, 'a.md'), stampedPage(root, ['src/a.ts']));
  rmSync(join(root, 'src'), { recursive: true, force: true });

  const loose = spawnSync(process.execPath, [SCRIPT, '--dir', root], { encoding: 'utf8' });
  assert.equal(loose.status, 0, 'the plain run still only reports');

  const strict = spawnSync(process.execPath, [SCRIPT, '--dir', root, '--strict'], { encoding: 'utf8' });
  assert.equal(strict.status, 1);
  assert.match(strict.stdout, /0 fresh · 0 stale · 1 unverifiable/);
  assert.match(strict.stdout, /do not exist in this repo/);
});

test('README.md at the wiki root is not a page, but a nested one is', () => {
  const root = makeProject();
  write(root, 'src/a.ts', 'a\n');
  write(root, join(WIKI_DIR, 'README.md'), '---\nsources: src/a.ts\n---\n# How the wiki works\n');
  write(root, join(WIKI_DIR, 'areas', 'README.md'), stampedPage(root, ['src/a.ts']));
  const report = runWikiCheck(root);
  assert.deepEqual(
    report.pages.map((p) => p.file),
    ['ai-docs/wiki/areas/README.md'],
  );
  assert.equal(report.pages[0].status, 'fresh');
});

test('human blocks are counted, including two in one page', () => {
  const root = makeProject();
  write(root, 'src/a.ts', 'a\n');
  const body = [
    '# A',
    '<!-- human:start -->',
    'Keep this paragraph.',
    '<!-- human:end -->',
    'generated prose',
    '<!-- human:start -->and this one<!-- human:end -->',
    '',
  ].join('\n');
  write(root, join(WIKI_DIR, 'a.md'), stampedPage(root, ['src/a.ts'], body));
  const report = runWikiCheck(root);
  assert.equal(report.pages[0].humanBlocks, 2);
  assert.match(renderWikiCheck(report), /2 human block\(s\)/);
});

test('sources given as a YAML block list are read', () => {
  const root = makeProject();
  write(root, 'src/a.ts', 'a\n');
  write(root, 'src/b.ts', 'b\n');
  const { digest } = digestSources(root, ['src/a.ts', 'src/b.ts']);
  write(root, join(WIKI_DIR, 'list.md'), `---\nsources:\n  - src/b.ts\n  - src/a.ts\ndigest: ${digest}\n---\n# List\n`);
  const report = runWikiCheck(root);
  assert.deepEqual(report.pages[0].sources, ['src/a.ts', 'src/b.ts']);
  assert.equal(report.pages[0].status, 'fresh');
});

test('a source path escaping the root is dropped', () => {
  assert.equal(normalizeSourcePath('../outside.txt'), null);
  assert.equal(normalizeSourcePath('src/../../outside.txt'), null);
  assert.equal(normalizeSourcePath('/etc/passwd'), null);
  assert.equal(normalizeSourcePath('src/./app/'), 'src/app');
  const parsed = parseWikiPage('---\nsources: ../outside.txt, src/a.ts\ndigest: x\n---\n# A\n');
  assert.deepEqual(parsed.sources, ['src/a.ts']);

  const root = makeProject();
  write(root, join(WIKI_DIR, 'escape.md'), '---\nsources: ../../../etc/passwd\ndigest: x\n---\n# Nope\n');
  const report = runWikiCheck(root);
  assert.deepEqual(report.pages[0].sources, []);
  assert.equal(report.pages[0].status, 'unverifiable');
});

test('frontmatter markers appearing in the BODY are content, not fields', () => {
  const root = makeProject();
  write(root, 'src/a.ts', 'a\n');
  const body = [
    '# A',
    '',
    'The page format looks like this:',
    '',
    '---',
    'sources: src/does-not-exist.ts',
    'digest: 0000000000000000000000000000000000000000',
    '---',
    '',
    'That block above is documentation, not frontmatter.',
    '',
  ].join('\n');
  write(root, join(WIKI_DIR, 'meta.md'), stampedPage(root, ['src/a.ts'], body));
  const report = runWikiCheck(root);
  assert.deepEqual(report.pages[0].sources, ['src/a.ts']);
  assert.equal(report.pages[0].status, 'fresh');
});

test('parseWikiPage returns null without frontmatter and reports hasBody', () => {
  assert.equal(parseWikiPage('# Just a heading\n'), null);
  assert.equal(parseWikiPage(''), null);
  const bodyless = parseWikiPage('---\nsources: src/a.ts\n---\n');
  assert.equal(bodyless.hasBody, false);
  assert.equal(parseWikiPage('---\nupdated: today\n---\nprose\n').fields.updated, 'today');
  // CRLF pages (Windows checkouts) still parse.
  const crlf = parseWikiPage('---\r\nsources: src/a.ts\r\ndigest: abc\r\n---\r\n# A\r\n');
  assert.deepEqual(crlf.sources, ['src/a.ts']);
  assert.equal(crlf.digest, 'abc');
});

test('digestSources is stable across calls and moves when content changes', () => {
  const root = makeProject();
  write(root, 'src/a.ts', 'a\n');
  write(root, 'src/nested/b.ts', 'b\n');
  const first = digestSources(root, ['src']);
  const second = digestSources(root, ['src']);
  assert.equal(first.digest, second.digest);
  assert.deepEqual(first.files, ['src/a.ts', 'src/nested/b.ts']);
  assert.deepEqual(first.missing, []);
  assert.equal(first.truncated, false);
  // Source order must not change the digest.
  assert.equal(
    digestSources(root, ['src/nested/b.ts', 'src/a.ts']).digest,
    digestSources(root, ['src/a.ts', 'src/nested/b.ts']).digest,
  );

  write(root, 'src/a.ts', 'a2\n');
  assert.notEqual(digestSources(root, ['src']).digest, first.digest);

  // Dotfiles and heavy trees never enter the digest.
  const before = digestSources(root, ['src']).digest;
  write(root, 'src/.hidden', 'x\n');
  write(root, 'src/node_modules/pkg/index.js', 'x\n');
  assert.equal(digestSources(root, ['src']).digest, before);

  const gone = digestSources(root, ['src/nope.ts']);
  assert.deepEqual(gone.missing, ['src/nope.ts']);
  assert.deepEqual(gone.files, []);
  assert.equal(gone.digest.length, 40);
});

test('wiki plan: absent, valid, unknown preset, and malformed all degrade safely', () => {
  const root = makeProject();
  const absent = readWikiPlan(root);
  assert.equal(absent.available, false);
  assert.equal(absent.preset, 'architecture');
  assert.deepEqual(absent.include, []);
  assert.equal(absent.error, null);

  write(
    root,
    join(WIKI_DIR, PLAN_FILE),
    'preset: product\ninclude:\n  - src/**\nexclude:\n  - src/generated/**\npages:\n  - auth\n  - billing\nguidance: keep it short\n',
  );
  const valid = readWikiPlan(root);
  assert.equal(valid.available, true);
  assert.equal(valid.preset, 'product');
  assert.deepEqual(valid.include, ['src/**']);
  assert.deepEqual(valid.exclude, ['src/generated/**']);
  assert.deepEqual(valid.pages, ['auth', 'billing']);
  assert.equal(valid.guidance, 'keep it short');
  assert.equal(valid.error, null);

  write(root, join(WIKI_DIR, PLAN_FILE), 'preset: whatever\n');
  const typo = readWikiPlan(root);
  assert.equal(typo.preset, 'architecture');
  assert.match(typo.error, /unknown preset "whatever"/);

  write(root, join(WIKI_DIR, PLAN_FILE), 'preset: [unclosed\n  bad: : :\n');
  const broken = readWikiPlan(root);
  assert.equal(broken.available, false);
  assert.equal(broken.preset, 'architecture');
  assert.match(broken.error, /wiki-plan\.yaml/);
  // A malformed plan never blocks the freshness check.
  const report = runWikiCheck(root);
  assert.equal(report.available, true);
  assert.equal(report.plan.available, false);
  assert.match(renderWikiCheck(report), /wiki-plan\.yaml/);
});

test('FIA_AI_DOCS / opts.aiDocsDir relocate the wiki', () => {
  const root = makeProject();
  const elsewhere = mkdtempSync(join(tmpdir(), 'wiki-check-docs-'));
  mkdirSync(join(elsewhere, 'wiki'), { recursive: true });
  write(root, 'src/a.ts', 'a\n');
  writeFileSync(join(elsewhere, 'wiki', 'a.md'), stampedPage(root, ['src/a.ts']));
  const report = runWikiCheck(root, { aiDocsDir: elsewhere });
  assert.equal(report.available, true);
  assert.equal(report.summary.fresh, 1);

  const previous = process.env.FIA_AI_DOCS;
  process.env.FIA_AI_DOCS = elsewhere;
  try {
    assert.equal(runWikiCheck(root).summary.fresh, 1);
  } finally {
    if (previous == null) delete process.env.FIA_AI_DOCS;
    else process.env.FIA_AI_DOCS = previous;
  }
});

test('a relative FIA_AI_DOCS resolves against the project root, not the process cwd', () => {
  const root = mkdtempSync(join(tmpdir(), 'wiki-check-relative-docs-'));
  mkdirSync(join(root, 'docs', 'wiki'), { recursive: true });
  write(root, 'src/a.ts', 'a\n');
  writeFileSync(join(root, 'docs', 'wiki', 'a.md'), stampedPage(root, ['src/a.ts']));

  const previous = process.env.FIA_AI_DOCS;
  process.env.FIA_AI_DOCS = 'docs';
  try {
    const report = runWikiCheck(root);
    assert.equal(report.available, true, 'a relative override must not bind to the process cwd');
    assert.equal(report.summary.fresh, 1);
    assert.equal(report.dir, 'docs/wiki');
  } finally {
    if (previous == null) delete process.env.FIA_AI_DOCS;
    else process.env.FIA_AI_DOCS = previous;
  }
});

test('the digest ignores line endings, so a CRLF checkout never goes stale on its own', () => {
  const root = makeProject('wiki-check-crlf-digest');
  write(root, 'src/a.ts', 'export const a = 1;\nexport const b = 2;\n');
  write(root, join(WIKI_DIR, 'a.md'), stampedPage(root, ['src/a.ts']));
  assert.equal(runWikiCheck(root).summary.fresh, 1);

  // Same content re-checked out with core.autocrlf=true (Git for Windows).
  write(root, 'src/a.ts', 'export const a = 1;\r\nexport const b = 2;\r\n');
  const report = runWikiCheck(root);
  assert.equal(report.summary.stale, 0, 'CRLF alone is not a content change');
  assert.equal(report.summary.fresh, 1);

  // A real edit still moves the digest, CRLF and all.
  write(root, 'src/a.ts', 'export const a = 2;\r\nexport const b = 2;\r\n');
  assert.equal(runWikiCheck(root).summary.stale, 1);
});

test('binary sources keep the raw-byte digest', () => {
  const root = makeProject('wiki-check-binary-digest');
  writeFileSync(join(root, 'blob.bin'), Buffer.from([0x00, 0x0d, 0x0a, 0x01]));
  const first = digestSources(root, ['blob.bin']).digest;
  writeFileSync(join(root, 'blob.bin'), Buffer.from([0x00, 0x0a, 0x01]));
  assert.notEqual(digestSources(root, ['blob.bin']).digest, first, 'a NUL-bearing file is hashed byte for byte');
});

test('the plan names declared pages that have no file on disk yet', () => {
  const root = makeProject('wiki-check-plan-pages');
  write(root, 'src/a.ts', 'a\n');
  write(root, join(WIKI_DIR, PLAN_FILE), 'pages:\n  - auth\n  - data\n  - ui\n');
  write(root, join(WIKI_DIR, 'auth.md'), stampedPage(root, ['src/a.ts']));
  const report = runWikiCheck(root);
  assert.deepEqual(report.summary.plannedMissing, ['data', 'ui']);
  assert.equal(report.passed, true, 'a page-less plan entry is a named gap, not a failure');
  assert.match(renderWikiCheck(report), /no file yet: data, ui/);
});

test('a plan whose every page is missing reports them all; a nested or suffixed match counts as present', () => {
  const root = makeProject('wiki-check-plan-empty');
  write(root, join(WIKI_DIR, PLAN_FILE), 'pages:\n  - auth\n  - data\n  - ui\n');
  const empty = runWikiCheck(root);
  assert.equal(empty.summary.total, 0);
  assert.deepEqual(empty.summary.plannedMissing, ['auth', 'data', 'ui']);

  write(root, 'src/a.ts', 'a\n');
  write(root, join(WIKI_DIR, PLAN_FILE), 'pages:\n  - areas/auth.md\n  - Data\n');
  write(root, join(WIKI_DIR, 'areas', 'auth.md'), stampedPage(root, ['src/a.ts']));
  write(root, join(WIKI_DIR, 'data.md'), stampedPage(root, ['src/a.ts']));
  assert.deepEqual(runWikiCheck(root).summary.plannedMissing, []);
});

test('CLI: --json prints pure JSON and exits 0 on a fresh wiki', () => {
  const root = makeProject();
  write(root, 'src/a.ts', 'a\n');
  write(root, join(WIKI_DIR, 'a.md'), stampedPage(root, ['src/a.ts']));
  const stdout = execFileSync(process.execPath, [SCRIPT, '--dir', root, '--json'], { encoding: 'utf8' });
  assert.equal(stdout.trimStart().startsWith('{'), true);
  const report = JSON.parse(stdout);
  assert.equal(report.available, true);
  assert.equal(report.passed, true);
  assert.equal(report.pages[0].file, 'ai-docs/wiki/a.md');
  const strict = spawnSync(process.execPath, [SCRIPT, '--dir', root, '--strict'], { encoding: 'utf8' });
  assert.equal(strict.status, 0);
  assert.match(strict.stdout, /1 fresh · 0 stale/);
});

test('CLI: --strict exits 1 when a page is stale, plain run still exits 0', () => {
  const root = makeProject();
  write(root, 'src/a.ts', 'a\n');
  write(root, join(WIKI_DIR, 'a.md'), stampedPage(root, ['src/a.ts']));
  write(root, 'src/a.ts', 'a changed\n');

  const loose = spawnSync(process.execPath, [SCRIPT, '--dir', root], { encoding: 'utf8' });
  assert.equal(loose.status, 0);
  assert.match(loose.stdout, /1 stale/);

  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [SCRIPT, '--dir', root, '--strict'], { encoding: 'utf8' });
  } catch (err) {
    status = err.status;
    stdout = String(err.stdout || '');
  }
  assert.equal(status, 1);
  assert.match(stdout, /src\/a\.ts/);
});

test('CLI: a project without a wiki exits 0 and says so once', () => {
  const root = mkdtempSync(join(tmpdir(), 'wiki-check-cli-empty-'));
  const r = spawnSync(process.execPath, [SCRIPT, '--dir', root, '--strict'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\/absorb/);
});

// ── --stamp: the one writing mode ────────────────────────────────────────────

test('stamp: a stale page is re-stamped and its body — human blocks included — is byte-identical', () => {
  const root = makeProject('wiki-stamp');
  write(root, 'src/auth.ts', 'export const a = 1;\n');
  const body = '# Auth\n\nProse.\n\n<!-- human:start -->hand-written, must survive<!-- human:end -->\n';
  write(root, `${WIKI_DIR}/auth.md`, `---\nupdated: 2020-01-01\nsources: src/auth.ts\ndigest: deadbeef\n---\n${body}`);

  assert.equal(runWikiCheck(root).summary.stale, 1);
  const result = stampWikiPages(root, { lock: null });
  assert.equal(result.blocked, null);
  assert.equal(result.stamped.length, 1);
  assert.equal(result.stamped[0].file, 'ai-docs/wiki/auth.md');
  assert.deepEqual(result.skipped, []);

  const after = readFileSync(join(root, WIKI_DIR, 'auth.md'), 'utf8');
  assert.ok(after.endsWith(body), 'the body was concatenated back untouched');
  assert.match(after, /<!-- human:start -->hand-written, must survive<!-- human:end -->/);
  assert.equal(runWikiCheck(root).summary.stale, 0, 'the page is fresh once stamped');
  assert.equal(runWikiCheck(root).summary.fresh, 1);
});

test('stamp: a fresh wiki stamps nothing, and the renderer says so', () => {
  const root = makeProject('wiki-stamp-noop');
  write(root, 'src/a.ts', 'a\n');
  write(root, `${WIKI_DIR}/a.md`, stampedPage(root, ['src/a.ts']));
  const result = stampWikiPages(root, { lock: null });
  assert.deepEqual(result.stamped, []);
  assert.deepEqual(result.skipped, []);
  assert.match(renderStamp(result), /nothing to stamp/);
});

test('stamp: a page with no digest field gains one, above the closing delimiter', () => {
  const root = makeProject('wiki-stamp-insert');
  write(root, 'src/a.ts', 'a\n');
  write(root, `${WIKI_DIR}/a.md`, `---\nsources: src/a.ts\n---\n# A\n`);
  assert.equal(runWikiCheck(root).pages[0].status, 'stale', 'no digest recorded reads as stale');
  const result = stampWikiPages(root, { lock: null });
  assert.equal(result.stamped.length, 1);
  const after = readFileSync(join(root, WIKI_DIR, 'a.md'), 'utf8');
  assert.match(after, /^---\nsources: src\/a\.ts\ndigest: [0-9a-f]{40}\nupdated: \d{4}-\d{2}-\d{2}\n---\n# A\n$/);
  assert.equal(runWikiCheck(root).summary.fresh, 1);
});

test('stamp: CRLF line endings survive the rewrite', () => {
  const root = makeProject('wiki-stamp-crlf');
  write(root, 'src/a.ts', 'a\n');
  write(root, `${WIKI_DIR}/a.md`, `---\r\nsources: src/a.ts\r\ndigest: nope\r\n---\r\n# A\r\n`);
  stampWikiPages(root, { lock: null });
  const after = readFileSync(join(root, WIKI_DIR, 'a.md'), 'utf8');
  assert.ok(after.includes('\r\n'), 'CRLF preserved');
  assert.ok(!/[^\r]\n/.test(after), 'no lone LF was introduced');
  assert.equal(runWikiCheck(root).summary.fresh, 1);
});

test('stamp: a page whose every source is gone is skipped with a reason, never stamped', () => {
  const root = makeProject('wiki-stamp-gone');
  write(root, `${WIKI_DIR}/a.md`, `---\nsources: src/gone.ts\ndigest: deadbeef\n---\n# A\n`);
  const result = stampWikiPages(root, { lock: null });
  assert.deepEqual(result.stamped, []);
  // Every source missing is 'unverifiable', not 'stale' — nothing to stamp at all.
  assert.deepEqual(result.skipped, []);
  assert.equal(result.report.pages[0].status, 'unverifiable');
});

test('stamp: an ai-docs dir OUTSIDE the project root is stamped where the page really lives', () => {
  const root = mkdtempSync(join(tmpdir(), 'wiki-stamp-outside-'));
  const docs = mkdtempSync(join(tmpdir(), 'wiki-stamp-outside-docs-'));
  mkdirSync(join(docs, 'wiki'), { recursive: true });
  write(root, 'src/a.ts', 'a\n');
  const real = join(docs, 'wiki', 'a.md');
  writeFileSync(real, `---\nsources: src/a.ts\ndigest: deadbeef\n---\n# A\n`);
  // A same-named in-repo page: the old code rebuilt the write target from the
  // display string and corrupted THIS file instead of the real one.
  const decoy = `---\nsources: src/a.ts\ndigest: deadbeef\n---\n# Decoy\n`;
  write(root, join(WIKI_DIR, 'a.md'), decoy);

  const opts = { aiDocsDir: docs, lock: null };
  assert.equal(runWikiCheck(root, opts).summary.stale, 1);
  const result = stampWikiPages(root, opts);
  assert.equal(result.blocked, null);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.stamped.length, 1);
  assert.match(readFileSync(real, 'utf8'), /^---\nsources: src\/a\.ts\ndigest: [0-9a-f]{40}\n/);
  assert.equal(runWikiCheck(root, opts).summary.fresh, 1, 'the real page reads fresh afterwards');
  assert.equal(readFileSync(join(root, WIKI_DIR, 'a.md'), 'utf8'), decoy, 'the in-repo page was never touched');
});

test('stamp: a page entry that lost its carried path is skipped with a reason, never mis-written', () => {
  const root = makeProject('wiki-stamp-lost-path');
  write(root, 'src/a.ts', 'a\n');
  write(root, `${WIKI_DIR}/a.md`, `---\nsources: src/a.ts\ndigest: deadbeef\n---\n# A\n`);
  const report = runWikiCheck(root);
  // A report rebuilt by a caller (spread, JSON round-trip) drops `abs`; a page
  // whose display prefix no longer matches the wiki root cannot be located.
  const rebuilt = { ...report, pages: report.pages.map((p) => ({ ...p, file: `elsewhere/${p.file}` })) };
  const result = stampWikiPages(root, { lock: null, report: rebuilt });
  assert.deepEqual(result.stamped, []);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /cannot be located/);
});

test('stamp: a live FDA lock blocks the write entirely and names the run', () => {
  const root = makeProject('wiki-stamp-lock');
  write(root, 'src/a.ts', 'a\n');
  const page = `---\nsources: src/a.ts\ndigest: deadbeef\n---\n# A\n`;
  write(root, `${WIKI_DIR}/a.md`, page);
  const result = stampWikiPages(root, { lock: { fda_id: 'r_live1', pid: 4242 } });
  assert.match(result.blocked, /r_live1/);
  assert.deepEqual(result.stamped, []);
  assert.equal(readFileSync(join(root, WIKI_DIR, 'a.md'), 'utf8'), page, 'nothing was written');
  assert.match(renderStamp(result), /^✗ /);
});

test('CLI: --stamp rewrites the digest and exits 0; --stamp --json is pure JSON', () => {
  const root = makeProject('wiki-stamp-cli');
  write(root, 'src/a.ts', 'a\n');
  write(root, `${WIKI_DIR}/a.md`, `---\nsources: src/a.ts\ndigest: deadbeef\n---\n# A\n`);

  const out = execFileSync(process.execPath, [SCRIPT, '--stamp', '--dir', root], { encoding: 'utf8' });
  assert.match(out, /Stamped 1 page\(s\)/);

  // Already fresh now: a second --stamp is a no-op and stays exit 0.
  const again = spawnSync(process.execPath, [SCRIPT, '--stamp', '--json', '--dir', root], { encoding: 'utf8' });
  assert.equal(again.status, 0);
  const parsed = JSON.parse(again.stdout);
  assert.deepEqual(parsed, { blocked: null, stamped: [], skipped: [] });
});

test('CLI: --stamp refuses while an FDA lock is live (exit 1, nothing written)', () => {
  const root = makeProject('wiki-stamp-cli-lock');
  write(root, 'src/a.ts', 'a\n');
  const page = `---\nsources: src/a.ts\ndigest: deadbeef\n---\n# A\n`;
  write(root, `${WIKI_DIR}/a.md`, page);
  // From the child's point of view this test process is a live foreign pid.
  write(
    root,
    join('imp', 'data', '.fda.lock'),
    JSON.stringify({ pid: process.pid, fda_id: 'r_busy', runner: 'fda_sdlc', started_at: new Date(0).toISOString() }),
  );
  const r = spawnSync(process.execPath, [SCRIPT, '--stamp', '--dir', root], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /r_busy/);
  assert.equal(readFileSync(join(root, WIKI_DIR, 'a.md'), 'utf8'), page);
});

test('a wiki with zero pages never claims "every page matches" — that is the day-one state', () => {
  // The harness SHIPS ai-docs/wiki/ with its README explainer, so every fresh
  // install starts here. Closing a page-less report with a green reassurance
  // reads as "the wiki is doing its job" for a wiki nobody has written.
  const root = makeProject('wiki-dayone');
  write(root, `${WIKI_DIR}/README.md`, '# The repo wiki\n\nThe page contract, not a page.\n');
  const report = runWikiCheck(root);
  assert.equal(report.summary.total, 0);
  assert.equal(report.passed, true, 'nothing stale is still a pass — it just proves nothing');
  const out = renderWikiCheck(report);
  assert.match(out, /has no pages/);
  assert.doesNotMatch(out, /Every page matches its sources/, 'no false green on an empty wiki');
  assert.match(out, /\/absorb/, 'names the command that changes the situation');
});
