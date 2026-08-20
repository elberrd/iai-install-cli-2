import process from 'node:process';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as ui from './lib/ui.js';
import { initLog, getLogPath, logLine, redactSecret } from './lib/log.js';
import { run } from './lib/proc.js';
import { ensureAuthenticated } from './steps/auth.js';
import { checkEngines, ensureCliTools, ensureFiaAuth } from './steps/preflight.js';
import { promptProject, fetchTemplate, installTemplate, addMcps } from './steps/project.js';
import { resolveTemplateId } from './steps/template.js';
import { stepEnabled } from './lib/pipeline.js';
import { selectInstallMode } from './steps/mode.js';
import { collectStack } from './steps/stack.js';
import { setupStackDocs } from './steps/stack-docs.js';
import { collectDecisions } from './steps/decisions.js';
import { maybeUpdateDeps } from './steps/deps.js';
import { setupShadcn } from './steps/shadcn.js';
import { setupConvex, finalizeConvex } from './steps/convex.js';
import { setupClerk } from './steps/clerk.js';
import { setupWebhook } from './steps/webhook.js';
import { setupStorage } from './steps/storage.js';
import { setupServiceKeys } from './steps/service-keys.js';
import { setupIntegrations } from './steps/integrations.js';
import { loadKeysFile } from './lib/keys.js';
import { ENV_FILE, TEMPLATES } from './config.js';
import { setupGithub } from './steps/github.js';
import { setupDeploy } from './steps/deploy.js';
import { setupHarness } from './steps/harness.js';
import { setupFia } from './steps/fia.js';
import { setupImpeccable } from './steps/impeccable.js';
import { finish } from './steps/finish.js';

