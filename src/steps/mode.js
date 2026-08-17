import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as ui from '../lib/ui.js';
import { presentAgentFiles } from '../lib/agent-backup.js';
import { parseStackFlag } from '../lib/stack.js';
import { hasStateMarker } from './project.js';

/**
 * First real choice of the installer (right after name/folder): how to start.
 *
 * Besides the mode (harness | full), this is where the STACK PATH is born
 * (`ctx.stackPath`):
 *
 *   - 'template'   → IAI recommended stack (Next.js + Convex + Clerk + R2):
 *                    full mode — downloads the ready-made template and runs
 *                    the whole stack.
 *   - 'custom'     → build your own stack layer by layer (Convex OR
 *                    Hono + Neon/Supabase + Drizzle/Prisma…): harness mode —
 *                    the agent builds the app guided by the ai-docs/stack.md
 *                    manifest. Any layer can be left for "later".
 *   - 'discover'   → the person doesn't know what they need yet: harness mode
 *                    with EVERYTHING pending — Pi (/idea) extracts the PRD +
 *                    stack later.
 *   - 'brownfield' → existing project: harness mode; /absorb maps the real
 *                    stack and fills in the manifest.
 *
 * The harness is always installed on every path. Result goes to `ctx.mode`
 * and `ctx.stackPath` (--stack choices land in `ctx.stackFlagChoices` for the
 * prelude's "Your stack" step).
 *
 * Flag precedence: --stack > --mode/--harness-only > --yes.
 */
