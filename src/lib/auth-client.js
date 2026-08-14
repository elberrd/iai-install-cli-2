// Device flow client (RFC 8628) against the community + token storage.
//
// The CLI token lives in ~/.create-iai/auth.json (permission 600) and is never
// exposed in the command/history. All calls are best-effort with a timeout;
// none of them throw — they return result objects for the auth step to decide.

import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, hostname, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { COMMUNITY, AUTH_FILE, STATE_DIR } from '../config.js';

function authPath() {
  return join(homedir(), STATE_DIR, AUTH_FILE);
}

let warnedCustomApiBase = false;

/**
 * Community API base: --api > env > config default. Warns once (per process)
 * when a custom base is in use — the saved CLI token is sent to that host, so
 * the student should know they left the official API.
 */
export function resolveApiBase(flags = {}) {
  const raw = flags.api || process.env.CREATE_IAI_API || COMMUNITY.apiBase;
  const base = String(raw).replace(/\/+$/, '');
  if (base !== COMMUNITY.apiBase && !warnedCustomApiBase) {
    warnedCustomApiBase = true;
    console.error(
      `! Using a custom community API (${base}) — your CLI token will be sent to this host.\n` +
        '  If you did not mean to, remove the --api flag (or unset CREATE_IAI_API) and run again.',
    );
  }
  return base;
}

/** Device label shown in the student's token list. */
export function deviceLabel() {
  return `${hostname()} (${platform()})`;
}

// ── Token storage ────────────────────────────────────────────────────────────

export async function loadAuth() {
  const path = authPath();
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    if (!data || typeof data.token !== 'string') return null;
    return data; // { token, expiresAt?, apiBase?, user? }
  } catch {
    return null;
  }
}

export async function saveAuth(data) {
  const path = authPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

export async function clearAuth() {
  if (existsSync(authPath())) await rm(authPath(), { force: true });
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

async function postJson(url, body, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

// ── Endpoints ────────────────────────────────────────────────────────────────

export function deviceStart(apiBase, label) {
  return postJson(`${apiBase}/api/cli/device/start`, { label });
}

export function devicePoll(apiBase, deviceCode) {
  return postJson(`${apiBase}/api/cli/device/poll`, { device_code: deviceCode });
}

/** Validates the token and re-checks the enrollment. Returns { ok, status, data }. */
export async function verifyToken(apiBase, token, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${apiBase}/api/cli/verify`, {
      headers: { authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

export async function revokeToken(apiBase, token, timeoutMs = 10000) {
  try {
    await fetch(`${apiBase}/api/cli/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Downloads the private (gated) template tarball. Writes to `destPath`.
 * Capped at 2 minutes so a frozen connection never hangs the install forever;
 * on timeout the reason is `download_timeout`, and any other network failure
 * (DNS, refused, offline) is `network_error` — never a raw throw
 * (template-fetch.js turns both into plain-language messages with the
 * recovery step).
 * @returns {Promise<{ok:boolean, status:number, reason?:string}>}
 */
export async function downloadTemplate(apiBase, token, name, destPath, ref, timeoutMs = 120000) {
  const qs = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const signal = AbortSignal.timeout(timeoutMs); // also aborts the body read
  try {
    const res = await fetch(`${apiBase}/api/cli/template/${encodeURIComponent(name)}${qs}`, {
      headers: { authorization: `Bearer ${token}` },
      signal,
    });
    if (!res.ok) {
      let reason = `http_${res.status}`;
      try {
        const j = await res.json();
        if (j?.reason) reason = j.reason;
      } catch {
        /* non-JSON body */
      }
      return { ok: false, status: res.status, reason };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(destPath, buf);
    return { ok: true, status: res.status };
  } catch {
    if (signal.aborted) return { ok: false, status: 0, reason: 'download_timeout' };
    // DNS failure, connection refused, network down… — the contract here is
    // that download calls never throw; template-fetch.js turns this reason
    // into a plain-language message with the recovery step.
    return { ok: false, status: 0, reason: 'network_error' };
  }
}