export async function main(flags = {}) {
  initLog();
  ui.intro('IMPACTUS CLI');
  ui.message(
    'IAI installer v2: agent harness + FIA (the IAI Agent Factory, with Pi and FDAs).\n' +
      'First I ask every decision and show a summary; you confirm and I run everything at once.',
  );
  await checkForUpdate();

  const ctx = { flags };

  // Early gate (before login): if --template-id/--tenancy ask for an unknown
  // or unpublished template, warn right away. Every download (template AND
  // harness) goes exclusively through the community's API — there is no
  // direct GitHub clone. The templates require the student token; the harness
  // is also served WITHOUT one (guest mode installs harness + FIA only — see
  // steps/auth.js, steps/mode.js and steps/harness.js).
  {
    const { id } = resolveTemplateId(flags);
    if (id && !TEMPLATES[id]) {
      ui.error(`Unknown template: "${id}". Available: ${Object.keys(TEMPLATES).join(', ')}.`);
      process.exit(1);
    }
    if (id && !TEMPLATES[id].available) {
      ui.error(
        `The "${TEMPLATES[id].label}" template is unavailable at the moment. ` +
          'Use another template or try again later.',
      );
      process.exit(1);
    }
  }

  // `--keys <file>` — keys pasted in the web UI (they stay on this machine only).
  if (flags.keys) {
    try {
      const { keys, unknown } = await loadKeysFile(flags.keys);
      for (const v of Object.values(keys)) redactSecret(v); // never in the log
      ctx.providedKeys = keys;
      ctx.keysFilePath = flags.keys;
      ui.info(`Keys loaded from ${flags.keys}: ${Object.keys(keys).length} recognized.`);
      if (unknown.length) ui.warn(`Unrecognized keys in the file (ignored): ${unknown.join(', ')}`);
    } catch (err) {
      // Say WHY it failed — "check the path" alone hides an unreadable or
      // malformed file behind the same message as a typo in the path.
      const cause =
        err?.code === 'ENOENT'
          ? 'the file does not exist at that path'
          : err?.code === 'EACCES' || err?.code === 'EPERM'
            ? 'this user has no permission to read the file'
            : `the file could not be read as KEY=value lines (${err?.message || err})`;
      ui.error(`Could not read the keys file ${flags.keys} — ${cause}. Fix it (or remove --keys) and run again.`);
      process.exit(1);
    }
  }

  // The pipeline is built in two phases. First we resolve the mode (name/folder
  // + the "harness or harness + template" choice); only then do we know which
  // steps will run, so the `[i/n]` header counts exactly the right total.
  //
  // The harness is ALWAYS installed (it's the base). In 'full' mode the whole
  // template stack runs before it; in 'harness' mode nothing else runs — only
  // the folder is prepared and the harness is merged into it.
  const preludeSteps = [
    ['Access — sign in to the community (optional)', () => ensureAuthenticated(ctx)],
    ['Engines — Claude Code and Codex (status only, never blocks)', () => checkEngines(ctx)],
    ['Project — target folder (the project name is the folder name)', async () => Object.assign(ctx, await promptProject(flags))],
    ['How to start — ready-made template, your own stack, or decide later', () => selectInstallMode(ctx)],
    // Only the "build my stack" path asks here; the others pass straight through.
    // It must stay in the prelude: if the choices match the recommended stack,
    // the step switches ctx.mode to 'full' BEFORE the pipeline is assembled.
    ['Your stack — layer by layer (or decide later)', () => collectStack(ctx)],
  ];

  // Each step declares a CAPABILITY (3rd field): 'core' runs for any
  // template; the others only when the template declares it in `requires`
  // (src/config.js → TEMPLATES; pure helper in src/lib/pipeline.js).
  //
  // ALL decisions (template, stack, shadcn, deps, storage, webhook,
  // GitHub, deploy) are asked at once in collectDecisions, with a summary
  // and confirmation — execution from then on asks no more decision
  // questions. Addon selection uses the built-in catalog; after the download,
  // reconcileAddons checks it against the downloaded template.addons.json.
  const templateSteps = [
    ['Your decisions — assemble the installation', () => collectDecisions(ctx), 'core'],
    // Browser logins (vercel, gh) only come in if the matching decision was
    // "yes" — without deploy/push they are pure friction.
    [
      'CLIs — git, gh and vercel (+ login)',
      () => ensureCliTools({ vercel: ctx.decisions?.deploy === true, ghAuth: ctx.decisions?.push === true, flags, ctx }),
      'core',
    ],
    // FIA subscriptions: the engines were probed in the prelude (checkEngines,
    // informational only); here we only make sure Pi is installed/updated — the
    // Codex login is the user's last step, AFTER the install finishes (the
    // final notes explain it).
    [
      'FIA — Pi (install/update; Codex login comes at the end)',
      async () => {
        if (ctx.decisions?.fia === false) return ui.info('FIA turned off — Pi/Codex skipped.');
        try {
          await ensureFiaAuth(flags);
        } catch (err) {
          // A failed Pi install (EACCES on a system-owned npm folder is the
          // classic case) must NOT abort the whole installation: everything
          // else works without FIA. Degrade: explain, mark, keep going.
          ui.warn(err?.message || String(err));
          ui.warn(
            'Continuing WITHOUT FIA. After fixing the above, run the installer again in the same folder — it only adds what is missing.',
          );
          ctx.fiaSkipped = true;
        }
      },
      'core',
    ],
    ['Template download', () => fetchTemplate(ctx), 'core'],
    ['Template install + npm install', () => installTemplate(ctx), 'core'],
    ['Dependencies — update (optional)', () => maybeUpdateDeps(ctx), 'core'],
    ['MCPs — Playwright and Convex', () => addMcps(ctx), 'mcps'],
    ['shadcn/ui — preset and block (optional)', () => setupShadcn(ctx), 'shadcn'],
    ['Convex — create project and environment', () => setupConvex(ctx), 'convex'],
    ['Clerk — app, keys and JWT', () => setupClerk(ctx), 'clerk'],
    ['Convex — publish functions', () => finalizeConvex(ctx), 'convex'],
    ['Clerk → Convex webhook (optional)', () => setupWebhook(ctx), 'clerk'],
    ['Storage — R2 or Convex (optional)', () => setupStorage(ctx), 'storage'],
    ['Keys — activate chosen integrations', () => setupServiceKeys(ctx), 'convex'],
    ['Integrations — official skills and CLIs', () => setupIntegrations(ctx), 'core'],
    ['Git — commit and GitHub (optional)', () => setupGithub(ctx), 'core'],
    ['Vercel — Preview deploy (optional)', () => setupDeploy(ctx), 'core'],
  ];

  // `tailSteps(mode)` completes the pipeline once the mode is known.
  const tailSteps = (mode) =>
    mode === 'harness'
      ? [
          // The harness always comes through the community API (with or
          // without a token — guests get it anonymously): git comes in for the
          // local commit, nothing is pushed to GitHub and no clone happens, so
          // neither gh nor the Vercel CLI is installed.
          [
            'CLIs — git',
            () => ensureCliTools({ vercel: false, gh: false, ghAuth: false, flags, ctx }),
          ],
          ['Harness — agent workflow', () => setupHarness(ctx)],
          // After the harness (which creates ai-docs/): the ai-docs/stack.md
          // manifest, the stack block in AGENTS.md and the tooling
          // (skills/CLI/MCP) for the chosen techs — including the instant Neon
          // database when applicable.
          ['Stack — manifest, docs and tooling', () => setupStackDocs(ctx)],
          ['FIA — the IAI Agent Factory (Pi + FDAs)', () => setupFia(ctx)],
          ['Impeccable — design skill (optional)', () => setupImpeccable(ctx)],
          ['Final summary', () => finish(ctx)],
        ]
      : [
          ...templateSteps,
          ['Harness — agent workflow', () => setupHarness(ctx)],
          ['Stack — the project stack manifest', () => setupStackDocs(ctx)],
          ['FIA — the IAI Agent Factory (Pi + FDAs)', () => setupFia(ctx)],
          ['Impeccable — design skill (optional)', () => setupImpeccable(ctx)],
          ['Final summary', () => finish(ctx)],
        ];

  try {
    // Phase 1: run the prelude (resolves ctx.mode).
    let done = 0;
    for (const [title, fn] of preludeSteps) {
      // Total is still unknown here; we show the prelude index against the
      // full-mode length as a stable upper bound so the header never regresses.
      const total = preludeSteps.length + tailSteps('full').length;
      done++;
      ui.phase(done, total, title);
      logLine(`\n== [${done}/${total}] ${title} ==`);
      await fn();
    }

    // Phase 2: now the mode is set — build the tail and run it with the exact total.
    const rest = tailSteps(ctx.mode);
    const total = preludeSteps.length + rest.length;
    for (const [title, fn, cap] of rest) {
      done++;
      ui.phase(done, total, title);
      logLine(`\n== [${done}/${total}] ${title} ==`);
      // A capability step the template doesn't declare → skipped (stable
      // counter; today live1/live2 declare them all — this serves future
      // templates with smaller stacks).
      if (!stepEnabled(cap, ctx.template)) {
        ui.info(`(skipped — the ${ctx.template?.id ?? ''} template doesn't use "${cap}")`);
        logLine(`(skipped: capability ${cap} absent from the template)`);
        continue;
      }
      await fn();
    }
  } catch (err) {
    // The user pressed Ctrl-C/Esc on a prompt (lib/ui.js throws CancelError
    // instead of exiting mid-flight): not a failure — short goodbye, clean up
    // the temp download, offer the usual rollback, exit 130 (SIGINT
    // convention).
    if (err?.name === 'CancelError') {
      logLine('\n== CANCELED ==\n' + (err?.stack || String(err)));
      ui.info('Installation canceled — nothing else will be changed.');
      await maybeRollback(ctx);
      ui.outro('Canceled. Run the installer again whenever you like.');
      process.exit(130);
    }
    // The stack goes to the log FIRST: err.message alone rarely says where a
    // crash came from, and the log is what students attach to bug reports.
    logLine('\n== FATAL ==\n' + (err?.stack || String(err)));
    ui.error(err?.message || String(err));
    const logPath = getLogPath();
    if (logPath) ui.info(`Full log of this run: ${logPath}`);
    await maybeRollback(ctx);
    ui.outro(ui.color.red('Installation interrupted. Fix the error above and run again.'));
    process.exit(1);
  }
}

