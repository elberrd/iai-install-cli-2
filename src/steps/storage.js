import process from 'node:process';
import { join } from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ENV_FILE, OPTIONAL_SKILLS, R2_ENV_VARS } from '../config.js';
import { has, run, runInherit } from '../lib/proc.js';
import { redactSecret } from '../lib/log.js';
import { upsertEnvVar } from '../lib/env-file.js';
import { extractCloudflareAccounts } from '../lib/util.js';
import { installProjectSkills } from '../lib/skills.js';
import * as ui from '../lib/ui.js';

/**
 * Optional step: choose the blob-storage backend for the "Documentos" page.
 *
 * The template ships the Documentos feature working out of the box on Convex's
 * built-in file storage. This step lets the user instead wire up Cloudflare R2
 * by setting the four R2_* vars on the Convex deployment (they're read there,
 * not by Next.js). Each var is skippable — R2 only activates once ALL four are
 * present, so a partial fill just stays on Convex storage until completed.
 *
 * To make the R2 hookup painless there is a `wrangler` (Cloudflare CLI)
 * assistant: it checks whether wrangler exists (offering to install it if
 * not), logs in, discovers the Account ID, creates/reuses the bucket and
 * applies the CORS policy the browser uploads need. The only thing wrangler
 * cannot do is mint the S3 API token (dashboard-only), so those two values are
 * still pasted by the user.
 */
