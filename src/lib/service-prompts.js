// Per-service AI prompts + response parsing. Pure layer (no I/O), used by the
// web UI (--ui), by the `steps/service-keys.js` step in the terminal, and by
// the tests.
//
// The idea: for each service that needs dashboard keys (Stripe, Asaas,
// Resend…), we generate a ready-made prompt for the student to paste into a
// browser automation AI extension (e.g. Claude in Chrome). The agent navigates
// the dashboard, creates/copies the keys and returns a `KEY=value` block —
// which the user pastes back (in the UI or terminal) and `parseKeysBlock`
// recognizes.

import { SERVICES } from '../config.js';

/**
 * Services relevant to an installation.
 * @param {{addons?: string[], storage?: string}} sel The user's selection.
 * @returns {Array} subset of SERVICES, in catalog order.
 */
export function relevantServices(sel = {}) {
  const addons = sel.addons ?? [];
  return SERVICES.filter(
    (s) =>
      s.when.always ||
      (s.when.addon && addons.includes(s.when.addon)) ||
      (s.when.storage && sel.storage === s.when.storage),
  );
}

/** Envs the AI prompt must bring back from the dashboard (in catalog order). */
export function dashboardEnvs(service) {
  return service.envs.filter((e) => e.source === 'dashboard');
}

/**
 * Builds a service's AI prompt, ready to copy.
 * @param {object} service A SERVICES entry.
 * @param {string} [projectName] Replaces {{PROJECT}} in the steps.
 * @returns {string|null} null when the service has no dashboard keys.
 */
export function buildServicePrompt(service, projectName = 'my-app') {
  const wanted = dashboardEnvs(service);
  if (!service.prompt || wanted.length === 0) return null;

  const fill = (text) => text.replaceAll('{{PROJECT}}', projectName);
  const lines = [
    'You are an AI agent controlling my browser (automation extension).',
    `Mission: obtain the ${service.label} credentials for the project "${projectName}", in the development environment.`,
    '',
    'Steps:',
    `1. Open ${service.prompt.url} — if I am not logged in, STOP, ask me to log in and only then continue.`,
    ...service.prompt.steps.map((s, i) => `${i + 2}. ${fill(s)}`),
    '',
    'Rules:',
    ...(service.prompt.rules || []).map((r) => `- ${fill(r)}`),
    '- Do not change anything beyond what is described and do not expose the keys anywhere else.',
    '- If a screen differs from the description, look for the equivalent option before giving up.',
    '',
    'When you finish, return ONLY this block, with the values filled in',
    '(one line per key, no comments, no surrounding markdown):',
    '',
    ...wanted.map((e) => `${e.key}=<${e.patternHint || 'value'}>`),
  ];
  return lines.join('\n');
}

/**
 * Recognizes a `KEY=value` block pasted by the user (the agent's answer).
 * Accepts `KEY=value` and `KEY: value`, ignores comments/code fences, strips
 * quotes/backticks and placeholders (`<…>`), and only returns keys from the
 * allowlist (by default, every known key in the catalog).
 * @param {string} text
 * @param {string[]} [allowed]
 * @returns {Object<string,string>}
 */
export function parseKeysBlock(text, allowed) {
  const allowSet = new Set(allowed ?? SERVICES.flatMap((s) => s.envs.map((e) => e.key)));
  const found = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*•]\s*/, '');
    if (!line || line.startsWith('#') || line.startsWith('```')) continue;
    const m = /^([A-Z][A-Z0-9_]*)\s*[=:]\s*(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    if (!allowSet.has(key)) continue;
    const value = m[2].trim().replace(/^[`'"]+|[`'",]+$/g, '').trim();
    if (!value || /^<.*>$/.test(value)) continue; // unfilled placeholder
    found[key] = value;
  }
  return found;
}

/**
 * Validates a value against the spec's `pattern` (when there is one).
 * @returns {true|string} true when ok; otherwise the expected-format hint.
 */
export function validateEnvValue(spec, value) {
  if (!spec.pattern) return true;
  const ok = new RegExp(spec.pattern).test(String(value).trim());
  return ok ? true : `expected format: ${spec.patternHint || spec.pattern}`;
}
