import process from 'node:process';
import { join } from 'node:path';
import { ENV_FILE, CLERK_JWT_TEMPLATE } from '../config.js';
import { has, run, runInherit } from '../lib/proc.js';
import { redactSecret } from '../lib/log.js';
import { getEnvVar, upsertEnvVar, removeEnvVar } from '../lib/env-file.js';
import {
  issuerFromPublishableKey,
  looksLikeRealPk,
  looksLikeRealSk,
  extractAppInfo,
  parseAppList,
} from '../lib/clerk.js';
import * as ui from '../lib/ui.js';

export async function setupClerk(ctx) {
  const { dir } = ctx;
  const envLocal = join(dir, ENV_FILE);

  ui.note(
    [
      "Now authentication (Clerk). This is 100% automatic — you do NOT need to",
      'touch the Convex dashboard or fill in CLERK_JWT_ISSUER_DOMAIN by hand.',
      "I'll: create/pick the Clerk app, grab the keys, create the \"convex\" JWT",
      'template and set the issuer in Convex for you.',
      'If it asks you to log in, finish it in the browser.',
    ].join('\n'),
    'Clerk',
  );

  const clerk = await resolveClerk();

  // 1. Ensure logged in. whoami also gives us the account e-mail — used later
  //    to unlock the /admin panel (SUPERADMIN_EMAILS) without questions.
  let who = await clerk(['whoami'], { agent: true });
  if (!who.ok) {
    // `clerk login` opens the browser and waits — under --yes that would hang
    // the run forever. Fail fast with the exact recovery.
    if (ctx.flags?.yes) {
      throw new Error(
        [
          'The Clerk CLI is not logged in and --yes cannot open the interactive login.',
          'Log in once and run the installer again:',
          '  npx clerk login',
        ].join('\n'),
      );
    }
    ui.step('Logging in to Clerk…');
    await clerk(['login'], { inherit: true });
    who = await clerk(['whoami'], { agent: true });
  } else {
    ui.info('Clerk already authenticated.');
  }
  ctx.clerkEmail = extractEmail(`${who.stdout}\n${who.stderr}`);

  // 2. Choose the app: reuse an existing one (avoids piling up test apps) or
  //    create a fresh one.
  const app = await chooseClerkApp(clerk, ctx);

  if (app.appId) {
    ui.success(`Clerk app: ${app.name || app.appId}`);
    await clerk(['link', '--app', app.appId], { agent: true, cwd: dir }); // best-effort
    // env pull writes CLERK_SECRET_KEY (and CLERK_PUBLISHABLE_KEY without the
    // NEXT_PUBLIC_ prefix Next.js needs — we normalize that below).
    ui.step('Pulling the Clerk keys…');
    await clerk(['env', 'pull', '--app', app.appId, '--instance', 'dev', '--file', ENV_FILE], {
      agent: true,
      cwd: dir,
    });
  } else {
    ui.warn("I couldn't create/identify the Clerk app automatically — I'll ask for the keys.");
  }

  // 3. Resolve the two keys, normalizing the publishable key to the name the
  //    Next.js app expects.
  const { pk, sk } = await resolveKeys(envLocal, app, ctx.flags);

  // 4. Ensure the "convex" JWT template exists on this app. The SAME simple
  //    template serves live1 and live2: in multi-tenant, organizations belong
  //    to the APP (Convex), so the JWT carries no organization claim at all.
  await ensureConvexJwtTemplate(clerk, app.appId, sk, CLERK_JWT_TEMPLATE);

  // 5. Derive the issuer and wire both sides.
  const issuer = issuerFromPublishableKey(pk);
  if (issuer) {
    await upsertEnvVar(envLocal, 'CLERK_JWT_ISSUER_DOMAIN', issuer);
    ui.step(`Setting CLERK_JWT_ISSUER_DOMAIN in Convex: ${issuer}`);
    const set = await run('npx', ['convex', 'env', 'set', 'CLERK_JWT_ISSUER_DOMAIN', issuer], { cwd: dir });
    if (set.ok) ui.success('Convex ⇄ Clerk connected.');
    else
      ui.warn(
        `I couldn't set it in Convex automatically. Run in the project folder:\n  npx convex env set CLERK_JWT_ISSUER_DOMAIN ${issuer}`,
      );
    ctx.issuer = issuer;
  } else {
    ui.warn("I couldn't derive the issuer from the publishable key. Set CLERK_JWT_ISSUER_DOMAIN manually.");
  }
  ctx.clerkApp = app.appId;

  // 6. /admin panel: unlocks the first super-admin by setting SUPERADMIN_EMAILS
  //    on the Convex deployment (the template checks this env — see adminAuth.ts).
  await grantSuperAdmin(ctx, envLocal);
}

