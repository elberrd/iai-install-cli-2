# Observability

DB: `imp/data/fia.db` (WAL — reads never block writers)

## Visual app (npm run fda:viewer)

```bash
npm run fda:viewer        # opens http://127.0.0.1:4600
```

Full observability app, live-updating every 2s:

- **Sidebar**: every FDA run (filterable) with status, request, tokens, cost
- **Timeline (Gantt)**: one lane per owner, roster colors, dashed = running, red outline = failed
- **Click a bar** → drill-down tabs: Overview (engine/model/tools/writes/context %), Gates (checks + attempts), Output (typed envelope JSON), Prompts (compiled system/user)
- **Event stream**: live tool calls with real durations, gate results, phase/agent lifecycle — filterable by type, click to expand payload
- **Engine switches**: `engine_error`, `engine_fallback`, `engine_relay` and `engine_continuation` mark every engine death, substitution and handover (all ride the `error` filter); `npm run fda:sessions` shows a `relayed` count per run

Tool calls are captured by `imp/modules/stream-events.mjs` from both engines (Pi `tool_execution_*`, Claude `tool_use`/`tool_result`).

## Plan view (npm run plan)

```bash
npm run plan             # opens http://127.0.0.1:4600#plan
npm run plan -- --detach # same, in the background (returns immediately — use in prompts)
```

Third tab of the same viewer: everything `/map` (or `/start`) created under
`ai-docs/` — workflow progress from `map.yaml`, screens/routes with ✅/🔄/⏳
status, tasks with blockers/criteria (flags index × issue status mismatches),
design system + reusable components, and every generated doc rendered in-page.
Read-only and fault-tolerant (missing/odd docs degrade to raw markdown).
Override the folder with `FIA_AI_DOCS` or `--ai-docs`.

## Agents tab (npm run agents)

```bash
npm run agents           # opens http://127.0.0.1:4600#agents (same as /agents in pi)
```

The viewer's "Agents" tab: engine login status (claude/pi/cursor), and a visual
editor for each FDA agent's engine, model and reasoning, plus an optional
`fallbacks:` chain. Save writes `imp/fia.config.yaml` preserving comments (a
backup is kept; saving is locked while an FDA runs). Details: cookbook
`update_roster.md`.

## npm scripts (merged into the project by the installer)

```bash
npm run fda:sessions   # recent FDA sessions
npm run fda:phases     # phases for an fda_id (pass as arg)
npm run fda:tail       # latest events
npm run fda:viewer     # web timeline (Gantt) at http://127.0.0.1:4600
npm run plan           # plan view (screens, tasks, design system) at #plan
npm run agents         # agents tab (engines, models, fallbacks) at #agents
npm run fda:demo       # smoke FDA (scout read-only)
npm run fda:quality    # lint/typecheck/build/test without agents
```

## SQL (run against imp/data/fia.db)

Recent sessions:

```sql
SELECT fda_id, status, substr(request,1,60) AS request, total_tokens, total_cost, started_at
FROM sessions ORDER BY started_at DESC LIMIT 10;
```

Phases for one run:

```sql
SELECT seq, name, kind, owner, status, error
FROM phases WHERE fda_id = ? ORDER BY seq;
```

Latest events:

```sql
SELECT type, name, substr(payload_json,1,120) AS payload
FROM events WHERE fda_id = ? ORDER BY rowid DESC LIMIT 30;
```

Envelopes + gate results:

```sql
SELECT e.agent, e.output_type, e.status, g.gate_name, g.passed
FROM envelopes e
LEFT JOIN gate_results g ON g.envelope_id = e.id
WHERE e.fda_id = ?
ORDER BY e.id, g.id;
```

Agent sessions (Pi / Claude CLI resume ids):

```sql
SELECT agent, coding_agent, session_file, updated_at
FROM agent_sessions WHERE fda_id = ?;
```

Failed runs only:

```sql
SELECT fda_id, request, finished_at
FROM sessions WHERE status = 'fail' ORDER BY finished_at DESC LIMIT 20;
```

Or use the helper: `node imp/scripts/fia-query.mjs sessions`.
