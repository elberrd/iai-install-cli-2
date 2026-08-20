import { rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENV_FILE, DEPLOY_ENV_KEYS } from '../config.js';
import { run } from '../lib/proc.js';
import { getEnvVar } from '../lib/env-file.js';
import { parseEnvFile } from './verify.js';
import { toolPending } from './preflight.js';
import { validateClerkKeyPair } from '../lib/clerk.js';
import * as ui from '../lib/ui.js';

export const QUICK_DEPLOY_TARGET = 'preview';
export const QUICK_DEPLOY_ARGS = ['deploy', '--yes'];

/**
 * Optional final step: quick deploy to Vercel.
 *
 * "Quick" means: link (or create) the Vercel project, copy the runtime env
 * vars from .env.local into Vercel Preview, and ship a preview deployment
 * straight from the local folder (no git integration needed).
 *
 * Production is deliberately excluded: dev Convex and pk_test_/sk_test_ keys
 * must never be copied to Vercel Production. `/launch` owns that promotion.
 *
 * Flags: --deploy / --no-deploy / --skip-deploy; --yes skips (deploy is opt-in).
 */
export async function setupDeploy(ctx) {
  const { dir, slug, flags } = ctx;

  // FIA runs AFTER this step, so use the decision (not ctx.fiaInstalled) to
  // know whether "/launch inside pi" will actually exist for this person.
  const fiaPlanned =
    ctx.fiaSkipped !== true &&
    flags?.skipFia !== true &&
    flags?.fia !== false &&
    ctx.decisions?.fia !== false;

  // The Vercel CLI (or its login) was skipped in the preflight: no deploy now
  // — the pending list and the note below carry the manual route.
  if (toolPending(ctx, 'vercel') || toolPending(ctx, 'vercel-auth')) {
    ui.info('The Vercel CLI (or its login) was skipped in the preflight — skipping the deploy.');
    ui.note(howToLater(slug, fiaPlanned), 'How to deploy later');
    return;
  }

  // The decision came from the decisions phase; the confirm below is just a
  // fallback for calls outside the standard pipeline.
  let wants = ctx.decisions?.deploy ?? flags.deploy;
  if (flags.skipDeploy) wants = false;
  if (wants == null) {
    if (flags.yes) {
      wants = false;
    } else {
      ui.note(
        [
          'I can publish a Vercel Preview right now, straight from this folder.',
          'You get a public https://…vercel.app URL in about a minute.',
          '',
          'This Preview uses the DEV Convex backend and DEV Clerk keys.',
          'Production stays isolated and is promoted later through /launch.',
        ].join('\n'),
        'Deploy to Vercel (optional)',
      );
      wants = await ui.confirm({ message: 'Deploy to Vercel now?', initialValue: false });
    }
  }
  if (!wants) {
    ui.note(howToLater(slug, fiaPlanned), 'How to deploy later');
    return;
  }

  // ── 1. Link (creates the project on Vercel when it doesn't exist) ──────────
  ui.step(`Linking project "${slug}" on Vercel…`);
  const link = await run('vercel', ['link', '--yes', '--project', slug], { cwd: dir });
  if (!link.ok) {
    ui.warn(
      [
        'Could not link the project on Vercel. Detail:',
        `  ${(link.stderr || link.stdout).trim().split('\n')[0]}`,
        '',
        ...howToLater(slug, fiaPlanned).split('\n'),
      ].join('\n'),
    );
    return;
  }
  ui.success('Project linked.');

  // ── 2. Copy runtime env vars from .env.local → Preview ────────────────────
  // Additive on purpose: a re-run must NOT delete-and-recreate what is already
  // on Vercel (the person may have edited values in the dashboard). Only the
  // MISSING keys are added; existing ones are kept — with a heads-up when the
  // remote value differs from .env.local.
  // Fail closed on the KEYS (nothing is sent to Vercel), but never abort the
  // install over this optional step — degrade like every other branch here.
  const clerkKeys = await previewClerkKeys(join(dir, ENV_FILE));
  if (!clerkKeys.ok) {
    ui.warn(`Skipping the quick deploy: ${clerkKeys.reason}`);
    ui.note(howToLater(slug, fiaPlanned), 'How to deploy later');
    return;
  }

  ui.step('Sending development environment variables to Vercel Preview…');
  const envLocal = join(dir, ENV_FILE);
  const existing = await fetchVercelPreviewEnv(dir);
  let sent = 0;
  let kept = 0;
  for (const key of DEPLOY_ENV_KEYS) {
    const value = await getEnvVar(envLocal, key);
    if (!value) continue;
    if (existing && key in existing) {
      kept++;
      if (existing[key] !== undefined && existing[key] !== value) {
        ui.info(`${key}: kept the value already on Vercel (it differs from ${ENV_FILE} — change it in the dashboard if that is not intended).`);
      }
      continue;
    }
    const add = await run('vercel', ['env', 'add', key, QUICK_DEPLOY_TARGET], { cwd: dir, input: value });
    if (add.ok) sent++;
    else if (/already exist/i.test(add.stderr + add.stdout)) kept++; // listing failed but the var is there — keep it
    else ui.warn(`Could not set ${key} on Vercel — configure it in the dashboard later.`);
  }
  ui.success(`${sent} variable(s) added on Vercel${kept ? ` (${kept} already there — kept)` : ''}.`);

  // ── 3. Preview deployment ──────────────────────────────────────────────────
  const deploy = await ui.spin(
    'Running the Preview deploy (vercel deploy --yes)…',
    () => run('vercel', QUICK_DEPLOY_ARGS, { cwd: dir }),
    'Deploy sent.',
  );
  if (deploy.ok) {
    const url = deploy.stdout.trim().split('\n').pop();
    ctx.deployUrl = url || null;
    ui.success(`App is live: ${url}`);
    ui.note(prodChecklist(fiaPlanned), 'Promote to production later');
  } else {
    ui.warn(
      [
        'The deploy failed. Detail:',
        `  ${(deploy.stderr || deploy.stdout).trim().split('\n').slice(-3).join('\n  ')}`,
        '',
        'Try it manually in the project folder:  vercel deploy --yes',
      ].join('\n'),
    );
  }
}

