// Pure helpers for the capability-driven pipeline (no I/O — testable).
//
// Each `full`-mode step declares a capability; the template declares in
// `requires` (src/config.js → TEMPLATES) which capabilities it uses. A step
// whose capability the template does NOT declare is skipped at runtime (the
// [i/n] counter stays stable — the step shows up as "skipped").
//
// 'core' = installer infrastructure (download, addons, git, summary…) —
// runs for any template.

export const CAPABILITIES = ['convex', 'clerk', 'shadcn', 'storage', 'mcps'];

/**
 * Does the step with this capability run for this template?
 * @param {string|undefined} capability - 'core' (or empty) always runs.
 * @param {{requires?: string[]}|undefined} template - a TEMPLATES entry.
 */
export function stepEnabled(capability, template) {
  if (!capability || capability === 'core') return true;
  return (template?.requires ?? []).includes(capability);
}

/**
 * Validate a `requires` set against the known capabilities.
 * @returns {string[]} unknown capabilities (empty = ok).
 */
export function unknownCapabilities(requires = []) {
  return requires.filter((c) => !CAPABILITIES.includes(c));
}

/**
 * Is the GitHub push DEFINITELY ruled out by flags?
 *
 * Used in harness mode (which has no decisions phase). In full mode the
 * preflight now looks at the DECISION (ctx.decisions.push/deploy) — gh/vercel
 * are only prepared when the user said "yes". GitHub CLI login is only
 * needed when a push can happen: with a student token, both the template
 * and the harness come through the gate (steps/harness.js uses the API
 * whenever `ctx.authToken` exists; `gh` is only a dev fallback without a token).
 *
 * Mirrors the precedence of steps/github.js.
 */
export function pushRuledOut(flags = {}) {
  if (flags.skipGithub) return true;
  if (flags.push === false) return true;
  if (flags.push == null && flags.yes) return true; // creating a remote repo is irreversible
  return false;
}

/**
 * Should the web UI open instead of the terminal wizard?
 *
 * The TERMINAL wizard is the default entry point (`npx impactus` on its
 * own asks everything right there — the standard among professional
 * scaffolders). The web UI is OPT-IN: it only opens with an explicit
 * `--ui`/`--web`. `--terminal` and `--no-ui` remain accepted for
 * compatibility (today they are the default behavior).
 *
 * @param {object} flags - parseArgs output
 */
export function wantsWebUi(flags = {}) {
  return flags.ui === true;
}
