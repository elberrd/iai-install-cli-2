# Launch — from "runs on my machine" to LIVE

`/goal` ends with the app RUNNING locally. This cookbook is the next (and
last) rung: a public URL, then real production. You orchestrate; the student
decides; FDAs fix code; deterministic scripts state the facts.

## Ground rules

- **This flow PUBLISHES.** Before every outward or hard-to-reverse step
  (creating a repo, deploying, changing DNS, switching to live keys) state
  what is about to happen and get an explicit "yes".
- **The stack manifest drives the recipe**: read `ai-docs/stack.md` FIRST.
  A layer still "decide later" is a HARD BLOCKER — resolve with `/stack`
  before launching. For each chosen tech, the **Production** section of
  `ai-docs/apis/<tech>.md` is the runbook for Steps 3–4 (generate missing
  docs with `/stack` before deploying).
- **Everything with a CLI, you run yourself** (after asking for the one-time
  login: `vercel login`, `neon auth`, `supabase login`, `wrangler login`…).
  The human only does what truly needs them: browser logins, dashboard-only
  keys, DNS at the registrar, claiming a database.
- **Facts come from the checker, not from memory**:
  `node imp/scripts/fia-launch-check.mjs --json` (human view:
  `npm run launch:check`). Never re-derive what it already measured.
- **Code fixes go through FDAs** (`fda_sdlc` with a brief, or `fda_prompt`
  for tiny ones). You never edit the app yourself.
- **Human-only dashboard steps happen MID-flow**: give the exact link and the
  exact thing to click/copy, wait for confirmation, continue. No homework
  lists at the end (same philosophy as harness_bridge Step 4).
- **Secrets stay out of the chat**: when a step needs a secret value
  (deploy key, sk_live, webhook secret), hand the student the exact command
  to run in THEIR terminal (`vercel env add …`, `npx convex env set …`) and
  ask them to paste the value there — never into the conversation.
- **Record everything in `ai-docs/launch.md`** (create it on the first run):
  rung, decisions, URLs, keys' *locations* (never values), checklist state,
  dates. Re-runs read it and resume instead of starting over.

## The rungs

| Rung | Frontend | Backend/database | Auth | Good for |
| --- | --- | --- | --- | --- |
| **local** | localhost | dev | dev | building |
| **beta** | `…vercel.app` | **production** | dev keys (banner, user cap) | showing real users today |
| **production** | own domain | production | production instance / live keys | charging money, real launch |

