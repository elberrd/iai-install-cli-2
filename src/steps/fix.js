// `imp fix` — the remediating sibling of `imp doctor`. Contract (the norms
// every professional CLI converged on — cargo fix, ng update, expo install,
// copier):
//
//   - A bare `imp fix` NEVER writes blind: it computes the plan, prints it,
//     and asks ONE yes/no before applying (`--yes` skips the ask; without a
//     TTY it prints the plan and exits 1 instead of hanging — CI-safe).
//   - `--dry-run` and `--json` stop after the plan, always (machine-readable
//     output never mutates the project).
//   - Fixes that touch the project tree require a CLEAN git tree, so git
//     itself is the undo — `--allow-dirty` is the named escape hatch, and
//     `--commit` makes one commit per applied fix (à la ng update
//     --create-commits). Machine-level fixes (Pi packages) skip the gate.
//   - RESTORE-ONLY tier: every fix here recreates something missing or adds a
//     flag — it never overwrites a file that exists with different content.
//     Files that differ from their stamp are REPORTED (notes), never touched;
//     updating outdated-but-present runtime files stays with
//     `npx impactus --update-runtime` (which has its own per-file consent).
//   - Idempotent: a second run right after a successful one finds nothing.
//   - Exit 0 = nothing left to fix; 1 = fixes pending (plan modes) or a fix
//     failed / findings remain (apply mode).

import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import pc from 'picocolors';
import { HARNESS } from '../config.js';
import { run } from '../lib/proc.js';
import { hasPi, installPiPackages, piPackageStatus, PI_PACKAGES } from '../lib/pi-auth.js';
import { prunePiSkillCopies } from '../lib/skills.js';
import { loadAuth, resolveApiBase } from '../lib/auth-client.js';
import { downloadErrorMessage, fetchTemplateToDir } from '../lib/template-fetch.js';
import { classifyHarnessState, readHarnessManifest } from '../lib/harness-manifest.js';
import { mergeAgentsMd } from './harness.js';
import { readRuntimeManifest, templateTrees } from './update-runtime.js';

const SAMPLE = (list, max = 4) => list.slice(0, max).join(', ') + (list.length > max ? ', …' : '');

/**
 * Compute the fix plan: what is wrong AND how each item repairs it. Detection
 * only — nothing is written until an item's `apply()` runs. `probes` lets
 * tests bypass machine-level lookups (Pi on PATH, ~/.pi settings).
 * @returns {Promise<{items: Array<{id,kind,label,detail,apply}>, notes: string[], cleanup: () => Promise<void>}>}
 */
