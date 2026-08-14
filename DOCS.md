# IMPACTUS CLI — Full documentation

Reference manual for **CLI v2**: architecture, pipeline, addons, template,
harness, **FIA — the IAI Agent Factory** and how to extend it. Getting started:
[README](./README.md).

> **v2 (`impactus`)** adds the FIA: Pi package (`.pi/`), Node runner
> (`imp/`), deterministic FDAs (`fda_*.mjs`), observability SQLite
> (`imp/data/fia.db`) and subscription-based authentication (Claude CLI + Pi/Codex).

---

## 1. The three pieces

| Piece        | Source              | What it is                                                              |
| ------------ | ------------------- | ----------------------------------------------------------------------- |
| **CLI**      | this repo (`impactus` on npm) | Interactive Node.js installer (ESM + @clack/prompts)      |
| **Harness**  | private repo (community gated API) | Agent-workflow scaffold (/start, /dev, /sv, 9 agents, skills) — **the base, always installed** |
| **Template** | private repo (community gated API) | Next.js 16 + Convex + Clerk + shadcn/Tailwind v4 app, with EVERYTHING implemented — **optional** |

The CLI **does not bundle** the template or the harness: both are downloaded at
install time **exclusively through the community gated API** (paying-student
token) — there is no direct GitHub clone.

**Tenancy**: `--tenancy single` (default) downloads live1; `--tenancy multi`
downloads **live2** — multi-tenant with organizations owned by the
**app itself** (Convex tables; Clerk only authenticates identity): data and
billing per organization, roles (`admin`/`member`) with a per-module permission
matrix, email invites, mandatory onboarding and an `/admin` panel with user and
organization management. The `convex` JWT template is the SAME simple one in
both templates (no org claims) and the webhook subscribes only to `user.*` (and
is optional — `users.ensure` syncs on first login). Both templates ship the
`/admin` panel; in live2 the FIRST user to sign in becomes super-admin, and the
CLI additionally sets `SUPERADMIN_EMAILS` in Convex with the Clerk account
email during installation (extra bootstrap). Spec/roadmap: `live2-spec.md`
in the private `impactus-internal-docs` repo.

### Install modes and stack paths

Right after name/folder, the CLI asks **how to start** (stored in
`ctx.mode` + `ctx.stackPath`, set in `steps/mode.js`):

- **Recommended stack** (`--stack recomendada` / `--mode full`; the `--yes`
  default in a new folder) → `mode=full`, `stackPath=template`: downloads the
  template and runs the full pipeline. The harness still comes in (last).
- **Build my own stack** (`--stack backend=hono,db=neon,…`) → `mode=harness`,
  `stackPath=custom`: the wizard in `steps/stack.js` asks layer by layer
  (catalog in `src/stack-catalog.js`; pure rules in `src/lib/stack.js` —
  Convex ⇒ no API/ORM; Hono ⇒ SQL database + ORM; Automations/Jobs outside
  the app is optional — "none" by default, Modal for external compute).
  Every layer accepts **"decide later"**. If the choices match the recommended stack, the wizard
  offers to switch to the template (still in the prelude, before the pipeline).
- **Not sure yet** (`--stack depois`; `--mode harness` in a new folder) →
  `stackPath=discover`: everything pending — Pi (`/idea`) extracts PRD + stack.
- **Existing project** → `stackPath=brownfield`: `/absorb` fills the manifest
  with the real stack.

On every path, `steps/stack-docs.js` runs after the harness: it writes the
`ai-docs/stack.md` manifest (source of truth), stamps the stack block into
`AGENTS.md` (`<!-- stack-start/end -->` markers) and — outside template mode —
installs official skills, offers CLIs (with login) and registers MCPs for the
chosen techs. The installer works from the static catalog
(`src/stack-catalog.js`) — it is the bootstrap; the first `/stack` pass later
verifies and refreshes that tooling through the research ledger
(`imp/scripts/stack-research.mjs`, see "Stack research"). DEV database
provisioning:

- **Neon** — two routes: instant with NO account (Neon Launchpad,
  `src/lib/neon.js` — `DATABASE_URL` in `.env.local` + claim URL in the
  manifest, expires in ~72h without claim) or in the student's ACCOUNT via CLI
  (`neon auth` + `neon projects create --output json`).
- **Supabase** — guided through the official CLI: `supabase login` →
  `projects create` with a generated password (recorded in `.env.local`); the
  connection string comes from the dashboard (pasted into the installer or later).

The web UI (`--ui`) also knows the paths: the "Harness only" card gains a
"Your stack" section (decide with Pi, or layer-by-layer selects driven by the
catalog) and the generated command comes out with `--stack` (`src/lib/command.js`).

The harness is **always** installed; the mode only decides whether the template comes along.

```
npx impactus
      │
      ├─► name/folder + MODE (harness only  |  harness + template)
      │
      ├─ full mode ──► pick the TEMPLATE (live1 | live2 — TEMPLATES catalog)
      │               ├─► DOWNLOADS the template to a tmp (community gated API)
      │               ├─► pick the stack (addons — groups may come from the
      │               │    downloaded template.addons.json)
      │               ├─► install ──► REMOVES what was not chosen
      │               ├─► Convex + Clerk + webhook + storage + skills/CLIs
      │               └─► GitHub + Vercel (optional)
      │
      └─► harness merge (gated download — always, in both modes)
```

## 2. Philosophy: maximal template, guided removal

Instead of the CLI *generating* code (fragile, hard to test), the template
ships with **all integrations implemented and working together** — and the CLI
**removes what the user did not choose**. Three mechanisms, all described in
the `template.addons.json` manifest (at the template root):

### 2.1 Markers in the code

Snippets belonging to an addon sit between markers:

```ts
// live1:addon:sentry:start
import { withSentryConfig } from "@sentry/nextjs"
// live1:addon:sentry:end
```

Stripper rules (`src/lib/addons.js`):

- Addon **not chosen** → the whole block is deleted.
- Addon **chosen** → the code stays; the marker lines disappear.
- **Inverse block** `live1:addon!:<id>` → only exists when the addon was NOT
  chosen (e.g. the minimal baseline CSP vs. the full CSP of the `csp` addon).
- Works in any text file: `//` (TS/JS), `{/* */}` (JSX), `#`
  (YAML, .env.example). Nested blocks are supported.

### 2.2 Files/dependencies manifest

`template.addons.json` lists, per addon: `files` (deleted), `dependencies`/
`devDependencies` and `scripts` (pruned from package.json). A file listed by
more than one addon (e.g. `app/dashboard/billing`, shared by stripe/
asaas/clerk-billing) is only deleted when **none** of them was chosen.
`virtual` defines derived ids used in markers (e.g. `billing-ui` = turns on
when any payment turns on — controls the "Subscription" item in the sidebar).

### 2.3 Recording the choice

