import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectFindings, parseEnvFile } from '../src/steps/verify.js';

async function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'create-iai-verify-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  return dir;
}

const ENV_OK = [
  'NEXT_PUBLIC_CONVEX_URL=https://x.convex.cloud',
  'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_abc',
  'CLERK_SECRET_KEY=sk_test_abc',
].join('\n');

test('parseEnvFile: KEY=value, comments and quotes', () => {
  const env = parseEnvFile('# doc\nA=1\nB="two"\n\nC=\nD=x=y\n');
  assert.deepEqual(env, { A: '1', B: 'two', C: '', D: 'x=y' });
});

test('collectFindings: clean project → zero errors', async () => {
  const dir = await fixture({
    'package.json': JSON.stringify({ name: 'my-app' }),
    'iai.config.json': JSON.stringify({ createdWith: 'create-iai', addons: [] }),
    '.env.local': ENV_OK,
    'app/page.tsx': 'export default function Page() { return null }\n',
  });
  const findings = await collectFindings(dir);
  const errors = findings.filter((f) => f.level === 'error');
  assert.deepEqual(errors, []);
});

test('collectFindings: deprecated Clerk route matcher is a warning (templates still ship it)', async () => {
  const dir = await fixture({
    'package.json': JSON.stringify({ name: 'my-app' }),
    'iai.config.json': JSON.stringify({ createdWith: 'impactus', addons: [] }),
    '.env.local': ENV_OK,
    'proxy.ts': "import { createRouteMatcher } from '@clerk/nextjs/server';\n",
  });
  const findings = await collectFindings(dir);
  assert.ok(
    findings.some((finding) => finding.level === 'warn' && finding.msg.includes('createRouteMatcher')),
  );
  assert.deepEqual(findings.filter((f) => f.level === 'error'), []);
});

test('collectFindings: createRouteMatcher inside the stamped runtime is never flagged', async () => {
  // The installer stamps imp/scripts/security-scan.mjs, which names the
  // deprecated API in its own patterns — a pristine install must stay clean.
  const dir = await fixture({
    'package.json': JSON.stringify({ name: 'my-app' }),
    'iai.config.json': JSON.stringify({ createdWith: 'impactus', addons: [] }),
    '.env.local': ENV_OK,
    'imp/scripts/security-scan.mjs': 'const p = /\\bcreateRouteMatcher\\b/;\n',
    '.claude/skills/design-system/scripts/check.mjs': '// createRouteMatcher is deprecated\n',
  });
  const findings = await collectFindings(dir);
  assert.deepEqual(
    findings.filter((f) => f.msg.includes('createRouteMatcher') && f.level !== 'ok'),
    [],
  );
});

test('collectFindings: leftover manifest + orphan marker + missing env → errors', async () => {
  const dir = await fixture({
    'package.json': JSON.stringify({ name: 'my-app' }),
    'iai.config.json': JSON.stringify({ addons: ['stripe'] }),
    'template.addons.json': JSON.stringify({ addons: {} }),
    '.env.local': 'NEXT_PUBLIC_CONVEX_URL=https://x.convex.cloud\n',
    'lib/foo.ts': '// live1:addon:sentry:start\nimport x from "y"\n// live1:addon:sentry:end\n',
  });
  const findings = await collectFindings(dir);
  const errors = findings.filter((f) => f.level === 'error').map((f) => f.msg);
  assert.ok(errors.some((m) => m.includes('template.addons.json')), 'leftover manifest is an error');
  assert.ok(errors.some((m) => m.includes('orphan')), 'orphan marker is an error');
  assert.ok(errors.some((m) => m.includes('CLERK_SECRET_KEY')), 'missing base env is an error');
  // Stripe chosen without its key → WARNING (degrades gracefully), not an error.
  const warns = findings.filter((f) => f.level === 'warn').map((f) => f.msg);
  assert.ok(warns.some((m) => m.includes('STRIPE_SECRET_KEY')), 'missing service key is a warning');
});

test('collectFindings: no package.json → single error and short-circuit', async () => {
  const dir = await fixture({});
  const findings = await collectFindings(dir);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, 'error');
});

test('collectFindings: harness-only install → template checks skipped, zero errors', async () => {
  // "Harness only" footprint: HARNESS.md + ai-docs, no iai.config.json, no
  // convex/ and no .env.local — none of the template checks apply.
  const dir = await fixture({
    'HARNESS.md': '# harness\n',
    'ai-docs/PRD.md': '# prd\n',
    'package.json': JSON.stringify({ name: 'my-existing-app' }),
  });
  const findings = await collectFindings(dir);
  const errors = findings.filter((f) => f.level === 'error');
  assert.deepEqual(errors, [], 'harness-only installs must not report template errors');
  const msgs = findings.map((f) => f.msg);
  assert.ok(msgs.some((m) => m.includes('skip (harness-only install)')), 'skips are labeled');
});