/** Sets SUPERADMIN_EMAILS in Convex with the account e-mail (or asks for one). */
async function grantSuperAdmin(ctx, envLocal) {
  let email = ctx.clerkEmail || null;
  if (!email && !ctx.flags?.yes) {
    const answer = await ui.text({
      message: 'E-mail that will have access to the /admin panel (empty to set up later):',
      placeholder: 'you@example.com',
    });
    email = String(answer ?? '').trim() || null;
  }
  if (!email) {
    ui.info('/admin panel: set it later with  npx convex env set SUPERADMIN_EMAILS you@example.com');
    return;
  }
  const r = await run('npx', ['convex', 'env', 'set', 'SUPERADMIN_EMAILS', email], { cwd: ctx.dir });
  if (r.ok) {
    await upsertEnvVar(envLocal, 'SUPERADMIN_EMAILS', email);
    ui.success(`/admin panel unlocked for ${email} (SUPERADMIN_EMAILS in Convex).`);
    ctx.superAdminEmail = email;
  } else {
    ui.warn(`I couldn't set SUPERADMIN_EMAILS. Run later:\n  npx convex env set SUPERADMIN_EMAILS ${email}`);
  }
}

/** First plausible e-mail in a text (output of `clerk whoami`). */
function extractEmail(text) {
  const m = /[A-Za-z0-9][\w.+-]*@[\w-]+\.[\w.-]+/.exec(String(text || ''));
  return m ? m[0] : null;
}

// ── App selection ───────────────────────────────────────────────────────────

async function chooseClerkApp(clerk, ctx) {
  const nonInteractive = ctx.flags?.yes;
  const list = await clerk(['apps', 'list', '--json'], { agent: true });
  const existing = list.ok ? parseAppList(list.stdout) : [];

  let mode = 'new';
  if (existing.length && !nonInteractive) {
    mode = await ui.select({
      message: 'How should we set up the Clerk app?',
      initialValue: 'new',
      options: [
        { value: 'new', label: 'Create a new app', hint: 'recommended' },
        { value: 'existing', label: `Use an existing app (${existing.length})` },
      ],
    });
  }

  if (mode === 'existing') {
    const picked = await ui.select({
      message: 'Pick the app:',
      options: existing.map((a) => ({ value: a.appId, label: a.name || a.appId })),
    });
    const found = existing.find((a) => a.appId === picked);
    if (found) return found;
  }

  // Create a new app.
  const appName = nonInteractive
    ? ctx.name
    : String(
        await ui.text({ message: 'Name for the new Clerk app?', defaultValue: ctx.name, placeholder: ctx.name }),
      ).trim();
  const created = await clerk(['apps', 'create', appName, '--json'], { agent: true });
  if (created.ok) {
    try {
      const info = extractAppInfo(JSON.parse(created.stdout));
      if (info.appId) return info;
    } catch {
      /* fall through */
    }
  }
  // Last resort: re-list and match by the name we just tried to create.
  const relist = await clerk(['apps', 'list', '--json'], { agent: true });
  const match = relist.ok ? parseAppList(relist.stdout).find((a) => a.name === appName) : null;
  return match || { appId: null, name: appName, pk: null };
}

// ── Keys ────────────────────────────────────────────────────────────────────