The generated project gets an `imp/iai.config.json` with the chosen addons (older versions kept it at the root), and
the manifest is removed. `npm install` runs only after the pruning (never
downloads what was cut) and `convex dev --once` (the Convex step) regenerates
`convex/_generated` for the reduced set.

### 2.4 Template catalog and the template's addon catalog

`TEMPLATES` (`src/config.js`) is the single source of installable templates
(live1 single-tenant, live2 multi-tenant). Each entry declares `repo`,
`available` (publication gate), `strip`, `tenancy` and `requires` — the
capabilities the pipeline turns on (`convex`, `clerk`, `shadcn`, `storage`,
`mcps`; pure helper in `src/lib/pipeline.js`). The choice comes from
`--template-id` (or the legacy `--tenancy` shortcut, or an interactive
question). There is no direct fork/clone flag: the download is always the
gated one, by the catalog `id`.

Since the download happens BEFORE the addon choice, the downloaded
`template.addons.json` itself may declare the optional
`groups`/`presets` fields (same format as `ADDON_GROUPS`/`ADDON_PRESETS`): in
that case the addons step uses the TEMPLATE'S catalog — a new template exposes
its own groups without requiring a CLI release. Without those fields, the
CLI's built-in catalog applies (current live1/live2 behavior).

To ADD a template: an entry in `TEMPLATES` + repo on the community backend's
allowlist (`cli-paid-gate.md`, private `impactus-internal-docs` repo) +
`TEMPLATE_GITHUB_TOKEN` scope.

### 2.5 Post-install audit (`--verify`)

`npx impactus --verify --dir <folder>` audits an already-installed project
without touching anything (`src/steps/verify.js`): valid package.json,
`imp/iai.config.json` present, leftover manifest, orphaned `live1:addon:*`
markers, base envs in `.env.local` (error) and keys for the chosen addons'
services (warning — everything degrades gracefully),
`node_modules`/`convex/_generated`, and the **agent skills coverage**: every
skill in `skills-lock.json` must exist in `.agents/skills/<name>/` (else Cursor
is blind to it) and, when the project has a `.pi/`, in `.pi/skills/<name>/`
(else the FIA agents are) — warning-level, fixed with
`npx skills experimental_install` (§5.2). Exits with code 1 when there is an
error — usable in the student's CI. With `--json` the human report is replaced
by `{ ok, errors, warnings }` on stdout (same exit code) — for scripts.

### 2.6 Runtime updates (`--update-runtime`)

`npx impactus --update-runtime --dir <folder>` re-stamps the FIA/Pi RUNTIME of
an already-installed project from the impactus version currently running
(`src/steps/update-runtime.js`) — new FDAs, gates and prompts without a
re-install. The contract:

- **Manifest** — `setupFia` records `imp/.runtime-manifest.json`
  (`{ impactus, stamped_at, files: { <relpath>: <sha1> } }`) covering every
  file stamped from both template trees. The shas are the TEMPLATE's: the
  stamp skips pre-existing files, so a file that differs from the template was
  never written by us and stays "modified" (consent + backup before any
  overwrite).
- **Updatable paths only** (`FIA.runtimeUpdatablePaths`): `imp/modules/`,
  `imp/fda_*.mjs`, `imp/scripts/`, `imp/package.json`, `.pi/skills/fia/`,
  `.pi/prompts/`, `.pi/extensions/`. Never touched: `imp/fia.config.yaml`,
  `imp/data/`, `imp/node_modules/`, anything outside the template trees.
  Files the template no longer ships are LEFT in place — additive + replace,
  never delete.
- **Per file**: missing → add; byte-identical → skip; differs with the disk
  sha matching the manifest (unmodified since the stamp) → overwrite; differs
  otherwise (edited locally, or no manifest) → interactive runs ask per file —
  Yes / **Yes to all** / No / **No to all**, the *-to-all answers stick for
  the rest of the run — after one loud warning; non-interactive runs skip and
  report unless `--force` (= yes to everything). Every overwrite is backed up
  to `imp/.runtime-backup-<YYYYMMDD-HHmmss>/<relpath>` first (gitignored).
- **Afterwards**: `npm install` in `imp/` when `imp/package.json` changed, Pi
  packages re-installed (idempotent, degrades with a warning), manifest
  rewritten — overwritten files move to the new baseline while
  skipped-modified ones KEEP the stamp sha, so the next run still flags them.
  Prints an added / updated / skipped-modified / unchanged summary; `--json`
  prints the same as JSON. Exits 1 only on hard failures (e.g. the
  `npm install`).

## 3. Pipeline

The prelude (steps 1–5) always runs; the `[i/n]` counter only knows the exact
total after the mode is resolved (`main.js` builds the list in two phases — the
prelude, then the tail for the chosen mode).

**Prelude (always):**

| #  | Step | File | Notes |
| -- | ----- | ------- | ----- |
| 1  | Access — community student | `steps/auth.js` | Device-flow login; validates the subscription |
| 2  | Claude Code | `steps/preflight.js` | Blocks if missing/logged out |
| 3  | Name and folder | `steps/project.js` | `.` installs in the current folder |
| 4  | **How to start — mode + stack path** | `steps/mode.js` | Sets `ctx.mode` + `ctx.stackPath` |
| 5  | Your stack — layer by layer | `steps/stack.js` | Only the "build my own stack" path asks; may switch `ctx.mode` to `full` |

**`full` mode (harness + template):** each step declares a CAPABILITY
(`core` always runs; `convex`/`clerk`/`shadcn`/`storage`/`mcps` only when the
template declares them in `requires` — see §2.4 and `src/lib/pipeline.js`).

| #  | Step | File | Notes |
| -- | ----- | ------- | ----- |
| 6  | **Decisions — assemble the installation** | `steps/decisions.js` | ALL questions at once (template variant, addons, shadcn, deps, storage, webhook, GitHub, deploy, FIA) + summary/confirm |
| 7  | CLIs (git, gh, vercel) | `steps/preflight.js` | Auto-install; logins only when push/deploy was chosen |
| 8  | FIA — Pi install/update | `steps/preflight.js` | Codex login stays for AFTER the install; a failed Pi install degrades (continues without FIA) |
| 9  | **Template download** | `steps/project.js` | Community gated API (tarball) → tmp; reads the manifest |
| 10 | Install + prune + npm install | `steps/project.js` | Copies from tmp; applies addons BEFORE the install |
| 11 | Update deps (optional) | `steps/deps.js` | none / safe (patch/minor) |
| 12 | MCPs (Playwright, Convex) | `steps/project.js` | `claude mcp add` |
| 13 | shadcn preset + block | `steps/shadcn.js` | Optional |
| 14 | Convex — cloud project | `steps/convex.js` | Login + env; 1st push fails on purpose (issuer missing) |
| 15 | Clerk — app, keys, JWT | `steps/clerk.js` | `convex` JWT template (the SAME simple one in single and multi — no org claims) + issuer in Convex |
| 16 | Convex — publish functions | `steps/convex.js` | Also regenerates `_generated` |
| 17 | Clerk → Convex webhook | `steps/webhook.js` | Optional; subscribes only to `user.*` events (multi included) |
| 18 | Storage — Convex or R2 | `steps/storage.js` | R2 with wrangler assistant (bucket + CORS); consumes keys from `--keys` |
| 19 | **Keys — activate integrations** | `steps/service-keys.js` | See §5.1 — AI prompts, `--keys`, webhooks via API |
| 20 | **Integrations — skills and CLIs** | `steps/integrations.js` | See §5 |
| 21 | Git + GitHub | `steps/github.js` | Private/public repo, push |
| 22 | Vercel deploy | `steps/deploy.js` | Optional (demo with dev creds) |
| 23 | Harness | `steps/harness.js` | Merge without overwriting anything (always) |
| 24 | Stack — manifest and docs | `steps/stack-docs.js` | `ai-docs/stack.md` + stack block in `AGENTS.md` |
| 25 | FIA — Pi + FDAs | `steps/fia.js` | Stamps `imp/` + `.pi/`, npm scripts, SQLite + the runtime manifest (§2.6) |
| 26 | Impeccable — design skill | `steps/impeccable.js` | Optional, default on; requires Node ≥ 22.12 |
| 27 | Final summary | `steps/finish.js` | URLs + integrations report + pending items |

