import { existsSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SHADCN } from '../config.js';
import { run, runInherit } from '../lib/proc.js';
import { classifyBlockChanges, isImported, parseStatus } from '../lib/shadcn-guard.js';
import { tokenize } from '../lib/util.js';
import * as ui from '../lib/ui.js';

/**
 * Optional step: customize the shadcn/ui setup of the freshly installed project.
 *
 * Two independent choices:
 *   1. Preset — apply a custom design preset generated at ui.shadcn.com/create
 *      ("Get Code"). The user pastes the full command (e.g.
 *      `npx shadcn@latest init --preset b0`) or just the preset code.
 *   2. Block — install a ready-made block. The classic default is
 *      `sidebar-07`, but the user can pick another from the curated list,
 *      type any block name, or skip entirely.
 *
 * Failures are non-fatal: the template already ships with a working shadcn/ui
 * setup. But the step is NOT hands-off anymore — three guard-rails protect the
 * template from the registry (each documented at its function):
 *   - hooks/use-mobile.ts is backed up and restored (lint gate);
 *   - `add` runs deterministically (-y -o) and application code is restored
 *     from the git baseline afterwards (see protectAppCode);
 *   - a final `tsc --noEmit` warns when the step left the app uncompilable.
 *
 * Flags: --skip-shadcn, --shadcn-preset <code|command>,
 * --shadcn-block <a,b|none>. With --yes: no preset, default block.
 */
export async function setupShadcn(ctx) {
  const { dir, flags } = ctx;

  if (flags.skipShadcn) {
    ui.info('Skipped (--skip-shadcn): keeping the template\'s default shadcn/ui.');
    return;
  }

  // The decision (preset + blocks) was made in the decisions phase. With no
  // customization chosen, there is nothing to run here.
  const d = ctx.decisions;
  if (d && d.shadcnPreset == null && (d.shadcnBlocks == null || d.shadcnBlocks.length === 0)) {
    ui.info('Keeping the template\'s default shadcn/ui (no customization chosen).');
    return;
  }

  const interactive = !flags.yes && !d;
  if (interactive && !flags.shadcnPreset && !flags.shadcnBlock) {
    ui.note(
      [
        'The template already ships with shadcn/ui configured and working.',
        'Here you can (optionally) customize:',
        '',
        `1. Apply a custom visual PRESET — create yours at ${SHADCN.createUrl}`,
        '   (style, colors, font, icons, radius) and paste the "Get Code" command.',
        `2. Install a ready-made BLOCK (default: ${SHADCN.defaultBlock}) — catalog at`,
        `   ${SHADCN.blocksUrl}`,
      ].join('\n'),
      'shadcn/ui — customization (optional)',
    );
  }

  // hooks/use-mobile.ts: the registry version uses setState inside useEffect
  // and fails react-hooks/set-state-in-effect — since the template's lefthook
  // runs eslint on pre-commit, EVERY commit would start failing (including the
  // CLI's own commit in the GitHub step). The template's version exports the
  // same useIsMobile (drop-in), so we back it up before and restore it after.
  const useMobilePath = join(dir, 'hooks', 'use-mobile.ts');
  const useMobileBackup = existsSync(useMobilePath) ? await readFile(useMobilePath, 'utf8') : null;

  await maybeApplyPreset(ctx, dir);
  await maybeInstallBlock(ctx, dir);

  if (useMobileBackup != null && existsSync(useMobilePath)) {
    const now = await readFile(useMobilePath, 'utf8');
    if (now !== useMobileBackup) {
      await writeFile(useMobilePath, useMobileBackup, 'utf8');
      ui.info('hooks/use-mobile.ts restored (the registry version fails the template\'s eslint).');
    }
  }

  await typecheckAfterShadcn(ctx, dir);
}

/**
 * Final safety net: a preset/block can leave type errors behind (e.g. a custom
 * component overwritten by a registry namesake with a different API) and today
 * nothing compiles until the student runs `next build` on their own. Warn-only
 * — the step's philosophy stays non-fatal.
 */
