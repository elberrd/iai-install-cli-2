# Specs — durable requirements with proof

The PRD says where the product goes; a spec pins ONE capability down:
requirements + BDD scenarios + a traceability trail that tests must satisfy.
Proportionality beats completeness — a lean enforced spec wins over a thorough
ignored one.

## File format

`ai-docs/specs/NNNN-<slug>.md` — 4-digit zero-padded, numbering continues from
the existing files; slug kebab-case. Header right after the H1:

```markdown
# Spec 0003 — <Title>

Status: draft | defined | in-progress | done
Created: YYYY-MM-DD · Updated: YYYY-MM-DD
Tasks: 07, 08
```

`Tasks:` = task numbers in `ai-docs/todos/issues/`, filled as they are created.

Sections, in order ("Not applicable — <why>" is a valid section body):

1. `## Problem & Outcome` — observable problem, expected outcome. No solution bias.
2. `## Scope` — `In:` / `Out:` bullets.
3. `## Flow` — ONE ```mermaid diagram of the capability: the happy path plus
   where it can refuse. `flowchart TD` for a data/decision flow,
   `sequenceDiagram` when the point is who calls whom. Keep it to the nodes a
   reader needs — a diagram nobody can hold in their head is worse than prose.
   Deterministic requirement: the fenced block must open with ```mermaid at line
   start. `npm run launch:check` warns for every spec without one
   (`spec_diagrams`), and each FDA run records the gap in its trace.
4. `## Actors & Permissions`
5. `## Requirements` — bullets with IDs `FR-1`, `FR-2`… (functional) and
   `NFR-1`… (non-functional). ONE obligation per ID.
6. `## Scenarios` — BDD, IDs `S-1`, `S-2`…:

   ```markdown
   ### S-1 — <name> (covers: FR-1)
   Given … / When … / Then …
   ```

   Mandatory classes for user-facing features that mutate data: success,
   validation (bad input), authorization (who must NOT be able), cross-tenant
   isolation (multi-tenant projects only), idempotency (webhooks/retried
   mutations only). A class that does not apply is listed under
   `Scenario classes considered:` with a one-line reason.
7. `## Traceability` — table `| Requirement | Scenario | Test |`. The Test
   column is filled with file paths as tests land — update it at task completion.
8. `## Gate log` — append-only lines:
   - `Definition Gate: passed — YYYY-MM-DD` (requirements + scenarios present, a `## Flow` diagram present, no open P1 questions)
   - `Delivery Gate: passed — YYYY-MM-DD — <evidence: suite green, coverage check ok, or /qa NNNN green with report path>`
9. `## Decisions` — dated one-liners with rationale.

Lifecycle: `draft` → `defined` (Definition Gate passed; tasks may be generated)
→ `in-progress` (first task started) → `done` (all linked tasks done + Delivery
Gate passed). Definition remains declared by the planning flow. Delivery is
closed deterministically by the tested task FDAs: after the suite, spec
coverage, checklist and the remaining gates pass, their `spec_close` code
phase treats the current issue as delivered, verifies every other number on
`Tasks:` is already `done`, appends the Delivery Gate evidence and sets
`Status: done` before the commit. Missing/unknown task metadata fails closed
and is recorded in the trace instead of guessing completion.

## Test markers

A test file that proves spec scenarios carries ONE comment marker per spec:

```js
// spec:NNNN covers:S-1,S-2,FR-2
```

Grep target is the literal `spec:NNNN` plus a `covers:` list of IDs —
case-sensitive, no spaces inside the list. The FDA spec-coverage gate greps
for exactly this shape; a creative variant is invisible to it.

## Task and brief linkage

Issues in `ai-docs/todos/issues/` and briefs in `ai-docs/actual-todo/` MAY
carry, on its own line:

```
Spec: 0003 (S-1, S-4)
```

The spec id + the scenario/requirement IDs this task must prove. Present → the
FDA runs its spec-coverage check after the suite passes: every listed ID must
appear in some test's `covers:` list; missing ids fail the phase. Absent → the
check is skipped (proportionality — not every task needs a spec). The
task-sequencer copies the line plus the relevant scenario excerpts into the
brief.
