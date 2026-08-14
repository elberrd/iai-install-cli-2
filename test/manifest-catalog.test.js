import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogFromManifest } from '../src/lib/addons.js';

const GROUPS = [
  {
    id: 'ia',
    flag: 'ia',
    title: 'Artificial intelligence',
    options: [
      { value: 'none', label: 'None', recommended: true },
      { value: 'ai-chat', label: 'AI Chat', recommended: false },
    ],
  },
  {
    id: 'quality',
    flag: 'addons',
    title: 'Quality',
    options: [
      { value: 'commitlint', label: 'Commitlint', recommended: true },
      { value: 'knip', label: 'Knip' },
    ],
  },
];

test('catalogFromManifest: manifest without groups → null (falls back to the CLI catalog)', () => {
  assert.equal(catalogFromManifest(null), null);
  assert.equal(catalogFromManifest({}), null);
  assert.equal(catalogFromManifest({ addons: { sentry: {} } }), null);
  assert.equal(catalogFromManifest({ groups: [] }), null);
  // Malformed group (no flag) → null, never a half-broken catalog.
  assert.equal(catalogFromManifest({ groups: [{ id: 'x', title: 'X', options: [] }] }), null);
});

test('catalogFromManifest: valid groups → catalog with derived presets', () => {
  const catalog = catalogFromManifest({ groups: GROUPS });
  assert.ok(catalog);
  assert.deepEqual(catalog.allIds, ['ai-chat', 'commitlint', 'knip']);
  assert.deepEqual(catalog.presets.minimo, []);
  // padrao = recommended without 'none'
  assert.deepEqual(catalog.presets.padrao, ['commitlint']);
});

test('catalogFromManifest: manifest presets win over the derived ones', () => {
  const catalog = catalogFromManifest({
    groups: GROUPS,
    presets: { padrao: ['knip'], completo: ['ai-chat', 'commitlint', 'knip'] },
  });
  assert.deepEqual(catalog.presets.padrao, ['knip']);
  assert.deepEqual(catalog.presets.completo, ['ai-chat', 'commitlint', 'knip']);
  assert.deepEqual(catalog.presets.minimo, []);
});
