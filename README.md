# IMPACTUS CLI

> [!WARNING]
> **Alpha software.** IMPACTUS CLI `2.x` is in active development. Commands,
> flags, templates and the stamped runtime change between releases without
> deprecation cycles. Pin a version if you need stability, and expect to run
> `npx impactus --update-runtime` in installed projects often.

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
install at once. From there:

1. **Describe the product.** Fill in `ai-docs/PRD.md` — or let Pi extract it
   from an interview: run `imp` and type `/idea`. In Claude Code, `/grill`
   sharpens the PRD one question at a time.
2. **Plan.** `/start` (Claude Code/Cursor) or `/map` (Pi) turns the PRD into
   screens, tasks and a design system — everything versioned under `ai-docs/`.
3. **Build.** Interactive: `/dev` (test-first) with `/sv` and `/test-ui`.
   Automated: inside `pi`, `/task` runs ONE task as an FDA and `/goal` runs
   them all — deterministic sequencing, quality gates, commit hygiene.
4. **Follow along.** `npm run tui` (terminal dashboard), `npm run fda:viewer`
   (web viewer), `npm run plan` (the plan `/map` created), `npm run agents`
   (which engine/model each FDA uses).
5. **Lost at any point?** `/guide` (inside `pi`) reads the project state and
   charts the route.

The `imp` launcher (`npm i -g impactus`):

```bash
imp init     # install into the current folder (same as npx impactus)
imp          # start Pi here (installs Pi if it's missing)
imp update   # update impactus + Pi + the pinned Pi extension packages
imp tui      # the project dashboard in the terminal
```

One login is left for the very end: inside `pi`, `/login openai-codex` (for
the Codex roles). Claude runs through the official `claude` CLI you already
use — the CLI never asks for an API key.

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
- **Claude Code** installed and logged in with a Claude **Pro/Max**
  subscription
- For FIA's Codex roles: a **ChatGPT Plus/Pro** subscription (login at the
  end via `/login openai-codex` in Pi)

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
