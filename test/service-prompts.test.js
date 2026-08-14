import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SERVICES } from '../src/config.js';
import {
  buildServicePrompt,
  dashboardEnvs,
  parseKeysBlock,
  relevantServices,
  validateEnvValue,
} from '../src/lib/service-prompts.js';

const byId = (id) => SERVICES.find((s) => s.id === id);

test('relevantServices: always includes clerk/convex; addons and storage filter the rest', () => {
  const none = relevantServices({ addons: [] });
  assert.deepEqual(none.map((s) => s.id), ['clerk', 'convex']);

  const saas = relevantServices({ addons: ['stripe', 'sentry', 'posthog'], storage: 'r2' });
  const ids = saas.map((s) => s.id);
  assert.ok(ids.includes('stripe') && ids.includes('sentry') && ids.includes('posthog') && ids.includes('r2'));
  assert.ok(!ids.includes('asaas') && !ids.includes('resend') && !ids.includes('arcjet'));
});

test('buildServicePrompt: null for 100% automatic services', () => {
  assert.equal(buildServicePrompt(byId('clerk')), null);
  assert.equal(buildServicePrompt(byId('convex')), null);
});

test('buildServicePrompt(stripe): requires test mode and asks for the keys by exact name', () => {
  const prompt = buildServicePrompt(byId('stripe'), 'loja-x');
  assert.ok(prompt.includes('loja-x'));
  assert.ok(/test mode/i.test(prompt) || /modo de teste/i.test(prompt));
  assert.ok(prompt.includes('sk_live'), 'must explicitly warn against live keys');
  assert.ok(prompt.includes('STRIPE_SECRET_KEY=<sk_test_…>'));
  assert.ok(prompt.includes('STRIPE_PRICE_ID=<price_…>'));
  // The webhook secret is created via API by the CLI — it does not go in the prompt.
  assert.ok(!prompt.includes('STRIPE_WEBHOOK_SECRET='));
});

test('buildServicePrompt: every service with dashboard keys asks for exactly those envs in the reply', () => {
  for (const svc of SERVICES) {
    const wanted = dashboardEnvs(svc);
    const prompt = buildServicePrompt(svc, 'proj');
    if (wanted.length === 0) {
      assert.equal(prompt, null, svc.id);
      continue;
    }
    for (const env of wanted) {
      assert.ok(prompt.includes(`${env.key}=`), `${svc.id}: prompt must ask for ${env.key}`);
    }
    assert.ok(!prompt.includes('{{PROJECT}}'), `${svc.id}: placeholder not replaced`);
  }
});

test('parseKeysBlock: accepts =, :, quotes, lists and ignores placeholders/unknown keys', () => {
  const text = [
    'Here is what you asked for:',
    '```',
    'STRIPE_SECRET_KEY=sk_test_abc123',
    'STRIPE_PRICE_ID: "price_123"',
    '- RESEND_API_KEY=`re_xyz`',
    'NEXT_PUBLIC_SENTRY_DSN=<https://…>', // placeholder → out
    'HACKED_KEY=oops', // unknown → out
    '# comment',
    '```',
  ].join('\n');
  const parsed = parseKeysBlock(text);
  assert.deepEqual(parsed, {
    STRIPE_SECRET_KEY: 'sk_test_abc123',
    STRIPE_PRICE_ID: 'price_123',
    RESEND_API_KEY: 're_xyz',
  });
});

test('validateEnvValue: patterns catch wrong keys (live instead of test, wrong prefix)', () => {
  const skSpec = byId('stripe').envs.find((e) => e.key === 'STRIPE_SECRET_KEY');
  assert.equal(validateEnvValue(skSpec, 'sk_test_ok123'), true);
  assert.notEqual(validateEnvValue(skSpec, 'sk_live_nope'), true);

  const resendSpec = byId('resend').envs.find((e) => e.key === 'RESEND_API_KEY');
  assert.equal(validateEnvValue(resendSpec, 're_abc'), true);
  assert.notEqual(validateEnvValue(resendSpec, 'sk_test_x'), true);

  const asaasEnv = byId('asaas').envs.find((e) => e.key === 'ASAAS_ENV');
  assert.equal(validateEnvValue(asaasEnv, 'production'), true);
  assert.notEqual(validateEnvValue(asaasEnv, 'prod'), true);
});

test('SERVICES: payment envs match what the template reads (exact names)', () => {
  assert.deepEqual(
    byId('stripe').envs.map((e) => e.key).sort(),
    ['SITE_URL', 'STRIPE_PRICE_ID', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
  );
  assert.deepEqual(
    byId('asaas').envs.map((e) => e.key).sort(),
    ['ASAAS_API_KEY', 'ASAAS_ENV', 'ASAAS_VALUE', 'ASAAS_WEBHOOK_TOKEN', 'SITE_URL'],
  );
  assert.deepEqual(
    byId('r2').envs.map((e) => e.key).sort(),
    ['R2_ACCESS_KEY_ID', 'R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_SECRET_ACCESS_KEY'],
  );
});
