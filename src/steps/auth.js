// Access gate: runs BEFORE everything else, but signing in is OPTIONAL.
// Signed in (active subscription) → the FULL installer: templates + the whole
// automated template pipeline. Not signed in ("guest mode", ctx.guest) → the
// CLI still installs the harness + FIA (the server hands the harness tarball
// out without a token), but NOTHING from the templates — steps/mode.js blocks
// every template path. Login uses the device flow (RFC 8628): opens the
// browser at the community, the student approves (the server checks the
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
 * Resolves access. Three outcomes:
 *   - authenticated: ctx.authToken/ctx.communityUser set → full installer;
 *   - guest: ctx.guest = true, no token → harness + FIA only (steps/mode.js
 *     blocks every template path);
 *   - exit: community unreachable, or an explicit CI token that is invalid.
 * A valid saved session skips every question ("Welcome back"); everyone else
 * gets the sign-in offer RIGHT AT THE START, with the limitation of skipping
 * it announced on the spot.
 */
export async function ensureAuthenticated(ctx) {
  const { flags = {} } = ctx;
  const apiBase = resolveApiBase(flags);
  ctx.apiBase = apiBase;

  // CI / automation: token via env (non-interactive). An explicit token that
  // does not work fails LOUDLY — automation must never silently degrade to a
  // harness-only install.
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

  // Token saved from a previous login: valid → straight through, no questions.
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
    if (verdict === 'unavailable') unavailableAndExit(v);
    if (verdict === 'inactive') {
      // A fresh login with the SAME account won't fix this — keep the token
      // (a renewal makes it valid again) and offer the limited path below.
      ui.warn(
        `Your ${COMMUNITY.name} subscription is no longer active — templates and the automated pipeline are locked until you renew (${COMMUNITY.checkoutUrl}).`,
      );
    } else {
      // Expired/revoked token (401 and the like) → clear it; the offer below
      // includes a fresh login.
      ui.info('Your CLI session expired — sign in again to unlock everything.');
      await clearAuth();
    }
  }

  // --login subcommand: always the device flow (no "optional" question).
  if (flags.login) return deviceLogin(ctx, apiBase);

  // --yes has no prompts: continue as guest. Full installs in automation use
  // CREATE_IAI_TOKEN; flags that force the template error out in steps/mode.js.
  if (flags.yes) {
    ui.warn(
      'No active login and --yes is non-interactive — continuing WITHOUT sign-in (harness + agent only). ' +
        'For the full install set CREATE_IAI_TOKEN, or run once without --yes to sign in.',
    );
    return enterGuestMode(ctx);
  }

  // The optional sign-in — the first real question of the installer.
  if (!(await promptSignIn())) return enterGuestMode(ctx);
  await deviceLogin(ctx, apiBase, { guestOnDeny: true });
}

/** The sign-in offer: what it unlocks, what skipping it costs. */
async function promptSignIn() {
  ui.note(
    [
      `Signing in as a ${COMMUNITY.name} student (active subscription) unlocks the`,
      'FULL installer: the ready-made templates (Next.js + Convex + Clerk) and the',
      'automated template pipeline (cloud provisioning, keys, GitHub, deploy).',
      '',
      'Without signing in you can still install the agent HARNESS + the FIA',
      'agents — but nothing from the templates, and none of their automation.',
    ].join('\n'),
    'Sign in (optional)',
  );
  const choice = await ui.select({
    message: 'Sign in to the community now?',
    initialValue: 'signin',
    options: [
      {
        value: 'signin',
        label: 'Sign in (recommended)',
        hint: 'opens the browser once — unlocks templates + full automation',
      },
      {
        value: 'guest',
        label: 'Continue without signing in',
        hint: 'harness + agent only — nothing from the templates',
      },
    ],
  });
  return choice === 'signin';
}

/** Continue without a token: announce the limitation once, visibly. */
function enterGuestMode(ctx) {
  ctx.guest = true;
  ui.note(
    [
      'You are NOT signed in, so this run installs ONLY:',
      '  • the agent harness (/start, /dev, /sv, …);',
      '  • the FIA — Pi + the automated dev agents.',
      '',
      'Everything template-related stays OFF: the ready-made templates and their',
      'automation (Convex/Clerk provisioning, keys, webhooks, GitHub, deploy).',
      '',
      `Full access is for ${COMMUNITY.name} students: ${COMMUNITY.checkoutUrl}`,
      'Already a student? Sign in any time: npx impactus --login',
    ].join('\n'),
    'Limited mode — harness + agent only',
  );
}

// ── Device flow ──────────────────────────────────────────────────────────────

async function deviceLogin(ctx, apiBase, { guestOnDeny = false } = {}) {
  ui.note(
    [
      `The full installer is exclusive to ${COMMUNITY.name} students with an active subscription.`,
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
    // During an install the denial must not kill the run — the harness + FIA
    // still work without access. `--login` (no install to continue) still exits.
    if (guestOnDeny) {
      accessNote('Authorization denied.');
      return enterGuestMode(ctx);
    }
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
    ui.info('You are not authenticated. Run `npx impactus --login` to sign in.');
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

function accessNote(headline) {
  ui.note(
    [
      headline,
      '',
      `The full installer (templates + automation) is exclusive to ${COMMUNITY.name}`,
      'students with an active subscription.',
      `Activate or renew your access: ${COMMUNITY.checkoutUrl}`,
    ].join('\n'),
    'Access required',
  );
}

function denyAndExit(v, headline) {
  accessNote(headline);
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