export async function collectFixPlan({ cwd = process.cwd(), probes = {} } = {}) {
  const items = [];
  const notes = [];

  // ── Machine tier: the Pi extension packages (no git involved) ─────────────
  const piReady = await (probes.piReady ? probes.piReady() : hasPi());
  if (piReady) {
    const status = (probes.piStatus ?? piPackageStatus)();
    const missingPkgs = PI_PACKAGES.filter((name) => status[name] === 'missing');
    if (missingPkgs.length) {
      items.push({
        id: 'pi-packages',
        kind: 'machine',
        label: `Reinstall the missing Pi extension package(s): ${missingPkgs.join(', ')}`,
        detail: 'Exact-pinned install into your Pi settings — the same thing `imp update` does.',
        apply: async () => {
          await installPiPackages(cwd);
          return `${missingPkgs.length} package(s) reinstalled.`;
        },
      });
    }
  }

  // ── .mcp.json hygiene: npx servers need -y (cold cache kills the stdio) ───
  const mcpPath = join(cwd, '.mcp.json');
  if (existsSync(mcpPath)) {
    try {
      const mcp = JSON.parse(await readFile(mcpPath, 'utf8'));
      const offenders = Object.entries(mcp?.mcpServers ?? {})
        .filter(([, cfg]) => {
          if (cfg?.command !== 'npx') return false;
          const args = Array.isArray(cfg?.args) ? cfg.args : [];
          return !args.includes('-y') && !args.includes('--yes');
        })
        .map(([name]) => name);
      if (offenders.length) {
        items.push({
          id: 'mcp-npx-yes',
          kind: 'project',
          label: `Add "-y" to ${offenders.length} npx MCP server(s) in .mcp.json (${offenders.join(', ')})`,
          detail: 'Without -y, a cold npx cache kills the server before the handshake ("Connection closed").',
          apply: async () => {
            const current = JSON.parse(await readFile(mcpPath, 'utf8'));
            for (const name of offenders) {
              const cfg = current.mcpServers[name];
              cfg.args = ['-y', ...(Array.isArray(cfg.args) ? cfg.args : [])];
            }
            await writeFile(mcpPath, JSON.stringify(current, null, 2) + '\n', 'utf8');
            return `${offenders.length} server(s) fixed.`;
          },
        });
      }
    } catch {
      notes.push('.mcp.json is not valid JSON — fix cannot repair a hand-edited file; restore it from git (or fix the syntax) first.');
    }
  }

  // ── Agent skills: restore lock entries, prune legacy .pi/skills copies ────
  let lockNames = [];
  try {
    const lock = JSON.parse(await readFile(join(cwd, 'skills-lock.json'), 'utf8'));
    lockNames = Object.keys(lock?.skills ?? {});
  } catch {
    /* no lockfile — no official skills to audit */
  }
  const missingSkills = lockNames.filter((n) => !existsSync(join(cwd, '.agents', 'skills', n)));
  if (missingSkills.length) {
    items.push({
      id: 'skills-missing',
      kind: 'project',
      label: `Restore ${missingSkills.length} agent skill(s) missing from .agents/skills/ (${SAMPLE(missingSkills)})`,
      detail: 'Runs `npx skills experimental_install` — reinstalls exactly what skills-lock.json records.',
      apply: async () => {
        const r = await run('npx', ['skills', 'experimental_install'], { cwd, timeout: 300_000 });
        if (!r.ok) throw new Error(`npx skills experimental_install failed:\n${(r.stderr || r.stdout || '').trim().slice(-400)}`);
        return `${missingSkills.length} skill(s) reinstalled.`;
      },
    });
  }
  const dupeSkills = existsSync(join(cwd, '.pi'))
    ? lockNames.filter((n) => existsSync(join(cwd, '.pi', 'skills', n)) && existsSync(join(cwd, '.agents', 'skills', n)))
    : [];
  if (dupeSkills.length) {
    items.push({
      id: 'pi-skill-dupes',
      kind: 'project',
      label: `Remove ${dupeSkills.length} duplicated skill copy(ies) from .pi/skills/ (${SAMPLE(dupeSkills)})`,
      detail: 'Pi already reads .agents/skills/ — the copies only produce the "Skill conflicts" panel.',
      apply: async () => `${await prunePiSkillCopies(cwd)} copy(ies) removed.`,
    });
  }

  // ── FIA runtime: bring back files the STAMP recorded and the disk lost ────
  // Restore-only and manifest-gated on purpose: a file in the runtime manifest
  // was stamped once, so its absence means "deleted" — recreating it from the
  // bundled template is additive. Template files ABSENT from the manifest are
  // new in a later runtime and belong to --update-runtime, not here.
  const runtimeManifest = await readRuntimeManifest(cwd);
  if (runtimeManifest) {
    const goneRuntime = Object.keys(runtimeManifest.files ?? {}).filter((rel) => !existsSync(join(cwd, rel)));
    if (goneRuntime.length) {
      const trees = templateTrees();
      items.push({
        id: 'runtime-missing',
        kind: 'project',
        label: `Restore ${goneRuntime.length} missing FIA runtime file(s) (${SAMPLE(goneRuntime)})`,
        detail: 'Recreated from the templates bundled in this impactus version; run `npx impactus --update-runtime` after, if you want everything current.',
        apply: async () => {
          let restored = 0;
          const unavailable = [];
          for (const rel of goneRuntime) {
            const tree = trees.find((t) => rel === t.prefix || rel.startsWith(`${t.prefix}/`));
            const src = tree ? join(tree.src, rel.slice(tree.prefix.length + 1)) : null;
            if (!src || !existsSync(src)) {
              unavailable.push(rel);
              continue;
            }
            await mkdir(dirname(join(cwd, rel)), { recursive: true });
            await cp(src, join(cwd, rel));
            restored++;
          }
          return (
            `${restored} file(s) restored.` +
            (unavailable.length ? ` Not in the current templates (left out): ${SAMPLE(unavailable)}` : '')
          );
        },
      });
    }
  }

  // ── Harness: restore missing stamped files + the AGENTS.md block ──────────
  // One lazy, memoized download serves both items; cleanup() removes the tmp
  // clone after the apply loop (or immediately when nothing used it).
  let cloneState = null;
  const fetchClone = async () => {
    if (cloneState) return cloneState;
    const tmpRoot = mkdtempSync(join(tmpdir(), 'imp-fix-harness-'));
    const cloneDir = join(tmpRoot, 'repo');
    const res = await fetchTemplateToDir(resolveApiBase({}), (await loadAuth())?.token ?? null, 'harness', cloneDir);
    if (!res.ok) {
      await rm(tmpRoot, { recursive: true, force: true });
      throw new Error(downloadErrorMessage('harness', res.reason));
    }
    // Same adaptation the stamp applied, so clone paths line up with manifest keys.
    let agentsMd = null;
    if (existsSync(join(cloneDir, 'README.md'))) {
      await mkdir(dirname(join(cloneDir, HARNESS.readmeAs)), { recursive: true });
      await rename(join(cloneDir, 'README.md'), join(cloneDir, HARNESS.readmeAs));
    }
    if (existsSync(join(cloneDir, 'AGENTS.md'))) {
      agentsMd = await readFile(join(cloneDir, 'AGENTS.md'), 'utf8');
      await rm(join(cloneDir, 'AGENTS.md'), { force: true });
    }
    cloneState = { tmpRoot, cloneDir, agentsMd };
    return cloneState;
  };
  const cleanup = async () => {
    if (cloneState) await rm(cloneState.tmpRoot, { recursive: true, force: true });
    cloneState = null;
  };

  const harnessManifest = await readHarnessManifest(cwd);
  if (harnessManifest) {
    const state = await classifyHarnessState(harnessManifest, cwd);
    if (state.missing.length) {
      items.push({
        id: 'harness-missing',
        kind: 'project',
        label: `Restore ${state.missing.length} missing harness file(s) (${SAMPLE(state.missing)})`,
        detail: 'Re-downloads the harness from the community API and copies ONLY the missing paths — existing files are never touched.',
        apply: async () => {
          const { cloneDir } = await fetchClone();
          let restored = 0;
          const leftovers = [];
          for (const rel of state.missing) {
            const entry = String(harnessManifest.files[rel]);
            const dest = join(cwd, rel);
            await mkdir(dirname(dest), { recursive: true });
            if (entry.startsWith('link:')) {
              // A dangling link at dest would have classified as missing —
              // remove the husk before recreating, then link to the stamped target.
              await rm(dest, { force: true });
              try {
                await symlink(entry.slice(5), dest);
              } catch {
                // No symlink privilege (typical on Windows) — materialize the
                // mirror instead, same degradation the installer's extractor
                // applies: the fresh clone has real content at this path.
                const source = existsSync(join(cloneDir, rel)) ? join(cloneDir, rel) : resolve(dirname(dest), entry.slice(5));
                await cp(source, dest, { recursive: true, dereference: true });
              }
              restored++;
            } else if (existsSync(join(cloneDir, rel))) {
              await rm(dest, { force: true });
              await cp(join(cloneDir, rel), dest);
              restored++;
            } else {
              leftovers.push(rel); // the current harness no longer ships it
            }
          }
          return (
            `${restored} file(s) restored.` +
            (leftovers.length ? ` No longer shipped by the harness (left out): ${SAMPLE(leftovers)}` : '')
          );
        },
      });
    }
    if (state.modified.length) {
      notes.push(
        `${state.modified.length} harness file(s) differ from the stamp (${SAMPLE(state.modified)}) — ` +
          'your edits or template-owned variants; left alone. To adopt the harness version, re-run the installer with --agent-files replace.',
      );
    }

    // The AGENTS.md harness block (merged by marker, so it lives outside the manifest).
    const agentsPath = join(cwd, 'AGENTS.md');
    const agentsContent = existsSync(agentsPath) ? await readFile(agentsPath, 'utf8') : '';
    if (!agentsContent.includes(HARNESS.markerStart)) {
      items.push({
        id: 'agents-md-block',
        kind: 'project',
        label: existsSync(agentsPath)
          ? 'Re-append the harness block to AGENTS.md (markers not found)'
          : 'Recreate AGENTS.md with the harness block',
        detail: 'Same idempotent marker merge the installer uses — your own AGENTS.md content is kept.',
        apply: async () => {
          const { agentsMd } = await fetchClone();
          if (!agentsMd) return 'The current harness ships no AGENTS.md — nothing to merge.';
          return `AGENTS.md: harness block ${await mergeAgentsMd(agentsPath, agentsMd)}.`;
        },
      });
    }
  }

  return { items, notes, cleanup };
}

