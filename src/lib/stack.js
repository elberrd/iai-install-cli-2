// PURE stack resolution (no I/O — testable): compatibility rules, --stack
// flag parsing, and rendering of the ai-docs/stack.md manifest + the stack
// block of AGENTS.md.
//
// The manifest is the SOURCE OF TRUTH for the generated project's stack: the
// installer creates it, the agent commands (/stack, /idea, /absorb) complete
// it, and planning (/map, /start) and launch (/launch) read from it.

import {
  RECOMMENDED_STACK,
  STACK_CATEGORIES,
  STACK_LATER,
  STACK_OPTIONS,
  stackOption,
} from '../stack-catalog.js';

// Markers of the stack block in AGENTS.md (same pattern as the harness block).
export const STACK_MARKERS = {
  start: '<!-- stack-start -->',
  end: '<!-- stack-end -->',
};

export const STACK_MANIFEST_PATH = 'ai-docs/stack.md';

/**
 * Applies the compatibility rules to a set of partial choices.
 * Rules (the same ones the wizard and the agent commands follow):
 *   - Convex backend  ⇒ database = Convex and ORM = none (all built in);
 *   - backend "later" ⇒ database and ORM stay "later" (they depend on it);
 *   - option with `onlyWhen` out of context ⇒ error (e.g. Supabase Storage
 *     without the Supabase database).
 *
 * @param {object} partial - { category: optionId } (missing ones become `later`).
 * @returns {{choices: object, pending: string[], errors: string[]}}
 */
export function applyStackRules(partial = {}) {
  const choices = {};
  const errors = [];

  for (const cat of STACK_CATEGORIES) {
    // Categories are processed in catalog order (backend before database/ORM)
    // — forcedBy sees what was ALREADY validated, not the raw input: an
    // invalid backend became `later` and drags database/ORM along with it.
    const forced = cat.forcedBy?.({ ...withDefaults(partial), ...choices });
    const explicit = partial[cat.id];
    let value = forced ?? explicit ?? STACK_LATER;
    // An explicit choice overridden by a rule NEVER disappears silently.
    if (forced != null && explicit != null && explicit !== forced) {
      errors.push(
        forced === STACK_LATER
          ? `${cat.label}: "${explicit}" depends on the backend — since the backend stayed "${STACK_LATER}", this layer also stayed pending.`
          : `${cat.label}: "${explicit}" ignored — the chosen backend already defines this layer (${forced === 'none' ? 'not applicable' : forced}).`,
      );
    }
    if (value !== STACK_LATER && !stackOption(cat.id, value)) {
      errors.push(`${cat.label}: unknown option "${value}" (accepted: ${optionIds(cat.id).join(' | ')} | ${STACK_LATER})`);
      value = STACK_LATER;
    }
    choices[cat.id] = value;
  }

  // `onlyWhen` depends on the full set — validate after assembling everything.
  for (const cat of STACK_CATEGORIES) {
    const opt = stackOption(cat.id, choices[cat.id]);
    if (opt?.onlyWhen && !opt.onlyWhen(choices)) {
      errors.push(`${cat.label}: "${opt.label}" does not fit the other choices — it stayed pending.`);
      choices[cat.id] = STACK_LATER;
    }
  }

  const pending = STACK_CATEGORIES.filter((c) => choices[c.id] === STACK_LATER).map((c) => c.id);
  return { choices, pending, errors };
}

function withDefaults(partial) {
  const out = {};
  for (const cat of STACK_CATEGORIES) out[cat.id] = partial[cat.id] ?? STACK_LATER;
  return out;
}

function optionIds(categoryId) {
  return (STACK_OPTIONS[categoryId] ?? []).map((o) => o.id);
}

