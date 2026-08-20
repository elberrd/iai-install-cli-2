import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QUICK_DEPLOY_ARGS, QUICK_DEPLOY_TARGET, previewClerkKeys } from '../src/steps/deploy.js';

test('quick deploy contract is Vercel Preview without --prod', () => {
  assert.equal(QUICK_DEPLOY_TARGET, 'preview');
  assert.deepEqual(QUICK_DEPLOY_ARGS, ['deploy', '--yes']);
  assert.equal(QUICK_DEPLOY_ARGS.includes('--prod'), false);
});

test('quick deploy accepts matching development Clerk keys only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'impactus-deploy-test-'));
  const env = join(dir, '.env.local');
  await writeFile(
    env,
    `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${publishable('test')}\nCLERK_SECRET_KEY=sk_test_secret-value\n`,
  );
  assert.equal((await previewClerkKeys(env)).ok, true);

  await writeFile(
    env,
    `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${publishable('live')}\nCLERK_SECRET_KEY=sk_live_secret-value\n`,
  );
  const live = await previewClerkKeys(env);
  assert.equal(live.ok, false);
  assert.match(live.reason, /Preview-only/);
});

function publishable(environment) {
  return `pk_${environment}_${Buffer.from('example.clerk.accounts.dev$').toString('base64')}`;
}
