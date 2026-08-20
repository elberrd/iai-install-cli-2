import process from 'node:process';
import { join } from 'node:path';
import { ADDON_NOTES, CLERK_CLI_VERSION, CLERK_JWT_TEMPLATE, ENV_FILE } from '../config.js';
import { run, runInherit } from '../lib/proc.js';
import { redactSecret } from '../lib/log.js';
import { getEnvVar, upsertEnvVar, removeEnvVar } from '../lib/env-file.js';
import { readInstallState, updateInstallState } from './project.js';
import {
  extractAppInfo,
  findInstanceId,
  issuerFromPublishableKey,
  jwtTemplateDiff,
  looksLikeRealPk,
  looksLikeRealSk,
  matchAppsByName,
  parseAppList,
  parseJwtTemplates,
  parseWhoami,
  validateAppPublishableKey,
  validateClerkKeyPair,
} from '../lib/clerk.js';
import * as ui from '../lib/ui.js';

export async function setupClerk(ctx) {
  const { dir } = ctx;
  const envLocal = join(dir, ENV_FILE);

  ui.note(
    [
      'Authentication is provisioned with a pinned Clerk CLI release.',
      'The installer reuses a linked/exact-name app when possible, pulls',
      'development keys, reconciles the Convex JWT configuration and runs a',
      'read-only health check. Production is a separate /launch step.',
    ].join('\n'),
    'Clerk',
  );

  const clerk = await resolveClerk();
  let who = await clerk(['whoami', '--json'], { cwd: dir });
  let identity = who.ok ? parseWhoami(who.stdout) : { email: null, appId: null };
  if (!who.ok || !identity.email) {
    if (ctx.flags?.yes) {
      throw new Error(
        [
          'The Clerk CLI is not logged in and --yes cannot open the browser login.',
          'Log in once and run the installer again:',
          `  npx -y clerk@${CLERK_CLI_VERSION} auth login`,
        ].join('\n'),
      );
    }
    ui.step('Logging in to Clerk…');
    const login = await clerk(['auth', 'login'], { inherit: true, agent: false, cwd: dir });
    if (!login.ok) throw new Error('Clerk login did not complete. Run the installer again after logging in.');
    who = await clerk(['whoami', '--json'], { cwd: dir });
    identity = who.ok ? parseWhoami(who.stdout) : { email: null, appId: null };
  } else {
    ui.info('Clerk already authenticated.');
  }
  if (!who.ok || !identity.email) {
    throw new Error('Clerk authentication could not be verified with `whoami --json`.');
  }

  ctx.clerkEmail = identity.email;

  const app = await chooseClerkApp(clerk, ctx, identity.appId);
  if (!app.appId) throw new Error('The Clerk application could not be identified.');

  // A resumed install may have stopped after creating the Clerk app but before
  // finishing JWT/Billing. Preserve that ownership receipt so --yes can finish
  // our app without silently changing an arbitrary reused application.
  const installState = await readInstallState(dir);
  app.createdByInstaller = app.created || installState.clerkAppCreatedByInstaller === app.appId;
  if (app.created) {
    await updateInstallState(dir, { clerkAppCreatedByInstaller: app.appId }).catch(() => {
      ui.warn('Could not record the new Clerk app in the local recovery marker; exact-name reuse remains available.');
    });
  }

  const appStatus = app.created ? 'new' : app.createdByInstaller ? 'resumed' : 'reused';
  ui.success(`Clerk app: ${app.name || app.appId} (${appStatus})`);
  const link = await clerk(['link', '--app', app.appId], { cwd: dir });
  if (!link.ok) throw new Error(`Could not link ${app.appId} to the project: ${firstLine(link)}`);

  ui.step('Pulling development keys from Clerk…');
  const pull = await clerk(
    ['env', 'pull', '--app', app.appId, '--instance', 'dev', '--file', ENV_FILE],
    { cwd: dir },
  );
  if (!pull.ok && ctx.flags?.yes) {
    throw new Error(`Could not pull development keys for ${app.appId}: ${firstLine(pull)}`);
  }
  if (!pull.ok) ui.warn(`Automatic key pull failed (${firstLine(pull)}); manual key entry will be offered.`);

  const { pk, sk } = await resolveKeys(envLocal, app, ctx.flags);
  const pair = validateClerkKeyPair(pk, sk);
  if (!pair.ok) throw new Error(pair.reason);
  if (pair.environment !== 'test') {
    throw new Error('The normal installer only accepts Clerk development keys. Configure pk_live_/sk_live_ through /launch.');
  }
  const ownership = validateAppPublishableKey(app, pk);
  if (!ownership.ok) throw new Error(ownership.reason);
  const instance = await validateClerkInstance(clerk, app, sk, dir);
  if (!instance.ok) throw new Error(instance.reason);

  await ensureConvexJwtTemplate(clerk, app, ctx, CLERK_JWT_TEMPLATE);
  if (ctx.addons?.includes('clerk-billing')) {
    // Billing is an optional addon: per the repo hard rule it may never abort
    // the install. Any failure (CLI error, reused-app authorization declined)
    // degrades to the manual instructions.
    try {
      await ensureClerkBilling(clerk, app, ctx);
    } catch (err) {
      ui.warn(`Clerk Billing was not enabled: ${err?.message || err}`);
      ui.note(ADDON_NOTES['clerk-billing'] + '\nEnable it manually: npx -y clerk@' + CLERK_CLI_VERSION + ' enable billing --instance dev', 'Clerk Billing — manual setup');
    }
  }

  const issuer = issuerFromPublishableKey(pk);
  if (!issuer) throw new Error('Could not derive CLERK_JWT_ISSUER_DOMAIN from the selected publishable key.');
  await upsertEnvVar(envLocal, 'CLERK_JWT_ISSUER_DOMAIN', issuer);
  ui.step(`Setting CLERK_JWT_ISSUER_DOMAIN in Convex: ${issuer}`);
  const set = await run('npx', ['convex', 'env', 'set', 'CLERK_JWT_ISSUER_DOMAIN', issuer], { cwd: dir });
  if (set.ok) ui.success('Convex ⇄ Clerk connected.');
  else {
    ui.warn(`Could not set the issuer in Convex. Run:\n  npx convex env set CLERK_JWT_ISSUER_DOMAIN ${issuer}`);
  }

  ctx.issuer = issuer;
  ctx.clerkApp = app.appId;
  ctx.clerkAppCreated = app.created;
  await grantSuperAdmin(ctx, envLocal);
  await runClerkDoctor(clerk, ctx);
}

