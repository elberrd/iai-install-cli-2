import process from 'node:process';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { ADDON_GROUPS, ADDON_PRESETS, SERVICES, TEMPLATES } from '../config.js';
import { STACK_CATEGORIES, STACK_OPTIONS } from '../stack-catalog.js';
import { basename } from 'node:path';
import { buildCommand } from '../lib/command.js';
import { dirInfo, listDir } from '../lib/browse.js';
import { pickFolder } from '../lib/native-dialog.js';
import { buildServicePrompt } from '../lib/service-prompts.js';
import { defaultKeysPath, saveKeysFile } from '../lib/keys.js';
import { slugify } from '../lib/util.js';
import { renderPage } from '../ui/page.js';
import { openTerminal } from '../lib/open-terminal.js';
import { existsSync } from 'node:fs';
import {
  deviceLabel,
  deviceStart,
  devicePoll,
  loadAuth,
  resolveApiBase,
  saveAuth,
  verifyToken,
} from '../lib/auth-client.js';
import * as ui from '../lib/ui.js';

const DEFAULT_PORT = 4599; // unusual on purpose: away from Next/Vite/PHP/Postgres
const MAX_PORT_TRIES = 20; // 4599..4618 before giving up

/**
 * The opt-in web UI (`--ui`): a local server that serves ONE self-contained
 * HTML page where the installation is ASSEMBLED by clicking. The terminal
 * wizard is the default entry point. Execution does NOT happen on the page:
 * at the end it highlights the ready command, the student copies it and runs
 * it in their own terminal (with a button that opens the terminal for them).
 *
 * Endpoints:
 *   GET  /                  → the page
 *   GET  /api/catalog       → groups/presets/services/templates (the page renders itself)
 *   GET  /api/browse?path=… → subfolders (disk picker, fallback)
 *   GET  /api/dir-info?path=… → { exists, empty, name } (full-folder warning)
 *   POST /api/pick-folder   → opens the system's NATIVE folder dialog
 *   POST /api/keys          → writes the keys to ~/.create-iai/keys/<slug>.env (600)
 *   POST /api/command       → { …choices } → { command, argv } (to copy)
 *   GET  /api/auth          → student access status
 *   POST /api/login         → device flow (NDJSON: pending → ok/error)
 *   POST /api/open-terminal → opens the system terminal app in the right folder
 *
 * Port: DEFAULT_PORT, falling back to the next free one; override with --port.
 */
