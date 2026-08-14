// Pure helpers for the addon system (no I/O — fully unit-testable).
//
// The template ships with EVERY addon implemented. Removal is driven by two
// mechanisms, both described in the template's `template.addons.json`:
//
//   1. MARKER BLOCKS inside shared files:
//        // live1:addon:sentry:start
//        …code that only exists for the sentry addon…
//        // live1:addon:sentry:end
//      Blocks of unchosen addons are deleted; marker lines themselves are
//      always deleted (chosen addons keep their code, minus the markers).
//      Inverse blocks (`live1:addon!:csp:start`) are the baseline that must
//      exist only when the addon is NOT chosen (e.g. the minimal CSP header).
//
//   2. The MANIFEST lists, per addon: files to delete, package.json deps and
//      scripts to prune. A file/dep listed by several addons is only removed
//      when NONE of them was chosen.

const MARKER_RE = /live1:addon(!?):([a-z0-9-]+):(start|end)/;

export const MARKER_HINT = 'live1:addon';

/**
 * Strip addon marker blocks from a file's content.
 * @param {string} content
 * @param {Set<string>} keep - addon ids the user chose (virtual ids included).
 * @returns {string} content with unchosen blocks removed and ALL marker lines gone.
 */
export function stripMarkedContent(content, keep) {
  const lines = content.split('\n');
  const out = [];
  /** @type {{id: string, inverse: boolean, remove: boolean}[]} */
  const stack = [];

  for (const line of lines) {
    const m = line.match(MARKER_RE);
    if (m) {
      const [, bang, id, kind] = m;
      const inverse = bang === '!';
      if (kind === 'start') {
        const chosen = keep.has(id);
        const remove = inverse ? chosen : !chosen;
        stack.push({ id, inverse, remove });
      } else {
        // Tolerate stray/duplicated end markers instead of corrupting output.
        const top = stack[stack.length - 1];
        if (top && top.id === id && top.inverse === inverse) stack.pop();
      }
      continue; // marker lines never survive
    }
    const removed = stack.some((b) => b.remove);
    if (!removed) out.push(line);
  }
  return collapseBlankRuns(out).join('\n');
}

/** Collapse 3+ consecutive blank lines (left behind by removed blocks) into 1. */
function collapseBlankRuns(lines) {
  const out = [];
  let blanks = 0;
  for (const line of lines) {
    if (line.trim() === '') {
      blanks++;
      if (blanks > 1) continue;
    } else {
      blanks = 0;
    }
    out.push(line);
  }
  return out;
}

/**
 * Expand the chosen set with the manifest's virtual ids (e.g. `billing-ui`
 * is "on" when stripe OR clerk-billing is on) — virtual ids exist only to be
 * used in markers shared by several addons.
 * @param {object} manifest
 * @param {Iterable<string>} chosen
 * @returns {Set<string>}
 */
export function expandChosen(manifest, chosen) {
  const keep = new Set(chosen);
  for (const [virtualId, members] of Object.entries(manifest.virtual ?? {})) {
    if (members.some((id) => keep.has(id))) keep.add(virtualId);
  }
  return keep;
}

/**
 * Files to delete: those whose EVERY owning addon was left out.
 * @returns {string[]} project-relative paths.
 */
export function filesToRemove(manifest, chosen) {
  const keep = new Set(chosen);
  /** @type {Map<string, boolean>} path -> some owner kept? */
  const owners = new Map();
  for (const [id, addon] of Object.entries(manifest.addons ?? {})) {
    for (const file of addon.files ?? []) {
      owners.set(file, (owners.get(file) ?? false) || keep.has(id));
    }
  }
  return [...owners.entries()].filter(([, kept]) => !kept).map(([file]) => file);
}

/**
 * Prune package.json: drop deps/devDeps/scripts belonging exclusively to
 * unchosen addons. Returns a NEW object (input untouched).
 */
