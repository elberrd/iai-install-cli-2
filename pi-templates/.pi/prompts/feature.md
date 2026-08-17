---
description: New feature in an existing system — delta interview → delta spec → integrated tasks
argument-hint: "\"what you want to build\""
---
Read `.pi/skills/fia/SKILL.md`. Prerequisite: `ai-docs/map.yaml` — if it doesn't
exist (existing system not yet absorbed), stop and ask me to run
/onboarding first (or /absorb alone for just the map).

Request: $@

0. **Size triage** (mirror of /quick's): this is a DELTA command — a described
   change on the existing system. MODULE-sized signals — a new actor, a new
   data domain, several new screens, a new stack layer, or I can't describe
   the delta in one sentence → stop and route to `/idea` (module mode: it
   detects the existing system, interviews in depth and appends a
   `## Module: <name>` chapter to the PRD), then come back here with that
   chapter as the request.
1. **Mini-grill of the DELTA** (one question at a time, always with a
   recommended answer, 3–7 questions): scope, actors, new vs existing data,
   error/empty states, what stays OUT of this delivery. Facts → look them up in
   the code yourself; only decisions come to me. Decision log (cookbook
   `.pi/skills/fia/cookbooks/decision-log.md`): `open feature` before the
   first question, `log` each answer as it lands, `close` after step 2 with
   `--artifact ai-docs/specs/NNNN-<slug>.md`. Related unchecked items in
   `ai-docs/inbox.md` → fold them into the interview. Rows in
   `ai-docs/examples/registry.md` whose Tags match this delta → read their
   NOTES.md before shaping it, and tell me which shape you're borrowing.
2. **Delta spec** in `ai-docs/specs/NNNN-<slug>.md` (numbering continues;
   format pinned in the cookbook `.pi/skills/fia/cookbooks/specs.md`):
   **Flow** (ONE ```mermaid diagram of the delta — what changes and where it
   can refuse) + `FR-n` requirements + BDD `S-n` scenarios + Traceability +
   Gate log. It replaces the old mini-PRD — the main PRD stays untouched.
   Requirements + scenarios + the Flow diagram in place and no open P1 →
   `Status: defined`; tick the promoted inbox items `→ spec NNNN`.
   (`npm run launch:check` warns for any spec without a diagram.)
3. Delegate to the `task-master-generator` in DELTA mode: generate ONLY the new
   issues in `ai-docs/todos/issues/` (vertical slices; numbering continues from
   the existing one; `Blocked by:` points to real tasks; inventory — what the
   code already does does NOT become a task; each issue carries its
   `Spec: NNNN (S-…)` line) and update `ai-docs/todos/task-master.md`.
4. **Show me the breakdown for approval** before executing anything —
   granularity and dependencies are mine to decide.
5. Approved → suggest /task (one) or /goal (all the new ones). Step 4 of the
   cookbook applies: when done, deliver it RUNNING + a "How to test" section.
   When the new spec's tasks are all done, suggest `/qa NNNN` once (cookbook
   `qa.md`) — do not auto-run it and never suggest QA after `/quick`.
