#!/usr/bin/env node
/**
 * FDA lock probe — the reader side of the FIA single-run lock.
 *
 * The runner (imp/modules/session.mjs) writes imp/data/.fda.lock while an FDA
 * is active and removes it on exit. A live lock means a deterministic run is
 * writing to this tree: its permission gate attributes every change to the
 * current phase agent and rolls back what the phase did not declare, so
 * anything an OUTSIDE session writes mid-run gets reverted or swept into the
 * run's commit. This script lets everything outside the run discover that
 * state:
 *
 *   status  one human line (--json for the raw lock) — `npm run fda:status`
 *   warn    SessionStart hook: prints a read-only notice when a run is
 *           active, stays silent otherwise — new sessions start informed
 *   gate    PreToolUse hook: reads the hook JSON from stdin and exits 2
 *           (block) when the tool call would write inside this repository
 *           while a run is active; silent exit 0 otherwise
 *
 * The Cursor hook (.cursor/hooks/fda-lock-cursor.mjs) imports activeFdaLock
 * and gateDecision from here and answers Cursor's beforeShellExecution
 * protocol with the same verdicts.
 *
 * The FDA's own child agents are exempt: the runner exports FIA_FDA_RUN into
 * their environment (see session.mjs) and both hooks stay silent when it is
 * present. Every path here fails OPEN — a missing lock, unreadable stdin or
 * an internal error never blocks a tool and never breaks a session.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The FIA single-run lock, when a LIVE process holds it → { pid, fda_id, … }. */
