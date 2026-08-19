---
description: Review the PRD (gaps, ambiguity, acceptance criteria)
argument-hint: "[optional focus]"
---
Read `.pi/skills/fia/SKILL.md` and follow its rules.

Delegate to the `reviewer` subagent the review of `ai-docs/PRD.md` (or
`ai-docs/prd.md`). In addition to gaps, ambiguities, requirements without
acceptance criteria, contradictions and technical risks, verify the full
falsifiability contract:

- evidence is separated from assumptions, and every unknown is written as
  `TBD — needs validation` with a concrete validation method;
- the problem is solution-independent and identifies context/trigger, JTBD and
  explicit non-users;
- the hypothesis has separate RIGHT and WRONG/counter-signals with a timeframe;
- the MVP is the thinnest end-to-end slice that can validate or kill the
  hypothesis;
- every outcome and guardrail metric states metric, target, timeframe and how
  it is measured;
- the product thesis, why now and guardrails are explicit;
- module chapters apply the same contract without rewriting the main PRD;
- v1 scope, exclusions, launch criteria, decision logs, stack ownership and the
  protected term `semantic type` remain intact. $@

Give me back the list of problems in order of importance, each with the suggested fix. Do NOT edit the PRD — I decide the changes.
