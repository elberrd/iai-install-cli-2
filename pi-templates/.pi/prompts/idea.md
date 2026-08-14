---
description: Discover WHAT to build in conversation — from scratch, revising the idea, or a NEW module on an existing system (auto-detected)
argument-hint: "[vague topic or module, if you have one]"
---
You will help me discover WHAT to build, in conversation: $@

**Step 0 — Mode (deterministic).** Run `node imp/scripts/project-mode.mjs --json`
and branch on `mode` (trust the script — the starter's code and a PRD template
full of `{{placeholders}}` do NOT make a project brownfield; it already knows):

- `greenfield` → interview from scratch (rules below, wrap-up below).
- `ideation` → a real PRD exists but nothing was built from it. FIRST question:
  revise THIS idea or start a NEW direction? Revise → read the PRD and the
  previous decision logs, interview only the gaps, update the PRD. New →
  full interview and rewrite the PRD (git + decision logs keep the old version).
- `brownfield` → **Module mode** (below).
- In greenfield/ideation, if the code holds a real application that `ai-docs/`
  never absorbed (not the installer's starter), stop and suggest `/absorb` first.

Interview rules (follow them to the letter):

1. **ONE question at a time.** Ask, wait for the answer, move on.
2. **Every question comes with your recommendation** ("My suggestion: X, because Y") — I can accept in two words or disagree.
3. Start broad and narrow down: problem/pain → for whom → what already exists in the market → what the differentiator is → v1 features → what stays OUT of v1.
4. Facts you can discover on your own (the template's stack, what already exists in the code), discover them — don't ask me.
5. Do not move on to UI details before closing the problem and the audience.
6. **Decision log (deterministic)** — follow the cookbook
   `.pi/skills/fia/cookbooks/decision-log.md`: `node imp/scripts/decision-log.mjs open idea --topic "…"`
   before the first question (read `list --json` first — don't re-ask what a
   previous run already decided), `log` EACH answer right after it lands,
   `close` in the wrap-up. Code keeps the record — not your memory.

**Module mode (brownfield)** — the product exists; we are discovering a NEW module:

1. Read first: `ai-docs/PRD.md` (or `PRD-as-built.md`), `map.yaml`, `stack.md`,
   `milestones.md` and the recent decision logs. Open the log as
   `open idea --topic "module: <name>"`.
2. Same interview rules, narrowed to the module: the problem it solves → for
   whom (existing actor or a new one?) → how it plugs into what exists (data it
   touches, screens, permissions) → module v1 features → what stays OUT.
3. Wrap-up (module): **APPEND a `## Module: <name>` chapter** to `ai-docs/PRD.md`
   (vision, users, v1 features, out of scope, data touched, launch criteria for
   the module) — NEVER rewrite the rest of the PRD. Stack: DELTA only — the
   module needs a new layer (queue, payments…)? Follow the stack cookbook just
   for that layer; otherwise confirm the installed stack covers it. Close the
   decision log (`--artifact ai-docs/PRD.md`). Then suggest: `/feature "<module>"`
   to turn the chapter into delta spec(s) + tasks (no `map.yaml` → `/absorb`
   first) and a new milestone in `ai-docs/milestones.md`.

Wrap-up (MANDATORY, greenfield/ideation), once I confirm we've closed the idea:

1. Write the PRD in `ai-docs/PRD.md` — if a template with `{{placeholders}}` already exists, fill in ALL of its fields; otherwise create it with: vision, audience, v1 features, out of scope, initial data model, measurable acceptance criteria. In the data model, tag fields whose valid values are already known to the world with their semantic type (`state: UF`, `country: ISO-3166`, `price: money-cents`, `cep: CEP (address lookup)`) — the UI layer derives selects, masks, and lookups from it, never free-text inputs. Either way the PRD gets a `## Launch criteria` section — "The MVP is ready when…", 3–5 verifiable conditions.
2. **Stack**: read `ai-docs/stack.md`. If there is a "decide later" layer, derive
   the best stack FROM what we are going to build — follow the cookbook
   `.pi/skills/fia/cookbooks/stack.md` (Step 2): one question at a time, always
   with a recommendation in layman's terms, preferring Next.js + Convex + Clerk +
   R2 + Vercel (without Convex → Hono + Neon/Supabase + Drizzle). Record each
   decision in the manifest right away. No pending items? Just confirm that the
   installed stack works for this idea.
3. Close the decision log: `node imp/scripts/decision-log.mjs close <id> --outcome "…" --artifact ai-docs/PRD.md --artifact ai-docs/stack.md`.
4. Show me a summary of the decisions (idea AND stack) and what was left open on purpose.
5. Suggest the next step: `/stack` to generate the documentation for the chosen
   technologies (recommended before implementing), `/grill` to stress-test the PRD,
   or straight to `/map`.
