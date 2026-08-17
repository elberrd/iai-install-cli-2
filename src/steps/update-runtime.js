// `npx impactus --update-runtime [--dir folder]` — re-stamps the FIA/Pi
// RUNTIME of an ALREADY-installed project from the impactus version currently
// running. The install stamp (src/steps/fia.js) records
// `imp/.runtime-manifest.json` with the sha1 of every stamped file; this
// command uses it to decide, per template file:
//
//   missing on disk                 → add
//   byte-identical to the template  → skip (unchanged)
//   differs, disk sha == manifest   → overwrite (unmodified since the stamp)
//   differs, disk sha != manifest   → the STUDENT edited it: interactive runs
//     ask per file — Yes / Yes to all / No / No to all, the *-to-all answers
//     stick for the rest of the run — after one loud warning; non-interactive
//     runs skip and report, unless --force (= yes to everything). Every
//     overwrite is backed up first.
//
// Only RUNTIME paths are eligible (`FIA.runtimeUpdatablePaths`): imp/ modules,
// FDAs, scripts, package.json + the .pi/ fia skill, prompts and extensions.
// imp/fia.config.yaml (the roster), imp/data/ (editable agent prompts, DB),
// imp/node_modules/ and everything outside the template trees are NEVER
// touched — and files the template no longer ships are LEFT in place
// (additive + replace only, never delete).
//
// Projects stamped before the imp/ layout kept the runtime at `fia/` (with
// HARNESS.md and iai.config.json at the root) — `migrateLegacyFiaLayout`
// below moves them over before any plan is drawn.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADDONS_CONFIG_FILE, FIA, HARNESS, LEGACY_ADDONS_CONFIG_FILE } from '../config.js';
import { isRuntimeCode } from '../lib/runtime-health.js';
import { installPiPackages } from '../lib/pi-auth.js';
import { prunePiSkillCopies } from '../lib/skills.js';
import { run } from '../lib/proc.js';
import * as ui from '../lib/ui.js';

const PKG_ROOT = join(fileURLToPath(new URL('../..', import.meta.url)));

/** The two template trees the installer stamps: package source → project prefix. */
export function templateTrees() {
  return [
    { src: join(PKG_ROOT, FIA.fiaTemplateDir), prefix: FIA.runtimeDir },
    { src: join(PKG_ROOT, FIA.piTemplateDir), prefix: '.pi' },
  ];
}

export function sha1(content) {
  return createHash('sha1').update(content).digest('hex');
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Is `relPath` (project-root relative, forward slashes) one the update may
 * touch? Trailing slash = folder prefix; `*` matches within ONE path segment
 * (so `fia/fda_*.mjs` covers the FDA files but never a nested folder).
 */
export function isRuntimeUpdatable(relPath, patterns = FIA.runtimeUpdatablePaths) {
  return patterns.some((p) => {
    if (p.endsWith('/')) return relPath.startsWith(p);
    if (p.includes('*')) return new RegExp(`^${p.split('*').map(escapeRegExp).join('[^/]*')}$`).test(relPath);
    return relPath === p;
  });
}

/**
 * The per-file decision (pure — the whole update contract in one function).
 * @returns {'add'|'unchanged'|'update'|'modified'}
 */
export function decideAction({ templateSha, diskSha, manifestSha }) {
  if (diskSha == null) return 'add';
  if (diskSha === templateSha) return 'unchanged';
  if (manifestSha != null && manifestSha === diskSha) return 'update';
  return 'modified'; // edited after the stamp (or no manifest to prove otherwise)
}

/** `imp/.runtime-backup-YYYYMMDD-HHmmss` — one folder per run, local time. */
export function backupDirName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `${FIA.runtimeBackupPrefix}${stamp}`;
}

/**
 * The manifest sha a plan entry carries FORWARD after a run. Overwritten files
 * move to the new baseline; skipped-modified ones KEEP the stamp sha (so the
 * next run still sees the local edit instead of silently clobbering it);
 * untouched paths keep their recorded baseline. `null` = leave unlisted.
 */