// ── --stack flag ─────────────────────────────────────────────────────────────
// Three forms:
//   --stack recomendada            → ready-made template (current path)
//   --stack depois                 → harness only; everything pending (decide in Pi)
//   --stack backend=hono,db=neon   → direct choices (the rest stays pending)
const CATEGORY_ALIASES = {
  db: 'database',
  banco: 'database',
  arquivos: 'blob',
  storage: 'blob',
  autenticacao: 'auth',
  jobs: 'automations',
  automacoes: 'automations',
};

/**
 * @param {string|undefined} value - raw value of the --stack flag.
 * @returns {{path: 'template'|'discover'|'custom'|undefined, choices: object, errors: string[]}}
 */
export function parseStackFlag(value) {
  if (value == null) return { path: undefined, choices: {}, errors: [] };
  const v = String(value).trim().toLowerCase();
  if (v === 'recomendada') return { path: 'template', choices: {}, errors: [] };
  if (v === 'depois') return { path: 'discover', choices: {}, errors: [] };
  if (v === 'propria' || v === 'custom') return { path: 'custom', choices: {}, errors: [] };

  const usage = `accepted: recomendada | propria | depois | category=option pairs (categories: ${STACK_CATEGORIES.map((c) => c.id).join(', ')})`;
  // No "=" means it is not a pair list — it is a shortcut with a typo (e.g.
  // "recomendado"). Returning an undefined path makes the caller ABORT
  // instead of silently switching the install type (mode.js).
  if (!v || !v.includes('=')) {
    return { path: undefined, choices: {}, errors: [`--stack: unknown value "${value}" — ${usage}.`] };
  }

  const choices = {};
  const errors = [];
  for (const pair of v.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [rawKey, rawVal] = pair.split('=').map((s) => s?.trim());
    const key = CATEGORY_ALIASES[rawKey] ?? rawKey;
    if (!rawVal || !STACK_CATEGORIES.some((c) => c.id === key)) {
      errors.push(`--stack: invalid pair "${pair}" — ${usage}.`);
      continue;
    }
    choices[key] = rawVal;
  }
  // No usable pair ⇒ same treatment as the typo: abort in the caller.
  if (Object.keys(choices).length === 0) return { path: undefined, choices: {}, errors };
  return { path: 'custom', choices, errors };
}

// ── Bridges to template mode ─────────────────────────────────────────────────

/** The (complete) stack the live1/live2 template delivers, given the decisions. */
export function stackFromDecisions(decisions = {}) {
  return {
    ...RECOMMENDED_STACK,
    blob: decisions.storage === 'r2' ? 'r2' : 'convex-storage',
  };
}

/**
 * Do the choices match the ready-made template's stack? (Then it is worth
 * suggesting the template instead of building from scratch.) `blob` accepts
 * R2 OR Convex Storage — the template ships both paths.
 */
export function matchesTemplateStack(choices = {}) {
  return (
    choices.frontend === 'nextjs' &&
    choices.backend === 'convex' &&
    choices.auth === 'clerk' &&
    (choices.blob === 'r2' || choices.blob === 'convex-storage') &&
    choices.deploy === 'vercel'
  );
}

// ── Manifest rendering (ai-docs/stack.md) ────────────────────────────────────

const SOURCE_LABEL = {
  template: 'ready-made template (IAI recommended stack)',
  custom: 'stack assembled in the installer',
  discover: 'to be decided — talk to Pi (/idea extracts PRD + stack)',
  brownfield: 'existing project — run /absorb so the system maps the real stack',
};

/**
 * Generates the content of ai-docs/stack.md.
 * @param {{
 *   choices: object, pending: string[],
 *   source: 'template'|'custom'|'discover'|'brownfield',
 *   projectName?: string,
 *   provision?: { neon?: { claimUrl: string, expiresAt?: string } },
 * }} info
 */