export async function setupStorage(ctx) {
  const { dir, flags = {} } = ctx;
  const envLocal = join(dir, ENV_FILE);

  // R2 keys that arrived ready-made (--keys file pasted in the web UI).
  const fromKeys = {};
  for (const spec of R2_ENV_VARS) {
    const v = ctx.providedKeys?.[spec.key];
    if (!v) continue;
    fromKeys[spec.key] = String(v).trim();
    if (spec.secret) redactSecret(fromKeys[spec.key]);
  }

  // Non-interactive: with all FOUR keys in the --keys file (the R2 AI prompt
  // creates bucket + CORS + token and returns all four) we can configure R2
  // without a single question; without them, we stay on Convex Storage.
  if (flags.yes && flags.storage === 'r2') {
    if (R2_ENV_VARS.every((s) => fromKeys[s.key])) {
      let failed = 0;
      for (const spec of R2_ENV_VARS) {
        const r = await run('npx', ['convex', 'env', 'set', spec.key, fromKeys[spec.key]], { cwd: dir });
        if (r.ok) await upsertEnvVar(envLocal, spec.key, fromKeys[spec.key]);
        else failed++;
      }
      if (failed === 0) {
        ui.success('Cloudflare R2 configured from the keys file.');
        ui.note(corsReminder(), '⚠️ Check the bucket CORS (the AI prompt already walks you through it)');
        ctx.storageBackend = 'r2';
        ctx.keysApplied = true;
        (ctx.serviceReport ??= []).push({
          id: 'r2',
          label: 'Cloudflare R2 (files)',
          ok: true,
          detail: 'active (keys from --keys) — check the bucket CORS',
        });
        return;
      }
      ui.warn("I couldn't apply all the R2 keys in Convex — using Convex Storage for now.");
    } else {
      ui.warn(
        '--storage r2 with --yes needs all four R2 keys in --keys (the R2 AI prompt in the UI returns all four). Using Convex Storage.',
      );
    }
  }
  if (flags.skipStorage || flags.storage === 'convex' || flags.yes) {
    ui.info('Storage: using Convex built-in file storage.');
    ctx.storageBackend = 'convex';
    return;
  }

  // The Convex × R2 choice came from the decisions phase; the prompt below is
  // just a fallback for calls outside the standard pipeline.
  let choice = ctx.decisions?.storage ?? (flags.storage === 'r2' ? 'r2' : null);
  if (!choice) {
    ui.note(
      [
        'The "Documentos" page lets you upload and manage files (drag-and-drop',
        'upload, multiple files, progress bar).',
        '',
        'Files can be stored in Cloudflare R2 OR in Convex built-in file',
        'storage. You can choose now — or stay on Convex and switch on R2',
        'later, whenever you want.',
      ].join('\n'),
      'Documentos — file storage (optional)',
    );
    choice = await ui.select({
      message: 'Where should uploaded files be stored?',
      options: [
        {
          value: 'convex',
          label: 'Convex built-in storage (default — nothing to configure)',
        },
        { value: 'r2', label: 'Cloudflare R2 (set up now, with help from wrangler)' },
      ],
      initialValue: 'convex',
    });
  }

  if (choice !== 'r2') {
    ui.note(howToLater(), 'Using Convex Storage — how to switch on R2 later');
    ctx.storageBackend = 'convex';
    return;
  }

  // The user picked R2 → also ship the OFFICIAL Cloudflare agent skills
  // (`cloudflare` + `wrangler`, from github.com/cloudflare/skills) into the
  // project, so the coding agent knows R2/wrangler by heart from day one.
  await installProjectSkills(dir, OPTIONAL_SKILLS.r2);

  // Values collected along the way (keys file, wrangler, or typed by the user).
  const provided = { ...fromKeys };
  if (Object.keys(fromKeys).length) {
    ui.success(`R2 keys from the --keys file: ${Object.keys(fromKeys).join(', ')}.`);
  }

  // ── Wrangler assistant (optional but recommended) ─────────────────────────
  const wranglerReady = await ensureWrangler();
  if (wranglerReady) {
    const accountId = provided.R2_ACCOUNT_ID || (await pickCloudflareAccount());
    if (accountId) {
      provided.R2_ACCOUNT_ID = accountId;
      // Bucket already came from the keys file (created by the AI prompt)? Only
      // the CORS gets reapplied, for safety; otherwise wrangler creates/reuses one.
      const bucket = provided.R2_BUCKET || (await ensureBucket(accountId, ctx));
      if (bucket) {
        provided.R2_BUCKET = bucket;
        await applyCors(accountId, bucket, ctx);
      }
    }
  }

  // ── Credentials wrangler can't create (S3 API token = dashboard-only) ────
  ui.note(
    [
      "Now the R2 S3 API credentials — wrangler CANNOT create these; they're",
      'born in the Cloudflare dashboard and the Secret is shown only ONCE:',
      '',
      '  Cloudflare → R2 → Manage API Tokens → Create API Token',
      '  (minimum scope: "Object Read & Write" on the project bucket only)',
      '',
      'Leave it EMPTY to skip and fill in later — R2 only activates once ALL',
      'FOUR variables are set.',
    ].join('\n'),
    'Cloudflare R2 — API token',
  );

  for (const spec of R2_ENV_VARS) {
    if (provided[spec.key]) {
      ui.success(`${spec.key}: ${spec.secret ? '••••' : provided[spec.key]} (already obtained)`);
      continue;
    }
    const answer = spec.secret
      ? await ui.password({
          message: `${spec.key} — ${spec.label} (empty to skip):`,
        })
      : await ui.text({
          message: `${spec.key} — ${spec.label} (empty to skip):`,
          placeholder: spec.hint,
        });
    const value = String(answer ?? '').trim();
    if (value) provided[spec.key] = value;
  }

  const keys = Object.keys(provided);
  if (keys.length === 0) {
    ui.note(howToLater(), 'No credentials provided — how to switch it on later');
    ctx.storageBackend = 'convex';
    return;
  }

  // Set each provided var on the Convex deployment AND mirror into .env.local.
  for (const spec of R2_ENV_VARS) {
    if (spec.secret && provided[spec.key]) redactSecret(provided[spec.key]);
  }
  let failed = 0;
  for (const key of keys) {
    const r = await run('npx', ['convex', 'env', 'set', key, provided[key]], { cwd: dir });
    if (r.ok) {
      await upsertEnvVar(envLocal, key, provided[key]);
      if (fromKeys[key]) ctx.keysApplied = true;
    } else {
      failed++;
      ui.warn(`I couldn't set ${key} in Convex. Run later:\n  npx convex env set ${key} <value>`);
    }
  }

  const complete = R2_ENV_VARS.every((s) => provided[s.key]) && failed === 0;
  if (complete) {
    ui.success('Cloudflare R2 configured — uploads from the Documentos page will go to your bucket.');
    if (!ctx.r2CorsConfigured) ui.note(corsReminder(), '⚠️ 1 step left: bucket CORS');
    ctx.storageBackend = 'r2';
    (ctx.serviceReport ??= []).push({
      id: 'r2',
      label: 'Cloudflare R2 (files)',
      ok: true,
      detail: ctx.r2CorsConfigured ? 'active (bucket + CORS ok)' : 'active — only the bucket CORS is missing',
    });
  } else {
    ui.note(
      [
        `You set ${keys.length - failed} of ${R2_ENV_VARS.length} R2 variables.`,
        'Until all four are set, files stay in Convex Storage.',
        '',
        ...howToLater().split('\n'),
      ].join('\n'),
      'R2 partially configured',
    );
    ctx.storageBackend = 'convex';
  }
}

