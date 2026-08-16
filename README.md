<p align="center">
  <img src="https://raw.githubusercontent.com/elberrd/impactus-cli/main/assets/impactus-cli-logo.jpeg" alt="IMPACTUS CLI logo" width="140" />
</p>

<h1 align="center">IMPACTUS CLI</h1>

<p align="center">
  The IAI installer — agent harness + FIA, running entirely on the AI subscriptions you already have.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/impactus"><img src="https://img.shields.io/npm/v/impactus?label=npm&color=black" alt="npm version" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22.12-black" alt="Node >= 22.12" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-black" alt="MIT license" /></a>
</p>

> [!WARNING]
> **Alpha software.** IMPACTUS CLI `2.x` is in active development. Commands,
> flags, templates and the stamped runtime change between releases without
> deprecation cycles. Pin a version if you need stability, and expect to run
> `npx impactus --update-runtime` in installed projects often — `imp doctor`
> tells you when an install has fallen behind.

**IMPACTUS CLI** (npm package `impactus`) is the installer of the **IAI
method**. It exists so students and followers of
**[IMPACTUS Academy](https://www.impactus.academy)** can do **assisted vibe
coding** in a simpler and more professional way: you describe the product, the
agents plan, build and test it — and the method keeps everything traceable
(PRD, specs, decision log, quality gates), so what comes out is a real,
maintainable codebase instead of a throwaway prototype.

```bash
npx impactus
```

One command stamps your project with the **agent harness** plus the **FIA**,
running entirely inside the AI subscriptions you already have (Claude Pro/Max
and ChatGPT Plus/Pro) — no API keys, no per-token billing.

## What the names mean

| Name | What it is |
| --- | --- |
| **IAI** | The method taught at IMPACTUS Academy for building production software with AI agents. This CLI is its installer. |
| **FIA** | The **IAI Agent Factory** — the agent runtime stamped into your project (`imp/` + `.pi/`): Pi as the interactive agent, the FDAs as the workforce, plus an observability database, quality gates and dashboards. |
| **FDA** | **Fully-automated Dev Agent** — a deterministic, non-interactive agent run (`imp/fda_*.mjs`) that takes a task end to end: implements, tests, passes the quality gates and commits, with every step recorded. |
| **Pi** | The interactive agent you talk to (the `imp` command opens it): `/idea`, `/map`, `/task`, `/goal`, `/guide`… It plans with you and dispatches the FDAs. |
| **Harness** | The agent-workflow scaffold for Claude Code and Cursor (`/start`, `/dev`, `/sv`, 9 specialist agents, skills and gates) — the base of every install. |
| **imp** | The brand launcher (`npm i -g impactus`) — a thin wrapper over the real `pi` binary, not a fork. |

## Who can use it

Anyone can run the installer — **signing in is optional and asked right at
the start**:

- **Signed in** ([Impactus Academy](https://www.impactus.academy) student with
  an active enrollment): the full installer — the ready-made project templates
  plus the whole automated template pipeline (cloud provisioning, keys,
  webhooks, GitHub, deploy).
- **Without signing in** (guest mode): the CLI still installs the **agent
  harness + the FIA agents**, but nothing from the templates — the CLI shows
  the limitation up front and again in the final summary.

Login uses the OAuth device flow (browser, one time per computer); access is
revalidated on every use. Templates and harness are delivered by the academy's
API — they are **not** in this repository or in the npm package, and the CLI
has no clone path (the harness is served without a token; the templates
require an active enrollment).

```bash
npx impactus --login    # authenticate this computer
npx impactus --whoami   # subscription status
npx impactus --logout   # revoke + remove the local token
```

## Quick start

```bash
npx impactus
```

The wizard asks **everything up front** (sign-in, project folder, how to
start, stack, addons), shows a summary, and only then executes the whole
install at once. After it finishes you work in **two cockpits**:

- **Claude Code / Cursor** — the harness slash commands, for interactive
  building (`/start`, `/dev`, `/sv`, `/test-ui`…).
- **Pi** (the `imp` command opens it) — the FIA: planning interviews
  (`/idea`, `/map`) and the fully-automated runs (`/task`, `/goal`), with
  dashboards via `npm run tui` and `npm run fda:viewer`.

The flow, in short: **describe** the product (PRD) → **plan** (map, screens,
tasks) → **build** (interactively or via FDAs) → **follow along**
(dashboards) → **launch**. Every step below is optional and resumable — and
`/guide` (inside `pi`) always tells you the next best command.

One login is left for the very end: inside `pi`, `/login openai-codex` (for
the Codex roles). Claude runs through the official `claude` CLI you already
use — the CLI never asks for an API key.

### Installer & launcher commands

```bash
npx impactus                   # install (the wizard asks everything up front)
npx impactus --login           # authenticate this computer (browser, one time)
npx impactus --whoami          # subscription status
npx impactus --logout          # revoke + remove the local token
npx impactus --verify --dir .  # audit an installed project (read-only)
npx impactus --update-runtime --dir .  # re-stamp imp/ + .pi/ from a newer CLI

npm i -g impactus              # installs the `imp` launcher:
imp init                       # install into the current folder (same as npx impactus)
imp                            # open Pi here (installs Pi if it's missing)
imp update                     # update impactus + Pi + the pinned Pi extensions
imp tui                        # the project dashboard in the terminal
imp doctor                     # read-only checkup: subscriptions, CLIs, Pi, project
imp fix                        # repair what doctor found (plan + consent; restores missing files only)
imp handoff                    # continue the newest Pi conversation in `claude`
                               # (Codex outage? your work keeps moving)
```

### Inside `pi` (run `imp`) — plan and automate

| Command | What it does |
| --- | --- |
| `/idea [topic]` | Interview from scratch → PRD + the best stack for it. On an existing system it adds a new `## Module:` chapter instead. |
| `/stack [tech?]` | Decides pending stack layers, generates docs for each technology in `ai-docs/apis/`, installs CLIs, MCPs and skills. |
| `/grill [target]` | Stress-tests the PRD one question at a time, recording every decision. |
| `/prd [focus]` | Quick reviewer opinion on the PRD. |
| `/map` | PRD → map + screens + tasks + milestones; opens the plan in the browser when done. |
| `/task [n]` | Runs ONE task end to end via FDA (implements, tests, gates, commits). |
| `/goal` | Runs ALL tasks until done — the fully-automated mode. |
| `/feature "what you want"` | New feature in an existing system: delta interview → delta spec + new tasks. |
| `/bug "the symptom"` | Records the defect, proves a valid failing test first (RED), then fixes it. |
| `/quick "small change"` | Triage: a genuinely small change ships in one sitting; anything bigger routes to `/feature` or `/bug`. |
| `/spec [capability]` | Durable spec — requirements + BDD scenarios + traceability gates. |
| `/onboarding [focus?]` | Existing project, first run: chains `/absorb` → `/stack` → `/kit` in one guided pass — ends ready for `/idea` or `/feature`. |
| `/absorb [focus]` | Existing project → as-built PRD, map, conventions, stack manifest and component registry. |
| `/kit` | Design-system audit of existing code: as-built registry, gap report, design-only tasks. |
| `/component`, `/theme`, `/design`, `/example` | Design system: add a component, change colors/fonts, redesign from references, register an external reference. |
| `/launch` | Go live — public beta and production, with readiness gates. |
| `/agents` | Visual roster editor: engine, model and fallbacks per FDA agent — with automatic mid-run relay when an engine dies. |
| `/status` | Progress + latest runs. |
| `/guide [goal?]` | Lost? Reads the project state, confirms your goal in one question and charts the shortest route. |
| `/note "idea"` | One line into `ai-docs/inbox.md` — zero questions. |
| `/fia` | Factory overview. |

### In Claude Code / Cursor — the harness, interactive building

| Command | What it does |
| --- | --- |
| `/start` | Initializes the project from the PRD: map, screens, tasks and design system. |
| `/dev [task?]` | Executes a dev task test-first (no argument = the next frontier task). |
| `/sv` | Save: build verification + git commit + database backup. |
| `/test-ui [flow?]` | Tests the UI in a real browser, with automated sign-in and issue detection. |
| `/team [task]` | Multi-agent orchestration: parallel specialist agents on one task. |
| `/restore` | Rolls code + database back to a previous save (destructive — confirms first). |
| `/grill`, `/stack`, `/absorb`, `/onboarding`, `/quick`, `/spec`, `/feature`, `/bug`, `/component`, `/theme`, `/design`, `/example`, `/kit`, `/launch`, `/note` | The same planning, spec and design-system commands also live here. |

### Dashboards & utilities (npm scripts stamped into the project)

```bash
npm run tui           # terminal dashboard: tasks, specs, milestones, runs
npm run plan          # web viewer, "Plan" tab — everything /map created
npm run agents        # web viewer, "Agents" tab — engine/model per FDA
npm run fda:viewer    # the full web viewer (observability of every run)
npm run launch:check  # launch readiness: blockers/warnings before going live
npm run env:check     # which keys your declared stack still needs in .env.local
npm run fda:status    # is an FDA running in this repo right now?
npm run docs:commit   # commit ai-docs/ artifacts (docs only)
```

### Something not working? — the maintenance ladder

```bash
imp doctor                             # 1. what is wrong? (read-only, never touches a file)
imp fix                                # 2. put back what is MISSING (shows the plan, asks first)
npx impactus --update-runtime --dir .  # 3. imp/ + .pi/ outdated? re-stamp from a newer CLI
imp update                             # 4. update the CLI itself, Pi and the pinned extensions
```

`imp doctor` checks your subscriptions (Claude/Codex/Cursor), the core CLIs,
Pi and — inside a project — the install itself, and every finding ends in the
command that repairs it. `imp fix` only ever **restores what disappeared**
(deleted harness/runtime/skill files, the `AGENTS.md` block) and never
overwrites a file you changed: those are reported, not touched. Use
`--dry-run` to see the plan, `--yes --commit` to run it unattended with one
git commit per fix.

### Example 1 — from zero, WITHOUT the template (your own stack; works as guest)

```bash
npx impactus              # pick "Build my own stack" (or "I don't know yet")
cd my-app
imp                       # open Pi
/login openai-codex       # one time only
/idea                     # interview → PRD + the best stack (all into ai-docs/)
/stack                    # docs for each tech + CLIs, MCPs and skills
/grill                    # stress-test the PRD before building
/map                      # PRD → screens, tasks, milestones (opens the plan)
/task 1                   # first task via FDA — or /goal to run them all
npm run tui               # follow along in another terminal
```

### Example 2 — from zero, WITH the ready-made template (signed-in students)

```bash
npx impactus              # sign in; pick "Recommended stack (ready-made template)"
# the CLI provisions everything: Convex + Clerk + keys + webhooks (+ GitHub/deploy)
cd my-app
npm run dev:convex        # terminal 1 — backend (watch + codegen)
npm run dev               # terminal 2 — Next.js → http://localhost:3000

# the app already runs — now shape it into YOUR product:
imp                       # open Pi
/grill                    # sharpen the PRD (template features are the baseline)
/map                      # plan screens + tasks on top of the template
/goal                     # let the FDAs build it — or /dev in Claude Code, task by task
```

### Example 3 — an EXISTING web app (brownfield)

```bash
cd my-app
npx impactus --dir .      # detects the existing project → harness + FIA only,
                          # nothing in your code is overwritten
imp
/onboarding               # guided pass: /absorb → /stack → /kit (as-built PRD,
                          # map, stack docs, design-system audit)
/feature "CSV export on the reports page"   # new feature → delta spec + tasks
/bug "login loops after logout"             # defect → proven RED, then the fix
/quick "rename the Save button"             # small change, no ceremony
/task                     # execute — or /goal for everything approved
```

## What you get

One command takes a project from zero to running locally — a SaaS starter
(Next.js + Convex + Clerk, single or multi-tenant) or your own stack — plus
the agent harness (skills, commands, gates) and the FIA runtime:

- **`imp/`** — the FDA runner: deterministic sequencers, quality gates, an
  observability SQLite, the terminal TUI and the web viewer.
- **`.pi/`** — Pi's project config: prompts, the `fia` skill and cookbooks.
- **`ai-docs/`** — the project's living documentation: PRD, stack manifest,
  specs, decisions, design system.

## Requirements

- **Node.js >= 22.12**
- An **active [Impactus Academy](https://www.impactus.academy) enrollment**
  for the templates + automated pipeline (optional: without it the installer
  delivers the harness + agent only)
- Recommended, **not required** (the installer only warns and keeps going):
  **Claude Code** with a Claude **Pro/Max** subscription, and/or — for FIA's
  Codex roles — a **ChatGPT Plus/Pro** subscription (login at the end via
  `/login openai-codex` in Pi). With neither, everything still installs; you
  get the best results with one of these, and other providers/models can be
  added later inside Pi with `/login`.

Everything runs inside these subscriptions — no API keys, no per-token
billing.

## Documentation

[`DOCS.md`](./DOCS.md) is the full documentation: install modes, the
pipeline, addons, the FIA runtime, the planning layer and the complete flag
reference. `npx impactus --help` lists every flag.

## Status & support

IMPACTUS CLI is **alpha** and distributed to enrolled students. Bug reports and
reproductions are welcome in the
[issues](https://github.com/elberrd/impactus-cli/issues); support and
onboarding happen inside the academy community.

## License

[MIT](./LICENSE) — covers this repository: the installer CLI and the runtime
it stamps (`fia-templates/`, `pi-templates/`). The project templates and the
agent harness are proprietary and live in private repositories — they are not
part of this package. The templates are delivered only to enrolled students;
the harness is served by the academy's API to any installer run.
