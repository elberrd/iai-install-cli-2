// Local keys file (`--keys <file>`): the web UI saves the keys the user
// pasted into ~/.impactus-cli/keys/<project>.env (permission 600) and the
// generated command only REFERENCES the path — the keys never appear in the
// command, in the shell history, nor leave the machine. The CLI loads the file
// and each step consumes what it needs (Clerk/Convex stay automatic).

import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { KNOWN_SERVICE_KEYS } from '../config.js';
import { stateDirPath } from './state-dir.js';

/** Default path of a project's keys file. */
export function defaultKeysPath(slug) {
  const safe =
    String(slug || 'project')
      .replace(/[^a-z0-9-]/gi, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'project';
  return join(stateDirPath(), 'keys', `${safe}.env`);
}

/**
 * Reads a keys file (.env format). `KEY=value` lines; comments and empty
 * lines are ignored.
 * @returns {Promise<{keys: Object<string,string>, unknown: string[]}>}
 *   `unknown` = keys present in the file the CLI does not recognize.
 */
export async function loadKeysFile(path) {
  const text = await readFile(path, 'utf8');
  const keys = {};
  const unknown = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2].trim().replace(/^['"]|['"]$/g, '');
    if (!value) continue;
    if (KNOWN_SERVICE_KEYS.includes(m[1])) keys[m[1]] = value;
    else unknown.push(m[1]);
  }
  return { keys, unknown };
}

/**
 * Writes (or deletes, when empty) the keys file with restricted permission (600).
 * @returns {Promise<string|null>} the written path, or null when deleted.
 */
export async function saveKeysFile(path, keys = {}) {
  const entries = Object.entries(keys).filter(([, v]) => String(v ?? '').trim());
  if (entries.length === 0) {
    if (existsSync(path)) await rm(path, { force: true });
    return null;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const body = [
    '# Keys pasted in the IMPACTUS CLI web UI — on this machine ONLY.',
    '# Consumed by: npx impactus --keys <this file>. You may delete it after the install.',
    ...entries.map(([k, v]) => `${k}=${String(v).trim()}`),
    '',
  ].join('\n');
  await writeFile(path, body, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600); // guarantees it even when the file already existed
  return path;
}

/** Random urlsafe token (e.g. ASAAS_WEBHOOK_TOKEN). */
export function generateToken(bytes = 24) {
  return randomBytes(bytes).toString('base64url');
}
