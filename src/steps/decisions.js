// DECISIONS phase of the terminal wizard (full mode).
//
// The professional scaffolder pattern (create-next-app, create-astro…):
// ALL the questions come first — template, stack, shadcn, dependencies,
// storage, webhook, GitHub and deploy — then a summary to review and a
// single confirmation. From there execution runs end to end with no further
// decision question (logins and keys for chosen services may still
// interact — the summary says so, no surprises).
//
// Flags still rule: whatever they decide is not asked
// (lib/decisions.js resolves with the SAME precedence as always). With --yes
// nothing is asked and the summary is shown as information.

import { ADDON_GROUPS, ADDON_PRESETS, ALL_ADDON_IDS, SHADCN } from '../config.js';
import { resolveAddonFlags } from '../lib/addons.js';
import { resolveDecisions } from '../lib/decisions.js';
import { stepEnabled } from '../lib/pipeline.js';
import { relToCwd } from './project.js';
import { selectTemplate } from './template.js';
import * as ui from '../lib/ui.js';

export async function collectDecisions(ctx) {
  const { flags = {} } = ctx;
  const base = resolveDecisions(flags);
  let previous = null;

  for (;;) {
    await selectTemplate(ctx);
    await pickStack(ctx, previous);

    const d = { ...base };

    // Capabilities the template does not declare never become a question.
    if (!stepEnabled('shadcn', ctx.template)) {
      d.shadcnPreset = null;
      d.shadcnBlocks = null;
    }
    if (!stepEnabled('storage', ctx.template)) d.storage = 'convex';
    if (!stepEnabled('clerk', ctx.template)) d.webhook = false;

    if (d.shadcnPreset === undefined || d.shadcnBlocks === undefined) {
      await askShadcn(d, previous);
    }
    if (d.updateDeps === undefined) d.updateDeps = await askDeps(previous);
    if (d.storage === undefined) d.storage = await askStorage(previous);
    if (d.webhook === undefined) d.webhook = await askWebhook(previous);
    if (d.push === undefined) d.push = await askPush(previous);
    if (d.push) {
      if (d.repoName === undefined && !flags.yes) d.repoName = await askRepoName(ctx.slug, previous);
      if (d.visibility === undefined) d.visibility = await askVisibility(previous);
    }
    if (d.deploy === undefined) d.deploy = await askDeploy(previous);
    if (d.fia === undefined) d.fia = await askFia(previous);
    if (d.impeccable === undefined) d.impeccable = await askImpeccable(previous);

    // Defensive defaults (cover --yes and TTY-less runs).
    if (d.updateDeps === undefined) d.updateDeps = 'none';
    if (d.push && d.repoName == null) d.repoName = ctx.slug;
    if (d.push && d.visibility == null) d.visibility = 'private';

    ctx.decisions = d;
    showSummary(ctx);

    if (flags.yes) return;
    const next = await ui.select({
      message: 'Confirm and start the install?',
      initialValue: 'go',
      options: [
        { value: 'go', label: 'Yes — start now', hint: 'runs everything based on the summary above' },
        { value: 'adjust', label: 'Adjust the choices…', hint: 'answer the questions again' },
        { value: 'cancel', label: 'Cancel' },
      ],
    });
    if (next === 'go') return;
    if (next === 'cancel') ui.bail();
    previous = { ...d, addons: ctx.addons, addonsPreset: ctx.addonsPreset ?? null };
  }
}

// ── Stack (addons) ───────────────────────────────────────────────────────────
// The catalog here is the CLI's built-in one; after the download, reconcileAddons
// (steps/addons.js) checks the selection against the downloaded template.addons.json.

