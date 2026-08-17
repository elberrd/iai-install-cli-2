---
description: Design-system onboarding & audit of an existing codebase — as-built registry, /ui-components page, gap report vs the core kit, approved design-only tasks
argument-hint: "[optional focus, e.g. tables only | --report-only]"
---
Read `.pi/skills/fia/SKILL.md`. This is the brownfield counterpart of the
greenfield `Kind: kit` task: a system built without a design-system layer gets
one retrofitted — WITHOUT changing any component or screen in this command
(the only code it may touch is the `/ui-components` page). The measuring stick
is `.claude/skills/design-system/references/core-kit.md`.

Focus/flags: $@

In this order:

1. Preconditions: runnable app with UI code; read `ai-docs/stack.md` and
   `ai-docs/components/registry.md` (missing/empty = the blind-registry state
   this fixes). Open the log: `node imp/scripts/decision-log.mjs open kit
   --topic "design system audit"`.
2. Inventory: `component-architect` in AS-BUILT mode — one `installed` row per
   reusable component the code has, real paths; record duplicates, add NO
   `planned` rows yet.
3. Page: `ui-component-page` — create/update `/ui-components` from the registry.
4. Gap audit → `ai-docs/components/kit-report.md`, three lists vs core-kit.md:
   missing needs; below contract (audit the DataTable item by item — fuzzy
   multi-word search with yellow highlights, header menu on click AND
   right-click, per-column type-adapted filters, a single Filter control +
   chips with an x — never a toolbar row of per-column filter buttons,
   visibility, pagination, selection + bulk bar, row-click,
   skeleton/empty/no-results; Combobox popover width = trigger; calendar
   caption jumps month/year; pointer cursor; `/ui-components` one component
   per card — design-system `references/interaction.md` — with file/line
   evidence); duplicates without default/alternative roles. Each finding gets
   a recommendation and a rough size. `--report-only` → present, close the log
   ("report only"), stop.
5. Decisions: present the report grouped; ONE question at a time with a
   recommendation. The engineer approves what gets done, defers the rest, and
   settles each duplicate's default. Close the log with the approved scope.
   Nothing approved → close ("nothing approved") and stop — a valid outcome.
6. Write the approved scope: `planned` registry rows ONLY for approved needs;
   roles on duplicates; one delta spec `ai-docs/specs/NNNN-design-system-kit.md`
   whose S-n scenarios are the approved contract items.
7. Tasks: `task-master-generator` in DELTA mode against that spec — one task
   per approved build/upgrade carrying `Kind: kit` (arms `npm run build`) and
   one checkbox per contract item (the checklist gate enforces them); then
   expand–contract migration tasks per screen batch; then a contract task
   deleting each retired duplicate. No product features mixed in.

Finish with: registry changes, kit-report path, decision-log id, spec, tasks —
and the next commands (`/task` / `/goal` to execute, `/component` for one-offs).
