// Stack — manifest, documentation and tooling.
//
// Runs AFTER the harness (which brings ai-docs/) in both modes:
//   1. provisions the instant Neon database (Launchpad, no account) when the
//      person chose Neon — DATABASE_URL in .env.local + claim URL stored;
//   2. writes the ai-docs/stack.md manifest (source of truth for the stack:
//      choices, pending layers, dev × production environments, per-technology docs);
//   3. stamps the stack block into AGENTS.md (between markers, idempotent);
//   4. outside template mode: installs the official skills, offers the CLIs
//      (with login) and registers the MCPs of the CHOSEN technologies — the
//      big differentiator: you picked the stack, the system arrives equipped.
//
// Pending layers install nothing: whoever decides later (Pi /idea or /stack)
// gets the tools at decision time, guided by the command itself.

import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ENV_FILE } from '../config.js';
import { STACK_CATEGORIES, stackOption } from '../stack-catalog.js';
import {
  STACK_MANIFEST_PATH,
  applyAgentsStackBlock,
  applyStackRules,
  renderStackAgentsBlock,
  renderStackMd,
  stackFromDecisions,
} from '../lib/stack.js';
import { createClaimableNeonDb, parseNeonProjectCreate } from '../lib/neon.js';
import { installProjectSkills } from '../lib/skills.js';
import { ensureIntegrationCli } from './integrations.js';
import { redactSecret } from '../lib/log.js';
import { has, run, runInherit } from '../lib/proc.js';
import * as ui from '../lib/ui.js';

export async function setupStackDocs(ctx) {
  const { dir } = ctx;
  const info = resolveStackInfo(ctx);
  ctx.stackInfo = info;

  // 1. Development database (custom path only): Neon — instant with no
  //    account (claim) or in your account via CLI; Supabase — guided creation.
  if (ctx.stackPath !== 'template' && info.choices.database === 'neon') {
    await maybeProvisionNeon(ctx, info);
  }
  if (ctx.stackPath !== 'template' && info.choices.database === 'supabase') {
    await maybeProvisionSupabase(ctx);
  }

  // 2. ai-docs/stack.md manifest (never overwrites — /stack updates it).
  const manifestAbs = join(dir, STACK_MANIFEST_PATH);
  await mkdir(join(dir, 'ai-docs'), { recursive: true });
  if (existsSync(manifestAbs)) {
    ui.info(`${STACK_MANIFEST_PATH} already exists — kept (/stack updates it).`);
  } else {
    await writeFile(
      manifestAbs,
      renderStackMd({ ...info, projectName: ctx.name, provision: ctx.neonProvision ? { neon: ctx.neonProvision } : undefined }) + '\n',
      'utf8',
    );
    ui.success(`Stack manifest created: ${STACK_MANIFEST_PATH}`);
  }

  // 3. Stack block in AGENTS.md (idempotent via markers).
  const agentsPath = join(dir, 'AGENTS.md');
  const current = existsSync(agentsPath) ? await readFile(agentsPath, 'utf8') : null;
  const { content, action } = applyAgentsStackBlock(current, renderStackAgentsBlock(info));
  if (action === 'skipped') {
    ui.info('AGENTS.md already contained the stack block — kept.');
  } else {
    await writeFile(agentsPath, content, 'utf8');
    ui.success(action === 'created' ? 'AGENTS.md created with the stack block.' : 'AGENTS.md: stack block appended.');
  }

  // 4. Tooling for the chosen technologies. In template mode the full-stack
  //    steps (MCPs, template skills, integrations) already handle this.
  if (ctx.stackPath !== 'template') {
    await setupStackTooling(ctx, info);
  }
}

/**
 * Template mode: the stack comes from the template + decisions (storage decides
 * the blob). Custom paths: it comes from the wizard (ctx.stack, built in steps/stack.js).
 */
function resolveStackInfo(ctx) {
  if (ctx.stackPath === 'template' || !ctx.stack) {
    // templateStackOverrides: layers the template does not cover but the wizard
    // already decided (today: automations) — they survive the template switch.
    const { choices, pending } = applyStackRules({
      ...stackFromDecisions(ctx.decisions ?? {}),
      ...(ctx.templateStackOverrides ?? {}),
    });
    return { choices, pending, source: 'template' };
  }
  return { choices: ctx.stack.choices, pending: ctx.stack.pending, source: ctx.stack.source };
}

