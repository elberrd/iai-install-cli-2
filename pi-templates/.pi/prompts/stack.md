---
description: Decide the stack (whatever is missing), generate the docs for each technology and equip the project
argument-hint: "[technology or layer — optional; empty = full pass]"
---
Read `.pi/skills/fia/SKILL.md` and the cookbook `.pi/skills/fia/cookbooks/stack.md`, and follow it to the letter.

Focus (optional): $@

The manifest `ai-docs/stack.md` is the source of truth. In this order:

1. Read the manifest (doesn't exist → create it with everything "decide later") and the PRD, if any.
2. Pending layers: ONE question at a time, always with a recommendation and the
   why in plain terms. Preference: Next.js + Convex + Clerk + R2 + Vercel.
   Without Convex → Hono (API) + Neon/Supabase (database) + Drizzle/Prisma (ORM).
   Automations/jobs OUTSIDE the app are an optional layer — "none" is a valid
   answer; when something heavy runs outside (Modal recommended), it is a
   second deploy target and its `ai-docs/apis/<tech>.md` Production runbook
   becomes mandatory before /launch.
   Record EACH decision in the manifest (and in the AGENTS.md stack block) right away.
   Decision log too (cookbook `.pi/skills/fia/cookbooks/decision-log.md`): `open stack`
   before the first question, `log` each answer as it lands, `close` at the end
   with `--artifact ai-docs/stack.md`.
3. For each decided technology without documentation: MANDATORY research across
   the four dimensions — docs (+ `llms.txt`), skills (registry), CLI, MCP — via
   `imp/scripts/stack-research.mjs`: `open <tech>`, `log` each dimension with
   its source (`--none --source` when the vendor has none), write
   `ai-docs/apis/<tech>.md` (with the **Production** section — it's what
   /launch follows — and the **Tooling** summary), then `close <tech>` — the
   script refuses while a dimension is missing; only a closed record marks the
   doc as generated in the manifest.
4. Equip the project from the closed research (never from memory): the skills,
   CLI (+ login) and MCP found in step 3 — anything with a CLI you run
   yourself; only call me for login/dashboard/claim.

Finish with: what was decided · docs generated · tools installed · what is
still pending · the next step (/map with PRD ready; /idea without a PRD).
