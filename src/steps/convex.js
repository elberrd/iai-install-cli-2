import process from 'node:process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ENV_FILE } from '../config.js';
import { runInherit } from '../lib/proc.js';
import { getEnvVar, upsertEnvVar } from '../lib/env-file.js';
import * as ui from '../lib/ui.js';

/**
 * Phase 1 — provision the Convex project + dev deployment and write the local
 * env vars. We do NOT treat a non-zero exit as fatal: the very first push runs
 * `convex/auth.config.ts`, which references CLERK_JWT_ISSUER_DOMAIN. That var
 * isn't set on the deployment yet (Clerk runs next), so Convex errors on the
 * push — but the project + deployment were already created and .env.local was
 * written. Success is therefore detected by the presence of the Convex vars in
 * .env.local, and the functions are published later by finalizeConvex().
 */
export async function setupConvex(ctx) {
  const { dir, slug } = ctx;
  ui.note(
    [
      "Let's create your Convex project (backend + real-time database).",
      "If it's your first time, Convex will open the browser to authenticate —",
      'finish the login normally. If you have more than one team, it may ask',
      'you to choose; pick the team you want.',
      '',
      'Note: in this first step Convex will warn that CLERK_JWT_ISSUER_DOMAIN',
      'is not set yet — that is EXPECTED. We configure Clerk right after and',
      'finish publishing the functions automatically.',
    ].join('\n'),
    'Convex',
  );

  // `--configure=new` overwrites convex/tsconfig.json (convex-js #144). Back it up.
  const tsconfigPath = join(dir, 'convex', 'tsconfig.json');
  const tsconfigBackup = existsSync(tsconfigPath) ? await readFile(tsconfigPath, 'utf8') : null;

  // 1. Login (idempotent; short-circuits if already authenticated). Under
  //    --yes the interactive browser login would hang the run forever — fail
  //    fast with the exact recovery instead.
  if (ctx.flags?.yes && !convexLoggedIn()) {
    throw new Error(
      [
        'The Convex CLI is not logged in and --yes cannot open the interactive login.',
        'Log in once and run the installer again:',
        '  npx convex login',
      ].join('\n'),
    );
  }
  ui.step('Logging in to Convex…');
  await runInherit('npx', ['convex', 'login', '--device-name', 'create-iai installer'], { cwd: dir });

  // 2. Provision — or REUSE. A crashed previous run may already have created
  //    the cloud project and written the env vars: running --configure=new
  //    again would create a SECOND project in the cloud. If .env.local already
  //    points at a deployment, just reconnect and push to it.
  const envLocalPath = join(dir, ENV_FILE);
  const prevDeployment = await getEnvVar(envLocalPath, 'CONVEX_DEPLOYMENT');
  const prevUrl = await getEnvVar(envLocalPath, 'NEXT_PUBLIC_CONVEX_URL');
  if (prevDeployment && prevUrl) {
    ui.info(`Reusing the Convex deployment already in ${ENV_FILE} (${prevDeployment}) — no new cloud project is created.`);
    await runInherit('npx', ['convex', 'dev', '--once', '--tail-logs', 'disable'], { cwd: dir });
  } else {
    ui.step(`Creating the Convex project "${slug}" (cloud dev deployment)…`);
    await runInherit(
      'npx',
      ['convex', 'dev', '--once', '--configure=new', '--project', slug, '--dev-deployment', 'cloud', '--tail-logs', 'disable'],
      { cwd: dir },
    );
  }

  // Restore the template's tsconfig if the CLI clobbered it.
  if (tsconfigBackup != null) {
    const now = existsSync(tsconfigPath) ? await readFile(tsconfigPath, 'utf8') : '';
    if (now !== tsconfigBackup) await writeFile(tsconfigPath, tsconfigBackup, 'utf8');
  }

  // 3. Success is gauged by the env vars Convex writes on successful provisioning
  //    — NOT by the exit code (the first push intentionally fails, see above).
  const envLocal = envLocalPath;
  const deployment = await getEnvVar(envLocal, 'CONVEX_DEPLOYMENT');
  const cloudUrl = await getEnvVar(envLocal, 'NEXT_PUBLIC_CONVEX_URL');

  if (!deployment || !cloudUrl) {
    throw new Error(
      [
        "I couldn't provision Convex (CONVEX_DEPLOYMENT/NEXT_PUBLIC_CONVEX_URL were not written).",
        'Run manually inside the project folder and try again:',
        `  npx convex dev --once --configure=new --project ${slug} --dev-deployment cloud`,
      ].join('\n'),
    );
  }

  // 4. Derive the HTTP-actions URL (.cloud -> .site).
  const siteUrl = cloudUrl.replace('.convex.cloud', '.convex.site');
  await upsertEnvVar(envLocal, 'NEXT_PUBLIC_CONVEX_SITE_URL', siteUrl);
  ctx.convexUrl = cloudUrl;
  ctx.convexDeployment = deployment;
  ui.success(`Convex provisioned — ${cloudUrl}`);
}

/**
 * Heuristic login check, used only under --yes (interactive runs just let
 * `npx convex login` short-circuit): the CLI stores its access token in
 * ~/.convex/config.json; a CONVEX_DEPLOY_KEY in the environment also works.
 */
function convexLoggedIn() {
  if (process.env.CONVEX_DEPLOY_KEY) return true;
  try {
    return existsSync(join(homedir(), '.convex', 'config.json'));
  } catch {
    return false;
  }
}

/**
 * Phase 2 — publish the Convex functions now that Clerk has set
 * CLERK_JWT_ISSUER_DOMAIN on the deployment, so `convex/auth.config.ts`
 * validates. Uses the deployment already recorded in .env.local (no
 * --configure, so it never creates a second project).
 */
export async function finalizeConvex(ctx) {
  ui.step('Publishing the Convex functions (with authentication configured)…');
  const r = await runInherit('npx', ['convex', 'dev', '--once', '--tail-logs', 'disable'], { cwd: ctx.dir });
  if (r.ok) {
    ui.success('Convex functions published.');
  } else {
    ui.warn(
      [
        "I couldn't publish the functions right now. When you're done, run in the project folder:",
        '  npx convex dev',
      ].join('\n'),
    );
  }
}
