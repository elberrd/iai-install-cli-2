// Neon Launchpad (https://neon.new) — instant Postgres with NO account.
//
// The POST returns the connection string and a CLAIM URL: the database is born
// anonymous and the person claims it into their own Neon account within ~72h
// (after that it expires). Same flow the scaffolders use (`neon-new` package /
// `instantPostgres` SDK). Docs: https://neon.com/docs/reference/neon-launchpad
//
// Everything here is best-effort: a network failure or a shape change NEVER
// aborts the install — the caller falls back to the manual instructions.

const LAUNCHPAD_API = 'https://neon.new/api/v1/database';

/**
 * Creates a claimable Postgres on the Neon Launchpad.
 * @param {string} ref - integrator identifier (visible to Neon).
 * @returns {Promise<{databaseUrl: string, directUrl: string|null, claimUrl: string|null, expiresAt: string|null}>}
 */
export async function createClaimableNeonDb(ref = 'impactus') {
  const res = await fetch(LAUNCHPAD_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`neon.new answered HTTP ${res.status}`);
  const parsed = normalizeNeonResponse(await res.json());
  if (!parsed.databaseUrl) throw new Error('neon.new response has no recognizable connection string');
  return parsed;
}

/**
 * Extracts the useful fields from the response without depending on the exact
 * shape (the API belongs to the Launchpad product, not versioned for us).
 * Pure — testable.
 * @param {unknown} data
 */
export function normalizeNeonResponse(data) {
  const flat = flatten(data);
  const find = (keyRe, valueRe) => {
    for (const [key, value] of flat) {
      if (typeof value === 'string' && keyRe.test(key) && (!valueRe || valueRe.test(value))) return value;
    }
    return null;
  };
  // The "direct" URL (no pooler) first — otherwise the generic match would swallow it.
  const directUrl = find(/direct/i, /^postgres(ql)?:\/\//);
  let databaseUrl = null;
  for (const [key, value] of flat) {
    if (
      typeof value === 'string' &&
      /database_url|connection_string|connection_uri|^url$/i.test(key) &&
      /^postgres(ql)?:\/\//.test(value) &&
      value !== directUrl
    ) {
      databaseUrl = value;
      break;
    }
  }
  return {
    databaseUrl: databaseUrl ?? directUrl,
    directUrl,
    claimUrl: find(/claim/i, /^https?:\/\//),
    expiresAt: find(/expires/i),
  };
}

/**
 * Extracts the connection string from `neon projects create --output json`
 * output (the Tier-1 path, in the user's OWN account — authenticated CLI).
 * The documented shape carries `connection_uris[0].connection_uri`; the
 * tolerant normalizer covers variations. Pure — testable.
 * @param {string} stdout - raw JSON output from the CLI.
 * @returns {{databaseUrl: string|null, projectId: string|null}}
 */
export function parseNeonProjectCreate(stdout) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { databaseUrl: null, projectId: null };
  }
  const uri = data?.connection_uris?.[0]?.connection_uri ?? normalizeNeonResponse(data).databaseUrl;
  const projectId = data?.project?.id ?? data?.id ?? null;
  return { databaseUrl: typeof uri === 'string' && /^postgres/.test(uri) ? uri : null, projectId };
}

/** Flattens an object into [key, value] pairs (depth first). */
function flatten(data, out = []) {
  if (data == null || typeof data !== 'object') return out;
  for (const [key, value] of Object.entries(data)) {
    if (value != null && typeof value === 'object') flatten(value, out);
    else out.push([key, value]);
  }
  return out;
}