// ── wrangler: presence + login ───────────────────────────────────────────────

/**
 * Make sure the Cloudflare CLI is available and authenticated. Missing
 * wrangler is not an error: we ASK before installing, and declining simply
 * falls back to the manual copy-paste flow.
 * @returns {Promise<boolean>} true when `wrangler` is usable and logged in.
 */
async function ensureWrangler() {
  ui.step('Checking for wrangler (the Cloudflare CLI)…');

  if (!(await has('wrangler'))) {
    ui.warn('wrangler not found.');
    const install = await ui.confirm({
      message: 'Install wrangler now (npm install -g wrangler)? It automates Account ID, bucket and CORS.',
      initialValue: true,
    });
    if (!install) {
      ui.info('No problem — we continue with the manual R2 setup.');
      return false;
    }
    const r = await runInherit('npm', ['install', '-g', 'wrangler']);
    if (!r.ok || !(await has('wrangler'))) {
      ui.warn("I couldn't install wrangler. We continue with the manual setup.");
      ui.info('To install later: npm install -g wrangler  (docs: https://developers.cloudflare.com/workers/wrangler/)');
      return false;
    }
    ui.success('wrangler installed.');
  } else {
    ui.success('wrangler installed.');
  }

  if (await isWranglerLoggedIn()) {
    ui.success('wrangler authenticated.');
    return true;
  }

  ui.warn('You need to log in to Cloudflare.');
  ui.info('Opening `wrangler login` — finish it in the browser.');
  await runInherit('wrangler', ['login']);
  if (await isWranglerLoggedIn()) {
    ui.success('wrangler authenticated.');
    return true;
  }
  ui.warn('wrangler login not confirmed. We continue with the manual R2 setup.');
  return false;
}

async function isWranglerLoggedIn() {
  const who = await run('wrangler', ['whoami']);
  if (!who.ok) return false;
  const text = `${who.stdout}\n${who.stderr}`;
  if (/not authenticated|not logged in/i.test(text)) return false;
  return extractCloudflareAccounts(text).length > 0;
}

// ── wrangler: Account ID ─────────────────────────────────────────────────────

/** Discover the Account ID via `wrangler whoami` (asking when there are several). */
async function pickCloudflareAccount() {
  const who = await run('wrangler', ['whoami']);
  const accounts = extractCloudflareAccounts(`${who.stdout}\n${who.stderr}`);

  if (accounts.length === 0) {
    ui.warn("I couldn't discover the Account ID via wrangler — you'll be able to enter it manually.");
    return null;
  }
  if (accounts.length === 1) {
    ui.success(`Account ID: ${accounts[0].id}${accounts[0].name ? ` (${accounts[0].name})` : ''}`);
    return accounts[0].id;
  }
  return await ui.select({
    message: 'Which Cloudflare account should R2 use?',
    options: accounts.map((a) => ({ value: a.id, label: a.name ? `${a.name} — ${a.id}` : a.id })),
  });
}

// ── wrangler: bucket ─────────────────────────────────────────────────────────

