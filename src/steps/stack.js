// "Your stack" phase of the prelude: turns the path chosen in mode.js
// (`ctx.stackPath`) into a set of choices with pending items (`ctx.stack`).
//
// Only the 'custom' path asks questions; the other three resolve silently:
//   template   → the stack comes ready from the template (manifest generated
//                later, in steps/stack-docs.js, already with the storage decision);
//   discover   → everything pending — the person decides by talking to Pi;
//   brownfield → everything pending — /absorb maps the project's real stack.
//
// Golden rule of the wizard (same as the agent commands): Convex is database +
// backend in one — choosing Convex removes the database and ORM questions;
// choosing your own API (Hono) opens both. Every category accepts
// "Decide later (talking to Pi)".

import {
  STACK_CATEGORIES,
  STACK_LATER,
  STACK_OPTIONS,
  stackOption,
} from '../stack-catalog.js';
import { applyStackRules, matchesTemplateStack } from '../lib/stack.js';
import * as ui from '../lib/ui.js';

export async function collectStack(ctx) {
  const { flags = {} } = ctx;

  if (ctx.stackPath === 'template') {
    ctx.stack = null; // resolved by the template + decisions (steps/stack-docs.js)
    ui.info('Stack: IAI recommended (Next.js + Convex + Clerk + R2) — comes ready in the template.');
    return;
  }
  if (ctx.stackPath === 'brownfield') {
    ctx.stack = { ...applyStackRules({}), source: 'brownfield' };
    ui.info('Existing project: /absorb will map the real stack and fill in ai-docs/stack.md.');
    return;
  }
  if (ctx.stackPath === 'discover') {
    ctx.stack = { ...applyStackRules({}), source: 'discover' };
    ui.info('Stack: to be decided with Pi — the ai-docs/stack.md manifest starts with everything pending.');
    return;
  }

  // ── 'custom' path ──────────────────────────────────────────────────────────
  // Flags with an INVALID option do not lock the category: they are dropped
  // with a warning and the question comes back (only recognized values skip it).
  let flagChoices = {};
  for (const [key, value] of Object.entries(ctx.stackFlagChoices ?? {})) {
    if (value === STACK_LATER || stackOption(key, value)) flagChoices[key] = value;
    else ui.warn(`--stack: "${key}=${value}" is not a valid option — that layer will be asked again.`);
  }

  // No TTY/automatic decision: whatever the flags decided stands; the rest
  // stays pending (safe — you can decide later with Pi, nothing is removed).
  if (flags.yes) {
    const result = applyStackRules(flagChoices);
    for (const err of result.errors) ui.warn(err);
    ctx.stack = { ...result, source: 'custom' };
    ui.info(`Stack: ${summaryLine(result)}`);
    return;
  }

  ui.note(
    [
      'Choose each layer — or leave it as "decide later" and settle it by',
      'talking to Pi (/idea recommends the stack from what you want to build).',
      '',
      'The most important rule: with the CONVEX backend there is no API layer',
      'and no ORM — it is already database + backend + realtime, and the',
      'frontend connects directly. Without Convex, you get your own API (Hono)',
      '+ SQL database (Neon/Supabase) + ORM (Drizzle/Prisma) — the system',
      'guides you either way.',
    ].join('\n'),
    'Build your stack',
  );

  let previous = null;
  for (;;) {
    const chosen = {};
    for (const cat of STACK_CATEGORIES) {
      // Flags win: a category decided via --stack is not asked.
      if (flagChoices[cat.id] != null) {
        chosen[cat.id] = flagChoices[cat.id];
        continue;
      }
      const soFar = fill(chosen);
      const forced = cat.forcedBy?.(soFar);
      if (forced) {
        chosen[cat.id] = forced;
        continue;
      }
      if (cat.askWhen && !cat.askWhen(soFar)) {
        chosen[cat.id] = STACK_LATER;
        continue;
      }
      const available = (STACK_OPTIONS[cat.id] ?? []).filter(
        (o) => !o.onlyWhen || o.onlyWhen(soFar),
      );
      const options = [
        ...available.map((o) => ({ value: o.id, label: o.label, hint: o.hint })),
        {
          value: STACK_LATER,
          label: 'Decide later',
          hint: 'stays pending in the manifest — Pi (/idea or /stack) decides with you',
        },
      ];
      const prev = previous?.choices?.[cat.id];
      chosen[cat.id] = await ui.select({
        message: cat.question,
        initialValue: prev != null && options.some((o) => o.value === prev) ? prev : cat.defaultId,
        options,
      });
    }

    const result = applyStackRules(chosen);
    for (const err of result.errors) ui.warn(err);

    // Chose exactly the recommended stack? The template delivers it all ready.
    if (!ctx.existingProject && !result.pending.length && matchesTemplateStack(result.choices)) {
      const useTemplate = await ui.confirm({
        message:
          'These choices are exactly the recommended stack — the ready-made template delivers everything assembled and tested (much faster than building from scratch). Use the template?',
        initialValue: true,
      });
      if (useTemplate) {
        ctx.mode = 'full';
        ctx.stackPath = 'template';
        ctx.stack = null;
        // The file-storage choice was already made here — it becomes the
        // storage decision of the template flow (flags win ⇒ no repeat question).
        if (flags.storage == null && !flags.skipStorage) {
          flags.storage = result.choices.blob === 'r2' ? 'r2' : 'convex';
        }
        // The automations layer lives OUTSIDE the app — the template does not
        // cover it, so anything other than "none" (Modal, or an honest
        // "decide later") survives the switch and lands in the manifest.
        if (result.choices.automations !== 'none') {
          ctx.templateStackOverrides = { automations: result.choices.automations };
        }
        ui.success('Switched to the ready-made template — the next questions assemble the rest of the install.');
        return;
      }
    }

    showStackSummary(result);
    const next = await ui.select({
      message: 'Confirm this stack?',
      initialValue: 'go',
      options: [
        { value: 'go', label: 'Yes — go with it', hint: 'the ai-docs/stack.md manifest is born from these choices' },
        { value: 'adjust', label: 'Adjust the choices…', hint: 'answer the questions again' },
        { value: 'cancel', label: 'Cancel' },
      ],
    });
    if (next === 'go') {
      ctx.stack = { ...result, source: 'custom' };
      return;
    }
    if (next === 'cancel') ui.bail();
    // "Adjust" reopens ALL layers — including the ones set by flag (the
    // current answers become each question's initial value).
    flagChoices = {};
    previous = result;
  }
}

