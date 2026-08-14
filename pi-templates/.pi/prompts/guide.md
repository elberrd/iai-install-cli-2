---
description: Lost? Reads the project state, confirms your goal and charts the fastest command route to it
argument-hint: "[your goal, if you have one]"
---
Read `.pi/skills/fia/SKILL.md` — its **Routing** table is your only catalog of
commands (single source of truth: keep no list of your own; a command absent
there does not exist for you). Then orient me. My goal, if I already gave one: $@

**Step 0 — Probe (silent, script-first — trust the scripts, they already know):**

1. `node imp/scripts/project-mode.mjs --json` — mode + evidence.
2. `node imp/scripts/decision-log.mjs list --json` — what previous interviews
   already decided; never re-ask it.
3. Plan state, if any (a file that doesn't exist → skip it, don't complain):
   task checkboxes in `ai-docs/todos/task-master.md`, `ai-docs/milestones.md`,
   specs in `ai-docs/specs/` (ignore `0000-example.md`), unticked items in
   `ai-docs/inbox.md`, "Layers decided" in `ai-docs/stack.md`, and whether
   `ai-docs/components/registry.md` is seeded.
4. `node imp/scripts/fia-launch-check.mjs --json` — only when the tasks are
   mostly done or my goal is going live.
5. The one thing the scripts cannot see (code cannot tell a starter from a
   product): a real hand-built application that `ai-docs/` never absorbed →
   the route starts with `/absorb`, before anything else.

**Step 1 — ONE question.** Tell me where I stand in two lines, citing the
scripts' evidence — then ask my goal with your recommendation embedded ("My
suggestion: X, because Y"). If $@ already names the goal, or the state makes
it obvious (a PRD that is 100% placeholders wants `/idea`), turn the question
into a confirmation. ONE question only — this is triage, not an interview:
depth belongs to the commands you route to, and each of those keeps its own
decision log (/guide decides nothing and opens none).

**Step 2 — The route.** Map goal + state onto the Routing table and give me:

1. A numbered command sequence — each step with the criterion that put it
   there, in one line ("`/grill` before `/map`: the PRD has no Launch criteria").
2. Required steps separated from optional ones — say which is which.
3. The rungs I might expect but you skipped, with the reason ("`/kit` skipped:
   registry already seeded as-built by the template").

Close by offering to start step 1 now. If I accept, run that command;
otherwise stop — suggest, never execute on your own.