/**
 * Best-effort update check against the npm registry (3s timeout, never fatal).
 * Keeps users on the newest installer without adding a dependency.
 */
async function checkForUpdate() {
  try {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const r = await run('npm', ['view', pkg.name, 'version'], { timeout: 3000 });
    const latest = r.ok ? r.stdout.trim() : null;
    if (latest && isNewer(latest, pkg.version)) {
      ui.warn(`A newer version of ${pkg.name} exists (${latest} > ${pkg.version}). Run: npx ${pkg.name}@latest`);
    }
  } catch {
    /* offline / slow registry — carry on */
  }
}

/**
 * Prerelease-aware "is `a` newer than `b`" (exported for tests). The naive
 * `split('.').map(Number)` turned '2.0.0-alpha.0' into NaN — publishing
 * alpha.1 never warned alpha.0 users. Rules: numeric cores compare first;
 * equal cores: the version WITHOUT a prerelease wins; two prereleases compare
 * dot-part by dot-part (numeric when both parts are numeric, lexical
 * otherwise; more parts wins a tie).
 */
export function isNewer(a, b) {
  const parse = (v) => {
    const [core, ...rest] = String(v).split('-');
    return {
      core: core.split('.').map((n) => Number(n) || 0),
      pre: rest.length ? rest.join('-').split('.') : null,
    };
  };
  const A = parse(a);
  const B = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((A.core[i] || 0) > (B.core[i] || 0)) return true;
    if ((A.core[i] || 0) < (B.core[i] || 0)) return false;
  }
  if (!A.pre && !B.pre) return false;
  if (!A.pre) return true; // a release beats any prerelease of the same core
  if (!B.pre) return false;
  const len = Math.max(A.pre.length, B.pre.length);
  for (let i = 0; i < len; i++) {
    const x = A.pre[i];
    const y = B.pre[i];
    if (x === undefined) return false; // shorter prerelease is older (semver)
    if (y === undefined) return true;
    if (x === y) continue;
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) return Number(x) > Number(y);
    return x > y;
  }
  return false;
}

