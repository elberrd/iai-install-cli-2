# Design — layout redesign from references, inside the design system

`/design` changes the app's LAYOUT (navigation, where tables/cards/
charts live, hierarchy, density, motion) from reference images
and/or a description. The rule that makes it work:

> **The reference is STRUCTURE inspiration. The identity is OURS.**
> Layout/hierarchy/density/motion come from the reference; colors, fonts and
> components come from the design system (theme + `ai-docs/components/registry.md`).

You orchestrate and interview; **app code is FDA work**. Speak the engineer's language.

## Step 1 — Facts

Registry (the single component vocabulary, default × alternative roles),
`ai-docs/stack.md`, `ai-docs/screens-routes.md`, `ai-docs/map.yaml`, the code
of the screens in scope, and the Impeccable skill when installed (the
motion/polish authority).

## Step 2 — Read the reference like a designer (not like a copier)

From each image, extract in writing: structure (navigation, grid, regions),
hierarchy (what dominates, what supports), density, patterns (filters on top ×
sidebar; detail as a page × drawer) and perceived motion. Explicitly
DISCARD: palette, typography, icons, components from another library.
Did they ask for the image's colors? Explain the separation and offer to take
the extracted palette as the starting point for `/theme` (with a preview).

## Step 3 — Confirm (short interview, ONE question at a time, with a recommendation)

Scope (which screens) · what matters from the reference (confirm your reading in
one sentence) · what to preserve from the current design · motion level (subtle
recommended | medium | expressive).

## Step 4 — Plan mapped to the design system (approval required)

Per screen, region by region, each need → registry row (`default`;
`alternative` only when asked for by name). Component missing → the
`/component` protocol (register + install) FIRST. Motion: with Impeccable,
follow it; without it: 150–300ms, transform/opacity, stagger ≤ 60ms,
`prefers-reduced-motion` always. Show the plan and wait for the OK.

## Step 5 — Apply (size decides)

- **Contained** (one screen/region): ONE FDA with the plan as the brief; validate
  in the browser — in Claude Code, `/test-ui` runs that validation (no Pi
  equivalent yet; from Pi, start the dev server and walk the screens yourself,
  plus `impeccable audit` when available). Update `ai-docs/screens-routes.md`.
- **Broad** (navigation + several screens): recommend turning it into TASKS —
  numbered issues (one vertical slice per screen, the plan goes into the briefs)
  executed with `/task`//`/goal` as always. A broad change without tasks = no trace.

Close by committing the doc updates
(`node imp/scripts/docs-commit.mjs --message "docs(design): <redesign>"
ai-docs`) and reporting: screens/tasks, registry components used, what was
left out and why, motion applied, next steps (`/test-ui` in Claude Code,
`/theme`, `/component`).
