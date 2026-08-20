import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clerkKeyEnvironment,
  findInstanceId,
  issuerFromPublishableKey,
  jwtTemplateDiff,
  matchAppsByName,
  parseAppList,
  parseJwtTemplates,
  parseWhoami,
  validateAppPublishableKey,
  validateClerkKeyPair,
} from '../src/lib/clerk.js';
import { chooseClerkApp, summarizeDoctor, validateClerkInstance } from '../src/steps/clerk.js';

const apps = [
  { application_id: 'app_alpha1', name: 'alpha', instances: [{ instance_id: 'ins_alpha1', environment_type: 'development', publishable_key: key('test', 'alpha.clerk.accounts.dev') }] },
  { application_id: 'app_beta1', name: 'beta', instances: [{ instance_id: 'ins_beta1', environment_type: 'development', publishable_key: key('test', 'beta.clerk.accounts.dev') }] },
];

test('Clerk keys: issuer and environment pair validation', () => {
  const pk = key('test', 'happy.test.clerk.accounts.dev');
  assert.equal(issuerFromPublishableKey(pk), 'https://happy.test.clerk.accounts.dev');
  assert.equal(clerkKeyEnvironment(pk), 'test');
  assert.deepEqual(validateClerkKeyPair(pk, 'sk_test_secret-value'), {
    ok: true,
    environment: 'test',
    reason: null,
  });
  assert.equal(validateClerkKeyPair(pk, 'sk_live_secret-value').ok, false);
});

test('Clerk structured parsers avoid prose scraping', () => {
  assert.deepEqual(parseWhoami(JSON.stringify({ user: { email: 'owner@example.com' }, application: { id: 'app_alpha1' } })), {
    email: 'owner@example.com',
    appId: 'app_alpha1',
  });
  assert.deepEqual(parseWhoami('not json'), { email: null, appId: null });
  assert.equal(parseAppList(JSON.stringify({ data: apps })).length, 2);
  assert.equal(matchAppsByName(parseAppList({ data: apps }), 'alpha')[0].appId, 'app_alpha1');
  assert.equal(findInstanceId({ data: { id: 'ins_alpha1' } }), 'ins_alpha1');
});

test('Clerk app/key ownership and JWT reconciliation helpers are strict', () => {
  const normalized = parseAppList({ data: apps })[0];
  assert.equal(validateAppPublishableKey(normalized, normalized.pk).ok, true);
  assert.equal(validateAppPublishableKey(normalized, key('test', 'other.clerk.accounts.dev')).ok, false);

  const list = parseJwtTemplates({ data: [{ id: 'jwt_1', name: 'convex', claims: { aud: 'convex' }, lifetime: 3600 }] });
  assert.equal(list.length, 1);
  assert.deepEqual(jwtTemplateDiff(list[0], { name: 'convex', claims: { aud: 'convex' }, lifetime: 3600 }), []);
  assert.deepEqual(jwtTemplateDiff({ ...list[0], lifetime: 60 }, { name: 'convex', claims: { aud: 'convex' }, lifetime: 3600 }), ['lifetime']);
  assert.deepEqual(jwtTemplateDiff({ ...list[0], claims: { z: true, aud: 'convex' } }, { name: 'convex', claims: { aud: 'convex', z: true }, lifetime: 3600 }), []);
  assert.deepEqual(jwtTemplateDiff(null, { name: 'convex', claims: { aud: 'convex' }, lifetime: 3600 }), ['missing']);
});

test('chooseClerkApp prioritizes explicit, linked and exact-name apps without duplication', async () => {
  const clerk = mockClerk({ apps });
  assert.equal((await chooseClerkApp(clerk, { name: 'new-name', flags: { clerkApp: 'app_beta1', yes: true } })).appId, 'app_beta1');
  assert.equal((await chooseClerkApp(clerk, { name: 'new-name', flags: { yes: true } }, 'app_alpha1')).appId, 'app_alpha1');
  assert.equal((await chooseClerkApp(clerk, { name: 'beta', flags: { yes: true } })).appId, 'app_beta1');
  assert.equal(clerk.calls.filter((call) => call[0] === 'apps' && call[1] === 'create').length, 0);
});

test('chooseClerkApp fails closed on ambiguous exact names in --yes', async () => {
  const clerk = mockClerk({ apps: [...apps, { ...apps[0], application_id: 'app_alpha2' }] });
  await assert.rejects(
    chooseClerkApp(clerk, { name: 'alpha', flags: { yes: true } }),
    /More than one Clerk app.*--clerk-app/,
  );
});

test('Clerk doctor summary separates structural errors and warnings', () => {
  assert.deepEqual(
    summarizeDoctor({ checks: [{ status: 'warning', message: 'dev keys' }, { status: 'failed', message: 'provider missing' }] }),
    { errors: ['provider missing'], warnings: ['dev keys'], parsed: true },
  );
  assert.equal(summarizeDoctor('plain text').parsed, false);
});

test('Clerk secret key must resolve to the selected development instance', async () => {
  const app = parseAppList({ data: apps })[0];
  const valid = async (_args, options) => {
    assert.equal(options.secretKey, 'sk_test_secret-value');
    assert.equal(options.sensitiveOutput, true);
    return { ok: true, stdout: JSON.stringify({ id: 'ins_alpha1' }), stderr: '' };
  };
  assert.deepEqual(await validateClerkInstance(valid, app, 'sk_test_secret-value', '/tmp/app'), {
    ok: true,
    instanceId: 'ins_alpha1',
    reason: null,
  });

  const mismatched = async () => ({ ok: true, stdout: JSON.stringify({ id: 'ins_other1' }), stderr: '' });
  assert.equal((await validateClerkInstance(mismatched, app, 'sk_test_other', '/tmp/app')).ok, false);

  const withoutInstanceInList = { ...app, instanceId: null };
  const calls = [];
  const resolved = async (args, options) => {
    calls.push({ args, options });
    return { ok: true, stdout: JSON.stringify({ id: 'ins_alpha1' }), stderr: '' };
  };
  assert.equal((await validateClerkInstance(resolved, withoutInstanceInList, 'sk_test_secret-value', '/tmp/app')).ok, true);
  assert.deepEqual(calls[0].args, ['api', '/instance', '--app', 'app_alpha1', '--instance', 'dev']);
  assert.equal(calls[1].options.secretKey, 'sk_test_secret-value');
});

function key(environment, host) {
  return `pk_${environment}_${Buffer.from(`${host}$`).toString('base64')}`;
}

function mockClerk({ apps: rows }) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    if (args[0] === 'apps' && args[1] === 'list') return { ok: true, stdout: JSON.stringify({ data: rows }), stderr: '' };
    if (args[0] === 'apps' && args[1] === 'create') {
      const created = { application_id: 'app_created1', name: args[2], instances: [] };
      return { ok: true, stdout: JSON.stringify(created), stderr: '' };
    }
    return { ok: false, stdout: '', stderr: 'unexpected command' };
  };
  fn.calls = calls;
  return fn;
}
