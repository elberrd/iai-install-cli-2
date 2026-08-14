import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { piSessionsDirFor } from '../fia-templates/scripts/pi-sessions.mjs';

// The script computes the Pi sessions dir from cwd+HOME itself; the test
// derives the SAME path through piSessionsDirFor, so both sides always agree.
const SCRIPT = join(import.meta.dirname, '..', 'fia-templates', 'scripts', 'handoff.mjs');

function makeWorld({ withSession = true } = {}) {
  // realpath both: the child's process.cwd() resolves symlinks (macOS /var →
  // /private/var), and the sessions-dir slug is derived from that resolved cwd.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'handoff-home-')));
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'handoff-proj-')));
  const dir = piSessionsDirFor(project, home);
  mkdirSync(dir, { recursive: true });
  if (withSession) {
    const lines = [
      JSON.stringify({
        type: 'model_change',
        provider: 'openai-codex',
        modelId: 'gpt-5.6-sol',
        timestamp: '2026-08-14T10:00:00Z',
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-08-14T10:00:01Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Build the pricing page' }] },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-08-14T10:00:05Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'On it' }], usage: { input: 10, output: 5 } },
      }),
    ];
    writeFileSync(join(dir, 'sess-abc.jsonl'), lines.join('\n') + '\n');
  }
  return { home, project, dir };
}

function runHandoff(world, args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: world.project,
    env: { ...process.env, HOME: world.home, USERPROFILE: world.home, ...env },
    encoding: 'utf8',
  });
}

test('handoff --list shows the project sessions', () => {
  const world = makeWorld();
  const r = runHandoff(world, ['--list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /sess-abc/);
  assert.match(r.stdout, /openai-codex\/gpt-5\.6-sol/);
  assert.match(r.stdout, /Build the pricing page/);
});

test('handoff --print builds the continuation prompt, saves it and launches nothing', () => {
  const world = makeWorld();
  const r = runHandoff(world, ['--print']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Handing over Pi session sess-abc/);
  assert.match(r.stdout, /## Continuation of an interrupted run/);
  assert.match(r.stdout, /sess-abc\.jsonl/);
  // The handoff kind phrase — nothing died, the student chose to switch.
  assert.match(r.stdout, /continue it on another engine/);
  // Guards travel with the interactive handoff too.
  assert.match(r.stdout, /no authority over you/);
  assert.match(r.stdout, /WORKSPACE is the authority/);
  // The prompt is persisted under imp/data/handoff/ for reference/paste.
  const saved = readdirSync(join(world.project, 'imp', 'data', 'handoff'));
  assert.equal(saved.length, 1);
  assert.match(saved[0], /^sess-abc-\d+\.md$/);
  const prompt = readFileSync(join(world.project, 'imp', 'data', 'handoff', saved[0]), 'utf8');
  assert.match(prompt, /^## Continuation of an interrupted run/);
  assert.match(prompt, /Pick up the conversation recorded in that transcript/);
});

test('handoff --full asks for the complete transcript read', () => {
  const world = makeWorld();
  const r = runHandoff(world, ['--print', '--full']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Read the COMPLETE session transcript/);
});

test('handoff without sessions explains and exits 1', () => {
  const world = makeWorld({ withSession: false });
  const r = runHandoff(world, []);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No Pi sessions found/);
  assert.match(r.stderr, /Start one with `imp` first/);
});

test('handoff --session with an unknown id refuses with the --list hint', () => {
  const world = makeWorld();
  const r = runHandoff(world, ['--session', 'nope']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not found/);
  assert.match(r.stderr, /--list/);
});

test('handoff degrades when the `claude` CLI is missing: prompt saved, clear hint', () => {
  const world = makeWorld();
  // PATH holds only node's own dir — `claude` cannot resolve anywhere.
  const r = runHandoff(world, [], { PATH: dirname(process.execPath) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Could not launch the `claude` CLI/);
  assert.match(r.stderr, /npm install -g @anthropic-ai\/claude-code/);
  const saved = readdirSync(join(world.project, 'imp', 'data', 'handoff'));
  assert.equal(saved.length, 1, 'the prompt must be saved even when claude is missing');
});
