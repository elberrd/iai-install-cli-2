import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidWebhookSecret } from '../src/steps/webhook.js';

test('Clerk webhook signing secret requires a complete whsec_ value', () => {
  assert.equal(isValidWebhookSecret('whsec_abcdefghijklmnop'), true);
  assert.equal(isValidWebhookSecret('whsec_abc-DEF_123456789'), true);
  // Svix secrets are standard base64: '+', '/' and '=' are legitimate.
  assert.equal(isValidWebhookSecret('whsec_C2FVsBQIhrscChlQIMV+b5sSYspob7oD'), true);
  assert.equal(isValidWebhookSecret('whsec_4casG/Ne0uZzLerHdEDDwSXoJZQwUnCG'), true);
  assert.equal(isValidWebhookSecret('whsec_abcdefghijklmno='), true);
  assert.equal(isValidWebhookSecret('whsec_'), false);
  assert.equal(isValidWebhookSecret('whsec_short'), false);
  assert.equal(isValidWebhookSecret('sk_test_abcdefghijklmnop'), false);
});
