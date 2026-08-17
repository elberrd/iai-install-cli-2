import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { extractTarGz, tarEntries } = await import('../src/lib/tar-extract.js');

// ── Hand-rolled tar builder ──────────────────────────────────────────────────
// Building the bytes by hand keeps these tests deterministic on every OS: no
// system tar, and no symlink privilege needed to CREATE the fixture (the whole
// point of the extractor is machines where that privilege is missing).

function headerBlock(name, { size = 0, type = '0', linkname = '', mode = 0o644 } = {}) {
  const b = Buffer.alloc(512);
  b.write(name, 0, 100, 'utf8');
  b.write(mode.toString(8).padStart(7, '0') + '\0', 100);
  b.write('0000000\0', 108); // uid
  b.write('0000000\0', 116); // gid
  b.write(size.toString(8).padStart(11, '0') + '\0', 124);
  b.write('00000000000\0', 136); // mtime
  b.fill(0x20, 148, 156); // checksum field counts as spaces while summing
  b.write(type, 156);
  if (linkname) b.write(linkname, 157, 100, 'utf8');
  b.write('ustar\0', 257);
  b.write('00', 263);
  let sum = 0;
  for (const byte of b) sum += byte;
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return b;
}

function entry(name, content = '', opts = {}) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const blocks = [headerBlock(name, { ...opts, size: body.length })];
  if (body.length) {
    const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
    body.copy(padded);
    blocks.push(padded);
  }
  return blocks;
}

/** pax body: "<len> <key>=<value>\n" where len counts the whole record. */
function paxBody(records) {
  let out = '';
  for (const [k, v] of Object.entries(records)) {
    const base = `${k}=${v}\n`;
    let len = base.length + 2;
    while (String(len).length + 1 + base.length !== len) len++;
    out += `${len} ${base}`;
  }
  return out;
}

function writeTgz(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'impactus-tarx-'));
  const tgz = join(dir, 'fixture.tar.gz');
  writeFileSync(tgz, gzipSync(Buffer.concat([...entries.flat(), Buffer.alloc(1024)])));
  return { tgz, out: join(dir, 'out') };
}

const failingSymlink = () => {
  const err = new Error('EPERM: operation not permitted (simulated Windows)');
  err.code = 'EPERM';
  throw err;
};

// ── Extraction basics ────────────────────────────────────────────────────────

test('extractTarGz: files and dirs land stripped of the tarball root', () => {
  const { tgz, out } = writeTgz([
    entry('owner-repo-sha/', '', { type: '5' }),
    entry('owner-repo-sha/package.json', '{"name":"x"}\n'),
    entry('owner-repo-sha/src/', '', { type: '5' }),
    entry('owner-repo-sha/src/deep/nested.txt', 'deep\n'),
  ]);
  const res = extractTarGz(tgz, out);
  assert.equal(readFileSync(join(out, 'package.json'), 'utf8'), '{"name":"x"}\n');
  assert.equal(readFileSync(join(out, 'src', 'deep', 'nested.txt'), 'utf8'), 'deep\n');
  assert.ok(!existsSync(join(out, 'owner-repo-sha')));
  assert.equal(res.materialized, false);
  assert.deepEqual(res.skipped, []);
});

test('extractTarGz: symlinks become real links when the machine allows them', () => {
  const { tgz, out } = writeTgz([
    entry('r/a.txt', 'target content\n'),
    entry('r/sub/inner.txt', 'inner\n'),
    entry('r/link.txt', '', { type: '2', linkname: 'a.txt' }),
    entry('r/dirlink', '', { type: '2', linkname: 'sub' }),
  ]);
  extractTarGz(tgz, out);
  // Content through the link is the universal contract (link or copy).
  assert.equal(readFileSync(join(out, 'link.txt'), 'utf8'), 'target content\n');
  assert.equal(readFileSync(join(out, 'dirlink', 'inner.txt'), 'utf8'), 'inner\n');
  if (process.platform !== 'win32') {
    assert.ok(lstatSync(join(out, 'link.txt')).isSymbolicLink());
    assert.ok(lstatSync(join(out, 'dirlink')).isSymbolicLink());
  }
});

