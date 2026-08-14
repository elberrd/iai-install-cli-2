import process from 'node:process';
import { has } from './proc.js';

/** @returns {'mac'|'linux'|'windows'} */
export function osKind() {
  if (process.platform === 'darwin') return 'mac';
  if (process.platform === 'win32') return 'windows';
  return 'linux';
}

/**
 * Detect which system package managers are available.
 * @returns {Promise<Record<string, boolean>>}
 */
export async function detectPackageManagers() {
  const candidates = ['brew', 'apt-get', 'dnf', 'pacman', 'zypper', 'apk', 'winget', 'choco', 'scoop'];
  const found = {};
  await Promise.all(
    candidates.map(async (pm) => {
      found[pm] = await has(pm);
    }),
  );
  return found;
}
