---
description: Browser QA at milestone, spec, or task boundaries — Playwright e2e + design audit
argument-hint: "[M1 | NNNN | NN — optional scope] [--video off|on|retain-on-failure]"
---
Read `.pi/skills/fia/SKILL.md` and the cookbook `.pi/skills/fia/cookbooks/qa.md`, and follow it to the letter.

Engineer's scope and flags: $@

This command **verifies** — it does not implement features. Unit/integration
tests already ran inside each `/task` FDA; `/qa` is the product layer: real
browser, responsive viewports, registry/patterns audit, durable report.

1. Parse scope: `M1`, a spec id (`0007`), a task number (`07`), or omit to
   infer the latest milestone/spec whose tasks are all done and lacks a passing
   report. If inference is ambiguous, ask me to pick one scope.
2. Run the FDA:

```bash
node imp/fda_qa.mjs "<scope>" [--video retain-on-failure]
```

3. Exit 0 → show me the report path under `ai-docs/qa/` and summarize what
   was exercised. Remind me that milestone `Status: done` is still my manual
   edit — a green `/qa` is the evidence that makes it honest.
4. Exit != 0 → show the failing phase (e2e vs audit), artifact dir under
   `imp/data/qa/<fda-id>/`, and suggest `/bug` or `/task` for fixes — never
   re-run `/qa` until the underlying issue is addressed.

Do **not** suggest `/qa` after `/quick`. After `/goal` finishes a milestone
or `/feature` finishes a spec batch, suggest `/qa <scope>` once — do not block
the loop on it.
