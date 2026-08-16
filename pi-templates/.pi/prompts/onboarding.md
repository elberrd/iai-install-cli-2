---
description: First command on an EXISTING system — /absorb → /stack → /kit in one guided pass, ending ready for /idea or /feature
argument-hint: "[optional focus, e.g. only the sales module]"
---
Read `.pi/skills/fia/SKILL.md`. This is the ONE command to run right after
installing on an EXISTING system: it chains the three brownfield onboarding
commands in order and ends with the project ready for new work. You orchestrate
the sequence — each stage's own prompt is the law: follow it to the letter
(interviews, decision logs, approvals included). NEVER change product code
here (the only exception is /kit's `/ui-components` page, per its own prompt).

Focus (optional, passed to the /absorb stage): $@

0. **Guard + announce** — run `node imp/scripts/project-mode.mjs --json` and
   trust it. Not `brownfield` → stop: there is nothing to absorb; route in one
   line — no PRD yet → /idea (discover the product), PRD exists but nothing
   built → /grill then /map. Brownfield → announce the tour: three stages,
   what each produces, roughly what I will be asked.
1. **Absorb** — follow `.pi/prompts/absorb.md`: as-built PRD, `ai-docs/map.yaml`,
   conventions, stack manifest, component registry and the project skill. If
   `ai-docs/map.yaml` AND the as-built PRD already exist, show what is there
   and ask ONE question: re-run or keep them and skip ahead.
2. **Stack** — follow `.pi/prompts/stack.md` (full pass): decide any layer
   still "decide later", run the mandatory research, write
   `ai-docs/apis/<tech>.md` for each technology in use and equip the project
   (skills, CLIs, MCPs).
3. **Kit** — follow `.pi/prompts/kit.md`: as-built registry + `/ui-components`
   page, gap report vs the core kit, and ONLY engineer-approved design-only
   tasks — "nothing approved" is a valid outcome; approved tasks run later via
   /task or /goal.
4. **Wrap-up** (mandatory) — recap the three stages in one line each (artifact
   paths), then hand over — the system now behaves like a project "with a
   PRD". Explain the split:
   - `/idea "<module>"` — something MODULE-sized: a new area of the product
     (new actor, new data domain, several screens). Deep interview → a
     `## Module: <name>` chapter appended to the PRD; /feature then turns it
     into specs + tasks.
   - `/feature "what you want"` — a delta on the existing system you can
     describe in one sentence. Delta interview → delta spec → only the NEW
     tasks, shown for my approval before anything runs.
   Rule of thumb: can't describe it in one sentence → /idea; otherwise
   /feature. (Defect → /bug; tiny change → /quick.)
   A stage was skipped or /kit tasks were approved → say what is pending and
   the command that resumes it.
