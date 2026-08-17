---
name: fia
description: FIA — the IAI Agent Factory — install, run and monitor FDAs (deterministic agent flows) in the project. Use when the user says /fia, wants to run an FDA, observe fia.db, or operate the IAI agent factory.
---

# FIA — the IAI Agent Factory

Deterministic Node.js FDAs own sequencing, retries, and acceptance; agents (Claude Code CLI or Pi/Codex) work inside bounded phases; typed JSON envelopes cross seams; SQLite trace at `imp/data/fia.db`.

## Startup

1. Read [cookbooks/fia_overview.md](cookbooks/fia_overview.md)
2. If `imp/` exists, list `imp/fda_*.mjs` and print a table — then wait for the engineer.

## Hard rules

1. Validate config before running (`imp/fia.config.yaml`)
2. Typed envelopes only — parse failures re-prompt the same session
3. Gates verify claims after the fact
4. Known commands are code phases (`fda_quality`, test phases) — not agents
5. You orchestrate — you do not replace an FDA's job

## Routing

Short commands (prompt templates in `.pi/prompts/`) are the student entry points — each one already tells you which cookbook to follow:

| Command | Does | Cookbook |
|---|---|---|
| `/fia` | factory overview | — |
| `/guide [goal?]` | lost? probes the state (project-mode, decision logs, plan, launch gates), confirms the goal in ONE question and charts the shortest command route — suggests, never executes | — |
| `/idea [topic]` | interview from scratch → PRD + stack — or, on an existing system (auto-detected via `project-mode.mjs`), a NEW `## Module:` chapter in the PRD | stack (Step 2), decision-log |
| `/stack [tech?]` | decides pending layers, generates docs in `ai-docs/apis/`, equips the project | stack |
| `/grill [target]` | stress-tests the PRD, records decisions | decision-log |
| `/prd [focus]` | quick reviewer opinion on the PRD | — |
| `/map` | PRD → map.yaml + screens + tasks + milestones | harness_bridge (Step 1) |
| `/task [n]` | runs ONE task via FDA | harness_bridge (Step 2) |
| `/goal` | all tasks until done | harness_bridge (Step 3) |
| `/feature "what you want"` | new feature in an existing system — delta interview → delta spec + new issues | harness_bridge (Step 4) |
| `/bug "the symptom"` | records the defect, `fda_bug` proves a valid RED, then fixes it | harness_bridge (Step 2) |
| `/quick "small change"` | triage — simple stays simple: `fda_quick` + quick-log entry; complex routes to /feature or /bug | harness_bridge (Step 2) |
| `/note "idea"` | one line into `ai-docs/inbox.md` — zero questions | — |
| `/spec [capability or NNNN]` | durable spec — requirements + BDD scenarios + gates | specs |
| `/launch` | go live — public beta and production | launch |
| `/component [name + URL/command]` | add a component to the design system (register + install + page) | components |
| `/theme [hint]` | change colors/fonts/shape — interview → approved preview → apply | theme |
| `/design [images]` | layout redesign from references, inside the design system | design |
| `/example [URL or slug]` | register an external reference (repo, code, docs, design) on the examples shelf | examples |
| `/agents` | visual roster editor — engines, models, fallbacks (viewer "Agents" tab) | update_roster |
| `/onboarding [focus?] [--report-only]` | first command on an existing system — chains /absorb → /stack → /kit in one guided pass (resumable via its decision-log rail; `--report-only` defers the kit decisions), ends ready for /idea or /feature | decision-log |
| `/absorb [focus]` | existing project → as-built PRD + map + conventions + stack manifest + component registry + the maintained `ai-docs/wiki/` (stamped, then checked by `npm run wiki:check`) | — |
| `/kit` | existing code → design-system audit: as-built registry + `/ui-components`, gap report vs the core kit, approved design-only tasks (`Kind: kit`) | components |
| `/status` | progress + latest runs | observability |
| `imp handoff` (terminal, outside Pi) | Codex outage — continue the newest Pi conversation in the `claude` CLI (`--list` picks a session) | update_roster |
| `imp health` (terminal) | five-dimension score of this project's agent work loop, from its own evidence — every finding names the command that repairs it (`--html` writes a report, `--strict` for CI) | observability |
| `imp rewind` (terminal) | undo an FDA run — lists its checkpoints, previews the exact file impact, restores only with `--yes`. Restore-only: never resets, never rewrites history | run_fda |
| `imp notify` (terminal) | show (or `--test`) the run-end ping — webhook/Slack/Discord/Telegram, off until the engineer turns it on | observability |
| `imp settings` (terminal) | where every setting comes from (machine config, project roster, env), read-only and secrets redacted | — |

For anything else, route by request:

| Request | Cookbook |
|---|---|
| Record/reuse interview answers (all interview commands) | [cookbooks/decision-log.md](cookbooks/decision-log.md) |
| Decide stack / document a technology | [cookbooks/stack.md](cookbooks/stack.md) |
| Spec format / test markers / traceability | [cookbooks/specs.md](cookbooks/specs.md) |
| UI components / design system / registry | [cookbooks/components.md](cookbooks/components.md) |
| Change theme / colors / fonts | [cookbooks/theme.md](cookbooks/theme.md) |
| Layout redesign / visual reference / motion | [cookbooks/design.md](cookbooks/design.md) |
| External references / what to take from a repo | [cookbooks/examples.md](cookbooks/examples.md) |
| Install / stamp FIA | [cookbooks/install.md](cookbooks/install.md) |
| Run an FDA | [cookbooks/run_fda.md](cookbooks/run_fda.md) |
| Create a new FDA | [cookbooks/create_fda.md](cookbooks/create_fda.md) |
| Update the roster / agents | [cookbooks/update_roster.md](cookbooks/update_roster.md) |
| Observe trace / how a run ended (terminal outcomes) | [cookbooks/observability.md](cookbooks/observability.md) |
| Resume only the MISSING work after a failed run (verdict) | [cookbooks/run_fda.md](cookbooks/run_fda.md) |
| Keep the repo wiki true / a page went stale | [cookbooks/observability.md](cookbooks/observability.md) |
| Bridge with ai-docs issues | [cookbooks/harness_bridge.md](cookbooks/harness_bridge.md) |
| Go live / deploy / production | [cookbooks/launch.md](cookbooks/launch.md) |
