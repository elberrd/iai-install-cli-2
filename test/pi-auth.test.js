import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSemver, isNewer, piInstallError, piPackageRefreshPlan } from '../src/lib/pi-auth.js';

test('parseSemver: extracts x.y.z from the `pi --version` format', () => {
  assert.equal(parseSemver('pi v0.73.1'), '0.73.1');
  assert.equal(parseSemver('0.83.0\n'), '0.83.0');
  assert.equal(parseSemver('no version here'), null);
});

test('isNewer: simple semver comparison', () => {
  assert.equal(isNewer('0.83.0', '0.73.1'), true);
  assert.equal(isNewer('0.73.1', '0.83.0'), false);
  assert.equal(isNewer('0.73.1', '0.73.1'), false);
  assert.equal(isNewer('1.0.0', '0.99.99'), true);
});

test('isNewer: prerelease precedence — the launch update probe lives on 2.0.0-alpha.N', () => {
  assert.equal(isNewer('2.0.0-alpha.4', '2.0.0-alpha.3'), true);
  assert.equal(isNewer('2.0.0-alpha.3', '2.0.0-alpha.3'), false);
  assert.equal(isNewer('2.0.0-alpha.10', '2.0.0-alpha.9'), true, 'numeric prerelease segments compare numerically');
  assert.equal(isNewer('2.0.0', '2.0.0-alpha.3'), true, 'the release beats its own prereleases');
  assert.equal(isNewer('2.0.0-alpha.3', '2.0.0'), false);
  assert.equal(isNewer('2.0.0-beta.1', '2.0.0-alpha.9'), true, 'alpha < beta');
  assert.equal(isNewer('2.0.0-alpha.3.1', '2.0.0-alpha.3'), true, 'longer prerelease with equal prefix is newer');
  assert.equal(isNewer('2.0.1-alpha.1', '2.0.0'), true, 'core still dominates');
});

test('piInstallError: EACCES explains the real cause and never suggests sudo', () => {
  const err = piInstallError({ ok: false, stderr: 'npm ERR! Error: EACCES: permission denied, mkdir /usr/local/lib/node_modules' });
  assert.equal(err.name, 'PiInstallError');
  assert.match(err.message, /EACCES/);
  assert.match(err.message, /nodejs\.org|nvm/, 'points at reinstalling Node in user space');
  assert.match(err.message, /Do NOT run it with sudo/);
  assert.ok(!/^\s*sudo /m.test(err.message), 'no sudo command is ever recommended');
});

test('piInstallError: generic failure keeps the npm tail and the manual command', () => {
  const err = piInstallError({ ok: false, stderr: 'npm ERR! network request failed' });
  assert.equal(err.name, 'PiInstallError');
  assert.match(err.message, /network request failed/);
  assert.match(err.message, /npm install -g @earendil-works\/pi-coding-agent/);
});

test('piPackageRefreshPlan: absent or npm-pinned entries refresh', () => {
  assert.deepEqual(piPackageRefreshPlan(null), {
    'pi-subagents': 'refresh',
    'pi-mcp-adapter': 'refresh',
    'pi-web-access': 'refresh',
  });
  const pinned = {
    packages: ['npm:pi-subagents@1.2.3', { source: 'npm:pi-mcp-adapter@0.9.0' }, 'npm:pi-web-access'],
  };
  assert.deepEqual(piPackageRefreshPlan(pinned), {
    'pi-subagents': 'refresh',
    'pi-mcp-adapter': 'refresh',
    'pi-web-access': 'refresh',
  });
  // Unrelated entries never flag ours — including a name that merely
  // CONTAINS ours (that used to mark pi-subagents custom and skip its
  // install even on a fresh machine).
  assert.deepEqual(piPackageRefreshPlan({ packages: ['npm:some-other@1.0.0', 'npm:pi-subagents-extras@1.0.0'] }), {
    'pi-subagents': 'refresh',
    'pi-mcp-adapter': 'refresh',
    'pi-web-access': 'refresh',
  });
  // A malformed settings shape (packages not an array) degrades, never throws.
  assert.deepEqual(piPackageRefreshPlan({ packages: { 'pi-subagents': 'npm:pi-subagents@1.2.3' } }), {
    'pi-subagents': 'refresh',
    'pi-mcp-adapter': 'refresh',
    'pi-web-access': 'refresh',
  });
});

test("piPackageRefreshPlan: customized sources are the student's — never overwritten", () => {
  const custom = {
    packages: [
      'git:github.com/acme/pi-subagents.git#main', // fork checkout
      { source: 'file:../pi-mcp-adapter' }, // local path
      'npm:pi-web-access@beta', // dist-tag pin (not an exact semver)
    ],
  };
  assert.deepEqual(piPackageRefreshPlan(custom), {
    'pi-subagents': 'custom',
    'pi-mcp-adapter': 'custom',
    'pi-web-access': 'custom',
  });
  // A scoped fork identifies the same package — the student's choice wins.
  assert.equal(piPackageRefreshPlan({ packages: ['npm:@acme/pi-subagents@2.0.0'] })['pi-subagents'], 'custom');
});
