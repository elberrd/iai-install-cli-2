import process from 'node:process';
import { existsSync, readdirSync, mkdtempSync } from 'node:fs';
import { readFile, writeFile, rm, cp, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, basename, sep } from 'node:path';
import { ADDONS_MANIFEST_FILE, CLERK_ROUTING_DEFAULTS, ENV_EXAMPLE, ENV_FILE, MCPS, TEMPLATES } from '../config.js';
import { presentAgentFiles, backupAgentFiles } from '../lib/agent-backup.js';
import { run, runInherit } from '../lib/proc.js';
import { upsertEnvVar } from '../lib/env-file.js';
import { slugify } from '../lib/util.js';
import { downloadErrorMessage, fetchTemplateToDir } from '../lib/template-fetch.js';
import { applyAddons, reconcileAddons } from './addons.js';
import * as ui from '../lib/ui.js';

// Crash-recovery marker: written at the start of a FULL install (template
// path), removed by the finish step. If a later run finds it, the folder is a
// half-finished installation — NOT an "existing project" (steps/mode.js would
// otherwise steer recovery into brownfield/harness-only and a fresh full run
// would duplicate the cloud resources).
export const STATE_MARKER = '.impactus-cli-state.json';
// Installs started by a pre-rebrand CLI wrote this name — readers accept
// both, and the finish step removes both.
export const LEGACY_STATE_MARKER = '.create-iai-state.json';

/** True when `dir` carries a half-finished-install marker (either brand). */
export function hasStateMarker(dir) {
  return existsSync(join(dir, STATE_MARKER)) || existsSync(join(dir, LEGACY_STATE_MARKER));
}

