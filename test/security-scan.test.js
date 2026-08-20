import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join, parse, relative } from 'node:path';
import { tmpdir } from 'node:os';
import {
  RULES,
  SEVERITIES,
  listSourceFiles,
  renderSecurityScan,
  runSecurityScan,
  scanText,
  toSarif,
} from '../fia-templates/scripts/security-scan.mjs';

const SCRIPT = join(import.meta.dirname, '..', 'fia-templates', 'scripts', 'security-scan.mjs');

/** A throwaway project tree. Nothing is cleaned up — deliberate. */
function project(files) {
  const root = mkdtempSync(join(tmpdir(), 'sec-scan-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

const idsOf = (report) => report.findings.map((f) => f.ruleId);
const run = (args, root) => spawnSync(process.execPath, [SCRIPT, '--dir', root, ...args], { encoding: 'utf8' });

// ── planted positives: every rule must fire ──────────────────────────────────

const POSITIVES = {
  'app/danger.tsx': `export const Body = ({ html }) => <div dangerouslySetInnerHTML={{ __html: html }} />;\n`,
  'app/sql.ts': [
    'export async function byId(db, id) {',
    '  return db.query(`SELECT * FROM users WHERE id = ${id}`);',
    '}',
    'export async function byName(db, name) {',
    "  return db.execute('SELECT * FROM users WHERE name = ' + name);",
    '}',
    '',
  ].join('\n'),
  'app/jwt.ts': "import { jwtDecode } from 'jwt-decode';\nexport const who = (token) => jwtDecode(token).sub;\n",
  'app/env.ts': 'export const t = process.env.NEXT_PUBLIC_API_SECRET_TOKEN;\n',
  'app/dyn.ts': 'export const run = (src) => eval(src);\n',
  'app/spawn.ts': "import { spawnSync } from 'node:child_process';\nspawnSync(cmd, { shell: true });\n",
  'app/urls.ts': "export const API = 'http://api.acme-internal.test/v1';\n",
  'app/api/things/route.ts': [
    'export async function POST(req) {',
    '  const body = await req.json();',
    '  return Response.json({ ok: true, body });',
    '}',
    '',
  ].join('\n'),
  'proxy.ts': "import { createRouteMatcher } from '@clerk/nextjs/server';\n",
  'convex/messages.ts': [
    "import { mutation } from './_generated/server';",
    'export const send = mutation({',
    '  handler: async (ctx, { text }) => ctx.db.insert("messages", { text }),',
    '});',
    '',
  ].join('\n'),
  'app/keys.ts': "export const stripe = 'sk_live_51H8xAbCdEfGhIjKlMnOpQr';\n",
};

test('every rule fires on a planted positive', () => {
  const report = runSecurityScan(project(POSITIVES));
  assert.equal(report.available, true);
  const found = new Set(idsOf(report));
  for (const rule of RULES) assert.ok(found.has(rule.id), `rule ${rule.id} did not fire on its positive`);
});

test('the report shape is exactly the contract', () => {
  const report = runSecurityScan(project({ 'app/dyn.ts': 'export const r = (s) => eval(s);\n' }));
  assert.deepEqual(Object.keys(report), ['available', 'findings', 'summary', 'rules']);
  assert.deepEqual(Object.keys(report.summary), ['high', 'medium', 'low', 'total', 'filesScanned', 'truncated']);
  const [finding] = report.findings;
  assert.deepEqual(Object.keys(finding), ['ruleId', 'severity', 'title', 'file', 'line', 'excerpt', 'fix']);
  assert.equal(finding.ruleId, 'eval_usage');
  assert.equal(finding.severity, 'high');
  assert.equal(finding.file, 'app/dyn.ts');
  assert.equal(finding.line, 1);
  assert.equal(finding.excerpt, 'export const r = (s) => eval(s);');
  assert.match(finding.fix, /[a-z]/);
  assert.equal(report.summary.high, 1);
  assert.equal(report.summary.total, 1);
  assert.equal(report.summary.filesScanned, 1);
  assert.equal(report.summary.truncated, false);
  // Every rule is listed, zero-hit ones included.
  assert.equal(report.rules.length, RULES.length);
  assert.equal(report.rules.find((r) => r.id === 'eval_usage').hits, 1);
  assert.equal(report.rules.find((r) => r.id === 'http_url').hits, 0);
});

// ── near-miss negatives: the shapes that must stay silent ────────────────────

const NEGATIVES = {
  // PostHog's Project API key is browser-side BY DESIGN (`phc_…`) and THIS
  // installer prompts for it, so flagging it told students to rotate a public
  // key and made day-one `security:scan` cry wolf on the product's own code.
  'app/posthog-provider.tsx':
    'if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return null;\n// NEXT_PUBLIC_POSTHOG_KEY is public by design\n',

  // Parameterized query + tagged sql template + a plain interpolated string.
  'app/safe-sql.ts': [
    "export const byId = (db, id) => db.query('SELECT * FROM users WHERE id = $1', [id]);",
    'export const tagged = (id) => sql`SELECT * FROM users WHERE id = ${id}`;',
    'export const label = (n) => `rows: ${n}`;',
    'export const cache = (qc) => qc.invalidateQueries({ queryKey: ["users"] });',
    '',
  ].join('\n'),
  // Decode present, but the file verifies too.
  'app/safe-jwt.ts': [
    "import { jwtVerify } from 'jose';",
    "import { jwtDecode } from 'jwt-decode';",
    'export const who = async (token, key) => (await jwtVerify(token, key)) && jwtDecode(token).sub;',
    '',
  ].join('\n'),
  // The four public-by-design key names.
  'app/safe-env.ts': [
    'export const pk = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;',
    'export const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;',
    'export const maps = process.env.NEXT_PUBLIC_MAPS_API_KEY;',
    'export const convex = process.env.NEXT_PUBLIC_CONVEX_URL;',
    'export const secret = process.env.CLERK_SECRET_KEY;',
    '',
  ].join('\n'),
  // Every documented http_url exclusion, one per line.
  'app/safe-urls.ts': [
    "export const dev = 'http://localhost:3000';",
    "export const loop = 'http://127.0.0.1:8080';",
    "export const any = 'http://0.0.0.0:3000';",
    "export const v6 = 'http://[::1]:9229';",
    "export const ns = 'http://www.w3.org/2000/svg';",
    "export const ooxml = 'http://schemas.openxmlformats.org/x';",
    "export const draft = 'http://json-schema.org/draft-07/schema#';",
    '',
  ].join('\n'),
  // A shell-free spawn, plus an identifier that merely reads like the pattern.
  'app/safe-spawn.ts': [
    "import { spawn, spawnSync } from 'node:child_process';",
    'export const sync = (bin, args) => spawnSync(bin, args, { shell: false });',
    'export const async = (bin, args) => spawn(bin, args);',
    'export const shellTrue = false;',
    '',
  ].join('\n'),
  // A route handler that DOES check auth.
  'app/api/safe/route.ts': [
    "import { auth } from '@clerk/nextjs/server';",
    'export async function POST(req) {',
    '  const { userId } = await auth();',
    "  if (!userId) return new Response('unauthorized', { status: 401 });",
    '  return Response.json({ ok: true, body: await req.json() });',
    '}',
    '',
  ].join('\n'),
  'convex/safe.ts': [
    "import { v } from 'convex/values';",
    "import { mutation } from './server';",
    'export const send = mutation({',
    '  args: { text: v.string() },',
    '  handler: async (ctx, { text }) => ctx.db.insert("messages", { text }),',
    '});',
    '',
  ].join('\n'),
  'app/safe-misc.ts': [
    'export const key = process.env.STRIPE_SECRET_KEY;',
    "export const cls = 're_render';",
    'export const evaluate = (x) => evaluateExpression(x);',
    'export const m = new Map();',
    '',
  ].join('\n'),
  'proxy.ts': [
    "import { clerkMiddleware } from '@clerk/nextjs/server';",
    'export default clerkMiddleware();',
    '',
  ].join('\n'),
};

test('near-miss negatives produce zero findings', () => {
  const report = runSecurityScan(project(NEGATIVES));
  assert.equal(report.available, true);
  assert.deepEqual(report.findings, []);
  assert.equal(report.summary.total, 0);
  assert.ok(report.summary.filesScanned >= 7);
});

/**
 * The negative fixture that pins each rule's near-miss shape. A rule with no
 * entry here has nothing stopping its pattern from being widened, so the
 * structural guard below refuses to let one ship.
 *
 * `dangerous_html` is the one documented exemption: its pattern is a bare
 * identifier that is a real finding wherever it appears, so no safe shape of it
 * exists to pin.
 */
const NEGATIVE_FIXTURES = Object.freeze({
  raw_sql_interpolation: 'app/safe-sql.ts',
  jwt_decode_without_verify: 'app/safe-jwt.ts',
  public_env_secret: 'app/safe-env.ts',
  eval_usage: 'app/safe-misc.ts',
  child_process_shell_true: 'app/safe-spawn.ts',
  http_url: 'app/safe-urls.ts',
  missing_auth_check: 'app/api/safe/route.ts',
  clerk_route_matcher: 'proxy.ts',
  convex_missing_args_validator: 'convex/safe.ts',
  hardcoded_secret_literal: 'app/safe-misc.ts',
});
const NEGATIVE_EXEMPT = Object.freeze(['dangerous_html']);

test('structural guard: every rule has a planted positive AND a near-miss negative fixture', () => {
  const positives = runSecurityScan(project(POSITIVES));
  const fired = new Set(idsOf(positives));
  const negatives = runSecurityScan(project(NEGATIVES));
  assert.equal(negatives.available, true);
  assert.deepEqual(negatives.findings, []);
  // Pinned to the fixture count: a rule added without its negative fixture
  // fails here instead of silently shipping a pattern nothing can widen-test.
  assert.ok(
    negatives.summary.filesScanned >= Object.keys(NEGATIVES).length,
    `only ${negatives.summary.filesScanned} of ${Object.keys(NEGATIVES).length} negative fixtures were scanned`,
  );
  for (const rule of RULES) {
    assert.ok(fired.has(rule.id), `rule ${rule.id} has no planted positive`);
    if (NEGATIVE_EXEMPT.includes(rule.id)) continue;
    const fixture = NEGATIVE_FIXTURES[rule.id];
    assert.ok(fixture, `rule ${rule.id} has no negative fixture in NEGATIVE_FIXTURES`);
    assert.ok(NEGATIVES[fixture], `the negative fixture ${fixture} for ${rule.id} does not exist`);
    // The fixture must be silent ON ITS OWN, not only alongside the others.
    const alone = runSecurityScan(project({ [fixture]: NEGATIVES[fixture] }), { ruleIds: [rule.id] });
    assert.equal(alone.available, true, `${fixture} was not scanned at all`);
    assert.equal(alone.summary.filesScanned, 1, `${fixture} was not the only file scanned`);
    assert.deepEqual(alone.findings, [], `${rule.id} fired on its negative fixture ${fixture}`);
  }
});

test('legitimate public keys and an authed route handler are silent on their own', () => {
  const env = runSecurityScan(project({ 'app/safe-env.ts': NEGATIVES['app/safe-env.ts'] }));
  assert.deepEqual(idsOf(env), []);
  const route = runSecurityScan(project({ 'app/api/safe/route.ts': NEGATIVES['app/api/safe/route.ts'] }));
  assert.deepEqual(idsOf(route), []);
});

test('a secret-named _KEY variable still fires even though PUBLISHABLE_KEY does not', () => {
  const report = runSecurityScan(
    project({
      'app/keys.ts': [
        'export const a = process.env.NEXT_PUBLIC_SIGNING_KEY;',
        'export const b = process.env.VITE_APP_PASSWORD;',
        'export const c = process.env.PUBLIC_PRIVATE_NOTE;',
        '',
      ].join('\n'),
    }),
  );
  assert.deepEqual(
    report.findings.map((f) => f.line),
    [1, 2, 3],
  );
  assert.ok(report.findings.every((f) => f.ruleId === 'public_env_secret'));
});

// ── the bug this lane fixes, plus the documented exclusions ──────────────────

test('src/ layout files are scanned (the launch check only saw app/ + components/)', () => {
  const report = runSecurityScan(
    project({
      'src/lib/db.ts': ['export const bad = (db, id) => db.query(`SELECT * FROM t WHERE id = ${id}`);', ''].join('\n'),
      'src/app/page.tsx': 'export default () => <div dangerouslySetInnerHTML={{ __html: h }} />;\n',
    }),
  );
  assert.deepEqual(
    report.findings.map((f) => `${f.ruleId} ${f.file}:${f.line}`),
    ['raw_sql_interpolation src/lib/db.ts:1', 'dangerous_html src/app/page.tsx:1'],
  );
});

test('a scan root that ends in a separator still reports whole paths', () => {
  const root = project({ 'app/page.tsx': 'export default () => <div dangerouslySetInnerHTML={{ __html: h }} />;\n' });
  // The filesystem/drive root is the one path resolve() leaves with a trailing
  // separator ('/' stays '/', 'C:\' stays 'C:\'), so it is the only way to
  // exercise the off-by-one. Only the fixture's app/ dir is ever walked.
  const fsRoot = parse(root).root;
  const appRoot = relative(fsRoot, join(root, 'app'));
  const expected = relative(fsRoot, join(root, 'app', 'page.tsx')).replaceAll('\\', '/');
  const report = runSecurityScan(fsRoot, { roots: [appRoot] });
  assert.equal(report.available, true);
  assert.deepEqual(
    report.findings.map((f) => f.file),
    [expected],
  );
  // The SARIF uri is the same string, so a code-scanning annotation resolves.
  const uri = toSarif(report).runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri;
  assert.equal(uri, expected);
});

test('convex/lib and _generated are excluded from the convex rule', () => {
  const body = ['export const send = mutation({', '  handler: async () => null,', '});', ''].join('\n');
  const report = runSecurityScan(
    project({
      'convex/lib/helpers.ts': body,
      'convex/_generated/server.ts': body,
      'convex/messages.ts': body,
    }),
  );
  assert.deepEqual(
    report.findings.map((f) => f.file),
    ['convex/messages.ts'],
  );
});

// ── free-text edge cases (the marker AS CONTENT) ─────────────────────────────

test('an L1 pattern inside a comment still fires — the scan is textual by design', () => {
  const report = runSecurityScan(
    project({
      'app/notes.tsx': [
        '// House rule: never use dangerouslySetInnerHTML with user content.',
        'export const Safe = ({ text }) => <p>{text}</p>;',
        '',
      ].join('\n'),
    }),
  );
  assert.deepEqual(idsOf(report), ['dangerous_html']);
  assert.equal(report.findings[0].line, 1);
});

test('an absentPattern veto is generous: the word in a comment silences the rule', () => {
  const commentOnly = runSecurityScan(
    project({
      'app/api/x/route.ts': [
        '// TODO: add the auth check before shipping this.',
        'export async function DELETE() {',
        '  return Response.json({ ok: true });',
        '}',
        '',
      ].join('\n'),
    }),
  );
  assert.deepEqual(idsOf(commentOnly), []);
  // Without any such mention, the same handler is reported.
  const handler = ['export async function DELETE() {', '  return Response.json({ ok: true });', '}', ''].join('\n');
  const bare = runSecurityScan(project({ 'app/api/x/route.ts': handler }));
  assert.deepEqual(idsOf(bare), ['missing_auth_check']);
  assert.equal(bare.findings[0].line, 1);
});

test('missing_auth_check only looks at route handler files', () => {
  const report = runSecurityScan(
    project({ 'app/api/x/handler.ts': 'export async function POST() {\n  return null;\n}\n' }),
  );
  assert.deepEqual(idsOf(report), []);
});

// ── ordering, options, degradation ───────────────────────────────────────────

test('findings are sorted by severity, then file, then line — identical across two runs', () => {
  const root = project({
    'components/z.tsx': 'export const Z = () => <div dangerouslySetInnerHTML={{ __html: h }} />;\n',
    'app/a.ts': ["export const u = 'http://acme-internal.test';", 'export const r = (s) => eval(s);', ''].join('\n'),
    'app/b.ts': "export const k = 'whsec_abcdefghijklmnop';\n",
  });
  const first = runSecurityScan(root);
  const second = runSecurityScan(root);
  assert.deepEqual(first, second);
  assert.equal(renderSecurityScan(first), renderSecurityScan(second));
  assert.deepEqual(
    first.findings.map((f) => `${f.severity} ${f.file}:${f.line}`),
    ['high app/a.ts:2', 'high app/b.ts:1', 'medium components/z.tsx:1', 'low app/a.ts:1'],
  );
});

test('available is false on an empty directory and the renderer says so', () => {
  const report = runSecurityScan(mkdtempSync(join(tmpdir(), 'sec-scan-empty-')));
  assert.equal(report.available, false);
  assert.deepEqual(report.findings, []);
  assert.equal(report.summary.filesScanned, 0);
  assert.match(renderSecurityScan(report), /none of the scan roots exist/);
});

test('the file cap surfaces as truncated in the report AND in the renderer', () => {
  const root = project({
    'app/a.ts': 'export const r = (s) => eval(s);\n',
    'app/b.ts': 'export const q = (s) => eval(s);\n',
  });
  const report = runSecurityScan(root, { maxFiles: 1 });
  assert.equal(report.summary.truncated, true);
  assert.equal(report.summary.filesScanned, 1);
  assert.match(renderSecurityScan(report), /FILE CAP REACHED/);
  assert.equal(runSecurityScan(root).summary.truncated, false);
});

test('ruleIds restricts the run and the rules list', () => {
  const report = runSecurityScan(project(POSITIVES), { ruleIds: ['eval_usage'] });
  assert.deepEqual(idsOf(report), ['eval_usage']);
  assert.deepEqual(report.rules, [{ id: 'eval_usage', severity: 'high', hits: 1 }]);
});

test('opts.roots overrides the source roots but never widens the convex rule', () => {
  const root = project({
    'weird/a.ts': 'export const r = (s) => eval(s);\n',
    'convex/messages.ts': POSITIVES['convex/messages.ts'],
  });
  const report = runSecurityScan(root, { roots: ['weird'] });
  assert.deepEqual(
    report.findings.map((f) => f.file),
    ['weird/a.ts', 'convex/messages.ts'],
  );
  // app/ is no longer scanned once the roots are overridden.
  const narrowed = runSecurityScan(project({ 'app/a.ts': 'export const r = (s) => eval(s);\n' }), { roots: ['weird'] });
  assert.equal(narrowed.available, false);
});

test('the renderer caps a rule at 5 findings with a (+N) suffix and states the totals', () => {
  const files = {};
  for (let i = 1; i <= 7; i++) files[`app/f${i}.ts`] = 'export const r = (s) => eval(s);\n';
  const report = runSecurityScan(project(files));
  const text = renderSecurityScan(report);
  assert.equal((text.match(/app\/f\d\.ts:1/g) || []).length, 5);
  assert.match(text, /\(\+2\)/);
  assert.match(text, /Result: 7 high · 0 medium · 0 low · 7 finding\(s\) · 7 file\(s\) scanned/);
});

test('a clean project renders the file count, not an empty report', () => {
  const text = renderSecurityScan(runSecurityScan(project({ 'app/page.tsx': 'export default () => null;\n' })));
  assert.match(text, /no L1 findings across 1 file\(s\)/);
});

// ── the pure units ──────────────────────────────────────────────────────────

test('scanText returns 1-indexed lines with a trimmed excerpt capped at 160 chars', () => {
  const rule = RULES.find((r) => r.id === 'eval_usage');
  const long = `  const x = eval('${'a'.repeat(300)}');`;
  const hits = scanText(['const ok = 1;', long, 'const y = 2;'].join('\n'), rule);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2);
  assert.equal(hits[0].excerpt.length, 160);
  assert.ok(hits[0].excerpt.startsWith("const x = eval('"));
  assert.deepEqual(scanText('', rule), []);
  assert.deepEqual(scanText(null, rule), []);
  assert.deepEqual(scanText('eval(1)', null), []);
});

test('scanText never loses hits to a stateful regex', () => {
  const rule = { id: 'g', severity: 'low', title: 't', roots: [], exts: [], pattern: /eval\(/g, fix: 'f' };
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(
      scanText('eval(1)\neval(2)\n', rule).map((h) => h.line),
      [1, 2],
    );
  }
});

test('listSourceFiles is bounded, sorted and skips the noise directories', () => {
  const root = project({
    'app/b.ts': '',
    'app/a.tsx': '',
    'app/.hidden/x.ts': '',
    'app/node_modules/pkg/index.js': '',
    'app/dist/out.js': '',
    'app/build/out.js': '',
    'app/coverage/lcov.js': '',
    'app/.next/chunk.js': '',
    'app/_generated/api.ts': '',
    'app/notes.md': '',
    'src/a/b/c/d/deep.ts': '',
    'other/x.ts': '',
  });
  const files = listSourceFiles(root).map((f) => f.replaceAll('\\', '/').slice(root.length + 1));
  assert.deepEqual(files, ['app/a.tsx', 'app/b.ts', 'src/a/b/c/d/deep.ts']);
  assert.deepEqual(listSourceFiles(root, { roots: ['nope'] }), []);
  assert.equal(listSourceFiles(root, { maxFiles: 1 }).length, 1);
  assert.equal(listSourceFiles(root, { roots: ['src'], maxDepth: 2 }).length, 0);
  assert.equal(listSourceFiles(root, { roots: ['src'] }).length, 1);
});

test('SEVERITIES and the rule ids are a frozen, stable contract', () => {
  assert.deepEqual(SEVERITIES, ['high', 'medium', 'low']);
  assert.ok(Object.isFrozen(SEVERITIES));
  assert.deepEqual(
    RULES.map((r) => r.id),
    [
      'dangerous_html',
      'raw_sql_interpolation',
      'jwt_decode_without_verify',
      'public_env_secret',
      'eval_usage',
      'child_process_shell_true',
      'http_url',
      'missing_auth_check',
      'clerk_route_matcher',
      'convex_missing_args_validator',
      'hardcoded_secret_literal',
    ],
  );
  for (const rule of RULES) {
    assert.ok(/^[a-z][a-z0-9_]*$/.test(rule.id), `${rule.id} is not snake_case`);
    assert.ok(SEVERITIES.includes(rule.severity), `${rule.id} has an unknown severity`);
    assert.equal(rule.pattern.global, false, `${rule.id} must not carry the g flag`);
    assert.ok(rule.fix.length > 10 && rule.fix.endsWith('.'), `${rule.id} needs one imperative fix sentence`);
  }
});

// ── SARIF ───────────────────────────────────────────────────────────────────

test('toSarif emits a valid 2.1.0 log with the mapped level', () => {
  const report = runSecurityScan(project({ 'app/dyn.ts': 'const a = 1;\nexport const r = (s) => eval(s);\n' }));
  const log = toSarif(report);
  assert.equal(log.version, '2.1.0');
  assert.match(log.$schema, /sarif-schema-2\.1\.0\.json$/);
  assert.equal(log.runs.length, 1);
  const driver = log.runs[0].tool.driver;
  assert.equal(driver.name, 'IMPACTUS CLI security L1');
  assert.match(driver.informationUri, /^https:\/\//);
  assert.equal(driver.rules.length, 1);
  assert.equal(driver.rules[0].id, 'eval_usage');
  assert.equal(driver.rules[0].defaultConfiguration.level, 'error');
  const [result] = log.runs[0].results;
  assert.equal(log.runs[0].results.length, 1);
  assert.equal(result.ruleId, 'eval_usage');
  assert.equal(result.ruleIndex, 0);
  assert.equal(result.level, 'error');
  assert.match(result.message.text, /eval/);
  assert.equal(result.locations[0].physicalLocation.artifactLocation.uri, 'app/dyn.ts');
  assert.equal(result.locations[0].physicalLocation.region.startLine, 2);
});

test('toSarif maps medium to warning and low to note, and tolerates an empty report', () => {
  const report = runSecurityScan(
    project({
      'app/x.tsx': 'export const X = () => <div dangerouslySetInnerHTML={{ __html: h }} />;\n',
      'app/u.ts': "export const u = 'http://acme-internal.test';\n",
    }),
  );
  const levels = toSarif(report).runs[0].results.map((r) => r.level);
  assert.deepEqual(levels, ['warning', 'note']);
  const empty = toSarif({ findings: [] });
  assert.deepEqual(empty.runs[0].results, []);
  assert.deepEqual(empty.runs[0].tool.driver.rules, []);
});

// ── CLI ─────────────────────────────────────────────────────────────────────

test('CLI --json prints pure JSON and exits 0', () => {
  const root = project({ 'app/dyn.ts': 'export const r = (s) => eval(s);\n' });
  const r = run(['--json'], root);
  assert.equal(r.status, 0);
  const report = JSON.parse(r.stdout);
  assert.equal(report.summary.high, 1);
  assert.equal(report.findings[0].file, 'app/dyn.ts');
});

test('CLI --sarif prints pure JSON and wins over --json', () => {
  const root = project({ 'app/dyn.ts': 'export const r = (s) => eval(s);\n' });
  const r = run(['--json', '--sarif'], root);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.trimStart().startsWith('{'));
  const log = JSON.parse(r.stdout);
  assert.equal(log.version, '2.1.0');
  assert.equal(log.runs[0].results.length, 1);
});

test('CLI default output is the human report', () => {
  const r = run([], project({ 'app/dyn.ts': 'export const r = (s) => eval(s);\n' }));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Security scan \(L1\)/);
  assert.match(r.stdout, /eval_usage/);
});

test('CLI --fail-on high exits 1 on a high finding and 0 when only a low one exists', () => {
  const high = run(['--fail-on', 'high'], project({ 'app/dyn.ts': 'export const r = (s) => eval(s);\n' }));
  assert.equal(high.status, 1);
  const low = run(['--fail-on', 'high'], project({ 'app/u.ts': "export const u = 'http://acme-internal.test';\n" }));
  assert.equal(low.status, 0);
  assert.match(low.stdout, /http_url/);
  // A low threshold catches the low finding.
  const strict = run(['--fail-on', 'low'], project({ 'app/u.ts': "export const u = 'http://acme-internal.test';\n" }));
  assert.equal(strict.status, 1);
});

test('CLI without --fail-on always exits 0, even with high findings', () => {
  const r = run([], project(POSITIVES));
  assert.equal(r.status, 0);
});

test('CLI rejects an unknown --fail-on severity on stderr with exit 1', () => {
  const r = run(['--fail-on', 'critical'], project({ 'app/a.ts': 'export const a = 1;\n' }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown --fail-on severity "critical"/);
  assert.match(r.stderr, /high, medium, low/);
  const missing = run(['--fail-on'], project({ 'app/a.ts': 'export const a = 1;\n' }));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Unknown --fail-on severity/);
});