async function typecheckAfterShadcn(ctx, dir) {
  if (!ctx.shadcnPreset && !ctx.shadcnBlocks) return;
  ui.step('Checking that the project still compiles (npx tsc --noEmit)…');
  const t = await run('npx', ['tsc', '--noEmit'], { cwd: dir, timeout: 240000 });
  if (t.ok) {
    ui.success('TypeScript OK after the shadcn customization.');
    return;
  }
  const lines = `${t.stdout}\n${t.stderr}`.trim().split('\n');
  const head = lines.slice(0, 15).join('\n');
  ui.warn(
    [
      'The shadcn customization left TypeScript errors — the build may fail:',
      head,
      lines.length > 15 ? `(… ${lines.length - 15} more line(s) — run npx tsc --noEmit in the project folder)` : '',
      'To undo an overwrite: git diff <file> (view) and git checkout -- <file> (revert).',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

// ── 1. Custom preset / custom command ───────────────────────────────────────

async function maybeApplyPreset(ctx, dir) {
  const { flags } = ctx;

  // Decision already made in the decisions phase → never ask again.
  if (ctx.decisions) {
    if (!ctx.decisions.shadcnPreset) return;
    return applyPresetCommand(ctx, dir, ctx.decisions.shadcnPreset);
  }

  let answer = flags.shadcnPreset ? String(flags.shadcnPreset).trim() : null;

  if (!answer) {
    if (flags.yes) return; // no preset in non-interactive mode
    const wantsPreset = await ui.confirm({
      message: 'Apply a custom preset from shadcn/create?',
      initialValue: false,
    });
    if (!wantsPreset) return;
    answer = String(
      await ui.text({
        message: 'Paste the "Get Code" command (or just the preset code):',
        placeholder: 'npx shadcn@latest init --preset b0   —   or just: b0',
        validate: (v) => (v && v.trim() ? undefined : 'Paste the command or the preset code.'),
      }),
    ).trim();
  }

  return applyPresetCommand(ctx, dir, answer);
}

// Full command pasted → run it verbatim. Bare preset code → wrap it in
// `shadcn apply`, the recommended command for an existing project (the
// template already has a components.json).
async function applyPresetCommand(ctx, dir, answer) {
  let bin;
  let args;
  if (/\s/.test(answer)) {
    [bin, ...args] = tokenize(answer);
  } else {
    bin = 'npx';
    args = ['shadcn@latest', 'apply', answer];
  }

  ui.step(`Applying preset: ${bin} ${args.join(' ')}`);
  const r = await runInherit(bin, args, { cwd: dir });
  if (r.ok) {
    ctx.shadcnPreset = answer;
    ui.success('shadcn preset applied.');
  } else {
    ui.warn(
      [
        'The preset command failed — the template keeps the default look.',
        'You can try again later, inside the project folder:',
        `  ${bin} ${args.join(' ')}`,
      ].join('\n'),
    );
  }
}

// ── 2. Block selection ──────────────────────────────────────────────────────

async function maybeInstallBlock(ctx, dir) {
  const { flags } = ctx;
  let blocks = null;

  if (ctx.decisions) {
    // Decision already made in the decisions phase.
    blocks = ctx.decisions.shadcnBlocks;
    if (!blocks || blocks.length === 0) {
      ui.info('No block installed (assembly decision).');
      return;
    }
  } else if (flags.shadcnBlock) {
    const value = String(flags.shadcnBlock).trim();
    if (value.toLowerCase() === 'none') {
      ui.info('No block installed (--shadcn-block none).');
      return;
    }
    blocks = value.split(/[\s,]+/).filter(Boolean);
  } else if (flags.yes) {
    blocks = [SHADCN.defaultBlock]; // classic behavior in -y mode
  } else {
    const options = [
      ...SHADCN.blocks.map((b) => ({
        value: b.name,
        label: b.name === SHADCN.defaultBlock ? `${b.name} (default)` : b.name,
        hint: b.description,
      })),
      { value: '__custom__', label: 'Another block…', hint: `type the name — catalog: ${SHADCN.blocksUrl}` },
      { value: '__skip__', label: 'Don\'t install any block' },
    ];

    const choice = await ui.select({
      message: 'Which shadcn/ui block should be installed?',
      options,
      initialValue: SHADCN.defaultBlock,
    });

    if (choice === '__skip__') {
      ui.info('No block installed.');
      return;
    }
    if (choice === '__custom__') {
      const answer = String(
        await ui.text({
          message: 'Block name(s) — separate multiple with spaces:',
          placeholder: 'dashboard-01 login-03',
          validate: (v) => (v && v.trim() ? undefined : 'Provide at least one block.'),
        }),
      ).trim();
      blocks = answer.split(/[\s,]+/).filter(Boolean);
    } else {
      blocks = [choice];
    }
  }

  // The add runs DETERMINISTIC (-y -o): no shadcn overwrite prompts in the
  // middle of the install (which a beginner answers wrong and which without a
  // TTY don't even show up). The -o overwrites even the template's APPLICATION
  // code (the real app-sidebar becomes an "Acme Inc" demo, nav-user loses the
  // app's only logout, the dashboard page becomes an example) — which is why
  // the guard-rail after the add restores app code from the git baseline
  // (committed in installTemplate) and deletes unused demo files. The block's
  // value — components/ui/*, hooks/*, lib/* and the deps — stays.
  ui.info('The app code (template sidebar/nav/pages) is preserved — the block contributes the UI components.');
  const before = await gitPorcelain(dir);
  ui.step(`Installing block(s): npx shadcn@latest add -y -o ${blocks.join(' ')}`);
  const r = await runInherit('npx', ['shadcn@latest', 'add', '-y', '-o', ...blocks], { cwd: dir });
  if (r.ok) {
    ctx.shadcnBlocks = blocks;
    await protectAppCode(dir, before);
    ui.success(`Block(s) installed: ${blocks.join(', ')}.`);
  } else {
    ui.warn(
      [
        'The block install failed — you can run it later, in the project folder:',
        `  npx shadcn@latest add ${blocks.join(' ')}`,
      ].join('\n'),
    );
  }
}

// ── Block guard-rail ────────────────────────────────────────────────────────

/** `git status --porcelain` → Map (null when there is no git — no guard-rail). */
async function gitPorcelain(dir) {
  const s = await run('git', ['status', '--porcelain'], { cwd: dir });
  return s.ok ? parseStatus(s.stdout) : null;
}

/**
 * After the `add -y -o`: restores overwritten application code (via git,
 * against the baseline committed in installTemplate) and removes new
 * application files nobody imports (the block's demo: nav-main,
 * team-switcher…). The comparison uses the status CHANGE between before/after
 * the add, so whatever other steps had already touched (e.g. the deps step's
 * package.json) is left alone. Pure classification in src/lib/shadcn-guard.js.
 */
async function protectAppCode(dir, before) {
  if (!before) return;
  const after = await gitPorcelain(dir);
  if (!after) return;
  const { restore, created } = classifyBlockChanges(before, after);

  if (restore.length) {
    const rv = await run('git', ['checkout', '--', ...restore], { cwd: dir });
    if (rv.ok) ui.info(`App code preserved (block demo discarded): ${restore.join(', ')}`);
    else ui.warn(`Couldn't restore: ${restore.join(', ')} — check with git diff.`);
  }

  if (created.length) {
    const sources = await readProjectSources(dir, created);
    for (const file of created) {
      if (isImported(file, sources)) continue;
      await rm(join(dir, file), { force: true });
      ui.info(`Removed unused demo file: ${file}`);
    }
  }
}

/** Contents of the project's .ts/.tsx sources (minus the removal candidates). */
async function readProjectSources(dir, excludeRel) {
  const exclude = new Set(excludeRel);
  const out = [];
  const walk = async (rel) => {
    const abs = join(dir, rel);
    if (!existsSync(abs)) return;
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(childRel);
      else if (/\.(tsx|ts)$/.test(entry.name) && !exclude.has(childRel)) {
        out.push(await readFile(join(dir, childRel), 'utf8'));
      }
    }
  };
  for (const root of ['app', 'components', 'lib', 'hooks']) await walk(root);
  return out;
}
