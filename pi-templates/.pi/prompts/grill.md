---
description: Stress-test the PRD via interview (one question at a time) and record the decisions
argument-hint: "[file or topic — default: ai-docs/PRD.md]"
---
Interview me relentlessly about the target until we reach a shared understanding — and then write the decisions BACK into the document. Target: $@ (empty → `ai-docs/PRD.md`; if it doesn't exist, suggest /idea).

Interview rules:

1. **ONE question at a time** — ask, wait, continue.
2. **Every question comes with a recommendation** ("My suggestion: X, because Y").
3. Facts you discover on your own in the code and in `ai-docs/` — only DECISIONS come to me.
4. Resolve dependencies in order: data model before UI.
5. Hunt for what is MISSING, not just what is vague: actors, permissions, error/empty states, edge cases, non-goals, v1 scope vs later, launch criteria.
6. Priorities in a PRD: untouched `{{placeholders}}` and contradictions → scope boundaries → actors/permissions → data model → edge cases → non-measurable acceptance criteria.
7. Do not act on anything until I confirm the shared understanding.
8. **Decision log (deterministic)** — cookbook `.pi/skills/fia/cookbooks/decision-log.md`:
   `node imp/scripts/decision-log.mjs open grill --topic "…"` before the first
   question (read `list --json` first — don't re-ask what a previous run
   already decided), `log` EACH answer right after it lands.

Wrap-up (MANDATORY): record every decision in the document (existing sections first; the rest in a `## Decisions (grilled)` section with a one-line rationale). A PRD without a `## Launch criteria` section gets one — "The MVP is ready when…", verifiable conditions. Close the decision log (`… close <id> --outcome "…" --artifact <target document>`). Show the summary and suggest `/map` (or redoing the map if the scope changed).
