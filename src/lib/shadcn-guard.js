// Guard-rail for the shadcn step: PURE helpers (no I/O, testable) to decide
// what to restore and what to delete after a `shadcn add -y -o`.
//
// A registry block's value lives in components/ui/*, hooks/* and lib/* (and
// the deps it installs). Its "demo" — the Acme Inc app-sidebar, a nav-user
// without logout, an example page.tsx — must NOT replace the template's real
// application code: that's exactly the damage -o would do without this
// guard-rail.

/**
 * Parse `git status --porcelain` → Map path → 2-char code ('M ', '??'…).
 * Renames ("R  old -> new") are recorded under the NEW path.
 */
export function parseStatus(out) {
  const map = new Map();
  for (const raw of String(out || '').split('\n')) {
    if (!raw.trim()) continue;
    const code = raw.slice(0, 2);
    let path = raw.slice(3).trim();
    const arrow = path.indexOf(' -> ');
    if (arrow !== -1) path = path.slice(arrow + 4);
    // git quotes paths that contain special characters
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    map.set(path, code);
  }
  return map;
}

/**
 * APPLICATION code (which the block must not replace): .ts/.tsx under app/**
 * or components/** — except components/ui/**, the block's legitimate part.
 */
export function isAppCode(path) {
  if (!/\.(tsx|ts)$/.test(path)) return false;
  if (path.startsWith('components/ui/')) return false;
  return path.startsWith('app/') || path.startsWith('components/');
}

/**
 * Compares the status from before/after the `add`.
 * @param {Map<string,string>} before - parseStatus before the add
 * @param {Map<string,string>} after - parseStatus after the add
 * @returns {{restore: string[], created: string[]}}
 *   restore – tracked application files the add MODIFIED
 *             (go back to the baseline via `git checkout --`)
 *   created – NEW (untracked) application files created by the add
 *             (removed if nobody imports them)
 */
export function classifyBlockChanges(before, after) {
  const restore = [];
  const created = [];
  for (const [path, code] of after) {
    if (before.get(path) === code) continue; // already like this before the add
    if (!isAppCode(path)) continue;
    if (code === '??' || code === 'A ') created.push(path);
    else if (code.includes('M')) restore.push(path);
  }
  return { restore: restore.sort(), created: created.sort() };
}

/**
 * Does anyone import this file? Content heuristic: covers the alias
 * ("@/components/nav-main") and the same-directory relative ("./nav-main").
 * A false positive keeps the file (the safe direction).
 * @param {string} filePath - relative path (e.g. 'components/nav-main.tsx')
 * @param {string[]} sources - contents of the project's sources (minus the candidates)
 */
export function isImported(filePath, sources) {
  const noExt = filePath.replace(/\.(tsx|ts)$/, '');
  const base = noExt.split('/').pop();
  const needles = [`/${noExt}"`, `/${noExt}'`, `./${base}"`, `./${base}'`];
  return sources.some((src) => needles.some((n) => src.includes(n)));
}
