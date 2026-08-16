// `imp doctor` — a read-only checkup of the machine and, when run inside a
// project, of the install. DETECTION ONLY by design: doctor never installs,
// never opens a login and never rewrites a file — every finding ends in the
// exact command the student runs to fix it. (The remediating siblings each
// keep their own consent flow: `imp init`, `imp update`, `npx impactus
// --update-runtime`, `npx impactus --verify`.)
//
// Sections:
//   1. Engines (subscriptions) — Claude Code on PATH, the Codex login inside
//      Pi (~/.pi/agent/auth.json) and the Cursor CLI. Informative, never an
//      error: which subscriptions to use is the professional's call. There is
//      deliberately no `claude` login probe (same rationale as the preflight:
//      no heuristic is reliable, and `claude` walks the user through login on
//      first run).
//   2. Core CLIs — node/git/npm (required) and gh/vercel (optional).
//   3. Pi & imp — Pi installed + the three pinned extension packages, plus
//      the same update probe `imp` prints after a session.
//   4. Project — only when the folder looks like an IAI project: FIA runtime
//      present, .mcp.json hygiene (npx without -y dies on a cold cache — the
//      "Connection closed" lesson) and a summary of the full --verify audit.
//
// `--json` swaps the report for `{ ok, sections }` on stdout. Exit code:
// 0 = no error-level finding (warnings included), 1 otherwise.

import process from 'node:process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pc from 'picocolors';
import { has } from '../lib/proc.js';
import { osKind } from '../lib/platform.js';
import {
  hasPi,
  piCodexReady,
  piPackageStatus,
  piVersion,
  collectUpdateNotices,
  PI_PACKAGES,
} from '../lib/pi-auth.js';
import { CLAUDE_INSTALL_HINT } from './preflight.js';
import { collectFindings } from './verify.js';
import { classifyHarnessState, readHarnessManifest } from '../lib/harness-manifest.js';

const NODE_FLOOR = [22, 12];

// How long the network update probe may hold the report. Offline (or slow)
// just skips the section's update rows — doctor never blocks on the network.
const UPDATE_PROBE_MS = 4000;

// Cap on inline project-audit rows; the full list lives in --verify.
const MAX_AUDIT_ROWS = 8;

const ok = (msg) => ({ level: 'ok', msg });
const info = (msg) => ({ level: 'info', msg });
const warn = (msg) => ({ level: 'warn', msg });
const error = (msg) => ({ level: 'error', msg });

/**
 * `.mcp.json` hygiene: every npx-launched MCP server needs `-y` — on a cold
 * npx cache the "Ok to proceed?" prompt lands on the MCP stdio channel and
 * the server dies before the handshake ("Connection closed"; the classic
 * first-run-on-Windows report). Pure — unit-testable on a parsed JSON.
 * @returns {{level:string,msg:string}[]} one warn per offending server.
 */
export function mcpNpxFindings(mcpJson) {
  const servers = mcpJson?.mcpServers;
  if (!servers || typeof servers !== 'object') return [];
  const rows = [];
  for (const [name, cfg] of Object.entries(servers)) {
    const args = Array.isArray(cfg?.args) ? cfg.args : [];
    if (cfg?.command !== 'npx') continue;
    if (args.includes('-y') || args.includes('--yes')) continue;
    rows.push(
      warn(
        `MCP "${name}": npx without -y in .mcp.json — with a cold npx cache the server dies before the handshake ` +
          '("Connection closed"). Add "-y" as the first item of its "args".',
      ),
    );
  }
  return rows;
}

async function enginesSection() {
  const rows = [];
  const claude = await has('claude');
  rows.push(
    claude
      ? ok('Claude Code (Claude Pro/Max) — installed. Not logged in yet? Run `claude` once and finish in the browser.')
      : info(
          `Claude Code (Claude Pro/Max) — not installed.\n  Install:  ${CLAUDE_INSTALL_HINT[osKind()]}\n  Then run \`claude\` once to log in.`,
        ),
  );
  rows.push(
    piCodexReady()
      ? ok('Codex (ChatGPT Plus/Pro, via Pi) — logged in.')
      : info(
          'Codex (ChatGPT Plus/Pro, via Pi) — login pending.\n  Log in:  run `imp` and type /login openai-codex (only that one — Anthropic stays on the `claude` CLI).',
        ),
  );
  rows.push(
    (await has('cursor-agent'))
      ? ok('Cursor CLI (cursor-agent) — installed (Cursor subscription).')
      : info('Cursor CLI (cursor-agent) — not installed (optional; see https://cursor.com/cli).'),
  );
  rows.push(info('None is mandatory — doctor only reports; which subscriptions to use is your call.'));
  return { title: 'Engines (subscriptions)', rows };
}

