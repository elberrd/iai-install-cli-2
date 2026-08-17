// Is the stamped FIA runtime COMPLETE enough to load?
//
// The runtime under `imp/` is ESM that imports itself: modules/ and scripts/
// reference each other by relative path. Half of it is not a degraded runtime,
// it is a dead one — Node fails at module resolution before a single line runs,
// so the student gets a raw ERR_MODULE_NOT_FOUND stack instead of a diagnosis.
//
// Three consumers need that answer and must never disagree about it:
//   - `imp doctor`  — detection (it used to report a green runtime while 57
//                     files were missing, because it probed only two paths);
//   - `imp fix`     — what to restore (restore-only, never overwrites);
//   - `bin/imp.js`  — the hint printed when a stamped reporter dies.
// Hence one module. Prose (.pi/prompts/, .pi/skills/) is deliberately OUT of
// scope: it has no import graph, and adding new prose is --update-runtime's job.
//
// Deliberately light on imports (node builtins + the config data only): the
// launcher loads this on a failed verb, and pulling the installer's prompt
// layer in for a guard would be absurd. `runtimeTrees()` mirrors
// `templateTrees()` in src/steps/update-runtime.js — a test pins them equal.
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIA } from '../config.js';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Runtime directories whose files import each other. */
export const RUNTIME_CODE_DIRS = [`${FIA.runtimeDir}/modules/`, `${FIA.runtimeDir}/scripts/`];

const FDA_ENTRY = new RegExp(`^${FIA.runtimeDir}/fda_[^/]+\\.mjs$`);

/** Is this project-relative path part of the runtime's own import graph? */
export function isRuntimeCode(rel) {
  const path = String(rel || '');
  return RUNTIME_CODE_DIRS.some((prefix) => path.startsWith(prefix)) || FDA_ENTRY.test(path);
}

/** The template trees this package would stamp. Twin of templateTrees(). */
export function runtimeTrees() {
  return [
    { src: join(PKG_ROOT, FIA.fiaTemplateDir), prefix: FIA.runtimeDir },
    { src: join(PKG_ROOT, FIA.piTemplateDir), prefix: '.pi' },
  ];
}

/** Every file the bundled templates ship, as project-relative paths. */
export async function listTemplateFiles(trees = runtimeTrees()) {
  const out = [];
  const walk = async (dir, prefix) => {
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      /* a template tree absent from this install — contribute nothing */
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  for (const tree of trees) await walk(tree.src, tree.prefix);
  return out.sort();
}

/**
 * Runtime code files this package ships that the project does not have.
 * Empty array when the project has no `imp/` at all — a project without a
 * runtime is not a BROKEN runtime, and `imp init` is the answer there, not a
 * repair. Never throws.
 */
export async function missingRuntimeCode(cwd, { trees } = {}) {
  if (!existsSync(join(cwd, FIA.runtimeDir))) return [];
  const files = await listTemplateFiles(trees);
  return files.filter((rel) => isRuntimeCode(rel) && !existsSync(join(cwd, rel)));
}

/**
 * Runtime code files the project HAS but at a different version than this
 * package ships. Restoring a missing file next to one of these still yields a
 * tree that cannot load — and `imp fix` is restore-only, so it may report the
 * mix but must never silently overwrite it. Never throws.
 */
export async function staleRuntimeCode(cwd, { trees = runtimeTrees() } = {}) {
  if (!existsSync(join(cwd, FIA.runtimeDir))) return [];
  const stale = [];
  for (const tree of trees) {
    for (const rel of (await listTemplateFiles([tree])).filter(isRuntimeCode)) {
      const dest = join(cwd, rel);
      if (!existsSync(dest)) continue;
      const src = join(tree.src, rel.slice(tree.prefix.length + 1));
      try {
        const [a, b] = await Promise.all([readFile(src), readFile(dest)]);
        if (!a.equals(b)) stale.push(rel);
      } catch {
        /* unreadable on either side — not something a repair can judge */
      }
    }
  }
  return stale.sort();
}

/** The one English sentence every consumer prints. Keep it identical. */
export function runtimeHint(missing) {
  const n = missing.length;
  return (
    `${n} FIA runtime file(s) are missing from imp/ — the runtime imports itself, so a partial one cannot load at all. ` +
    'Restore them with `imp fix`, or bring everything current with `npx impactus --update-runtime`.'
  );
}
