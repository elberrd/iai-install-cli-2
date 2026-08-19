#!/usr/bin/env node
/**
 * Controlled, internal ablation of always-loaded AI instructions.
 *
 * Dry-run is the default. Real execution is isolated in detached temporary
 * worktrees and never strips deterministic enforcement.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINES, mapAiLayer } from './ai-layer-map.mjs';

const MAX_CAPTURE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const LOGICAL_ARMS = Object.freeze(['control', 'always-loaded-stripped']);
const BLIND_ARMS = Object.freeze(['arm-a', 'arm-b']);
const EXECUTION_ORDER_STRATEGY = 'deterministic-alternating-blind-labels-v1';

function commandFailure(label, result) {
  const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
  return new Error(`${label} failed${detail ? `: ${detail}` : ''}`);
}

function git(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  });
  if (!allowFailure && (result.error || result.status !== 0)) throw commandFailure(`git ${args.join(' ')}`, result);
  return result;
}

function repoRoot(dir) {
  const result = git(resolve(dir), ['rev-parse', '--show-toplevel']);
  return resolve(result.stdout.trim());
}

function repoStatus(root) {
  return git(root, ['status', '--porcelain=v1', '--untracked-files=all']).stdout;
}

function bounded(value) {
  const text = String(value || '');
  if (Buffer.byteLength(text) <= MAX_CAPTURE_BYTES) return { text, truncated: false };
  let slice = text.slice(0, MAX_CAPTURE_BYTES);
  while (Buffer.byteLength(slice) > MAX_CAPTURE_BYTES) slice = slice.slice(0, -1024);
  return { text: slice, truncated: true };
}

function assertSafeRelative(rel) {
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../')) {
    throw new Error(`unsafe mapped path: ${rel}`);
  }
}

function strippingSafety(layer) {
  const alwaysLoaded = [];
  const enforcementCanonical = new Set();
  for (const engine of ENGINES) {
    alwaysLoaded.push(...layer.engines[engine].always_loaded);
    for (const file of layer.engines[engine].enforcement) {
      enforcementCanonical.add(file.canonical_path || file.path);
    }
  }
  const excludedAliases = new Set();
  const excludedEnforcement = new Set();
  const stripped = new Set();
  for (const file of alwaysLoaded) {
    const canonical = file.canonical_path || file.path;
    if (file.via_symlink) excludedAliases.add(file.path);
    if (enforcementCanonical.has(canonical)) excludedEnforcement.add(file.path);
    if (!file.via_symlink && !enforcementCanonical.has(canonical)) stripped.add(file.path);
  }
  return {
    stripped: [...stripped].sort(),
    excludedAliases: [...excludedAliases].sort(),
    excludedEnforcement: [...excludedEnforcement].sort(),
    enforcementPreserved: [...stripped].every((path) => {
      const file = alwaysLoaded.find((entry) => entry.path === path);
      return file && !file.via_symlink && !enforcementCanonical.has(file.canonical_path || file.path);
    }),
  };
}

function pathInside(root, candidate) {
  // Windows paths are case-insensitive, while path.relative compares strings.
  // realpath may return the same directory with a different drive/path casing.
  const comparableRoot = process.platform === 'win32' ? root.toLowerCase() : root;
  const comparableCandidate = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  const rel = relative(comparableRoot, comparableCandidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function canonicalFuturePath(candidate) {
  let cursor = resolve(candidate);
  const tail = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    tail.unshift(basename(cursor));
    cursor = parent;
  }
  return join(realpathSync.native(cursor), ...tail);
}

function existingAncestorInside(root, candidate) {
  const canonicalRoot = realpathSync.native(root).toLowerCase();
  let cursor = resolve(candidate);
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
  while (true) {
    if (realpathSync.native(cursor).toLowerCase() === canonicalRoot) return true;
    const parent = dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}

function prepareOutputDir(explicit, sourceRoot) {
  if (!explicit) return mkdtempSync(join(tmpdir(), 'impactus-ablation-results-'));
  const out = resolve(explicit);
  // Walking existing ancestors with the native resolver handles Windows paths
  // that mix long names and 8.3 aliases for the same directory.
  if (existingAncestorInside(sourceRoot, out)) throw new Error('--out must be outside the source repository');
  const canonicalRoot = realpathSync.native(sourceRoot);
  const canonicalOut = canonicalFuturePath(out);
  if (pathInside(canonicalRoot, canonicalOut)) throw new Error('--out must be outside the source repository');
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`--out must be absent or empty: ${out}`);
  mkdirSync(out, { recursive: true });
  return out;
}

function writeText(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value);
}

function writeJson(file, value) {
  writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function taskDigest(text) {
  return createHash('sha256').update(text).digest('hex');
}

function mapCommittedHead(root, head) {
  const snapshotParent = mkdtempSync(join(tmpdir(), 'impactus-ablation-head-'));
  const snapshot = join(snapshotParent, 'snapshot');
  try {
    git(root, ['clone', '--quiet', '--no-checkout', '--shared', '--', root, snapshot]);
    git(snapshot, ['checkout', '--quiet', '--detach', head]);
    return { ...mapAiLayer(snapshot), root };
  } finally {
    rmSync(snapshotParent, { recursive: true, force: true });
  }
}

function balancedExecutionOrder(runs) {
  const trials = [];
  let sequence = 1;
  for (let run = 1; run <= runs; run++) {
    const arms = run % 2 === 1 ? BLIND_ARMS : [...BLIND_ARMS].reverse();
    for (let position = 0; position < arms.length; position++) {
      trials.push({ sequence, run, position: position + 1, arm: arms[position] });
      sequence += 1;
    }
  }
  return { strategy: EXECUTION_ORDER_STRATEGY, trials };
}

/** Build the no-side-effect plan printed by the default dry-run. */
export function buildAblationPlan(options) {
  const root = repoRoot(options.dir || process.cwd());
  const taskPath = resolve(options.task);
  if (!existsSync(taskPath)) throw new Error(`task file not found: ${taskPath}`);
  if (!options.runnerBin) throw new Error('--runner-bin is required');
  const runs = Number(options.runs ?? 2);
  if (!Number.isInteger(runs) || runs < 2) throw new Error('--runs must be an integer >= 2');
  const timeoutMs = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('--timeout-ms must be a positive integer');
  const head = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const dirty = repoStatus(root) !== '';
  // Trials always start from committed HEAD. Mapping that same immutable
  // snapshot keeps dirty, deleted, untracked and ignored instructions from
  // changing which files the stripped arm removes.
  const layer = mapCommittedHead(root, head);
  const stripping = strippingSafety(layer);
  return {
    schema_version: 1,
    mode: options.execute ? 'execute' : 'dry-run',
    root,
    head,
    dirty,
    allow_dirty_base: Boolean(options.allowDirtyBase),
    limitations:
      dirty && options.allowDirtyBase
        ? ['The source tree is dirty; trials use committed HEAD only and exclude every uncommitted change.']
        : [],
    task: { path: taskPath, sha256: taskDigest(readFileSync(taskPath)) },
    runner: { bin: options.runnerBin, args: [...(options.runnerArgs || [])], stdin: 'task file contents' },
    runs_per_arm: runs,
    timeout_ms: timeoutMs,
    layer_source: 'committed-head',
    execution_order: balancedExecutionOrder(runs),
    arms: [
      { name: 'control', stripped: [] },
      { name: 'always-loaded-stripped', stripped: stripping.stripped },
    ],
    enforcement_preserved: stripping.enforcementPreserved,
    alias_paths_excluded_from_stripping: stripping.excludedAliases,
    enforcement_excluded_from_stripping: stripping.excludedEnforcement,
    layer,
  };
}

