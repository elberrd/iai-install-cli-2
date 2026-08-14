import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDecisions } from '../src/lib/decisions.js';
import { SHADCN } from '../src/config.js';

// Convention: undefined = ask; null = "none"; value = decided.

test('resolveDecisions: with no flags, everything is left for the wizard to ask', () => {
  const d = resolveDecisions({});
  assert.equal(d.updateDeps, undefined);
  assert.equal(d.shadcnPreset, undefined);
  assert.equal(d.shadcnBlocks, undefined);
  assert.equal(d.storage, undefined);
  assert.equal(d.webhook, undefined);
  assert.equal(d.push, undefined);
  assert.equal(d.visibility, undefined);
  assert.equal(d.deploy, undefined);
  assert.equal(d.fia, undefined);
  assert.equal(d.impeccable, undefined);
});

test('resolveDecisions: --yes never leaves a question pending (safe defaults)', () => {
  const d = resolveDecisions({ yes: true });
  assert.equal(d.updateDeps, 'none');
  assert.equal(d.shadcnPreset, null, 'no preset in automatic mode');
  assert.deepEqual(d.shadcnBlocks, [SHADCN.defaultBlock], 'classic block kept under -y');
  assert.equal(d.storage, 'convex');
  assert.equal(d.webhook, false, 'webhook requires the dashboard — automation does not turn it on');
  assert.equal(d.push, false, 'creating a remote repo is irreversible — opt-in');
  assert.equal(d.visibility, 'private');
  assert.equal(d.deploy, false, 'deploy is opt-in in automatic mode');
  assert.equal(d.fia, true, 'FIA on by default in v2');
  assert.equal(d.impeccable, true, 'Impeccable is local/reversible — on by default');
  // repoName is the only conditional one: it only matters with push=true, and
  // then the wizard fills in the project slug as the default.
  for (const [key, value] of Object.entries(d)) {
    if (key === 'repoName') continue;
    assert.notEqual(value, undefined, `${key} cannot stay pending under --yes`);
  }
});

test('resolveDecisions: flags decide and the question goes away (same precedence as the steps)', () => {
  const d = resolveDecisions({
    updateDeps: 'safe',
    shadcnPreset: 'b0',
    shadcnBlock: 'dashboard-01,login-01',
    storage: 'r2',
    push: true,
    repo: 'meu-repo',
    public: true,
    deploy: true,
  });
  assert.equal(d.updateDeps, 'safe');
  assert.equal(d.shadcnPreset, 'b0');
  assert.deepEqual(d.shadcnBlocks, ['dashboard-01', 'login-01']);
  assert.equal(d.storage, 'r2');
  assert.equal(d.push, true);
  assert.equal(d.repoName, 'meu-repo');
  assert.equal(d.visibility, 'public');
  assert.equal(d.deploy, true);
});

test('resolveDecisions: skips and negations become "don\'t use" without asking', () => {
  const d = resolveDecisions({
    skipShadcn: true,
    skipStorage: true,
    skipWebhook: true,
    skipGithub: true,
    skipDeploy: true,
  });
  assert.equal(d.shadcnPreset, null);
  assert.equal(d.shadcnBlocks, null);
  assert.equal(d.storage, 'convex');
  assert.equal(d.webhook, false);
  assert.equal(d.push, false);
  assert.equal(d.deploy, false);
});

test('resolveDecisions: --shadcn-block none e --no-push/--no-deploy', () => {
  const d = resolveDecisions({ shadcnBlock: 'none', push: false, deploy: false });
  assert.equal(d.shadcnBlocks, null);
  assert.equal(d.push, false);
  assert.equal(d.deploy, false);
});

test('resolveDecisions: --yes respects explicit flags over the defaults', () => {
  const d = resolveDecisions({ yes: true, storage: 'r2', push: true, deploy: true, updateDeps: 'safe' });
  assert.equal(d.storage, 'r2');
  assert.equal(d.push, true);
  assert.equal(d.deploy, true);
  assert.equal(d.updateDeps, 'safe');
});

test('resolveDecisions: --no-fia and --skip-fia turn FIA off', () => {
  assert.equal(resolveDecisions({ fia: false }).fia, false);
  assert.equal(resolveDecisions({ skipFia: true }).fia, false);
  assert.equal(resolveDecisions({ fia: true }).fia, true);
});

test('resolveDecisions: --no-impeccable and --skip-impeccable turn Impeccable off', () => {
  assert.equal(resolveDecisions({ impeccable: false }).impeccable, false);
  assert.equal(resolveDecisions({ skipImpeccable: true }).impeccable, false);
  assert.equal(resolveDecisions({ impeccable: true }).impeccable, true);
  assert.equal(resolveDecisions({ yes: true, impeccable: false }).impeccable, false, '--yes does not override the negation');
});
