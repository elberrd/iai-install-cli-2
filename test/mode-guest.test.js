// Guest mode (sign-in declined): only harness paths may come out of
// selectInstallMode — a flag that forces the template is a HARD error, never a
// silent downgrade (scripts must notice), and interactive paths fall to
// harness without ever offering the template.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectInstallMode } from '../src/steps/mode.js';
import { STATE_MARKER } from '../src/steps/project.js';

test('guest + --mode full → hard error pointing at the sign-in', async () => {
  const ctx = { guest: true, flags: { mode: 'full' } };
  await assert.rejects(() => selectInstallMode(ctx), /sign-in/);
});

test('guest + --stack recomendada (the template path) → hard error', async () => {
  const ctx = { guest: true, flags: { stack: 'recomendada' } };
  await assert.rejects(() => selectInstallMode(ctx), /sign-in/);
});

test('guest + --yes → harness mode on the discover path (never the template)', async () => {
  const ctx = { guest: true, flags: { yes: true } };
  await selectInstallMode(ctx);
  assert.equal(ctx.mode, 'harness');
  assert.equal(ctx.stackPath, 'discover');
});

test('guest + --stack propria keeps working (harness path)', async () => {
  const ctx = { guest: true, flags: { stack: 'propria' } };
  await selectInstallMode(ctx);
  assert.equal(ctx.mode, 'harness');
  assert.equal(ctx.stackPath, 'custom');
});

test('guest + unfinished full install in the folder → error (resuming needs the login)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'create-iai-guest-resume-'));
  writeFileSync(join(dir, STATE_MARKER), '{}\n');
  const ctx = { guest: true, dir, flags: { yes: true } };
  await assert.rejects(() => selectInstallMode(ctx), /sign-in/);
});

test('signed in (no guest flag): --mode full stays untouched', async () => {
  const ctx = { flags: { mode: 'full' } };
  await selectInstallMode(ctx);
  assert.equal(ctx.mode, 'full');
  assert.equal(ctx.stackPath, 'template');
});
