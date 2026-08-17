import { rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENV_FILE, DEPLOY_ENV_KEYS } from '../config.js';
import { run } from '../lib/proc.js';
import { getEnvVar } from '../lib/env-file.js';
import { parseEnvFile } from './verify.js';
import { toolPending } from './preflight.js';
import * as ui from '../lib/ui.js';

/**
 * Optional final step: quick deploy to Vercel.
 *
 * "Quick" means: link (or create) the Vercel project, copy the runtime env
 * vars from .env.local into the production environment, and ship a production
 * deployment straight from the local folder (no git integration needed).
 *
 * Caveat stated to the user: this deploy points at the *dev* Convex deployment
 * and *dev* Clerk keys — perfect to show the app running on a real URL. For a
 * real production setup (prod Convex deployment + prod Clerk instance) we
 * print the exact follow-up instructions.
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
          'I can publish the app to Vercel right now (quick deploy, straight from this folder).',
          'You get a public https://…vercel.app URL in about a minute.',
          '',
          'This deploy uses the DEV Convex backend and DEV Clerk keys —',
          'perfect for a demo. The "real" production instructions come',
          'at the end.',
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

  // ── 2. Copy runtime env vars from .env.local → production ─────────────────
  // Additive on purpose: a re-run must NOT delete-and-recreate what is already
  // on Vercel (the person may have edited values in the dashboard). Only the
  // MISSING keys are added; existing ones are kept — with a heads-up when the
  // remote value differs from .env.local.
  ui.step('Sending environment variables to Vercel (production)…');
  const envLocal = join(dir, ENV_FILE);
  const existing = await fetchVercelProdEnv(dir);
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
    const add = await run('vercel', ['env', 'add', key, 'production'], { cwd: dir, input: value });
    if (add.ok) sent++;
    else if (/already exist/i.test(add.stderr + add.stdout)) kept++; // listing failed but the var is there — keep it
    else ui.warn(`Could not set ${key} on Vercel — configure it in the dashboard later.`);
  }
  ui.success(`${sent} variable(s) added on Vercel${kept ? ` (${kept} already there — kept)` : ''}.`);

  // ── 3. Production deployment ───────────────────────────────────────────────
  const deploy = await ui.spin(
    'Running the production deploy (vercel deploy --prod)…',
    () => run('vercel', ['deploy', '--prod', '--yes'], { cwd: dir }),
    'Deploy sent.',
  );
  if (deploy.ok) {
    const url = deploy.stdout.trim().split('\n').pop();
    ctx.deployUrl = url || null;
    ui.success(`App is live: ${url}`);
    ui.note(prodChecklist(fiaPlanned), 'For real production (when the time comes)');
  } else {
    ui.warn(
      [
        'The deploy failed. Detail:',
        `  ${(deploy.stderr || deploy.stdout).trim().split('\n').slice(-3).join('\n  ')}`,
        '',
        'Try it manually in the project folder:  vercel deploy --prod',
      ].join('\n'),
    );
  }
}

/**
 * Existing production env vars on Vercel, as { KEY: value | undefined }.
 * `env pull` gives names AND values (so divergence can be reported); if it
 * fails (older CLI, permissions), fall back to `env ls` for names only.
 * Returns null when neither works — the caller then just tries to add.
 */
async function fetchVercelProdEnv(dir) {
  const tmpFile = join(tmpdir(), `impactus-vercel-env-${Date.now()}-${Math.random().toString(36).slice(2)}.env`);
  try {
    const pull = await run(
      'vercel',
      ['env', 'pull', tmpFile, '--environment', 'production', '--yes'],
      { cwd: dir, sensitiveOutput: true },
    );
    if (pull.ok) return parseEnvFile(await readFile(tmpFile, 'utf8'));
  } catch {
    /* fall through to ls */
  } finally {
    await rm(tmpFile, { force: true }).catch(() => {});
  }
  const ls = await run('vercel', ['env', 'ls', 'production'], { cwd: dir });
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
          'When you want to publish, the guided path is `/launch` (inside `pi`):',
          'it checks readiness and security and climbs rung by rung (beta → production).',
          '',
          'Or manually, in the project folder:',
        ]
      : ['When you want to publish, run in the project folder:']),
    `  vercel link --yes --project ${slug}`,
    '  vercel env add CONVEX_DEPLOY_KEY production        # Production key from the Convex dashboard',
    '  vercel env add NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY production   # plus the other vars from .env.local',
    '  vercel deploy --prod',
  ].join('\n');
}

function prodChecklist(fiaPlanned) {
  if (!fiaPlanned) {
    return [
      'The quick deploy uses the DEV Clerk instance. For real production you',
      'will need: the production Convex deployment (CONVEX_DEPLOY_KEY from the',
      'Convex dashboard), the prod Clerk instance (pk_live_ keys) and your own',
      'domain — all set via `vercel env` and the dashboards.',
    ].join('\n');
  }
  return [
    'The quick deploy uses the DEV Clerk instance. For real production, run',
    '`/launch` inside `pi`: it walks you through the security checklist, the',
    'production Convex deployment (CONVEX_DEPLOY_KEY), the prod Clerk instance',
    '(pk_live_) and your own domain — one rung at a time, logging everything in ai-docs/launch.md.',
    '',
    'Readiness at any time (read-only): npm run launch:check',
  ].join('\n');
}
