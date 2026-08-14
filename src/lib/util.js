/** Split a pasted command line into tokens, honoring single/double quotes. */
export function tokenize(line) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(line))) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3]);
  }
  return tokens;
}

/**
 * Extract Cloudflare accounts from `wrangler whoami` output. The command
 * prints a box-drawing table of `Account Name │ Account ID` rows; account ids
 * are 32 lowercase hex chars. Returns `[{ id, name }]` (name may be '').
 */
export function extractCloudflareAccounts(text) {
  const accounts = [];
  const seen = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/\b([0-9a-f]{32})\b/i);
    if (!m) continue;
    const id = m[1].toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    const name = line
      .slice(0, m.index)
      .replace(/[│┌┬┐├┼┤└┴┘─|]/g, ' ')
      .trim();
    accounts.push({ id, name });
  }
  return accounts;
}

/** Turn a human name into a safe slug for npm/Convex project names. */
export function slugify(name) {
  const s = String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'my-app';
}