function installSignalCleanup(cleanup) {
  const handlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      cleanup();
      process.exit(128 + (signal === 'SIGINT' ? 2 : 15));
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  };
}

/** Execute the two-arm experiment and return its manifest. */
export function executeAblation(options) {
  const plan = buildAblationPlan({ ...options, execute: true });
  if (!plan.enforcement_preserved) throw new Error('refusing ablation because enforcement would be stripped');
  if (plan.dirty && !plan.allow_dirty_base) {
    throw new Error('working tree is dirty; commit/stash it or pass --allow-dirty-base to measure HEAD only');
  }

  const sourceStatusBefore = repoStatus(plan.root);
  const outputDir = prepareOutputDir(options.out, plan.root);
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'impactus-ablation-worktrees-'));
  const liveWorktrees = new Set();
  const cleanupErrors = [];

  const cleanup = () => {
    for (const worktree of [...liveWorktrees]) {
      const result = git(plan.root, ['worktree', 'remove', '--force', worktree], { allowFailure: true });
      if (result.error || result.status !== 0)
        cleanupErrors.push(String(result.stderr || result.error?.message || '').trim());
      liveWorktrees.delete(worktree);
    }
    git(plan.root, ['worktree', 'prune'], { allowFailure: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  };
  const removeSignalHandlers = installSignalCleanup(cleanup);

  const blindLabels = randomInt(2) === 0 ? ['arm-a', 'arm-b'] : ['arm-b', 'arm-a'];
  const labels = Object.fromEntries(LOGICAL_ARMS.map((arm, index) => [arm, blindLabels[index]]));
  const logicalByBlind = Object.fromEntries(Object.entries(labels).map(([logical, blind]) => [blind, logical]));
  const results = [];
  const taskText = readFileSync(plan.task.path, 'utf8');

  try {
    for (const trial of plan.execution_order.trials) {
      const { sequence, run, position, arm: blind } = trial;
      const arm = logicalByBlind[blind];
      const worktree = join(worktreeRoot, `${blind}-${String(run).padStart(2, '0')}`);
      git(plan.root, ['worktree', 'add', '--detach', worktree, plan.head]);
      liveWorktrees.add(worktree);

      const stripped = arm === 'always-loaded-stripped' ? plan.arms[1].stripped : [];
      for (const rel of stripped) {
        assertSafeRelative(rel);
        rmSync(join(worktree, rel), { recursive: true, force: true });
      }

      // Capture the arm baseline as a tree object. This excludes the
      // deliberate instruction removals from the runner's blind diff.
      git(worktree, ['add', '-A', '--', '.']);
      const baselineTree = git(worktree, ['write-tree']).stdout.trim();

      const started = Date.now();
      const runner = spawnSync(plan.runner.bin, plan.runner.args, {
        cwd: worktree,
        input: taskText,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        timeout: plan.timeout_ms,
        shell: false,
        env: { ...process.env, IMPACTUS_ABLATION_RUN: String(run) },
      });
      const durationMs = Date.now() - started;
      const stdout = bounded(runner.stdout);
      const stderr = bounded(runner.stderr || runner.error?.message || '');

      git(worktree, ['add', '-A', '--', '.']);
      const diff = git(worktree, ['diff', '--cached', '--binary', '--no-ext-diff', baselineTree]).stdout;
      const prefix = join(outputDir, 'blind', blind, `run-${String(run).padStart(2, '0')}`);
      writeText(`${prefix}.diff`, diff);
      writeText(`${prefix}.stdout.txt`, stdout.text);
      writeText(`${prefix}.stderr.txt`, stderr.text);
      const result = {
        arm: blind,
        run,
        sequence,
        position,
        exit_code: runner.status,
        signal: runner.signal || null,
        timed_out: runner.error?.code === 'ETIMEDOUT',
        duration_ms: durationMs,
        stdout_truncated: stdout.truncated,
        stderr_truncated: stderr.truncated,
        diff_bytes: Buffer.byteLength(diff),
      };
      results.push(result);
      writeJson(`${prefix}.json`, result);

      const removed = git(plan.root, ['worktree', 'remove', '--force', worktree], { allowFailure: true });
      if (removed.error || removed.status !== 0) throw commandFailure('git worktree remove', removed);
      liveWorktrees.delete(worktree);
    }
  } finally {
    cleanup();
    removeSignalHandlers();
  }

  const sourceStatusAfter = repoStatus(plan.root);
  const runnerFailures = results.filter((result) => result.exit_code !== 0 || result.signal || result.timed_out);
  const manifest = {
    schema_version: 1,
    created_at: new Date().toISOString(),
    root: plan.root,
    head: plan.head,
    task: plan.task,
    runner: plan.runner,
    runs_per_arm: plan.runs_per_arm,
    timeout_ms: plan.timeout_ms,
    layer_source: plan.layer_source,
    execution_order: plan.execution_order,
    source_dirty_base: plan.dirty,
    limitations: plan.limitations,
    source_unchanged: sourceStatusBefore === sourceStatusAfter,
    enforcement_preserved: plan.enforcement_preserved,
    alias_paths_excluded_from_stripping: plan.alias_paths_excluded_from_stripping,
    enforcement_excluded_from_stripping: plan.enforcement_excluded_from_stripping,
    valid: runnerFailures.length === 0,
    runner_failures: runnerFailures.map(({ arm, run, sequence, position, exit_code, signal, timed_out }) => ({
      arm,
      run,
      sequence,
      position,
      exit_code,
      signal,
      timed_out,
    })),
    blind_results: results,
    cleanup_errors: cleanupErrors.filter(Boolean),
  };
  writeJson(join(outputDir, 'manifest.json'), manifest);
  writeJson(join(outputDir, 'answer-key.json'), {
    warning: 'Keep this file away from the blind grader until grading is complete.',
    labels,
    logical_execution_order: {
      strategy: plan.execution_order.strategy,
      trials: plan.execution_order.trials.map((trial) => ({ ...trial, arm: logicalByBlind[trial.arm] })),
    },
    stripped_paths: plan.arms[1].stripped,
  });
  if (!manifest.source_unchanged)
    throw new Error(`source working tree changed during ablation; results kept at ${outputDir}`);
  if (manifest.cleanup_errors.length) throw new Error(`worktree cleanup was incomplete; results kept at ${outputDir}`);
  if (!manifest.valid) throw new Error(`one or more runner trials failed; evidence kept at ${outputDir}`);
  return { ...manifest, output_dir: outputDir };
}

function parseArgs(argv) {
  const opts = { dir: process.cwd(), runnerArgs: [], runs: 2, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dir') opts.dir = argv[++i];
    else if (arg === '--task') opts.task = argv[++i];
    else if (arg === '--runner-bin') opts.runnerBin = argv[++i];
    else if (arg === '--runner-arg') opts.runnerArgs.push(argv[++i]);
    else if (arg === '--runs') opts.runs = argv[++i];
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--timeout-ms') opts.timeoutMs = argv[++i];
    else if (arg === '--execute') opts.execute = true;
    else if (arg === '--allow-dirty-base') opts.allowDirtyBase = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const key of ['dir', 'task', 'runnerBin']) {
    if (!opts.help && !opts[key]) throw new Error(`--${key === 'runnerBin' ? 'runner-bin' : key} is required`);
  }
  if (opts.runnerArgs.some((arg) => arg == null)) throw new Error('--runner-arg requires a value');
  return opts;
}

function usage() {
  return [
    'Usage: node scripts/ai-layer-ablate.mjs --dir <repo> --task <file> --runner-bin <bin>',
    '  [--runner-arg <arg>...] [--runs <n>] [--out <dir>] [--timeout-ms <ms>]',
    '  [--execute] [--allow-dirty-base]',
    '',
    'Default: print a dry-run plan. --execute runs two isolated arms.',
    '',
  ].join('\n');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) process.stdout.write(usage());
    else {
      const result = opts.execute ? executeAblation(opts) : buildAblationPlan(opts);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`ai-layer-ablate: ${error.message}\n`);
    process.exitCode = 1;
  }
}
