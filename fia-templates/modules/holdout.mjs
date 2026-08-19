/**
 * Holdout probes — acceptance checks the builder never optimizes against.
 *
 * Everything else in the gate (tests, lint, checklist, UI gate) sits INSIDE
 * the builder's loop: the agent can read those checks, run them, and iterate
 * until they are green. A holdout probe sits outside it. Probes live in
 * imp/data/holdout/ — a directory agents cannot write (permissions.mjs
 * ALWAYS_PROTECTED) — and are written when the BRIEF is, before the code they
 * will judge exists. That order is the whole point: a scenario written after
 * seeing the implementation is a description of the implementation.
 *
 * Contract: every `*.mjs` file in imp/data/holdout/ (except README/`_`-prefixed
 * helpers) is one probe. It is executed as `node <file>` from the project
 * root; exit 0 means the invariant holds, anything else is a violation. A
 * probe should COMPOSE — assert something no single unit test is positioned
 * to see — and assert the PROPERTY, not one algebraic consequence of it.
 *
 * When a probe fails, the run FAILS with no repair round. Feeding the probe's
 * content back to the builder would move it inside the loop it exists to sit
 * outside of; the failure output is for the human, in the trace and the
 * console.
 */
import { readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

export const HOLDOUT_DIR = 'holdout';

export function holdoutDir(dataDir) {
  return join(dataDir || 'imp/data', HOLDOUT_DIR);
}

/** Sorted probe files (absolute). README and `_`-prefixed helpers are not probes. */
export function listHoldoutProbes(dataDir) {
  const dir = holdoutDir(dataDir);
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // no holdout directory — nothing to run, by design
  }
  return names
    .filter((n) => n.endsWith('.mjs') && !n.startsWith('_'))
    .sort()
    .map((n) => join(dir, n));
}

/** Output kept per probe — a runaway probe must not fill memory before its timeout. */
const MAX_PROBE_OUTPUT = 64 * 1024;

function runProbe(file, { cwd, timeoutSeconds = 120, env = process.env } = {}) {
  return new Promise((settle) => {
    let output = '';
    let settled = false;
    const collect = (chunk) => {
      if (output.length < MAX_PROBE_OUTPUT) output += chunk;
    };
    const done = (passed, note = '') => {
      if (settled) return;
      settled = true;
      settle({ name: basename(file), file, passed, output: (output + (note ? `\n${note}` : '')).trim() });
    };
    let child;
    try {
      child = spawn(process.execPath, [file], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      // A probe that cannot even start must be LOUD, not absent — an
      // unrunnable check scored as green is how gates rot silently.
      return done(false, `probe failed to start: ${err?.message || err}`);
    }
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const timer = setTimeout(() => {
      // SIGTERM first, then SIGKILL: a probe that boots a server (exactly the
      // "compose, assert what no unit test sees" shape the README asks for)
      // can trap SIGTERM or hold its pipes open through a child of its own,
      // and the parent would then wait forever on a check it already failed.
      child.kill('SIGTERM');
      const hard = setTimeout(() => child.kill('SIGKILL'), 5000);
      hard.unref?.();
      child.stdout?.destroy();
      child.stderr?.destroy();
      done(false, `probe timed out after ${timeoutSeconds}s`);
    }, timeoutSeconds * 1000);
    timer.unref?.();
    child.on('close', (code) => {
      clearTimeout(timer);
      done(code === 0, code === 0 ? '' : `exit ${code}`);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      done(false, `probe failed to run: ${err?.message || err}`);
    });
  });
}

/** Run every probe → { scenarios, passed, results, failures }. Zero probes = vacuously passed. */
export async function runHoldoutProbes({ repoRoot = process.cwd(), dataDir, timeoutSeconds } = {}) {
  const files = listHoldoutProbes(dataDir);
  const results = [];
  for (const file of files) {
    results.push(await runProbe(file, { cwd: repoRoot, timeoutSeconds }));
  }
  const failures = results.filter((r) => !r.passed);
  return { scenarios: results.length, passed: failures.length === 0, results, failures };
}

/**
 * The FDA-side gate: a `holdout` code phase after the suite went green. Skips
 * (with a logged reason) when the project carries no probes — proportionality,
 * same as the spec-coverage gate. A violation throws and fails the run with
 * NO repair round: the probe's output names the violated scenario for the
 * human; the builder is never prompted with it.
 */
export async function runHoldoutGate(run) {
  // Resolved against the RUN's repo, never the process cwd — `data_dir` is a
  // repo-relative path, and probes must be looked for in the tree under test.
  const dataDir = resolve(run.repoRoot, run.cfg?.defaults?.data_dir || 'imp/data');
  // Imported HERE, not at module scope: `fda-cli.mjs` pulls in better-sqlite3
  // (a native module), and the halves of this file above are also loaded by
  // `imp/scripts/holdout.mjs` and by the gate self-test — both of which must
  // keep working in a project whose imp/node_modules was never installed,
  // which is exactly the state `imp doctor` exists to diagnose.
  const { phaseParams } = await import('./fda-cli.mjs');
  return run.runPhase(
    phaseParams('holdout', 'code', 'quality', 'Run the holdout probes (never quoted to the builder, no repair round)'),
    async (ph) => {
      const report = await runHoldoutProbes({ repoRoot: run.repoRoot, dataDir });
      if (!report.scenarios) {
        ph.log({ skipped: `no probes in ${holdoutDir(dataDir)}` });
        return { skip: true };
      }
      if (!report.passed) {
        ph.log({ scenarios: report.scenarios, violated: report.failures.map((f) => f.name).join(', ') });
        throw new Error(
          `holdout violated — ${report.failures.length} of ${report.scenarios} scenario(s) failed:\n` +
            report.failures.map((f) => `- ${f.name}\n${f.output.split('\n').map((l) => `    ${l}`).join('\n')}`).join('\n') +
            '\nHoldout probes get no automatic repair round: a human reviews the violation ' +
            '(the probes live in imp/data/holdout/ and agents cannot edit them).',
        );
      }
      ph.log({ holdout: `HOLDOUT_PASSED scenarios=${report.scenarios}` });
      return { skip: false, scenarios: report.scenarios };
    },
  );
}
