# IMPACTUS CLI

> [!WARNING]
> **Alpha software.** IMPACTUS CLI `2.x` is in active development. Commands,
> flags, templates and the stamped runtime change between releases without
> deprecation cycles. Pin a version if you need stability, and expect to run
> `npx impactus --update-runtime` in installed projects often.

The IAI method's installer (npm package `impactus`): it stamps a project with the agent harness
plus the **FIA** — the IAI Agent Factory: **Pi** as the interactive agent,
deterministic **FDAs** (fully-automated dev agents) and subscription-based
authentication (Claude through the official `claude` CLI, Codex through Pi —
never API keys, never per-token billing).

```bash
npx impactus
```

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

## What you get

One command takes a project from zero to running locally — a SaaS starter
(Next.js + Convex + Clerk, single or multi-tenant) or your own stack — plus
the agent harness (skills, commands, gates) and the FIA runtime:

- **`imp/`** — the FDA runner: deterministic sequencers, quality gates, an
  observability SQLite, the terminal TUI and the web viewer.
- **`.pi/`** — Pi's project config: prompts, the `fia` skill and cookbooks.
- **`imp`** — the launcher, installed globally with `npm i -g impactus`:

```bash
imp init     # install into the current folder (same as npx impactus)
imp          # start Pi here (installs Pi if it's missing)
imp update   # update impactus + Pi + the pinned Pi extension packages
imp tui      # the project dashboard in the terminal
```

`imp` is a thin brand wrapper, **not a Pi fork** — anything that isn't an imp
command passes straight through to the real `pi` binary.

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
