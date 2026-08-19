# UI contract — deterministic applicability and implementation

Use `ai-docs/ui/contract.json` as the single executable decision record for UI
capabilities. Profiles: `enterprise-admin`, `operational-saas`, `content`,
`marketing`, `immersive-game`, `custom`. States: `required`, `optional`,
`not_applicable`, `waived`.

Schema v3 also records implementation selection for the closed surfaces
`app_shell`, `breadcrumb`, `theme`, `data_table`, and `kanban`. Precedence is:
explicit per-surface choice, then the canonical-only default. Canonical
`fia-universal` applies when the user/project supplied no detailed choice.
`existing-library`, `specified-library`, and `custom` are implementation modes,
not waivers; the universal behavior and quality rules still apply.
Every non-canonical choice names one concrete surface and a project-relative
entrypoint. Library modes require both package and entrypoint. A package name
alone is never presumed to implement every surface.
Examples are an optional shelf.
They never select a dependency or component.

A capability boolean is the activation record: `optional` + `false` is dormant
and skipped; `optional` + `true` was explicitly activated by an approved need.
Write a confirmed boolean only through
`node .agents/scripts/ui-contract.mjs capability --name <capability> --enabled true|false --json`.
Enabling `kanban` also enables `dragAndDrop`; enabling
`advancedDataTableControls` also enables `dataTables`. A conflicting disable is
rejected atomically: disable the consumer first.

1. Read PRD, stack, optional architecture/routes, existing contract and recent
   `ui-contract` decision logs.
2. Existing contract: run `node .agents/scripts/ui-contract.mjs check --json`.
   Schema v1/v2 fails closed; run `migrate --json`. V1 gains the canonical
   fallback. V2 migrates only unambiguous per-surface choices; a global
   alternate stops for explicit re-selection, while a missing library
   entrypoint requires `--entrypoint <surface=project-relative-path>`.
   `show` reports the
   validated decisions and stops without writing.
3. Infer one recommended profile from product shape. Ask ONE profile question,
   recommended first, previewing shell/breadcrumb/theme/table/advanced-table/
   Kanban defaults, each optional capability's active/dormant boolean, the
   resolved canonical default, and surface overrides. Search the PRD,
   stack, registry and decisions for an explicit library/custom choice first.
   Accept `accept all recommended`. A supplied profile is a hint, not
   permission to write.
4. Open `decision-log.mjs open ui-contract --topic "UI applicability"`, then
   log the confirmed answer. Ask more only when PRD facts contradict the
   profile; offer a precise rule override.
5. After confirmation, create with
   `node .agents/scripts/ui-contract.mjs init --profile <profile> --json`. Record a confirmed
   surface choice atomically with `node .agents/scripts/ui-contract.mjs
implementation --surface <surface> --mode
<canonical|existing-library|specified-library|custom>
[--package <name>] [--path <entrypoint>] --json`. Library modes require both;
custom requires the entrypoint; canonical needs neither. `default` is valid
only for canonical. Existing file: change only
   confirmed selections. Record each confirmed capability activation or
   deactivation with `node .agents/scripts/ui-contract.mjs capability --name <capability> --enabled true|false --json`;
   never hand-edit dependency booleans or silently reset with `--force`.
6. Run `node .agents/scripts/ui-contract.mjs check --json`; errors block. Report
   `not_applicable`/`waived` as `SKIP <rule-id> — <reason>` and report the
   resolved implementation for each applicable surface. Close the decision log
   with `--artifact ai-docs/ui/contract.json`.

When the established frontend is Vue/Nuxt/Svelte/Angular/Solid/Astro or another
non-Next stack, each applicable surface must select a compatible per-surface
library/custom entrypoint instead of the Next-specific canonical adapter.
Materialization closes only after `ui-kit.mjs verify`: the entrypoint is a
non-empty local file, its exact registry row is installed/selected, the package
is declared for library modes, and the schema-v2 receipt contains current
entrypoint/registry SHA-256 evidence. Never author that receipt manually.

`waived` requires `approvedBy` and `scope`. Non-waivable quality invariants
remain required for every profile. Downstream agents and gates read this file;
they do not infer applicability, invent skips, replace explicit libraries, or
use canonical-only APIs unless `resolveUiImplementation(...).isCanonical`.
