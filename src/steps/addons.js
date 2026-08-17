import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  ADDON_NOTES,
  ADDONS_CONFIG_FILE,
  ADDONS_MANIFEST_FILE,
  ALL_ADDON_IDS,
} from '../config.js';
import {
  catalogFromManifest,
  expandChosen,
  filesToRemove,
  MARKER_HINT,
  prunePackageJson,
  resolveAddonFlags,
  stripMarkedContent,
} from '../lib/addons.js';
import { logLine } from '../lib/log.js';
import * as ui from '../lib/ui.js';

/**
 * The stack CHOICE now happens in the decisions phase (steps/decisions.js),
 * BEFORE the download, using the CLI's built-in catalog. This step reconciles
 * the choice with the downloaded template: if template.addons.json declares
 * its own `groups`/`presets` (ctx.templateManifest), it is the source of truth
 * — a new template can expose groups without a CLI release.
 *
 *   - Selection via flags (--preset/--addons/…): re-resolved against the
 *     manifest's catalog — exactly the classic behavior.
 *   - Interactive selection: intersected with the manifest's catalog; ids the
 *     template doesn't know are dropped (with a warning) and new options that
 *     were never asked stay out (with a warning on how to re-enable them).
 *
 * Runs in installTemplate, right before applyAddons.
 */
export function reconcileAddons(ctx) {
  const manifestCatalog = catalogFromManifest(ctx.templateManifest);
  if (!manifestCatalog) return;

  if (ctx.addonsSource === 'flags') {
    const { chosen, errors } = resolveAddonFlags(ctx.flags ?? {}, manifestCatalog);
    for (const err of errors) ui.warn(err);
    ctx.addons = chosen;
    ctx.addonCatalog = manifestCatalog;
    return;
  }

  const known = new Set(manifestCatalog.allIds);
  const dropped = (ctx.addons ?? []).filter((id) => !known.has(id));
  if (dropped.length) {
    ctx.addons = (ctx.addons ?? []).filter((id) => known.has(id));
    ui.warn(`The downloaded template doesn't know: ${dropped.join(', ')} — removed from the selection.`);
  }
  const asked = new Set(ctx.addonCatalog?.allIds ?? ALL_ADDON_IDS);
  const extra = manifestCatalog.allIds.filter((id) => !asked.has(id));
  if (extra.length) {
    ui.info(
      `The template ships options the CLI doesn't ask about yet (${extra.join(', ')}) — they stay out; the project README shows how to re-enable them.`,
    );
  }
  ctx.addonCatalog = manifestCatalog;
}

/**
 * Apply the choice to the freshly cloned project (BEFORE npm install):
 *   1. delete files of unchosen addons (per the template manifest);
 *   2. strip `live1:addon:*` marker blocks everywhere;
 *   3. prune package.json deps/scripts;
 *   4. record the choice in live1.config.json; drop the manifest.
 * Missing manifest (old template) → warn and continue untouched.
 */
export async function applyAddons(ctx) {
  const { dir } = ctx;
  const chosen = ctx.addons ?? [];
  const manifestPath = join(dir, ADDONS_MANIFEST_FILE);

  if (!existsSync(manifestPath)) {
    ui.warn(`Template has no ${ADDONS_MANIFEST_FILE} — keeping everything that came in the download.`);
    return;
  }

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const keep = expandChosen(manifest, chosen);

  // 1. Delete files/folders that belong only to unchosen addons.
  const doomed = filesToRemove(manifest, chosen);
  for (const rel of doomed) {
    await rm(join(dir, rel), { recursive: true, force: true });
    logLine(`addons: removed ${rel}`);
  }
  await removeEmptiedParents(dir, doomed);

  // 2. Strip marker blocks across the whole project.
  const touched = await stripMarkersInTree(dir, keep);
  logLine(`addons: markers processed in ${touched} file(s)`);

  // 3. Prune package.json.
  const pkgPath = join(dir, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  const pruned = prunePackageJson(pkg, manifest, chosen);
  await writeFile(pkgPath, JSON.stringify(pruned, null, 2) + '\n', 'utf8');

  // 4. Persist the choice + drop the manifest from the generated project.
  // The config lives inside imp/, which the FIA/harness steps only create
  // LATER in the pipeline — make the folder here.
  await mkdir(dirname(join(dir, ADDONS_CONFIG_FILE)), { recursive: true });
  await writeFile(
    join(dir, ADDONS_CONFIG_FILE),
    JSON.stringify({ createdWith: 'impactus', addons: [...chosen].sort() }, null, 2) + '\n',
    'utf8',
  );
  await rm(manifestPath, { force: true });

  // {id, text} pairs: the final summary filters out notes for services the
  // keys step already left 100% configured (no redundant instructions).
  ctx.addonNotes = [...chosen]
    .filter((id) => ADDON_NOTES[id])
    .map((id) => ({ id, text: ADDON_NOTES[id] }));

  const removedCount = (ctx.addonCatalog?.allIds ?? ALL_ADDON_IDS).length - chosen.length;
  ui.success(
    `Stack applied: ${chosen.length} addon(s) kept, ${removedCount} removed from the code.`,
  );
}

/**
 * Deleting addon files can empty their parent folders (e.g. components/billing
 * when no payment provider was chosen) — remove those directories up to the
 * project root so the generated project carries no empty folders.
 */
async function removeEmptiedParents(root, removedPaths) {
  const parents = new Set(
    removedPaths
      .map((rel) => rel.split('/').slice(0, -1).join('/'))
      .filter(Boolean),
  );
  for (let parent of parents) {
    while (parent) {
      const abs = join(root, parent);
      if (!existsSync(abs)) break;
      const entries = await readdir(abs);
      if (entries.length > 0) break;
      await rm(abs, { recursive: true, force: true });
      logLine(`addons: empty folder removed ${parent}`);
      parent = parent.split('/').slice(0, -1).join('/');
    }
  }
}

// Directories never worth scanning for markers.
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '_generated', 'public']);
// Only text files can carry markers.
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|mts|cjs|json|yml|yaml|md|css|example|txt)$/;

/** Walk the tree, stripping marker blocks. Returns how many files changed. */
async function stripMarkersInTree(root, keep) {
  let touched = 0;
  async function walk(dirPath) {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full);
        continue;
      }
      if (!TEXT_EXT.test(entry.name) && entry.name !== '.env.example') continue;
      const info = await stat(full);
      if (info.size > 1024 * 1024) continue; // markers don't live in huge blobs
      const content = await readFile(full, 'utf8');
      if (!content.includes(MARKER_HINT)) continue;
      const next = stripMarkedContent(content, keep);
      if (next !== content) {
        await writeFile(full, next, 'utf8');
        touched++;
      }
    }
  }
  await walk(root);
  return touched;
}