export function nextManifestSha({ action, wrote, templateSha, diskSha, manifestSha }) {
  if (wrote) return templateSha;
  if (action === 'unchanged') return templateSha; // already at template state — self-heals a stale entry
  if (action === 'modified') return manifestSha ?? null;
  return manifestSha ?? diskSha ?? null; // preserved / never-recorded paths
}

async function listFiles(root, rel = '') {
  const out = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(join(root, entry.name), relPath)));
    else out.push(relPath);
  }
  return out;
}

/** Parsed manifest, or null when missing/invalid (treated as "no baseline"). */
export async function readRuntimeManifest(dir) {
  try {
    const parsed = JSON.parse(await readFile(join(dir, FIA.runtimeManifest), 'utf8'));
    return parsed && typeof parsed.files === 'object' && parsed.files !== null ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveRuntimeManifest(dir, files) {
  const manifest = { impactus: await pkgVersion(), stamped_at: new Date().toISOString(), files };
  const path = join(dir, FIA.runtimeManifest);
  await mkdir(dirname(path), { recursive: true }); // a .pi-only project has no imp/ yet
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return manifest;
}

/**
 * The manifest written right after a stamp (used by setupFia): the sha of the
 * TEMPLATE, for every template file present on disk. Template — not disk — is
 * what makes the baseline honest: the stamp SKIPS pre-existing files, so a
 * file whose content differs from the template was never written by us. Its
 * disk sha as baseline would read as "unmodified since the stamp" and let
 * `--update-runtime` overwrite the student's file with no confirmation.
 */
export async function stampManifestFiles(dir, trees = templateTrees()) {
  const files = {};
  for (const tree of trees) {
    for (const rel of (await listFiles(tree.src)).sort()) {
      const dest = join(dir, tree.prefix, rel);
      if (existsSync(dest)) files[`${tree.prefix}/${rel}`] = sha1(await readFile(join(tree.src, rel)));
    }
  }
  return files;
}

/**
 * Plan one entry per template file: shas + the decided action. Non-updatable
 * paths come back as `action: 'preserved'` (needed for the manifest rewrite,
 * never written to). Injectable trees/patterns keep this unit-testable.
 */
export async function planRuntimeUpdate({
  dir,
  trees = templateTrees(),
  manifest = null,
  patterns = FIA.runtimeUpdatablePaths,
}) {
  const plan = [];
  for (const tree of trees) {
    for (const rel of (await listFiles(tree.src)).sort()) {
      const relPath = `${tree.prefix}/${rel}`;
      const src = join(tree.src, rel);
      const templateSha = sha1(await readFile(src));
      const dest = join(dir, relPath);
      const diskSha = existsSync(dest) ? sha1(await readFile(dest)) : null;
      const manifestSha = manifest?.files?.[relPath] ?? null;
      const updatable = isRuntimeUpdatable(relPath, patterns);
      plan.push({
        rel: relPath,
        src,
        dest,
        templateSha,
        diskSha,
        manifestSha,
        action: updatable ? decideAction({ templateSha, diskSha, manifestSha }) : 'preserved',
      });
    }
  }
  return plan;
}

/**
 * Execute a plan. `overwriteModified(entry)` is the consent hook for locally
 * modified files (interactive confirm / --force / skip). Every overwrite backs
 * the old bytes into `imp/.runtime-backup-<ts>/<relpath>` FIRST — they may be
 * the student's only copy. Marks written entries with `wrote: true` (consumed
 * by the manifest rewrite).
 */
export async function applyRuntimePlan({ dir, plan, overwriteModified = async () => false, now = new Date() }) {
  const result = { added: [], updated: [], skippedModified: [], forcedRuntime: [], unchanged: [], backupDir: null };
  const backupRel = backupDirName(now);
  for (const entry of plan) {
    if (entry.action === 'preserved') continue;
    if (entry.action === 'unchanged') {
      result.unchanged.push(entry.rel);
      continue;
    }
    if (entry.action === 'add') {
      await mkdir(dirname(entry.dest), { recursive: true });
      await cp(entry.src, entry.dest);
      entry.wrote = true;
      result.added.push(entry.rel);
      continue;
    }
    // 'update' | 'modified' — both replace an existing file; modified needs
    // consent, EXCEPT for runtime code. imp/modules/, imp/scripts/ and
    // imp/fda_*.mjs import each other by relative path, so keeping ONE of them
    // at the old version while its siblings move forward does not preserve a
    // student's edit — it produces `SyntaxError: does not provide an export
    // named …` on every FDA, under a "Runtime updated ✅" banner. Those files
    // are never student material (src/steps/fix.js makes the same argument),
    // and the pre-overwrite backup below still keeps their bytes.
    if (entry.action === 'modified' && !isRuntimeCode(entry.rel) && !(await overwriteModified(entry))) {
      result.skippedModified.push(entry.rel);
      continue;
    }
    if (entry.action === 'modified' && isRuntimeCode(entry.rel)) result.forcedRuntime.push(entry.rel);
    const backupPath = join(dir, backupRel, entry.rel);
    await mkdir(dirname(backupPath), { recursive: true });
    await cp(entry.dest, backupPath);
    result.backupDir = backupRel;
    await cp(entry.src, entry.dest);
    entry.wrote = true;
    result.updated.push(entry.rel);
  }
  return result;
}

/** New manifest `files` map after a run (see nextManifestSha for the rules). */
export function manifestFilesAfter(plan) {
  const files = {};
  for (const entry of plan) {
    const sha = nextManifestSha(entry);
    if (sha) files[entry.rel] = sha;
  }
  return files;
}

/** The one section header the runtime owns inside the student's .gitignore. */
export const GITIGNORE_HEADER = '# imp runtime';

/**
 * Add the FIA runtime ignores (runtime data, node_modules, update backups)
 * once. Shared by setupFia and the update (projects stamped by older versions
 * predate the backup entry).
 *
 * Exactly ONE `# imp runtime` section ever exists: a project stamped by an
 * older release already carries the header, so a newly shipped entry is
 * inserted INSIDE that block. Emitting the header again would leave the
 * student's file with one stanza per release, each holding whatever that
 * release added — the same ignores, but a diff nobody can read.
 */
export async function ensureFiaGitignore(dir) {
  const gitignore = join(dir, '.gitignore');
  const raw = existsSync(gitignore) ? await readFile(gitignore, 'utf8') : '';
  const lines = raw ? raw.split('\n') : [];
  const missing = FIA.gitignoreEntries.filter((e) => !lines.includes(e));
  if (!missing.length) return;

  const headerIx = lines.findIndex((l) => l.trim() === GITIGNORE_HEADER);
  if (headerIx === -1) {
    await writeFile(
      gitignore,
      (lines.length ? lines.join('\n') + '\n' : '') + `${GITIGNORE_HEADER}\n` + missing.join('\n') + '\n',
      'utf8',
    );
    return;
  }
  // Our block ends at the first blank line or at the next `# …` section header,
  // so entries the student added under ours are kept above the new ones.
  let insertAt = headerIx + 1;
  while (insertAt < lines.length && lines[insertAt].trim() && !lines[insertAt].trimStart().startsWith('#')) {
    insertAt += 1;
  }
  lines.splice(insertAt, 0, ...missing);
  const out = lines.join('\n');
  await writeFile(gitignore, out.endsWith('\n') ? out : `${out}\n`, 'utf8');
}

// ── Legacy layout migration (fia/ → imp/) ────────────────────────────────────
// Until the imp/ layout the runtime was stamped at `fia/`, with HARNESS.md and
// iai.config.json at the project root. One idempotent pass brings an old
// project over:
//   1. fia/ → imp/ (plain fs rename — git records a move on the next add);
//   2. root HARNESS.md → imp/HARNESS.md and root iai.config.json →
//      imp/iai.config.json (skipped when the new location already exists);
//   3. path fix: `fia/<child>` references become `imp/<child>` in everything
//      that points at the runtime — root package.json scripts, .gitignore,
//      imp/** (runtime code, fia.config.yaml roster, data/ agent prompts),
//      .pi/** (prompts/skills/agents/extensions) and the legacy harness copies
//      in .claude/** and .cursor/** (e.g. commands/launch.md). Only ENUMERATED
//      children are rewritten, so `.pi/skills/fia/…` (the skill name) never
//      matches. The legacy fia-guard's bare `"fia"` token gets a targeted fix.
//      A marker inside imp/ keeps this pass re-runnable if a crash interrupts
//      it (every rewrite is idempotent);
//   4. manifest: keys move fia/* → imp/*, and a rewritten file whose
//      pre-rewrite sha matched the manifest gets the post-rewrite sha recorded
//      — it keeps its "unmodified since stamp" status, so a later
//      --update-runtime still refreshes it silently instead of asking consent
//      for OUR path fix. User-edited files are path-fixed too (the old folder
//      no longer exists) but stay flagged as modified.

// `fia/` followed by one of the runtime's REAL children, not preceded by a
// word char or `-` (`algo-fia/…` never matches; `.pi/skills/fia/` is safe too
// because the skill only contains SKILL.md/cookbooks — never these children).
// A leading `/` DOES match: the fia-guard extension keys on "/fia/modules/".
const LEGACY_FIA_REF = /(^|[^\w-])fia\/(?=data\b|modules\b|scripts\b|fda_|fia\.config\.yaml|package\.json|node_modules|\.runtime-)/g;
export const fixLegacyFiaRefs = (text) => text.replace(LEGACY_FIA_REF, `$1${FIA.runtimeDir}/`);

const MIGRATE_TEXT_RE = /\.(mjs|js|cjs|ts|json|ya?ml|md|mdc|txt)$/;
const MIGRATE_SKIP = new Set(['node_modules', 'sessions', 'backups']);

/**
 * Merge `FIA.npmScripts` into the project's root package.json (created minimal
 * when absent — "harness only" folders still get `npm run fda:viewer`). Never
 * clobbers a project script: a conflicting name keeps the project's version
 * and ships ours as `<name>:fia`. Writes only when something changed, so a
 * re-run never reformats the student's file. Used by the installer AND by
 * `--update-runtime` (new runtime versions ship new entry points — `npm run
 * tui`, `env:check`… — and updated projects must get them too).
 * @returns {{added: string[], aliased: string[]}}
 */
export async function mergeFiaNpmScripts(dir) {
  const pkgPath = join(dir, 'package.json');
  const fresh = !existsSync(pkgPath);
  const pkg = fresh
    ? { name: basename(dir), private: true, version: '0.0.0' }
    : JSON.parse(await readFile(pkgPath, 'utf8'));
  pkg.scripts = pkg.scripts || {};
  const added = [];
  const aliased = [];
  for (const [name, cmd] of Object.entries(FIA.npmScripts)) {
    const current = pkg.scripts[name];
    if (current === undefined) {
      pkg.scripts[name] = cmd;
      added.push(name);
    } else if (current !== cmd) {
      const alias = `${name}:fia`;
      if (pkg.scripts[alias] === undefined) {
        pkg.scripts[alias] = cmd;
        aliased.push(`${name} → ${alias}`);
      }
    }
  }
  if (fresh || added.length || aliased.length) {
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  }
  return { added, aliased };
}

/**
 * Migrate a pre-imp project in place. Idempotent and silent when there is
 * nothing to do. @returns {Promise<{migrated: boolean, renamed: boolean, moved: string[], rewritten: string[]}>}
 */
export async function migrateLegacyFiaLayout(dir, { quiet = false } = {}) {
  const result = { migrated: false, renamed: false, moved: [], rewritten: [] };
  const legacy = join(dir, 'fia');
  const target = join(dir, FIA.runtimeDir);
  // Only OUR runtime folder qualifies — an unrelated fia/ folder is left alone
  // (the stamp then creates imp/ fresh next to it, which is correct).
  const legacyIsRuntime =
    existsSync(legacy) &&
    (existsSync(join(legacy, 'fia.config.yaml')) || existsSync(join(legacy, 'modules')));

  // Crash-resume: the marker is written BEFORE any move — into fia/ ahead of
  // the whole-folder rename (the rename carries it to imp/), or into imp/
  // ahead of the entry-by-entry merge. A migration that dies at ANY later
  // point leaves the marker behind, so the next run resumes the moves and the
  // path-rewrite pass instead of reporting a half-migrated project as done
  // (every move and rewrite is idempotent).
  const MARKER = '.fia-migration-pending';
  const pendingMarker = join(target, MARKER);
  const resumeRewrites = existsSync(pendingMarker);

  if (legacyIsRuntime) {
    const targetIsRuntime =
      existsSync(join(target, 'fia.config.yaml')) || existsSync(join(target, 'modules'));
    if (targetIsRuntime && !resumeRewrites) {
      // TWO runtimes — a state we never create; only a human can merge it.
      // (With the marker present this is OUR interrupted merge, resumed below.)
      if (!quiet) {
        ui.warn(
          `Both fia/ and ${FIA.runtimeDir}/ exist — automatic migration skipped. ` +
            `${FIA.runtimeDir}/ is the current layout: merge what you need from fia/ into it and delete fia/.`,
        );
      }
      return result;
    }
    if (!existsSync(target)) {
      await writeFile(join(legacy, MARKER), 'fia -> imp migration in progress\n', 'utf8');
      await rename(legacy, target);
    } else {
      // imp/ exists but holds only non-runtime files that EARLIER pipeline
      // steps created this run (iai.config.json from the addons step,
      // HARNESS.md from the harness merge) — or a previous merge died halfway
      // (marker present). Move the runtime entries over.
      await writeFile(pendingMarker, 'fia -> imp migration in progress\n', 'utf8');
      for (const entry of await readdir(legacy)) {
        if (entry === MARKER) continue;
        if (!existsSync(join(target, entry))) {
          await rename(join(legacy, entry), join(target, entry));
        }
      }
      if ((await readdir(legacy)).filter((e) => e !== MARKER).length === 0) {
        await rm(legacy, { recursive: true, force: true });
      } else if (!quiet) {
        ui.warn(`fia/ still has entries that also exist in ${FIA.runtimeDir}/ — review and delete fia/ by hand.`);
      }
    }
    result.renamed = true;
  }

  // Root files that moved into imp/ (also for harness-only projects, which
  // have HARNESS.md but never had fia/).
  const rootMoves = [
    ['HARNESS.md', HARNESS.readmeAs],
    [LEGACY_ADDONS_CONFIG_FILE, ADDONS_CONFIG_FILE],
  ];
  for (const [from, to] of rootMoves) {
    if (existsSync(join(dir, from)) && !existsSync(join(dir, to))) {
      await mkdir(dirname(join(dir, to)), { recursive: true });
      await rename(join(dir, from), join(dir, to));
      result.moved.push(`${from} → ${to}`);
    }
  }

  if (!result.renamed && !result.moved.length && !resumeRewrites) return result;
  result.migrated = true;

  if (result.renamed || resumeRewrites) {
    // Manifest keys first (it now lives at the NEW path after the rename).
    const manifest = await readRuntimeManifest(dir);
    if (manifest) {
      manifest.files = Object.fromEntries(
        Object.entries(manifest.files).map(([k, v]) => [
          k.startsWith('fia/') ? `${FIA.runtimeDir}/${k.slice(4)}` : k,
          v,
        ]),
      );
    }

    // Path fix across everything that points at the runtime.
    const fixFile = async (abs, rel, transform = fixLegacyFiaRefs) => {
      const before = await readFile(abs, 'utf8');
      const after = transform(before);
      if (after === before) return;
      await writeFile(abs, after, 'utf8');
      if (!result.rewritten.includes(rel)) result.rewritten.push(rel);
      if (manifest && manifest.files[rel] === sha1(before)) manifest.files[rel] = sha1(after);
    };

    const walkFix = async (root, rel) => {
      if (!existsSync(root)) return;
      for (const entry of await readdir(root, { withFileTypes: true })) {
        const abs = join(root, entry.name);
        const relPath = `${rel}/${entry.name}`;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (MIGRATE_SKIP.has(entry.name) || entry.name.startsWith('.runtime-backup-')) continue;
          await walkFix(abs, relPath);
        } else if (MIGRATE_TEXT_RE.test(entry.name)) {
          await fixFile(abs, relPath);
        }
      }
    };
    await walkFix(target, FIA.runtimeDir);
    await walkFix(join(dir, '.pi'), '.pi');
    // Legacy harness copies in the agent folders also point at the runtime
    // (e.g. .claude/commands/launch.md → node fia/scripts/fia-launch-check.mjs).
    await walkFix(join(dir, '.claude'), '.claude');
    await walkFix(join(dir, '.cursor'), '.cursor');

    // The legacy fia-guard needs two targeted fixes the enumerated regex
    // cannot see: the BARE "fia" token comparison that blocks `rm -rf fia`
    // (no slash), and the PROTECTED regex literals, whose slashes are
    // regex-escaped (`/^fia\/modules(\/|$)/` — the char after `fia` is `\`,
    // so `fia/` never matches and the guard would silently stop protecting
    // the migrated runtime).
    const guardRel = '.pi/extensions/fia-guard.ts';
    if (existsSync(join(dir, guardRel))) {
      await fixFile(join(dir, guardRel), guardRel, (text) =>
        text
          .replaceAll('"fia"', `"${FIA.runtimeDir}"`)
          .replaceAll('fia\\/', `${FIA.runtimeDir}\\/`),
      );
    }

    // Root package.json: only the script values (never deps or app fields).
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      const raw = await readFile(pkgPath, 'utf8');
      try {
        const pkg = JSON.parse(raw);
        let touched = false;
        for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
          const fixed = fixLegacyFiaRefs(String(cmd));
          if (fixed !== cmd) {
            pkg.scripts[name] = fixed;
            touched = true;
          }
        }
        if (touched) {
          await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
          result.rewritten.push('package.json');
        }
      } catch {
        /* invalid package.json — leave it for the steps that report it */
      }
    }

    // .gitignore entries (fia/node_modules/, fia/data/…, fia/.runtime-backup-*/).
    const gitignorePath = join(dir, '.gitignore');
    if (existsSync(gitignorePath)) {
      const raw = await readFile(gitignorePath, 'utf8');
      const fixed = fixLegacyFiaRefs(raw);
      if (fixed !== raw) {
        await writeFile(gitignorePath, fixed, 'utf8');
        result.rewritten.push('.gitignore');
      }
    }

    if (manifest) await saveRuntimeManifest(dir, manifest.files);
    await rm(pendingMarker, { force: true });
  }

  if (!quiet) {
    const parts = [
      ...(result.renamed ? ['fia/ → imp/'] : []),
      ...result.moved,
      ...(result.rewritten.length ? [`${result.rewritten.length} file(s) had fia/ paths fixed`] : []),
    ];
    ui.success(`Layout migrated to imp/: ${parts.join(' · ')}.`);
  }
  return result;
}

