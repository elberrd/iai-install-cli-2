import { join } from 'node:path';
import { ENV_FILE, CLERK_WEBHOOK } from '../config.js';
import { run } from '../lib/proc.js';
import { redactSecret } from '../lib/log.js';
import { upsertEnvVar } from '../lib/env-file.js';
import { resolveClerk } from './clerk.js';
import * as ui from '../lib/ui.js';

/** Extract the Svix dashboard URL from `clerk api /webhooks/svix*` output. */
function extractSvixUrl(stdout) {
  try {
    const obj = JSON.parse(stdout);
    if (obj && typeof obj.svix_url === 'string') return obj.svix_url;
  } catch {
    /* fall through */
  }
  const m = /https?:\/\/[^\s"']+/.exec(stdout || '');
  return m ? m[0] : null;
}

export function isValidWebhookSecret(value) {
  // Svix signing secrets are "whsec_" + STANDARD base64 (may contain +, / and =).
  return /^whsec_[A-Za-z0-9+/=_-]{16,}$/.test(String(value || '').trim());
}

/**
 * Optional step: help wire the Clerk → Convex user-sync webhook. The endpoint
 * URL and signing secret cannot be created via the Clerk API (dashboard-only),
 * so this generates the Svix dashboard link, tells the user exactly what to
 * paste, then captures the secret and sets it on the Convex deployment. Fully
 * skippable.
 */
export async function setupWebhook(ctx) {
  const { dir, convexUrl, clerkApp, flags = {} } = ctx;
  const siteUrl = convexUrl ? convexUrl.replace('.convex.cloud', '.convex.site') : null;
  const endpoint = siteUrl ? `${siteUrl}${CLERK_WEBHOOK.route}` : null;
  // The SAME events in both templates: only user.* — in live2 organizations
  // belong to the app (Convex), no organization.* in the webhook.
  const events = CLERK_WEBHOOK.events;

  // The webhook needs manual dashboard steps, so non-interactive runs skip it.
  if (flags.skipWebhook || flags.yes) {
    ui.info('Clerk → Convex webhook skipped.');
    ui.note(howToLater(endpoint, events), 'How to set it up later');
    return;
  }

  // The decision came from the decisions phase; the confirm below is just a
  // fallback for calls outside the standard pipeline.
  let go = ctx.decisions?.webhook;
  if (go == null) {
    ui.note(
      [
        'The app creates/updates the signed-in user on first load even without',
        'a webhook. This optional endpoint keeps external profile changes in',
        'sync and removes users deleted in Clerk.',
        '',
        'The endpoint and signing secret are created in Clerk/Svix, so this',
        'step is semi-automatic and can be completed later.',
      ].join('\n'),
      'Clerk → Convex webhook (optional)',
    );
    go = await ui.confirm({
      message: 'Set up the webhook now? (No = skip and set up later)',
      initialValue: false,
    });
  }

  if (!go) {
    ui.note(howToLater(endpoint, events), 'How to set it up later');
    return;
  }

  if (!endpoint) {
    ui.warn("Without the Convex URL I can't build the endpoint. Set it up later (see the README).");
    return;
  }

  // Best-effort: mint the Svix dashboard URL to save the user a few clicks.
  let svixUrl = null;
  try {
    const clerk = await resolveClerk();
    const appArgs = clerkApp ? ['--app', clerkApp] : [];
    let r = await clerk(['api', '/webhooks/svix_url', ...appArgs, '-X', 'POST', '--yes'], { agent: true });
    if (r.ok) svixUrl = extractSvixUrl(r.stdout);
    if (!svixUrl) {
      // The Svix app may not exist yet; creating it also returns the URL.
      r = await clerk(['api', '/webhooks/svix', ...appArgs, '-X', 'POST', '--yes'], { agent: true });
      if (r.ok) svixUrl = extractSvixUrl(r.stdout);
    }
  } catch {
    /* non-fatal — fall back to dashboard instructions */
  }

  ui.note(
    [
      '1) Open the webhooks dashboard:',
      `   ${svixUrl || 'Clerk Dashboard → Configure → Webhooks → Add Endpoint'}`,
      '',
      '2) Endpoint URL (paste exactly):',
      `   ${endpoint}`,
      '',
      `3) Subscribe to the events: ${events.join(', ')}`,
      '',
      '4) Create and copy the Signing Secret (whsec_…).',
    ].join('\n'),
    'Create the endpoint in the dashboard',
  );

  const secret = String(
    await ui.password({
      message: 'Paste the Signing Secret (whsec_…) — empty to skip:',
      validate: (v) =>
        !v || isValidWebhookSecret(v)
          ? undefined
          : 'Invalid signing secret. It must be the complete whsec_ value from Clerk.',
    }),
  ).trim();

  if (!secret) {
    ui.note(howToLater(endpoint, events), 'Skipped — set it up later');
    return;
  }

  redactSecret(secret); // never in the execution log
  // Document the value locally either way (gitignored): if the Convex set
  // fails, .env.local is where the full secret survives — the terminal only
  // ever shows a masked prefix (never the whole secret in clear text).
  // Both names are set on purpose: current templates read the canonical
  // CLERK_WEBHOOK_SIGNING_SECRET (with a legacy fallback), but projects
  // generated from older template versions read only CLERK_WEBHOOK_SECRET —
  // the dual write keeps every vintage working.
  await upsertEnvVar(join(dir, ENV_FILE), CLERK_WEBHOOK.secretEnv, secret);
  await upsertEnvVar(join(dir, ENV_FILE), CLERK_WEBHOOK.legacySecretEnv, secret);
  const set = await run('npx', ['convex', 'env', 'set', CLERK_WEBHOOK.secretEnv, secret], { cwd: dir });
  const setLegacy = await run('npx', ['convex', 'env', 'set', CLERK_WEBHOOK.legacySecretEnv, secret], { cwd: dir });
  if (set.ok && setLegacy.ok) {
    ui.success('Clerk → Convex webhook configured.');
    ctx.webhook = true;
  } else {
    const masked = `${secret.slice(0, 8)}…`;
    ui.warn(
      [
        `I couldn't set the signing secret (${masked}) in Convex.`,
        `The full value is saved in ${ENV_FILE}. Run in the project folder:`,
        `  npx convex env set ${CLERK_WEBHOOK.secretEnv} <the ${CLERK_WEBHOOK.secretEnv} value from ${ENV_FILE}>`,
        `  npx convex env set ${CLERK_WEBHOOK.legacySecretEnv} <same value>`,
      ].join('\n'),
    );
  }
}

function howToLater(endpoint, events = CLERK_WEBHOOK.events) {
  return [
    'First authenticated load already syncs the active user. To also receive',
    'external profile updates and deletions:',
    '',
    '1) Clerk Dashboard → Configure → Webhooks → Add Endpoint',
    `2) URL: ${endpoint || 'https://<your-deployment>.convex.site' + CLERK_WEBHOOK.route}`,
    `3) Events: ${events.join(', ')}`,
    '4) Copy the Signing Secret and run in the project folder:',
    `   npx convex env set ${CLERK_WEBHOOK.secretEnv} whsec_...`,
    `   npx convex env set ${CLERK_WEBHOOK.legacySecretEnv} whsec_...`,
    `   (${CLERK_WEBHOOK.secretEnv} is canonical; older projects read only ${CLERK_WEBHOOK.legacySecretEnv} — setting both covers every version)`,
  ].join('\n');
}