export function renderStackMd(info) {
  const { choices, pending, source, projectName, provision } = info;
  const decided = STACK_CATEGORIES.length - pending.length;
  const lines = [];

  lines.push('# Project stack');
  lines.push('');
  lines.push('> SOURCE OF TRUTH for this project\'s stack. Agents read this file before');
  lines.push('> planning (/map, /start), implementing and launching (/launch). Who updates it:');
  lines.push('> the installer (creation), the /stack command (deciding pending layers +');
  lines.push('> generating docs in `ai-docs/apis/`) and /absorb (existing projects). Do not');
  lines.push('> invent a layer: anything marked "decide later" STOPS and is decided with the engineer.');
  lines.push('');
  lines.push(`- Project: ${projectName ?? '(unnamed)'}`);
  lines.push(`- Source: ${SOURCE_LABEL[source] ?? source}`);
  lines.push(`- Layers decided: ${decided} of ${STACK_CATEGORIES.length}`);
  lines.push('');

  // Summary
  lines.push('## Summary');
  lines.push('');
  lines.push('| Layer | Choice | Local docs |');
  lines.push('|---|---|---|');
  for (const cat of STACK_CATEGORIES) {
    const value = choices[cat.id];
    const opt = stackOption(cat.id, value);
    const name = value === STACK_LATER ? '◌ decide later' : (opt?.label ?? value);
    const doc =
      value === STACK_LATER || value === 'none'
        ? '—'
        : `\`ai-docs/apis/${value}.md\` (generate with /stack)`;
    lines.push(`| ${cat.label} | ${name} | ${doc} |`);
  }
  lines.push('');

  // Pending layers
  if (pending.length) {
    lines.push('## Pending — decide before implementing');
    lines.push('');
    for (const id of pending) {
      const cat = STACK_CATEGORIES.find((c) => c.id === id);
      lines.push(`- [ ] ${cat.label}`);
    }
    lines.push('');
    lines.push('How to decide: run `/stack` (Claude Code/Cursor) or talk to Pi —');
    lines.push('`/idea` extracts the PRD and the stack together; `/stack` decides one layer at a time.');
    lines.push('Rules the commands follow:');
    lines.push('- IAI preference: Next.js + Convex + Clerk + Cloudflare R2 + Vercel.');
    lines.push('- Convex backend ⇒ there is NO API layer and no ORM (Convex is database + backend).');
    lines.push('- Non-Convex backend ⇒ own API layer (Hono) + SQL database (Neon or');
    lines.push('  Supabase) + ORM (Drizzle recommended; Prisma as the alternative).');
    lines.push('- Automations/jobs outside the app are OPTIONAL — "none" is a valid answer');
    lines.push('  (in-app scheduling fits Convex scheduled functions / Vercel crons). An');
    lines.push('  external service (Modal) is a SECOND deploy target: it needs its own doc');
    lines.push('  with a Production runbook that /launch executes.');
    lines.push('- Deployment: Vercel is the only supported path today.');
    lines.push('');
  }

  // Decided layers (detail)
  const detailed = STACK_CATEGORIES.filter(
    (c) => choices[c.id] !== STACK_LATER && choices[c.id] !== 'none',
  );
  if (detailed.length) {
    lines.push('## Layers');
    lines.push('');
    for (const cat of detailed) {
      const opt = stackOption(cat.id, choices[cat.id]);
      if (!opt) continue;
      lines.push(`### ${cat.label} — ${opt.label}`);
      lines.push('');
      lines.push(`- Role: ${opt.role}`);
      if (opt.docs?.length) lines.push(`- Official docs: ${opt.docs.join(' · ')}`);
      if (opt.llms) lines.push(`- llms.txt: ${opt.llms}`);
      const tooling = [];
      if (opt.cli) tooling.push(`CLI \`${opt.cli.bin}\``);
      if (opt.mcp) tooling.push(`MCP \`${opt.mcp.name}\``);
      if (opt.mcpNote) tooling.push(opt.mcpNote);
      if (opt.skills) tooling.push(`skills \`${opt.skills.source}\``);
      if (tooling.length) lines.push(`- Tools: ${tooling.join(' · ')}`);
      if (opt.notes) lines.push(`- Notes: ${opt.notes}`);
      if (opt.testUsers) lines.push(`- Test users: ${opt.testUsers}`);
      if (cat.id === 'database' && choices.database === 'neon' && provision?.neon) {
        if (provision.neon.claimUrl) {
          lines.push(`- DEV database already provisioned (Neon Launchpad, no account): \`DATABASE_URL\` in \`.env.local\`.`);
          lines.push(`  **Claim the database** (or it expires in ~72h): ${provision.neon.claimUrl}`);
        } else {
          lines.push(
            `- DEV database already provisioned in YOUR Neon account${provision.neon.projectId ? ` (project \`${provision.neon.projectId}\`)` : ''}: \`DATABASE_URL\` in \`.env.local\`.`,
          );
        }
      }
      lines.push(`- Local docs: \`ai-docs/apis/${opt.id}.md\` — generate/update with /stack`);
      lines.push('');
    }
  }

  // Dev × production environments
  lines.push('## Environments — development × production');
  lines.push('');
  lines.push('Golden rule: `.env.local` is development ONLY and never goes into git.');
  lines.push('EVERY production env lives on Vercel (`vercel env add <KEY> production`) or');
  lines.push('in the matching service (`npx convex env set … --prod`). /launch guides the');
  lines.push('dev → production promotion layer by layer, in the right order.');
  lines.push('');
  const withEnvs = STACK_CATEGORIES.map((c) => stackOption(c.id, choices[c.id])).filter((o) => o?.envs);
  if (withEnvs.length) {
    lines.push('| Service | Development | Production |');
    lines.push('|---|---|---|');
    for (const opt of withEnvs) {
      const dev = opt.envs.dev.map((e) => `\`${e.key}\` — ${e.note}`).join('<br>');
      const prod = opt.envs.prod.map((e) => `\`${e.key}\` — ${e.note}`).join('<br>');
      lines.push(`| ${opt.label} | ${dev} | ${prod} |`);
    }
    lines.push('');
  }
  if (pending.length) {
    lines.push('(Pending layers join this table once decided — /stack updates it.)');
    lines.push('');
  }

  return lines.join('\n');
}

