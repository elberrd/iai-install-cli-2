import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stateDirPath } from '../src/lib/state-dir.js';
import { hasStateMarker, LEGACY_STATE_MARKER, STATE_MARKER } from '../src/steps/project.js';

const makeHome = () => mkdtempSync(join(tmpdir(), 'impactus-state-home-'));

test('stateDirPath: fresh machine → ~/.impactus-cli, nothing created on disk', () => {
  const home = makeHome();
  assert.equal(stateDirPath(home), join(home, '.impactus-cli'));
  assert.equal(existsSync(join(home, '.impactus-cli')), false, 'a pure path builder must not mkdir');
});

test('stateDirPath: pre-rebrand ~/.create-iai is RENAMED — token, keys and logs survive', () => {
  const home = makeHome();
  mkdirSync(join(home, '.create-iai', 'keys'), { recursive: true });
  writeFileSync(join(home, '.create-iai', 'auth.json'), '{"token":"t"}\n');
  writeFileSync(join(home, '.create-iai', 'keys', 'app.env'), 'STRIPE_SECRET_KEY=sk\n');

  const dir = stateDirPath(home);
  assert.equal(dir, join(home, '.impactus-cli'));
  assert.equal(readFileSync(join(dir, 'auth.json'), 'utf8'), '{"token":"t"}\n');
  assert.equal(readFileSync(join(dir, 'keys', 'app.env'), 'utf8'), 'STRIPE_SECRET_KEY=sk\n');
  assert.equal(existsSync(join(home, '.create-iai')), false, 'renamed, not copied');
});

test('stateDirPath: when BOTH exist the new folder wins and the legacy one is left alone', () => {
  const home = makeHome();
  mkdirSync(join(home, '.impactus-cli'), { recursive: true });
  writeFileSync(join(home, '.impactus-cli', 'auth.json'), '{"token":"new"}\n');
  mkdirSync(join(home, '.create-iai'), { recursive: true });
  writeFileSync(join(home, '.create-iai', 'auth.json'), '{"token":"old"}\n');

  assert.equal(stateDirPath(home), join(home, '.impactus-cli'));
  assert.equal(readFileSync(join(home, '.impactus-cli', 'auth.json'), 'utf8'), '{"token":"new"}\n');
  assert.equal(existsSync(join(home, '.create-iai', 'auth.json')), true, 'never deleted');
});

test('hasStateMarker: accepts the current AND the pre-rebrand marker name', () => {
  const none = mkdtempSync(join(tmpdir(), 'impactus-marker-'));
  assert.equal(hasStateMarker(none), false);

  const current = mkdtempSync(join(tmpdir(), 'impactus-marker-'));
  writeFileSync(join(current, STATE_MARKER), '{}\n');
  assert.equal(hasStateMarker(current), true);

  const legacy = mkdtempSync(join(tmpdir(), 'impactus-marker-'));
  writeFileSync(join(legacy, LEGACY_STATE_MARKER), '{}\n');
  assert.equal(hasStateMarker(legacy), true, 'an install started by the old CLI still resumes');
});
