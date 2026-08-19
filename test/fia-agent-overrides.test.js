import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolveForPhase, validate } from '../fia-templates/modules/agents.mjs';

const SYSTEM = fileURLToPath(new URL('../fia-templates/data/prompt_engineering/builder/system.md', import.meta.url));
const USER = fileURLToPath(new URL('../fia-templates/data/prompt_engineering/builder/user.md', import.meta.url));

function builder(phase_overrides) {
  return {
    name: 'builder',
    coding_agent: 'pi',
    model: 'openai-codex/gpt-5.6-sol',
    thinking: 'high',
    effort: 'high',
    writes: ['src/'],
    prompt_engineering: { system: SYSTEM, user: USER },
    phase_overrides,
  };
}

test('resolveForPhase: exact/wildcard tuning applies without mutating the base agent', () => {
  const base = builder({ 'fix_*': { thinking: 'low' }, fix_ui: { effort: 'medium' } });
  const cfg = { agents: [base] };

  const wildcard = resolveForPhase(cfg, 'builder', 'fix_1');
  assert.equal(wildcard.thinking, 'low');
  assert.equal(wildcard.effort, 'high');

  const exact = resolveForPhase(cfg, 'builder', 'fix_ui');
  assert.equal(exact.thinking, 'high', 'an exact entry wins instead of merging an earlier wildcard');
  assert.equal(exact.effort, 'medium');
  assert.equal(base.thinking, 'high', 'phase resolution never mutates the canonical roster');
});

test('resolveForPhase: protected fields are ignored defensively even before validation', () => {
  const base = builder({
    build: {
      coding_agent: 'claude_code',
      model: 'opus',
      writes: [],
      prompt_engineering: { system: '/tmp/other', user: '/tmp/other' },
      thinking: 'low',
    },
  });
  const resolved = resolveForPhase({ agents: [base] }, 'builder', 'build');
  assert.equal(resolved.coding_agent, 'pi');
  assert.equal(resolved.model, 'openai-codex/gpt-5.6-sol');
  assert.deepEqual(resolved.writes, ['src/']);
  assert.equal(resolved.prompt_engineering, base.prompt_engineering);
  assert.equal(resolved.thinking, 'low');
});

test('validate: phase overrides reject engine/permission changes and malformed patterns', () => {
  assert.throws(
    () => validate({ agents: [builder({ build: { coding_agent: 'claude_code' } })] }, ['builder']),
    /unsupported field\(s\): coding_agent/,
  );
  assert.throws(
    () => validate({ agents: [builder({ 'fix_*_later': { thinking: 'low' } })] }, ['builder']),
    /invalid phase_overrides pattern/,
  );
});

test('validate: thinking/effort overrides pass', () => {
  assert.doesNotThrow(() =>
    validate({ agents: [builder({ 'fix_*': { thinking: 'low' }, review: { effort: 'medium' } })] }, ['builder']),
  );
});
