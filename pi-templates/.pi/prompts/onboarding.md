---
description: First command on an EXISTING system — /absorb → /stack → /kit in one guided pass, ending ready for /idea or /feature
argument-hint: "[optional focus] [--report-only]"
---
Read `.pi/skills/fia/SKILL.md`. This is the ONE command to run right after
installing on an EXISTING system: it chains the three brownfield onboarding
commands in order and ends with the project ready for new work. You orchestrate
the sequence — each stage's own prompt is the law: follow it to the letter
(interviews, decision logs, approvals included). NEVER change product code
here (the only exception is /kit's `/ui-components` page, per its own prompt).

Focus/flags (optional; the focus goes to the /absorb stage): $@

0. **Guard + resume rail + announce** — run
   `node imp/scripts/project-mode.mjs --json` for the evidence, then decide
   the entry question YOURSELF — by design the script leaves it to you (a
   fresh install on a real app still reports `greenfield`: code cannot tell
   a starter from a product). Does this folder hold a REAL application
   (hand-built code, not the installer's starter)?
   - No real app → stop: there is nothing to absorb; route in one line — no
     real PRD → /idea (discover the product), real PRD but nothing built →
     /grill then /map.
   - Real app → proceed (`brownfield` — already absorbed — is fine too: the
     stages detect existing artifacts and offer to skip).
   The tour keeps a resume rail in the decision log
   (cookbook `.pi/skills/fia/cookbooks/decision-log.md`):
   - `node imp/scripts/decision-log.mjs latest onboarding --json` FIRST. An
     `open` log = an interrupted tour: read its stage notes, confirm the
     resume point with me in ONE question and KEEP that log id — a new
     `open` would supersede the trail. No open log →
     `open onboarding --topic "brownfield onboarding tour"`.
   - After EACH stage lands: `note <id> --text "stage <absorb|stack|kit>:
     done|skipped|report-only (<one line>)"` — that note trail is exactly
     what a resumed tour reads.
   Then announce the tour: three stages, what each produces, roughly what I
   will be asked — and, on a large codebase, that this is a long session
   (`--report-only` is the express path: the /kit decisions are deferred).
1. **Absorb** — follow `.pi/prompts/absorb.md`: as-built PRD, `ai-docs/map.yaml`,
   conventions, stack manifest, component registry and the project skill. If
   `ai-docs/map.yaml` AND the as-built PRD already exist, show what is there
   and ask ONE question: re-run or keep them and skip ahead.
2. **Stack** — follow `.pi/prompts/stack.md` (full pass): decide any layer
   still "decide later", run the mandatory research, write
   `ai-docs/apis/<tech>.md` for each technology in use and equip the project
   (skills, CLIs, MCPs).
3. **Kit** — follow `.pi/prompts/kit.md`, passing `--report-only` through
   when I gave it (express mode: the gap report is presented and the design
   decisions are deferred — running /kit later picks them up). Full mode:
   as-built registry + `/ui-components` page, gap report vs the core kit,
   and ONLY engineer-approved design-only tasks — "nothing approved" is a
   valid outcome; approved tasks run later via /task or /goal.
4. **Wrap-up** (mandatory) — recap the three stages in one line each
   (artifact paths), then close the rail:
   `close <id> --outcome "<stages done/skipped/deferred>"
   --artifact ai-docs/PRD.md --artifact ai-docs/stack.md` and commit the
   docs per the cookbook. Then hand over — the system now behaves like a
   project "with a PRD". Explain the split:
   - `/idea "<module>"` — something MODULE-sized: a new area of the product
     (new actor, new data domain, several screens). Deep interview → a
     `## Module: <name>` chapter appended to the PRD; /feature then turns it
     into specs + tasks.
   - `/feature "what you want"` — a delta on the existing system you can
     describe in one sentence. Delta interview → delta spec → only the NEW
     tasks, shown for my approval before anything runs.
   Rule of thumb: can't describe it in one sentence → /idea; otherwise
   /feature. (Defect → /bug; tiny change → /quick.)
   A stage was skipped, /kit ran report-only or /kit tasks were approved →
   say what is pending and the command that resumes it.
