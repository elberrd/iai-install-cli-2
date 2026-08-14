import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { promptProject } from '../src/steps/project.js';

// Every case here passes --dir (or --name/--yes), so no @clack prompt is
// triggered — the name derivation can be tested without a TTY.

function tmp(name) {
  const root = mkdtempSync(join(tmpdir(), 'create-iai-test-'));
  if (!name) return root;
  const dir = join(root, name);
  mkdirSync(dir);
  return dir;
}

test('promptProject: without a name, the project name is the --dir folder name', async (t) => {
  const dir = tmp('Meu SaaS');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = await promptProject({ dir });
  assert.equal(r.name, 'Meu SaaS');
  assert.equal(r.slug, 'meu-saas');
  assert.equal(r.dir, dir);
  assert.equal(r.createdDir, false); // the folder already existed (empty)
});

test('promptProject: --dir to a nonexistent folder derives the name and sets createdDir', async (t) => {
  const root = tmp();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'novo-app');
  const r = await promptProject({ dir });
  assert.equal(r.name, 'novo-app');
  assert.equal(r.createdDir, true);
});

test('promptProject: explicit --name beats the folder name', async (t) => {
  const dir = tmp('outra-pasta');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = await promptProject({ dir, name: 'Meu App' });
  assert.equal(r.name, 'Meu App');
  assert.equal(r.slug, 'meu-app');
  assert.equal(r.dir, dir);
});

test('promptProject: --yes without name/dir keeps the ./my-app default', async (t) => {
  const root = tmp();
  t.after(() => {
    process.chdir(prev);
    rmSync(root, { recursive: true, force: true });
  });
  const prev = process.cwd();
  process.chdir(root);
  const r = await promptProject({ yes: true });
  assert.equal(r.name, 'my-app');
  assert.equal(basename(r.dir), 'my-app');
  assert.equal(r.createdDir, true);
});

test('promptProject: --yes refuses a non-empty folder (never overwrites)', async (t) => {
  const dir = tmp('cheia');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'existente.txt'), 'x');
  await assert.rejects(() => promptProject({ dir, yes: true }), /is not empty/);
});
