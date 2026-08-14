# Components — the design system registry and its hard rule

`ai-docs/components/registry.md` is the SOURCE OF TRUTH for UI components:
name, category (foundations/actions/forms/overlays/navigation/data/
feedback/structure/charts), origin, file, install command, docs URL, status
(`installed`/`planned`), **role** (`—` only one for the need | `default` |
`alternative`) and "when to use". The live page `/ui-components`
(Design System, standardized layout: sidebar + search + Foundations/tokens)
renders everything in it, in the project's own stack. This cookbook backs
`/component` and the reuse rule every task obeys.

## The hard rule (enforced at task creation AND at build)

1. **No UI component is created if the registry has an equivalent.** Briefs
   (task-sequencer) carry a "Design system components" section mapping
   every UI need of the task to registry rows — the FDA uses those, period.
2. **Component missing from the registry?** The flow depends on the mode:
   - **Interactive** (/task, conversation): STOP and ask the engineer — ONE
     question, with a recommendation (suggested origin: shadcn/ui → REUI →
     another lib → custom component) — then run the `/component` flow
     (register + install) BEFORE the task continues.
   - **Goal mode** (/goal): do NOT interrupt — run the `/component` flow
     yourself (register + install + page), continue the task, and REPORT in
     the final summary every component added this way (feedback to the engineer).
3. **Variants are not new components**: DataTable with sort, multi-select
   Combobox etc. are props/composition of the existing one — or a new row in
   the registry pointing at the library's variant, with a "When to use" that
   disambiguates.
4. Status `planned` never ships in a screen — install first.
5. **Default × alternative (same-need conflict)**: when two entries serve the
   SAME need (two data tables…), exactly one has the role
   `default` — it's the one every task uses automatically. An
   `alternative` only enters a task when the issue/the engineer asked for it BY
   NAME (and the brief cites the request). Swapping the default is the
   engineer's decision — never swap silently during a goal.

## Semantic fields (the second hard rule)

Data whose valid values are already known to the world — state/UF, country,
address/CEP, phone, CPF/CNPJ, money, civil dates, timezone, language, fixed
categories — NEVER ships as a free-text input. The user selects from the
canonical source (the 27-UF list; ISO 3166 countries with flag) or types into
a masked, validated field (CEP with automatic address lookup — ViaCEP primary,
BrasilAPI fallback, both free and keyless; assistive, never blocking). Store
the canonical code (`SP`, `BR`, integer cents, `yyyy-MM-dd`); display the
localized label. The canonical catalog with each component contract ships in
the project at `.claude/skills/design-system/references/semantic-fields.md`.
Briefs map field → semantic type → registry component in the "Semantic
fields" table, and the brief's Quality Checklist carries the gate line — the
checklist gate refuses to close a run that ignored it.

## /component — add with minimum friction

Minimum input: **name** + **exact component URL** and/or **install
command** (one of the two REQUIRED) + category + where it lives (ask ONE
at a time, with a recommendation, for whatever is missing). Flow:

1. **Duplicate/conflict?** Registry already has an equivalent → show it and
   recommend props/composition. Confirmed the second component? Resolve the
   conflict with ONE question (with a recommendation): "which one becomes the
   **default**?" — update BOTH rows (role `default`/`alternative`) and each
   one's "When to use" saying when the alternative is worth it.
2. **Research** → local doc `ai-docs/components/<lib>/<name>.md` (delegate to
   the `ui-component-researcher` subagent when available; otherwise
   research/fetch it yourself, or dispatch a `scout` FDA for docs in the repo).
3. **Install + adapt** — the install command actually runs
   (`npx shadcn@latest add <name|url>`…); the component follows the project's
   conventions (theme tokens, i18n, a11y, mask/validation when it's a field).
   App code = FDA whenever the work goes beyond pasting the component
   (e.g. wrapping it in a canonical wrapper) — you orchestrate.
4. **Register + expose** — row in the registry (between the
   `<!-- registry:start/end -->` markers) + section on the `/ui-components`
   page (harness: ui-component-page subagent; via FDA if needed).
5. **Commit the docs** — registry row + local doc are durable records:
   `node imp/scripts/docs-commit.mjs --message "docs(component): register
   <name>" ai-docs/components`. Left uncommitted they contaminate the next
   FDA's commit. (Code installed by an FDA is committed by that FDA.)
6. **Report**: file, registry row, page section, local doc.

Extra modes: `list` (registry by category) · `sync` (reconcile
registry ↔ code ↔ page; a row without a file becomes `planned`, never disappears
silently).

## Seeding (when the registry is empty)

- New project: `/map`//start seeds via component-architect (template
  components + ideal ones from the PRD). Greenfield Task 02 (`Kind: kit`)
  then builds every core-kit component up front (design-system skill,
  `references/core-kit.md`).
- Existing project: `/absorb` seeds as-built (what the code already uses);
  `/kit` goes further — as-built registry + `/ui-components` page + gap
  report vs the core kit → approved design-only tasks (`Kind: kit`).
  `launch:check`'s `registry_seeded` warn points here when the registry is
  blind to the code.
- Any time: `/component sync`.
