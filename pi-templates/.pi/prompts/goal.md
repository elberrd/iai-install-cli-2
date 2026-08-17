---
description: Execute ALL tasks in order until done (goal mode)
argument-hint: "[optional limit, e.g.: 3 tasks]"
---
Read `.pi/skills/fia/SKILL.md` and the cookbook `.pi/skills/fia/cookbooks/harness_bridge.md`, and follow Step 3 (goal mode) to the letter.

Before any task: read `ai-docs/stack.md`. A "decide later" layer that any task
will touch = STOP and resolve it with me first (cookbook `stack.md`, same flow
as /stack) — implementing with an undecided stack is guaranteed rework.

Limit/instructions from the engineer: $@

Loop, until no unblocked task remains:

1. `task-sequencer` → next unblocked issue → brief in `ai-docs/actual-todo/`
   (sequencer stopped on the **theme gate** — right after the greenfield
   foundation task, no closed `theme` decision log? PAUSE the loop and resolve
   with me per the cookbook: `/theme` (recommended) or record my explicit
   acceptance of the default theme. Never decide for me, never skip silently.
   Stopped on the **env gate** — foundation task picked but
   `node imp/scripts/env-preflight.mjs` reports dev keys missing from
   `.env.local`? PAUSE and provision with me mid-goal per the cookbook:
   CLI parts yourself, dashboard keys from me — then continue.
   Stopped on an **impossible/circular dependency** with a recommended
   split (Task 06 needs Task 07's schema, 07 is blocked by 06)? Apply
   the split once — do not ask — and re-delegate. If the second pass
   still cannot write a brief, THEN ask.)
2. `node imp/fda_sdlc.mjs ai-docs/actual-todo/<brief>.md` — ONE task per run, never batch them
3. exit 0 → report to me in one line (task, phases, tokens, commit) and continue
4. exit != 0 → ONE automatic recovery first (cookbook `harness_bridge`,
   "On failure"): if the recommended action is re-run, or you would bring
   me something to correct that an FDA can apply, do that once
   (`--fda-id … --resume`, with a verdict `--missing` when you can name
   the gap). If that also fails, or the outcome is `no_progress` /
   `attempt_cap` / `budget_exhausted` / `engine_exhausted`: STOP. Show
   the phase, the gate violations and the trace. I decide: fix, skip or
   re-run. Never a third attempt on your own.

Briefs with a `Spec: NNNN (…)` line arm the FDA's spec-coverage gate — on
success, check the spec's Traceability table reflects the new tests and flag
it if it doesn't.

Suggest I keep `npm run fda:viewer` open in another terminal to watch live.

When everything is done, fulfill Step 4 of the cookbook (deliver it RUNNING) before the summary:
the app starts with ONE command (`npm run dev` — if it needs 2+ processes, dispatch an
FDA to create the single script), env/database ready and smoke-check done. Whatever
requires human action (login, account), ask for it in the MIDDLE of the goal and
continue — no homework at the end. Final summary: tasks, commits, tokens — and ALWAYS
closing with the **How to test** section (minimal command, URL, short checklist of
what was delivered) + an offer to start the dev server yourself right now.

When a milestone's tasks are all done, suggest `/qa <milestone>` once (cookbook
`qa.md`) before `/launch` — do not auto-run it.

Running locally and tested? The next rung is `/launch` — suggest it at the end
(it puts the app on a public URL and then into real production, guided).
