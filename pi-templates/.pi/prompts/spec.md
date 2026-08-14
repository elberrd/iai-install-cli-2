---
description: Create or update a durable spec (requirements + BDD scenarios) — also for work not born from the PRD
argument-hint: "\"capability\" or NNNN"
---
Read the cookbook `.pi/skills/fia/cookbooks/specs.md` — it pins the exact
format. The spec is the deliverable; you implement NOTHING.

Target: $@ (a number → update that spec in `ai-docs/specs/`; text → new spec
`ai-docs/specs/NNNN-<slug>.md`, numbering continues from the existing files).

1. **Short interview** (one question at a time, always with a recommendation,
   3–6 questions): problem & observable outcome, scope in/out, actors &
   permissions, what must NOT be possible. Facts → look them up in the code
   and `ai-docs/` yourself; only decisions come to me. Decision log (cookbook
   `.pi/skills/fia/cookbooks/decision-log.md`): `open spec` before the first
   question, `log` each answer as it lands, `close` at the end with
   `--artifact ai-docs/specs/NNNN-<slug>.md`.
2. Write/update the spec per the cookbook: header block, Problem & Outcome,
   Scope, Actors & Permissions, `FR-n`/`NFR-n` requirements, BDD `S-n`
   scenarios (mandatory classes when data mutates: success, validation,
   authorization, cross-tenant isolation, idempotency — a class that doesn't
   apply gets a one-line reason), Traceability table, Gate log, Decisions.
   Lean beats complete — "Not applicable — <why>" is a valid section body.
3. Requirements + scenarios in place and no open P1 questions → append
   `Definition Gate: passed — YYYY-MM-DD` to the Gate log and set
   `Status: defined`. Otherwise keep `draft` and show me what's still open.
4. Tick related unchecked items in `ai-docs/inbox.md` with `→ spec NNNN`.
   Suggest the next step: /feature to break it into tasks (they carry
   `Spec: NNNN (S-…)` lines) — or /task if the tasks already exist.
