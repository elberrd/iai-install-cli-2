// Pure-JS .tar.gz extractor — the fallback when the system `tar` cannot unpack
// a downloaded template/harness tarball. The case that motivates it: Windows'
// bundled tar (bsdtar) refuses to CREATE SYMLINKS unless the process holds the
// symlink privilege (admin shell or Developer Mode) — on a typical student
// machine every one of the harness' 50+ mirror links (.agents/* and
// .cursor/agents/* pointing into .claude/ and .cursor/) died with
// "Can't create '…': Invalid argument", tar exited 1 and the installer
// mislabeled a perfectly good download as corrupted. Here a symlink that
// cannot be created is MATERIALIZED instead: the resolved target is copied in
// its place, so every engine still finds real content at the mirrored path.
//
// Scope: the GitHub codeload tarballs the community API serves (`git archive`
// pax format). Supported entries: regular files, directories, symlinks,
// hardlinks, pax extended headers (x/g) and GNU long name/link (L/K).
// Anything else (fifo, devices) is skipped. Header checksums are not
// validated — gzip's own CRC already covers download integrity.

import { cpSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, resolve, sep } from 'node:path';

const BLOCK = 512;

/** Numeric tar field: octal text, or GNU base-256 when the high bit is set. */
function parseNumeric(buf) {
  if (buf[0] & 0x80) {
    let v = buf[0] & 0x7f;
    for (let i = 1; i < buf.length; i++) v = v * 256 + buf[i];
    return v;
  }
  const s = buf.toString('ascii').replace(/\0/g, '').trim();
  return s ? parseInt(s, 8) : 0;
}

/** NUL-terminated string field. */
function stringField(block, start, len) {
  const raw = block.subarray(start, start + len);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul === -1 ? raw.length : nul).toString('utf8');
}

/** pax extended-header body: a sequence of "<len> <key>=<value>\n" records. */
function parsePaxRecords(body) {
  const out = {};
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i);
    if (sp === -1) break;
    const len = parseInt(body.subarray(i, sp).toString('ascii'), 10);
    if (!Number.isFinite(len) || len <= 0 || i + len > body.length) break;
    const record = body.subarray(sp + 1, i + len - 1).toString('utf8'); // drops the trailing \n
    const eq = record.indexOf('=');
    if (eq !== -1) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

/**
 * Iterate the entries of an (uncompressed) tar buffer. Metadata entries
 * (pax x/g, GNU L/K) are folded into the entry they describe and never
 * yielded themselves.
 * @param {Buffer} tar
 * @yields {{name: string, type: string, linkname: string, mode: number, body: Buffer}}
 */
