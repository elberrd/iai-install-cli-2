---
description: Stress-test the PRD via interview (one question at a time) and record the decisions
argument-hint: "[file or topic — default: ai-docs/PRD.md]"
---
Interview me relentlessly about the target until we reach a shared understanding — and then write the decisions BACK into the document. Target: $@ (empty → `ai-docs/PRD.md`; if it doesn't exist, suggest /idea).

Interview rules:

1. **ONE question at a time** — ask, wait, continue.
2. **Every question comes with a recommendation** ("My suggestion: X, because Y").
3. Facts you discover on your own in the code and in `ai-docs/` — only DECISIONS come to me.
   Before the first question, read the target and every reference supplied in
   `$@`. If no evidence reference was supplied, ask early whether interviews,
   tickets, analytics or research exist; never invent their signal.
4. Resolve dependencies in order: data model before UI.
5. Hunt for what is MISSING, not just what is vague: evidence vs assumptions,
   solution-independent problem, primary user context/trigger + JTBD, explicit
   non-users, falsifiable hypothesis, why now, guardrails, thinnest MVP, actors,
   permissions, error/empty states, edge cases, non-goals, v1 scope vs later,
   launch criteria.
6. Priorities in a PRD: untouched `{{placeholders}}` and contradictions →
   evidence vs assumptions → problem thesis, JTBD and non-users →
   hypothesis with separate RIGHT condition (metric, target, timeframe, how
   measured) and WRONG / counter-signal → why now → guardrails (each with
   metric, target, timeframe and how measured) → thinnest end-to-end MVP slice
   → outcome metrics → scope boundaries → actors/permissions → data model →
   edge cases → non-measurable acceptance criteria.
7. Do not act on anything until I confirm the shared understanding.
8. **Decision log (deterministic)** — cookbook `.pi/skills/fia/cookbooks/decision-log.md`:
   `node imp/scripts/decision-log.mjs open grill --topic "…"` before the first
   question (read `list --json` first — don't re-ask what a previous run
   already decided), `log` EACH answer right after it lands.

Wrap-up (MANDATORY): record every decision in the document (existing sections first; the rest in a `## Decisions (grilled)` section with a one-line rationale). Never turn an assumption into evidence: unresolved facts stay `TBD — needs validation` with a validation method. A PRD without a `## Launch criteria` section gets one — "The MVP is ready when…", verifiable conditions. Close the decision log (`… close <id> --outcome "…" --artifact <target document>`). Compare the final decisions with `ai-docs/stack.md`: if grilling introduced or changed a global technology/layer, route through `/stack <delta>` before `/map` so the manifest and tooling cannot go stale. An explicit UI/component/table library or local implementation is recorded in the PRD's `## UI implementation constraints` block and is resolved by `/map` into the UI contract. Otherwise show the summary and suggest `/map` (or redoing the map if the scope changed).
