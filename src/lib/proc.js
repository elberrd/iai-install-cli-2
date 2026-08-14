import process from 'node:process';
import { execa } from 'execa';
import { logCommand } from './log.js';

/** Locate an executable on PATH. Returns the resolved path or null. */
export async function which(cmd) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execa(finder, [cmd]);
    const first = stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)[0];
    return first || null;
  } catch {
    return null;
  }
}

/** True if a command is available on PATH. */
export async function has(cmd) {
  return (await which(cmd)) !== null;
}

/**
 * Run a command capturing output. Never throws on non-zero exit.
 * Pass `opts.input` to feed a string to the child's stdin (e.g. piping a
 * secret into `vercel env add`). Pass `opts.sensitiveOutput: true` when
 * STDOUT contains a secret only known AFTER running (e.g. `neon
 * projects create` returns the connection string with the password) — the
 * output stays out of the debug log (which the student attaches to bug reports).
 * @returns {Promise<{ok:boolean, exitCode:number, stdout:string, stderr:string}>}
 */
export async function run(cmd, args = [], opts = {}) {
  // Capture stdout/stderr, but never hand the child an interactive stdin.
  // execa's default leaves stdin as an *open pipe* that never receives EOF;
  // some CLIs probe stdin and block on it forever (notably the Clerk CLI's
  // `whoami`/`apps`/`api` in agent mode), which hangs the whole installer.
  // Anything that truly needs interactive input must use runInherit instead.
  // When `input` is provided, execa pipes it in and closes stdin afterwards.
  const { input, sensitiveOutput, ...rest } = opts;
  const stdio = input != null ? {} : { stdin: 'ignore' };
  const res = await execa(cmd, args, { ...stdio, ...(input != null ? { input } : {}), reject: false, ...rest });
  const out = {
    ok: res.exitCode === 0 && !res.failed,
    exitCode: res.exitCode ?? 1,
    stdout: (res.stdout ?? '').toString(),
    stderr: (res.stderr ?? '').toString(),
  };
  logCommand(cmd, args, sensitiveOutput ? { exitCode: out.exitCode, stdout: '(sensitive output — kept out of the log)' } : out);
  return out;
}

/**
 * Run a command wired to the parent's stdio — for anything interactive:
 * browser/device logins, `npm install` progress, dev servers.
 * @returns {Promise<{ok:boolean, exitCode:number}>}
 */
export async function runInherit(cmd, args = [], opts = {}) {
  const res = await execa(cmd, args, { stdio: 'inherit', reject: false, ...opts });
  const out = { ok: res.exitCode === 0 && !res.failed, exitCode: res.exitCode ?? 1 };
  logCommand(cmd, args, { exitCode: out.exitCode, stdout: '(inherited stdio — output in the terminal)' });
  return out;
}