**`harness` mode (harness only):**

| #  | Step | File | Notes |
| -- | ----- | ------- | ----- |
| 6  | CLIs (git, gh) | `steps/preflight.js` | Binaries only — no gh login and no Vercel; with a community token even the gh install is skipped |
| 7  | Harness | `steps/harness.js` | Merge into the folder; runs `git init` if missing |
| 8  | Stack — manifest, docs and tooling | `steps/stack-docs.js` | Manifest + `AGENTS.md` block + skills/CLIs/MCPs of the chosen techs (incl. Neon/Supabase dev DB) |
| 9  | FIA — Pi + FDAs | `steps/fia.js` | Stamps `imp/` + `.pi/` |
| 10 | Impeccable — design skill | `steps/impeccable.js` | Optional, default on |
| 11 | Final summary | `steps/finish.js` | Harness next steps (no `npm run dev`) |

Logs of each run: `~/.create-iai/logs/run-<timestamp>.log`.

## 4. Addon groups

| Group (flag) | Options | Default (`padrao`) |
| ------------ | ------ | ----------------- |
| `--addons` (Quality/DX) | `commitlint`, `knip`, `analyzer` | commitlint, knip, analyzer |
| `--observability` | `sentry`, `logging` | sentry |
| `--analytics` (single) | `none`, `posthog`, `vercel-analytics` | none |
| `--security` | `csp`, `rate-limit` | csp, rate-limit |
| `--emails` (single) | `none`, `resend` | none |
| `--platform` | `notifications` | none |
| `--payments` (single) | `none`, `stripe`, `asaas`, `clerk-billing` | none |

**Presets** (`--preset`): `minimo` (nothing), `padrao` (the recommended set),
`saas` (padrao + logging, posthog, notifications, resend, stripe). `completo`
predates the english-first rename and is a deprecated alias of `saas`
(accepted with a warning; no longer listed in pickers).

**Precedence**: group flag > `--preset` > default. Lists accept `none` and
`all`. Examples:

```bash
npx impactus my-saas --preset saas --payments asaas
npx impactus my-mvp --preset minimo --observability sentry --yes
```

**Always included** (not a choice): TypeScript strict, T3 Env (env vars
validated at build), Vitest + convex-test, Playwright, ESLint + Prettier,
Lefthook, SEO (sitemap/robots/OG), CI, Dependabot, `.vscode`, i18n pt-BR/en,
**Documents** page (upload → Convex Storage or R2, decided at runtime).

## 5. Integrations: official skills and CLIs (step 16)