export async function runUiServer(flags = {}) {
  const catalog = buildCatalog();
  const requestedPort = normalizePort(flags.port);

  // Shared per-run state so the request handler can dedupe terminal echoes.
  const runState = { lastCommand: null, flags };
  const server = createServer((req, res) => handle(req, res, catalog, runState));

  const port = await listenWithFallback(server, requestedPort);
  const url = `http://localhost:${port}`;

  ui.intro('create-iai');
  ui.success(`Open in your browser: ${url}`);
  ui.info('Assemble the install by clicking; at the end, copy the command and run it in your terminal.');
  ui.info('Tip: `npx impactus` (without --ui) asks everything right here in the terminal.');
  openBrowser(url);

  // Keep the process alive until Ctrl+C; clean up on the way out.
  await new Promise((resolve) => {
    const shutdown = () => {
      ui.info('Shutting down the UI server…');
      server.close(() => resolve());
      // Fallback: if sockets keep it open, force-exit shortly after.
      setTimeout(() => resolve(), 500).unref();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
  ui.outro('Server stopped. See you. 👋');
}

/** Snapshot of the addon config the page needs to render itself. */
function buildCatalog() {
  return {
    // Folder where the student ran `npx impactus`: becomes the initial value
    // of the "Project folder" field on the page (project name = folder name).
    cwd: process.cwd(),
    cwdName: basename(process.cwd()) || process.cwd(),
    groups: ADDON_GROUPS.map((g) => ({
      id: g.id,
      flag: g.flag,
      title: g.title,
      single: !!g.single,
      options: g.options.map((o) => ({ value: o.value, label: o.label, hint: o.hint || '' })),
    })),
    presets: Object.keys(ADDON_PRESETS).map((value) => ({
      value,
      label: presetLabel(value),
      hint: presetHint(value),
    })),
    presetAddons: ADDON_PRESETS,
    // "Harness only" path: categories/options of the custom stack (they build
    // the selects; `onlyWhen`/`forcedBy` are functions — the 3 equivalent
    // display rules live on the client, and the terminal wizard revalidates everything).
    stack: STACK_CATEGORIES.map((c) => ({
      id: c.id,
      label: c.label,
      question: c.question,
      defaultId: c.defaultId,
      options: (STACK_OPTIONS[c.id] ?? []).map((o) => ({ id: o.id, label: o.label, hint: o.hint || '' })),
    })),
    // Integrations & keys: everything the page needs to render the cards
    // (auto/key status, fields, and the ready-made AI prompt — with the
    // {{PROJECT}} placeholder replaced on the client by the project name).
    services: SERVICES.map((s) => ({
      id: s.id,
      label: s.label,
      purpose: s.purpose || '',
      when: s.when,
      setup: s.setup,
      autoNote: s.autoNote || '',
      keyNote: s.keyNote || '',
      dashboardUrl: s.dashboardUrl || '',
      promptTemplate: buildServicePrompt(s, '{{PROJECT}}') || '',
      envs: s.envs.map((e) => ({
        key: e.key,
        label: e.label || e.key,
        secret: !!e.secret,
        source: e.source,
        default: e.default || '',
        pattern: e.pattern || '',
        patternHint: e.patternHint || '',
        hint: e.hint || '',
        autoHint: e.autoHint || '',
      })),
    })),
    // Template catalog (the page renders the "System type" cards and the
    // generated command uses --template-id when it's not the default).
    templates: Object.values(TEMPLATES).map((t) => ({
      value: t.id,
      label: t.label,
      badge: t.badge || '',
      description: t.description || t.hint || '',
      hint: t.hint || '',
      available: t.available,
    })),
  };
}

function presetLabel(value) {
  return { padrao: 'Default', minimo: 'Minimal', saas: 'SaaS' }[value] || value;
}
function presetHint(value) {
  return {
    padrao: 'quality + Sentry + security',
    minimo: 'just the Next+Convex+Clerk base',
    saas: 'default + PostHog, Resend, and Stripe',
  }[value] || '';
}

/**
 * The server listens on 127.0.0.1 only, but that isn't enough: a malicious site
 * open in the browser can attack via DNS rebinding (odd Host) — and then
 * enumerate the disk through /api/browse or plant/delete key files through
 * /api/keys. We only accept requests whose Host is local and whose Origin (when
 * present, e.g. a fetch from the page itself) is local too.
 */
function isLocalRequest(req) {
  const host = String(req.headers.host || '');
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)) return false;
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(String(origin))) return false;
  return true;
}