/** Create (or reuse) the R2 bucket via wrangler. Returns the bucket name or null. */
async function ensureBucket(accountId, ctx) {
  const suggested = `${(ctx.name || 'my-app').toLowerCase()}-files`.replace(/[^a-z0-9-]/g, '-');
  const answer = await ui.text({
    message: 'R2 bucket name (new or existing; empty to skip):',
    placeholder: suggested,
  });
  const bucket = String(answer ?? '').trim() || '';
  if (!bucket) return null;

  const r = await ui.spin(`Creating bucket "${bucket}"…`, () =>
    run('wrangler', ['r2', 'bucket', 'create', bucket], {
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
    }),
  );
  if (r.ok) {
    ui.success(`Bucket "${bucket}" created.`);
    return bucket;
  }
  const text = `${r.stdout}\n${r.stderr}`;
  if (/already exists|already owned|10004/i.test(text)) {
    ui.success(`Bucket "${bucket}" already exists — we'll use it.`);
    return bucket;
  }
  ui.warn(`I couldn't create the bucket "${bucket}" via wrangler.`);
  ui.info('Create it in the dashboard (Cloudflare → R2 → Create bucket) and enter the name in the next step.');
  return null;
}

// ── wrangler: CORS ───────────────────────────────────────────────────────────

/**
 * Apply the CORS policy browser uploads need (GET+PUT from the app origins).
 * Cloudflare's expected JSON shape is the `rules`/`allowed` one — NOT the AWS
 * S3 style. Docs: https://developers.cloudflare.com/r2/buckets/cors/
 */
async function applyCors(accountId, bucket, ctx) {
  const wants = await ui.confirm({
    message: `Configure the CORS for bucket "${bucket}" now? (required for direct browser uploads)`,
    initialValue: true,
  });
  if (!wants) {
    ui.note(corsReminder(), 'CORS pending — configure it before using uploads');
    return;
  }

  const extra = await ui.text({
    message: 'Production origin to allow as well (e.g. https://my-app.vercel.app; empty = localhost only):',
    placeholder: 'https://…',
  });
  const origins = ['http://localhost:3000'];
  const extraOrigin = String(extra ?? '').trim();
  if (extraOrigin) origins.push(extraOrigin.replace(/\/+$/, ''));

  const policy = {
    rules: [
      {
        allowed: {
          origins,
          methods: ['GET', 'PUT'],
          headers: ['Content-Type'],
        },
        maxAgeSeconds: 3600,
      },
    ],
  };

  const dirTmp = await mkdtemp(join(tmpdir(), 'create-iai-r2-'));
  const corsFile = join(dirTmp, 'cors.json');
  await writeFile(corsFile, JSON.stringify(policy, null, 2), 'utf8');

  const r = await ui.spin(`Applying CORS to bucket "${bucket}"…`, () =>
    run('wrangler', ['r2', 'bucket', 'cors', 'set', bucket, '--file', corsFile, '--force'], {
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
    }),
  );
  if (r.ok) {
    ui.success(`CORS applied (origins: ${origins.join(', ')}).`);
    ctx.r2CorsConfigured = true;
  } else {
    ui.warn("I couldn't apply the CORS via wrangler.");
    ui.note(corsReminder(), 'Configure the CORS manually');
  }
}

// ── supporting copy ──────────────────────────────────────────────────────────

function howToLater() {
  return [
    'To activate Cloudflare R2 later, set the four variables on the Convex',
    'deployment (inside the project folder):',
    '',
    ...R2_ENV_VARS.map((s) => `  npx convex env set ${s.key} <value>`),
    '',
    'Tip: wrangler (npm install -g wrangler) automates the Account ID, bucket',
    'creation and CORS — run `wrangler login` and then:',
    '  wrangler r2 bucket create <name>',
    '  wrangler r2 bucket cors set <name> --file cors.json',
    '',
    'Then configure the bucket CORS (see .env.example). Without all of them,',
    'the Documentos page uses Convex built-in file storage.',
  ].join('\n');
}

function corsReminder() {
  return [
    'Since the browser sends files STRAIGHT to R2, the bucket needs a CORS',
    'policy. With wrangler:',
    '',
    '  wrangler r2 bucket cors set <bucket> --file cors.json',
    '',
    "cors.json (Cloudflare's format, not AWS's):",
    '  { "rules": [ { "allowed": {',
    '      "origins": ["http://localhost:3000"],',
    '      "methods": ["GET","PUT"],',
    '      "headers": ["Content-Type"] } } ] }',
    '',
    'Or in the dashboard: Cloudflare → R2 → your bucket → Settings → CORS Policy.',
    "In production, also add your app's public URL to the origins.",
  ].join('\n');
}
