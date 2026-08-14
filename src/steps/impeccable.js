// Impeccable (impeccable.style) — open-source design skill for the agents.
//
// Installs the `/impeccable` skill (craft, audit, polish, typeset… — 23
// subcommands) at PROJECT scope, for the providers this install's stamp
// actually has: .claude/ and .cursor/ (harness, always) and .pi/ (when the
// FIA came in). Free, Apache-2.0, no account or API key — runs within the
// subscriptions the student already has.
//
// Fixed decisions of this integration (see IMPECCABLE in src/config.js):
// - `--no-hooks`: its PostToolUse hook writes to `.impeccable/` on every
//   edit; inside an FDA the permission gate would revert that as an external
//   change in every phase. The interactive commands don't depend on the hook.
// - explicit `--scope=project`: with a non-TTY stdin its installer reads
//   answers from stdin and the scope default is global — never trust the
//   default in automation.
// - A failure here NEVER brings down the install: the skill is an extra, the
//   student can run `npx impeccable install` later.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { IMPECCABLE } from '../config.js';
import { run } from '../lib/proc.js';
import * as ui from '../lib/ui.js';

export async function setupImpeccable(ctx) {
  const { dir } = ctx;

  if (!(await shouldInstall(ctx))) {
    ui.info('Impeccable skipped.');
    return;
  }

  if (!nodeAtLeast(IMPECCABLE.minNode)) {
    ui.warn(
      `The Impeccable skill requires Node >= ${IMPECCABLE.minNode} (you are on ${process.versions.node}). ` +
        'Step skipped — update Node and run later, in the project folder: npx impeccable install',
    );
    return;
  }

  if (existsSync(join(dir, IMPECCABLE.installedMarker))) {
    ui.info('Impeccable already installed in this project — nothing to do (update with: npx impeccable update).');
    ctx.impeccableInstalled = true;
    return;
  }

  const providers = [...IMPECCABLE.baseProviders, ...(ctx.fiaInstalled ? ['pi'] : [])];
  try {
    await ui.spin('Installing the Impeccable skill (impeccable.style)…', async () => {
      const r = await run(
        'npx',
        ['-y', IMPECCABLE.package, 'install', `--providers=${providers.join(',')}`, '--scope=project', '--no-hooks', '-y'],
        { cwd: dir, timeout: 300000 },
      );
      if (!r.ok) throw new Error((r.stderr || r.stdout || '').trim().split('\n').slice(-3).join('\n'));
    }, 'Impeccable skill installed.');
  } catch (err) {
    // Optional extra: log and move on — never bring down the install.
    ui.warn(
      "Couldn't install Impeccable right now (no network? npm flaky?). " +
        'Install later, in the project folder: npx impeccable install\n' +
        (err?.message || ''),
    );
    return;
  }
  ctx.impeccableInstalled = true;

  ui.note(
    [
      'The agents\' design skill. First step (once per project):',
      '  /impeccable init     creates PRODUCT.md and DESIGN.md — the "brief" of',
      '                       brand, audience and voice that guides every command.',
      '',
      'Then, in any session (Claude Code, Cursor or Pi):',
      '  /impeccable craft …      create a page/asset from scratch (great for landing)',
      '  /impeccable audit        assess what exists and list problems',
      '  /impeccable polish …     refine a screen until it looks professional',
      '  /impeccable distill …    simplify what got overloaded',
      '',
      '"AI-looking" detector (59 rules, no LLM): npx impeccable detect src/',
    ].join('\n'),
    'Impeccable installed — how to use it',
  );
}

/** Same contract as shouldInstallFia: flags > decision > prompt (harness) > default. */
async function shouldInstall(ctx) {
  const { flags = {} } = ctx;
  if (flags.skipImpeccable || flags.impeccable === false) return false;
  if (ctx.decisions?.impeccable === false) return false;
  if (flags.impeccable === true || ctx.decisions?.impeccable === true) return true;
  if (flags.yes) return true;
  if (ctx.mode === 'harness' && flags.impeccable === undefined && ctx.decisions?.impeccable === undefined) {
    return await ui.confirm({
      message:
        'Install the Impeccable design skill (impeccable.style)? Free and open-source; gives the agents /impeccable commands (craft, audit, polish…).',
      initialValue: true,
    });
  }
  return ctx.decisions?.impeccable !== false;
}

/** true if the current Node satisfies `min` (simple major.minor.patch semver). */
export function nodeAtLeast(min, current = process.versions.node) {
  const a = String(current).split('.').map(Number);
  const b = String(min).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return true;
}
