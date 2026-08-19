# Stack — decide, document, equip

`ai-docs/stack.md` is the SOURCE OF TRUTH for the project's stack: one entry
per layer (frontend, backend & API, database, ORM, auth, files/blob,
automations/jobs, deploy),
the pending items, the dev × production env map, and the per-tech docs in
`ai-docs/apis/<tech>.md`. This cookbook backs `/stack` and the stack
extraction inside `/idea`. You orchestrate and write DOCUMENTATION and
config — never app code. Speak the engineer's language.

## Ground rules

- **One question at a time, always with a recommendation and the why** — in
  the person's terms (speed, cost, simplicity), never jargon. The
  person may not be technical; your job is to make the decision easy.
- **Persist every decision immediately**: update `ai-docs/stack.md` (Summary,
  Pending, Layers, Environments) AND the block between `<!-- stack-start -->`
  / `<!-- stack-end -->` in `AGENTS.md`. A decision that only lives in the
  chat does not exist.
- **Automation rule**: everything that has a CLI, you run yourself (after
  asking for the one-time login). Only the human does: browser logins,
  dashboard-only keys, DNS, claiming a database. Mid-flow, never homework at
  the end. Secrets go in THEIR terminal, never in the chat.
- **Dev × production separated from day 1**: `.env.local` is dev only; every
  production env lives on Vercel (`vercel env add <KEY> production`) or in the
  service (`npx convex env set … --prod`).

## Decision rules (hard)

- **IAI preference** (recommend whenever it fits): Next.js + **Convex**
  (backend + database, NO API layer) + **Clerk** (auth) + **Cloudflare R2**
  (files) + **Vercel** (publishing).
- **The preference is not a mandate.** Vue/Nuxt/Svelte or another frontend is
  selected only from an explicit user request or brownfield evidence, never by
  inference. Preserve the exact choice in the manifest and research it like
  every other technology. A non-Next frontend must use compatible explicit
  per-surface library/custom selections in `/ui-contract`; never normalize it
  to Next or materialize the Next/React `fia-universal` adapter.
- **Convex ⇒ no API layer and no ORM.** It is database + backend + realtime in
  one piece; the frontend connects directly.
- **Backend that is NOT Convex ⇒ three tied choices**: your own API with
  **Hono** (inside Next.js: `app/api/[[...route]]/route.ts` with
  `handle(app)` from `hono/vercel` — a single deploy), a SQL database (**Neon**
  recommended — instant dev DB with no account via `npx neon-new@latest --yes`,
  claim later; or **Supabase**) and an ORM (**Drizzle** recommended; Prisma as
  the alternative). Never leave one of the three pending if the other two were
  decided — ask.
- **Automations / Jobs (outside the app) is an OPTIONAL layer** — "none" is a
  valid, recommended default (in-app scheduling fits Convex scheduled
  functions or Vercel crons). Something genuinely OUTSIDE the app (long jobs,
  heavy/Python processing, GPU) → **Modal** recommended: a SECOND deploy
  target (`modal deploy`, separate from Vercel) whose `ai-docs/apis/modal.md`
  **Production** runbook is mandatory before /launch (the launch checker
  blocks without it). Automation code lives in its own folder (default
  `automations/`).
- **Publishing: Vercel is the only supported path today** (the app; an
  external automations service deploys itself, per its own runbook).

## Step 1 — Read the facts

`ai-docs/stack.md` (missing → create it with every layer "decide later" — the
skeleton is in the harness command `.claude/commands/stack.md`; never invent
a choice), `ai-docs/PRD.md` if present, the inventory of
`ai-docs/apis/*.md`, and `node imp/scripts/stack-research.mjs status` — which
techs already have CLOSED tooling research. A closed record is done; never
re-research it unless the person asks for that tech explicitly.

## Step 2 — Decide pending layers

WHAT the person wants to build (PRD or the conversation) drives WHICH stack
you recommend. Walk the pending items in order (frontend → backend → database
→ ORM → auth → files → automations → publishing), applying the hard rules above. Deviate from
the preference only when the person has a real reason (existing infra, team
preference, cost) — and record the why in the manifest.

## Step 3 — Research each tech, then document it (`ai-docs/apis/<tech>.md`)

For every decided tech without a doc, research is MANDATORY across FOUR
dimensions — **docs, skills, cli, mcp** — with evidence per dimension (what
was found + source). Memory and the hint table in Step 4 are not research.
The ledger is code-verified: `node imp/scripts/stack-research.mjs open <tech>`
before researching, `log <tech> --dim <d> --found "…" --source <url>` right
after EACH dimension (`--none --source <url>` when the vendor has none —
"I didn't check" is not a representable state). The dimensions:

1. **docs** — official docs root + probe `llms.txt`
   (`curl -sI https://<docs-host>/llms.txt`); prefer `llms.txt` as reading
   input when it exists (e.g. `https://neon.com/docs/llms.txt`).
2. **skills** — vendor orgs on the skills registry (fetch
   `https://skills.sh/<org>` — try product AND company names); with a
   candidate repo, `npx skills add <org>/<repo> --list` (never the
   interactive `npx skills find`).
3. **cli** — official CLI in the vendor's docs; npm-distributed → verify with
   `npm view <package> version`. Record install + login commands.
