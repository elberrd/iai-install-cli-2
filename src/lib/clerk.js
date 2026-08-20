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

/** `test` or `live` for a Clerk key; null for invalid/unknown values. */
export function clerkKeyEnvironment(key) {
  const match = /^(?:pk|sk)_(test|live)_/.exec(String(key || '').trim());
  return match ? match[1] : null;
}

/** Ensure a publishable/secret pair belongs to the same Clerk environment. */
export function validateClerkKeyPair(pk, sk) {
  if (!looksLikeRealPk(pk) || !looksLikeRealSk(sk)) {
    return { ok: false, environment: null, reason: 'Both Clerk keys must be real pk_/sk_ values.' };
  }
  const pkEnvironment = clerkKeyEnvironment(pk);
  const skEnvironment = clerkKeyEnvironment(sk);
  if (pkEnvironment !== skEnvironment) {
    return {
      ok: false,
      environment: null,
      reason: `Clerk key mismatch: publishable key is ${pkEnvironment}, secret key is ${skEnvironment}.`,
    };
  }
  return { ok: true, environment: pkEnvironment, reason: null };
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

/** Recursively search a structured response for a Clerk instance id. */
export function findInstanceId(value) {
  const re = /^ins_[A-Za-z0-9]+$/;
  const seen = new Set();
  const walk = (v) => {
    if (typeof v === 'string') return re.test(v) ? v : null;
    if (!v || typeof v !== 'object' || seen.has(v)) return null;
    seen.add(v);
    for (const child of Array.isArray(v) ? v : Object.values(v)) {
      const hit = walk(child);
      if (hit) return hit;
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
  if (!appObj || typeof appObj !== 'object') {
    return { appId: null, name: null, pk: null, instanceId: null };
  }
  const appId = appObj.application_id || appObj.id || findAppId(appObj);
  const name = appObj.name ?? null;
  let pk = null;
  const instances = Array.isArray(appObj.instances) ? appObj.instances : [];
  const dev = instances.find((i) => i && i.environment_type === 'development') || instances[0];
  if (dev && dev.publishable_key) pk = dev.publishable_key;
  if (!pk) pk = findPublishableKey(appObj);
  const instanceId = dev?.instance_id || findInstanceId(dev) || null;
  return { appId, name, pk, instanceId };
}

/** Parse `apps list --json` into an array of { appId, name, pk }. */
export function parseAppList(listJson) {
  try {
    const data = typeof listJson === 'string' ? JSON.parse(listJson) : listJson;
    const arr = Array.isArray(data) ? data : (data.data ?? data.apps ?? data.applications ?? []);
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

/** All exact-name matches (duplicates are possible in a Clerk account). */
export function matchAppsByName(apps, name) {
  return (Array.isArray(apps) ? apps : []).filter((app) => app.name === name);
}

/** Parse the structured `clerk whoami --json` result without scraping prose. */
export function parseWhoami(value) {
  let data = value;
  try {
    if (typeof data === 'string') data = JSON.parse(data);
  } catch {
    return { email: null, appId: null };
  }
  return { email: findEmail(data), appId: findAppId(data) };
}

/** Recursively search a parsed JSON value for the first e-mail address. */
export function findEmail(value) {
  const email = /^[A-Za-z0-9][\w.+-]*@[\w-]+\.[\w.-]+$/;
  const seen = new Set();
  const walk = (item) => {
    if (typeof item === 'string') return email.test(item.trim()) ? item.trim() : null;
    if (!item || typeof item !== 'object' || seen.has(item)) return null;
    seen.add(item);
    const preferred = ['email', 'email_address', 'emailAddress'];
    for (const key of preferred) {
      const hit = walk(item[key]);
      if (hit) return hit;
    }
    for (const child of Array.isArray(item) ? item : Object.values(item)) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return null;
  };
  return walk(value);
}

/** Normalize Clerk's list response into a plain array of JWT templates. */
export function parseJwtTemplates(value) {
  try {
    const data = typeof value === 'string' ? JSON.parse(value) : value;
    const templates = Array.isArray(data) ? data : (data?.data ?? data?.jwt_templates ?? []);
    return Array.isArray(templates) ? templates : [];
  } catch {
    return [];
  }
}

/** Return the exact fields that differ from the expected Convex JWT template. */
export function jwtTemplateDiff(actual, expected) {
  if (!actual) return ['missing'];
  const diff = [];
  if (actual.name !== expected.name) diff.push('name');
  if (Number(actual.lifetime) !== Number(expected.lifetime)) diff.push('lifetime');
  if (stableJson(actual.claims ?? {}) !== stableJson(expected.claims ?? {})) diff.push('claims');
  return diff;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Application ownership check for the keys pulled after app selection. */
export function validateAppPublishableKey(app, pk) {
  if (!app?.pk || !looksLikeRealPk(app.pk)) return { ok: true, reason: null };
  if (app.pk.trim() === String(pk || '').trim()) return { ok: true, reason: null };
  return {
    ok: false,
    reason: 'The publishable key pulled from Clerk does not belong to the selected application.',
  };
}
