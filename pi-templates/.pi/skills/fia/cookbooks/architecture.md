# Architecture checkpoint — decide only what can bend the plan

This cookbook is the conditional architecture preflight for `/map`. It is not a
standalone slash-command and not another persisted workflow step. Its job is to
surface expensive or uncertain choices before screens and tasks encode them,
while skipping ceremony for straightforward scopes.

## Trigger assessment

Run the checkpoint when **any** item is true:

- a new external integration or service;
- a second runtime/deploy target or external job;
- a new data domain, central relationship, migration or backfill;
- auth, roles, tenancy, payments, PII, secrets or another trust boundary;
- a public contract, storage choice or other expensive-to-reverse decision;
- two or more materially different solution approaches;
- uncertainty that needs a spike or experiment.

No trigger: report `architecture checkpoint skipped` and continue. Do not open
an interview and do not create `ai-docs/architecture.md` just to say "none".

## Reuse before reopening

Read, in order: `ai-docs/PRD.md`, `ai-docs/stack.md`, existing
`ai-docs/architecture.md`, `ai-docs/map.yaml` or as-built docs/code, and recent
decision logs. If an architecture document already covers this scope, reuse it.
Reopen only decisions invalidated by a material PRD or stack change; never
repeat the whole interview.

`ai-docs/stack.md` remains the source of truth for global technology layers.
Architecture may describe how a chosen technology is used, but cannot override
the manifest or silently add/reopen a layer. A newly discovered global service
or layer is resolved through `/stack`; resume `/map` afterward.

## Triggered protocol

1. Open the official record before asking:
   `node imp/scripts/decision-log.mjs open map --topic "architecture: <scope>"`
   (read `list --json` first and reuse prior decisions).
2. Interview **one question at a time**. Offer 2–3 concrete options with the
   recommended option first and explain the consequence in plain language.
3. Cover only decisions that matter: approach and existing-system reuse; domain
   and data shape; boundaries/contracts and trust; build vs buy; missing pieces;
   and spikes/experiments. Do not drift into UI details or task breakdown.
4. Present the proposed decisions and wait for explicit confirmation. Only then
   write the artifact and close the log with
   `--artifact ai-docs/architecture.md`.

## Artifact contract

Write exactly one current artifact:

```markdown
# Architecture — <scope>

Status: ready | provisional
Intent: ai-docs/PRD.md
Stack: ai-docs/stack.md
Decision log: ai-docs/decisions/<NNN-map-...>.md
Updated: <date>

## Problem & goals
## Trigger assessment
## Approaches considered
## Recommended approach
## Key decisions
### Stack and existing-system reuse
### Domain and data shape
### Boundaries and contracts
### Other major decisions
## Missing pieces
## Risks
## Spikes and experiments
## Open questions
## Downstream planning constraints
```

Every spike uses this compact record:

`Question · Smallest spike · Timebox · Decision rule · Blocks`

- `Status: ready` means downstream planning can proceed normally.
- `Status: provisional` means the chosen approach is good enough to plan, but
  task generation puts its smallest spike issues at the front of the DAG and
  blocks only the tasks named in `Blocks`.
- A blocking open question without a decision rule stops task generation. Ask
  for the missing decision rather than burying it as an assumption.

Spikes are ordinary issues, not a new `Kind`. Use `Mode: prototype` only when
the work is deliberately disposable. Their acceptance criteria require the
evidence/result and an update to `ai-docs/architecture.md`. Alternatives that
were not selected are context, never tasks.
