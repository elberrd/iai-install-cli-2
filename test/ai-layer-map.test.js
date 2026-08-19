import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { mapAiLayer } from '../scripts/ai-layer-map.mjs';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'ai-layer-map.mjs');
const HARNESS = join(import.meta.dirname, '..', 'harness');

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'ai-layer-map-'));
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

function paths(report, engine, category) {
  return report.engines[engine][category].map((item) => item.path);
}

test('maps always-loaded, on-demand and enforcement files per engine', () => {
  const root = fixture({
    'CLAUDE.md': '# Claude\n',
    'packages/api/CLAUDE.md': '# Scoped Claude rules\n',
    '.claude/rules/global.md': '# Global Claude rule\n',
    '.claude/rules/scoped.md': '---\npaths:\n  - "src/**/*.ts"\n---\nScoped.\n',
    'AGENTS.md': '# Root Codex rules\n',
    'packages/api/AGENTS.md': '# Scoped Codex rules\n',
    '.pi/prompts/agents.md': '# On-demand Pi prompt, not Codex rules\n',
    'nested-checkout/.git/HEAD': 'ref: refs/heads/main\n',
    'nested-checkout/AGENTS.md': '# Different repository\n',
    '.cursor/rules/always.mdc': '---\nalwaysApply: true\n---\nAlways.\n',
    '.cursor/rules/scoped.mdc': '---\nglobs: src/**\nalwaysApply: false\n---\nScoped.\n',
    '.pi/APPEND_SYSTEM.md': 'System appendix.\n',
    '.agents/skills/local/SKILL.md': '---\nname: local\ndescription: local\n---\n',
    '.agents/agents/shared.md': '# Shared agent\n',
    '.agents/commands/shared.md': '# Shared command\n',
    '.claude/skills/local/SKILL.md': '---\nname: local\ndescription: local\n---\n',
    '.claude/commands/bug.md': '# Bug\n',
    '.cursor/commands/bug.md': '# Bug\n',
    '.pi/prompts/bug.md': '# Bug\n',
    '.claude/settings.json': '{}\n',
    '.cursor/hooks.json': '{}\n',
    '.pi/extensions/guard.mjs': 'export default {};\n',
    'imp/modules/gates.mjs': 'export const gate = true;\n',
  });

  const report = mapAiLayer(root);
  assert.equal(report.schema_version, 1);
  assert.ok(report.traversal.observed.entries > 0);
  assert.ok(report.traversal.observed.directories > 0);
  assert.ok(report.traversal.observed.files > 0);
  assert.deepEqual(paths(report, 'claude', 'always_loaded'), ['.claude/rules/global.md', 'CLAUDE.md']);
  assert.ok(paths(report, 'claude', 'on_demand').includes('.claude/rules/scoped.md'));
  assert.ok(paths(report, 'claude', 'on_demand').includes('packages/api/CLAUDE.md'));
  assert.deepEqual(paths(report, 'codex', 'always_loaded'), ['AGENTS.md']);
  assert.ok(paths(report, 'codex', 'on_demand').includes('packages/api/AGENTS.md'));
  assert.ok(!paths(report, 'codex', 'on_demand').includes('.pi/prompts/agents.md'));
  assert.ok(!paths(report, 'codex', 'on_demand').includes('nested-checkout/AGENTS.md'));
  assert.deepEqual(paths(report, 'cursor', 'always_loaded'), ['.cursor/rules/always.mdc']);
  assert.deepEqual(paths(report, 'cursor', 'on_demand'), [
    '.agents/agents/shared.md',
    '.agents/commands/shared.md',
    '.agents/skills/local/SKILL.md',
    '.cursor/commands/bug.md',
    '.cursor/rules/scoped.mdc',
  ]);
  assert.ok(paths(report, 'pi', 'on_demand').includes('.agents/skills/local/SKILL.md'));
  assert.ok(paths(report, 'pi', 'on_demand').includes('.agents/agents/shared.md'));
  assert.ok(paths(report, 'pi', 'on_demand').includes('.agents/commands/shared.md'));
  assert.ok(paths(report, 'pi', 'on_demand').includes('.pi/prompts/bug.md'));
  assert.ok(!paths(report, 'codex', 'on_demand').includes('.agents/agents/shared.md'));
  assert.ok(!paths(report, 'codex', 'on_demand').includes('.agents/commands/shared.md'));
  assert.deepEqual(paths(report, 'fia', 'enforcement'), ['imp/modules/gates.mjs']);
  assert.ok(paths(report, 'claude', 'enforcement').includes('.claude/settings.json'));
  assert.ok(paths(report, 'cursor', 'enforcement').includes('.cursor/hooks.json'));
  assert.ok(paths(report, 'pi', 'enforcement').includes('.pi/extensions/guard.mjs'));
});

