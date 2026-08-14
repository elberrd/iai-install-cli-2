# Theme — interview → preview → approve → apply

`/theme` changes the project's visual identity (colors, typography, shape)
with ZERO risk: a quick interview, a PREVIEW route rendering the existing
design system with the proposed theme side by side with the current one, and
NOTHING applied until the engineer approves. You orchestrate and interview;
**app code (preview route, globals.css, layout) is FDA work** — hard rule 5.
Speak the engineer's language; translate every choice to plain language.

## Step 0 — Guards

1. **No app yet** (`ai-docs/stack.md` names a frontend but there is no
   scaffold/token file, nothing to `npm run dev`) → stop and point at the
   greenfield foundation task (Task 01: scaffold + `/ui-components` + neutral
   default theme, via `/task`); `/theme` comes right after it — the preview
   needs real components to render.
2. **Fast path — keep the current theme**: the engineer's hint or first answer
   is "the current/default theme is fine" → skip interview, preview and FDA.
   Record the decision (decision log: `open theme --topic "accept current
   theme"` + `close <id> --outcome "engineer accepted the current theme — no
   changes"`) and stop. Nothing changes in the app; the theme gate that holds
   feature tasks after the greenfield foundation is satisfied — it demands a
   recorded decision, not necessarily a new theme.

## Step 1 — Facts

`ai-docs/stack.md` (frontend → where the tokens live; recommended/custom Next
stacks: `app/globals.css` + fonts in the layout via `next/font`), the CURRENT
theme (read the tokens file), `ai-docs/PRD.md` (the product guides the
recommendation) and `ai-docs/components/registry.md` (the preview renders REAL
components).

## Step 2 — Interview (~7 questions, ONE at a time, always with a recommendation)

1. Starting point: adjust the current theme | a shadcn/create preset (paste the
   command) | rethink from scratch.
2. Primary color — accepts hex, a name or a VIBE ("feels trustworthy");
   recommend based on the PRD.
3. Accent + neutrals (warm × cool) — one question.
4. Light/dark: both (recommended) and which one starts.
5. Typography: 3 ready-made title+body pairs that match the vibe + "another".
6. Shape (presets): square and dense | soft and standard (recommended) |
   rounded and airy.
7. Interaction patterns — the `ai-docs/ui/patterns.md` defaults in plain
   words: "creating/editing opens a centered dialog (button or row click),
   deleting asks in a styled confirm dialog, form errors show in red under
   each field, saves confirm with a toast — keep, or change something (e.g.
   edit in a side panel)?" Recommend keeping. A changed default is recorded
   in the decision log AND you edit `ai-docs/ui/patterns.md` yourself at the
   Step 4 verdict (orchestrator work, not FDA work — the FDA's
   UI-conformance gate READS that file, so contract and enforcement must
   move together).
8. Optional free detail (gradient, dark-first, borders…).

## Step 3 — Preview via FDA (nothing global changes)

Dispatch ONE FDA (`fda_prompt`/`fda_build`) with the full spec:

- Generate ALL of the project's standard tokens (shadcn set: --background,
  --foreground, --card, --primary, --secondary, --muted, --accent,
  --destructive, --border, --input, --ring, --radius, charts… light AND
  dark). WCAG AA contrast in both modes is a BLOCKER (text ≥ 4.5:1).
- Create the preview route next to the design system page
  (`app/ui-components/preview/page.tsx`): a wrapper with the CSS variables
  redefined locally + `next/font` fonts for THIS route only; content =
  Foundations + samples of the real registry components, **side by side
  Current × Proposed**, light and dark. No `/ui-components` page yet →
  standalone preview with the basic samples.

Brief hygiene (BOTH theme FDAs, preview and promotion): the brief NEVER
contains commit instructions — committing is the FDA's own deterministic
phase, after review, limited to the paths the run itself changed. And it
never asks for registry/stack doc edits: the durable record of the theme
decision is the decision log (Step 4), not `ai-docs` rewrites.

Then: "open `/ui-components/preview` with `npm run dev`" — and wait.

## Step 4 — Approve | Adjust | Give up (loop)

- **Approve** → promotion FDA: tokens into `globals.css` (light+dark),
  fonts into the root layout, delete the preview route, `npm run build` green.
  Report values and files. The FDA commits its own approved work — never put
  "commit" in the brief. Close the decision log with the verdict; if question
  7 changed an interaction default, edit `ai-docs/ui/patterns.md` to match
  (after the run — the repo is read-only while the FDA holds the lock); then
  commit the record: `node imp/scripts/docs-commit.mjs --message "docs(theme):
  record approved theme decision" ai-docs/decisions ai-docs/ui`.
- **Adjust** → ask WHAT to change (one question), regenerate the preview
  (a new small FDA). As many times as needed.
- **Give up** → an FDA deletes the preview route. NOTHING changed.

Hard rules: never apply without explicit approval; only the project's standard
tokens; the `/ui-components` page (Foundations) already reflects the new theme
by reading the real variables — no need to edit it.
