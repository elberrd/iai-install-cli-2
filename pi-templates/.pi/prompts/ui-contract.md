---
description: Decide UI applicability and implementation, with explicit choices before canonical fallback
argument-hint: "[profile | show | review]"
---
Read `.pi/skills/fia/SKILL.md` and
`.pi/skills/fia/cookbooks/ui-contract.md`, then follow the cookbook exactly.

Requested mode or profile: $@

The schema-v3 artifact is `ai-docs/ui/contract.json`; the executable contract is
`node .agents/scripts/ui-contract.mjs`. Do not write or overwrite anything before
explicit confirmation. A game or art-directed single surface may legitimately
SKIP app shell, breadcrumb, theme switcher, DataTable, or Kanban, with a stable
reason. Responsive containment, keyboard/focus quality, recovery, and correct
drag geometry/alternatives when drag exists are never optional.

After confirmation, record a capability boolean only with the atomic
`capability --name <capability> --enabled true|false` command. Enabling
`kanban` safely enables `dragAndDrop`; enabling
`advancedDataTableControls` safely enables `dataTables`. Conflicting disables
are rejected without changing the contract.

Applicability and implementation are independent. Preserve an explicit
existing/specified library or custom project component; never replace it with
house code. Every non-canonical choice is per-surface and resolves through a
non-empty local entrypoint; library modes require package plus entrypoint.
Only an unspecified surface resolves to canonical `fia-universal`. A package
name is never a global implementation default. Established non-Next stacks
must select compatible alternates for every applicable surface, then
`ui-kit.mjs verify` hashes the entrypoint and installed registry row (and
checks the package for library modes).
The examples shelf is optional inspiration, never an implementation source.
