import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STACK_MARKERS,
  applyAgentsStackBlock,
  applyStackRules,
  matchesTemplateStack,
  parseStackFlag,
  renderStackAgentsBlock,
  renderStackMd,
  stackFromDecisions,
} from '../src/lib/stack.js';
import { STACK_CATEGORIES, STACK_LATER } from '../src/stack-catalog.js';
import { normalizeNeonResponse, parseNeonProjectCreate } from '../src/lib/neon.js';

function databaseUrl(scheme, host, database = 'db', user = 'u', password = 'p') {
  return `${scheme}://${user}:${password}@${host}/${database}`;
}

// ── Compatibility rules ──────────────────────────────────────────────────────

test('applyStackRules: empty → everything pending, no errors', () => {
  const r = applyStackRules({});
  assert.equal(r.errors.length, 0);
  assert.equal(r.pending.length, STACK_CATEGORIES.length);
  for (const cat of STACK_CATEGORIES) assert.equal(r.choices[cat.id], STACK_LATER);
});

test('applyStackRules: Convex backend forces Convex database and no ORM', () => {
  const r = applyStackRules({ backend: 'convex' });
  assert.equal(r.choices.database, 'convex');
  assert.equal(r.choices.orm, 'none');
  assert.ok(!r.pending.includes('database'), 'database is not pending with Convex');
  assert.ok(!r.pending.includes('orm'), 'ORM is not pending with Convex');
});

test('applyStackRules: pending backend drags database and ORM to pending — WITH a warning', () => {
  // Even if the person tries to pin the database before the backend, the
  // database/ORM depend on it — they stay "later" until the backend is
  // decided. And a discarded explicit choice NEVER disappears silently
  // (review finding).
  const r = applyStackRules({ database: 'neon' });
  assert.equal(r.choices.database, STACK_LATER);
  assert.equal(r.choices.orm, STACK_LATER);
  assert.ok(
    r.errors.some((e) => e.includes('neon')),
    'discarding an explicit choice raises a warning',
  );
});

test('applyStackRules: Convex backend discards a diverging explicit database with a warning', () => {
  const r = applyStackRules({ backend: 'convex', database: 'supabase' });
  assert.equal(r.choices.database, 'convex');
  assert.ok(r.errors.some((e) => e.includes('supabase')));
});

test('applyStackRules: the full SQL path closes with nothing pending', () => {
  const r = applyStackRules({
    frontend: 'nextjs',
    backend: 'hono',
    database: 'neon',
    orm: 'drizzle',
    auth: 'clerk',
    blob: 'r2',
    automations: 'none',
    deploy: 'vercel',
  });
  assert.equal(r.errors.length, 0);
  assert.deepEqual(r.pending, []);
  assert.equal(r.choices.database, 'neon');
});

test('applyStackRules: automations is independent — modal decides alone, absence stays pending', () => {
  // Modal does not depend on the backend choice…
  const r = applyStackRules({ backend: 'convex', automations: 'modal' });
  assert.equal(r.choices.automations, 'modal');
  assert.ok(!r.pending.includes('automations'));
  // …and an undecided automations layer is PENDING (the workflow forces the
  // question — "none" must be an explicit answer, never a silent default).
  const s = applyStackRules({ backend: 'convex' });
  assert.equal(s.choices.automations, STACK_LATER);
  assert.ok(s.pending.includes('automations'));
});

test('applyStackRules: unknown option becomes pending with an explanatory error', () => {
  const r = applyStackRules({ backend: 'hono', database: 'mongodb' });
  assert.equal(r.choices.database, STACK_LATER);
  assert.ok(r.errors.some((e) => e.includes('mongodb')));
});

test('applyStackRules: onlyWhen out of context drops the choice', () => {
  // Supabase Storage without the Supabase database; Better Auth with the Convex backend.
  const a = applyStackRules({ backend: 'hono', database: 'neon', orm: 'drizzle', blob: 'supabase-storage' });
  assert.equal(a.choices.blob, STACK_LATER);
  assert.ok(a.errors.length > 0);

  const b = applyStackRules({ backend: 'convex', auth: 'better-auth' });
  assert.equal(b.choices.auth, STACK_LATER);
  assert.ok(b.errors.some((e) => e.includes('Better Auth')));
});

// ── --stack flag ─────────────────────────────────────────────────────────────

