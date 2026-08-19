#!/usr/bin/env node
/**
 * Holdout probe runner — the CLI face of imp/modules/holdout.mjs.
 *
 *   npm run holdout             run every probe in imp/data/holdout/
 *   npm run holdout -- --list   list the probes without running them
 *   npm run holdout -- --require  fail when there are ZERO probes (for a
 *                                 project that has committed to holdouts, an
 *                                 empty directory is a silently-lowered gate)
 *   npm run holdout -- --json   machine-readable report
 *
 * Emits `HOLDOUT_PASSED scenarios=N` on green — a literal marker other tools
 * can grep for, because "the run said it passed" and "the marker is present"
 * must be the same fact. Exit 1 on any violation (and on --require with no
 * probes). See imp/data/holdout/README.md for the probe contract.
 */
import { listHoldoutProbes, runHoldoutProbes, holdoutDir } from '../modules/holdout.mjs';
import { isMainModule, dataDirOf } from '../modules/utils.mjs';

export async function runCli(argv, { root = process.cwd() } = {}) {
  const json = argv.includes('--json');
  // The same directory the GATE reads (imp/modules/holdout.mjs resolves
  // `defaults.data_dir` too) — otherwise a project that moved data_dir would
  // see this command report "no probes" while the run happily executes them.
  const dataDir = dataDirOf(root);

  if (argv.includes('--list')) {
    const files = listHoldoutProbes(dataDir);
    if (json) console.log(JSON.stringify(files));
    else if (!files.length) console.log(`no holdout probes in ${holdoutDir(dataDir)}`);
    else for (const f of files) console.log(f);
    return 0;
  }

  const report = await runHoldoutProbes({ repoRoot: root, dataDir });
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return report.passed && (report.scenarios > 0 || !argv.includes('--require')) ? 0 : 1;
  }
  if (!report.scenarios) {
    // Self-contained on purpose: a project upgraded with `--update-runtime`
    // gets the code but not imp/data/ (student-owned), so the directory and
    // its README may simply not exist yet — pointing at a file that is not
    // there would be a dead end.
    const how =
      `Probes are plain Node scripts in ${holdoutDir(dataDir)} (create the directory if absent); ` +
      'exit 0 means the invariant holds. The task-sequencer seals 1-3 of them when it writes a brief.';
    if (argv.includes('--require')) {
      console.error(`HOLDOUT_EMPTY — no probes found, and --require treats that as a failure.\n${how}`);
      return 1;
    }
    console.log(`HOLDOUT_EMPTY scenarios=0 — no probes found.\n${how}`);
    return 0;
  }
  for (const r of report.results) {
    console.log(`${r.passed ? '✓' : '✗'} ${r.name}`);
    if (!r.passed && r.output) console.log(r.output.split('\n').map((l) => `    ${l}`).join('\n'));
  }
  if (!report.passed) {
    console.error(`HOLDOUT_VIOLATED failed=${report.failures.length} of=${report.scenarios}`);
    return 1;
  }
  console.log(`HOLDOUT_PASSED scenarios=${report.scenarios}`);
  return 0;
}

const isMain = isMainModule(import.meta.url);
if (isMain) process.exit(await runCli(process.argv.slice(2)));
