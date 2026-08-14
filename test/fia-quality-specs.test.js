import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultSpecs } from '../fia-templates/modules/quality.mjs';

function specFor(specs, name) {
  return specs.find((s) => s.name === name);
}

test('defaultSpecs: resolves the live1/live2 templates\' "type-check"', () => {
  const root = mkdtempSync(join(tmpdir(), 'quality-specs-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { 'type-check': 'tsc --noEmit' } }));
  const specs = defaultSpecs(root);
  assert.deepEqual(specFor(specs, 'typecheck').argv, ['npm', 'run', 'type-check']);
});

test('defaultSpecs: explicit "typecheck" takes precedence', () => {
  const root = mkdtempSync(join(tmpdir(), 'quality-specs-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc', 'type-check': 'x' } }));
  assert.deepEqual(specFor(defaultSpecs(root), 'typecheck').argv, ['npm', 'run', 'typecheck']);
});

test('defaultSpecs: no readable package.json keeps the defaults without breaking', () => {
  const root = mkdtempSync(join(tmpdir(), 'quality-specs-'));
  const specs = defaultSpecs(root);
  assert.equal(specs.length, 4);
  assert.deepEqual(specFor(specs, 'typecheck').argv, ['npm', 'run', 'typecheck']);
  assert.deepEqual(specFor(specs, 'build').argv, ['npm', 'run', 'build']);
});
