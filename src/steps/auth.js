// Paying-student gate: runs BEFORE everything else. Without an active
// subscription in the community, the CLI installs nothing (neither the template
// nor the harness — both are private). Uses the device flow (RFC 8628): opens
// the browser at the community, the student approves (the server checks the
// enrollment) and the CLI receives a token.

import process from 'node:process';
import { spawn } from 'node:child_process';
import { COMMUNITY } from '../config.js';
import {
  clearAuth,
  deviceLabel,
  deviceStart,
  devicePoll,
  loadAuth,
  resolveApiBase,
  revokeToken,
  saveAuth,
  verifyToken,
} from '../lib/auth-client.js';
import { redactSecret } from '../lib/log.js';
import * as ui from '../lib/ui.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * How to interpret the `verifyToken` response. Pure, so it stays testable —
 * the distinction that matters is between "your token is no good" and "the
 * server is down":
 *
 *   'ok'          → proceed with the install;
 *   'inactive'    → subscription canceled/expired; a fresh login does NOT fix it;
 *   'unavailable' → 5xx or network down; the token is still good, it's the
 *                   community that's offline. NEVER delete the credential here;
 *   'expired'     → 401 and the like: token revoked/expired, log in again.
 *
 * @param {{ok?: boolean, status?: number, data?: object}} v
 * @returns {'ok'|'inactive'|'unavailable'|'expired'}
 */
export function classifyVerify(v = {}) {
  if (v.ok) return 'ok';
  if (v.status === 403 || v.data?.reason === 'no_active_enrollment') return 'inactive';
  if (!v.status || v.status >= 500) return 'unavailable';
  return 'expired';
}

/** Community is down: tell the student the problem isn't theirs and exit. */
function unavailableAndExit(v) {
  ui.error(
    [
      `I couldn't reach ${COMMUNITY.name} right now` +
        (v.status ? ` (HTTP ${v.status}).` : ' (no response).'),
      'Your login is still saved — just try again in a few minutes.',
    ].join('\n'),
  );
  process.exit(1);
}

/**
 * Ensures the user is a paying student; stores the token in ctx.authToken and
 * the API base in ctx.apiBase. Exits the CLI with a friendly message when
 * access is inactive or the login is refused.
 */
export async function ensureAuthenticated(ctx) {
  const { flags = {} } = ctx;
  const apiBase = resolveApiBase(flags);
  ctx.apiBase = apiBase;

  // CI / automation: token via env (non-interactive).
  const envToken = process.env.CREATE_IAI_TOKEN;
  if (envToken) {
    redactSecret(envToken);
    const v = await verifyToken(apiBase, envToken);
    const verdict = classifyVerify(v);
    if (verdict === 'ok') {
      accept(ctx, envToken, v.data);
      ui.info(`Access confirmed via CREATE_IAI_TOKEN (${who(v.data)}).`);
      return;
    }
    if (verdict === 'unavailable') unavailableAndExit(v);
    denyAndExit(v, 'CREATE_IAI_TOKEN is invalid or the subscription is not active.');
  }

  // Token saved from a previous login.
  const stored = await loadAuth();
  if (stored?.token) {
    redactSecret(stored.token);
    const v = await verifyToken(apiBase, stored.token);
    const verdict = classifyVerify(v);
    if (verdict === 'ok') {
      accept(ctx, stored.token, v.data);
      ui.success(`Welcome back, ${who(v.data)}. Access active ✓`);
      return;
    }
    if (verdict === 'inactive') denyAndExit(v, 'Your subscription is no longer active.');
    if (verdict === 'unavailable') unavailableAndExit(v);
    // Expired/revoked token (401 and the like) → clear it and log in again.
    ui.info('Your CLI session expired — let\'s sign in again.');
    await clearAuth();
  }

  await deviceLogin(ctx, apiBase, flags);
}

// ── Device flow ──────────────────────────────────────────────────────────────

