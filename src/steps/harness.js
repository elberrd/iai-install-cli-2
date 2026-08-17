import { existsSync, lstatSync, mkdtempSync, readdirSync } from 'node:fs';
import { readFile, writeFile, rm, cp, rename, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { HARNESS } from '../config.js';
import { presentAgentFiles, backupAgentFiles } from '../lib/agent-backup.js';
import { run } from '../lib/proc.js';
import { downloadErrorMessage, fetchTemplateToDir } from '../lib/template-fetch.js';
import { collectHarnessManifest, writeHarnessManifest } from '../lib/harness-manifest.js';
import { migrateLegacyFiaLayout } from './update-runtime.js';
import { toolPending } from './preflight.js';
import * as ui from '../lib/ui.js';

/**
 * The Harness — an agent-workflow scaffold (/start, /dev, /sv, /test-ui, /team,
 * …) with 9 specialist agents, slash commands and skills for Claude Code AND
 * Cursor, downloaded EXCLUSIVELY through the community's gated API (paying
 * student token) and MERGED into the target folder. It is the BASE of the
 * installer: always installed, in both modes.
 *
 * "Merged" because the project may already ship its own AGENTS.md/CLAUDE.md and
 * .claude/skills (the live1 template, or a pre-existing project in "harness
 * only" mode) — the harness must adapt to it, never clobber it:
 *   - files that already exist in the project are NEVER overwritten
 *     (`cp` with force:false), and symlinks are preserved verbatim
 *     (.cursor/agents/* and .agents/* are symlinks into .claude/) — every
 *     file kept this way is LISTED after the merge, so the "add" policy
 *     never hides a conflict;
 *   - the harness README.md lands as imp/HARNESS.md — the project README wins;
 *   - the harness AGENTS.md is APPENDED to the project's AGENTS.md between
 *     harness markers (idempotent: markers present ⇒ nothing to do);
 *   - skills a template MAY also ship (HARNESS.templateOwnedPaths, e.g.
 *     frontend-profissional) are discarded in full mode ONLY when the
 *     installed template actually brought that path — the template's variant
 *     wins there; every path the template did not ship (and everything in
 *     harness-only mode) comes from the harness, the single source.
 *
 * In 'full' mode it runs last (after GitHub/Vercel) and makes its own
 * best-effort commit. In 'harness' mode the folder may not have a git repo
 * yet — we initialize one before committing.
 *
 * Flags: in 'full' mode, --no-harness / --skip-harness still skip the step
 * (for whoever wants the bare template). In 'harness' mode these flags are
 * ignored with a warning, because without the harness there would be nothing
 * left to install.
 */
export async function setupHarness(ctx) {
  const { dir, flags = {} } = ctx;
  const harnessOnly = ctx.mode === 'harness';

  // Projects from older versions keep HARNESS.md (and fia/, iai.config.json)
  // at the root — migrate before the merge, or the copy below would add a
  // SECOND guide at imp/HARNESS.md next to the legacy root one.
  await migrateLegacyFiaLayout(dir);

  if (flags.skipHarness || flags.harness === false) {
    if (harnessOnly) {
      ui.warn('--no-harness/--skip-harness ignored in "harness only" mode (nothing would be left to install).');
    } else {
      ui.info('Harness skipped.');
      ui.note(howToLater(), 'How to install the harness later');
      return;
    }
  }

  // ── Download (community API — the ONLY path) ───────────────────────────────
  // With a student token the request is authenticated; without one (guest
  // mode — sign-in declined in steps/auth.js) the server hands the harness
  // out anonymously: harness + FIA are the free tier. The TEMPLATES remain
  // token-gated (steps/project.js) and steps/mode.js never lets a guest reach
  // them. There is no direct-clone fallback in either case.
  const tmpRoot = mkdtempSync(join(tmpdir(), 'impactus-harness-'));
  const tmpClone = join(tmpRoot, 'repo');
  try {
    await ui.spin(
      'Downloading the harness…',
      async () => {
        const res = await fetchTemplateToDir(ctx.apiBase, ctx.authToken ?? null, 'harness', tmpClone);
        if (!res.ok) {
          throw new Error(downloadErrorMessage('harness', res.reason));
        }
      },
      'Harness downloaded.',
    );

    // ── Adapt to the template before merging ─────────────────────────────────
    // README.md → imp/HARNESS.md (the project keeps its own README). readmeAs
    // lives inside imp/ — create the folder in the clone before the rename.
    if (existsSync(join(tmpClone, 'README.md'))) {
      await mkdir(dirname(join(tmpClone, HARNESS.readmeAs)), { recursive: true });
      await rename(join(tmpClone, 'README.md'), join(tmpClone, HARNESS.readmeAs));
    }
    // AGENTS.md is merged by hand below — keep it out of the bulk copy.
    let harnessAgents = null;
    if (existsSync(join(tmpClone, 'AGENTS.md'))) {
      harnessAgents = await readFile(join(tmpClone, 'AGENTS.md'), 'utf8');
      await rm(join(tmpClone, 'AGENTS.md'), { force: true });
    }
    // Skills a template MAY also ship (e.g. frontend-profissional): in full
    // mode the merge runs AFTER installTemplate, so the destination already
    // reflects the template — for each shared path that the template actually
    // brought, discard the harness copy so the merge doesn't mix versions.
    // Paths the template did NOT ship stay in the clone: the harness is the
    // single source for them (e.g. templates without .cursor/ still get the
    // four professional skills in Cursor).
    if (!harnessOnly) {
      for (const rel of ownedPathsToDiscard(HARNESS.templateOwnedPaths, dir)) {
        await rm(join(tmpClone, rel), { recursive: true, force: true });
      }
    }

    // ── Conflict policy (a project that already had agent files) ─────────────
    // Decided earlier in selectInstallMode; applied here in harness mode ONLY —
    // in full mode installTemplate already applied it BEFORE the template copy
    // (backing up here would move the template's own fresh files). 'replace'
    // moves the current agent files to .agents-backup-<date>/ — never deletes.
    if (harnessOnly && ctx.agentFilesPolicy === 'replace') {
      const present = presentAgentFiles(dir);
      if (present.length) {
        const backupDir = await backupAgentFiles(dir, present);
        ctx.agentFilesBackup = backupDir;
        ui.success(`Previous agent files moved to ${basename(backupDir)}/.`);
      }
    }

    // ── Merge: copy everything that does not exist yet ───────────────────────
    // cp resolves every collision silently (force:false keeps the project's
    // file) — collect them BEFORE copying so they can be reported after.
    const keptFiles = mergeSkips(tmpClone, dir);
    await ui.spin(
      'Merging the harness into the project…',
      () =>
        cp(tmpClone, dir, {
          recursive: true,
          force: false, // NEVER overwrite project files
          errorOnExist: false, // existing file ⇒ silently keep the project's
          verbatimSymlinks: true, // .cursor/agents + .agents are symlinks
        }),
      'Harness merged (existing files were preserved).',
    );
    reportKeptFiles(keptFiles, { harnessOnly });

    if (harnessAgents) {
      const result = await mergeAgentsMd(join(dir, 'AGENTS.md'), harnessAgents);
      if (result === 'appended') ui.success('AGENTS.md: harness instructions appended.');
      else if (result === 'created') ui.success('AGENTS.md created with the harness instructions.');
      else ui.info('AGENTS.md already contained the harness block — kept.');
    }

    // Stamp manifest — sha per file the (adapted) clone shipped, the baseline
    // `imp doctor` classifies against and `imp fix` restores from. Files the
    // merge KEPT record the harness sha on purpose ("differs from the stamp"
    // is the truth for them). Best-effort: a failure here never aborts the
    // install — doctor/fix just skip the harness checks.
    try {
      await writeHarnessManifest(dir, await collectHarnessManifest(tmpClone));
      ui.info('Harness stamp manifest recorded (imp/.harness-manifest.json — read by imp doctor/fix).');
    } catch (err) {
      ui.warn(`Could not record the harness manifest: ${err?.message || err} — imp doctor/fix will skip the harness checks.`);
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }

  // ── Commit (best-effort) ───────────────────────────────────────────────────
  // In 'full' mode the repo was already created by installTemplate; in
  // "harness only" mode the folder may not have git yet — initialize before committing.
  if (!existsSync(join(dir, '.git'))) {
    await run('git', ['init', '-q'], { cwd: dir });
  }
  await run('git', ['add', '-A'], { cwd: dir });
  const commit = await run('git', ['commit', '-q', '-m', 'feat: agent workflow harness (impactus)'], {
    cwd: dir,
  });
  if (commit.ok) {
    ui.success('Harness commit created.');
    if (ctx.repoUrl) {
      const push = await run('git', ['push'], { cwd: dir });
      if (push.ok) ui.success('Harness pushed to GitHub.');
      else ui.warn('Could not push the harness — run `git push` in the project folder.');
    }
  } else if (toolPending(ctx, 'git')) {
    // Git was skipped in the preflight — say why there is no commit instead
    // of failing silently; the final summary carries the manual fix.
    ui.info('Git not available — the harness was not committed (see the final summary).');
  }

  ctx.harnessInstalled = true;
  ui.note(
    [
      '1. Fill in the PRD in ai-docs/PRD.md (replace every {{placeholder}}).',
      '2. (Recommended) Run /grill to sharpen the PRD — one question at a time.',
      '3. Open Claude Code or Cursor in the project folder and run /start.',
      '4. Then iterate with /dev (test-first), /sv and /test-ui.',
      '',
      `Full guide: ${HARNESS.readmeAs}.`,
    ].join('\n'),
    'Harness installed — how to use it',
  );
}

/**
 * Which of the template-ownable paths should be dropped from the harness clone
 * before the merge: exactly those the installed template actually shipped
 * (i.e. that already exist in the destination). Pure decision — the fs check
 * is injectable for tests.
 * @param {string[] | undefined} templateOwnedPaths relative paths a template MAY own
 * @param {string} destDir project directory (already reflects the template)
 * @param {(path: string) => boolean} [exists] defaults to fs.existsSync
 * @returns {string[]} relative paths to discard from the harness copy
 */
export function ownedPathsToDiscard(templateOwnedPaths, destDir, exists = existsSync) {
  return (templateOwnedPaths ?? []).filter((rel) => exists(join(destDir, rel)));
}

/**
 * Which files of the harness clone the merge will SKIP because the destination
 * already has something at that path (`cp` with force:false keeps the
 * project's version silently). Walks the clone: a directory present on both
 * sides is merged (recursed into), so only real collisions are listed — a
 * file, a symlink (broken ones count: lstat, no follow), or a type mismatch
 * (then the whole subtree is blocked and listed once).
 * @param {string} srcDir the adapted harness clone
 * @param {string} destDir project directory
 * @returns {string[]} project-root-relative paths, forward slashes, sorted
 */
export function mergeSkips(srcDir, destDir) {
  const skipped = [];
  const walk = (rel) => {
    for (const entry of readdirSync(join(srcDir, rel), { withFileTypes: true })) {
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      const destStat = lstatSync(join(destDir, entryRel), { throwIfNoEntry: false });
      if (!destStat) continue; // missing at the destination ⇒ cp copies it whole
      if (entry.isDirectory() && !entry.isSymbolicLink() && destStat.isDirectory()) {
        walk(entryRel);
      } else {
        skipped.push(entryRel);
      }
    }
  };
  walk('');
  return skipped.sort();
}

/** The post-merge report for the collisions `mergeSkips` found (if any). */
function reportKeptFiles(keptFiles, { harnessOnly = true } = {}) {
  if (!keptFiles.length) return;
  const MAX_LISTED = 15; // keep the box readable on big overlaps (e.g. a re-run)
  const listed = keptFiles.slice(0, MAX_LISTED);
  if (keptFiles.length > MAX_LISTED) listed.push(`… and ${keptFiles.length - MAX_LISTED} more`);
  // Full mode: the template landed FIRST, so these collisions are files the
  // template deliberately ships (e.g. its as-built ai-docs/components/
  // registry.md) — keeping them IS the design, and `--agent-files replace`
  // could not adopt the harness copy here anyway (the backup step runs before
  // the template copy). Only harness-only mode gets that advice.
  const advice = harnessOnly
    ? [
        '',
        'To adopt the harness version of the agent files instead, run the',
        'installer again with --agent-files replace (the current ones move to',
        '.agents-backup-<date>/ — nothing is deleted).',
      ]
    : [
        '',
        "These are the template's files — its version is the source of truth",
        'for them (the as-built component registry, for example), so this is',
        'the intended outcome, not a conflict to resolve.',
      ];
  ui.note(
    [
      harnessOnly
        ? 'These files already existed, so YOUR version was kept and the harness'
        : 'These files came with the template, so ITS version was kept and the harness',
      'copy was not applied:',
      '',
      ...listed,
      ...advice,
    ].join('\n'),
    `Kept ${keptFiles.length} existing file${keptFiles.length === 1 ? '' : 's'}`,
  );
}

/**
 * Append the harness agent instructions to the project's AGENTS.md between
 * markers. Idempotent: if the start marker is already there, do nothing.
 * Exported for `imp fix` (restoring a deleted harness block reuses the exact
 * same merge).
 * @returns {Promise<'appended'|'created'|'skipped'>}
 */
export async function mergeAgentsMd(projectFile, harnessContent) {
  const block = [HARNESS.markerStart, '', harnessContent.trim(), '', HARNESS.markerEnd].join('\n');
  if (!existsSync(projectFile)) {
    await writeFile(projectFile, block + '\n', 'utf8');
    return 'created';
  }
  const current = await readFile(projectFile, 'utf8');
  if (current.includes(HARNESS.markerStart)) return 'skipped';
  await writeFile(projectFile, current.trimEnd() + '\n\n' + block + '\n', 'utf8');
  return 'appended';
}

function howToLater() {
  return [
    'To add the harness later, run the installer again in the project folder,',
    'in "harness only" mode (the download requires the student login):',
    '',
    '  npx impactus --dir . --harness-only',
    '',
    'The merge never overwrites anything that already exists; then follow the',
    `guide in ${HARNESS.readmeAs} (fill in ai-docs/PRD.md and run /start).`,
  ].join('\n');
}
