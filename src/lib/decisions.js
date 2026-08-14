// PURE resolution of the install decisions from the flags (no I/O).
//
// The terminal wizard asks EVERYTHING before executing (steps/decisions.js);
// this module resolves what the flags have already decided, with the SAME
// precedence the execution steps have always had. Value convention:
//
//   undefined → nobody decided — the wizard asks;
//   null      → decided as "none/don't use" (don't ask);
//   value     → decided (don't ask).
//
// Under --yes nothing stays undefined: safe defaults take over (deploy and
// push are opt-in; webhook needs the dashboard; deps stay at the tested versions).

import { SHADCN } from '../config.js';

/** @returns {string[]|null|undefined} null = no block; undefined = ask. */
function shadcnBlocksFromFlags(flags, yes) {
  if (flags.skipShadcn) return null;
  if (flags.shadcnBlock) {
    const v = String(flags.shadcnBlock).trim();
    if (v.toLowerCase() === 'none') return null;
    const blocks = v.split(/[\s,]+/).filter(Boolean);
    return blocks.length ? blocks : null;
  }
  return yes ? [SHADCN.defaultBlock] : undefined;
}

/**
 * Resolve the install decisions (full mode) from the flags.
 * @param {object} flags - parseArgs output.
 * @returns {{
 *   updateDeps: 'none'|'safe'|undefined,
 *   shadcnPreset: string|null|undefined,
 *   shadcnBlocks: string[]|null|undefined,
 *   storage: 'convex'|'r2'|undefined,
 *   webhook: boolean|undefined,
 *   push: boolean|undefined,
 *   repoName: string|undefined,
 *   visibility: 'private'|'public'|undefined,
 *   deploy: boolean|undefined,
 * }}
 */
export function resolveDecisions(flags = {}) {
  const yes = !!flags.yes;
  return {
    updateDeps: flags.updateDeps ?? (yes ? 'none' : undefined),
    shadcnPreset: flags.skipShadcn ? null : (flags.shadcnPreset ?? (yes ? null : undefined)),
    shadcnBlocks: shadcnBlocksFromFlags(flags, yes),
    storage: flags.skipStorage ? 'convex' : (flags.storage ?? (yes ? 'convex' : undefined)),
    // Webhook requires manual action in the Clerk dashboard — automation never turns it on.
    webhook: flags.skipWebhook || yes ? false : undefined,
    // Creating a remote repo is irreversible — opt-in in automatic mode.
    push: flags.skipGithub ? false : (flags.push ?? (yes ? false : undefined)),
    repoName: flags.repo ?? undefined,
    visibility: flags.public ? 'public' : flags.private || yes ? 'private' : undefined,
    deploy: flags.skipDeploy ? false : (flags.deploy ?? (yes ? false : undefined)),
    fia:
      flags.skipFia || flags.fia === false
        ? false
        : flags.fia === true
          ? true
          : yes
            ? true
            : undefined,
    // Impeccable is local and reversible (only skill files in the project) —
    // on by default under --yes; the step still checks the minimum Node.
    impeccable:
      flags.skipImpeccable || flags.impeccable === false
        ? false
        : flags.impeccable === true
          ? true
          : yes
            ? true
            : undefined,
  };
}
