// The system's NATIVE folder picker, opened at the page's request (--ui).
//
// Why on the server and not in the browser? The browser's native picker
// (showDirectoryPicker / webkitdirectory) does NOT expose the folder's
// absolute path — only a sandboxed handle — and the installer needs the real
// path. Since the CLI runs a local server, it is the one that opens the system
// dialog (Finder/Explorer/zenity) and returns the chosen path to the page.
//
// Command assembly is pure (testable); only `pickFolder` spawns.

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import process from 'node:process';

const PROMPT = 'create-iai — choose the project folder';

/**
 * Candidate commands to open the native folder dialog, in try-order.
 * Linux has two (zenity, then kdialog) because neither is guaranteed.
 * @param {NodeJS.Platform} platform
 * @param {string} [startDir] - initial folder shown by the dialog.
 * @returns {{cmd: string, args: string[]}[]} empty when the platform has none.
 */
export function pickFolderCommands(platform, startDir) {
  const start = String(startDir || '').trim();

  if (platform === 'darwin') {
    // Multiple -e = lines of the same script. The activate (best-effort, inside
    // a try) brings the dialog to the front — without it, it may open behind
    // the browser. Quotes/backslashes in the path are escaped for AppleScript.
    const esc = start.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const choose = start
      ? `POSIX path of (choose folder with prompt "${PROMPT}" default location (POSIX file "${esc}"))`
      : `POSIX path of (choose folder with prompt "${PROMPT}")`;
    return [
      {
        cmd: 'osascript',
        args: ['-e', 'try', '-e', 'tell application "System Events" to activate', '-e', 'end try', '-e', choose],
      },
    ];
  }

  if (platform === 'win32') {
    // -STA is required for WinForms dialogs. Single quotes are doubled
    // (PowerShell's escape for single-quoted strings).
    const esc = start.replace(/'/g, "''");
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      `$d.Description = '${PROMPT.replace(/'/g, "''")}'`,
      start ? `$d.SelectedPath = '${esc}'` : '',
      "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
    ]
      .filter(Boolean)
      .join('; ');
    return [{ cmd: 'powershell', args: ['-NoProfile', '-STA', '-Command', script] }];
  }

  if (platform === 'linux') {
    return [
      {
        cmd: 'zenity',
        args: [
          '--file-selection',
          '--directory',
          `--title=${PROMPT}`,
          // zenity requires the trailing slash to open INSIDE the starting folder.
          ...(start ? [`--filename=${start.replace(/\/*$/, '/')}`] : []),
        ],
      },
      { cmd: 'kdialog', args: ['--title', PROMPT, '--getexistingdirectory', start || homedir()] },
    ];
  }

  return [];
}

/**
 * One dialog at a time: two clicks on "Choose" must not stack Finders.
 */
let dialogOpen = false;

/**
 * Open the native folder dialog and wait for the user's choice.
 * @param {string} [startDir]
 * @returns {Promise<{path: string} | {cancelled: true} | {unsupported: true} | {busy: true}>}
 */
export async function pickFolder(startDir, platform = process.platform) {
  if (dialogOpen) return { busy: true };
  dialogOpen = true;
  try {
    const candidates = pickFolderCommands(platform, startDir);
    if (candidates.length === 0) return { unsupported: true };
    for (const spec of candidates) {
      const result = await runDialog(spec);
      // "unsupported" here = missing binary (e.g. no zenity) → try the next one.
      if (!result.unsupported) return result;
    }
    return { unsupported: true };
  } finally {
    dialogOpen = false;
  }
}

function runDialog({ cmd, args }) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return resolve({ unsupported: true });
    }
    child.on('error', () => resolve({ unsupported: true }));
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', () => {}); // "User canceled. (-128)" and the like — irrelevant
    child.on('close', (code) => {
      // AppleScript returns the POSIX path with a trailing "/" — normalize (without touching the root).
      let path = out.trim();
      if (path.length > 1) path = path.replace(/[\\/]+$/, '');
      if (code === 0 && path) return resolve({ path });
      resolve({ cancelled: true });
    });
  });
}
