// The harness stamp manifest (imp/.harness-manifest.json): collection from an
// adapted clone, roundtrip, and the missing/modified/pristine classification
// that doctor reports and fix restores from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectHarnessManifest,
  readHarnessManifest,
  writeHarnessManifest,
  classifyHarnessState,
  sha1,
} from '../src/lib/harness-manifest.js';

function makeClone() {
  const clone = mkdtempSync(join(tmpdir(), 'hm-clone-'));
  mkdirSync(join(clone, '.claude', 'commands'), { recursive: true });
  mkdirSync(join(clone, '.agents', 'skills'), { recursive: true });
  writeFileSync(join(clone, '.claude', 'commands', 'start.md'), '# /start\n');
  writeFileSync(join(clone, '.mcp.json'), '{}\n');
  symlinkSync('../../.claude/commands/start.md', join(clone, '.agents', 'skills', 'start-link'));
  return clone;
}

test('collectHarnessManifest: files get sha1, symlinks get link:<target>, keys are sorted', async () => {
  const clone = makeClone();
  const files = await collectHarnessManifest(clone);
  assert.equal(files['.claude/commands/start.md'], sha1('# /start\n'));
  assert.equal(files['.mcp.json'], sha1('{}\n'));
  assert.equal(files['.agents/skills/start-link'], 'link:../../.claude/commands/start.md');
  assert.deepEqual(Object.keys(files), [...Object.keys(files)].sort());
});

test('write/read roundtrip lands at imp/.harness-manifest.json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hm-proj-'));
  await writeHarnessManifest(dir, { 'a.md': sha1('x') });
  const back = await readHarnessManifest(dir);
  assert.equal(back.version, 1);
  assert.deepEqual(back.files, { 'a.md': sha1('x') });
});

test('readHarnessManifest: missing or invalid file → null (older install)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hm-none-'));
  assert.equal(await readHarnessManifest(dir), null);
  mkdirSync(join(dir, 'imp'), { recursive: true });
  writeFileSync(join(dir, 'imp', '.harness-manifest.json'), '{ not json');
  assert.equal(await readHarnessManifest(dir), null);
});

test('classifyHarnessState: pristine / modified / missing / link states', async () => {
  const clone = makeClone();
  const files = await collectHarnessManifest(clone);
  const manifest = { version: 1, files };

  // A project that mirrors the clone exactly → everything pristine.
  const dir = mkdtempSync(join(tmpdir(), 'hm-state-'));
  mkdirSync(join(dir, '.claude', 'commands'), { recursive: true });
  mkdirSync(join(dir, '.agents', 'skills'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'commands', 'start.md'), '# /start\n');
  writeFileSync(join(dir, '.mcp.json'), '{}\n');
  symlinkSync('../../.claude/commands/start.md', join(dir, '.agents', 'skills', 'start-link'));
  let state = await classifyHarnessState(manifest, dir);
  assert.deepEqual(state, { missing: [], modified: [], pristine: 3 });

  // Edit one, delete one, retarget the link → each lands in its bucket.
  writeFileSync(join(dir, '.mcp.json'), '{"edited":true}\n');
  rmSync(join(dir, '.claude', 'commands', 'start.md'));
  rmSync(join(dir, '.agents', 'skills', 'start-link'));
  symlinkSync('somewhere/else.md', join(dir, '.agents', 'skills', 'start-link'));
  state = await classifyHarnessState(manifest, dir);
  assert.deepEqual(state.missing, ['.claude/commands/start.md']);
  assert.deepEqual(state.modified.sort(), ['.agents/skills/start-link', '.mcp.json']);
  assert.equal(state.pristine, 0);
});

test('classifyHarnessState: a dangling symlink where a file was stamped counts as missing (restorable)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hm-dangling-'));
  symlinkSync('gone/nowhere.md', join(dir, 'broken.md'));
  const state = await classifyHarnessState({ files: { 'broken.md': sha1('content') } }, dir);
  assert.deepEqual(state.missing, ['broken.md']);
});
