import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rmSync, readFileSync, existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';

export class PermissionBreach extends Error {}

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return '';
  }
}

export function snapshot(run) {
  const fingerprints = {};
  for (const line of git(['diff', 'HEAD', '--numstat'], run.repoRoot).split('\n')) {
    const fields = line.split('\t');
    if (fields.length >= 3) {
      const path = fields[fields.length - 1].trim();
      fingerprints[path] = `${fields[0]},${fields[1]}`;
    }
  }
  // Untracked files are fingerprinted by CONTENT (size + sha1): mtime is both
  // too eager (a bare `touch` would look like a breach) and too coarse (a
  // same-size edit inside one timestamp tick would be invisible). The
  // untracked list is small, so hashing it is cheap.
  for (const path of git(['ls-files', '--others', '--exclude-standard'], run.repoRoot).split('\n')) {
    const p = path.trim();
    if (!p) continue;
    try {
      const content = readFileSync(resolve(run.repoRoot, p));
      fingerprints[p] = `untracked:${content.length},${createHash('sha1').update(content).digest('hex')}`;
    } catch {
      fingerprints[p] = 'untracked:unreadable';
    }
  }
  return fingerprints;
}

export function changedPaths(before, after) {
  const all = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...all].filter((p) => before[p] !== after[p]).sort();
}

function relPath(path, repoRoot) {
  return relative(repoRoot, resolve(repoRoot, path)).replace(/\\/g, '/');
}

function globMatch(rel, pattern) {
  const pat = pattern.replace(/^\.\//, '');
  // Directory pattern: match only at a segment boundary — "imp/modules/" owns
  // "imp/modules/x.mjs" but never "imp/modules-notes.txt".
  if (pat.endsWith('/')) return rel === pat.slice(0, -1) || rel.startsWith(pat);
  const re = new RegExp(
    '^' +
      pat
        .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex chars — "." must stay literal
        .replace(/\*\*/g, '<<<GLOB>>>')
        .replace(/\*/g, '[^/]*')
        .replace(/<<<GLOB>>>/g, '.*') +
      '$',
  );
  return re.test(rel);
}

function matchesAny(rel, patterns) {
  for (const p of patterns) {
    const pat = p.replace(/^\.\//, '');
    if (pat.endsWith('/') || pat.includes('*')) {
      if (globMatch(rel, pat)) return true;
    } else if (rel === pat) {
      return true;
    }
  }
  return false;
}

function isProtected(rel, protectedFiles) {
  return matchesAny(rel, protectedFiles);
}

/**
 * Build-tool side effects that must not be attributed to the agent (frameworks
 * regenerate these during build/dev/test — e.g. Next.js 16 writes AGENTS.md
 * unless `agentRules: false`). They are reverted and logged, never a breach.
 * Extend per project via `defaults.permissions.benign_paths` in fia.config.yaml.
 */
const DEFAULT_BENIGN = [
  'AGENTS.md',
  'next-env.d.ts',
  '**/*.tsbuildinfo',
  '.next/',
  '.turbo/',
  'node_modules/',
  'coverage/',
  '.eslintcache',
];

function benignPatterns(cfg) {
  return [...DEFAULT_BENIGN, ...(cfg.defaults?.permissions?.benign_paths || [])];
}

function pathAllowed(rel, agent, cfg) {
  const writes = agent.writes;
  const protectedFiles = cfg.defaults?.protected_files || [];
  if (isProtected(rel, protectedFiles)) return false;
  if (writes === null || writes === undefined) {
    return true;
  }
  if (writes.length === 0) return false;
  return writes.some((p) => globMatch(rel, p));
}

/**
 * Undo unauthorized changes: restore tracked files from HEAD, delete files the
 * agent created. Only the violating paths are rolled back — allowed work stays.
 * Files that pre-existed as UNTRACKED have no copy in git: a deleted one is
 * unrecoverable, and a modified one is left on disk (removing it would destroy
 * the user's only copy) — both are reported separately, never as "restored".
 */
export function rollback(run, paths, treeBefore = {}) {
  const restored = [];
  const unrecoverable = [];
  for (const path of paths) {
    try {
      execFileSync('git', ['checkout', 'HEAD', '--', path], {
        cwd: run.repoRoot,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      restored.push(path);
      continue;
    } catch {
      /* not in HEAD — decide below */
    }
    const preExisting = String(treeBefore[path] || '').startsWith('untracked');
    const onDisk = existsSync(resolve(run.repoRoot, path));
    if (preExisting) {
      unrecoverable.push(
        onDisk
          ? `${path} (modified — the original content was never in git)`
          : `${path} (deleted — the original content was never in git)`,
      );
      continue;
    }
    // The agent created it; remove.
    try {
      rmSync(resolve(run.repoRoot, path), { force: true, recursive: true });
      restored.push(path);
    } catch {
      unrecoverable.push(`${path} (could not be removed)`);
    }
  }
  return { restored, unrecoverable };
}

export function enforce(run, phase, agent, treeBefore) {
  const treeAfter = snapshot(run);
  const touched = changedPaths(treeBefore, treeAfter);
  const violations = [];
  const external = [];
  const protectedFiles = run.cfg.defaults?.protected_files || [];
  for (const path of touched) {
    const rel = relPath(path, run.repoRoot);
    if (pathAllowed(rel, agent, run.cfg)) continue;
    if (!isProtected(rel, protectedFiles) && matchesAny(rel, benignPatterns(run.cfg))) external.push(path);
    else violations.push(path);
  }
  if (external.length) {
    const { restored } = rollback(run, external, treeBefore);
    run.tracer?.event({
      fda_id: run.fdaId,
      phase_id: phase.phase_id || '',
      type: 'log',
      name: 'external_change',
      payload: { note: 'benign build artifacts reverted; not attributed to the agent', paths: external, restored: restored.length },
    });
    run.console?.note(`benign external changes reverted (${restored.length}/${external.length}): ${external.join(', ')}`);
  }
  if (violations.length) {
    const { restored, unrecoverable } = rollback(run, violations, treeBefore);
    throw new PermissionBreach(
      `${agent.name} modified paths outside its allowlist (rolled back: ${restored.length}/${violations.length}):\n- ${violations.join('\n- ')}` +
        (unrecoverable.length
          ? `\nNOT restorable (no copy exists in git — check these by hand):\n- ${unrecoverable.join('\n- ')}`
          : ''),
    );
  }
  return touched;
}