async function resolveKeys(envLocal, app, flags = {}) {
  // Publishable key: prefer the one from the app JSON, else whatever env pull
  // wrote (either the NEXT_PUBLIC_ name or the bare CLERK_PUBLISHABLE_KEY).
  let pk =
    (looksLikeRealPk(app.pk) && app.pk) ||
    (await getEnvVar(envLocal, 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY')) ||
    (await getEnvVar(envLocal, 'CLERK_PUBLISHABLE_KEY'));

  if (!looksLikeRealPk(pk) && flags.yes) {
    // Non-interactive runs can't paste keys — fail loudly with the fix.
    throw new Error(
      "I couldn't get the Clerk keys automatically (--yes mode doesn't allow pasting keys). Run without --yes.",
    );
  }
  if (!looksLikeRealPk(pk)) {
    // Manual fallback: say exactly WHERE the keys live before asking.
    ui.note(
      [
        'Where to find the two Clerk keys:',
        '  1. Open https://dashboard.clerk.com and select your application.',
        '  2. In the left menu, open "API Keys".',
        '  3. Copy the "Publishable key" (pk_test_… / pk_live_…) and the',
        '     "Secret key" (sk_test_… / sk_live_…) — I ask for both below.',
      ].join('\n'),
      'Clerk keys',
    );
    pk = String(
      await ui.text({
        message: 'Paste the Clerk Publishable Key (pk_test_… or pk_live_…):',
        validate: (v) => (looksLikeRealPk(v) ? undefined : 'Invalid key.'),
      }),
    ).trim();
  }
  // The Next.js app reads NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY; drop the bare one
  // env pull may have written so there's a single source of truth.
  await upsertEnvVar(envLocal, 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', pk);
  await removeEnvVar(envLocal, 'CLERK_PUBLISHABLE_KEY');

  let sk = await getEnvVar(envLocal, 'CLERK_SECRET_KEY');
  if (sk) redactSecret(sk);
  if (!looksLikeRealSk(sk) && flags.yes) {
    throw new Error(
      "I couldn't get the Clerk Secret Key automatically (--yes mode doesn't allow pasting keys). Run without --yes.",
    );
  }
  if (!looksLikeRealSk(sk)) {
    sk = String(
      await ui.password({
        message:
          'Paste the Clerk Secret Key (sk_test_… or sk_live_…) — dashboard.clerk.com → your app → API Keys:',
        validate: (v) => (looksLikeRealSk(v) ? undefined : 'Invalid key.'),
      }),
    ).trim();
    redactSecret(sk);
    await upsertEnvVar(envLocal, 'CLERK_SECRET_KEY', sk);
  }

  return { pk, sk };
}

// ── Clerk CLI resolution ────────────────────────────────────────────────────

/**
 * Return a callable that runs the Clerk CLI. Uses a global `clerk` if present;
 * otherwise installs it, falling back to `npx -y clerk@latest`.
 * Options: { agent, inherit, cwd }.
 */
export async function resolveClerk() {
  let base;
  if (await has('clerk')) {
    base = { bin: 'clerk', pre: [] };
  } else {
    ui.step('Installing the Clerk CLI (npm install -g clerk)…');
    const g = await runInherit('npm', ['install', '-g', 'clerk']);
    base = g.ok && (await has('clerk')) ? { bin: 'clerk', pre: [] } : { bin: 'npx', pre: ['-y', 'clerk@latest'] };
  }
  return async (args, { agent = false, inherit = false, cwd } = {}) => {
    const env = { ...process.env };
    if (agent) env.CLERK_MODE = 'agent';
    const full = [...base.pre, ...args];
    return inherit ? runInherit(base.bin, full, { cwd, env }) : run(base.bin, full, { cwd, env });
  };
}

// ── JWT template ────────────────────────────────────────────────────────────

async function ensureConvexJwtTemplate(clerk, appId, sk, template = CLERK_JWT_TEMPLATE) {
  ui.step('Ensuring the "convex" JWT template in Clerk…');
  const body = JSON.stringify(template);
  const appArgs = appId ? ['--app', appId] : [];

  const list = await clerk(['api', '/jwt_templates', ...appArgs], { agent: true });
  if (list.ok && /"name"\s*:\s*"convex"/.test(list.stdout)) {
    ui.info('JWT template "convex" already exists.');
    return;
  }

  const create = await clerk(['api', '/jwt_templates', ...appArgs, '-X', 'POST', '--yes', '-d', body], {
    agent: true,
  });
  if (create.ok) {
    ui.success('JWT template "convex" created.');
    return;
  }

  // Fallback: Clerk Backend API directly with the secret key.
  if (sk) {
    try {
      const res = await fetch('https://api.clerk.com/v1/jwt_templates', {
        method: 'POST',
        headers: { Authorization: `Bearer ${sk}`, 'Content-Type': 'application/json' },
        body,
      });
      if (res.ok) {
        ui.success('JWT template "convex" created (via API).');
        return;
      }
      const txt = await res.text();
      if (/already exists|taken|duplicate/i.test(txt)) {
        ui.info('JWT template "convex" already exists.');
        return;
      }
      ui.warn(`I couldn't create the JWT template automatically: ${txt.slice(0, 200)}`);
    } catch (e) {
      ui.warn(`Failed to call the Clerk API: ${String(e)}`);
    }
  }

  ui.note(
    'Create the JWT template in Clerk: Dashboard → JWT Templates → New → preset "Convex" (the name must be exactly "convex").',
    'Manual action required',
  );
}