For each chosen addon with official tooling, the CLI installs the **agent
skills** into the project (via [skills.sh](https://skills.sh), recorded in
`skills-lock.json`) and offers to install/log into the **official CLI**:

| Addon  | Skills (`npx skills add …`)  | Official CLI | Login | Keys/dashboard |
| ------ | ---------------------------- | ----------- | ----- | -------------- |
| stripe | `https://docs.stripe.com`    | `stripe` (brew `stripe/stripe-cli/stripe`) | `stripe login` | https://dashboard.stripe.com/apikeys |
| sentry | `getsentry/sentry-for-ai`    | `sentry-cli` (npm `@sentry/cli`) | `sentry-cli login` | https://sentry.io/settings/auth-tokens/ |
| resend | `resend/resend-skills`       | `resend` (npm `resend-cli`) | `resend login` | https://resend.com/api-keys |
| asaas  | — (no official skills; PROJECT skill in `.claude/skills/asaas`) | — (no CLI; REST API) | — | https://sandbox.asaas.com · https://www.asaas.com |
| r2 (storage) | `cloudflare/skills` (cloudflare + wrangler) | `wrangler` | `wrangler login` | dash.cloudflare.com → R2 |

Everything is best-effort: a network failure on skills never aborts the
installation, and the final summary lists the commands to redo it manually.

### 5.1 Service keys, AI prompts and `--keys` (step 15)

Central catalog: `SERVICES` in `src/config.js` — for each external service
(Clerk, Convex, Stripe, Asaas, Resend, Sentry, PostHog, R2) it declares what
is automatic, the envs (exact name, `convex`/`local` destination, format
regex) and the AI prompt steps. Three consumers:

1. **Web UI (`--ui`)** — "Integrations & keys" section: each service becomes a
   card with its status (✅ automatic at install · optional key), a
   **"Copy AI prompt"** button (to paste into a browser-automation extension,
   e.g. Claude in Chrome — the agent finds/creates the keys in the dashboard
   and returns `KEY=value` lines), a paste box that fills the fields by
   itself, and regex-validated fields. Pasted keys are saved to
   `~/.create-iai/keys/<slug>.env` (permission **600**, machine-local only)
   and the generated command references the path via `--keys` — no secret ever
   appears in the command/history.
2. **Terminal (`steps/service-keys.js`)** — same flow without the UI: shows
   the same AI prompt, accepts pasting the keys (validated), writes each env
   where the template reads it (`npx convex env set` + mirror in `.env.local`,
   or `.env.local` only for the `NEXT_PUBLIC_*` ones).
3. **Webhooks via API** — with the key in hand, the CLI creates the
   **Stripe** webhook (`POST /v1/webhook_endpoints`, `PAYMENT_WEBHOOKS`
   events, captures the `whsec_`) and the **Asaas** one (`POST /v3/webhooks`
   with `authToken` = locally generated `ASAAS_WEBHOOK_TOKEN`) pointing to
   `<deployment>.convex.site/...`. Failed? It prints the manual step.

Security rules: Stripe only accepts a **test** key (`sk_test_…` — the regex
rejects `sk_live_`); everything is optional (without a key the addon degrades
as always); the final summary shows the report (`ctx.serviceReport`) and
offers to delete the keys file that was used.

### 5.2 Agent skills — the skills.sh standard

Every official skill (this step, the storage step and the stack step) goes in
through the same door: `src/lib/skills.js`, which drives the
[skills.sh](https://skills.sh) CLI — the `skills` npm package, the standard the
vendors publish against (Vercel's own `vercel-labs/agent-skills` is the example
in its `--help`). The sources are declared as data: `ADDON_TOOLING[*].skills`
and `OPTIONAL_SKILLS` in `src/config.js`, `skills` per option in
`src/stack-catalog.js`.

On disk, per engine:

| Engine | Path | How it gets there |
| ------ | ---- | ----------------- |
| Cursor | `.agents/skills/<name>/SKILL.md` | the canonical store, read directly ("universal") |
| Claude Code | `.claude/skills/<name>` | symlink to the store |
| Pi (FIA agents) | `.agents/skills/<name>` | native `.agents/` discovery — no copy of its own |

`skillsAddArgs(spec, agents)` builds the argv and `installProjectSkills` runs it
**once**, with `-a claude-code cursor`. Measured against skills@1.5.22
(Aug 2026): `-a claude-code` alone never creates `.agents/skills/` (Cursor gets
nothing), and the comma form `-a a,b` is rejected and installs nothing. The
`-a` stays last in the argv so the variadic cannot swallow the `-y`. A failure
warns without failing the step (as ever, nothing about skills aborts an
install; the manual command is printed).

Pi needs no leg of its own: it scans the project's `.agents/skills/` natively
(behind the same project-trust gate as `.pi/skills/`, in interactive and
headless runs alike), so one canonical copy serves the three engines. Older
CLI versions DID run a second `skills add … -a pi` per source — and since Pi
dedupes discovered skills by realpath, that real copy made every skill load
twice and opened each Pi session with a "Skill conflicts" panel listing all of
them. `prunePiSkillCopies(dir)` cleans those leftovers: lock-driven (so
harness-owned skills like `.pi/skills/fia/` are never touched) and
conservative (a copy is only removed when its `.agents/skills/` canonical
exists). It runs in the FIA step and in `--update-runtime`, which is how
projects stamped by the old flow heal on their next update.

The install is recorded in `skills-lock.json` (v1: `{version, skills: {<name>:
{source, sourceType, skillPath, computedHash}}}`), which the project commits —
`.agents/` and the vendor folders under `.claude/skills/` are gitignored. Hence
the commands worth knowing in the generated project:

```bash
npx skills list                  # what is installed
npx skills find <query>          # search the catalog (--owner <org> to narrow)
npx skills update [name]         # update one skill, or all
npx skills experimental_install  # restore everything from skills-lock.json
```

`npx skills use <pkg>@<skill>` prints a single skill's prompt without
installing anything — handy for a one-off. And `--verify` audits the coverage
(see §2.5).

## 6. What each addon turns on in the template

| Addon | Key files | Envs (where) |
| ----- | -------------- | ----------- |
| commitlint | `commitlint.config.mjs` + commit-msg hook in `lefthook.yml` | — |
| knip | `knip.json`, `check:deps` script | — |
| analyzer | wrapper in `next.config.ts`, `build-stats` script | — |
| sentry | `sentry.*.config.ts`, `instrumentation*.ts`, `app/global-error.tsx` | `NEXT_PUBLIC_SENTRY_DSN` (+ ORG/PROJECT/AUTH_TOKEN for sourcemaps) |
| logging | `lib/logger.ts` (LogTape, JSON in prod) | — |
| posthog | `components/analytics/posthog-provider.tsx` | `NEXT_PUBLIC_POSTHOG_KEY` |
| vercel-analytics | `<Analytics />` in `components/analytics.tsx` | — |
| csp | full CSP in `next.config.ts` (inverse block removes the baseline) | — |
| rate-limit | `convex/lib/rateLimiter.ts` + calls in mutations | — |
| notifications | `convex/notifications.ts`, `convex/lib/notificationKinds.ts` registry, bell in the header; email channel when resend is also present (`signup-hooks` virtual) | — |
| resend | `convex/emails.ts` + single template `convex/lib/emailTemplate.ts` + scheduling in `users.upsertFromClerk` | `RESEND_API_KEY` (Convex) |
| stripe | `convex/stripe.ts`, `convex/subscriptions.ts`, `/stripe-webhook` webhook, billing page | `STRIPE_*` + `SITE_URL` (Convex) |
| asaas | `convex/asaas.ts`, `convex/assinaturasAsaas.ts`, `/asaas-webhook` webhook, billing page, skill | `ASAAS_*` (Convex) |
| clerk-billing | `components/billing/clerk-pricing.tsx` (PricingTable) | plans in the Clerk dashboard |

All degrade gracefully without their key (no-op/warning), so the app runs
immediately after the install and each service is activated whenever you want.

## 7. Documents page (storage)

Always present at `/dashboard/documentos`: multi-file upload with
drag-and-drop and progress, download via signed URL and deletion with
confirmation. The backend decides the destination at **runtime**:

- **Convex File Storage** (default, zero config): `ctx.storage.generateUploadUrl`.
- **Cloudflare R2**: activates when the four envs `R2_ACCOUNT_ID`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` exist in the Convex
  deployment — exactly what the storage step configures (with a wrangler
  assistant for account, bucket and CORS). Uses the official
  `@convex-dev/r2` component; the endpoint is derived from the Account ID.

Validation (MIME allowlist + 25 MB) is server-side in `convex/documentos.ts`;
the browser sends the binary STRAIGHT to storage via signed URL.

## 8. Harness

**The installer's base — always installed**, in both modes. Downloads the
harness through the community gated API (paying-student token — the only path)
and merges **without overwriting anything** — existing files
win, the harness `README.md` becomes `imp/HARNESS.md`, and its `AGENTS.md` is
appended to the project's between the `<!-- harness-start/end -->` markers.
Brings `/grill`, `/start`, `/dev`, `/sv`, `/test-ui`, `/team`, `/absorb`,
`/component`, `/theme`, `/launch`, `/quick`, `/note`, `/spec`, `/example`,
9 specialist agents, skills (TDD + the professional ones: frontend-profissional,
design-system, security, backend-profissional, plus `examples`) and `ai-docs/`
(PRD, maps, task roadmap, specs, milestones, inbox, examples) for Claude Code
and Cursor.

Skills shared with the templates (`HARNESS.templateOwnedPaths` — the four
professional ones, in `.claude/skills` and `.cursor/skills`): the harness is
the SINGLE SOURCE of this material. In `full` mode the harness copy of a path
is discarded only when the installed template actually shipped that path
(the merge runs after the template install, so the destination already
reflects it) — a template that brings its own variant wins in that path
(live2 ships only `security`, its multi-tenant variant), and a template
without the skill inherits the harness version (live1 no longer ships any of
the four; templates without `.cursor/` still get the four skills in Cursor
from the harness). In `harness` mode (no template) everything comes from the
harness. The `asaas` skill belongs to an addon and lives only in the templates.

In `full` mode it runs last (the git repo already exists, created during the
template install); in `harness` mode the folder may have no git — the step
runs `git init` before the best-effort commit. The `--no-harness`/
`--skip-harness` flags only apply in `full` mode (template WITHOUT the
harness); in `harness` mode they are ignored with a warning.

**Seeing what `/map` (or `/start`) created**: with the FIA installed, the
project gets the `npm run plan` script — it opens the "Plan" tab of the local
viewer (`http://127.0.0.1:4600#plan`, 100% offline) with the screens/routes,
the tasks with blockers and criteria, the design system and every file in
`ai-docs/` rendered. `/map` itself opens this page when it finishes. The
folder can be changed with `FIA_AI_DOCS` or `--ai-docs`.

**Choosing each agent's engine — `/agents` and `npm run agents`**: the new
`/agents` command (inside `pi`) and the `npm run agents` script open the FIA
viewer's **"Agents" tab** (`http://127.0.0.1:4600#agents`). There the student
sees the login status of each engine (claude/pi/cursor), changes each FDA
agent's engine, model and reasoning, and edits an optional `fallbacks:` chain.
Save writes `imp/fia.config.yaml` preserving comments (a backup is kept;
saving is locked while an FDA runs).

`imp/fia.config.yaml` now supports per-agent `fallbacks:` — an ordered list
tried at run start when the primary engine is unavailable (binary missing,
provider without login/key). The switch is logged and traced as
`engine_fallback` — never silent, never mid-run.

### 8.1 FDA runtime behavior (failure and recovery)

- **A failed FDA prints the exact resume command** (`node imp/fda_<name>.mjs
  --fda-id <id> --resume`) instead of a raw stack trace; pass `--debug` to see
  the full stack. With `--fda-id … --resume` the original prompt is loaded
  from the session database — no need to retype it.
- **Resume re-runs test/check phases**: deterministic `code` phases (tests,
  gates) are never replayed from a saved result, so fixing the code by hand
  and resuming actually re-tests it. Agent phases that succeeded are still
  reused.
- **Agent phases retry once by default** (`retries: 1`) before failing the run.
- **One FDA at a time per project**: a best-effort `imp/data/.fda.lock`
  (pid + fda_id + runner + started_at) blocks a second concurrent run — the
  permission gates of two parallel runs would revert each other's work.
  Acquisition is atomic and full-content (a complete temp file hard-linked
  into place — a competing reader can never observe a half-written lock), and
  a stale lock is stolen via an exclusive rename, so two runs started in the
  same instant cannot both proceed; a pid that answers EPERM counts as ALIVE
  (it exists under another user), and elapsed time alone never discards a
  lock — only a dead pid does. If a crash leaves a stale lock, deleting the
  file is the recovery.
- **Interactive sessions go read-only while an FDA runs**: the same lock has
  a reader side (`imp/scripts/fda-lock.mjs`, also `npm run fda:status`). A
  Claude session opened in the project during a run gets a READ-ONLY
  notice at session start (SessionStart hook) and a PreToolUse hook blocks
  file edits and write-shaped bash commands (incl. `git commit`/`add`/…)
  aimed inside the repo — an external write mid-run would be attributed to
  the phase agent and rolled back. Interactive Pi gets the same guard via the
  `.pi/extensions/fda-lock.ts` extension, and Cursor via the
  `.cursor/hooks.json` `beforeShellExecution` hook
  (`.cursor/hooks/fda-lock-cursor.mjs` — Cursor has no before-edit hook, so
  shell commands are the guarded surface; stray agent edits are still swept
  by the run's own gate). The FDA's own child agents are exempt (the runner
  exports `FIA_FDA_RUN` into their environment), writes outside the repo stay
  allowed, everything fails open, and the block lifts the moment the run
  ends.
- **Envelopes must declare artifacts**: `artifactsExist`/`filesNonEmpty` gates
  now fail on an empty `artifacts` list — an agent that produced nothing can
  no longer count as a success.
- **FIA commits are scoped**: FDAs commit only the files declared in the
  agent's envelope (never `git add -A`), so rejected builder changes and your
  own uncommitted work stay out of FIA commits.
- **Run baseline (anti-contamination)**: when a run starts, the runtime takes
  a pre-flight photo of the working tree (content fingerprint per dirty path,
  persisted as `imp/data/sessions/<id>/baseline.json`, reloaded verbatim on
  `--resume`). At commit time, a declared path whose content is identical to
  the baseline is dropped: it was already dirty before the run and the run
  never touched it — an over-declaring builder can no longer sweep another
  session's leftovers (the `registry.md`/`stack.md` case) into a FIA commit.
  A pre-dirty file the run DID modify stays in. Declared directories are
  expanded and filtered per file. The trace logs `excluded_pre_existing` and
  `changed_by_run_but_uncommitted` so nothing disappears silently.
- **Foundation commits are widened**: a `Kind: foundation` brief makes the
  commit phase union the envelope-declared paths with everything the run
  itself changed (baseline-diffed) — a scaffold of hundreds of files no
  envelope can enumerate gets committed whole instead of leaking into the
  tree as permanent dirt.
- **Agents never commit**: the builder/documenter task prompts carry explicit
  git rules — no `git commit`/`add`/`push` (committing is the FDA's own code
  phase, after review), and no declaring files the task did not touch. Brief
  hygiene backs it on the orchestrator side: briefs never contain commit
  instructions.
- **Checklist gate (C8)**: a brief's checkboxes (Objectives, Acceptance
  Criteria, Quality Checklist) can no longer be left behind by a "finished"
  run. The builder ticks what it verified (`[x]`, or `[x] … — N/A (<reason>)`
  for inapplicable items); after the suite is green, `checklist_1` re-reads
  the brief FROM DISK (`checkAcceptanceChecklist` in `imp/modules/gates.mjs`;
  the file path survives `--resume` via a session marker), one `fix_checklist`
  builder round repairs a forgotten checklist, and `checklist_2` fails the run
  if any `- [ ]` survives — the gate refuses, it never ticks a box itself.
  The second pass also compares box IDENTITIES against the first
  (`checklistDrift`): rewording, moving or swapping a box for a trivial
  ticked one is refused the same as deleting it — only the tick and the
  `— N/A (<reason>)` annotation are legal edits, and an N/A tick without a
  parenthesized reason fails on its own. In
  `fda_sdlc` this happens BEFORE review, so the reviewer audits the ticks
  against the diff (a false tick is grounds for rejection). Prompts that are
  not brief files, and briefs without checkboxes, skip the gate. The ticked
  brief is committed with the run's own work.
- **UI-conformance gate**: a run that changed frontend component files
  (`.tsx/.jsx/.vue/.svelte` vs the run baseline) gets a dedicated audit
  phase before it may close (`imp/modules/ui-gate.mjs`, wired in `fda_sdlc`
  — before review — `fda_plan_build_test` and `fda_bug`). `ui_scope` (code)
  decides deterministically whether the gate arms: an explicit `Surface:`
  line without `ui` in the brief stands it down (`parseSurfaceLine` in
  `imp/modules/gates.mjs`), otherwise changed frontend files arm it — briefs
  predating the convention included. `ui_check` (reviewer agent,
  ReviewOutput) audits ONLY those files against the interaction-pattern
  rubric — field errors inline with the field (never only a banner/toast),
  success/failure toasts after mutations resolve, create/edit in a `Dialog`,
  `AlertDialog` for destructive actions, no native `alert()`/`confirm()`,
  components from the registry — with `ai-docs/ui/patterns.md` overriding
  the defaults when the project keeps one. Violations get ONE `fix_ui`
  builder round, `ui_verify` re-audits, and the final `ui_gate` (code)
  throws if violations survive — the audit is an agent, the refusal is code.
  The rubric lives in `modules/` (not prompt material), so
  `--update-runtime` delivers it to existing installs; the repair round's
  files are committed with the run's own work.

### 8.2 The durable planning layer — specs, milestones, inbox, /quick, examples

Shared conventions between the harness (Claude Code/Cursor) and Pi, all under
`ai-docs/`:

- **Specs** — `ai-docs/specs/NNNN-<slug>.md` (4-digit, numbering continues).
  Header: `Status: draft | defined | in-progress | done`, created/updated
  dates and the linked task numbers. Sections: Problem & Outcome, Scope
  (In/Out), Actors & Permissions, Requirements (`FR-1`/`NFR-1`, one
  obligation per ID), Scenarios (BDD, `S-1` — with mandatory classes for
  user-facing mutations: success, validation, authorization, cross-tenant
  isolation and idempotency where they apply), Traceability
  (requirement → scenario → test file), an append-only Gate log
  (`Definition Gate` / `Delivery Gate`) and dated Decisions. Lean on purpose:
  "Not applicable — <why>" is a valid section body. Created by `/feature`
  (delta specs replacing the old mini-PRD), `/spec` (short interview, also
  for work not born from the PRD) and the full mapping.
- **Test markers** — a test file proving a spec carries
  `spec:NNNN covers:S-1,S-2,FR-2` (one marker per spec, grep target
  `spec:NNNN`). Tasks/briefs link back with a `Spec: 0003 (S-1, S-4)` line;
  when present, the FDAs run the **spec-coverage gate**
  (`checkSpecCoverage` in `imp/modules/gates.mjs` — `git grep` with a
  recursive fallback): every listed ID must appear in some test's `covers:`
  list, missing ones fail the phase by name. No `Spec:` line → check skipped.
- **RED validity** — `fda_bug.mjs` writes ONLY the failing reproduction test
  first, then a `red_check` phase runs it and `validateRedReason` classifies
  the failure: an assertion/expectation failure is a valid RED; a passing
  test fails the gate as "bug not reproduced"; module-not-found, syntax,
  command/env errors fail it with the classification (unknown → invalid,
  conservative). Only then does the fix build run.
- **Milestones** — `ai-docs/milestones.md`: 3–6 blocks (`Goal`, verifiable
  `Done when:` list, `Tasks:`, `Status: pending | in-progress | done`), the
  first being the MVP, generated by `/map` (Pi) and `/start` (harness) after
  the task breakdown and fed by the PRD's `## Launch criteria` (captured by
  `/idea`/`/grill`). A milestone is done only when its exit conditions are
  verified — never by task count.
- **Inbox** — `ai-docs/inbox.md`:
  `- [ ] YYYY-MM-DD — <one-line idea> (context: …)` appended by `/note` with
  ZERO interview. `/feature`, `/quick` and `/map` check it for related items
  and tick them with a `→ spec 0003` / `→ Q-012` / `→ task 07` annotation.
- **Decision logs** — `ai-docs/decisions/NNN-<command>-<date>.md`: every
  interview command (`/idea`, `/grill`, `/stack`, `/spec`, `/feature`,
  `/theme`, `/design`, `/kit`) records question/recommendation/answer as the interview
  happens, via `imp/scripts/decision-log.mjs` (deterministic: the script owns
  naming, numbering, timestamps and lifecycle — `open` → `log` per answer →
  `close` with outcome + artifacts; a crash loses nothing already answered).
  One file per run = versioning: re-running a command opens the next `NNN`;
  a still-open log of the same command becomes `superseded`, closed ones are
  history. Commands read the recent logs before interviewing and never re-ask
  a decided question. The log preserves the interview; the artifact
  (PRD/spec/manifest) stays the source of truth for WHAT was decided.
- **Stack research** — `ai-docs/research/<tech>.md`: before `/stack` documents
  or equips a technology, it must research FOUR dimensions — docs
  (+ `llms.txt`), agent skills (skills.sh registry), official CLI, official
  MCP — and log each finding with its source via
  `imp/scripts/stack-research.mjs` (`open` → `log` per dimension, `--found` or
  `--none`, always with `--source` → `close`). The `close` is the gate: it
  refuses while any dimension lacks an entry, and only a closed record lets
  the tech be marked documented in the manifest (and equipped). One file per
  tech, script-owned; a re-open discards old findings on purpose (fresh
  evidence — history lives in git). The hardcoded tables (installer catalog,
  `/stack` hint table) are bootstrap hints: research that diverges from them
  wins, and the divergence is reported so the tables get updated.
- **Docs commits** — `imp/scripts/docs-commit.mjs` (alias
  `npm run docs:commit`): pathspec-limited commit for `ai-docs/` artifacts,
  called by the flows that generate durable documents (`/stack`, `/map` and
  `/start`, `/component`, `/design`, `/theme`, decision-log close) right when
  the documents land. Uncommitted docs are a contamination reservoir — the
  next FDA's commit can sweep them into an unrelated change. Guardrails: only
  `ai-docs/` paths are accepted (escapes resolved and refused — code is
  committed by FDAs, never by this script), it refuses while a FIA run is
  active (`imp/data/.fda.lock` with a live pid), and a clean tree exits 0
  with "nothing to commit".
- **Env preflight** — `imp/scripts/env-preflight.mjs` (alias
  `npm run env:check`): derives, from the layers `ai-docs/stack.md` declares,
  the dev keys the scaffold reads at build/boot time (Convex →
  `NEXT_PUBLIC_CONVEX_URL` + `CONVEX_DEPLOYMENT`; Clerk → publishable +
  secret; SQL → `DATABASE_URL`; Supabase → URL + anon key; Better Auth →
  secret) and checks `.env.local`, printing a copy-pastable fix per missing
  key. The task-sequencer runs it BEFORE writing the foundation brief (env
  gate — the twin of the theme gate), so a missing key costs one command, not
  a full scaffold FDA rejected in review because `npm run build` crashed on
  prerender. Two more layers back it up deterministically: foundation briefs
  carry the issue's `Kind: foundation` line, which makes the FDA test phase
  run `npm run build` alongside the suite (in code, before the reviewer), and
  the foundation task's fixed scope demands a hermetic build — `npm run build`
  green with NO `.env.local`, plus a generated `.env.example`. No manifest →
  the preflight passes (it only enforces what the stack declares).
- **Project mode** — `imp/scripts/project-mode.mjs` classifies the project
  deterministically so `/idea` can branch: `greenfield` (no PRD, or a PRD
  template still carrying `{{placeholders}}` — the starter's code never
  counts), `ideation` (a real PRD but nothing built: re-running `/idea`
  means revising the idea) or `brownfield` (`map.yaml`, `todos/task-master.md`
  or `PRD-as-built.md` exist). In brownfield, `/idea` runs in **module mode**:
  deep interview about the new module and an APPENDED `## Module: <name>`
  chapter in the PRD (never rewriting the rest), stack delta only, then
  `/feature` breaks the chapter into delta specs + tasks (`/feature` itself
  triages size and routes module-sized requests up to `/idea`).
- **Guide** — `/guide [goal?]` (Pi): the situational router. Probes the state
  with the same scripts the flows use (`project-mode.mjs`,
  `decision-log.mjs list`, the plan artifacts, `fia-launch-check.mjs` when
  the goal is going live), asks ONE question to confirm the goal, then maps
  goal + state onto the Routing table in `.pi/skills/fia/SKILL.md` (single
  source of truth — the prompt keeps no command list of its own, so a new
  command registered in the table is routable for free) and answers with a
  numbered command sequence: each step, and each skipped rung, carries the
  criterion that decided it. Read-only by design: it opens no decision log
  and never executes the route — at most it offers to start step 1.
- **Quick flow** — `/quick <description>` triages: SIMPLE only when the blast
  radius is ≤ ~3 files with one obvious shape and NO schema/migrations,
  auth/permissions, payments, new dependency, new route/page, new UI
  component or destructive data operation — anything else routes to
  `/feature` or `/bug` with the reason. SIMPLE still enforces the guardrails
  (registry defaults, backend rules, one focal test when testable) and
  appends a `## Q-012` audit entry (files, verification, commit) to
  `ai-docs/todos/quick-log.md`. In Pi it runs `node imp/fda_quick.mjs "…"`
  (build → quality → one fix round → quick-log → commit); quick work never
  touches the task roadmap.
- **Example shelf** — `ai-docs/examples/`: `registry.md` is the index (same
  marker discipline as the component registry — real rows only between
  `<!-- registry:start/end -->`), each entry's detail in
  `<slug>/NOTES.md` with its images in `<slug>/assets/`. Row:
  `| Example | Kind | Tags | Source | What to take | License | Status |`, with
  fixed vocabularies — Kind `repo | code | docs | design`, Status `referenced |
  excerpted | archived`, License an SPDX id (`n/a` for docs/design). Tags are
  the search key (functionality, not technology): the `examples` skill and the
  task briefs match a task's nouns against that column, and NOTES.md carries a
  mandatory, never-empty `## What NOT to take`. Written by `/example` (harness
  and Pi), which reads the source before registering anything and researches
  the license instead of asking. Two rules make it safe: it is a **shelf, not a
  gate** — nothing fails because no example matched, and an empty registry is a
  normal state — and examples teach shape, so the default is to reimplement in
  this project's conventions; `AGPL-3.0`, any `GPL-*` and `unknown` are never
  copied verbatim, and any verbatim copy is called out in the task summary with
  its license. The `0000-*` entry is a format reference and never counts.

Observability follows along: the viewer's **Plan tab** gains Milestones
(progress from task status; declared Status never auto-flipped), Specs (id,
title, status, gate log), an inbox count badge and the **Example library** card
(kind, tags, what to take, source link and a license chip that flags the GPL
family and unstated licenses) — tolerant parsing, a missing file never breaks
the page. `imp/scripts/fia-query.mjs` accepts
`--json` on sessions/phases for scripts, and `npm run launch:check` adds a
read-only **docs sync** warning when schema-ish files (Convex/Drizzle/Prisma
schemas, migrations, package.json deps) changed more recently than
`ai-docs/stack.md`/`ai-docs/specs/`.

### 8.3 The design-system layer — core kit, registry and /kit

The problem this layer kills: components being created **on demand**, by
whichever task first needs one — the app reaches task 5 and grows its first
(hand-rolled) table, task 9 grows a second, different one. Three pieces make
the design system deterministic instead:

- **The registry** (`ai-docs/components/registry.md`) is the source of truth
  the task briefs enforce: every UI need in a brief maps to a registry row,
  creating a component the registry already covers is forbidden (variations
  are props/composition), and the living `/ui-components` page renders
  everything in it. Two components for the same need carry roles — exactly
  one `default`, the rest `alternative`, used only on explicit request.
- **The core kit** (design-system skill, `references/core-kit.md`) is the
  canonical always-needed set — buttons, inputs, MaskedInput, Select,
  Combobox, MultiSelect, the three date components (typed, calendar,
  date+time), menus incl. right-click ContextMenu, dialogs, toast, Skeleton,
  EmptyState — plus the FULL per-component contracts. The DataTable contract
  (TanStack Table as `default`; REUI Data Grid registered `alternative`) is
  the big one: global fuzzy multi-word search, header menu on click AND
  right-click (sort/hide/filter), per-column filters adapted to the column
  type (text/enum-facet/date-range/number-range), active-filter chips +
  clear-all, column visibility, pagination, row selection + bulk-actions
  bar, row-click edit, skeleton/empty/no-results states.
- **Greenfield**: Task 01 is always the fixed Foundation scaffold and Task
  02 the fixed **Core component kit** (`Kind: kit`), blocked by 01 and
  blocking every feature task — sequenced after the `/theme` checkpoint, so
  the demos render with the approved identity. Enforcement is code, not
  prose: `Kind: kit` arms `npm run build` in the FDA test phase
  (`isFoundationBrief` in `imp/modules/gates.mjs`), the issue carries one
  checkbox per component (the checklist gate refuses to close with an open
  box), and the UI gate's rubric fails a run whose list of records bypasses
  the registry's default table.

**Existing code** gets the same layer through `/kit` (the brownfield
counterpart of Task 02): as-built inventory (`installed` rows with real
paths — no `planned` promises invented), the `/ui-components` page, then a
**gap report** against core-kit.md — missing needs, below-contract items
(with file/line evidence), duplicates without roles — an interview where the
engineer approves what improves (recorded in the `kit` decision log;
"nothing approved" is a valid outcome), and finally design-only tasks via a
delta spec: `Kind: kit` build/upgrade tasks with one checkbox per contract
item, expand–contract migrations per screen batch, duplicate removal last.
The command itself changes no component and no screen. `/absorb` recommends
`/kit` whenever the as-built registry comes out empty or duplicated, and
`npm run launch:check` backs it with two warnings: `registry_seeded` (a
BLIND registry — reusable component files in the code, zero registry rows)
and `registry_planned` (a row still `planned` at launch — a promise nobody
built). Both templates ship the layer pre-filled: as-built registry + living
`/ui-components` page committed in their own repos (the harness merge never
overwrites an existing file, so the template's registry wins).

## 9. Flag reference

```
npx impactus [name] [options]

Project
  --name <name>            Name (same as the 1st positional argument)
  --dir <path>             Target folder ("." = current folder)
  --mode <value>           harness (harness only) | full (harness + template)
  --harness-only           Shortcut for --mode harness (does not install the template)
  --stack <value>          recomendada | propria | depois | category=option pairs
                           (e.g. backend=hono,db=neon,orm=drizzle)
  --agent-files <mode>     Folder already has agent files (.claude, CLAUDE.md…):
                           add (default, only what's missing) | replace (backup + replace)
  --template-id <id>       Catalog template: live1 (default) | live2
  --template-ref <branch>  Template branch/tag for the gated download

Stack (whatever is not chosen is REMOVED from the generated code)
  --preset <name>          minimo | padrao | saas (completo = deprecated alias of saas)
  --addons <list>          commitlint,knip,analyzer | none | all
  --observability <list>   sentry,logging | none
  --analytics <value>      none | posthog | vercel-analytics
  --security <list>        csp,rate-limit | none
  --emails <value>         none | resend
  --platform <list>        notifications | none | all
  --payments <value>       none | stripe | asaas | clerk-billing

Customization
  --update-deps <mode>     none | safe (patch/minor — there is no "latest" mode:
                           the template is tested with the pinned versions)
  --shadcn-preset <val>    Preset from ui.shadcn.com/create
  --shadcn-block <blocks>  shadcn blocks (comma-separated) or "none"
  --skip-shadcn            Skips the shadcn step

Services
  --keys <file>            .env file with service keys (generated by the --ui
                           web UI in ~/.create-iai/keys/; machine-local, mode 600)
  --tenancy <value>        single (Live 1, default) | multi (Live 2: your app's
                           own organizations in Convex — per-organization
                           data/billing, roles/permissions, /admin with org
                           management)
  --skip-webhook           No Clerk → Convex webhook
  --storage <value>        convex | r2
  --skip-storage           Stays on Convex Storage without asking
  --repo <name>            GitHub repo name (default: slug)
  --public | --private     Visibility (default: private)
  --push | --no-push       Create remote repo and push (or not)
  --skip-github            Not even a remote commit
  --deploy | --no-deploy   Vercel deploy at the end
  --skip-deploy            Same as --no-deploy
  --no-harness             (full mode only) template WITHOUT the harness
  --skip-harness           Same as --no-harness

FIA and design
  --fia | --no-fia         Install (default) or skip FIA (Pi + FDAs + skill);
  --skip-fia               --skip-fia = --no-fia
  --impeccable             Impeccable design skill (impeccable.style) — free,
                           no API key; default on. Requires Node >= 22.12
  --no-impeccable          Skips Impeccable (--skip-impeccable is the same)

Access (the CLI is exclusive to students with an active subscription)
  --login                  Authenticates this computer (browser) and exits
  --logout                 Removes/revokes the CLI token and exits
  --whoami                 Shows subscription status and exits
  --api <url>              Community API base (dev/testing; or CREATE_IAI_API)

General
  --ui, --web              Opens the local web UI to build the install command
  --terminal, --no-ui      Accepted for compatibility (terminal is the default)
  --port <n>               UI server port (default: 4599)
  --verify                 Audits an ALREADY-installed project (--dir) and exits
  --update-runtime         Re-stamps the FIA/Pi runtime of an installed project
                           (--dir) from this impactus version and exits (§2.6);
                           config/data/local edits preserved, backups always
  --force                  With --update-runtime: overwrite locally modified
                           runtime files too (after the backup)
  --json                   With --verify / --update-runtime: JSON report on stdout
  -y, --yes                No prompts (safe defaults; full mode, addons = padrao preset)
  -v, --version | -h, --help
```

`--yes` semantics: `full` mode, `padrao` addon preset (change with
`--preset`/groups), default shadcn block, no webhook/R2/deploy, **harness
installed**, local commit without a remote repo, no integration-CLI logins.
For harness only without prompts: `--harness-only` (or `--mode harness`).

## 10. How to add a new addon

1. **In the template (`live1`)**: implement the complete feature; wrap
   snippets in shared files with `live1:addon:<id>:start/:end`; add the entry
   to `template.addons.json` (files/deps/scripts); document the envs in
   `.env.example` (inside markers). Run `npm run type-check`,
   `npm run test` and the build with everything on.
2. **In the CLI**: add the option to the right group in `ADDON_GROUPS`
   (`src/config.js`); if there is official tooling, register it in
   `ADDON_TOOLING`; if it needs a post-install instruction, `ADDON_NOTES`.
   Validate the value in `src/lib/args.js` if it belongs to a `single` group.
3. **Test**: `npm test` in the CLI; apply the addon to a copy of the template
   (`node -e "import('./src/steps/addons.js').then(m => m.applyAddons({dir, addons:[...]}))"`)
   and run type-check/test/build there.

## 11. CLI development

```bash
node bin/create-iai.js my-test            # runs the installer locally
npm test                                    # node --test (CLI unit tests)
npm run lint && npm run format
npm run sync:skills                         # regenerate harness/.cursor/skills
```

**Mirror rule (single source of truth):** shared skills are edited ONLY in
`harness/.claude/skills/` — `harness/.cursor/skills/` is GENERATED by
`npm run sync:skills` (Cursor-only skills like `project-workflow` and
`workflow-*` are untouched). `test/consistency.test.js` fails on drift and
`sync:skills:check` reports it without writing. Commands
(`.claude/commands` ↔ `.cursor/commands`) stay manual on purpose: their
diffs are intentional (frontmatter, `.claude→.cursor` paths, Cursor-only
extras like `bugbot`). Cross-runtime knowledge follows the same principle:
one canonical file + pointers (e.g. the semantic-fields catalog in the
design-system skill; `test/semantic-fields.test.js` is the tripwire that no
runtime loses its pointer).

Structure: `bin/` (entrypoint) · `src/main.js` (pipeline) · `src/config.js`
(catalogs: template, harness, addons, tooling, shadcn, MCPs) · `src/lib/`
(args, addons/stripper, ui, proc, env-file, skills, clerk, log, util) ·
`src/steps/` (one file per step). The local checkouts `live1/` and
`harness/` are gitignored — each piece has its own repo.

Publishing to npm: bump `version` in `package.json` + `npm publish` (the
package ships `bin/`, `src/`, `fia-templates/`, `pi-templates/` and
`README.md` — the FIA/Pi templates are stamped into projects by the CLI
itself; only the SaaS template and the harness come from the gated API).
