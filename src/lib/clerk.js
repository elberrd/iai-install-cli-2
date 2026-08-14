// Pure helpers for the Clerk step (easy to reason about / test).

/**
 * Derive the Clerk Frontend API issuer URL from a publishable key.
 *   pk_(test|live)_<base64("<frontend-api-host>$")>  ->  https://<host>
 * This is deterministic, so we avoid an extra API round-trip.
 */
export function issuerFromPublishableKey(pk) {
  if (!pk) return null;
  const m = /^pk_(?:test|live)_([A-Za-z0-9+/=_-]+)\s*$/.exec(String(pk).trim());
  if (!m) return null;
  let decoded;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  const host = decoded.replace(/\$+$/, '').trim();
  if (!host || !host.includes('.')) return null;
  return `https://${host}`;
}

/** Real key vs the `pk_test_xxxx…` placeholder shipped in .env.example. */
export function looksLikeRealPk(pk) {
  return !!pk && /^pk_(test|live)_/.test(pk.trim()) && !/x{6,}/i.test(pk);
}
export function looksLikeRealSk(sk) {
  return !!sk && /^sk_(test|live)_/.test(sk.trim()) && !/x{6,}/i.test(sk);
}

/** Recursively search a parsed JSON value for the first `app_…` id. */
export function findAppId(value) {
  const re = /^app_[A-Za-z0-9]+$/;
  const seen = new Set();
  const walk = (v) => {
    if (typeof v === 'string') return re.test(v) ? v : null;
    if (v && typeof v === 'object') {
      if (seen.has(v)) return null;
      seen.add(v);
      for (const child of Array.isArray(v) ? v : Object.values(v)) {
        const hit = walk(child);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(value);
}

/** Recursively search a parsed JSON value for the first publishable key. */
export function findPublishableKey(value) {
  const re = /^pk_(test|live)_[A-Za-z0-9+/=_-]+$/;
  const seen = new Set();
  const walk = (v) => {
    if (typeof v === 'string') return re.test(v.trim()) ? v.trim() : null;
    if (v && typeof v === 'object') {
      if (seen.has(v)) return null;
      seen.add(v);
      for (const child of Array.isArray(v) ? v : Object.values(v)) {
        const hit = walk(child);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(value);
}

/**
 * Normalize a Clerk app object (from `apps create --json` or one item of
 * `apps list --json`) into { appId, name, pk }. Prefers the development
 * instance's publishable key; falls back to any pk_ found in the object.
 */
export function extractAppInfo(appObj) {
  if (!appObj || typeof appObj !== 'object') return { appId: null, name: null, pk: null };
  const appId = appObj.application_id || appObj.id || findAppId(appObj);
  const name = appObj.name ?? null;
  let pk = null;
  const instances = Array.isArray(appObj.instances) ? appObj.instances : [];
  const dev = instances.find((i) => i && i.environment_type === 'development') || instances[0];
  if (dev && dev.publishable_key) pk = dev.publishable_key;
  if (!pk) pk = findPublishableKey(appObj);
  return { appId, name, pk };
}

/** Parse `apps list --json` into an array of { appId, name, pk }. */
export function parseAppList(listJson) {
  try {
    const data = typeof listJson === 'string' ? JSON.parse(listJson) : listJson;
    const arr = Array.isArray(data) ? data : (data.data ?? data.apps ?? []);
    return arr.map(extractAppInfo).filter((a) => a.appId);
  } catch {
    return [];
  }
}

/** From `clerk apps list --json`, find the id of the app whose name matches. */
export function matchAppIdByName(listJson, name) {
  const app = parseAppList(listJson).find((a) => a.name === name);
  return app ? app.appId : null;
}
