---
description: Browser QA at milestone, spec, or task boundaries — Playwright e2e + design audit
argument-hint: '[M1 | NNNN | NN — optional scope] [--video off|on|retain-on-failure]'
---

Read `.pi/skills/fia/SKILL.md` and the cookbook `.pi/skills/fia/cookbooks/qa.md`, and follow it to the letter.

Engineer's scope and flags: $@

This command **verifies** — it does not implement features. Unit/integration
tests already ran inside each `/task` FDA; `/qa` is the product layer: real
browser, deterministic UI-contract applicability, responsive geometry,
registry/patterns audit, and a durable report.

1. Parse scope: `M1`, a spec id (`0007`), a task number (`07`), or omit to
   infer the latest milestone/spec whose tasks are all done and lacks a passing
   report. If inference is ambiguous, ask me to pick one scope.
2. A UI scope requires a valid `ai-docs/ui/contract.json`. The FDA loads it
   fail-closed and resolves every named rule to `APPLY` or `SKIP` with its
   deterministic reason. Only browser/audit evidence earns `PASS`; do not
   invent or relax applicability during QA.
   An API-only scope needs no UI contract and records `Status: skipped` plus
   the reason instead of starting a browser.
3. Run the FDA:

```bash
node imp/fda_qa.mjs "<scope>" [--video retain-on-failure]
```

4. Exit 0 → show me the report path under `ai-docs/qa/` and summarize what
   was exercised. Remind me that milestone `Status: done` is still my manual
   edit — a green `/qa` is the evidence that makes it honest.
5. Exit != 0 → show the failing phase (contract/scope vs e2e vs audit), artifact dir under
   `imp/data/qa/<fda-id>/`, and suggest `/bug` or `/task` for fixes — never
   re-run `/qa` until the underlying issue is addressed.

For applicable UI rules, the authored Playwright evidence must cover exact
360/768/1440 viewports and 100%/125%/200% zoom. Theme-capable products cover
system/light/dark; enterprise tables cover stable filter chrome plus
right-click and keyboard header actions; Kanban covers containment,
DragOverlay alignment, board scrolling, and the non-drag `Move to` path.
Rules resolved to `SKIP` stay absent from the test burden and retain their
reason in the evidence.

Do **not** suggest `/qa` after `/quick`. `/goal` runs `/qa <milestone>`
automatically at each completed milestone boundary and blocks on failure;
after `/feature` finishes a spec batch, suggest `/qa <scope>` once.
