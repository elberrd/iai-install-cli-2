# FIA Overview

FIA = the IAI Agent Factory. FDA = deterministic agent flow (one deterministic workflow script).

## Layout

```
imp/
├── fia.config.yaml       agent roster (planner, builder, scout, reviewer, documenter)
├── fda_*.mjs             workflows (prompt, scout, plan, build, plan_build_test, sdlc, quality, document, bug, quick)
├── modules/              runner, gates, tracer, agent-pi, agent-claude
└── data/
    ├── prompt_engineering/{agent}/system.md + user.md
    ├── sessions/{fda_id}/
    └── fia.db            SQLite trace (WAL)
```

## Auth

- **planner / reviewer**: `coding_agent: claude_code` → official `claude -p` (subscription Pro/Max, plan limits)
- **builder / scout / documenter**: `coding_agent: pi` → `/login openai-codex` (ChatGPT plan)

## Run

```bash
node imp/fda_plan_build_test.mjs "implement feature X"
npm run fda:sessions   # after stamp adds scripts to package.json
```
