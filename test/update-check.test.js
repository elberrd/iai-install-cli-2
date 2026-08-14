import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNewer } from '../src/main.js';

// The installer's update check compares the npm registry version against the
// local one. The old comparison mapped '2.0.0-alpha.0' to NaN — publishing
// alpha.1 never warned alpha.0 users.

test('isNewer: plain releases compare by numeric core', () => {
  assert.equal(isNewer('2.0.1', '2.0.0'), true);
  assert.equal(isNewer('2.0.0', '2.0.1'), false);
  assert.equal(isNewer('2.0.0', '2.0.0'), false);
  assert.equal(isNewer('2.1.0', '2.0.9'), true);
  assert.equal(isNewer('3.0.0', '2.99.99'), true);
});

test('isNewer: a release beats any prerelease of the same core', () => {
  assert.equal(isNewer('2.0.0', '2.0.0-alpha.0'), true);
  assert.equal(isNewer('2.0.0-alpha.0', '2.0.0'), false);
});

test('isNewer: prerelease vs a different core still follows the core', () => {
  assert.equal(isNewer('2.0.1-alpha.0', '2.0.0'), true);
  assert.equal(isNewer('2.0.0-alpha.0', '2.0.1'), false);
});

test('isNewer: two prereleases compare part by part', () => {
  assert.equal(isNewer('2.0.0-alpha.1', '2.0.0-alpha.0'), true);
  assert.equal(isNewer('2.0.0-alpha.0', '2.0.0-alpha.1'), false);
  assert.equal(isNewer('2.0.0-alpha.0', '2.0.0-alpha.0'), false);
  // Numeric parts compare numerically (10 > 9, not lexically '1' < '9').
  assert.equal(isNewer('2.0.0-alpha.10', '2.0.0-alpha.9'), true);
  // Non-numeric parts compare lexically.
  assert.equal(isNewer('2.0.0-beta.0', '2.0.0-alpha.9'), true);
  assert.equal(isNewer('2.0.0-alpha.0', '2.0.0-beta.0'), false);
  // More parts wins a tie on the shared prefix (semver precedence).
  assert.equal(isNewer('2.0.0-alpha.0.1', '2.0.0-alpha.0'), true);
  assert.equal(isNewer('2.0.0-alpha.0', '2.0.0-alpha.0.1'), false);
});