/** Fills missing categories with `later` (for forcedBy/askWhen/onlyWhen). */
function fill(partial) {
  const out = {};
  for (const cat of STACK_CATEGORIES) out[cat.id] = partial[cat.id] ?? STACK_LATER;
  return out;
}

function optionLabel(categoryId, id) {
  if (id === STACK_LATER) return 'decide later';
  return (STACK_OPTIONS[categoryId] ?? []).find((o) => o.id === id)?.label ?? id;
}

function summaryLine(result) {
  return STACK_CATEGORIES.map((c) => `${c.label}: ${optionLabel(c.id, result.choices[c.id])}`).join(' · ');
}

function showStackSummary(result) {
  const lines = STACK_CATEGORIES.map((cat) => {
    const value = result.choices[cat.id];
    const mark = value === STACK_LATER ? '◌' : '✓';
    return `${mark} ${cat.label.padEnd(15)} ${optionLabel(cat.id, value)}`;
  });
  if (result.pending.length) {
    lines.push(
      '',
      'Pending layers are recorded in ai-docs/stack.md — Pi (/idea or /stack)',
      'decides with you and the system generates the docs for each one.',
    );
  }
  lines.push(
    '',
    'During execution, the system equips the project with the tools for these',
    'choices — CLI installs, logins and (with Neon) creating the database still',
    'ask for your confirmation along the way, like the template-flow logins.',
  );
  ui.note(lines.join('\n'), 'Your stack — review it');
}