test('the JSON CLI exposes structure, never file contents', () => {
  const secretSentence = 'do-not-emit-this-instruction';
  const root = fixture({ 'CLAUDE.md': `${secretSentence}\n` });
  const result = spawnSync(process.execPath, [SCRIPT, '--dir', root, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.totals.claude.always_loaded, 1);
  assert.doesNotMatch(result.stdout, new RegExp(secretSentence));
});

test('rejects file/external symlinks but inventories internal directory aliases as read-only', () => {
  const marker = 'outside-secret-marker';
  const outside = fixture({
    'secret.md': `---\npaths:\n  - "${marker}/**"\n---\n`,
    'rules/also-secret.md': marker,
  });
  const root = fixture({
    '.claude/rules/global.md': '# Global\n',
    '.agents/canonical/demo/SKILL.md': '---\nname: demo\ndescription: demo\n---\n',
    '.cursor/runtime/agent-source.md': '# Agent source\n',
    '.cursor/runtime/command-source.md': '# Command source\n',
  });
  mkdirSync(join(root, '.claude/skills'), { recursive: true });
  mkdirSync(join(root, '.agents/agents'), { recursive: true });
  mkdirSync(join(root, '.agents/commands'), { recursive: true });
  symlinkSync(join(outside, 'secret.md'), join(root, '.claude/rules/external-file.md'));
  symlinkSync('global.md', join(root, '.claude/rules/internal-file.md'));
  symlinkSync(join(outside, 'rules'), join(root, '.claude/rules/external-directory'), 'dir');
  symlinkSync('../../.agents/canonical/demo', join(root, '.claude/skills/internal-directory'), 'dir');
  symlinkSync(join(outside, 'secret.md'), join(root, '.agents/agents/external.md'));
  symlinkSync('../../.cursor/runtime/agent-source.md', join(root, '.agents/agents/shared.md'));
  symlinkSync('../../.cursor/runtime/command-source.md', join(root, '.agents/commands/shared.md'));

  const report = mapAiLayer(root);
  const claudePaths = [
    ...paths(report, 'claude', 'always_loaded'),
    ...paths(report, 'claude', 'on_demand'),
    ...paths(report, 'claude', 'enforcement'),
  ];
  assert.ok(!claudePaths.includes('.claude/rules/external-file.md'));
  assert.ok(!claudePaths.includes('.claude/rules/internal-file.md'));
  assert.ok(!claudePaths.some((path) => path.startsWith('.claude/rules/external-directory/')));
  assert.ok(claudePaths.includes('.claude/skills/internal-directory/SKILL.md'));
  assert.ok(!paths(report, 'cursor', 'on_demand').includes('.agents/agents/external.md'));
  assert.ok(!paths(report, 'pi', 'on_demand').includes('.agents/agents/external.md'));
  const internalAlias = report.engines.claude.on_demand.find(
    (file) => file.path === '.claude/skills/internal-directory/SKILL.md',
  );
  assert.equal(internalAlias.via_symlink, true);
  assert.equal(internalAlias.canonical_path, '.agents/canonical/demo/SKILL.md');
  for (const [engine, path, canonical] of [
    ['cursor', '.agents/agents/shared.md', '.cursor/runtime/agent-source.md'],
    ['pi', '.agents/agents/shared.md', '.cursor/runtime/agent-source.md'],
    ['cursor', '.agents/commands/shared.md', '.cursor/runtime/command-source.md'],
    ['pi', '.agents/commands/shared.md', '.cursor/runtime/command-source.md'],
  ]) {
    const alias = report.engines[engine].on_demand.find((file) => file.path === path);
    assert.equal(alias.via_symlink, true);
    assert.equal(alias.canonical_path, canonical);
  }

  const result = spawnSync(process.execPath, [SCRIPT, '--dir', root, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, new RegExp(marker));
});

test('traversal budgets abort the whole map and the CLI exits nonzero', () => {
  const root = fixture({
    'CLAUDE.md': '# Claude\n',
    'AGENTS.md': '# Codex\n',
    'nested/extra.md': '# Extra\n',
  });

  for (const [kind, traversalLimits] of [
    ['entries', { entries: 1 }],
    ['directories', { directories: 1 }],
    ['files', { files: 1 }],
  ]) {
    assert.throws(() => mapAiLayer(root, { traversalLimits }), new RegExp(`AI layer traversal ${kind} limit exceeded`));
  }

  const result = spawnSync(process.execPath, [SCRIPT, '--dir', root, '--json', '--max-entries', '1'], {
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /AI layer traversal entries limit exceeded \(1\)/);
});

test(
  'the real harness exposes shared agent and command aliases to Cursor and Pi only',
  { skip: !existsSync(HARNESS) && 'private harness checkout not present' },
  () => {
    const report = mapAiLayer(HARNESS);
    for (const engine of ['cursor', 'pi']) {
      const agent = report.engines[engine].on_demand.find((file) => file.path === '.agents/agents/task-sequencer.md');
      const command = report.engines[engine].on_demand.find((file) => file.path === '.agents/commands/bug.md');
      assert.equal(agent.via_symlink, true);
      assert.equal(agent.canonical_path, '.claude/agents/task-sequencer.md');
      assert.equal(command.via_symlink, true);
      assert.equal(command.canonical_path, '.cursor/commands/bug.md');
    }
    assert.ok(!paths(report, 'codex', 'on_demand').includes('.agents/agents/task-sequencer.md'));
    assert.ok(!paths(report, 'codex', 'on_demand').includes('.agents/commands/bug.md'));
  },
);
