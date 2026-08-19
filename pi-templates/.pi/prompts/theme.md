---
description: Change the app's theme (colors, fonts, shape) — quick interview, preview to approve, only then apply
argument-hint: "[optional hint — e.g. 'blue, more serious' or a preset supported by the selected UI system]"
---
Read `.pi/skills/fia/SKILL.md` and the cookbook `.pi/skills/fia/cookbooks/theme.md`, and follow it to the letter.

Initial hint (optional): $@

In this order — and NOTHING changes in the app without my approval:

0. Guards: no app scaffold yet (nothing to `npm run dev`) → say the greenfield
   foundation task (Task 01) comes first (`/task`) and stop — the preview needs
   real components. And if the hint (or my answer) is "keep the current/default
   theme": skip interview and preview, just record the decision (decision log:
   `open theme` + `close` with outcome "accepted the current theme") — that
   satisfies the theme gate holding feature tasks — and change NOTHING.
1. Read the current theme, the stack (`ai-docs/stack.md`) and the PRD — the
   recommendations come from there. Also validate `ai-docs/ui/contract.json`
   and resolve the `theme` surface before proposing files or APIs. An explicit
   `existing-library`, `specified-library`, or `custom` theme remains
   authoritative; never replace it with `fia-universal`, shadcn, next-themes,
   or canonical prop names. Use the project/stack-native token source, font
   mechanism, provider, preview route, and component catalog. The canonical
   `app/globals.css` + `next/font` path applies only when the resolved theme is
   canonical `fia-universal` on Next.js.
2. Quick interview (~7 questions, ONE at a time, always with a recommendation
   in plain terms): main color (a vibe is fine), accent/neutrals, light/dark,
   font pair, shape (corners/density/shadow), interaction patterns (keep the
   `ai-docs/ui/patterns.md` defaults — dialog for create/edit, errors in red
   under each field, toasts on save — or change them; a change also edits
   patterns.md), free-form detail. Decision log
   (cookbook `.pi/skills/fia/cookbooks/decision-log.md`): `open theme` before
   the first question, `log` each answer, `close` after step 4 with the verdict
   (approved/adjusted/given up).
3. Preview via FDA: the project-native `/ui-components/preview` route (or the
   equivalent catalog/story route when that URL is unsupported) with the
   design system that ALREADY exists rendered side by side — Current ×
   Proposed, light and dark. Tell me how to open it with the stack's real dev
   command.
4. I decide: **approve** (applies through the resolved implementation's native
   token/provider/font files and deletes the preview), **adjust** (ask me what
   to change and regenerate) or **give up** (deletes the preview; zero
   changes).

AA contrast in both modes is a blocker. Commit only if I ask.
