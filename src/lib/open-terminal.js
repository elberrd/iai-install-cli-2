// Opens the system TERMINAL at the page's request (--ui).
//
// The page no longer runs the installation: it assembles the command and asks
// the student to run it in the terminal. This helper opens the terminal app
// already in the right folder — one less click for those who don't know where it is.
//
// Command assembly is pure (testable); only `openTerminal` spawns.

import { spawn } from 'node:child_process';
import process from 'node:process';

/**
 * Candidate commands that open the OS terminal at `dir`, in try-order.
 * @param {NodeJS.Platform} platform
 * @param {string} dir - existing folder the new terminal should start in.
 * @returns {{cmd: string, args: string[], cwd?: string}[]} empty when the platform has none.
 */
export function openTerminalCommands(platform, dir) {
  if (platform === 'darwin') {
    // `open -a Terminal <folder>` opens Terminal.app with a window already in the folder.
    return [{ cmd: 'open', args: ['-a', 'Terminal', dir] }];
  }

  if (platform === 'win32') {
    // `start` (a cmd builtin) opens a new Prompt window that inherits the
    // current directory — that's why the spawn cwd is the project folder. The ""
    // is the mandatory title when any argument comes quoted.
    return [{ cmd: 'cmd', args: ['/c', 'start', '', 'cmd'], cwd: dir }];
  }

  if (platform === 'linux') {
    // No emulator is guaranteed — try the most common ones. The spawn cwd becomes
    // the shell's starting folder (works in all of them, no specific flag needed).
    return [
      { cmd: 'x-terminal-emulator', args: [], cwd: dir },
      { cmd: 'gnome-terminal', args: [], cwd: dir },
      { cmd: 'konsole', args: [], cwd: dir },
      { cmd: 'xfce4-terminal', args: [], cwd: dir },
      { cmd: 'xterm', args: [], cwd: dir },
    ];
  }

  return [];
}

/**
 * Open the system terminal at `dir` (best-effort, never throws).
 * @param {string} dir - existing folder.
 * @returns {Promise<{ok: true} | {unsupported: true}>}
 */
export async function openTerminal(dir, platform = process.platform) {
  for (const spec of openTerminalCommands(platform, dir)) {
    if (await tryOpen(spec)) return { ok: true };
  }
  return { unsupported: true };
}

/** Spawn detached; true when the binary exists and was launched. */
function tryOpen({ cmd, args, cwd }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, stdio: 'ignore', detached: true });
    } catch {
      return resolve(false);
    }
    child.on('error', () => resolve(false)); // ENOENT → try the next candidate
    child.on('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}