function handle(req, res, catalog, runState) {
  const { method } = req;
  const parsed = new URL(req.url || '/', 'http://localhost');
  const url = parsed.pathname;

  if (!isLocalRequest(req)) {
    return send(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
  }

  if (method === 'GET' && (url === '/' || url === '/index.html')) {
    return send(res, 200, 'text/html; charset=utf-8', renderPage());
  }
  if (method === 'GET' && url === '/api/catalog') {
    return sendJson(res, 200, catalog);
  }
  if (method === 'GET' && url === '/api/browse') {
    return listDir(parsed.searchParams.get('path') || undefined)
      .then((result) => sendJson(res, 200, result))
      .catch((err) => sendJson(res, 400, { error: err?.code || 'browse failed', message: String(err?.message || err) }));
  }
  if (method === 'GET' && url === '/api/dir-info') {
    return dirInfo(parsed.searchParams.get('path') || undefined)
      .then((result) => sendJson(res, 200, result))
      .catch((err) => sendJson(res, 400, { error: String(err?.message || err) }));
  }
  if (method === 'POST' && url === '/api/pick-folder') {
    // Opens the NATIVE folder picker (Finder/Explorer/zenity). The response only
    // goes out when the student chooses or cancels; {unsupported} tells the page
    // to fall back to its own modal picker.
    return readBody(req)
      .then(async (body) => {
        const { start } = safeParse(body);
        const result = await pickFolder(typeof start === 'string' && start.trim() ? start.trim() : undefined);
        sendJson(res, 200, result);
      })
      .catch((err) => sendJson(res, 400, { error: String(err?.message || err) }));
  }
  if (method === 'POST' && url === '/api/keys') {
    // Keys pasted on the page → LOCAL file in ~/.create-iai/keys/ with
    // permission 600. NONE of this leaves the machine: the generated command
    // references the path and the installer reads from it. An empty/cleared body deletes the file.
    return readBody(req)
      .then(async (body) => {
        const { name, prevName, keys } = safeParse(body);
        const path = defaultKeysPath(slugify(String(name || 'my-app')));
        // Renamed the project? Delete the previous slug's file so no orphaned
        // secrets are left behind.
        if (prevName) {
          const prevPath = defaultKeysPath(slugify(String(prevName)));
          if (prevPath !== path) await saveKeysFile(prevPath, {});
        }
        const saved = await saveKeysFile(path, keys && typeof keys === 'object' ? keys : {});
        sendJson(res, 200, { path: saved });
      })
      .catch((err) => sendJson(res, 400, { error: String(err?.message || err) }));
  }
  if (method === 'POST' && url === '/api/command') {
    return readBody(req)
      .then((body) => {
        const choices = safeParse(body);
        // The server's --api (dev/test) travels along: the copied command must
        // validate the token against the SAME backend the page used.
        const result = buildCommand(choices, { api: flagsOf(runState).api });
        // Echo to the terminal — but only when the command actually changed,
        // so keystroke-by-keystroke refreshes don't spam the console.
        if (result.command !== runState.lastCommand) {
          runState.lastCommand = result.command;
          ui.step(`Command assembled: ${result.command}`);
        }
        sendJson(res, 200, result);
      })
      .catch(() => sendJson(res, 400, { error: 'invalid request' }));
  }

  // ── Access: status and sign-in (device flow) straight from the page ────────
  if (method === 'GET' && url === '/api/auth') {
    return authStatus(flagsOf(runState))
      .then((status) => sendJson(res, 200, status))
      .catch((err) => sendJson(res, 200, { authenticated: false, error: String(err?.message || err) }));
  }
  if (method === 'POST' && url === '/api/login') {
    return streamNdjson(res, (emit) => loginFlow(flagsOf(runState), emit));
  }

  // ── Terminal: opens the system terminal app for the student to paste the command ─
  if (method === 'POST' && url === '/api/open-terminal') {
    return readBody(req)
      .then(async (body) => {
        const { dir } = safeParse(body);
        // The project folder may not exist yet (the installer creates it) — in
        // that case open where the server was started. The copied command carries
        // --dir, so the terminal's starting folder doesn't change the outcome.
        const wanted = typeof dir === 'string' ? dir.trim() : '';
        const target = wanted && existsSync(wanted) ? wanted : process.cwd();
        const result = await openTerminal(target);
        if (result.ok) ui.step('Terminal opened from the page.');
        sendJson(res, 200, result);
      })
      .catch((err) => sendJson(res, 400, { error: String(err?.message || err) }));
  }

  return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
}

/** Process flags (only --api/--port matter here). */
function flagsOf(runState) {
  return runState.flags || {};
}

/**
 * NDJSON response: one JSON line per event, unbuffered. The page reads it with
 * `response.body.getReader()`. Chosen over SSE because it works over POST and
 * needs no reconnection.
 */
function streamNdjson(res, producer) {
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  });
  const emit = (event) => {
    if (!res.writableEnded) res.write(JSON.stringify(event) + '\n');
  };
  return Promise.resolve(producer(emit))
    .catch((err) => emit({ type: 'error', message: String(err?.message || err) }))
    .finally(() => res.end());
}