The backend/database goes to REAL production already at the beta rung — a
Convex production deployment (or a production Neon branch / Supabase project)
starts empty and free (a clean launch; do NOT seed prod with dev fixtures,
and NEVER point production at the dev DATABASE_URL). The only thing gating
"production" is a custom domain, because auth production instances (e.g.
Clerk's) require one.

## Step 0 — Read the facts

Run the checker, show a short summary (rung + blockers + warns). Every
**blocker** must be resolved before publishing: fix code via FDA, fix git via
commands, fix leaked env keys IMMEDIATELY (untrack + ROTATE the exposed key —
a secret that ever hit git history is burned).

## Step 1 — Gate: ready (work, git, CI)

1. `node imp/fda_quality.mjs "launch gate"` must exit 0.
2. Dirty tree → conventional commit. No remote → offer
   `gh repo create <slug> --private --source . --push` (confirm name and
   visibility first — creating a public repo exposes the code).
3. Push, then CI: `gh run watch` until green. **Never publish on a red CI** —
   dispatch an FDA to fix instead.

## Step 2 — Gate: safe (the go-live checklist)

The deterministic part came from the checker. The judgment items you ask ONE
at a time, always with a recommendation, and record in `ai-docs/launch.md`:

1. **Data ownership** (live1-style projects): if the security skill still says
   the decision is OPEN, STOP — recommend per-user `ownerId` scoping and
   dispatch the FDA (recipe: `security/references/multi-tenancy.md`). Shipping
   "every user sees everything" by accident is the #1 vibe-coding incident.
2. **Auth hardening** (per the manifest's provider). Clerk (dashboard — give
   the path): password policy + leaked-password protection ON; MFA/2FA
   available to users; attack protection / bot detection ON (this covers
   rate-limiting sign-in and forgot-password). Better Auth: rate limiting
   enabled, secure cookies, and a NEW production `BETTER_AUTH_SECRET` (never
   the dev one).
3. **Billing idempotency** (only when payments exist): the webhook handler
   must be safe to receive the same event twice (dedupe by event id) and a
   full test-mode purchase was done end-to-end.
4. **Backup drill**: at least one database export exists (in Claude Code,
   `/sv` runs the save/backup workflow; from Pi, run the export command from
   the database's `ai-docs/apis/<tech>.md` — e.g. `npx convex export`) AND one
   restore was rehearsed into a scratch/dev deployment (never prod). A backup that was
   never restored is a hope, not a backup.
5. **Error monitoring**: Sentry DSN configured for prod and
   `SENTRY_AUTH_TOKEN` present at build (readable stack traces). After
   deploying you will fire a test error and confirm it arrives readable.

The complete standard lives in the project's security skill
(`references/checklist.md`) — walk it top to bottom; unchecked items are
release blockers until justified.

## Step 3 — Rung BETA (public URL today)

Execute the **Production** section of each chosen tech's `ai-docs/apis/<tech>.md`
in this order: database → backend/API → auth → files → automations → deploy.
The recipe below is the RECOMMENDED stack (Convex + Clerk); the SQL variant
follows it.

1. **Convex production deploy key**: Convex dashboard → project →
   **Production** deployment → Settings → Generate deploy key. Student runs:
   `vercel link --yes --project <slug>` then
   `vercel env add CONVEX_DEPLOY_KEY production` (pastes the key there).
2. **Runtime envs on Vercel** (production): every var the app reads in the
   browser/server — `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`,
   the Clerk routing vars — copied from `.env.local`
   (`vercel env add <KEY> production`). Do NOT copy
   `NEXT_PUBLIC_CONVEX_URL`: the build injects the production URL itself.
3. **Envs on the Convex PROD deployment**: compare `npx convex env list`
   (dev) with `npx convex env list --prod`; set what's missing —
   `npx convex env set CLERK_JWT_ISSUER_DOMAIN <issuer> --prod` (the dev
   issuer, while Clerk is still dev), plus addon keys (Resend, Stripe test…).
4. **Webhook** (when the project uses it): Clerk dashboard → Webhooks → add
   endpoint `https://<prod-deployment>.convex.site/clerk-users-webhook` →
   copy signing secret → `npx convex env set CLERK_WEBHOOK_SECRET … --prod`.
5. **Deploy**: confirm, then `vercel deploy --prod --yes`. The template's
   `vercel.json` build (`npx convex deploy --cmd 'npm run build'`) pushes the
   functions to production and builds against the prod URL in one shot.
6. **Smoke on the real URL**: HTTP 200 on `/`, open `/sign-in`, create an
   account, run one core flow, fire the Sentry test error and confirm it
   shows a readable stack. Record the URL + date in `ai-docs/launch.md`.

**SQL stack (Hono + Neon/Supabase + Drizzle) — the same rung, different
moves:**

1. **Production database, separate from dev**: Neon → claim the dev DB if the
   manifest still shows a claim URL, then create the PRODUCTION branch/project
   (`neon` CLI or console). Supabase → `supabase projects create` for
   production. Never reuse the dev `DATABASE_URL`.
2. `vercel link --yes --project <slug>` →
   `vercel env add DATABASE_URL production` (the student pastes the PRODUCTION
   connection string in their terminal) + the auth envs (Clerk dev keys for
   beta, or a NEW production `BETTER_AUTH_SECRET` + `BETTER_AUTH_URL`).
3. **Migrations on production**: `npx drizzle-kit migrate` (direct, non-pooled
   connection) or `npx prisma migrate deploy`.
4. **Files (R2)**: bucket CORS must include the vercel.app URL.
5. **Deploy**: `vercel deploy --prod --yes` — the Hono API ships inside the
   Next.js app (route handler), one deploy.
6. Same smoke + record in `ai-docs/launch.md`.

**Automations layer (when the manifest declares one, e.g. Modal) — both
stacks:** the jobs deploy SEPARATELY from the app. Execute the **Production**
section of its `ai-docs/apis/<tech>.md` (Modal: typically
`modal deploy automations/`, secrets via `modal secret create` — never in
git) right before the app deploy, then smoke ONE job run and confirm it in
the service's dashboard. The checker has a blocker (`automations_runbook`)
when that runbook is missing — never improvise around it; have `/stack`
generate the doc first.

Auth dev keys work on the vercel.app URL with a "development" banner and a
user cap (Clerk) — fine for a beta; say so honestly and point at the next rung.

## Step 4 — Rung PRODUCTION (own domain, live keys)

Prerequisite: a domain the student owns (registro.br / Cloudflare, ~R$40/year).
Without one, stop here — beta is a respectable place to live for a while.
(SQL stacks: the moves are each tech's **Production** section — typically:
auth live keys/callback URLs on the real domain, production `BETTER_AUTH_URL`,
R2 CORS with the domain, and the same payments flow below.)

1. **Domain on Vercel**: project → Domains → add; apply the DNS records shown;
   wait until it turns green.
2. **Clerk production instance**: Clerk dashboard → Create production instance
   (it clones the dev config). Add the DNS records Clerk asks for. VERIFY the
   `convex` JWT template exists in the production instance (recreate with the
   same claims if not — login breaks without it). Copy `pk_live_` /
   `sk_live_`.
3. **Swap keys**: replace the two Clerk vars on Vercel (production) with the
   live keys; `npx convex env set CLERK_JWT_ISSUER_DOMAIN <prod-issuer> --prod`
   (now `clerk.<domain>`); recreate the webhook in the PRODUCTION Clerk
   instance pointing at the same convex.site URL → new secret →
   `npx convex env set CLERK_WEBHOOK_SECRET … --prod`.
4. **Payments live mode** (when applicable): activate the Stripe/Asaas
   account, live keys into the Convex prod deployment, a NEW live-mode
   webhook + secret, and confirm idempotency once more. Never reuse test
   endpoints/keys in live mode.
5. **Deploy again** (`vercel deploy --prod --yes`) and run the full smoke on
   the real domain: signup, core flow, and — if charging — one real payment
   (refund it, or use a 100% coupon).
6. **Post-launch routine** (write it into `ai-docs/launch.md`): a database
   backup whenever real data grows (in Claude Code, `/sv`; from Pi, the export
   command from `ai-docs/apis/<tech>.md`), `npm run launch:check` after big
   changes, a weekly look at Sentry.

## Failure etiquette

A failed deploy or a red smoke check is evidence, not shame: show the exact
error, dispatch the fix as an FDA when it's code, re-run only the step that
failed. Never leave the student on a broken rung without saying exactly where
they are and what the next single action is.
