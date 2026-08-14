import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCloudflareAccounts, slugify, tokenize } from '../src/lib/util.js';

test('slugify: normalizes human names', () => {
  assert.equal(slugify('Meu App Incrível'), 'meu-app-incrivel');
  assert.equal(slugify('  --Olá Mundo--  '), 'ola-mundo');
  assert.equal(slugify(''), 'my-app');
  assert.equal(slugify('já-válido'), 'ja-valido');
});

test('tokenize: splits commands honoring quotes', () => {
  assert.deepEqual(tokenize('npx shadcn@latest init --preset b0'), [
    'npx',
    'shadcn@latest',
    'init',
    '--preset',
    'b0',
  ]);
  assert.deepEqual(tokenize(`npx shadcn@latest init --preset 'https://ui.shadcn.com/init?a=1&b=2'`), [
    'npx',
    'shadcn@latest',
    'init',
    '--preset',
    'https://ui.shadcn.com/init?a=1&b=2',
  ]);
  assert.deepEqual(tokenize('cmd "dois tokens" tres'), ['cmd', 'dois tokens', 'tres']);
  assert.deepEqual(tokenize(''), []);
});

test('extractCloudflareAccounts: wrangler whoami table', () => {
  const out = [
    'Getting User settings...',
    '👋 You are logged in with an OAuth Token, associated with the email user@example.com.',
    '┌───────────────────────┬──────────────────────────────────┐',
    '│ Account Name          │ Account ID                       │',
    '├───────────────────────┼──────────────────────────────────┤',
    "│ Elber's Account       │ 0123456789abcdef0123456789abcdef │",
    '│ Empresa XPTO          │ ffffffffffffffffffffffffffffffff │',
    '└───────────────────────┴──────────────────────────────────┘',
  ].join('\n');
  assert.deepEqual(extractCloudflareAccounts(out), [
    { id: '0123456789abcdef0123456789abcdef', name: "Elber's Account" },
    { id: 'ffffffffffffffffffffffffffffffff', name: 'Empresa XPTO' },
  ]);
});

test('extractCloudflareAccounts: no accounts / duplicates', () => {
  assert.deepEqual(extractCloudflareAccounts('You are not authenticated.'), []);
  assert.deepEqual(extractCloudflareAccounts(''), []);
  const dup = 'A │ 0123456789abcdef0123456789abcdef\nB │ 0123456789abcdef0123456789abcdef';
  assert.equal(extractCloudflareAccounts(dup).length, 1);
});
