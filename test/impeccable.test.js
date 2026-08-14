import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeAtLeast } from '../src/steps/impeccable.js';
import { parseArgs } from '../src/lib/args.js';

test('nodeAtLeast: compares major.minor.patch correctly', () => {
  assert.equal(nodeAtLeast('22.12.0', '22.12.0'), true);
  assert.equal(nodeAtLeast('22.12.0', '22.12.1'), true);
  assert.equal(nodeAtLeast('22.12.0', '23.0.0'), true);
  assert.equal(nodeAtLeast('22.12.0', '22.11.9'), false);
  assert.equal(nodeAtLeast('22.12.0', '20.9.0'), false);
  // Non-numeric suffixes (nightly) must not break the comparison.
  assert.equal(nodeAtLeast('22.12.0', '22.12.0-nightly'), true);
});

test('parseArgs: Impeccable flags', () => {
  assert.equal(parseArgs(['--impeccable']).flags.impeccable, true);
  assert.equal(parseArgs(['--no-impeccable']).flags.impeccable, false);
  assert.equal(parseArgs(['--skip-impeccable']).flags.skipImpeccable, true);
});