// ── Development databases (Neon and Supabase) ────────────────────────────────

/** DATABASE_URL already in .env.local? Then the database is the user's — hands off. */
async function hasDatabaseUrl(envPath) {
  return envContains(envPath, /^DATABASE_URL=/m);
}

/** Does .env.local match the pattern? (missing file = false) */
async function envContains(envPath, re) {
  return existsSync(envPath) && re.test(await readFile(envPath, 'utf8'));
}

/** Appends lines to .env.local (creating it) and ensures the .gitignore entry. */
async function appendEnvLines(ctx, lines) {
  const envPath = join(ctx.dir, ENV_FILE);
  const prefix = existsSync(envPath) ? '\n' : '';
  await appendFile(envPath, prefix + lines.join('\n') + '\n', 'utf8');
  await ensureGitignoreEntries(ctx.dir, [ENV_FILE]);
}

async function maybeProvisionNeon(ctx, info) {
  const envPath = join(ctx.dir, ENV_FILE);
  if (await hasDatabaseUrl(envPath)) {
    ui.info(`DATABASE_URL already exists in ${ENV_FILE} — database kept.`);
    return;
  }
  // A previous run created the project but did not record the URL (parse
  // failed)? Do not create ANOTHER cloud database — just point the way.
  if (await envContains(envPath, /^# Neon database \(DEV\)/m)) {
    ui.info('A Neon database was already created in a previous run — grab the DATABASE_URL at https://console.neon.tech and put it in .env.local.');
    return;
  }

  const manualHint = () =>
    ui.info(
      'To create it later: `npx neon-new@latest --yes` in the project folder (no account; claim later) ' +
        'or `neon projects create` in your account — DATABASE_URL goes in .env.local.',
    );

  if (ctx.flags?.yes) {
    manualHint();
    return;
  }
  const how = await ui.select({
    message: 'Postgres database (Neon) — how do you want to create the development one?',
    initialValue: 'instant',
    options: [
      {
        value: 'instant',
        label: 'Now, no account (recommended)',
        hint: 'instant — you get the DATABASE_URL right away and claim it into your Neon account later (~72h)',
      },
      {
        value: 'account',
        label: 'In my Neon account (CLI)',
        hint: 'creates a real project — installs the `neon` CLI and logs in via the browser if needed',
      },
      { value: 'skip', label: 'Later', hint: 'continue without a database — the instructions stay in the manifest' },
    ],
  });
  if (how === 'skip') {
    manualHint();
    return;
  }
  if (how === 'account') {
    await provisionNeonAccount(ctx, manualHint);
    return;
  }

  try {
    const db = await ui.spin(
      'Creating the database on Neon Launchpad (no account)…',
      () => createClaimableNeonDb('impactus'),
      'Development Postgres database created.',
    );
    redactSecret(db.databaseUrl); // the connection string carries a password — never in the log
    if (db.directUrl) redactSecret(db.directUrl);

    await appendEnvLines(ctx, [
      '# Neon database (DEV) — created by the installer via Neon Launchpad (no account).',
      ...(db.claimUrl ? [`# CLAIM the database into your Neon account (or it expires in ~72h): ${db.claimUrl}`] : []),
      `DATABASE_URL=${db.databaseUrl}`,
      ...(db.directUrl ? [`DATABASE_URL_DIRECT=${db.directUrl}`] : []),
    ]);

    ctx.neonProvision = { claimUrl: db.claimUrl, expiresAt: db.expiresAt };
    info.provision = { neon: ctx.neonProvision };
    ui.success(`DATABASE_URL written to ${ENV_FILE}.`);
    if (db.claimUrl) {
      ui.warn(`IMPORTANT: claim the database into your Neon account (or it expires in ~72h): ${db.claimUrl}`);
    }
  } catch (err) {
    ui.warn(`Could not create the database right now (${err?.message || err}).`);
    manualHint();
  }
}

/** Neon Tier-1: project created IN the user's account via the official CLI. */
async function provisionNeonAccount(ctx, manualHint) {
  const neonCli = stackOption('database', 'neon')?.cli;
  if (!(await has('neon'))) {
    await ensureIntegrationCli(neonCli, ctx);
    if (!(await has('neon'))) {
      manualHint();
      return;
    }
  }

  const create = () =>
    // sensitiveOutput: the JSON carries the connection string WITH the
    // password — it must not land in the debug log (which the student
    // attaches to bug reports).
    run('neon', ['projects', 'create', '--name', ctx.slug ?? ctx.name ?? 'app', '--output', 'json'], {
      timeout: 120000,
      sensitiveOutput: true,
    });
  let r = await ui.spin('Creating the project in your Neon account…', create, 'Creation command executed.');
  // Without login the CLI fails — open `neon auth` (browser) and retry ONCE.
  if (!r.ok && /auth|login|credential|unauthorized|api.?key|401|403/i.test(r.stderr + r.stdout)) {
    ui.info('You are not logged in to Neon yet — opening the browser (`neon auth`)…');
    const auth = await runInherit('neon', ['auth']);
    if (auth.ok) r = await ui.spin('Creating the project in your Neon account…', create, 'Creation command executed.');
  }
  if (!r.ok) {
    ui.warn(`Could not create the project (${r.stderr.trim().slice(0, 160) || 'neon CLI error'}).`);
    manualHint();
    return;
  }
  const { databaseUrl, projectId } = parseNeonProjectCreate(r.stdout);
  if (!databaseUrl) {
    ui.warn('The CLI created the project but I could not recognize the connection string in the response — grab it at https://console.neon.tech and put it in DATABASE_URL in .env.local.');
    // Marker: on a re-run the flow knows the project ALREADY exists and does
    // not offer to create another one in the cloud.
    await appendEnvLines(ctx, [
      `# Neon database (DEV) — project created in YOUR account${projectId ? ` (id: ${projectId})` : ''}; grab the DATABASE_URL at https://console.neon.tech.`,
    ]);
    ctx.neonProvision = { projectId };
    return;
  }
  redactSecret(databaseUrl);
  await appendEnvLines(ctx, [
    `# Neon database (DEV) — project created in YOUR account via CLI${projectId ? ` (id: ${projectId})` : ''}.`,
    `DATABASE_URL=${databaseUrl}`,
  ]);
  ctx.neonProvision = { projectId };
  ui.success(`Neon project created in your account — DATABASE_URL written to ${ENV_FILE}.`);
}

/**
 * Guided Supabase: login → `projects create` (the CLI asks org/region) →
 * the connection string comes from the dashboard (cannot be composed safely).
 */
async function maybeProvisionSupabase(ctx) {
  const envPath = join(ctx.dir, ENV_FILE);
  if (await hasDatabaseUrl(envPath)) {
    ui.info(`DATABASE_URL already exists in ${ENV_FILE} — database kept.`);
    return;
  }

  const manualHint = () =>
    ui.info(
      'To create it later: `supabase login` then `supabase projects create <name>` — the connection string is in the dashboard (Connect) and goes in DATABASE_URL in .env.local.',
    );

  if (ctx.flags?.yes) {
    manualHint();
    return;
  }

  // Project already created in a previous run (marker in .env.local)? Do not
  // create ANOTHER one in the cloud — only the connection string is missing.
  const alreadyCreated = await envContains(envPath, /^# Supabase database \(DEV\)/m);
  if (!alreadyCreated) {
    const wants = await ui.confirm({
      message:
        'Create the Supabase project now? (official CLI — browser login; you pick the organization, region and database password along the way)',
      initialValue: true,
    });
    if (!wants) {
      manualHint();
      return;
    }

    const supaCli = stackOption('database', 'supabase')?.cli;
    if (!(await has('supabase'))) {
      await ensureIntegrationCli(supaCli, ctx);
      if (!(await has('supabase'))) {
        manualHint();
        return;
      }
    }

    // `projects list` fails without login — the cheapest test before opening the browser.
    const logged = await run('supabase', ['projects', 'list'], { timeout: 30000 });
    if (!logged.ok) {
      ui.info('Supabase login — opening the browser (`supabase login`)…');
      const auth = await runInherit('supabase', ['login']);
      if (!auth.ok) {
        ui.warn('Login not completed.');
        manualHint();
        return;
      }
    }

    // The database password is typed INTO the Supabase CLI (hidden prompt) —
    // it never goes through argv (visible in `ps`) and never stays with the installer.
    ui.info('Creating the project — pick the organization, region and database password when the CLI asks (save the password).');
    const created = await runInherit('supabase', ['projects', 'create', ctx.slug ?? ctx.name ?? 'app']);
    if (!created.ok) {
      ui.warn('Creation did not finish.');
      manualHint();
      return;
    }
    ui.success('Supabase project created.');
    // Marker so re-runs do not offer to create another project.
    await appendEnvLines(ctx, [
      '# Supabase database (DEV) — project created by the installer; connection string: dashboard → Connect.',
    ]);
  } else {
    ui.info('Supabase project already created in a previous run — only the connection string is missing.');
  }

  const pasted = String(
    await ui.text({
      message:
        'Paste the database connection string (dashboard → Connect → ORMs; use the password you typed at creation) — or leave empty to do it later:',
      placeholder: 'postgresql://…  (Enter to skip)',
      defaultValue: '',
    }) ?? '',
  ).trim();
  if (/^postgres(ql)?:\/\//.test(pasted)) {
    redactSecret(pasted);
    await appendEnvLines(ctx, [`DATABASE_URL=${pasted}`]);
    ui.success(`DATABASE_URL written to ${ENV_FILE}.`);
  } else {
    ui.info('No problem — set DATABASE_URL in .env.local once you grab the string from the dashboard.');
  }
}

/** Ensures entries in .gitignore (creating the file if it does not exist). */
async function ensureGitignoreEntries(dir, entries) {
  const path = join(dir, '.gitignore');
  const existing = existsSync(path) ? (await readFile(path, 'utf8')).split('\n') : [];
  const missing = entries.filter((e) => !existing.includes(e));
  if (!missing.length) return;
  const base = existing.length ? existing.join('\n').trimEnd() + '\n' : '';
  await writeFile(path, base + missing.join('\n') + '\n', 'utf8');
}

// ── Tooling: official skills + CLI + MCP per chosen technology ───────────────

async function setupStackTooling(ctx, info) {
  const seen = new Set();
  const chosen = [];
  for (const cat of STACK_CATEGORIES) {
    const opt = stackOption(cat.id, info.choices[cat.id]);
    if (!opt || seen.has(opt.id)) continue; // Convex appears under backend AND database
    seen.add(opt.id);
    if (opt.skills || opt.cli || opt.mcp || opt.mcpNote) chosen.push(opt);
  }
  if (!chosen.length) {
    ui.info('No technology chosen yet — the tools arrive when you decide (Pi: /idea or /stack).');
    return;
  }

  // `claude mcp list` prints "name: command/url …" per line — compare by
  // EXACT name (an MCP "my-vercel-tools" must not hide the official "vercel").
  const list = await run('claude', ['mcp', 'list'], { cwd: ctx.dir });
  const existingMcps = new Set(
    (list.ok ? list.stdout : '')
      .split('\n')
      .map((line) => line.split(':')[0].trim())
      .filter(Boolean),
  );

  for (const opt of chosen) {
    // 1. The technology's official skills → inside the project (skills-lock.json).
    if (opt.skills) {
      await installProjectSkills(ctx.dir, opt.skills);
    }
    // 2. Official CLI (install + login, both optional). `viaNpx` = not a
    //    global binary (e.g. convex runs via npx) — guidance only.
    if (opt.cli?.viaNpx) {
      ui.info(`${opt.cli.name}: used via npx (no global install). Login when needed: npx ${opt.cli.bin} ${opt.cli.loginArgs.join(' ')}`);
    } else if (opt.cli) {
      await ensureIntegrationCli(opt.cli, ctx);
    }
    // 3. Official MCP.
    if (opt.mcp) {
      if (existingMcps.has(opt.mcp.name)) {
        ui.info(`MCP ${opt.mcp.name} already configured.`);
      } else {
        const r = await run('claude', opt.mcp.addArgs, { cwd: ctx.dir });
        if (r.ok) ui.success(`MCP ${opt.mcp.name} added.`);
        else ui.warn(`Could not add the MCP ${opt.mcp.name} — /stack guides you later. (${r.stderr.trim().slice(0, 120)})`);
      }
    }
    if (opt.mcpNote) ui.info(`${opt.label} — ${opt.mcpNote}`);
  }
}
