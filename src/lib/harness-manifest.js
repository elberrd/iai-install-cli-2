// The harness stamp manifest — `imp/.harness-manifest.json`, the harness
// counterpart of imp/.runtime-manifest.json. Written by setupHarness right
// after the merge, from the ADAPTED clone (README already renamed to
// imp/HARNESS.md, AGENTS.md removed for the marker merge, template-owned
// paths discarded), so its keys are exactly the project-relative paths the
// harness shipped. Each entry is either the sha1 of the file's harness
// content or `link:<target>` for a symlink (the merge copies links verbatim,
// so the recorded target is what a healthy disk must show).
//
// The manifest makes the missing/pristine/modified classification possible
// for harness files — `imp doctor` reports it, `imp fix` restores the missing
// ones. A file the merge KEPT (the project's version won) records the HARNESS
// sha on purpose: it reads as "differs from the stamp", which is the truth,
// and keeps `imp fix` from ever overwriting it silently.

import { createHash } from 'node:crypto';
import { readFile, readdir, readlink, lstat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const HARNESS_MANIFEST = 'imp/.harness-manifest.json';

export function sha1(content) {
  return createHash('sha1').update(content).digest('hex');
}

/**
 * Walk the adapted harness clone and build the manifest map. Symlinks are
 * recorded by target (`link:<target>`), never followed — the merge copies
 * them verbatim, and following one inside the clone could double-count its
 * target's content.
 * @returns {Promise<Record<string, string>>} rel path → sha1 | `link:<target>`
 */
export async function collectHarnessManifest(cloneDir) {
  const files = {};
  async function walk(rel) {
    for (const entry of await readdir(join(cloneDir, rel), { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      const full = join(cloneDir, entryRel);
      if (entry.isSymbolicLink()) {
        files[entryRel] = `link:${await readlink(full)}`;
      } else if (entry.isDirectory()) {
        await walk(entryRel);
      } else {
        files[entryRel] = sha1(await readFile(full));
      }
    }
  }
  await walk('');
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

/** Parsed manifest, or null when missing/invalid (older install — no baseline). */
export async function readHarnessManifest(dir) {
  try {
    const parsed = JSON.parse(await readFile(join(dir, HARNESS_MANIFEST), 'utf8'));
    return parsed && typeof parsed.files === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Write (replace) the manifest — the record of the LATEST stamp. */
export async function writeHarnessManifest(dir, files, { stampedAt = new Date().toISOString() } = {}) {
  const path = join(dir, HARNESS_MANIFEST);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ version: 1, stampedAt, files }, null, 2) + '\n', 'utf8');
}

/**
 * Compare the manifest against the disk.
 * missing  → recorded but gone (or a broken link where a file should be) — restorable;
 * modified → present but different (student edit, template-owned variant, retargeted link) — NEVER auto-touched;
 * pristine → byte-identical to the stamp (for links: same target).
 * @returns {Promise<{missing: string[], modified: string[], pristine: number}>}
 */
export async function classifyHarnessState(manifest, dir) {
  const missing = [];
  const modified = [];
  let pristine = 0;
  for (const [rel, expected] of Object.entries(manifest?.files ?? {})) {
    const dest = join(dir, rel);
    const st = await lstat(dest).catch(() => null);
    if (!st) {
      missing.push(rel);
      continue;
    }
    if (String(expected).startsWith('link:')) {
      const target = st.isSymbolicLink() ? await readlink(dest).catch(() => null) : null;
      if (target === String(expected).slice(5)) pristine++;
      else modified.push(rel);
      continue;
    }
    if (st.isDirectory()) {
      modified.push(rel);
      continue;
    }
    // readFile follows symlinks: a link resolving to the stamped bytes counts
    // as pristine; a DANGLING one reads as missing — restorable.
    const content = await readFile(dest).catch(() => null);
    if (content == null) missing.push(rel);
    else if (sha1(content) === expected) pristine++;
    else modified.push(rel);
  }
  return { missing, modified, pristine };
}
