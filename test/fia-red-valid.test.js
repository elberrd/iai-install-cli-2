import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRedReason } from '../fia-templates/modules/gates.mjs';

// ── valid RED: assertion failures across the three supported runners ─────────

const nodeTestOutput = [
  '✖ adds VAT to the net price (2.1ms)',
  '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
  '  119 !== 121',
  '      at TestContext.<anonymous> (file:///repo/test/vat.test.js:9:10)',
].join('\n');

const vitestOutput = [
  ' FAIL  src/cart.test.ts > cart > applies the discount once',
  'AssertionError: expected 20 to be 10 // Object.is equality',
  '- Expected',
  '+ Received',
  '- 10',
  '+ 20',
  ' ❯ src/cart.test.ts:14:23',
].join('\n');

const jestOutput = [
  ' FAIL  ./sum.test.js',
  '  ● adds 1 + 2 to equal 3',
  '',
  '    expect(received).toBe(expected) // Object.is equality',
  '',
  '    Expected: 3',
  '    Received: 4',
  '',
  '      at Object.toBe (sum.test.js:4:17)',
].join('\n');

test('validateRedReason: node:test assertion failure is a valid RED', () => {
  const r = validateRedReason(nodeTestOutput);
  assert.equal(r.valid, true);
  assert.equal(r.classification, 'assertion');
});

test('validateRedReason: vitest assertion failure is a valid RED', () => {
  const r = validateRedReason(vitestOutput);
  assert.equal(r.valid, true);
  assert.equal(r.classification, 'assertion');
});

test('validateRedReason: jest expect diff is a valid RED', () => {
  const r = validateRedReason(jestOutput);
  assert.equal(r.valid, true);
  assert.equal(r.classification, 'assertion');
});

test('validateRedReason: chai-style prose assertion is a valid RED', () => {
  const r = validateRedReason('Error: expected [] to have length 3\n    at chain.js:1:1');
  assert.equal(r.valid, true);
  assert.equal(r.classification, 'assertion');
});

test('validateRedReason: an assertion ABOUT an env/syntax value is still an assertion', () => {
  // The bug under test is about error handling: the expected/actual values
  // legitimately quote ENOENT and a parser message — that is not a broken run.
  const enoent = [
    '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    "+ actual - expected",
    "+ 'EACCES'",
    "- 'ENOENT'",
    '      at TestContext.<anonymous> (file:///repo/test/fs.test.js:9:10)',
  ].join('\n');
  assert.equal(validateRedReason(enoent).classification, 'assertion');

  const parser = 'AssertionError: expected "Unexpected token }" to be "invalid JSON"';
  assert.equal(validateRedReason(parser).classification, 'assertion');
});

// ── invalid RED: environment ─────────────────────────────────────────────────

test('validateRedReason: CJS module-not-found is environment, not a RED', () => {
  const out = [
    "Error: Cannot find module '../lib/prices'",
    'Require stack:',
    '- /repo/test/vat.test.js',
    "    code: 'MODULE_NOT_FOUND'",
  ].join('\n');
  const r = validateRedReason(out);
  assert.equal(r.valid, false);
  assert.equal(r.classification, 'environment');
  assert.match(r.note, /module not found/);
});

test('validateRedReason: ESM package-not-found is environment', () => {
  const r = validateRedReason(
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'left-pad' imported from /repo/src/cart.ts",
  );
  assert.equal(r.valid, false);
  assert.equal(r.classification, 'environment');
});

test('validateRedReason: environment wins even when the output quotes expect() code', () => {
  // jest "Test suite failed to run" prints the code frame — the `expect(` in
  // it must NOT be read as an assertion failure.
  const out = [
    ' FAIL  ./sum.test.js',
    '  ● Test suite failed to run',
    '',
    "    Cannot find module './sum' from 'sum.test.js'",
    '',
    "    > 1 | const sum = require('./sum');",
    '    > 4 | expect(sum(1, 2)).toBe(3);',
  ].join('\n');
  const r = validateRedReason(out);
  assert.equal(r.valid, false);
  assert.equal(r.classification, 'environment');
});

test('validateRedReason: command not found / ENOENT is environment', () => {
  assert.equal(validateRedReason('sh: vitest: command not found').classification, 'environment');
  assert.equal(validateRedReason('Error: spawn vitest ENOENT').classification, 'environment');
});

test('validateRedReason: EADDRINUSE is environment', () => {
  const r = validateRedReason('Error: listen EADDRINUSE: address already in use :::3000');
  assert.equal(r.valid, false);
  assert.equal(r.classification, 'environment');
});

test('validateRedReason: missing environment variable is environment', () => {
  const r = validateRedReason('Error: Missing required environment variable DATABASE_URL');
  assert.equal(r.valid, false);
  assert.equal(r.classification, 'environment');
});

test('validateRedReason: npm dependency error is environment', () => {
  const r = validateRedReason("npm ERR! missing script: test\nnpm ERR! A complete log of this run…");
  assert.equal(r.valid, false);
  assert.equal(r.classification, 'environment');
});

// ── invalid RED: syntax ──────────────────────────────────────────────────────

test('validateRedReason: SyntaxError is syntax, not a RED', () => {
  const out = ["SyntaxError: Unexpected token ')'", '    at compileSourceTextModule (node:internal/modules/esm/utils:340:16)'].join('\n');
  const r = validateRedReason(out);
  assert.equal(r.valid, false);
  assert.equal(r.classification, 'syntax');
});

test('validateRedReason: transform/parse failures are syntax', () => {
  assert.equal(validateRedReason('Transform failed with 1 error:\nexpected ";" but found "}"').classification, 'syntax');
  assert.equal(validateRedReason('Parsing error: Unexpected character').classification, 'syntax');
});

// ── unknown → invalid (conservative) ─────────────────────────────────────────

test('validateRedReason: unexplained failure is invalid and asks for a clearer one', () => {
  const r = validateRedReason('Error: something exploded\n    at foo.js:1:1');
  assert.equal(r.valid, false);
  assert.equal(r.classification, 'unknown');
  assert.match(r.note, /assertion/);
});

test('validateRedReason: empty output is unknown, never valid', () => {
  const r = validateRedReason('');
  assert.equal(r.valid, false);
  assert.equal(r.classification, 'unknown');
  assert.equal(validateRedReason(null).valid, false);
});