async function pickStack(ctx, previous) {
  const { flags = {} } = ctx;
  const catalog = { groups: ADDON_GROUPS, presets: ADDON_PRESETS, allIds: ALL_ADDON_IDS };
  ctx.addonCatalog = catalog;

  const { chosen, errors } = resolveAddonFlags(flags, catalog);
  for (const err of errors) ui.warn(err);

  const anyGroupFlag = catalog.groups.some((g) => flags[g.flag] != null);
  if (flags.yes || flags.preset || anyGroupFlag) {
    ctx.addons = chosen;
    ctx.addonsSource = 'flags';
    ui.info(`Stack: ${chosen.length ? chosen.join(', ') : 'just the template base'}`);
    return;
  }

  if (!previous) {
    ui.note(
      [
        'The template ships with EVERYTHING implemented (tests, Sentry, analytics, billing…).',
        'Pick what this project will use — whatever you do not pick is REMOVED',
        'from the generated code (files, dependencies and marked sections).',
        '',
        'In "Customize…" you see every option, group by group (Sentry,',
        'PostHog, Stripe…). Everything can be turned back on later — the',
        'instructions live in the project README.',
      ].join('\n'),
      'Build your stack',
    );
  }

  const PRESET_META = {
    padrao: { label: 'Default (recommended)', hint: 'quality + Sentry + security' },
    minimo: { label: 'Minimal', hint: 'just the template base' },
    saas: { label: 'SaaS', hint: 'default + PostHog, Resend and Stripe' },
  };
  const presetOptions = Object.keys(catalog.presets).map((value) => ({
    value,
    label: PRESET_META[value]?.label ?? value,
    hint: PRESET_META[value]?.hint ?? '',
  }));
  const preset = await ui.select({
    message: 'Start from which preset?',
    initialValue: previous?.addonsPreset ?? (catalog.presets.padrao ? 'padrao' : presetOptions[0]?.value),
    options: [
      ...presetOptions,
      { value: 'custom', label: 'Customize…', hint: 'choose option by option, group by group' },
    ],
  });

  ctx.addonsSource = 'interactive';
  if (preset !== 'custom') {
    ctx.addons = catalog.presets[preset] ?? [];
    ctx.addonsPreset = preset;
    ui.success(`Preset "${preset}": ${ctx.addons.length ? ctx.addons.join(', ') : 'no addons'}`);
    return;
  }

  const previousSet = previous?.addons ? new Set(previous.addons) : null;
  const picked = [];
  for (const group of catalog.groups) {
    const recommended = group.options.find((o) => o.recommended)?.value ?? group.options[0].value;
    if (group.single) {
      const value = await ui.select({
        message: group.title,
        initialValue: previousSet
          ? (group.options.find((o) => previousSet.has(o.value))?.value ?? 'none')
          : recommended,
        options: group.options.map((o) => ({ value: o.value, label: o.label, hint: o.hint })),
      });
      if (value !== 'none') picked.push(value);
    } else {
      const values = await ui.multiselect({
        message: `${group.title} (space toggles, enter confirms)`,
        options: group.options.map((o) => ({ value: o.value, label: o.label, hint: o.hint })),
        initialValues: previousSet
          ? group.options.filter((o) => previousSet.has(o.value)).map((o) => o.value)
          : group.options.filter((o) => o.recommended).map((o) => o.value),
        required: false,
      });
      picked.push(...values);
    }
  }
  ctx.addons = picked;
  ctx.addonsPreset = null;
  ui.success(`Chosen stack: ${picked.length ? picked.join(', ') : 'just the template base'}`);
}

// ── Individual questions ─────────────────────────────────────────────────────

async function askShadcn(d, previous) {
  ui.note(
    [
      'The template already ships with shadcn/ui configured and working.',
      'Here you can (optionally) customize:',
      '',
      `1. Apply a custom visual PRESET — create yours at ${SHADCN.createUrl}`,
      '   (style, colors, font, icons, radius) and paste the "Get Code" command.',
      `2. Install a ready-made BLOCK (default: ${SHADCN.defaultBlock}) — catalog at`,
      `   ${SHADCN.blocksUrl}`,
    ].join('\n'),
    'shadcn/ui — customization (optional)',
  );

  if (d.shadcnPreset === undefined) {
    const wantsPreset = await ui.confirm({
      message: 'Apply a custom preset from shadcn/create?',
      initialValue: !!previous?.shadcnPreset,
    });
    d.shadcnPreset = wantsPreset
      ? String(
          await ui.text({
            message: 'Paste the "Get Code" command (or just the preset code):',
            placeholder: 'npx shadcn@latest init --preset b0   —   or just: b0',
            defaultValue: previous?.shadcnPreset ?? undefined,
            validate: (v) => (v && v.trim() ? undefined : 'Paste the command or the preset code.'),
          }),
        ).trim()
      : null;
  }

  if (d.shadcnBlocks === undefined) {
    const options = [
      ...SHADCN.blocks.map((b) => ({
        value: b.name,
        label: b.name === SHADCN.defaultBlock ? `${b.name} (default)` : b.name,
        hint: b.description,
      })),
      { value: '__custom__', label: 'Another block…', hint: `type the name — catalog: ${SHADCN.blocksUrl}` },
      { value: '__skip__', label: 'Do not install any block' },
    ];
    const choice = await ui.select({
      message: 'Which shadcn/ui block to install?',
      options,
      initialValue: previous?.shadcnBlocks?.[0] ?? (previous && previous.shadcnBlocks === null ? '__skip__' : SHADCN.defaultBlock),
    });
    if (choice === '__skip__') d.shadcnBlocks = null;
    else if (choice === '__custom__') {
      const answer = String(
        await ui.text({
          message: 'Block name(s) — separate multiple with spaces:',
          placeholder: 'dashboard-01 login-03',
          validate: (v) => (v && v.trim() ? undefined : 'Enter at least one block.'),
        }),
      ).trim();
      d.shadcnBlocks = answer.split(/[\s,]+/).filter(Boolean);
    } else d.shadcnBlocks = [choice];
  }
}