/** Short stack block for AGENTS.md (between STACK_MARKERS). */
export function renderStackAgentsBlock(info) {
  const { choices, pending } = info;
  const decided = STACK_CATEGORIES.filter(
    (c) => choices[c.id] !== STACK_LATER && choices[c.id] !== 'none',
  )
    .map((c) => stackOption(c.id, choices[c.id])?.label ?? choices[c.id])
    .join(' · ');
  const pendingLabels = pending
    .map((id) => STACK_CATEGORIES.find((c) => c.id === id)?.label ?? id)
    .join(', ');
  return [
    '## This project\'s stack',
    '',
    `The source of truth is \`${STACK_MANIFEST_PATH}\` (choices, pending layers,`,
    'dev × production environments and per-technology docs). Read it before planning or implementing.',
    '',
    decided ? `- Decided: ${decided}` : null,
    pendingLabels ? `- Pending: ${pendingLabels} — do NOT invent: stop and decide with the engineer (/stack command).` : null,
    '- Per-technology docs: `ai-docs/apis/<tech>.md` (generated/updated by /stack).',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Inserts/keeps the stack block in an AGENTS.md (idempotent: marker present
 * ⇒ nothing changes — /stack is what updates the content later).
 * @param {string|null} current - current content (null = file does not exist).
 * @param {string} block - output of renderStackAgentsBlock.
 * @returns {{content: string, action: 'created'|'appended'|'skipped'}}
 */
export function applyAgentsStackBlock(current, block) {
  const wrapped = [STACK_MARKERS.start, '', block.trim(), '', STACK_MARKERS.end].join('\n');
  if (current == null) return { content: wrapped + '\n', action: 'created' };
  if (current.includes(STACK_MARKERS.start)) return { content: current, action: 'skipped' };
  return { content: current.trimEnd() + '\n\n' + wrapped + '\n', action: 'appended' };
}