// ── App selection ───────────────────────────────────────────────────────────

export async function chooseClerkApp(clerk, ctx, linkedAppId = null) {
  const flags = ctx.flags ?? {};
  const list = await clerk(['apps', 'list', '--json']);
  if (!list.ok) throw new Error(`Could not list Clerk applications: ${firstLine(list)}`);
  const existing = parseAppList(list.stdout);

  if (flags.newClerkApp) return createClerkApp(clerk, ctx.name);

  if (flags.clerkApp) {
    const selected = existing.find((app) => app.appId === flags.clerkApp);
    if (!selected) {
      throw new Error(
        `Clerk application ${flags.clerkApp} is not accessible to this account. Check the ID or use --new-clerk-app.`,
      );
    }
    return { ...selected, created: false };
  }

  if (linkedAppId) {
    const linked = existing.find((app) => app.appId === linkedAppId);
    if (linked) return { ...linked, created: false };
  }

  const exact = matchAppsByName(existing, ctx.name);
  if (exact.length === 1) return { ...exact[0], created: false };
  if (exact.length > 1) {
    if (flags.yes) {
      throw new Error(
        `More than one Clerk app is named "${ctx.name}". Re-run with --clerk-app <app_id> to choose one.`,
      );
    }
    const picked = await ui.select({
      message: `More than one Clerk app is named "${ctx.name}". Pick one:`,
      options: exact.map((app) => ({ value: app.appId, label: `${app.name} (${app.appId})` })),
    });
    return { ...exact.find((app) => app.appId === picked), created: false };
  }

  if (!flags.yes && existing.length > 0) {
    const picked = await ui.select({
      message: 'Choose a Clerk application:',
      initialValue: '__new__',
      options: [
        { value: '__new__', label: `Create "${ctx.name}"`, hint: 'recommended for a new project' },
        ...existing.map((app) => ({ value: app.appId, label: app.name || app.appId, hint: app.appId })),
      ],
    });
    if (picked !== '__new__') return { ...existing.find((app) => app.appId === picked), created: false };
  }

  return createClerkApp(clerk, ctx.name);
}

