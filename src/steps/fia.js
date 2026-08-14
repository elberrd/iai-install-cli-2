import { cp, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIA } from '../config.js';
import { run } from '../lib/proc.js';
import { ensureImpGlobal, ensurePiReady, installPiPackages, piCodexReady } from '../lib/pi-auth.js';
import { prunePiSkillCopies } from '../lib/skills.js';
import {
  stampManifestFiles,
  ensureFiaGitignore,
  mergeFiaNpmScripts,
  saveRuntimeManifest,
  migrateLegacyFiaLayout,
  readRuntimeManifest,
} from './update-runtime.js';
import * as ui from '../lib/ui.js';

const PKG_ROOT = join(fileURLToPath(new URL('../..', import.meta.url)));

/**
 * Stamp FIA (deterministic FDA runner) and `.pi/` (Pi agent config) into the project.
 * Idempotent: never overwrites existing files (same philosophy as harness merge).
 */
export async function setupFia(ctx) {
  const { dir } = ctx;

  // Projects stamped by older versions have the runtime under fia/ (and
  // HARNESS.md / iai.config.json at the root). Migrate BEFORE any decision:
  // the skip-existing stamp below must see the current layout, or it would
  // create a second copy under imp/.
  await migrateLegacyFiaLayout(dir);

  if (ctx.fiaSkipped) {
    ui.info(
      'FIA skipped — Pi could not be installed earlier (see the warning above). ' +
        'After fixing Node/npm, run the installer again in this folder: it only adds what is missing.',
    );
    return;
  }
  if (!(await shouldInstallFia(ctx))) {
    ui.info('FIA skipped.');
    return;
  }

  // Install/update Pi WITHOUT any interactive login: opening Pi mid-install
  // invited a Ctrl+C that killed the installer with the stamp half done.
  // /login openai-codex is the last step, guided in the final note.
  // A failed Pi INSTALL is not fatal (EACCES on a system-owned npm folder is
  // the classic case): the rest of the installation works without FIA.
  try {
    await ensurePiReady();
  } catch (err) {
    ui.warn(err?.message || String(err));
    ui.warn(
      'Continuing WITHOUT FIA. After fixing the above, run the installer again in the same folder — it only adds what is missing.',
    );
    ctx.fiaSkipped = true;
    return;
  }

  const fiaSrc = join(PKG_ROOT, FIA.fiaTemplateDir);
  const piSrc = join(PKG_ROOT, FIA.piTemplateDir);
  const fiaDest = join(dir, FIA.runtimeDir);
  const piDest = join(dir, '.pi');

  await ui.spin('Stamping FIA (FIA — the IAI Agent Factory)…', async () => {
    await stampTree(fiaSrc, fiaDest);
    await stampTree(piSrc, piDest);
    // Check file by file: a half-done copy (swallowed error, full disk…) must
    // not pass as success — without `.pi/` Pi opens without FIA.
    await verifyStamp(fiaSrc, fiaDest, FIA.runtimeDir);
    await verifyStamp(piSrc, piDest, '.pi');
    await ensureFiaGitignore(dir);
    await mergePackageJson(dir);
    // Record the stamp: sha1 of every TEMPLATE file we shipped — the baseline
    // `--update-runtime` later uses to tell "unmodified since stamp" (safe
    // overwrite) from "the student's file" (confirm + backup). The stamp skips
    // files that already existed, and those differ from the template on
    // purpose — that difference is exactly what must ask for consent.
    // On a RE-RUN the existing baselines win: they still prove "unmodified
    // since the ORIGINAL stamp"; replacing them with the new template's sha
    // would flag every untouched-but-outdated file as student-edited.
    const stamped = await stampManifestFiles(dir);
    const existing = await readRuntimeManifest(dir);
    await saveRuntimeManifest(dir, { ...stamped, ...(existing?.files ?? {}) });
  }, 'FIA stamped.');

  // Pi reads the .agents/skills/ canonical directly (the skills went in
  // earlier, before `.pi/` existed — that's fine). A resumed install stamped
  // by an older CLI may still carry `.pi/skills/` copies of them, which only
  // produce a "Skill conflicts" panel at every Pi launch: prune those.
  const pruned = await prunePiSkillCopies(dir);
  if (pruned > 0) ui.info(`Removed ${pruned} duplicated skill folder(s) from .pi/skills/ — Pi reads .agents/skills/ directly.`);

  await ui.spin('Installing FIA dependencies…', async () => {
    const r = await run('npm', ['install'], { cwd: fiaDest });
    if (!r.ok) throw new Error(`npm install in ${FIA.runtimeDir}/ failed:\n${r.stderr || r.stdout}`);
  }, 'FIA dependencies installed.');

  // Degrade, never abort: the FIA needs these packages for Pi subagents, but
  // a registry hiccup here must not kill an install that already stamped the
  // template and harness — `imp update` re-runs this step (hard rule: nothing
  // about extras aborts an install).
  let piPkgs = null;
  try {
    piPkgs = await ui.spin(
      'Installing Pi packages (subagents + MCP + web access)…',
      () => installPiPackages(dir),
      'Pi packages installed.',
    );
  } catch (err) {
    ui.warn(
      `Pi extension packages not installed: ${err?.message || String(err)}\n` +
        'Run `imp update` later to install them — the FIA needs them for Pi subagents.',
    );
  }
  if (piPkgs?.skipped?.length) {
    ui.warn(
      `Customized in your Pi settings and left untouched: ${piPkgs.skipped.join(', ')}. ` +
        'Refresh manually if you want: pi install npm:<name>@latest',
    );
  }

  // The brand launcher: `npx impactus` leaves no bin behind, so `imp` only
  // exists after a global install. The final notes instruct whichever command
  // is actually on the student's PATH.
  ctx.impGlobal = await ensureImpGlobal();
  const cmd = ctx.impGlobal ? 'imp' : 'pi';

  ctx.fiaInstalled = true;
  const needsLogin = !piCodexReady();
  ui.note(
    [
      ...(needsLogin
        ? [
            'Only the Codex login is left — the installation is done. Do this:',
            `  1. Run \`${cmd}\` in the project folder.`,
            '  2. Type /login openai-codex and finish in the browser.',
            '',
            '  Only THAT login. Do not log in to Anthropic inside Pi: there the',
            '  Claude subscription bills per token as "extra usage". The Claude in',
            '  the FDAs runs through the official `claude` CLI, within the Pro/Max',
            '  plan limits.',
            '',
          ]
        : []),
      `Commands (inside \`${cmd}\`) — /fia loads the factory and shows where the project stands:`,
      '',
      '  /guide      lost? it reads the project state, confirms your goal and charts the shortest command route',
      '',
      'Decide and plan',
      '  /idea       not sure what to build — an interview until the PRD + stack are born (on an existing system: discovers a new MODULE)',
      '  /stack      decide pending stack layers + generate docs and tools',
      '  /grill      stress-test the PRD (decisions recorded in the document)',
      '  /prd        quick reviewer opinion on the PRD',
      '  /map        PRD → map + screens + tasks (opens the result in the browser)',
      '',
      'Build',
      '  /task       execute ONE task (FDA, fresh context)',
      '  /goal       all tasks until done',
      '  /feature    new feature on a mapped system — size triage → delta interview → delta spec + only the NEW tasks',
      '  /bug        fix a defect — reproduction first (a RED test that fails for the right reason), FDA second',
      '  /quick      small change (≤3 files): triage — simple runs now with guardrails, complex routes to /feature or /bug',
      '  /note       capture an idea in ai-docs/inbox.md and keep working — zero questions',
      '  /spec       write/update a durable spec (requirements + BDD scenarios) in ai-docs/specs/',
      '',
      'Design system and references',
      '  /component  add a component to the design system (registry + page)',
      '  /theme      change colors/fonts/shape — preview to approve, then apply',
      '  /design     layout redesign from references (images), within the design system',
      '  /example    put an external reference (repo, code, docs, screen) on the shelf: read, licensed, indexed',
      '',
      'Existing code',
      '  /absorb     EXISTING project → as-built PRD + map + stack manifest',
      '  /kit        EXISTING code → design-system audit: as-built registry, /ui-components, gaps vs the core kit, approved design-only tasks',
      '',
      'Ship and follow along',
      '  /launch     go live — public beta and real production (guided)',
      '  /agents     view/change each FDA agent\'s engine and model (visual editor)',
      '  /status     progress and latest runs',
      '',
      'Models: in Pi\'s interactive session use /model; the FDA agents are',
      'chosen in imp/fia.config.yaml (each agent with its engine and model).',
      'Visual timeline: npm run fda:viewer  ·  What /map created: npm run plan',
      'Terminal dashboard (tasks, specs, runs — live): npm run tui',
      'Checks: npm run env:check (dev keys the stack needs)  ·  npm run launch:check (before going live)',
      '',
      ...(ctx.impGlobal
        ? [
            'Tip: `imp` and `pi` open the same agent (`imp` adds the banner);',
            '`imp update` refreshes impactus and Pi in one go.',
          ]
        : [
            'Tip: with impactus installed globally (npm i -g impactus), `imp` opens',
            'this same Pi — banner included — and `imp update` refreshes both. Every',
            'command above works verbatim under `imp`.',
          ]),
    ].join('\n'),
    needsLogin ? 'FIA installed — last step: Codex login' : 'FIA installed — how to use it',
  );
}