async function clisSection() {
  const rows = [];
  const [major, minor] = process.versions.node.split('.').map(Number);
  const nodeOk = major > NODE_FLOOR[0] || (major === NODE_FLOOR[0] && minor >= NODE_FLOOR[1]);
  rows.push(
    nodeOk
      ? ok(`Node.js ${process.versions.node} (floor: ${NODE_FLOOR.join('.')})`)
      : error(`Node.js ${process.versions.node} is below the ${NODE_FLOOR.join('.')} floor — update at https://nodejs.org.`),
  );
  for (const cmd of ['git', 'npm']) {
    rows.push(
      (await has(cmd))
        ? ok(`${cmd} — installed.`)
        : warn(`${cmd} — not found. Run \`imp init\`: the installer sets it up for you (or records the pending step).`),
    );
  }
  for (const cmd of ['gh', 'vercel']) {
    rows.push(
      (await has(cmd))
        ? ok(`${cmd} — installed (optional).`)
        : info(`${cmd} — not installed (optional; the installer offers it when a step needs it).`),
    );
  }
  return { title: 'Core CLIs', rows };
}

async function piSection(impactusVersion) {
  const rows = [];
  if (await hasPi()) {
    const version = await piVersion();
    rows.push(ok(`Pi — installed${version ? ` (v${version})` : ''}.`));
    const status = piPackageStatus();
    const missing = PI_PACKAGES.filter((name) => status[name] === 'missing');
    const custom = PI_PACKAGES.filter((name) => status[name] === 'custom');
    const unpinned = PI_PACKAGES.filter((name) => status[name] === 'unpinned');
    if (missing.length === 0) {
      const notes = [
        custom.length ? `${custom.join(', ')} customized by you — left alone` : null,
        unpinned.length ? `${unpinned.join(', ')} unpinned — the next online \`imp update\` pins them` : null,
      ].filter(Boolean);
      rows.push(ok(`Pi extension packages — ${PI_PACKAGES.length} present${notes.length ? ` (${notes.join('; ')})` : ''}.`));
    } else {
      rows.push(warn(`Pi extension packages missing: ${missing.join(', ')} — run \`imp update\` to (re)install them.`));
    }
  } else {
    rows.push(warn('Pi — not installed. `imp` installs it on first launch (or run `imp update`).'));
  }

  // Same probe the launcher prints after a session — timeboxed so an offline
  // or slow registry never holds the report.
  const notices = await Promise.race([
    collectUpdateNotices(impactusVersion).catch(() => []),
    new Promise((res) => setTimeout(res, UPDATE_PROBE_MS, [])),
  ]);
  if (notices.length > 0) {
    for (const line of notices) rows.push(warn(`Update available: ${line}`));
    rows.push(warn('Run `imp update` to bring everything current.'));
  } else {
    rows.push(ok('No pending updates found (or the registry was unreachable — checked best-effort).'));
  }
  return { title: 'Pi & imp', rows };
}