/** Is there already a valid token on this machine? */
async function authStatus(flags) {
  const apiBase = resolveApiBase(flags);
  const stored = await loadAuth();
  if (!stored?.token) return { authenticated: false, apiBase };
  const v = await verifyToken(apiBase, stored.token);
  if (v.ok) return { authenticated: true, apiBase, user: v.data?.user ?? stored.user ?? null };
  return {
    authenticated: false,
    apiBase,
    // 403 = inactive subscription (a fresh sign-in won't fix it); the rest is an old token.
    reason: v.status === 403 ? 'inactive' : 'expired',
    message: v.data?.message || null,
  };
}

/**
 * The whole device flow server-side, streaming the code and link to the page.
 * The token is saved to ~/.create-iai/auth.json — the child installer reads it
 * from there, so the secret never travels to the browser.
 */
async function loginFlow(flags, emit) {
  const apiBase = resolveApiBase(flags);
  const start = await deviceStart(apiBase, deviceLabel());
  if (!start.ok || !start.data?.device_code) {
    const detail = start.data?.data || start.data?.message || `HTTP ${start.status || '?'}`;
    return emit({ type: 'error', message: `Could not start sign-in: ${detail}` });
  }
  const { device_code, user_code, verification_uri, verification_uri_complete, interval } = start.data;
  const link = verification_uri_complete || verification_uri;
  emit({ type: 'pending', url: link, code: user_code });
  ui.info(`Sign-in pending — code ${user_code}: ${link}`);

  const deadline = Date.now() + 10 * 60 * 1000;
  const wait = (interval || 5) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, wait));
    const poll = await devicePoll(apiBase, device_code);
    const token = poll.data?.access_token || poll.data?.token;
    if (token) {
      await saveAuth({ token, apiBase, user: poll.data?.user ?? null });
      ui.success('Sign-in completed via the UI.');
      return emit({ type: 'ok', user: poll.data?.user ?? null });
    }
    const err = poll.data?.error;
    // Terminal states of the device flow: stop polling right away (leaving the
    // page on "waiting" for the whole 10-minute window was the old bug).
    if (err === 'access_denied') {
      return emit({ type: 'error', message: 'Login denied — try again.' });
    }
    if (err === 'expired_token') {
      return emit({ type: 'error', message: 'Login expired — try again.' });
    }
    if (err && err !== 'authorization_pending' && err !== 'slow_down' && poll.data?.status !== 'pending') {
      return emit({ type: 'error', message: `Authorization refused (${err}).` });
    }
  }
  emit({ type: 'error', message: 'Authorization timed out. Try again.' });
}

// ── tiny http helpers ────────────────────────────────────────────────────────

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}
function sendJson(res, status, obj) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) reject(new Error('body too large')); // 1MB guard
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
function safeParse(s) {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}

// ── port binding ─────────────────────────────────────────────────────────────

function normalizePort(raw) {
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  return DEFAULT_PORT;
}

/** Try `start`, then the next ports, until one binds (or we give up). */
function listenWithFallback(server, start) {
  return new Promise((resolve, reject) => {
    let port = start;
    let tries = 0;

    const attempt = () => {
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError);
        resolve(port);
      });
    };
    const onError = (err) => {
      if (err && err.code === 'EADDRINUSE' && tries < MAX_PORT_TRIES) {
        tries++;
        port++;
        attempt();
      } else {
        reject(err);
      }
    };
    attempt();
  });
}

// ── open the browser (best-effort, cross-platform) ───────────────────────────

function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  const args = process.platform === 'win32' ? ['', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, shell: process.platform === 'win32' });
    child.on('error', () => ui.info(`Could not open the browser automatically — go to: ${url}`));
    child.unref();
  } catch {
    ui.info(`Open it manually in your browser: ${url}`);
  }
}