async function askDeps(previous) {
  return await ui.select({
    message: 'Dependencies — how to handle versions?',
    initialValue: previous?.updateDeps ?? 'none',
    options: [
      { value: 'none', label: 'Keep the template versions', hint: 'recommended — tested and compatible' },
      { value: 'safe', label: 'Safe update (npm update)', hint: 'patch/minor only' },
    ],
  });
}

// Same recommendation as the stack catalog (src/stack-catalog.js, blob →
// defaultId 'r2'): the two texts must never contradict each other.
async function askStorage(previous) {
  return await ui.select({
    message: 'Documents — where to store uploaded files?',
    initialValue: previous?.storage ?? 'r2',
    options: [
      { value: 'r2', label: 'Cloudflare R2', hint: 'recommended — cheap, no egress cost; guided setup during the install (wrangler)' },
      { value: 'convex', label: 'Convex native storage', hint: 'zero configuration — files inside Convex itself' },
    ],
  });
}

async function askWebhook(previous) {
  return await ui.confirm({
    message: 'Sync Clerk users → Convex via webhook? (requires a dashboard action during the install)',
    initialValue: previous?.webhook ?? false,
  });
}

async function askPush(previous) {
  return await ui.confirm({
    message: 'Create a GitHub repository and push at the end?',
    initialValue: previous?.push ?? true,
  });
}

async function askRepoName(slug, previous) {
  return String(
    await ui.text({
      message: 'GitHub repository name:',
      placeholder: slug,
      defaultValue: previous?.repoName ?? slug,
      validate: (v) => (v && v.trim() ? undefined : 'Enter a name.'),
    }),
  ).trim();
}

async function askVisibility(previous) {
  return await ui.select({
    message: 'Repository visibility:',
    initialValue: previous?.visibility ?? 'private',
    options: [
      { value: 'private', label: 'Private', hint: 'recommended — only you (and whoever you invite)' },
      { value: 'public', label: 'Public', hint: 'anyone can see the code' },
    ],
  });
}

async function askDeploy(previous) {
  return await ui.confirm({
    message: 'Deploy a Vercel Preview at the end? (https://…vercel.app URL using the DEV backend)',
    initialValue: previous?.deploy ?? false,
  });
}

async function askFia(previous) {
  return await ui.confirm({
    message:
      'Install FIA — the IAI Agent Factory? Interactive Pi + deterministic FDAs; Claude via the plan CLI + Codex via Pi.',
    initialValue: previous?.fia ?? true,
  });
}

async function askImpeccable(previous) {
  return await ui.confirm({
    message:
      'Install the Impeccable design skill (impeccable.style)? Free/open-source; /impeccable commands (craft, audit, polish…) for professional-looking screens and landing pages.',
    initialValue: previous?.impeccable ?? true,
  });
}

// ── Summary ──────────────────────────────────────────────────────────────────

const DEPS_LABEL = {
  none: 'keep the template versions (tested)',
  safe: 'safe update (patch/minor)',
};

function shadcnSummary(d) {
  const parts = [];
  if (d.shadcnPreset) parts.push(`preset "${d.shadcnPreset}"`);
  if (d.shadcnBlocks?.length) parts.push(`block ${d.shadcnBlocks.join(', ')}`);
  return parts.length ? parts.join(' + ') : 'template default (no customization)';
}

function showSummary(ctx) {
  const d = ctx.decisions;
  const lines = [
    `Folder         ${relToCwd(ctx.dir)}  (project "${ctx.name}")`,
    `Template       ${ctx.template?.label ?? '—'}`,
    `Stack          ${ctx.addons?.length ? ctx.addons.join(', ') : 'just the template base'}`,
    `shadcn/ui      ${shadcnSummary(d)}`,
    `Dependencies   ${DEPS_LABEL[d.updateDeps] ?? d.updateDeps}`,
    `Files          ${d.storage === 'r2' ? 'Cloudflare R2 (recommended — guided setup during the install)' : 'Convex Storage (zero configuration)'}`,
    `Clerk webhook  ${d.webhook ? 'yes — will ask for a dashboard action' : 'no (can be turned on later)'}`,
    `GitHub         ${d.push ? `publish as "${d.repoName}" (${d.visibility === 'public' ? 'public' : 'private'})` : 'not publishing now'}`,
    `Vercel Preview ${d.deploy ? 'yes — public Preview URL at the end' : 'no'}`,
    `FIA            ${d.fia ? 'yes — Pi + FDAs + fia skill' : 'no'}`,
    `Impeccable     ${d.impeccable ? 'yes — /impeccable design skill' : 'no'}`,
  ];
  if (ctx.keysFilePath) {
    lines.push(`Keys           ${Object.keys(ctx.providedKeys ?? {}).length} from file ${ctx.keysFilePath}`);
  }
  lines.push(
    '',
    'From here on I run everything in sequence. Logins (Convex, Clerk…) and',
    'keys for chosen services may still need your attention along the way.',
  );
  ui.note(lines.join('\n'), 'Summary — review before starting');
}
