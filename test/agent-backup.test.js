import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { presentAgentFiles, backupAgentFiles, AGENT_FILE_TARGETS } from '../src/lib/agent-backup.js';
import { parseArgs } from '../src/lib/args.js';
import { selectInstallMode } from '../src/steps/mode.js';
import { STATE_MARKER } from '../src/steps/project.js';

test('presentAgentFiles: lists only what exists, in canonical order', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-bak-'));
  mkdirSync(join(root, '.claude', 'commands'), { recursive: true });
  writeFileSync(join(root, 'HARNESS.md'), '# old\n');
  writeFileSync(join(root, 'package.json'), '{}\n');
  assert.deepEqual(presentAgentFiles(root), ['.claude', 'HARNESS.md']);
});

test('presentAgentFiles: leftovers from other agent tools are detected too', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-bak-'));
  writeFileSync(join(root, 'CLAUDE.md'), '# memory\n');
  writeFileSync(join(root, '.cursorrules'), 'rules\n');
  mkdirSync(join(root, '.windsurf'), { recursive: true });
  mkdirSync(join(root, '.pi', 'skills'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# app\n'); // never a target
  assert.deepEqual(presentAgentFiles(root), ['.cursorrules', '.pi', '.windsurf', 'CLAUDE.md']);
});

test('backupAgentFiles: moves to .agents-backup-<date> without deleting anything', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-bak-'));
  mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
  writeFileSync(join(root, '.claude', 'skills', 'x.md'), 'content\n');
  writeFileSync(join(root, 'HARNESS.md'), '# old\n');
  const present = presentAgentFiles(root);
  const backupDir = await backupAgentFiles(root, present, new Date('2026-08-04T12:00:00Z'));

  assert.match(backupDir, /\.agents-backup-2026-08-04_12-00-00$/);
  assert.equal(existsSync(join(root, '.claude')), false, 'original moved out of place');
  assert.equal(readFileSync(join(backupDir, '.claude', 'skills', 'x.md'), 'utf8'), 'content\n');
  assert.equal(readFileSync(join(backupDir, 'HARNESS.md'), 'utf8'), '# old\n');
  // ai-docs/AGENTS.md never enter the policy.
  assert.ok(!AGENT_FILE_TARGETS.includes('ai-docs'));
  assert.ok(!AGENT_FILE_TARGETS.includes('AGENTS.md'));
  assert.equal(readdirSync(root).filter((f) => f.startsWith('.agents-backup-')).length, 1);
});

test('backupAgentFiles: nested target imp/HARNESS.md keeps its relative path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-bak-'));
  mkdirSync(join(root, 'imp'), { recursive: true });
  writeFileSync(join(root, 'imp', 'HARNESS.md'), '# guide\n');
  writeFileSync(join(root, 'imp', 'fia.config.yaml'), 'agents: []\n');
  const present = presentAgentFiles(root);
  assert.deepEqual(present, ['imp/HARNESS.md'], 'only the guide, never the imp/ runtime');
  const backupDir = await backupAgentFiles(root, present, new Date('2026-08-12T12:00:00Z'));

  assert.equal(readFileSync(join(backupDir, 'imp', 'HARNESS.md'), 'utf8'), '# guide\n');
  assert.equal(existsSync(join(root, 'imp', 'HARNESS.md')), false, 'guide moved out');
  assert.equal(existsSync(join(root, 'imp', 'fia.config.yaml')), true, 'runtime untouched');
});

test('agent-files policy: honored in FULL mode too (flag-driven)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-bak-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  const ctx = { dir: root, flags: { mode: 'full', agentFiles: 'replace' } };
  await selectInstallMode(ctx);
  assert.equal(ctx.mode, 'full');
  assert.equal(ctx.agentFilesPolicy, 'replace');
});

test('agent-files policy: skipped when resuming a half-finished full install', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-bak-'));
  // The half-copied template's own agent files + the crash-recovery marker.
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, STATE_MARKER), '{}\n');
  const ctx = { dir: root, flags: { mode: 'full', agentFiles: 'replace' } };
  await selectInstallMode(ctx);
  assert.equal(ctx.resumingInstall, true);
  assert.equal(ctx.agentFilesPolicy, undefined, 'the template\'s own files are not "the user\'s"');
});

test('--agent-files: validates add | replace', () => {
  const ok = parseArgs(['my-app', '--agent-files', 'replace']);
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.flags.agentFiles, 'replace');

  const bad = parseArgs(['my-app', '--agent-files', 'everything']);
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0], /--agent-files/);
});