test('extractTarGz: symlink failure materializes EVERY link as a copy (the Windows path)', () => {
  const { tgz, out } = writeTgz([
    entry('r/real.txt', 'X\n'),
    entry('r/skills/tdd/SKILL.md', '# tdd\n'),
    // Chain out of order on purpose: l1 → l2 → real.txt forces the retry pass.
    entry('r/l1', '', { type: '2', linkname: 'l2' }),
    entry('r/l2', '', { type: '2', linkname: 'real.txt' }),
    entry('r/mirror', '', { type: '2', linkname: 'skills/tdd' }),
  ]);
  const res = extractTarGz(tgz, out, { makeSymlink: failingSymlink });
  assert.equal(res.materialized, true);
  assert.deepEqual(res.skipped, []);
  for (const p of ['l1', 'l2']) {
    assert.ok(!lstatSync(join(out, p)).isSymbolicLink(), `${p} must be a real file`);
    assert.equal(readFileSync(join(out, p), 'utf8'), 'X\n');
  }
  assert.ok(statSync(join(out, 'mirror')).isDirectory());
  assert.equal(readFileSync(join(out, 'mirror', 'SKILL.md'), 'utf8'), '# tdd\n');
});

test('extractTarGz: pax headers (git archive format) — global skipped, path override honored', () => {
  const longName = 'r/' + 'very-long-directory-name/'.repeat(5) + 'file.txt';
  const { tgz, out } = writeTgz([
    entry('pax_global_header', paxBody({ comment: 'abc123' }), { type: 'g' }),
    entry('pax-x-0', paxBody({ path: longName }), { type: 'x' }),
    entry('r/_truncated_placeholder', 'via pax\n'),
    entry('r/plain.txt', 'plain\n'),
  ]);
  extractTarGz(tgz, out);
  assert.equal(readFileSync(join(out, longName.slice(2)), 'utf8'), 'via pax\n');
  assert.ok(!existsSync(join(out, '_truncated_placeholder')));
  assert.equal(readFileSync(join(out, 'plain.txt'), 'utf8'), 'plain\n');
});

test('extractTarGz: GNU longname (L) and hardlinks resolve to real content', () => {
  const gnuName = 'r/gnu/' + 'x'.repeat(120) + '.txt';
  const { tgz, out } = writeTgz([
    entry('././@LongLink', gnuName + '\0', { type: 'L' }),
    entry('r/gnu/_short', 'gnu long\n'),
    entry('r/orig.txt', 'HH\n'),
    entry('r/hard.txt', '', { type: '1', linkname: 'r/orig.txt' }),
  ]);
  extractTarGz(tgz, out);
  assert.equal(readFileSync(join(out, gnuName.slice(2)), 'utf8'), 'gnu long\n');
  assert.equal(readFileSync(join(out, 'hard.txt'), 'utf8'), 'HH\n');
});

test('extractTarGz: path traversal in the archive throws instead of writing outside', () => {
  const { tgz, out } = writeTgz([entry('r/../../evil.txt', 'nope\n')]);
  assert.throws(() => extractTarGz(tgz, out), /unsafe path/);
});

test('extractTarGz: overwrites leftovers from a previous partial extraction', () => {
  const { tgz, out } = writeTgz([entry('r/keep.txt', 'fresh\n')]);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'keep.txt'), 'stale partial copy\n');
  extractTarGz(tgz, out);
  assert.equal(readFileSync(join(out, 'keep.txt'), 'utf8'), 'fresh\n');
});

test('extractTarGz: executable bit survives (scripts must stay runnable)', { skip: process.platform === 'win32' }, () => {
  const { tgz, out } = writeTgz([entry('r/hook.sh', '#!/bin/sh\n', { mode: 0o755 })]);
  extractTarGz(tgz, out);
  assert.ok(statSync(join(out, 'hook.sh')).mode & 0o100, 'owner-executable');
});

test('tarEntries: folds pax overrides into the next entry only', () => {
  const bytes = Buffer.concat([
    ...entry('pax-x', paxBody({ path: 'renamed.txt' }), { type: 'x' }),
    ...entry('original.txt', 'a'),
    ...entry('second.txt', 'b'),
    Buffer.alloc(1024),
  ]);
  const names = [...tarEntries(bytes)].map((e) => e.name);
  assert.deepEqual(names, ['renamed.txt', 'second.txt']);
});