export async function selectInstallMode(ctx) {
  const { flags = {} } = ctx;

  // A leftover state marker means a PREVIOUS full install of this folder died
  // midway — that is a resume, never an "existing project": steering it into
  // brownfield/harness-only would leave the half-copied template as-is, and a
  // later fresh full run would duplicate the cloud resources (Convex/Clerk).
  ctx.resumingInstall = Boolean(ctx.dir) && hasStateMarker(ctx.dir);

  // Existing project: a folder the CLI didn't create that already has
  // package.json or git. Changes the default (harness only) and the final
  // guidance (/absorb).
  ctx.existingProject =
    !ctx.resumingInstall && !ctx.createdDir && Boolean(ctx.dir) &&
    (existsSync(join(ctx.dir, 'package.json')) || existsSync(join(ctx.dir, '.git')));

  // ── Guest mode (no sign-in): only harness paths exist ──────────────────────
  // The template download and its whole automation are token-gated
  // (steps/auth.js already announced the limitation). A flag that forces the
  // template is a HARD error — silently downgrading a scripted full install
  // would surprise whoever wrote the script.
  const guest = Boolean(ctx.guest);
  const needsSignIn = (what) =>
    new Error(
      `${what} needs the community sign-in — run the installer again and choose "Sign in" ` +
        '(or authenticate first with `npx impactus --login`; automation uses IMPACTUS_TOKEN).',
    );
  if (guest && ctx.resumingInstall) {
    // The leftover marker means a half-finished FULL install: only the gated
    // template flow can resume it safely (see the resume note further down).
    throw needsSignIn('Resuming the unfinished template install in this folder');
  }

  // ── --stack decides path AND mode ──────────────────────────────────────────
  if (flags.stack != null) {
    const parsed = parseStackFlag(flags.stack);
    // An unrecognized value must NOT silently change the install type —
    // abort like any other invalid flag (--mode, --preset…).
    if (!parsed.path) {
      throw new Error(parsed.errors.join('\n') || `--stack: invalid value "${flags.stack}".`);
    }
    for (const err of parsed.errors) ui.warn(err);
    const impliedMode = parsed.path === 'template' ? 'full' : 'harness';
    if (guest && impliedMode === 'full') {
      throw needsSignIn(`--stack ${flags.stack} (the ready-made template)`);
    }
    if ((flags.mode === 'full' || flags.mode === 'harness') && flags.mode !== impliedMode) {
      throw new Error(
        `--mode ${flags.mode} conflicts with --stack ${flags.stack} — the recommended stack is the template (full); ` +
          'a custom/pending stack installs only the harness. Use one flag or the other.',
      );
    }
    ctx.mode = impliedMode;
    ctx.stackPath =
      parsed.path === 'discover' && ctx.existingProject ? 'brownfield' : parsed.path;
    ctx.stackFlagChoices = parsed.choices;
    ui.info(`Mode: ${modeLabel(ctx.mode)} (--stack ${flags.stack}).`);
    return agentFilesPolicy(ctx);
  }

  if (flags.mode === 'harness' || flags.mode === 'full') {
    if (guest && flags.mode === 'full') throw needsSignIn('--mode full (harness + template)');
    ctx.mode = flags.mode;
    ctx.stackPath =
      flags.mode === 'full' ? 'template' : ctx.existingProject ? 'brownfield' : 'discover';
    ui.info(`Mode: ${modeLabel(ctx.mode)}.`);
    return agentFilesPolicy(ctx);
  }

  if (flags.yes) {
    if (guest) {
      ctx.mode = 'harness';
      ctx.stackPath = ctx.existingProject ? 'brownfield' : 'discover';
      ui.info('Mode: harness only (not signed in — the template is unavailable).');
      return agentFilesPolicy(ctx);
    }
    ctx.mode = ctx.existingProject ? 'harness' : 'full';
    ctx.stackPath = ctx.existingProject ? 'brownfield' : 'template';
    ui.info(
      ctx.existingProject
        ? 'Mode: harness only (existing project detected). Use --mode full to force the template.'
        : 'Mode: harness + template (the --yes default). Use --mode harness for harness only.',
    );
    return agentFilesPolicy(ctx);
  }

  // ── Existing project: the path is to absorb, not pick a stack ──────────────
  if (ctx.existingProject) {
    ui.note(
      [
        'I detected an EXISTING project in this folder (package.json/git).',
        'The recommended path is to install just the harness + FIA on top — none',
        'of your files are overwritten — and then run /onboarding in `pi`: one',
        'guided pass (/absorb → /stack → /kit) that maps the system (as-built',
        'PRD, map, conventions, stack manifest, design-system audit) and leaves',
        'it ready for /idea or /feature.',
      ].join('\n'),
      'Existing project',
    );
    // Guest: "harness + template" does not exist — the recommended path is the
    // only one, so there is nothing to select.
    if (guest) {
      ctx.mode = 'harness';
      ctx.stackPath = 'brownfield';
      ui.info('Mode: harness only (the "harness + template" option needs the community sign-in).');
      return agentFilesPolicy(ctx);
    }
    const mode = await ui.select({
      message: 'Choose what to install:',
      initialValue: 'harness',
      options: [
        {
          value: 'harness',
          label: 'Harness only',
          hint: 'recommended — merges the agent workflow into your project',
        },
        {
          value: 'full',
          label: 'Harness + template',
          hint: 'not recommended — this folder already has a project',
        },
      ],
    });
    ctx.mode = mode;
    ctx.stackPath = mode === 'full' ? 'template' : 'brownfield';
    ui.success(`Mode: ${modeLabel(mode)}.`);
    return agentFilesPolicy(ctx);
  }

  // ── Unfinished previous install: recommend continuing the full install ─────
  if (ctx.resumingInstall) {
    ui.note(
      [
        'A previous installation of this folder did not finish.',
        'Recommended: continue the full install (first option below) — it',
        'resumes in place and REUSES what was already created (the folder,',
        '.env.local and any cloud resources), instead of duplicating them.',
      ].join('\n'),
      'Unfinished installation detected',
    );
  }

  // ── New project: the three paths (two without sign-in) ─────────────────────
  ui.note(
    [
      'The harness (agent workflow: /start, /dev, /sv, /launch…) is ALWAYS',
      'installed. The question is HOW to start the project:',
      '',
      guest
        ? '  • Recommended stack (ready-made template) — LOCKED: it needs the\n' +
          '    community sign-in. Run the installer again and sign in to use it.'
        : '  • Recommended stack — ready-made template: Next.js + Convex (database+\n' +
          '    backend with no API layer) + Clerk (login) + Cloudflare R2 (files) +\n' +
          '    Vercel. The fastest path: up and running in minutes.',
      '  • Build my own stack — you choose layer by layer (e.g. without Convex',
      '    you get your own API with Hono + Neon/Supabase database + Drizzle ORM)',
      '    and the agent builds the app guided by the docs the system generates.',
      '    Any layer can be left as "decide later".',
      '  • Not sure yet — installs the harness and you decide by talking to Pi:',
      '    /idea interviews you, extracts the PRD and recommends the best stack.',
    ].join('\n'),
    'How to start?',
  );

  const path = await ui.select({
    message: 'How do you want to start?',
    initialValue: guest ? 'custom' : 'template',
    options: [
      guest
        ? null
        : {
            value: 'template',
            label: 'Recommended stack (ready-made template)',
            hint: 'Next.js + Convex + Clerk + R2 — the fastest path',
          },
      {
        value: 'custom',
        label: 'Build my own stack',
        hint: 'choose layer by layer — parts can be left for later',
      },
      {
        value: 'discover',
        label: "I don't know what I need yet",
        hint: 'installs the harness; Pi (/idea) extracts the PRD and stack with you',
      },
    ].filter(Boolean),
  });

  ctx.stackPath = path;
  ctx.mode = path === 'template' ? 'full' : 'harness';
  ui.success(`Mode: ${modeLabel(ctx.mode)}.`);
  await agentFilesPolicy(ctx);
}