async function projectSection(cwd) {
  const rows = [];
  const inProject =
    existsSync(join(cwd, 'imp')) || existsSync(join(cwd, 'ai-docs')) || existsSync(join(cwd, '.agents'));
  if (!inProject) {
    rows.push(info('No IAI project detected in this folder — run `imp doctor` inside a project for the install audit (create one with `imp init`).'));
    return { title: 'Project', rows };
  }

  if (existsSync(join(cwd, 'imp'))) {
    const runtimeOk = existsSync(join(cwd, 'imp', 'scripts', 'fia-tui.mjs'));
    const rosterOk = existsSync(join(cwd, 'imp', 'fia.config.yaml'));
    rows.push(
      runtimeOk && rosterOk
        ? ok('FIA runtime present (imp/scripts + imp/fia.config.yaml).')
        : warn('FIA runtime incomplete (imp/ exists but scripts or fia.config.yaml are missing) — run `npx impactus --update-runtime`.'),
    );
  } else {
    rows.push(info('FIA not installed here (harness-only install) — `imp init` adds it.'));
  }

  const mcpPath = join(cwd, '.mcp.json');
  if (existsSync(mcpPath)) {
    try {
      const mcp = JSON.parse(await readFile(mcpPath, 'utf8'));
      const hygiene = mcpNpxFindings(mcp);
      const count = Object.keys(mcp?.mcpServers || {}).length;
      rows.push(...(hygiene.length ? hygiene : [ok(`.mcp.json — ${count} server(s), npx entries all carry -y.`)]));
    } catch {
      rows.push(error('.mcp.json is not valid JSON — no MCP server will load until it parses again.'));
    }
  } else {
    rows.push(info('.mcp.json not found — no MCP servers registered for this project.'));
  }

  // Harness stamp: classify against imp/.harness-manifest.json when the
  // install recorded one. Missing files are fixable (`imp fix` restores
  // them); files that differ are the student's (or template-owned) and are
  // only reported — never an error.
  const harnessManifest = await readHarnessManifest(cwd);
  if (harnessManifest) {
    const state = await classifyHarnessState(harnessManifest, cwd);
    if (state.missing.length) {
      rows.push(
        warn(
          `${state.missing.length} harness file(s) missing (deleted?) — e.g. ${state.missing.slice(0, 4).join(', ')}${state.missing.length > 4 ? ', …' : ''}. Restore with \`imp fix\`.`,
        ),
      );
    }
    if (state.modified.length) {
      rows.push(info(`${state.modified.length} harness file(s) differ from the stamp — your edits or template-owned variants (left alone).`));
    }
    if (!state.missing.length && !state.modified.length) {
      rows.push(ok(`Harness stamp intact (${state.pristine} file(s) match imp/.harness-manifest.json).`));
    }
  } else if (existsSync(join(cwd, 'imp', 'HARNESS.md'))) {
    rows.push(info('No harness stamp manifest (project from an older CLI) — the next `npx impactus --harness-only --dir .` run records one.'));
  }

  // Full install audit, summarized: the detailed report stays in --verify.
  try {
    const findings = await collectFindings(cwd);
    const errors = findings.filter((f) => f.level === 'error');
    const warns = findings.filter((f) => f.level === 'warn');
    const shown = [...errors, ...warns].slice(0, MAX_AUDIT_ROWS);
    for (const f of shown) rows.push(f.level === 'error' ? error(f.msg) : warn(f.msg));
    const hidden = errors.length + warns.length - shown.length;
    if (hidden > 0) rows.push(info(`… and ${hidden} more — full report: npx impactus --verify`));
    if (errors.length === 0 && warns.length === 0) {
      rows.push(ok(`Install audit — ${findings.length} check(s), all good (same audit as \`npx impactus --verify\`).`));
    }
  } catch (err) {
    rows.push(warn(`Install audit could not run here: ${err?.message || err}`));
  }
  return { title: 'Project', rows };
}

/**
 * Probe everything and return the report (no printing — unit-testable).
 * @returns {Promise<{ok: boolean, sections: {title: string, rows: {level:string,msg:string}[]}[]}>}
 */
export async function collectDoctorReport({ cwd = process.cwd(), impactusVersion = '0.0.0' } = {}) {
  const sections = [
    await enginesSection(),
    await clisSection(),
    await piSection(impactusVersion),
    await projectSection(resolve(cwd)),
  ];
  return { ok: !sections.some((s) => s.rows.some((r) => r.level === 'error')), sections };
}

const ICONS = { ok: '✅', info: '○', warn: '⚠', error: '✖' };
const PAINT = { ok: (s) => s, info: pc.dim, warn: pc.yellow, error: pc.red };

/** Entry point of `imp doctor`. @returns {Promise<boolean>} true = no errors. */
export async function runDoctor(flags = {}, impactusVersion = '0.0.0') {
  const report = await collectDoctorReport({ impactusVersion });
  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
    return report.ok;
  }
  console.log(pc.bold('imp doctor — read-only checkup (nothing is installed or changed)'));
  for (const section of report.sections) {
    console.log('');
    console.log(pc.bold(pc.cyan(section.title)));
    for (const row of section.rows) {
      const paint = PAINT[row.level] || ((s) => s);
      const [first, ...cont] = row.msg.split('\n');
      console.log(paint(`  ${ICONS[row.level] || ' '} ${first}`));
      for (const line of cont) console.log(paint(`   ${line}`));
    }
  }
  console.log('');
  console.log(
    report.ok
      ? 'Everything the system needs is in place (○/⚠ items are optional or have their command above).'
      : pc.red('Problems found — each ✖ above ends with the command that fixes it.'),
  );
  if (report.sections.some((s) => s.rows.some((r) => r.level === 'warn' || r.level === 'error'))) {
    console.log(pc.dim('Repairable findings can be applied with `imp fix` — it shows the plan and asks before touching anything.'));
  }
  return report.ok;
}
