import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runEnvPreflight, renderPreflight } from '../fia-templates/scripts/env-preflight.mjs';

const SCRIPT = join(import.meta.dirname, '..', 'fia-templates', 'scripts', 'env-preflight.mjs');

const CONVEX_CLERK = `# Stack

## Summary

| Layer | Choice | Local docs |
|---|---|---|
| Frontend | Next.js | — |
| Backend & API | Convex | — |
| Auth | Clerk | — |
| Publishing | Vercel | — |
`;

const NEON_DRIZZLE = `# Stack

## Summary

| Layer | Choice | Local docs |
|---|---|---|
| Database | Neon | — |
| ORM | Drizzle | — |
`;

function projectWith({ stack, env } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'env-preflight-'));
  if (stack) {
    mkdirSync(join(root, 'ai-docs'), { recursive: true });
    writeFileSync(join(root, 'ai-docs', 'stack.md'), stack);
  }
  if (env) writeFileSync(join(root, '.env.local'), env);
  return root;
}

test('no manifest → passes with manifest:false (nothing declared, nothing required)', () => {
  const report = runEnvPreflight(projectWith());
  assert.equal(report.passed, true);
  assert.equal(report.manifest, false);
  assert.deepEqual(report.required, []);
  assert.match(renderPreflight(report), /no ai-docs\/stack\.md/);
});

test('convex+clerk declared, no .env.local → all four keys missing, each with a fix', () => {
  const report = runEnvPreflight(projectWith({ stack: CONVEX_CLERK }));
  assert.equal(report.passed, false);
  assert.equal(report.envFile, false);
  assert.deepEqual(
    report.missing.map((r) => r.key).sort(),
    ['CLERK_SECRET_KEY', 'CONVEX_DEPLOYMENT', 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'NEXT_PUBLIC_CONVEX_URL'],
  );
  for (const r of report.missing) assert.ok(r.fix.length > 10, `fix missing for ${r.key}`);
  assert.match(renderPreflight(report), /✗ NEXT_PUBLIC_CONVEX_URL/);
});

test('convex+clerk with a complete .env.local → passes', () => {
  const root = projectWith({
    stack: CONVEX_CLERK,
    env: [
      'NEXT_PUBLIC_CONVEX_URL=https://x.convex.cloud',
      'CONVEX_DEPLOYMENT=dev:x',
      'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_x',
      'CLERK_SECRET_KEY=sk_test_x',
    ].join('\n'),
  });
  const report = runEnvPreflight(root);
  assert.equal(report.passed, true);
  assert.equal(report.missing.length, 0);
  assert.equal(report.required.length, 4);
});

test('partial .env.local → only the absent keys are reported missing', () => {
  const root = projectWith({
    stack: CONVEX_CLERK,
    env: 'NEXT_PUBLIC_CONVEX_URL=https://x.convex.cloud\nCONVEX_DEPLOYMENT=dev:x\n',
  });
  const report = runEnvPreflight(root);
  assert.equal(report.passed, false);
  assert.deepEqual(
    report.missing.map((r) => r.key).sort(),
    ['CLERK_SECRET_KEY', 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY'],
  );
});

test('neon+drizzle → one DATABASE_URL requirement, not one per service', () => {
  const report = runEnvPreflight(projectWith({ stack: NEON_DRIZZLE }));
  assert.deepEqual(report.missing.map((r) => r.key), ['DATABASE_URL']);
});

test('cli: --json exits 1 with the report on missing keys, 0 when clean', () => {
  const failing = projectWith({ stack: CONVEX_CLERK });
  let out;
  try {
    execFileSync(process.execPath, [SCRIPT, '--json', '--dir', failing], { encoding: 'utf8' });
    throw new Error('expected exit 1');
  } catch (err) {
    assert.equal(err.status, 1);
    out = JSON.parse(err.stdout);
  }
  assert.equal(out.passed, false);
  assert.equal(out.missing.length, 4);

  const clean = projectWith();
  const ok = JSON.parse(execFileSync(process.execPath, [SCRIPT, '--json', '--dir', clean], { encoding: 'utf8' }));
  assert.equal(ok.passed, true);
});