/**
 * Conflict policy when the target already has agent files (.claude, .cursor,
 * CLAUDE.md, .cursorrules… — see lib/agent-backup.js). Asked HERE so every
 * decision still happens up front, in BOTH modes. Applied later by
 * setupHarness (harness mode) or installTemplate (full mode — the template
 * ships its own .claude/CLAUDE.md, and the plain copy would clobber them):
 *   - 'add'     → the usual default: only copies what's missing, nothing is touched.
 *   - 'replace' → moves the current ones to .agents-backup-<date>/ and installs the new ones.
 * App code, ai-docs/, docs/, AGENTS.md (append) and mcp.json always stay out.
 */
async function agentFilesPolicy(ctx) {
  const { flags = {} } = ctx;
  // Resuming a half-finished FULL install: the agent files in the folder are
  // the template's own half-copied tree, not the user's — nothing to ask.
  if (!ctx.dir || ctx.resumingInstall) return;
  const present = presentAgentFiles(ctx.dir);
  if (!present.length) return;

  if (flags.agentFiles === 'add' || flags.agentFiles === 'replace') {
    ctx.agentFilesPolicy = flags.agentFiles;
  } else if (flags.yes) {
    ctx.agentFilesPolicy = 'add';
  } else {
    const incoming = ctx.mode === 'full' ? 'template + harness' : 'harness';
    ctx.agentFilesPolicy = await ui.select({
      message: `This folder already has agent files (${present.join(', ')}). What should I do?`,
      initialValue: 'add',
      options: [
        {
          value: 'add',
          label: 'Add only what is missing',
          hint: 'recommended — your current files are preserved',
        },
        {
          value: 'replace',
          label: `Replace with the ${incoming} ones`,
          hint: `moves the current ones to .agents-backup-<date>/ (nothing is deleted)`,
        },
      ],
    });
  }
  ui.info(
    ctx.agentFilesPolicy === 'replace'
      ? 'Agent-files policy: replace (with automatic backup).'
      : 'Agent-files policy: add only what is missing.',
  );
}

function modeLabel(mode) {
  return mode === 'harness' ? 'harness only' : 'harness + template';
}