async function createClerkApp(clerk, name) {
  const created = await clerk(['apps', 'create', name, '--json']);
  if (!created.ok) throw new Error(`Could not create Clerk application "${name}": ${firstLine(created)}`);
  try {
    const info = extractAppInfo(JSON.parse(created.stdout));
    if (info.appId) return { ...info, created: true };
  } catch {
    // The exact-name relist below provides a safe structured fallback.
  }
  const relist = await clerk(['apps', 'list', '--json']);
  const matches = relist.ok ? matchAppsByName(parseAppList(relist.stdout), name) : [];
  if (matches.length === 1) return { ...matches[0], created: true };
  throw new Error(`Clerk created "${name}", but its application ID could not be determined safely.`);
}

// ── Keys ────────────────────────────────────────────────────────────────────

export async function resolveKeys(envLocal, app, flags = {}) {
  let pk =
    (looksLikeRealPk(app.pk) && app.pk) ||
    (await getEnvVar(envLocal, 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY')) ||
    (await getEnvVar(envLocal, 'CLERK_PUBLISHABLE_KEY'));

  if (!looksLikeRealPk(pk) && flags.yes) {
    throw new Error('Could not get the Clerk publishable key in --yes mode. Re-run without --yes.');
  }
  if (!looksLikeRealPk(pk)) {
    ui.note(
      [
        'Open Clerk Dashboard → your application → API Keys.',
        'Copy the development Publishable key (pk_test_…) and Secret key (sk_test_…).',
        'Production keys belong in the separate /launch flow.',
      ].join('\n'),
      'Clerk development keys',
    );
    pk = String(
      await ui.text({
        message: 'Paste the Clerk development Publishable Key (pk_test_…):',
        validate: (value) => (looksLikeRealPk(value) ? undefined : 'Invalid publishable key.'),
      }),
    ).trim();
  }
  await upsertEnvVar(envLocal, 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', pk);
  await removeEnvVar(envLocal, 'CLERK_PUBLISHABLE_KEY');

  let sk = await getEnvVar(envLocal, 'CLERK_SECRET_KEY');
  if (sk) redactSecret(sk);
  if (!looksLikeRealSk(sk) && flags.yes) {
    throw new Error('Could not get the Clerk secret key in --yes mode. Re-run without --yes.');
  }
  if (!looksLikeRealSk(sk)) {
    sk = String(
      await ui.password({
        message: 'Paste the Clerk development Secret Key (sk_test_…):',
        validate: (value) => (looksLikeRealSk(value) ? undefined : 'Invalid secret key.'),
      }),
    ).trim();
    redactSecret(sk);
    await upsertEnvVar(envLocal, 'CLERK_SECRET_KEY', sk);
  }
  return { pk, sk };
}

// ── Clerk CLI ────────────────────────────────────────────────────────────────

/** Always run the exact Clerk CLI version tested by this installer. */
export async function resolveClerk() {
  return async (args, { agent = true, inherit = false, cwd, secretKey = null, sensitiveOutput = false } = {}) => {
    const env = { ...process.env };
    // A shell-level key must never silently override --app/--instance and make
    // the installer inspect or mutate a different application.
    delete env.CLERK_SECRET_KEY;
    delete env.CLERK_PUBLISHABLE_KEY;
    delete env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    if (secretKey) env.CLERK_SECRET_KEY = secretKey;
    const full = ['-y', `clerk@${CLERK_CLI_VERSION}`, '--mode', agent ? 'agent' : 'human', ...args];
    return inherit
      ? runInherit('npx', full, { cwd, env })
      : run('npx', full, { cwd, env, sensitiveOutput });
  };
}

/** Verify that the secret key resolves to the selected app's dev instance. */
export async function validateClerkInstance(clerk, app, secretKey, cwd) {
  let selectedInstanceId = app.instanceId;
  if (!selectedInstanceId) {
    const selected = await clerk(['api', '/instance', '--app', app.appId, '--instance', 'dev'], {
      cwd,
      sensitiveOutput: true,
    });
    if (!selected.ok) {
      return {
        ok: false,
        reason: `Could not identify the selected Clerk development instance: ${firstLine(selected)}`,
      };
    }
    try {
      selectedInstanceId = findInstanceId(JSON.parse(selected.stdout));
    } catch {
      selectedInstanceId = null;
    }
    if (!selectedInstanceId) {
      return { ok: false, reason: 'Clerk did not return the selected application development instance ID.' };
    }
  }

  const result = await clerk(['api', '/instance'], {
    cwd,
    secretKey,
    sensitiveOutput: true,
  });
  if (!result.ok) {
    return {
      ok: false,
      reason: `Could not validate the Clerk secret key against its instance: ${firstLine(result)}`,
    };
  }
  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    return { ok: false, reason: 'Clerk returned an unknown format while validating the secret key instance.' };
  }
  const instanceId = findInstanceId(data);
  if (!instanceId) {
    return { ok: false, reason: 'Clerk did not return an instance ID while validating the secret key.' };
  }
  if (instanceId !== selectedInstanceId) {
    return {
      ok: false,
      reason: 'Clerk key mismatch: the secret key does not belong to the selected application development instance.',
    };
  }
  return { ok: true, instanceId, reason: null };
}

// ── JWT + Billing reconciliation ────────────────────────────────────────────

export async function ensureConvexJwtTemplate(clerk, app, ctx, expected = CLERK_JWT_TEMPLATE) {
  ui.step('Checking the Clerk Convex JWT configuration…');
  const appArgs = ['--app', app.appId, '--instance', 'dev'];
  const list = await clerk(['api', '/jwt_templates', ...appArgs]);
  if (!list.ok) throw new Error(`Could not inspect Clerk JWT templates: ${firstLine(list)}`);

  const actual = parseJwtTemplates(list.stdout).find((template) => template.name === expected.name);
  const diff = jwtTemplateDiff(actual, expected);
  if (diff.length === 0) {
    ui.info('JWT template "convex" already matches the expected configuration.');
    return;
  }

  await authorizeReusedAppMutation(ctx, app, 'Convex JWT template', diff);
  const body = JSON.stringify(expected);
  const command = actual
    ? ['api', `/jwt_templates/${actual.id}`, ...appArgs, '-X', 'PATCH', '--yes', '-d', body]
    : ['api', '/jwt_templates', ...appArgs, '-X', 'POST', '--yes', '-d', body];
  if (actual && !actual.id) throw new Error('The existing Convex JWT template has no ID and cannot be reconciled safely.');

  const mutation = await clerk(command);
  if (!mutation.ok) throw new Error(`Could not reconcile the Convex JWT template: ${firstLine(mutation)}`);
  ui.success(`JWT template "convex" ${actual ? 'updated' : 'created'}.`);
}

async function ensureClerkBilling(clerk, app, ctx) {
  const args = ['enable', 'billing', '--app', app.appId, '--instance', 'dev', '--no-skills'];
  const dryRun = await clerk([...args, '--dry-run']);
  if (!dryRun.ok) throw new Error(`Could not inspect Clerk Billing: ${firstLine(dryRun)}`);
  if (/no changes|already enabled|nothing to (?:change|update)/i.test(`${dryRun.stdout}\n${dryRun.stderr}`)) {
    ui.info('Clerk Billing is already enabled.');
    return;
  }
  await authorizeReusedAppMutation(ctx, app, 'Clerk Billing', ['enable for users and organizations']);
  const enabled = await clerk([...args, '--yes']);
  if (!enabled.ok) throw new Error(`Could not enable Clerk Billing: ${firstLine(enabled)}`);
  ui.success('Clerk Billing enabled. Create the product plans in the Clerk Dashboard.');
}

async function authorizeReusedAppMutation(ctx, app, label, changes) {
  if (app.createdByInstaller) return;
  const detail = changes.join(', ');
  if (ctx.flags?.yes) {
    throw new Error(`${label} differs on reused app ${app.appId} (${detail}). Run interactively to review the change.`);
  }
  const approved = await ui.confirm({
    message: `${label} on reused app ${app.name || app.appId} needs this change: ${detail}. Apply it?`,
    initialValue: false,
  });
  if (!approved) throw new Error(`${label} was not changed; the Clerk integration cannot be completed safely.`);
}

// ── Health check + admin bootstrap ──────────────────────────────────────────

export function summarizeDoctor(value) {
  let data;
  try {
    data = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return { errors: [], warnings: [], parsed: false };
  }
  const errors = [];
  const warnings = [];
  const seen = new Set();
  const walk = (item) => {
    if (!item || typeof item !== 'object' || seen.has(item)) return;
    seen.add(item);
    const status = String(item.status ?? item.level ?? '').toLowerCase();
    const message = String(item.message ?? item.title ?? item.name ?? 'Clerk doctor finding');
    if (['error', 'fail', 'failed', 'failure'].includes(status)) errors.push(message);
    else if (['warn', 'warning'].includes(status)) warnings.push(message);
    for (const child of Array.isArray(item) ? item : Object.values(item)) walk(child);
  };
  walk(data);
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)], parsed: true };
}

