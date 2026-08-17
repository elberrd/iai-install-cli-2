// Debug log for troubleshooting failed installs. Every child command (and its
// captured output, when available) is appended to a per-run log file under the
// user's home directory. On fatal errors main.js prints the path so users can
// attach it to bug reports.
import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { stateDirPath } from './state-dir.js';

let logPath = null;

// How many run logs to keep in ~/.impactus-cli/logs — without a cap they
// accumulate forever (one file per run).
const KEEP_LOGS = 20;

/** Best-effort: delete run logs beyond the most recent KEEP_LOGS. */
function pruneOldLogs(dirPath) {
  try {
    const logs = readdirSync(dirPath)
      .filter((f) => f.startsWith('run-') && f.endsWith('.log'))
      .sort(); // ISO stamp in the name → lexicographic order == chronological
    for (const name of logs.slice(0, Math.max(0, logs.length - KEEP_LOGS))) {
      rmSync(join(dirPath, name), { force: true });
    }
  } catch {
    /* logging never breaks the CLI */
  }
}

/** Create the per-run log file (best-effort; logging never breaks the CLI). */
export function initLog() {
  try {
    const dirPath = join(stateDirPath(), 'logs');
    mkdirSync(dirPath, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    logPath = join(dirPath, `run-${stamp}.log`);
    appendFileSync(logPath, `# impactus — ${new Date().toISOString()}\n# node ${process.version} ${process.platform}/${process.arch}\n\n`);
    pruneOldLogs(dirPath);
  } catch {
    logPath = null;
  }
  return logPath;
}

export function getLogPath() {
  return logPath;
}

// Sensitive values (pasted/loaded keys) that must NEVER reach the log —
// the log is precisely the file we ask users to attach to bug reports.
const secrets = new Set();

/** Registers a sensitive value to be masked in everything that gets logged. */
export function redactSecret(value) {
  const v = String(value ?? '').trim();
  if (v.length >= 6) secrets.add(v);
}

function scrub(text) {
  let out = String(text);
  for (const s of secrets) out = out.split(s).join('«redacted»');
  return out;
}

/** Append a free-form line to the log (no-op when logging is unavailable). */
export function logLine(text) {
  if (!logPath) return;
  try {
    appendFileSync(logPath, `${scrub(text)}\n`);
  } catch {
    /* ignore */
  }
}

/** Record a child command invocation and its result. */
export function logCommand(cmd, args, { exitCode, stdout, stderr } = {}) {
  if (!logPath) return;
  const lines = [`$ ${cmd} ${args.join(' ')}`, `  exit: ${exitCode}`];
  if (stdout) lines.push(indent(stdout, '  out| '));
  if (stderr) lines.push(indent(stderr, '  err| '));
  logLine(lines.join('\n'));
}

function indent(text, prefix) {
  return String(text)
    .trimEnd()
    .split(/\r?\n/)
    .slice(0, 200) // keep the log bounded
    .map((l) => `${prefix}${l}`)
    .join('\n');
}