async function pkgVersion() {
  const pkg = JSON.parse(await readFile(join(PKG_ROOT, 'package.json'), 'utf8'));
  return pkg.version;
}

/**
 * Consent chooser for locally modified files. `--force` answers yes to
 * everything; non-interactive runs without it keep every modified file;
 * interactive runs ask per file with Yes / Yes to all / No / No to all —
 * the *-to-all answers stick for the rest of the run, so a project whose
 * runtime files ALL differ (typical of one stamped from a live template whose
 * .pi/ mirror lags the CLI) is one keystroke, not one question per file.
 * Exported for tests; `io` injects ui.warn/ui.select.
 */
export function makeModifiedConsent({ force, interactive, version, io = ui }) {
  let sticky = null; // 'yes' | 'no' after a *-to-all answer
  let warned = false;
  return async (entry) => {
    if (force) return true;
    if (!interactive) return false;
    if (sticky) return sticky === 'yes';
    if (!warned) {
      warned = true;
      io.warn(
        `Some runtime files were edited locally after the stamp. Overwriting REPLACES your edits — each file is backed up to ${FIA.runtimeBackupPrefix}<timestamp>/ first.`,
      );
    }
    const choice = await io.select({
      message: `${entry.rel} was modified locally. Overwrite with the impactus ${version} version?`,
      initialValue: 'yes',
      options: [
        { value: 'yes', label: 'Yes' },
        { value: 'yes-all', label: 'Yes to all', hint: 'overwrite the remaining modified files too (each one is backed up)' },
        { value: 'no', label: 'No' },
        { value: 'no-all', label: 'No to all', hint: 'keep the remaining modified files' },
      ],
    });
    if (choice === 'yes-all') sticky = 'yes';
    if (choice === 'no-all') sticky = 'no';
    return choice === 'yes' || choice === 'yes-all';
  };
}