export function prunePackageJson(pkg, manifest, chosen) {
  const keep = new Set(chosen);
  const removableDeps = new Map(); // name -> some owner kept?
  const removableScripts = new Map();

  for (const [id, addon] of Object.entries(manifest.addons ?? {})) {
    const kept = keep.has(id);
    for (const dep of [...(addon.dependencies ?? []), ...(addon.devDependencies ?? [])]) {
      removableDeps.set(dep, (removableDeps.get(dep) ?? false) || kept);
    }
    for (const script of addon.scripts ?? []) {
      removableScripts.set(script, (removableScripts.get(script) ?? false) || kept);
    }
  }

  const next = structuredClone(pkg);
  for (const section of ['dependencies', 'devDependencies']) {
    if (!next[section]) continue;
    for (const [dep, kept] of removableDeps) {
      if (!kept) delete next[section][dep];
    }
  }
  if (next.scripts) {
    for (const [script, kept] of removableScripts) {
      if (!kept) delete next.scripts[script];
    }
  }
  return next;
}

/**
 * Addon catalog coming from the template ITSELF (template.addons.json with the
 * optional `groups`/`presets` fields, same shape as ADDON_GROUPS /
 * ADDON_PRESETS). Returns null when the manifest has no valid groups — the
 * caller falls back to the CLI's built-in catalog. Derived presets: `minimo`
 * (empty) and `padrao` (recommended) always exist; the manifest's win.
 * @param {object|null|undefined} manifest
 * @returns {{groups: object[], presets: object, allIds: string[]}|null}
 */
export function catalogFromManifest(manifest) {
  const groups = manifest?.groups;
  if (!Array.isArray(groups) || groups.length === 0) return null;
  const valid = groups.every(
    (g) =>
      g && typeof g.id === 'string' && typeof g.flag === 'string' &&
      typeof g.title === 'string' && Array.isArray(g.options) &&
      g.options.every((o) => o && typeof o.value === 'string'),
  );
  if (!valid) return null;

  const allIds = groups.flatMap((g) =>
    g.options.map((o) => o.value).filter((v) => v !== 'none'),
  );
  const presets = {
    minimo: [],
    padrao: groups.flatMap((g) =>
      g.options.filter((o) => o.recommended && o.value !== 'none').map((o) => o.value),
    ),
    ...(manifest.presets && typeof manifest.presets === 'object' ? manifest.presets : {}),
  };
  return { groups, presets, allIds };
}

/**
 * Resolve CLI flags into the chosen addon set. Precedence:
 * explicit group flags > --preset > defaults (recommended set).
 * @param {object} flags - parsed CLI flags.
 * @param {object} catalog - { groups, presets, allIds } from config.js.
 * @returns {{chosen: string[], errors: string[]}}
 */
export function resolveAddonFlags(flags, catalog) {
  const { groups, presets, allIds } = catalog;
  const errors = [];
  const chosen = new Set(
    flags.preset ? (presets[flags.preset] ?? []) : (presets.padrao ?? []),
  );

  for (const group of groups) {
    const raw = flags[group.flag];
    if (raw == null) continue;
    const groupValues = group.options.map((o) => o.value).filter((v) => v !== 'none');

    // A group flag fully overrides that group (preset or default).
    for (const v of groupValues) chosen.delete(v);

    const values =
      raw === 'none'
        ? []
        : raw === 'all'
          ? groupValues
          : String(raw)
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);

    for (const v of values) {
      if (!groupValues.includes(v)) {
        errors.push(`--${group.flag}: unknown value "${v}" (accepts: ${groupValues.join(', ')}${group.single ? '' : ', none, all'})`);
        continue;
      }
      chosen.add(v);
    }
    if (group.single && values.length > 1) {
      errors.push(`--${group.flag} accepts only ONE value.`);
    }
  }

  // Sanity: everything chosen must exist in the catalog.
  for (const id of chosen) {
    if (!allIds.includes(id)) chosen.delete(id);
  }

  return { chosen: [...chosen], errors };
}