4. **mcp** — official MCP server in the vendor's docs (search
   `"<tech> MCP server"`). Record the exact registration command.

No network? STOP and tell the user — model memory is a hint, never evidence
(AGENTS.md rule 20), and the ledger must not close on unverified dimensions.
Leave the research record open and resume when the network is back; only the
user may explicitly accept an offline draft, and then every dimension is
logged with `--note "unverified (offline) — accepted by the user"` and the
doc opens with a "links to verify" warning. Each doc tailored to THIS
project, with copy-pastable commands, sections:

1. **Role in the project** · 2. **Setup — development** · 3. **Environments —
dev × production** (each env: where it lives in dev vs production and how it is
promoted) · 4. **Commands** · 5. **Production** (the runbook `/launch` executes) ·
6. **Common errors** · 7. **Links** · 8. **Tooling** (the four-dimension
summary from the ledger: result + source per dimension) · 9. **Test users**
(auth-layer techs ONLY: the provider's native test mechanism — e.g. Clerk dev
instances: `+clerk_test` emails + fixed code `424242`, no password; Better
Auth: a dev-only seed script — plus the rule it feeds: the task that wires
auth creates ONE dev test user per profile/role and records them in the
`ai-docs/test-credentials.md` roster, real passwords only as env var names).

The gate: `node imp/scripts/stack-research.mjs close <tech>` — it REFUSES
while any dimension lacks an entry. Only after a successful close, mark the
doc as generated in the manifest's Summary table.

## Step 4 — Equip the project

Offer (confirm once, execute yourself) the official tooling of each newly
decided tech **from its research ledger** (`ai-docs/research/<tech>.md`) —
never from memory. The table below is a bootstrap HINT: when the research
diverges from it, the ledger wins — report the divergence in Step 5 so the
table gets updated. Skills install in **one invocation**. The canonical copy
lands in `.agents/skills/`, Claude receives a compatibility symlink, and Pi
reads `.agents/` directly:

```bash
npx skills add <source> --skill <name> -y -a claude-code cursor
```

Never run a second Pi-specific installation or create a `.pi/skills/` copy: Pi would
discover both realpaths and report a conflict. Never use a comma list
(`-a a,b`) — it is rejected.

| Tech | Skills | CLI | MCP (Claude Code) |
|---|---|---|---|
| Convex | `get-convex/agent-skills` | `npx convex` | `claude mcp add-json convex '{"command":"npx","args":["-y","convex@latest","mcp","start"]}'` |
| Neon | `neondatabase/agent-skills` | `npm i -g neon` → `neon auth` | `claude mcp add --transport http neon https://mcp.neon.tech/mcp` |
| Supabase | `supabase/agent-skills` | `brew install supabase/tap/supabase` → `supabase login` | dashboard → "MCP connection" |
| Drizzle | ships with `drizzle-orm@1.x` | `npx drizzle-kit` | drizzle-kit 1.x docs |
| Hono | none — create a project skill | — | — |
| Clerk | `clerk/skills` | — | `npx @clerk/agent-toolkit -p local-mcp` (asks for secret key) |
| Better Auth | `better-auth/skills` | `npx @better-auth/cli` | — |
| Cloudflare R2 | `cloudflare/skills` | `npm i -g wrangler` → `wrangler login` | — |
| Vercel | — | `npm i -g vercel` → `vercel login` | `claude mcp add --transport http vercel https://mcp.vercel.com` |
| Modal | none — create a project skill | `pip install modal` → `modal setup` | — |

No official skill (per the ledger) → distill the doc you wrote into a
single canonical project skill at `.agents/skills/<tech>/SKILL.md`, then create
`.claude/skills/<tech>` as a directory symlink to
`../../.agents/skills/<tech>`. Never create `.cursor/skills/<tech>` or
`.pi/skills/<tech>` copies.

Before installing or writing that skill, inspect `.agents/skills/<tech>`,
`.claude/skills/<tech>`, `.cursor/skills/<tech>`, and `.pi/skills/<tech>`,
including each symlink target. The only valid steady state is one canonical
directory in `.agents/` plus the exact Claude symlink above. If a legacy path
is a real file/directory, the Claude symlink points elsewhere, or existing
copies differ, preserve every version, report the differences, STOP, and ask
which version is authoritative. Only after that explicit choice may you write
the chosen rules once in `.agents/` and establish the Claude symlink. Never
overwrite, delete, or silently merge a legacy skill.

## Step 5 — Close

Commit the documents this flow produced — uncommitted docs sit in the
working tree and contaminate the next FDA's commit:
`node imp/scripts/docs-commit.mjs --message "docs(stack): <what was decided>"
ai-docs` (the script only accepts `ai-docs/` paths and refuses while an FDA
is active).

Report: decided now · docs generated (paths) · research closed (per tech,
plus any divergence between ledger and hint table) · tooling installed ·
still pending. Next step: complete stack + PRD → `/map`; no PRD →
`/idea`; database with a claim URL pending in the manifest → remind them to
claim it (expires in ~72h); dev keys still missing (`npm run env:check`) →
provision them NOW, mid-flow — CLI-able parts yourself (e.g.
`npm install convex && npx convex dev --once`), dashboard-only keys with the
engineer (Clerk) — the foundation task's env gate refuses to scaffold
without them.