/** Entry point of `--update-runtime`. @returns {Promise<boolean>} true = no errors. */
export async function runUpdateRuntime(flags = {}) {
  const dir = resolve(String(flags.dir || '.'));
  const json = Boolean(flags.json);
  const warnings = [];
  const version = await pkgVersion();

  // Old layout (fia/ + root HARNESS.md/iai.config.json) → current layout first.
  await migrateLegacyFiaLayout(dir, { quiet: json });

  if (!existsSync(join(dir, FIA.runtimeDir)) && !existsSync(join(dir, '.pi'))) {
    const msg = `No ${FIA.runtimeDir}/ or .pi/ found in ${dir} — nothing to update. Run \`npx impactus\` there first (the installer stamps the runtime).`;
    if (json) {
      console.log(JSON.stringify({ ok: false, dir, impactus: version, error: msg }, null, 2));
    } else {
      ui.intro('impactus --update-runtime');
      ui.error(msg);
      ui.outro(ui.color.red('Nothing updated.'));
    }
    return false;
  }

  if (!json) {
    ui.intro('impactus --update-runtime');
    ui.message(`Re-stamping the FIA/Pi runtime at ${dir} from impactus ${version}…`);
  }

  const manifest = await readRuntimeManifest(dir);
  if (!manifest) {
    warnings.push(
      `${FIA.runtimeManifest} missing or invalid — every differing file is treated as locally modified (confirm interactively, or pass --force).`,
    );
    if (!json) ui.warn(warnings[0]);
  }

  const plan = await planRuntimeUpdate({ dir, manifest });

  // Consent for locally modified files: interactive → per-file choice with a
  // sticky "to all" shortcut; non-interactive → skip unless --force.
  const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY && !json && !flags.yes);
  const overwriteModified = makeModifiedConsent({ force: Boolean(flags.force), interactive, version });

  const result = await applyRuntimePlan({ dir, plan, overwriteModified });

  // imp/package.json changed → the new runtime may depend on new packages.
  let ok = true;
  const runtimePkg = `${FIA.runtimeDir}/package.json`;
  const wrotePkg = result.added.includes(runtimePkg) || result.updated.includes(runtimePkg);
  if (wrotePkg) {
    const install = async () => {
      const r = await run('npm', ['install'], { cwd: join(dir, FIA.runtimeDir) });
      if (!r.ok) throw new Error(`npm install in ${FIA.runtimeDir}/ failed:\n${r.stderr || r.stdout}`);
    };
    try {
      if (json) await install();
      else
        await ui.spin(
          `${runtimePkg} changed — installing FIA dependencies…`,
          install,
          'FIA dependencies installed.',
        );
    } catch (err) {
      ok = false; // new runtime code + old deps is a broken runtime
      warnings.push(err?.message || String(err));
      if (!json) ui.error(warnings[warnings.length - 1]);
    }
  }

  // Pi packages (subagents + MCP adapter + web access) — idempotent; a
  // missing/failed Pi never fails the update (same degrade as the installer).
  try {
    const piPkgs = await installPiPackages(dir);
    if (piPkgs.skipped.length) {
      warnings.push(
        `Pi packages left untouched (customized in your Pi settings): ${piPkgs.skipped.join(', ')} — ` +
          'refresh manually if you want: pi install npm:<name>@latest',
      );
      if (!json) ui.warn(warnings[warnings.length - 1]);
    }
  } catch (err) {
    warnings.push(`Pi packages not refreshed: ${err?.message || String(err)}`);
    if (!json) ui.warn(warnings[warnings.length - 1]);
  }

  // Projects stamped before the `.pi/skills/` copy leg was removed still carry
  // one copy per official skill — Pi discovers .agents/skills/ natively, so
  // those copies only feed the "Skill conflicts" panel at every launch.
  const pruned = await prunePiSkillCopies(dir);
  if (pruned > 0 && !json) ui.info(`Removed ${pruned} duplicated skill folder(s) from .pi/skills/ — Pi reads .agents/skills/ directly.`);

  await ensureFiaGitignore(dir);

  // New runtime versions ship new npm entry points (`npm run tui`,
  // `env:check`…) — an updated project must get them too, under the same
  // non-clobber contract as the installer.
  let scripts = { added: [], aliased: [] };
  try {
    scripts = await mergeFiaNpmScripts(dir);
  } catch (err) {
    warnings.push(`package.json npm scripts not merged: ${err?.message || String(err)}`);
    if (!json) ui.warn(warnings[warnings.length - 1]);
  }
  if (scripts.aliased.length) {
    const msg = `Your package.json already had npm scripts with these names — yours were kept and the FIA versions were added as: ${scripts.aliased.join(', ')}.`;
    warnings.push(msg);
    if (!json) ui.warn(msg);
  }

  await saveRuntimeManifest(dir, manifestFilesAfter(plan));

  const report = {
    ok,
    dir,
    impactus: version,
    added: result.added,
    updated: result.updated,
    skippedModified: result.skippedModified,
    unchanged: result.unchanged.length,
    backupDir: result.backupDir,
    npmScriptsAdded: scripts.added,
    warnings,
  };
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return ok;
  }

  const lines = [
    `added             ${result.added.length}`,
    ...result.added.map((f) => `  + ${f}`),
    `updated           ${result.updated.length}`,
    ...result.updated.map((f) => `  ~ ${f}`),
    `skipped-modified  ${result.skippedModified.length}`,
    ...result.skippedModified.map((f) => `  ! ${f} (kept — yours)`),
    `unchanged         ${result.unchanged.length}`,
    ...(scripts.added.length
      ? [`npm scripts added ${scripts.added.length}`, ...scripts.added.map((s) => `  + npm run ${s}`)]
      : []),
  ];
  ui.note(lines.join('\n'), `Runtime update — impactus ${version}`);
  if (result.backupDir) ui.info(`Every overwritten file was backed up to ${result.backupDir}/.`);
  if (result.skippedModified.length && !flags.force) {
    ui.info('Locally modified files were kept. Re-run with --force to overwrite them too (backups are always taken).');
  }
  if (result.forcedRuntime?.length) {
    // Not a silent overwrite: the student edited runtime code, and keeping it
    // would have produced an unloadable tree. Say so and name the backup.
    ui.info(
      `${result.forcedRuntime.length} edited runtime file(s) were updated anyway — the runtime imports itself, so a mixed-version imp/ cannot load. ` +
        `Your versions are in ${result.backupDir || FIA.runtimeBackupPrefix + '<timestamp>'}/: ${result.forcedRuntime.slice(0, 3).join(', ')}${result.forcedRuntime.length > 3 ? ', …' : ''}`,
    );
  }
  ui.outro(ok ? 'Runtime updated. ✅' : ui.color.red('Runtime update finished with errors — see above.'));
  return ok;
}
