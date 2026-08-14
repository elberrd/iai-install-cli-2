import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RECOMMENDED_STACK,
  STACK_CATEGORIES,
  STACK_LATER,
  STACK_OPTIONS,
  stackOption,
} from '../src/stack-catalog.js';

// The catalog is the single source: wizard, manifest, and tooling depend on its shape.

test('catalog: category ids are unique and have registered options', () => {
  const ids = STACK_CATEGORIES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate categories');
  for (const cat of STACK_CATEGORIES) {
    const options = STACK_OPTIONS[cat.id];
    assert.ok(Array.isArray(options) && options.length > 0, `category ${cat.id} has no options`);
    const optIds = options.map((o) => o.id);
    assert.equal(new Set(optIds).size, optIds.length, `duplicate options in ${cat.id}`);
    assert.ok(!optIds.includes(STACK_LATER), `"${STACK_LATER}" is a sentinel, not an option (${cat.id})`);
    assert.ok(cat.label && cat.question, `category ${cat.id} has no label/question`);
  }
});

test('catalog: every category defaultId exists among the options', () => {
  for (const cat of STACK_CATEGORIES) {
    assert.ok(
      STACK_OPTIONS[cat.id].some((o) => o.id === cat.defaultId),
      `defaultId "${cat.defaultId}" does not exist in ${cat.id}`,
    );
  }
});

test('catalog: RECOMMENDED_STACK covers every category with valid options', () => {
  for (const cat of STACK_CATEGORIES) {
    const value = RECOMMENDED_STACK[cat.id];
    assert.ok(value, `recommended stack is missing category ${cat.id}`);
    assert.ok(stackOption(cat.id, value), `invalid recommended option: ${cat.id}=${value}`);
  }
});

test('catalog: tooling shapes (cli/mcp/skills) are complete where declared', () => {
  for (const [catId, options] of Object.entries(STACK_OPTIONS)) {
    for (const opt of options) {
      assert.ok(opt.label && opt.role !== undefined, `${catId}/${opt.id} has no label/role`);
      assert.ok(Array.isArray(opt.docs), `${catId}/${opt.id} has no docs[]`);
      if (opt.cli) {
        assert.ok(opt.cli.bin && opt.cli.name && opt.cli.install, `${catId}/${opt.id}: incomplete cli`);
        assert.ok(Array.isArray(opt.cli.loginArgs), `${catId}/${opt.id}: cli has no loginArgs`);
      }
      if (opt.mcp) {
        assert.ok(opt.mcp.name && Array.isArray(opt.mcp.addArgs), `${catId}/${opt.id}: incomplete mcp`);
      }
      if (opt.skills) {
        assert.ok(opt.skills.source && Array.isArray(opt.skills.skills), `${catId}/${opt.id}: incomplete skills`);
      }
      if (opt.envs) {
        assert.ok(Array.isArray(opt.envs.dev) && Array.isArray(opt.envs.prod), `${catId}/${opt.id}: envs missing dev/prod`);
      }
    }
  }
});

test('stackOption: resolves by id and treats `depois`/unknown as null', () => {
  assert.equal(stackOption('database', 'neon')?.label, 'Neon (Postgres serverless)');
  assert.equal(stackOption('database', STACK_LATER), null);
  assert.equal(stackOption('database', 'nonexistent'), null);
  assert.equal(stackOption('ghost-category', 'neon'), null);
});

test('catalog: automations defaults to "none" and Modal declares its own tooling', () => {
  const cat = STACK_CATEGORIES.find((c) => c.id === 'automations');
  assert.ok(cat, 'automations category exists');
  assert.equal(cat.defaultId, 'none', 'external automations must be opt-in, never a default');
  const modal = stackOption('automations', 'modal');
  assert.equal(modal.cli.bin, 'modal');
  assert.equal(modal.cli.install.pip, 'modal', 'Modal installs via pip, not npm/brew');
  assert.deepEqual(modal.cli.loginArgs, ['setup']);
  assert.ok(RECOMMENDED_STACK.automations === 'none', 'recommended stack runs everything inside the app');
});

test('catalog: Neon claim points to the Launchpad', () => {
  const neon = stackOption('database', 'neon');
  assert.ok(neon.claim?.api.startsWith('https://neon.new/'), 'the Neon claim must use neon.new');
});