/** True when the folder's git tree is clean (no repo counts as NOT clean). */
async function gitClean(cwd) {
  const r = await run('git', ['status', '--porcelain'], { cwd });
  return r.ok && r.stdout.trim() === '';
}

const KIND_TAG = { machine: pc.dim('[machine]'), project: pc.dim('[project]') };

function printPlan(items, notes) {
  console.log(pc.bold(`imp fix — ${items.length} fix(es) to apply`));
  items.forEach((item, i) => {
    console.log(`  ${i + 1}. ${item.label} ${KIND_TAG[item.kind] ?? ''}`);
    console.log(pc.dim(`     ${item.detail}`));
  });
  for (const note of notes) console.log(pc.yellow(`  ⚠ ${note}`));
}

/**
 * Entry point of `imp fix`.
 * @returns {Promise<boolean>} true = nothing pending (and, in apply mode, nothing failed).
 */
export async function runFix(flags = {}) {
  const cwd = process.cwd();
  const plan = await collectFixPlan({ cwd });
  const { items, notes } = plan;

  try {
    // ── Plan-only modes ──────────────────────────────────────────────────────
    if (flags.json) {
      console.log(
        JSON.stringify(
          { ok: items.length === 0, pending: items.map(({ id, kind, label, detail }) => ({ id, kind, label, detail })), notes },
          null,
          2,
        ),
      );
      return items.length === 0;
    }
    if (items.length === 0) {
      console.log('Nothing to fix — everything `imp fix` knows how to repair is in place.');
      for (const note of notes) console.log(pc.yellow(`  ⚠ ${note}`));
      if (notes.length) console.log(pc.dim('Notes are report-only: fix never overwrites a file that exists with different content.'));
      return true;
    }
    printPlan(items, notes);
    if (flags.dryRun) {
      console.log(pc.dim('\n--dry-run: nothing was changed. Run `imp fix` (or `imp fix --yes`) to apply.'));
      return false;
    }

    // ── Git gate (project-tier fixes only) ───────────────────────────────────
    const touchesProject = items.some((i) => i.kind === 'project');
    if (touchesProject && !flags.allowDirty && !(await gitClean(cwd))) {
      console.log('');
      console.log(pc.red('Your git tree is not clean (or this folder has no git repo).'));
      console.log('Commit or stash your changes first — git is the undo for everything fix touches.');
      console.log('To proceed anyway: imp fix --allow-dirty');
      return false;
    }

    // ── Consent ──────────────────────────────────────────────────────────────
    if (!flags.yes) {
      if (!process.stdout.isTTY || !process.stdin.isTTY) {
        console.log(pc.yellow('\nNot a terminal — nothing was applied. Re-run with --yes to apply this plan.'));
        return false;
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question(`\nApply these ${items.length} fix(es)? [y/N] `)).trim().toLowerCase();
      rl.close();
      if (answer !== 'y' && answer !== 'yes') {
        console.log('Nothing was changed.');
        return false;
      }
    }

    // ── Apply ────────────────────────────────────────────────────────────────
    console.log('');
    const failures = [];
    for (const item of items) {
      try {
        const outcome = await item.apply();
        console.log(`  ✅ ${item.label}${outcome ? pc.dim(` — ${outcome}`) : ''}`);
        if (flags.commit && item.kind === 'project') {
          await run('git', ['add', '-A'], { cwd });
          await run('git', ['commit', '-q', '-m', `fix(imp): ${item.label}`], { cwd });
        }
      } catch (err) {
        failures.push(item);
        console.log(pc.red(`  ✖ ${item.label} — ${err?.message || err}`));
      }
    }

    // ── Convergence check: a fixed project must re-plan to zero ─────────────
    const after = await collectFixPlan({ cwd });
    await after.cleanup();
    const remaining = after.items;
    console.log('');
    if (failures.length === 0 && remaining.length === 0) {
      console.log(pc.bold('All fixes applied — `imp fix` finds nothing else.'));
      if (!flags.commit) console.log(pc.dim('Review with `git diff` and commit when happy (or use `imp fix --commit` next time).'));
    } else {
      if (failures.length) console.log(pc.red(`${failures.length} fix(es) failed — see the ✖ lines above.`));
      if (remaining.length) console.log(pc.yellow(`${remaining.length} finding(s) still pending — run \`imp doctor\` for the full picture.`));
    }
    return failures.length === 0 && remaining.length === 0;
  } finally {
    await plan.cleanup();
  }
}