export function* tarEntries(tar) {
  let offset = 0;
  let overrides = null; // accumulated pax/GNU metadata for the NEXT real entry
  while (offset + BLOCK <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every((b) => b === 0)) break; // end-of-archive marker
    const size = parseNumeric(block.subarray(124, 136));
    const body = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;

    const type = block[156] === 0 ? '0' : String.fromCharCode(block[156]);
    if (type === 'x') {
      overrides = { ...overrides, ...parsePaxRecords(body) };
      continue;
    }
    if (type === 'g') continue; // global pax header (git archive's commit comment)
    if (type === 'L' || type === 'K') {
      const text = body.subarray(0, body.indexOf(0) === -1 ? body.length : body.indexOf(0)).toString('utf8');
      overrides = { ...overrides, [type === 'L' ? 'path' : 'linkpath']: text };
      continue;
    }

    let name = stringField(block, 0, 100);
    // The prefix field only exists in ustar-family headers.
    if (stringField(block, 257, 6).startsWith('ustar')) {
      const prefix = stringField(block, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    let linkname = stringField(block, 157, 100);
    if (overrides?.path) name = overrides.path;
    if (overrides?.linkpath) linkname = overrides.linkpath;
    overrides = null;
    yield { name, type, linkname, mode: parseNumeric(block.subarray(100, 108)), body };
  }
}

/**
 * Extract `tgzPath` into `destDir`, dropping the first `strip` path components
 * (the GitHub tarball root `<owner>-<repo>-<sha>/`), like
 * `tar -xzf … --strip-components=1`. Existing files are overwritten (the
 * caller may be retrying after a partial system-tar run).
 *
 * Symlinks: a real link is attempted first (with the right dir/file type for
 * Windows). The FIRST failure flips the whole run to materialization — every
 * remaining link becomes a deep copy of its resolved target — because the
 * failure means the machine cannot create symlinks at all, and mixing links
 * with copies would leave the tree half-mirrored. Targets are resolved inside
 * the archive only; a link pointing outside `destDir` is created verbatim when
 * possible and skipped (reported) otherwise — never dereferenced.
 *
 * @param {string} tgzPath
 * @param {string} destDir
 * @param {{strip?: number, makeSymlink?: typeof symlinkSync}} [opts]
 *   `makeSymlink` is a test seam to simulate a symlink-incapable machine.
 * @returns {{files: number, links: number, materialized: boolean, skipped: string[]}}
 */
export function extractTarGz(tgzPath, destDir, opts = {}) {
  const { strip = 1, makeSymlink = symlinkSync } = opts;
  const tar = gunzipSync(readFileSync(tgzPath));
  const dest = resolve(destDir);
  const inside = (abs) => abs === dest || abs.startsWith(dest + sep);

  // Archive path → absolute destination (or null for entries the strip eats).
  const destPathOf = (rawName) => {
    const parts = String(rawName)
      .split('/')
      .filter((p) => p && p !== '.');
    if (parts.some((p) => p === '..')) throw new Error(`unsafe path in archive: ${rawName}`);
    if (parts.length <= strip) return null;
    const abs = resolve(dest, parts.slice(strip).join('/'));
    if (!inside(abs)) throw new Error(`unsafe path in archive: ${rawName}`);
    return abs;
  };

  const links = [];
  let files = 0;
  for (const entry of tarEntries(tar)) {
    const target = destPathOf(entry.name);
    if (target === null) continue;
    if (entry.type === '5' || entry.name.endsWith('/')) {
      mkdirSync(target, { recursive: true });
    } else if (entry.type === '2' || entry.type === '1') {
      links.push({ dest: target, linkname: entry.linkname, hard: entry.type === '1' });
    } else if (entry.type === '0') {
      mkdirSync(dirname(target), { recursive: true });
      rmSync(target, { recursive: true, force: true });
      writeFileSync(target, entry.body, { mode: entry.mode || 0o644 });
      files++;
    }
    // Anything else (fifo/devices) never appears in git archives — skipped.
  }

  // Links go LAST (their targets must exist), in passes: a link whose target
  // is another still-pending link is deferred to the next round.
  let cannotLink = false;
  const skipped = [];
  let pending = links;
  let progress = true;
  while (pending.length && progress) {
    progress = false;
    const next = [];
    for (const link of pending) {
      // Hardlink names are archive paths; symlink names are relative to the link.
      const target = link.hard ? destPathOf(link.linkname) : resolve(dirname(link.dest), link.linkname);
      const confined = target !== null && inside(target);
      let stat = null;
      if (confined) {
        try {
          stat = statSync(target);
        } catch {
          stat = null; // target not materialized yet (or dangling) — retry later
        }
      }
      if (confined && !stat) {
        next.push(link);
        continue;
      }
      mkdirSync(dirname(link.dest), { recursive: true });
      rmSync(link.dest, { recursive: true, force: true });
      if (!link.hard && !cannotLink) {
        try {
          makeSymlink(link.linkname, link.dest, stat?.isDirectory() ? 'dir' : 'file');
          files++;
          progress = true;
          continue;
        } catch {
          cannotLink = true; // this machine cannot create symlinks — materialize all
        }
      }
      if (!confined || !stat) {
        skipped.push(link.dest); // points outside the archive and cannot be linked
        progress = true;
        continue;
      }
      cpSync(target, link.dest, { recursive: true, dereference: true });
      files++;
      progress = true;
    }
    pending = next;
  }
  // Whatever is left points at a target the archive never shipped (dangling).
  for (const link of pending) {
    try {
      makeSymlink(link.linkname, link.dest, 'file');
      files++;
    } catch {
      skipped.push(link.dest);
    }
  }

  return { files, links: links.length, materialized: cannotLink, skipped };
}
