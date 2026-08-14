// Directory listing for the --ui folder picker. The web page can't read the
// real filesystem (browser sandbox), so the local server does it: given a path,
// return that folder's subdirectories so the page can navigate the disk.
//
// The I/O (readdir) is injected so the core logic stays unit-testable.

import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname, basename } from 'node:path';

/**
 * List the subdirectories of `dir` (defaults to the user's home).
 * @param {string|undefined} dir - requested path (absolute after resolve).
 * @param {(p: string) => Promise<import('node:fs').Dirent[]>} [read] - injectable readdir.
 * @returns {Promise<{path: string, parent: string|null, name: string, entries: {name: string, path: string}[]}>}
 */
export async function listDir(dir, read = defaultRead) {
  const path = resolve(dir && String(dir).trim() ? String(dir) : homedir());
  const parent = dirname(path);
  const dirents = await read(path);

  const entries = dirents
    .filter((d) => d.isDirectory())
    // hide dotfolders and node_modules — noise for picking a target folder
    .filter((d) => !d.name.startsWith('.') && d.name !== 'node_modules')
    .map((d) => ({ name: d.name, path: resolve(path, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  return {
    path,
    parent: parent === path ? null : parent, // null at the filesystem root
    name: basename(path) || path,
    entries,
  };
}

/**
 * Quick facts about a folder for the UI: does it exist, and is it empty?
 * The folder prefilled on the page is the cwd of whoever ran `npx impactus`
 * — which often is NOT empty; the page uses this to warn before the installer
 * refuses (with --yes it never overwrites a folder that has files).
 * @param {string|undefined} dir
 * @param {(p: string) => Promise<import('node:fs').Dirent[]>} [read]
 * @returns {Promise<{path: string, name: string, exists: boolean, empty: boolean}>}
 */
export async function dirInfo(dir, read = defaultRead) {
  const path = resolve(dir && String(dir).trim() ? String(dir) : homedir());
  const name = basename(path) || path;
  try {
    const dirents = await read(path);
    return { path, name, exists: true, empty: dirents.length === 0 };
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
      return { path, name, exists: false, empty: true };
    }
    throw err;
  }
}

function defaultRead(path) {
  return readdir(path, { withFileTypes: true });
}
