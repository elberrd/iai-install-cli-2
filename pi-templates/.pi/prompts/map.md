---
description: Generate map, screens and tasks from the PRD (FIA's "start")
argument-hint: "[optional instructions]"
---
Read `.pi/skills/fia/SKILL.md` and the cookbook `.pi/skills/fia/cookbooks/harness_bridge.md`, and follow Step 1 (Pi path).

First: read `ai-docs/stack.md`. If there is a "decide later" layer, warn me and
suggest resolving it first with `/stack` (or `/idea`, if there isn't even a PRD) —
the plan comes out better with the stack settled. I decide whether we proceed anyway.
If the manifest's Automations layer names an external service (e.g. Modal), the
plan must cover it: `start-mapper` fills the `automations:` section of
`ai-docs/map.yaml` (schema in `ai-docs/start/map-start.yaml`) and
`task-master-generator` creates the setup/deploy tasks for those jobs.
Also skim `ai-docs/inbox.md`: unchecked items that belong in this scope get
folded into the plan and ticked `- [x] … → task NN` once their task exists.
And skim `ai-docs/examples/registry.md`: entries whose Tags match the planned
capabilities are cited in the matching issues (a shelf, not a mandate — an
empty registry changes nothing).

**Architecture checkpoint (conditional preflight; it is NOT another workflow
step):** read and follow `.pi/skills/fia/cookbooks/architecture.md` before
delegating. Trigger the checkpoint when ANY item is true:

- a new external integration or service;
- a second runtime/deploy target or external job;
- a new data domain, central relationship, migration or backfill;
- auth, roles, tenancy, payments, PII, secrets or another trust boundary;
- a public contract, storage choice or other expensive-to-reverse decision;
- two or more materially different solution approaches;
- uncertainty that needs a spike or experiment.

No trigger → report "architecture checkpoint skipped" and continue without an
artifact or interview. Trigger → inspect the PRD, stack, existing map/code and
decision logs; open `node imp/scripts/decision-log.mjs open map --topic
"architecture: <scope>"`; interview one question at a time with 2–3 options and
the recommendation first; write `ai-docs/architecture.md` only after I confirm
the approach; then close the map log with that artifact. `ai-docs/stack.md`
remains the source of truth: architecture references it, never overrides it. A
new global layer/service must be resolved through `/stack`, then resume `/map`.
Reuse an existing architecture document and reopen only decisions invalidated
by a material PRD/stack change — never repeat the full interview.

**UI contract checkpoint (mandatory; also not a workflow step):** before
delegating, require `ai-docs/ui/contract.json` and run
`node .agents/scripts/ui-contract.mjs check --json`. Missing/invalid → follow
`.pi/skills/fia/cookbooks/ui-contract.md`: infer a recommended product profile,
first preserve any explicit `## UI implementation constraints` rows from the
PRD as per-surface library/custom choices, then show the
shell/breadcrumb/theme/table/Kanban consequences in ONE question and
wait for my confirmation before writing. A game or art-directed surface may
legitimately skip enterprise chrome; responsive containment, keyboard/focus,
recovery and correct drag quality remain non-waivable. Continue only on
structural PASS and pass this artifact to every delegated planner.

Delegate in sequence, waiting for each one to finish:

1. `start-mapper` → generates `ai-docs/map.yaml`
2. `screen-routes-generator` → generates `ai-docs/screens-routes.md`
3. `task-master-generator` → generates `ai-docs/todos/issues/NN-<slug>.md` + `ai-docs/todos/task-master.md`, plus one spec per major capability in `ai-docs/specs/` (issues that prove scenarios carry a `Spec: NNNN (S-…)` line)
4. `component-architect` → `ai-docs/components/ideal-components.md` + SEEDS the
   registry `ai-docs/components/registry.md` (the briefs' reuse guard depends
   on it — only `required` plus `optional` rules whose capability boolean is
   explicitly activated by an approved requirement;
   retain deterministic SKIP reasons without fake rows)
5. `ui-component-page` → creates/updates the living `/ui-components` page
   (standardized design system: sidebar + search + Fundamentals)

(Steps 4–5 follow the UI contract, not an ad-hoc yes/no. If it leaves no
applicable component catalog, record the reasoned SKIPs. Greenfield — no app
scaffolded yet — skip step 5 without trying: the foundation Task 01 creates
the page; the applicable registry seeded in step 4 is what it will render.)

Then **milestones** (you write this one, no subagent): from the task breakdown,
draft 3–6 milestones in `ai-docs/milestones.md` — the first is the MVP; each
with `Goal:`, a verifiable `Done when:` list and its `Tasks:` numbers — and
confirm them with me before saving. Greenfield (Task 01 came out as the
foundation, `Kind: foundation`): the first milestone's `Done when:` list MUST
include the theme checkpoint — "visual identity approved: closed `theme`
decision log in `ai-docs/decisions/`". Use the exact block from the cookbook
(Step 1): an H2 `## M<n> — <name>` heading plus `Goal:` / `Done when:` /
`Tasks:` / `Status: pending` lines — the Plan page and `/status` only see
milestones written in that shape. A milestone flips to done only when its
exit conditions are verified, never by task count alone.

Extra instructions from the engineer: $@

At the end:

1. Run `npm run plan -- --detach` — it opens the "Plan" page in the browser with everything that was created (screens, tasks, design system). If the script doesn't exist or fails, keep going and just say it can be viewed later with `npm run plan`.
2. Show me: how many tasks were created, the suggested order (dependency graph), what task 1 would be — plus the milestone list and how many components entered the registry.
3. State the architecture checkpoint outcome: skipped, reused, or created; if
   present, include its `ready`/`provisional` status and blocking spikes.
4. State the UI contract profile and list reasoned capability SKIPs.
5. Say, in these words: "I opened the Plan page in your browser with everything /map created — it lives at http://127.0.0.1:4600#plan (or `npm run plan`)".

Do NOT start implementing — for that I use /task or /goal. Greenfield (Task 01
is the foundation): spell the build order out for me, in this shape —
`/task` (Task 01: scaffold + design system base, autonomous) → `/theme`
(I approve the visual identity — the checkpoint feature tasks wait on) →
`/goal` (the rest, now born with the approved look). Make clear that the
executors will hold feature tasks until the theme decision is recorded.