async function deviceLogin(ctx, apiBase, flags) {
  if (flags.yes && !process.env.CREATE_IAI_TOKEN) {
    ui.error(
      'Login required: run without --yes ONCE to authenticate (opens the browser), ' +
        'or set CREATE_IAI_TOKEN for non-interactive mode.',
    );
    process.exit(1);
  }

  ui.note(
    [
      `The CLI is exclusive to ${COMMUNITY.name} students with an active subscription.`,
      "I'll open the browser so you can authorize this computer (one time only).",
    ].join('\n'),
    'Sign in to the community',
  );

  const start = await deviceStart(apiBase, deviceLabel());
  if (!start.ok || !start.data?.device_code) {
    ui.error(`I couldn't start the login (${start.status || 'no response'}). Try again in a moment.`);
    process.exit(1);
  }
  const { device_code, user_code, verification_uri, verification_uri_complete, interval } = start.data;

  ui.note(
    [
      'Confirm in the browser that the code below is the SAME:',
      '',
      `    ${user_code}`,
      '',
      `If the browser doesn't open, go to: ${verification_uri}`,
    ].join('\n'),
    'Authorize the CLI',
  );
  openBrowser(verification_uri_complete || verification_uri);

  // Polling runs inside the spinner and returns a RESULT — denial/error
  // messages are printed outside the spinner (otherwise they fight over the TTY).
  const outcome = await pollUntilDone(apiBase, device_code, interval || 5);
  if (outcome.status === 'denied') {
    denyAndExit({ status: 403, data: outcome.data }, 'Authorization denied.');
  }
  if (outcome.status === 'expired') {
    ui.error('The code expired. Run the CLI again to try once more.');
    process.exit(1);
  }
  if (outcome.status !== 'approved') {
    ui.error('Authorization timed out. Run the CLI again.');
    process.exit(1);
  }

  const token = outcome.token;
  await saveAuth({ token, apiBase, savedAt: Date.now(), label: deviceLabel() });
  redactSecret(token);
  const v = await verifyToken(apiBase, token);
  accept(ctx, token, v.data);
  ui.success(`All set, ${who(v.data)}! Access granted ✓`);
}

/** Polls until resolved. Returns { status: 'approved'|'denied'|'expired'|'timeout', token?, data? }. */
async function pollUntilDone(apiBase, deviceCode, intervalS) {
  let wait = Math.max(2, intervalS) * 1000;
  const deadline = Date.now() + 10 * 60 * 1000; // 10 min

  return ui.spin('Waiting for authorization in the browser…', async () => {
    while (Date.now() < deadline) {
      await sleep(wait);
      const r = await devicePoll(apiBase, deviceCode);
      const status = r.data?.status;
      if (status === 'approved' && r.data.access_token) {
        return { status: 'approved', token: r.data.access_token };
      }
      if (status === 'denied') return { status: 'denied', data: r.data };
      if (status === 'expired') return { status: 'expired' };
      if (status === 'slow_down') wait += 2000;
    }
    return { status: 'timeout' };
  });
}

// ── Subcommands: --logout / --whoami ─────────────────────────────────────────

export async function runLogout(flags = {}) {
  const apiBase = resolveApiBase(flags);
  const stored = await loadAuth();
  if (stored?.token) await revokeToken(apiBase, stored.token);
  await clearAuth();
  ui.success('Signed out — token removed from this computer.');
}

export async function runWhoami(flags = {}) {
  const apiBase = resolveApiBase(flags);
  const stored = await loadAuth();
  if (!stored?.token) {
    ui.info('You are not authenticated. Run `npx impactus` to sign in.');
    return;
  }
  const v = await verifyToken(apiBase, stored.token);
  if (v.ok) ui.success(`Authenticated as ${who(v.data)} — subscription active ✓`);
  else if (v.status === 403) ui.warn('Authenticated, but the subscription is NOT active.');
  else ui.warn('Your session expired. Run `npx impactus` to sign in again.');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function accept(ctx, token, data) {
  ctx.authToken = token;
  ctx.communityUser = data?.user || null;
}

function who(data) {
  return data?.user?.name || data?.user?.email || 'student';
}

function denyAndExit(v, headline) {
  ui.note(
    [
      headline,
      '',
      `The create-iai CLI is exclusive to ${COMMUNITY.name} students with an active subscription.`,
      `Activate or renew your access: ${COMMUNITY.checkoutUrl}`,
    ].join('\n'),
    'Access required',
  );
  process.exit(1);
}

function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  const args = process.platform === 'win32' ? ['', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, shell: process.platform === 'win32' });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* the user opens the shown link manually */
  }
}
