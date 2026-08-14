import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

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