/**
 * Existing Preview env vars on Vercel, as { KEY: value | undefined }.
 * `env pull` gives names AND values (so divergence can be reported); if it
 * fails (older CLI, permissions), fall back to `env ls` for names only.
 * Returns null when neither works — the caller then just tries to add.
 */
export async function fetchVercelPreviewEnv(dir) {
  const tmpFile = join(tmpdir(), `impactus-vercel-env-${Date.now()}-${Math.random().toString(36).slice(2)}.env`);
  try {
    const pull = await run(
      'vercel',
      ['env', 'pull', tmpFile, '--environment', QUICK_DEPLOY_TARGET, '--yes'],
      { cwd: dir, sensitiveOutput: true },
    );
    if (pull.ok) return parseEnvFile(await readFile(tmpFile, 'utf8'));
  } catch {
    /* fall through to ls */
  } finally {
    await rm(tmpFile, { force: true }).catch(() => {});
  }
  const ls = await run('vercel', ['env', 'ls', QUICK_DEPLOY_TARGET], { cwd: dir });
  if (!ls.ok) return null;
  const out = {};
  for (const key of DEPLOY_ENV_KEYS) {
    if (new RegExp(`(^|\\s)${key}(\\s|$)`).test(ls.stdout)) out[key] = undefined;
  }
  return out;
}

function howToLater(slug, fiaPlanned) {
  return [
    ...(fiaPlanned
      ? [
          'For a Preview, run now; for production use `/launch` inside `pi`.',
          'It validates live Clerk keys, production Convex and domain readiness.',
          '',
          'Or manually, in the project folder:',
        ]
      : ['For a Preview, run in the project folder:']),
    `  vercel link --yes --project ${slug}`,
    // The manual route must mirror the automated one: every runtime key the
    // quick deploy would copy (routing URLs included), not just the big three.
    ...DEPLOY_ENV_KEYS.map((key) => `  vercel env add ${key} preview`),
    '  vercel deploy --yes',
    '',
    'Do not copy those dev values to Production. Use `/launch` for pk_live_/sk_live_.',
  ].join('\n');
}

function prodChecklist(fiaPlanned) {
  if (!fiaPlanned) {
    return [
      'This URL is a Preview backed by development Clerk and Convex.',
      'Production requires production Convex, Clerk pk_live_/sk_live_, a',
      'production webhook signing secret and the final domain.',
    ].join('\n');
  }
  return [
    'This quick deploy is Preview-only. For production, run',
    '`/launch` inside `pi`: it walks you through the security checklist, the',
    'production Convex deployment (CONVEX_DEPLOY_KEY), the prod Clerk instance',
    '(pk_live_) and your own domain — one rung at a time, logging everything in ai-docs/launch.md.',
    '',
    'Readiness at any time (read-only): npm run launch:check',
  ].join('\n');
}

/** Fail closed if the quick deploy is not using a matching dev Clerk key pair. */
export async function previewClerkKeys(envPath) {
  const pk = await getEnvVar(envPath, 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY');
  const sk = await getEnvVar(envPath, 'CLERK_SECRET_KEY');
  const pair = validateClerkKeyPair(pk, sk);
  if (!pair.ok) return pair;
  if (pair.environment !== 'test') {
    return {
      ok: false,
      environment: pair.environment,
      reason: 'Quick deploy is Preview-only and requires pk_test_/sk_test_. Use /launch for production keys.',
    };
  }
  return pair;
}