/** Read the crash-recovery metadata without ever making resume itself fail. */
export async function readInstallState(dir) {
  try {
    const value = JSON.parse(await readFile(join(dir, STATE_MARKER), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** Merge durable, non-secret provisioning receipts into the recovery marker. */
export async function updateInstallState(dir, patch) {
  const current = await readInstallState(dir);
  await writeFile(join(dir, STATE_MARKER), JSON.stringify({ ...current, ...patch }, null, 2) + '\n', 'utf8');
}

// ── Prompt: target folder (its name IS the project name) ────────────────────

export async function promptProject(flags = {}) {
  // The project name IS the target folder name — there is no separate name
  // question. `--name`/positional still works as an override (and, without
  // --dir, keeps the old behavior of creating ./<slug>).
  let name = flags.name;
  const cwdName = basename(process.cwd());

  let dirInput;
  if (flags.dir) {
    dirInput = flags.dir;
  } else if (name || flags.yes) {
    // Explicit name (or --yes with nothing): new ./<slug> subfolder, as before.
    dirInput = `./${slugify(name || 'my-app')}`;
  } else {
    // Interactive: pick the FOLDER first; the project name comes from it. If
    // the current folder is empty (student did mkdir + cd before running),
    // installing into it is the natural path — otherwise the default is to
    // create a subfolder.
    const cwdEmpty = readdirSync(process.cwd()).length === 0;
    const location = await ui.select({
      message: 'Where to install? (the folder name becomes the project name)',
      initialValue: cwdEmpty ? 'current' : 'subfolder',
      options: [
        {
          value: 'current',
          label: `In the current folder (${cwdName}/)`,
          hint: cwdEmpty ? 'empty — recommended' : 'the folder already has files',
        },
        { value: 'subfolder', label: 'In a new subfolder…', hint: 'you pick the name' },
        { value: 'custom', label: 'Another path…' },
      ],
    });
    if (location === 'current') dirInput = '.';
    else if (location === 'subfolder') {
      const sub = await ui.text({
        message: 'Name of the new folder (it will be the project name):',
        placeholder: 'my-app',
        defaultValue: 'my-app',
        validate: (v) => (v && v.trim() ? undefined : 'Enter a name.'),
      });
      dirInput = `./${slugify(sub)}`;
    } else {
      dirInput = String(
        await ui.text({
          message: 'Folder path (use "." for the current folder):',
          placeholder: './my-app',
          defaultValue: './my-app',
        }),
      ).trim();
    }
  }

  const targetDir = resolve(process.cwd(), dirInput || '.');
  if (!name) name = basename(targetDir) || 'my-app';
  const slug = slugify(name);
  const isCurrent = targetDir === resolve(process.cwd());
  const existedBefore = existsSync(targetDir);

  if (existedBefore) {
    const entries = readdirSync(targetDir).filter((e) => e !== '.' && e !== '..');
    if (entries.length > 0) {
      const looksLikeProject =
        existsSync(resolve(targetDir, 'package.json')) || existsSync(resolve(targetDir, '.git'));
      if (flags.yes) {
        // Non-interactive: an EXISTING project may proceed — the --yes default
        // becomes "harness only" (steps/mode.js), which NEVER overwrites
        // (merges only what's missing). Forcing the template (--mode full /
        // --stack recomendada) into a non-empty folder stays forbidden: that
        // would be a real overwrite.
        const wantsTemplate =
          flags.mode === 'full' || String(flags.stack ?? '').trim().toLowerCase() === 'recomendada';
        if (!looksLikeProject || wantsTemplate) {
          throw new Error(`The folder ${targetDir} is not empty. With --yes I never overwrite; pick another one with --dir.`);
        }
        ui.info(`Existing project detected in ${targetDir} — the harness only adds what's missing (nothing is overwritten).`);
      } else if (hasStateMarker(resolve(targetDir))) {
        // Half-finished previous install (see STATE_MARKER above): continuing
        // in the same folder is the recovery path, not a conflict.
        ui.warn(
          `A previous installation of ${targetDir} did not finish. Continuing here is safe — the installer resumes and reuses what was already created (including cloud resources recorded in .env.local).`,
        );
        const cont = await ui.confirm({ message: 'Continue in this folder?', initialValue: true });
        if (!cont) ui.bail();
      } else {
        ui.warn(
          looksLikeProject
            ? `The ${isCurrent ? 'current ' : ''}folder (${targetDir}) already has a project. On the "harness only" path (recommended for an existing project) NOTHING of yours is overwritten — only what's missing goes in. Installing the template here may conflict with your files.`
            : `The ${isCurrent ? 'current ' : ''}folder (${targetDir}) already has files. On the template path, files with the same name are overwritten; on the "harness only" path nothing of yours is touched.`,
        );
        const overwrite = await ui.confirm({ message: 'Continue anyway?', initialValue: isCurrent });
        if (!overwrite) ui.bail();
      }
    }
  }

  // `createdDir` → the folder is entirely ours, so a fatal error later can
  // offer to delete it (rollback) without risk to pre-existing files.
  return { name: String(name).trim(), slug, dir: targetDir, isCurrent, createdDir: !existedBefore };
}

// ── Download + install (two steps) ──────────────────────────────────────────
// The addon choice happens BEFORE the download (decisions phase, embedded
// catalog). The downloaded template may still ship its own catalog in
// template.addons.json (ctx.templateManifest) — reconcileAddons checks the
// selection against it before applyAddons.

export async function fetchTemplate(ctx) {
  const { flags = {} } = ctx;
  // ctx.template comes from the selectTemplate step; defensive fallback via
  // the legacy --tenancy flag (e.g. calls outside the standard pipeline).
  const template = ctx.template ?? TEMPLATES[flags.tenancy === 'multi' ? 'live2' : 'live1'];

  // The ONLY download path: the community's gated API, with the paying
  // student's token (`ensureAuthenticated` runs before everything and exits
  // the CLI without login). There is no direct GitHub clone — this guard is
  // defense in depth. `--template-ref` allows testing a template branch/tag
  // (still gated).
  if (!ctx.authToken) {
    throw new Error(
      'The template download requires the community sign-in — run the installer again and choose "Sign in" (only the harness + agent install without it).',
    );
  }
  const branch = flags.templateRef || '';

  // Download into a temp dir; `installTemplate` copies it into the target
  // later. This also makes installing into the current/non-empty folder work.
  const tmpRoot = mkdtempSync(join(tmpdir(), 'impactus-template-'));
  const tmpClone = join(tmpRoot, 'repo');
  ctx.templateTmpRoot = tmpRoot;
  ctx.templateTmp = tmpClone;

  await ui.spin(
    `Downloading the template (${template.id})…`,
    async () => {
      const res = await fetchTemplateToDir(ctx.apiBase, ctx.authToken, template.id, tmpClone, branch);
      if (!res.ok) {
        throw new Error(downloadErrorMessage('template', res.reason));
      }

      // Drop installer-only folders before anything reads the tree.
      for (const p of template.strip ?? []) {
        await rm(join(tmpClone, p), { recursive: true, force: true });
      }
    },
    'Template downloaded.',
  );

  // The template's own addons manifest (optional): if it declares
  // `groups`/`presets`, the addons step uses that catalog instead of the CLI's
  // ADDON_GROUPS — a new feature in the template no longer requires a release.
  try {
    ctx.templateManifest = JSON.parse(await readFile(join(tmpClone, ADDONS_MANIFEST_FILE), 'utf8'));
  } catch {
    ctx.templateManifest = null;
  }
}

export async function installTemplate(ctx) {
  const { dir, slug } = ctx;

  // Copy template into the (possibly pre-existing) target folder. The state
  // marker goes in FIRST: if anything from here to the finish step dies, the
  // next run sees the marker and offers to CONTINUE the full install instead
  // of treating the half-copied tree as an existing (brownfield) project.
  try {
    await mkdir(dir, { recursive: true });
    await writeStateMarker(ctx);
    // Agent-files policy (decided in selectInstallMode) also covers the FULL
    // path: the template ships its own .claude/, .cursor/ and CLAUDE.md, and
    // the plain copy overwrites same-named files. 'replace' banks the user's
    // set BEFORE the copy (moved to .agents-backup-<date>/ — never deleted);
    // 'add' keeps the user's version of every pre-existing agent path and
    // merges the template's per file (same semantics as the harness merge).
    const protect = ctx.agentFilesPolicy ? presentAgentFiles(dir) : [];
    if (ctx.agentFilesPolicy === 'replace' && protect.length) {
      const backupDir = await backupAgentFiles(dir, protect);
      ctx.agentFilesBackup = backupDir;
      ui.success(`Previous agent files moved to ${basename(backupDir)}/.`);
      await copyTemplateTree(ctx.templateTmp, dir);
    } else {
      await copyTemplateTree(ctx.templateTmp, dir, {
        protect: ctx.agentFilesPolicy === 'add' ? protect : [],
      });
    }
  } finally {
    await rm(ctx.templateTmpRoot, { recursive: true, force: true });
    ctx.templateTmpRoot = null;
    ctx.templateTmp = null;
  }

  // Set the package name to the project slug.
  await setPackageName(join(dir, 'package.json'), slug);

  // Apply the addon choice made in the decisions phase: remove unchosen
  // files/deps/marker blocks BEFORE installing, so npm never downloads what
  // got cut and the initial commit already reflects the chosen stack. The
  // choice is first reconciled with the downloaded template's own catalog.
  ui.step('Applying the chosen addons…');
  reconcileAddons(ctx);
  await applyAddons(ctx);

  // Ensure a .env.local exists. Seed it from .env.example when the template
  // committed one; otherwise start empty. Either way, guarantee the safe Clerk
  // routing defaults are present (the example file is gitignored upstream and
  // may be missing from the downloaded tree).
  //
  // AFTER applyAddons on purpose: the pruning removes the `live1:addon:*`
  // blocks from .env.example, and it is that already-clean version that
  // becomes the student's .env.local. Otherwise, the file they actually edit
  // would be born full of dead config (Stripe, Asaas, R2…) from addons they
  // didn't choose.
  const envLocal = join(dir, ENV_FILE);
  const envExample = join(dir, ENV_EXAMPLE);
  if (!existsSync(envLocal)) {
    if (existsSync(envExample)) await copyFile(envExample, envLocal);
    else await writeFile(envLocal, '# Generated by impactus\n', 'utf8');
  }
  for (const [key, value] of Object.entries(CLERK_ROUTING_DEFAULTS)) {
    await upsertEnvVar(envLocal, key, value);
  }

  // Fresh local git repo + an initial commit of the pristine template. The
  // commit gives the user a diffable baseline (dep updates, shadcn presets and
  // blocks all become visible via `git diff`) and lets them revert any
  // customization. Best-effort: a missing git identity must not abort.
  await run('git', ['init', '-q'], { cwd: dir });
  await run('git', ['add', '-A'], { cwd: dir });
  await run('git', ['commit', '-q', '-m', 'chore: initial template (impactus)'], { cwd: dir });

  // Install dependencies with live output.
  ui.step('Installing dependencies (npm install)…');
  const inst = await runInherit('npm', ['install'], { cwd: dir });
  if (!inst.ok) throw new Error('npm install failed. Run `npm install` in the project folder and try again.');
  ui.success('Dependencies installed.');

  // Stripping addon blocks can leave formatting that Prettier would rewrite
  // (collapsed arrays, indentation) — normalize now so `format:check` passes
  // in the generated project's CI. Best-effort: needs the just-installed bins.
  const fmt = await ui.spin('Normalizing formatting (prettier)…', () =>
    run('npx', ['prettier', '--write', '.', '--log-level', 'warn'], { cwd: dir }),
  );
  if (fmt.ok) {
    await run('git', ['add', '-A'], { cwd: dir });
    // LEFTHOOK=0: npm install just installed the project's git hooks — this
    // amend is internal to the installer and must not trigger lint/commitlint.
    await run('git', ['commit', '-q', '--amend', '--no-edit'], {
      cwd: dir,
      env: { ...process.env, LEFTHOOK: '0' },
    });
  } else {
    ui.warn('prettier --write failed (run `npm run format` later).');
  }
  // Note: convex/_generated is refreshed automatically by the Convex step
  // later (`convex dev --once` runs codegen), so it always ends up matching
  // the addon-reduced convex/ folder.
}

/**
 * Copy the downloaded template into the target folder. `protect` (the 'add'
 * agent-files policy) lists paths whose PRE-EXISTING version must win: they
 * are kept out of the clobbering bulk copy and then merged per file with
 * force:false — the template only adds what's missing under them (same
 * semantics as the harness merge in steps/harness.js).
 */
export async function copyTemplateTree(srcDir, destDir, { protect = [] } = {}) {
  if (!protect.length) {
    await cp(srcDir, destDir, { recursive: true });
    return;
  }
  const shielded = protect.map((rel) => join(srcDir, rel));
  await cp(srcDir, destDir, {
    recursive: true,
    filter: (src) => !shielded.some((p) => src === p || src.startsWith(p + sep)),
  });
  for (const rel of protect) {
    if (!existsSync(join(srcDir, rel))) continue;
    await cp(join(srcDir, rel), join(destDir, rel), {
      recursive: true,
      force: false, // the project's version always wins
      errorOnExist: false,
      verbatimSymlinks: true,
    });
  }
}

/** Best-effort: the marker never blocks the install if it can't be written. */
async function writeStateMarker(ctx) {
  try {
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    const current = await readInstallState(ctx.dir);
    await updateInstallState(ctx.dir, {
      version: pkg.version,
      startedAt: current.startedAt ?? new Date().toISOString(),
      mode: ctx.mode ?? 'full',
    });
  } catch {
    /* non-fatal */
  }
}

async function setPackageName(pkgPath, name) {
  if (!existsSync(pkgPath)) return;
  try {
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
    pkg.name = name;
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  } catch {
    /* non-fatal */
  }
}

// ── Template MCPs (Playwright + Convex) ─────────────────────────────────────

export async function addMcps(ctx) {
  ui.step('Registering the template MCPs (Playwright, Convex)…');
  const list = await run('claude', ['mcp', 'list'], { cwd: ctx.dir });
  const existing = list.ok ? list.stdout : '';
  for (const mcp of MCPS) {
    if (existing.includes(mcp.name)) {
      ui.info(`MCP ${mcp.name} already configured.`);
      continue;
    }
    const r = await run('claude', mcp.args, { cwd: ctx.dir });
    if (r.ok) ui.success(`MCP ${mcp.name} added.`);
    else
      ui.warn(
        `Couldn't add the MCP ${mcp.name} — add it manually later. (${r.stderr.trim().slice(0, 120)})`,
      );
  }
}

export function relToCwd(dir) {
  return relative(process.cwd(), dir) || '.';
}