/**
 * If the installer itself created the target folder and then died, offer to
 * remove the half-configured project so re-running starts clean. Only ever
 * deletes folders we created (never a pre-existing one).
 */
async function maybeRollback(ctx) {
  // The download sits in a tmp dir until the install copies it — if we died
  // midway, don't leave the extracted tarball behind.
  if (ctx.templateTmpRoot) {
    await rm(ctx.templateTmpRoot, { recursive: true, force: true }).catch(() => {});
    ctx.templateTmpRoot = null;
  }
  if (!ctx.createdDir || !ctx.dir || !existsSync(ctx.dir)) return;
  if (ctx.flags?.yes) {
    ui.info(`The partially installed folder was kept: ${ctx.dir}`);
    return;
  }
  // If cloud resources were already provisioned (Convex/Clerk/Neon), deleting
  // the folder does NOT delete them — and .env.local here is the only local
  // record of which ones they are. Say so BEFORE the person confirms.
  const remote = await remoteResourcesIn(ctx.dir);
  if (remote.length) {
    ui.warn(
      [
        `Heads up: this install already created resources in the cloud (${remote.join(', ')}).`,
        'Deleting the folder does NOT delete them — and the .env.local inside it is the',
        'only local reference to those resources. To remove them later, use each',
        'dashboard: dashboard.convex.dev, dashboard.clerk.com, console.neon.tech.',
      ].join('\n'),
    );
  }
  // This confirm runs inside main()'s catch — a second Ctrl-C here would throw
  // a CancelError with no handler left above. Treat it as answering "no":
  // keep the folder and continue the normal goodbye flow.
  let wipe = false;
  try {
    wipe = await ui.confirm({
      message: `Delete the partially installed folder (${ctx.dir})?`,
      initialValue: false,
    });
  } catch (err) {
    if (err?.name !== 'CancelError') throw err;
  }
  if (wipe) {
    await rm(ctx.dir, { recursive: true, force: true });
    ui.success('Folder removed. Run the installer again whenever you like.');
  }
}

/**
 * Which cloud services does this project's .env.local point at? Key presence
 * only (values never leave the file) — used by maybeRollback's warning.
 */
async function remoteResourcesIn(dir) {
  try {
    const env = await readFile(join(dir, ENV_FILE), 'utf8');
    const has = (re) => re.test(env);
    const found = [];
    if (has(/^CONVEX_DEPLOYMENT=.+/m)) found.push('Convex');
    if (has(/^(NEXT_PUBLIC_)?CLERK_[A-Z_]*=.+/m)) found.push('Clerk');
    if (has(/^(NEON_[A-Z_]*|DATABASE_URL)=.+/m)) found.push('Neon/Postgres');
    return found;
  } catch {
    return []; // no .env.local yet — nothing provisioned
  }
}
