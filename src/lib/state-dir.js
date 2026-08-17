// The CLI's state folder in the user's home (~/.impactus-cli): the auth
// token, keys pasted in the web UI and the run logs. Installs made before the
// rebrand used ~/.create-iai — the first touch RENAMES that folder to the new
// name, so the student keeps the login, keys and logs with zero re-work.
// If the rename is denied (an open handle on Windows, permissions), the
// legacy folder keeps being used as-is: state must never split across two
// directories, and a naming nit must never break the CLI.
import { existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LEGACY_STATE_DIR, STATE_DIR } from '../config.js';

/**
 * Absolute path of the state folder, migrating the pre-rebrand one when found.
 * @param {string} [home] test seam; defaults to the real home directory.
 */
export function stateDirPath(home = homedir()) {
  const current = join(home, STATE_DIR);
  const legacy = join(home, LEGACY_STATE_DIR);
  if (!existsSync(current) && existsSync(legacy)) {
    try {
      renameSync(legacy, current);
    } catch {
      return legacy;
    }
  }
  return current;
}