async function stampTree(src, dest) {
  if (!existsSync(src)) throw new Error(`Missing template: ${src}`);
  await mkdir(dest, { recursive: true });
  await copySkipExisting(src, dest);
}

async function copySkipExisting(src, dest) {
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true });
      await copySkipExisting(from, to);
    } else if (!existsSync(to)) {
      await cp(from, to);
    }
  }
}

/** Every template file must exist in dest — a partial stamp is a hard error. */
async function verifyStamp(src, dest, label) {
  const missing = await missingFiles(src, dest);
  if (missing.length) {
    throw new Error(
      `Stamp of ${label}/ incomplete — ${missing.length} file(s) missing (e.g. ${label}/${missing[0]}). ` +
        'Run the installer again in the same folder: it completes what is missing without overwriting anything.',
    );
  }
}

async function missingFiles(src, dest, rel = '') {
  const out = [];
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await missingFiles(join(src, entry.name), join(dest, entry.name), relPath)));
    } else if (!existsSync(join(dest, entry.name))) {
      out.push(relPath);
    }
  }
  return out;
}

async function mergePackageJson(dir) {
  // In "harness only" mode in a folder without package.json the README
  // scripts (npm run fda:viewer, fda:sessions…) would not exist — the merge
  // creates a minimal one instead of skipping silently. Brownfield: a project
  // may already have a script with one of our names (e.g. its own `plan` or
  // `agents`) — it is NEVER clobbered, ours lands as `<name>:fia`.
  const { aliased } = await mergeFiaNpmScripts(dir);
  if (aliased.length) {
    ui.warn(
      `Your package.json already had npm scripts with these names — yours were kept and the FIA versions were added as: ${aliased.join(', ')}.`,
    );
  }
}

async function shouldInstallFia(ctx) {
  const { flags = {} } = ctx;
  if (flags.skipFia || flags.fia === false) return false;
  if (ctx.decisions?.fia === false) return false;
  if (flags.fia === true || ctx.decisions?.fia === true) return true;
  if (flags.yes) return true;
  if (ctx.mode === 'harness' && flags.fia === undefined && ctx.decisions?.fia === undefined) {
    return await ui.confirm({
      message: 'Install FIA (Pi + deterministic FDAs + orchestrator skill)?',
      initialValue: true,
    });
  }
  return ctx.decisions?.fia !== false;
}