export function activeFdaLock(root, dataDir = join('imp', 'data')) {
  let lock = null;
  try {
    lock = JSON.parse(readFileSync(join(root, dataDir, '.fda.lock'), 'utf8'));
  } catch {
    return null; /* no lock or unreadable — no active run */
  }
  if (!lock?.pid || lock.pid === process.pid) return null;
  try {
    process.kill(lock.pid, 0); // ESRCH when the pid is dead → stale lock
    return lock;
  } catch (err) {
    // EPERM = the pid EXISTS but belongs to another user — the run is alive
    // and the lock must hold; anything else means stale.
    return err?.code === 'EPERM' ? lock : null;
  }
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// Bash write-context heuristics, shared shape with the Pi fia-guard extension:
// a command only blocks when it plausibly mutates files inside the repo.
const WRITE_BINARY = /(^|[\s;&|(])(rm|mv|cp|tee|chmod|chown|truncate|dd|ln|rsync|install)(\s|$)/;
const SED_IN_PLACE = /(^|[\s;&|(])sed\s+(-\S*i|--in-place)/;
// Git verbs that move the tree/index/history — a mid-run commit or checkout
// is exactly the incident this lock exists to prevent.
const GIT_WRITE =
  /(^|[\s;&|(])git\s+(add|am|apply|checkout|cherry-pick|clean|commit|merge|mv|rebase|reset|restore|revert|rm|stash|switch)\b/;

/** Does `raw` resolve to the project root or below it? */
function insideRoot(root, raw) {
  if (!raw) return false;
  const rel = relative(resolve(root), resolve(root, raw));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Targets of >/>> redirections (writes even without a write binary). */
function redirectTargets(command) {
  const out = [];
  const re = />{1,2}\s*([^\s;|&<>]+)/g;
  let m;
  while ((m = re.exec(command))) out.push(m[1].replace(/^["']+|["']+$/g, ''));
  return out;
}

/** Would this bash command write inside the repository at `root`? */
export function bashWritesInRepo(root, command) {
  if (GIT_WRITE.test(command)) return true;
  if (redirectTargets(command).some((t) => insideRoot(root, t))) return true;
  if (!WRITE_BINARY.test(command) && !SED_IN_PLACE.test(command)) return false;
  const tokens = command
    .split(/[\s;|&()<>]+/)
    .map((t) => t.replace(/^["']+|["']+$/g, ''))
    .filter(Boolean);
  // Only path-looking tokens count: `npm install` alone stays allowed, while
  // `rm src/x.js` or `sed -i '' file.ts` block. /tmp and other outside paths
  // never block — the run only guards its own tree.
  return tokens.some((t) => /[/.]/.test(t) && insideRoot(root, t));
}

/** PreToolUse verdict for a Claude hook payload → { block, reason? }. */
export function gateDecision(hook, { root, lock }) {
  const tool = hook?.tool_name;
  const input = hook?.tool_input || {};
  if (WRITE_TOOLS.has(tool)) {
    const target = input.file_path || input.notebook_path || '';
    if (insideRoot(root, target)) return { block: true, reason: gateReason(lock, target) };
    return { block: false };
  }
  if (tool === 'Bash' && bashWritesInRepo(root, String(input.command || ''))) {
    return { block: true, reason: gateReason(lock, 'this command') };
  }
  return { block: false };
}

function gateReason(lock, target) {
  return (
    `FIA run active (fda_id ${lock?.fda_id || 'unknown'}, pid ${lock?.pid || '?'}): ${target} touches this repository, ` +
    'and repo writes are blocked while the FDA runs — its permission gate would attribute the change to the ' +
    'current phase agent and roll it back. Reading and inspecting are fine. Wait for the run to finish ' +
    '(npm run fda:sessions); the lock lifts automatically. If the run is truly gone, remove imp/data/.fda.lock and retry.'
  );
}

export function renderWarn(lock) {
  const lines = [
    '⚠ FIA run ACTIVE in this repository — treat this session as READ-ONLY for repo files.',
    `  fda_id: ${lock?.fda_id || 'unknown'}   runner: ${lock?.runner || '?'}   pid: ${lock?.pid || '?'}   started: ${lock?.started_at || '?'}`,
    '  A deterministic FDA is writing to this tree. Its permission gate attributes every change',
    '  to the current phase agent and rolls back what the phase did not declare — anything',
    '  written here now gets reverted or swept into that run\'s commit. A hook blocks repo',
    '  writes until the run ends; the lock lifts automatically.',
    '  Watch progress: npm run fda:sessions   ·   live viewer: npm run fda:viewer',
  ];
  return lines.join('\n');
}

function readStdin() {
  return new Promise((done) => {
    if (process.stdin.isTTY) return done('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => done(data));
    process.stdin.on('error', () => done(''));
  });
}

/**
 * CLI body, exported so the harness shim (.claude/hooks/fda-lock.mjs) can
 * call it without a nested process. Returns the process exit code.
 */
export async function runCli(argv, { root = process.cwd(), env = process.env, input } = {}) {
  const cmd = argv.find((a) => !a.startsWith('--')) || 'status';
  const lock = activeFdaLock(root);
  if (cmd === 'status') {
    if (argv.includes('--json')) console.log(JSON.stringify(lock));
    else if (lock) {
      console.log(
        `FIA run active — fda_id ${lock.fda_id || 'unknown'} (${lock.runner || '?'}, pid ${lock.pid}, started ${lock.started_at || '?'})`,
      );
    } else console.log('no active FIA run in this repository');
    return 0;
  }
  // Inside the run's own process tree (FIA_FDA_RUN exported by the runner)
  // the hooks must stay silent — the FDA's builder MUST be able to write.
  if (!lock || env.FIA_FDA_RUN) return 0;
  if (cmd === 'warn') {
    console.log(renderWarn(lock));
    return 0;
  }
  if (cmd === 'gate') {
    let hook;
    try {
      hook = JSON.parse(input ?? (await readStdin()));
    } catch {
      return 0; // unreadable hook payload → fail open
    }
    const verdict = gateDecision(hook, { root: hook?.cwd || root, lock });
    if (verdict.block) {
      console.error(verdict.reason);
      return 2;
    }
    return 0;
  }
  return 0;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  process.exit(await runCli(process.argv.slice(2)));
}
