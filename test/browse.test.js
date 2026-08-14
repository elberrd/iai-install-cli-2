import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { dirInfo, listDir } from '../src/lib/browse.js';

// Fake dirents so we don't touch the real filesystem.
function ents(...specs) {
  return specs.map(([name, isDir]) => ({ name, isDirectory: () => isDir }));
}

test('listDir: keeps only directories, sorts, and hides hidden/node_modules', async () => {
  const read = async () => ents(
    ['src', true],
    ['README.md', false],
    ['node_modules', true],
    ['.git', true],
    ['Apps', true],
    ['zeta', true],
  );
  const r = await listDir('/projeto', read);
  assert.equal(r.path, resolve('/projeto'));
  assert.deepEqual(r.entries.map((e) => e.name), ['Apps', 'src', 'zeta']);
  // paths are absolute
  assert.equal(r.entries[0].path, resolve('/projeto', 'Apps'));
});

test('listDir: parent points to the directory above', async () => {
  const read = async () => ents(['a', true]);
  const r = await listDir('/x/y/z', read);
  assert.equal(r.parent, dirname(resolve('/x/y/z')));
  assert.equal(r.name, 'z');
});

test('listDir: at the root, parent is null', async () => {
  const read = async () => ents();
  const r = await listDir('/', read);
  assert.equal(r.parent, null);
});

test('listDir: without a path, uses the user home', async () => {
  const read = async () => ents();
  const r = await listDir(undefined, read);
  assert.equal(r.path, resolve(homedir()));
});

test('listDir: propagates read errors (e.g. no permission)', async () => {
  const read = async () => {
    const e = new Error('permission denied');
    e.code = 'EACCES';
    throw e;
  };
  await assert.rejects(() => listDir('/root', read), /permission denied/);
});

test('dirInfo: a folder with ANY entry (even hidden) is not empty', async () => {
  const read = async () => ents(['.git', true]);
  const r = await dirInfo('/x/projeto', read);
  assert.deepEqual(r, { path: resolve('/x/projeto'), name: 'projeto', exists: true, empty: false });
});

test('dirInfo: empty folder', async () => {
  const read = async () => ents();
  const r = await dirInfo('/x/nova', read);
  assert.equal(r.exists, true);
  assert.equal(r.empty, true);
});

test('dirInfo: nonexistent folder → exists false (and empty true)', async () => {
  const read = async () => {
    const e = new Error('no such file');
    e.code = 'ENOENT';
    throw e;
  };
  const r = await dirInfo('/x/nao-existe', read);
  assert.deepEqual(r, { path: resolve('/x/nao-existe'), name: 'nao-existe', exists: false, empty: true });
});

test('dirInfo: other errors (e.g. permission) propagate', async () => {
  const read = async () => {
    const e = new Error('permission denied');
    e.code = 'EACCES';
    throw e;
  };
  await assert.rejects(() => dirInfo('/root', read), /permission denied/);
});
