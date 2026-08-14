import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { isFoundationBrief } from './gates.mjs';
import { nowIso } from './utils.mjs';

const TAIL_CHARS = 4000;

function checkDir(run, name) {
  const seq = run.phases.at(-1)?.seq ?? 0;
  const path = join(run.contextHandoffDir, 'quality', `${String(seq).padStart(2, '0')}_${name}`);
  mkdirSync(path, { recursive: true });
  return path;
}

async function runSpec(spec, run) {
  const phase = run.phases.at(-1);
  const outputDir = checkDir(run, spec.name);
  const outputArtifact = join(outputDir, 'command.log');
  const command = spec.argv.join(' ');
  run.console.note(`quality ${spec.name}: ${command}`);
  const startedAt = nowIso();
  const t0 = Date.now();

  let returncode = 0;
  let stdout = '';
  let stderr = '';
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: run.repoRoot,
        env: run.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.on('data', (d) => (stdout += d));
      child.stderr?.on('data', (d) => (stderr += d));
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Timed out after ${spec.timeoutSeconds}s`));
      }, spec.timeoutSeconds * 1000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });
      child.on('error', reject);
    });
    returncode = result;
  } catch (err) {
    returncode = 124;
    stderr = String(err.message || err);
  }

  const duration = (Date.now() - t0) / 1000;
  writeFileSync(
    outputArtifact,
    `$ ${command}\nexit: ${returncode}\nduration_seconds: ${duration.toFixed(3)}\n\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`,
  );
  const passed = returncode === 0;
  run.tracer.event({
    fda_id: run.fdaId,
    phase_id: phase.phase_id,
    type: 'tool_call',
    name: `quality:${spec.name}`,
    payload: { command, returncode, passed, output_artifact: outputArtifact },
    started_at: startedAt,
    ended_at: nowIso(),
  });
  return {
    name: spec.name,
    command,
    returncode,
    passed,
    duration_seconds: duration,
    output_artifact: outputArtifact,
    output_tail: (stdout + stderr).slice(-TAIL_CHARS),
  };
}

/**
 * Default quality commands for Next.js + Convex templates (live1/live2).
 * The typecheck script name varies per template ("type-check" in live1/live2,
 * "typecheck" in others) — resolve against the project's package.json so the
 * gate does not fail with "missing script" on a fresh install.
 */
export function defaultSpecs(projectRoot = process.cwd()) {
  let scripts = {};
  try {
    scripts = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).scripts || {};
  } catch {
    /* no readable package.json — keep the default names */
  }
  const typecheck = scripts.typecheck ? 'typecheck' : scripts['type-check'] ? 'type-check' : 'typecheck';
  return [
    { name: 'test', argv: ['npm', 'run', 'test'], timeoutSeconds: 600 },
    { name: 'lint', argv: ['npm', 'run', 'lint'], timeoutSeconds: 120 },
    { name: 'typecheck', argv: ['npm', 'run', typecheck], timeoutSeconds: 180 },
    { name: 'build', argv: ['npm', 'run', 'build'], timeoutSeconds: 600 },
  ];
}

/**
 * Focal spec: run ONLY the given test file(s) through the project's test
 * script — `npm run test -- <files>` hands the paths straight to vitest, jest
 * and node:test alike. red_check and /quick verify one behavior without
 * paying for the whole suite.
 */
export function focalSpec(files, { timeoutSeconds = 300 } = {}) {
  return { name: 'focal', argv: ['npm', 'run', 'test', '--', ...files], timeoutSeconds };
}

export async function runFocalTests(run, files) {
  return runTests(run, [focalSpec(files)]);
}

/**
 * Test phase for a brief: foundation briefs (`Kind: foundation` meta line,
 * copied from the issue by the task-sequencer) ALSO run `npm run build` —
 * the scaffold's unit tests pass without env vars, but the production build
 * reads them at prerender, and that failure must surface HERE, in code,
 * deterministically — never depend on the reviewer choosing to build.
 */
export async function runTestsForBrief(run, prompt) {
  if (!isFoundationBrief(prompt)) return runTests(run);
  const specs = defaultSpecs(run.repoRoot).filter((s) => s.name === 'test' || s.name === 'build');
  return runQuality(run, specs);
}

export async function runTests(run, specs = defaultSpecs()) {
  const testSpec = specs.find((s) => s.name === 'test') || specs[0];
  const check = await runSpec(testSpec, run);
  const failures = check.passed
    ? []
    : [`${check.name}: \`${check.command}\` exited ${check.returncode}\n${check.output_tail}`.trim()];
  return {
    passed: check.passed,
    checks: [check],
    failures,
    artifacts: [check.output_artifact],
  };
}

export async function runQuality(run, specs = defaultSpecs()) {
  const checks = [];
  for (const spec of specs) {
    checks.push(await runSpec(spec, run));
  }
  const failures = checks
    .filter((c) => !c.passed)
    .map((c) => `${c.name}: \`${c.command}\` exited ${c.returncode}\n${c.output_tail}`.trim());
  return {
    passed: failures.length === 0,
    checks,
    failures,
    artifacts: checks.map((c) => c.output_artifact),
  };
}

export function asEnvelope(result, what) {
  return {
    status: result.passed ? 'success' : 'fail',
    summary: result.passed
      ? `${what}: all ${result.checks.length} check(s) passed`
      : `${what}: ${result.failures.length} of ${result.checks.length} check(s) failed`,
    artifacts: result.artifacts,
    notes_for_next_agent: result.passed
      ? ''
      : 'Fix every failure below. The output is verbatim from the command — trust it over any summary.',
    passed: result.passed,
    failures: result.failures,
  };
}
