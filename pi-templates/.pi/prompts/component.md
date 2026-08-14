---
description: Add a component to the design system (name + URL/command) — register, install and expose it on the page
argument-hint: "[name + URL and/or install command | list | sync]"
---
Read `.pi/skills/fia/SKILL.md` and the cookbook `.pi/skills/fia/cookbooks/components.md`, and follow it to the letter.

Request: $@

The registry `ai-docs/components/registry.md` is the source of truth; the
`/ui-components` page shows everything actually rendered. In this order:

1. Is there already an equivalent in the registry? Show it to me and recommend
   using/composing before creating a variant. If I confirm a second component
   for the SAME need (e.g. two data tables), ask me which one becomes the
   **default** (with a recommendation) — the other stays as an **alternative**,
   used only when I ask for it by name; update both registry rows.
2. Missing part of the minimum (name + exact URL OR install command)? ONE
   question at a time, with a recommendation — category and folder you suggest
   on your own.
3. Research the official doc → `ai-docs/components/<lib>/<name>.md`; install;
   adapt to the conventions (tokens, i18n, a11y); add it to the registry and
   update the `/ui-components` page. Came from an entry on the examples shelf?
   The row's Docs column may point at `ai-docs/examples/<slug>/NOTES.md`.
4. Finish with: file created, registry row, page section — and the reminder
   that upcoming tasks will now use this component.

`list` = registry by category · `sync` = reconcile registry ↔ code ↔ page.
