// Install official agent skills into the generated project via the skills.sh
// CLI (https://skills.sh — the `skills` npm package). The canonical copy lands
// in .agents/skills/<name>/ — the agents-standard folder that Cursor reads
// directly, .claude/skills/<name> symlinks into, and Pi scans natively (behind
// the same project-trust gate as .pi/skills/, in interactive AND headless
// runs, so the FIA agents see it too). The install is recorded in
// skills-lock.json, which the template commits.
//
// Nothing is EVER copied into .pi/skills/. Older installer versions ran a
// second `skills add … -a pi` per source; Pi dedupes discovered skills by
// realpath, so a real copy next to the .agents/ canonical made every skill
// load twice and opened every session with a "Skill conflicts" panel listing
// all of them. `prunePiSkillCopies` removes those leftovers from projects
// stamped by the old flow.
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from './proc.js';
import * as ui from './ui.js';

const LOCK_FILE = 'skills-lock.json';

// Measured against skills@1.5.22 (Aug 2026) in fresh projects: `-a claude-code
// cursor` in ONE call fills .agents/skills/ plus the .claude/ symlinks; the
// comma form `-a a,b` is rejected outright and installs nothing. (A third `pi`
// item used to be required and was SILENTLY dropped by the CLI — moot now that
// Pi reads .agents/skills/ itself and no .pi/ copy exists.)
export const SKILL_AGENTS_MAIN = ['claude-code', 'cursor'];

/**
 * Build the non-interactive `npx skills add` argv for a spec from
 * config.OPTIONAL_SKILLS (or from the stack catalog). `agents` goes
 * space-separated after `-a` — the only form the CLI accepts — and stays LAST
 * so the variadic option can never swallow another flag. Exported for tests.
 * @param {{source: string, skills: string[]}} spec
 * @param {string[]} agents
 */
export function skillsAddArgs(spec, agents = SKILL_AGENTS_MAIN) {
  return [
    '-y', // npx: don't prompt to download the `skills` package
    'skills',
    'add',
    spec.source,
    ...spec.skills.flatMap((name) => ['--skill', name]),
    '-y', // skills: skip confirmation prompts
    '-a',
    ...agents,
  ];
}

/** The same command as the student would type it — printed when we fail. */
function manualCommand(spec, agents = SKILL_AGENTS_MAIN) {
  return ['npx skills add', spec.source, ...spec.skills.map((s) => `--skill ${s}`), '-y -a', agents.join(' ')].join(' ');
}

/**
 * Best-effort install of a skill bundle into the project at `dir`. One call
 * covers every engine: Claude Code and Cursor read their own folders, Pi
 * discovers the .agents/skills/ canonical directly. Never throws — a skills
 * hiccup must not abort the installer. Returns true when the install
 * succeeded. `deps` is a test seam ({ run, spin }).
 */
export async function installProjectSkills(dir, spec, deps = {}) {
  const exec = deps.run ?? run;
  const spin = deps.spin ?? ui.spin;
  const list = spec.skills.length ? spec.skills.join(', ') : 'all skills from the source';

  let r;
  try {
    r = await spin(
      `Installing official skills (${spec.label}): ${list}…`,
      () => exec('npx', skillsAddArgs(spec, SKILL_AGENTS_MAIN), { cwd: dir }),
      `Official skills installed (${spec.label}): ${list}`,
    );
  } catch {
    r = { ok: false };
  }

  if (!r?.ok) {
    ui.warn(`Could not install the skills from ${spec.source}. To install later, run in the project folder:`);
    ui.info(`  ${manualCommand(spec)}`);
    if (spec.docsUrl) ui.info(`  Docs: ${spec.docsUrl}`);
    return false;
  }

  ui.info('They live in .agents/skills/ (read by Cursor and Pi; .claude/skills/ symlinks into it) and are recorded in skills-lock.json (committed).');
  return true;
}

/**
 * Remove the `.pi/skills/<name>` COPIES that older installer versions created
 * (`skills add … -a pi`). Pi scans .agents/skills/ natively, so each copy made
 * the skill load twice and Pi opened every session with a "Skill conflicts"
 * panel listing all of them. Lock-driven and conservative: an entry is deleted
 * only when the canonical .agents/skills/<name>/ exists, so a skill can never
 * disappear from every engine at once — and harness-owned skills
 * (.pi/skills/fia/…) are never in the lockfile, so they are untouched.
 * Best-effort and SILENT (callers decide how to report — the update flow has
 * a json mode): never throws, returns the number of copies removed.
 */
export async function prunePiSkillCopies(dir) {
  let removed = 0;
  try {
    const lock = JSON.parse(await readFile(join(dir, LOCK_FILE), 'utf8'));
    for (const name of Object.keys(lock?.skills || {})) {
      const copy = join(dir, '.pi', 'skills', name);
      if (!existsSync(copy) || !existsSync(join(dir, '.agents', 'skills', name))) continue;
      await rm(copy, { recursive: true, force: true });
      removed++;
    }
  } catch {
    // No lockfile (or unreadable, or an rm raced) — nothing left to prune.
  }
  return removed;
}
