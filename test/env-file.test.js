import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEnvVar, upsertEnvVar, removeEnvVar } from '../src/lib/env-file.js';

function tmpFile() {
  return join(mkdtempSync(join(tmpdir(), 'cl1-env-')), '.env.local');
}

test('upsertEnvVar: creates the file and inserts', async () => {
  const f = tmpFile();
  await upsertEnvVar(f, 'FOO', 'bar');
  assert.equal(await getEnvVar(f, 'FOO'), 'bar');
});

test('upsertEnvVar: updates while preserving comments', async () => {
  const f = tmpFile();
  await writeFile(f, '# comment\nFOO=old\nOTHER=x\n', 'utf8');
  await upsertEnvVar(f, 'FOO', 'new');
  const text = await readFile(f, 'utf8');
  assert.ok(text.includes('# comment'));
  assert.ok(text.includes('OTHER=x'));
  assert.equal(await getEnvVar(f, 'FOO'), 'new');
});

test('getEnvVar: last occurrence wins and quotes are stripped', async () => {
  const f = tmpFile();
  await writeFile(f, 'KEY="first"\nKEY=\'second\'\n', 'utf8');
  assert.equal(await getEnvVar(f, 'KEY'), 'second');
});

test('upsertEnvVar: rejects values with line breaks (injection)', async () => {
  const f = tmpFile();
  await assert.rejects(() => upsertEnvVar(f, 'EVIL', 'a\nINJECTED=1'), /line break/);
  await assert.rejects(() => upsertEnvVar(f, 'EVIL', 'a\r\nb'), /line break/);
});

test('upsertEnvVar: quotes values with spaces, # or = (round trip intact)', async () => {
  const f = tmpFile();
  await upsertEnvVar(f, 'FROM', 'Name <a@b.com>'); // space
  await upsertEnvVar(f, 'HASH', 'abc#def'); // would read as a comment
  await upsertEnvVar(f, 'EQ', 'a=b'); // extra =
  await upsertEnvVar(f, 'PLAIN', 'simple'); // stays unquoted
  const text = await readFile(f, 'utf8');
  assert.ok(text.includes('FROM="Name <a@b.com>"'));
  assert.ok(text.includes('HASH="abc#def"'));
  assert.ok(text.includes('EQ="a=b"'));
  assert.ok(text.includes('PLAIN=simple'));
  assert.equal(await getEnvVar(f, 'FROM'), 'Name <a@b.com>');
  assert.equal(await getEnvVar(f, 'HASH'), 'abc#def');
  assert.equal(await getEnvVar(f, 'EQ'), 'a=b');
  assert.equal(await getEnvVar(f, 'PLAIN'), 'simple');
});

test('upsertEnvVar: internal double quotes round-trip (escape undone on read)', async () => {
  const f = tmpFile();
  const value = '{"a": "b c"}'; // spaces force quoting; inner quotes get escaped
  await upsertEnvVar(f, 'JSON', value);
  const text = await readFile(f, 'utf8');
  assert.ok(text.includes('JSON="{\\"a\\": \\"b c\\"}"'), 'written form escapes the inner quotes');
  assert.equal(await getEnvVar(f, 'JSON'), value, 'reading must undo the escaping');
});

test('removeEnvVar: removes every line of the key', async () => {
  const f = tmpFile();
  await writeFile(f, 'A=1\nB=2\nA=3\n', 'utf8');
  await removeEnvVar(f, 'A');
  assert.equal(await getEnvVar(f, 'A'), null);
  assert.equal(await getEnvVar(f, 'B'), '2');
});