async function runClerkDoctor(clerk, ctx) {
  ui.step('Running Clerk doctor (read-only)…');
  const result = await clerk(['doctor', '--json', '--spotlight'], { cwd: ctx.dir });
  const report = summarizeDoctor(result.stdout);
  if (!report.parsed) {
    ui.warn('Clerk doctor returned an unknown format; setup completed, but review `clerk doctor` manually.');
    return;
  }
  for (const warning of report.warnings) ui.warn(`Clerk doctor: ${warning}`);
  if (report.errors.length > 0) {
    throw new Error(`Clerk doctor found structural errors:\n- ${report.errors.join('\n- ')}`);
  }
  // A non-zero exit with no recognized error is never reported as success,
  // even when warnings were parsed alongside it.
  if (!result.ok) {
    ui.warn(`Clerk doctor exited without a recognized structural error: ${firstLine(result)}`);
    return;
  }
  ui.success('Clerk doctor found no structural errors.');
}

async function grantSuperAdmin(ctx, envLocal) {
  let email = ctx.clerkEmail || null;
  if (!email && !ctx.flags?.yes) {
    const answer = await ui.text({
      message: 'E-mail that will have access to /admin (empty to configure later):',
      placeholder: 'you@example.com',
    });
    email = String(answer ?? '').trim() || null;
  }
  if (!email) {
    ui.info('/admin: configure later with `npx convex env set SUPERADMIN_EMAILS you@example.com`.');
    return;
  }
  const result = await run('npx', ['convex', 'env', 'set', 'SUPERADMIN_EMAILS', email], { cwd: ctx.dir });
  if (result.ok) {
    await upsertEnvVar(envLocal, 'SUPERADMIN_EMAILS', email);
    ui.success(`/admin unlocked for ${email}.`);
    ctx.superAdminEmail = email;
  } else {
    ui.warn(`Could not set SUPERADMIN_EMAILS. Run later:\n  npx convex env set SUPERADMIN_EMAILS ${email}`);
  }
}

function firstLine(result) {
  return String(result?.stderr || result?.stdout || 'unknown error').trim().split(/\r?\n/)[0];
}
