---
description: Put the app live — from localhost to a public URL and real production (guided)
argument-hint: "[beta | production — optional; with no argument I detect the rung]"
---
Read `.pi/skills/fia/SKILL.md` and the cookbook `.pi/skills/fia/cookbooks/launch.md`, and follow it to the letter.

Also read `ai-docs/stack.md` — the production steps depend on the stack, and each
technology's recipe lives in the **Production** section of `ai-docs/apis/<tech>.md`.
A "decide later" layer in the manifest = blocker: resolve it with `/stack` first.

Engineer's request/limit: $@

This command PUBLISHES. Before any irreversible or public step (creating a
repository, deploy, DNS, live key), say what will happen and wait for my "yes".

1. `node imp/scripts/fia-launch-check.mjs --json` → show me the current rung
   (local / beta / production) and a short summary: blockers ✗, production
   requirements ▲ (gate only the production rung), warnings !, ok ✓.
   If `qa_evidence` warns, suggest `/qa <milestone>` before treating milestones
   as truly done.
2. Blockers first (Step 0–1 of the cookbook): quality via
   `node imp/fda_quality.mjs`, git/push/CI green. Code fixes = FDA,
   never you.
3. Security gate (Step 2): the judgment items ONE question at a time,
   always with a recommendation — data ownership, hardening of the manifest's
   auth provider (Clerk: password/2FA/protection; Better Auth: rate limit +
   production secret), billing idempotency, backup restore rehearsal, Sentry.
4. Climb one rung at a time (Step 3 = beta on Vercel, Step 4 = production with
   a domain) — secrets always in MY terminal, never in the chat. At the end of
   each rung: smoke test on the real URL and a record in `ai-docs/launch.md`.
   The ordinary Impactus deploy is Preview-only. Production must fail closed
   unless Clerk uses a matching `pk_live_`/`sk_live_` pair, Convex is the
   Production deployment, `CLERK_WEBHOOK_SIGNING_SECRET` is configured, and
   the final own domain is active. Never promote `pk_test_`/`sk_test_`.

ALWAYS finish with the **How to test** section (public URL, what to check in
3–6 items) + the next rung, if any. If I'm already in production, run the
report and propose only what is red.
