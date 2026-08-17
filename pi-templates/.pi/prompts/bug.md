---
description: Fix a defect — reproduction first, FDA second
argument-hint: "\"the symptom\""
---
Read `.pi/skills/fia/SKILL.md`. You fix NOTHING — the FDA fixes it.

Symptom: $@

1. **Collect the essentials** (objective questions, one at a time, only the
   necessary ones): how to reproduce, expected vs observed, since when/what
   changed. Whatever you can discover in the code or logs, discover yourself.
2. Record the issue in `ai-docs/todos/issues/NN-bug-<slug>.md` (numbering
   continues from the existing one) with the written reproduction and `Status:` pending.
3. Delegate to the `task-sequencer` → brief in `ai-docs/actual-todo/`. The brief MUST
   require: reproducing the bug with a RED test before any fix.
4. Run `node imp/fda_bug.mjs ai-docs/actual-todo/<brief>.md` and follow along.
   Tell me, in one line, that the FDA gates the RED for validity: the
   reproduction test must fail on a real assertion — a passing test means "bug
   not reproduced", and a module/syntax/env failure doesn't count as proof.
5. exit 0 → report phases/tokens/commit and close with "How to test" the fix.
   exit != 0 → ONE automatic recovery first (re-run / repair once per the
   cookbook). If that also fails, stop and show me the evidence; further
   re-runs use `--fda-id <id> --resume` (phases that passed don't run again).
