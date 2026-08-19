#!/usr/bin/env node
/**
 * The FIA stop button — arm, inspect or clear a manual stop request.
 *
 *   imp stop              arm: no new FDA run starts, and an in-flight run
 *                         stops cleanly before its next phase (nothing is
 *                         lost — the run settles as `stopped_by_request` and
 *                         resumes later with --resume)
 *   imp stop --status     show whether the button is armed and if a run is live
 *   imp stop --clear      disarm
 *   imp stop --reason "…" arm with a note (shown wherever the stop is reported)
 *   imp stop --json       machine-readable state (with any of the above)
 *
 * The button is a FILE (imp/data/fia-stop) on purpose: it works with the
 * network down, from any terminal, from a file manager, from an SSH session —
 * `touch imp/data/fia-stop` is a valid way to press it. The reader side
 * (modules/stop.mjs) FAILS CLOSED: a stop file that exists but cannot be read
 * still stops the run. Design borrowed from lights-out factory experiments —
 * a stop button that has never been used is a stop button nobody knows works,
 * so this one is exercised by the repo's test suite.
 */
import { rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { manualStopState, manualStopPath } from '../modules/stop.mjs';
import { isMainModule, dataDirOf } from '../modules/utils.mjs';
import { activeFdaLock } from './fda-lock.mjs';

function flagValue(argv, flag) {
  const ix = argv.indexOf(flag);
  return ix !== -1 && argv[ix + 1] !== undefined ? argv[ix + 1] : undefined;
}

export function runCli(argv, { root = process.cwd() } = {}) {
  // Arm and report at the directory the RUNNER reads (`defaults.data_dir`),
  // and treat the canonical imp/data as a second candidate everywhere — the
  // runtime reader checks both, so a file left by a hand `touch` (or by an
  // older version of this command) must be visible to --status and removable
  // by --clear. A button that reports "cleared" while a run stays stopped is
  // the same lie as one that reports ARMED while a run keeps going.
  const dataDir = dataDirOf(root);
  const candidates = [...new Set([dataDir, join(root, 'imp', 'data')])];
  const json = argv.includes('--json');
  const lock = activeFdaLock(root);
  const state = () => manualStopState(dataDir, root);

  if (argv.includes('--status')) {
    const s = state();
    if (json) {
      console.log(JSON.stringify({ armed: s.stopped, reason: s.reason || '', path: s.path, active_run: lock }));
      return 0;
    }
    console.log(s.stopped ? `stop button ARMED (${s.path})${s.reason ? ` — ${s.reason}` : ''}` : 'stop button not armed');
    if (lock) console.log(`FIA run active — fda_id ${lock.fda_id || 'unknown'} (pid ${lock.pid}); it stops before its next phase while armed.`);
    return 0;
  }

  if (argv.includes('--clear')) {
    for (const dir of candidates) {
      try {
        rmSync(manualStopPath(dir), { force: true });
      } catch (err) {
        // force:true swallows ENOENT; anything else (EACCES, EISDIR on some
        // platforms) means the button is still armed — say so, never lie.
        console.error(`could not remove ${manualStopPath(dir)}: ${err?.message || err}`);
        console.error('Remove the file by hand — while it exists (even unreadable) runs stay stopped.');
        return 1;
      }
    }
    const s = state();
    if (s.stopped) {
      console.error(`the stop file is still present after removal (${s.path}) — remove it by hand.`);
      return 1;
    }
    if (json) console.log(JSON.stringify({ armed: false }));
    else console.log('stop button cleared — FDA runs may start (resume an interrupted one with --resume).');
    return 0;
  }

  // Default verb: ARM. Idempotent — pressing an already-pressed button is fine.
  const reason = String(flagValue(argv, '--reason') || '').trim();
  const path = manualStopPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ requested_at: new Date().toISOString(), reason }, null, 2));
  } catch (err) {
    console.error(`could not write ${path}: ${err?.message || err}`);
    return 1;
  }
  if (json) {
    console.log(JSON.stringify({ armed: true, reason, path, active_run: lock }));
    return 0;
  }
  console.log(`stop button ARMED (${path})${reason ? ` — ${reason}` : ''}`);
  if (lock) {
    console.log(`FIA run active — fda_id ${lock.fda_id || 'unknown'} (pid ${lock.pid}).`);
    console.log('It stops cleanly before its next phase and records outcome `stopped_by_request`;');
    console.log('resume later with the --resume command it prints.');
  } else {
    console.log('No run is active — new runs refuse to start until you clear it:');
  }
  console.log('  imp stop --clear');
  return 0;
}

const isMain = isMainModule(import.meta.url);
if (isMain) process.exit(runCli(process.argv.slice(2)));
