import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyVerify } from '../src/steps/auth.js';

test('classifyVerify: good token proceeds', () => {
  assert.equal(classifyVerify({ ok: true, status: 200, data: { user: {} } }), 'ok');
});

test('classifyVerify: inactive subscription is final (a fresh login does not fix it)', () => {
  assert.equal(classifyVerify({ ok: false, status: 403 }), 'inactive');
  assert.equal(
    classifyVerify({ ok: false, status: 200, data: { reason: 'no_active_enrollment' } }),
    'inactive',
  );
});

test('classifyVerify: 5xx and network down do NOT invalidate the token', () => {
  // Regression of the real bug: with the gate returning 500 (CLI_TOKEN_PEPPER
  // missing) the CLI wiped every logged-in student's credential and forced a re-login.
  assert.equal(classifyVerify({ ok: false, status: 500 }), 'unavailable');
  assert.equal(classifyVerify({ ok: false, status: 502 }), 'unavailable');
  assert.equal(classifyVerify({ ok: false, status: 503 }), 'unavailable');
  assert.equal(classifyVerify({ ok: false }), 'unavailable', 'no status = no response');
  assert.equal(classifyVerify({ ok: false, status: 0 }), 'unavailable');
});

test('classifyVerify: 401 and the like require a fresh login', () => {
  assert.equal(classifyVerify({ ok: false, status: 401 }), 'expired');
  assert.equal(classifyVerify({ ok: false, status: 404 }), 'expired');
  assert.equal(classifyVerify({ ok: false, status: 422 }), 'expired');
});