test('collectFindings: harness-only without package.json → warning, not error', async () => {
  const dir = await fixture({ 'HARNESS.md': '# harness\n' });
  const findings = await collectFindings(dir);
  assert.deepEqual(findings.filter((f) => f.level === 'error'), []);
  assert.ok(findings.some((f) => f.level === 'warn' && f.msg.includes('package.json')));
});

test('collectFindings: imp/ layout — harness-only detected via imp/HARNESS.md', async () => {
  const dir = await fixture({
    'imp/HARNESS.md': '# harness\n',
    'package.json': JSON.stringify({ name: 'my-existing-app' }),
  });
  const findings = await collectFindings(dir);
  assert.deepEqual(findings.filter((f) => f.level === 'error'), []);
  assert.ok(findings.some((f) => f.msg.includes('harness-only install detected')));
});

test('collectFindings: imp/ layout — addons config read from imp/iai.config.json', async () => {
  const dir = await fixture({
    'package.json': JSON.stringify({ name: 'app' }),
    'imp/iai.config.json': JSON.stringify({ createdWith: 'create-iai', addons: ['knip'] }),
    '.env.local': 'NEXT_PUBLIC_CONVEX_URL=x\nNEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=x\nCLERK_SECRET_KEY=x\n',
  });
  const findings = await collectFindings(dir);
  assert.ok(findings.some((f) => f.level === 'ok' && f.msg.includes('imp/iai.config.json: knip')));
});

// ── Agent skills coverage (skills-lock.json vs what each engine can read) ────

const LOCK = JSON.stringify({
  version: 1,
  skills: {
    cloudflare: { source: 'cloudflare/skills', sourceType: 'github', skillPath: 'cloudflare', computedHash: 'abc' },
    wrangler: { source: 'cloudflare/skills', sourceType: 'github', skillPath: 'wrangler', computedHash: 'def' },
  },
});

test('collectFindings: skill in the lock but not in .agents/ → warning; a .pi/skills/ copy → duplicate warning', async () => {
  const dir = await fixture({
    'HARNESS.md': '# harness\n',
    'package.json': JSON.stringify({ name: 'my-app' }),
    'skills-lock.json': LOCK,
    '.agents/skills/cloudflare/SKILL.md': '# cloudflare\n',
    '.pi/skills/cloudflare/SKILL.md': '# cloudflare\n',
    '.pi/prompts/fia.md': '# fia\n',
  });
  const findings = await collectFindings(dir);
  const warns = findings.filter((f) => f.level === 'warn').map((f) => f.msg);
  assert.deepEqual(findings.filter((f) => f.level === 'error'), []);
  assert.ok(
    warns.some((m) => m.includes('.agents/skills/') && m.includes('wrangler') && !m.includes('cloudflare')),
    'the missing store copy is reported by name',
  );
  assert.ok(
    warns.some((m) => m.includes('duplicated in .pi/skills/') && m.includes('cloudflare')),
    'the leftover Pi copy (Skill conflicts fodder) is reported by name',
  );
});

test('collectFindings: complete coverage lives in .agents/ alone → ok, no .pi/ copies wanted', async () => {
  const complete = await fixture({
    'HARNESS.md': '# harness\n',
    'package.json': JSON.stringify({ name: 'my-app' }),
    'skills-lock.json': LOCK,
    '.agents/skills/cloudflare/SKILL.md': '# cloudflare\n',
    '.agents/skills/wrangler/SKILL.md': '# wrangler\n',
    '.pi/prompts/fia.md': '# fia\n',
  });
  const findings = await collectFindings(complete);
  assert.deepEqual(findings.filter((f) => f.level === 'warn' && f.msg.includes('skills')), []);
  assert.ok(findings.some((f) => f.level === 'ok' && f.msg.includes('2 skill(s) available')));

  // Same project without the FIA: .pi/ absent → no duplicate check either.
  const noPi = await fixture({
    'HARNESS.md': '# harness\n',
    'package.json': JSON.stringify({ name: 'my-app' }),
    'skills-lock.json': LOCK,
    '.agents/skills/cloudflare/SKILL.md': '# cloudflare\n',
    '.agents/skills/wrangler/SKILL.md': '# wrangler\n',
  });
  const noPiFindings = await collectFindings(noPi);
  assert.deepEqual(noPiFindings.filter((f) => f.level === 'warn' && f.msg.includes('.pi/skills/')), []);
});

test('collectFindings: no skills-lock.json → nothing reported; broken lock → warning', async () => {
  const none = await fixture({
    'HARNESS.md': '# harness\n',
    'package.json': JSON.stringify({ name: 'my-app' }),
  });
  assert.deepEqual((await collectFindings(none)).filter((f) => f.msg.includes('skills-lock.json')), []);

  const broken = await fixture({
    'HARNESS.md': '# harness\n',
    'package.json': JSON.stringify({ name: 'my-app' }),
    'skills-lock.json': '{ not json',
  });
  const findings = await collectFindings(broken);
  assert.ok(findings.some((f) => f.level === 'warn' && f.msg.includes('skills-lock.json')));
  assert.deepEqual(findings.filter((f) => f.level === 'error'), []);
});