test('parseStackFlag: shortcuts and pairs with alias', () => {
  assert.equal(parseStackFlag('recomendada').path, 'template');
  assert.equal(parseStackFlag('depois').path, 'discover');
  assert.equal(parseStackFlag(undefined).path, undefined);

  const pares = parseStackFlag('backend=hono,db=neon,orm=drizzle');
  assert.equal(pares.path, 'custom');
  assert.deepEqual(pares.choices, { backend: 'hono', database: 'neon', orm: 'drizzle' });
  assert.equal(pares.errors.length, 0);

  // jobs/automacoes are aliases of the automations category.
  assert.deepEqual(parseStackFlag('jobs=modal').choices, { automations: 'modal' });
  assert.deepEqual(parseStackFlag('automacoes=modal').choices, { automations: 'modal' });
});

test('parseStackFlag: an invalid pair becomes an error, the valid ones survive', () => {
  const r = parseStackFlag('backend=hono,frete=sedex');
  assert.equal(r.errors.length, 1);
  assert.equal(r.path, 'custom');
  assert.deepEqual(r.choices, { backend: 'hono' });
});

test('parseStackFlag: a shortcut typo or empty value does NOT silently become the custom path', () => {
  // "recomendado" (typo) would switch the whole install type — the caller
  // (mode.js) aborts when path is undefined (review finding).
  const typo = parseStackFlag('recomendado');
  assert.equal(typo.path, undefined);
  assert.ok(typo.errors.length > 0);

  const vazio = parseStackFlag('');
  assert.equal(vazio.path, undefined);
  assert.ok(vazio.errors.length > 0);

  // All pairs invalid ⇒ same treatment.
  const soLixo = parseStackFlag('frete=sedex');
  assert.equal(soLixo.path, undefined);
  assert.ok(soLixo.errors.length > 0);
});

// ── Bridges to the template ──────────────────────────────────────────────────

test('stackFromDecisions: storage decides the blob; the rest is the recommended stack', () => {
  assert.equal(stackFromDecisions({ storage: 'r2' }).blob, 'r2');
  assert.equal(stackFromDecisions({ storage: 'convex' }).blob, 'convex-storage');
  assert.equal(stackFromDecisions({}).backend, 'convex');
});

test('matchesTemplateStack: recommended matches (with R2 or Convex Storage); SQL does not', () => {
  const base = applyStackRules(stackFromDecisions({ storage: 'r2' })).choices;
  assert.equal(matchesTemplateStack(base), true);
  assert.equal(matchesTemplateStack({ ...base, blob: 'convex-storage' }), true);
  assert.equal(matchesTemplateStack({ ...base, backend: 'hono' }), false);
  assert.equal(matchesTemplateStack({ ...base, auth: STACK_LATER }), false);
});

// ── Manifest and AGENTS.md block ─────────────────────────────────────────────

test('renderStackMd: complete manifest lists layers, environments and nothing pending', () => {
  const { choices, pending } = applyStackRules(stackFromDecisions({ storage: 'r2' }));
  const md = renderStackMd({ choices, pending, source: 'template', projectName: 'meu-app' });
  assert.ok(md.includes('# Project stack'));
  assert.ok(md.includes('Convex'));
  assert.ok(md.includes('## Environments — development × production'));
  assert.ok(!md.includes('## Pending'), 'a complete stack has no pending section');
  assert.ok(!md.includes('◌ decide later'), 'a complete stack has no pending marker');
});

test('renderStackMd: the auth layer carries its Test users note', () => {
  const { choices, pending } = applyStackRules(stackFromDecisions({ storage: 'r2' }));
  const md = renderStackMd({ choices, pending, source: 'template', projectName: 'meu-app' });
  assert.ok(md.includes('- Test users:'), 'auth options render their testUsers field');
  assert.ok(md.includes('+clerk_test'), 'Clerk test-mode email pattern documented');
  assert.ok(md.includes('424242'), 'the fixed verification code documented');
  assert.ok(md.includes('ai-docs/test-credentials.md'), 'points at the roster file');
});

test('renderStackMd: pending layers show the ◌ marker and decision instructions', () => {
  const { choices, pending } = applyStackRules({});
  const md = renderStackMd({ choices, pending, source: 'discover' });
  assert.ok(md.includes('## Pending — decide before implementing'));
  assert.ok(md.includes('◌ decide later'));
  assert.ok(md.includes('/idea'), 'points to the decision path via Pi');
});

