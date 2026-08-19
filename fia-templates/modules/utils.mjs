import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function newId(length = 8) {
  return randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

export function nowIso() {
  return new Date().toISOString();
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

export function resolvePrompt(arg) {
  try {
    const p = resolve(arg);
    if (existsSync(p)) return readFileSync(p, 'utf8');
  } catch {
    /* inline text */
  }
  return arg;
}

export function engineerName() {
  const fromEnv = process.env.ENGINEER_NAME?.trim();
  if (fromEnv) return fromEnv;
  try {
    const out = execFileSync('git', ['config', 'user.name'], { encoding: 'utf8', timeout: 5000 }).trim();
    if (out) return out;
  } catch {
    /* ignore */
  }
  return process.env.USER || process.env.USERNAME || 'engineer';
}

export function operatorEnv() {
  return { ...process.env };
}

/**
 * Was this module the process entry point (`node <this file>`)?
 *
 * `import.meta.url` is the RESOLVED path — Node follows symlinks when it loads
 * a module — while `process.argv[1]` is whatever the caller typed. Comparing
 * the two directly makes a script silently do nothing (exit 0, no output)
 * whenever the project lives under a symlinked directory: `/tmp` on macOS,
 * a symlinked work folder, `/home` → `/usr/home` on some systems. Silence is
 * the worst failure mode a self-test can have, so both sides are realpath'd
 * here, with the plain resolve as a fallback for a path that no longer exists.
 */
export function isMainModule(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry || !importMetaUrl) return false;
  try {
    return importMetaUrl === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return importMetaUrl === pathToFileURL(resolve(entry)).href;
  }
}

/**
 * `defaults.data_dir` from the student's roster, resolved against `root`.
 *
 * Read with a narrow regex rather than a YAML parser ON PURPOSE: the callers
 * are the dependency-free CLIs (`imp stop`, `npm run holdout`, the gate
 * self-test), which must keep working in a project whose imp/node_modules was
 * never installed — that is exactly the state those commands exist to
 * diagnose. Anything unexpected degrades to the shipped default, and the
 * runtime readers cross-check the canonical path anyway.
 */
export function dataDirOf(root, configPath = 'imp/fia.config.yaml') {
  try {
    const raw = readFileSync(resolve(root, configPath), 'utf8');
    // Only a real key: a commented `# data_dir:` line never matches, because
    // the `#` sits where the `d` would have to be.
    const m = /^[ \t]*data_dir:[ \t]*(.+?)[ \t]*(?:#.*)?$/m.exec(raw);
    const declared = m?.[1]?.replace(/^['"]|['"]$/g, '').trim();
    if (declared) return resolve(root, declared);
  } catch {
    /* no roster, or unreadable — the shipped default below is correct anyway */
  }
  return resolve(root, 'imp', 'data');
}