test('renderStackMd: an external automations layer gets its row, doc and envs', () => {
  const { choices, pending } = applyStackRules({
    frontend: 'nextjs',
    backend: 'convex',
    auth: 'clerk',
    blob: 'r2',
    automations: 'modal',
    deploy: 'vercel',
  });
  const md = renderStackMd({ choices, pending, source: 'custom' });
  assert.match(md, /\| Automations \/ Jobs \| Modal \(external compute\) \| `ai-docs\/apis\/modal\.md`/);
  assert.ok(md.includes('### Automations / Jobs — Modal (external compute)'));
  assert.ok(md.includes('modal deploy automations/'), 'prod env row present');
});

test('renderStackMd: the Neon claim URL lands in the manifest', () => {
  const { choices, pending } = applyStackRules({
    frontend: 'nextjs',
    backend: 'hono',
    database: 'neon',
    orm: 'drizzle',
    auth: 'clerk',
    blob: 'r2',
    deploy: 'vercel',
  });
  const md = renderStackMd({
    choices,
    pending,
    source: 'custom',
    provision: { neon: { claimUrl: 'https://neon.new/claim/abc123' } },
  });
  assert.ok(md.includes('https://neon.new/claim/abc123'));
  assert.ok(md.includes('Claim'));
});

test('applyAgentsStackBlock: creates, appends and is idempotent', () => {
  const { choices, pending } = applyStackRules({ backend: 'convex' });
  const block = renderStackAgentsBlock({ choices, pending });
  assert.ok(block.includes('ai-docs/stack.md'));

  const created = applyAgentsStackBlock(null, block);
  assert.equal(created.action, 'created');
  assert.ok(created.content.includes(STACK_MARKERS.start));

  const appended = applyAgentsStackBlock('# Meu AGENTS\n', block);
  assert.equal(appended.action, 'appended');
  assert.ok(appended.content.startsWith('# Meu AGENTS'));

  const again = applyAgentsStackBlock(appended.content, block);
  assert.equal(again.action, 'skipped');
  assert.equal(again.content, appended.content);
});

// ── Neon Launchpad response (tolerant shape) ─────────────────────────────────

test('normalizeNeonResponse: neon-new-style shape (env vars)', () => {
  const pooledUrl = databaseUrl('postgresql', 'ep-x-pooler.neon.tech');
  const directUrl = databaseUrl('postgresql', 'ep-x.neon.tech');
  const r = normalizeNeonResponse({
    DATABASE_URL: pooledUrl,
    DATABASE_URL_DIRECT: directUrl,
    PUBLIC_POSTGRES_CLAIM_URL: 'https://neon.new/claim/uuid',
    expires_at: '2026-08-14T00:00:00Z',
  });
  assert.equal(r.databaseUrl, pooledUrl);
  assert.equal(r.directUrl, directUrl);
  assert.equal(r.claimUrl, 'https://neon.new/claim/uuid');
  assert.equal(r.expiresAt, '2026-08-14T00:00:00Z');
});

test('normalizeNeonResponse: nested API-style shape (connection_string)', () => {
  const connectionString = databaseUrl('postgres', 'host');
  const r = normalizeNeonResponse({
    database: { connection_string: connectionString },
    claim_url: 'https://neon.new/claim/x',
  });
  assert.equal(r.databaseUrl, connectionString);
  assert.equal(r.claimUrl, 'https://neon.new/claim/x');
});

test('normalizeNeonResponse: nothing recognizable → null fields', () => {
  const r = normalizeNeonResponse({ ok: true });
  assert.equal(r.databaseUrl, null);
  assert.equal(r.claimUrl, null);
});

test('parseNeonProjectCreate: documented CLI shape (connection_uris)', () => {
  const connectionUri = databaseUrl('postgresql', 'ep-x.neon.tech', 'neondb');
  const stdout = JSON.stringify({
    project: { id: 'proj-123', name: 'meu-app' },
    connection_uris: [{ connection_uri: connectionUri }],
  });
  const r = parseNeonProjectCreate(stdout);
  assert.equal(r.databaseUrl, connectionUri);
  assert.equal(r.projectId, 'proj-123');
});

test('parseNeonProjectCreate: invalid JSON or no URI → nulls (never throws)', () => {
  assert.deepEqual(parseNeonProjectCreate('not json'), { databaseUrl: null, projectId: null });
  const semUri = parseNeonProjectCreate(JSON.stringify({ project: { id: 'x' } }));
  assert.equal(semUri.databaseUrl, null);
  assert.equal(semUri.projectId, 'x');
});
