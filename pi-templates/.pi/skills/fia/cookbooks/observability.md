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

## How a run ENDED — the terminal outcome

`sessions.status` is still the boolean (`running` | `success` | `fail`), but every
run that closes also records ONE named outcome in `sessions.outcome`, with the
human sentence in `sessions.outcome_reason` and a closing `run_end` event
carrying both. Report the outcome, never just "failed" — the whole point is that
the run says honestly how it ended:

| outcome | what it means |
|---|---|
| `goal_met` | the only success: phases green AND the run's acceptance criterion met |
| `verification_failed` | the work ran but the suite or the reviewer refused it |
| `attempt_cap` | the fix loop spent its `stop.attempt_cap` rounds with the suite still red |
| `no_progress` | a repair round changed nothing and the same checks kept failing — stopped early on purpose, before spending more of the plan |
| `budget_exhausted` | `stop.budget_minutes` was reached |
| `breadth_exceeded` | the run touched more files than `stop.breadth_ceiling` |
| `blocked_by_gate` | a gate or the permission allowlist refused (spec coverage, C8 checklist, UI conformance, a write outside `writes:`) |
| `engine_exhausted` | every engine in the fallback chain died |
| `aborted` | Ctrl+C / SIGTERM — no longer an eternal `running` orphan |
| `failed` | an unclassified throw |

`attempt_cap`, `no_progress`, `budget_exhausted` and `breadth_exceeded` come from
the `stop:` block in `imp/fia.config.yaml` (all optional, code defaults apply).
A run with NO outcome is either still running, or predates the column — say
"unknown", never guess. Do not read `phases.attempt`: it is always 0.

## npm scripts (merged into the project by the installer)

```bash
npm run fda:sessions   # recent FDA sessions (now with the outcome column)
npm run fda:phases     # phases for an fda_id (pass as arg)
npm run fda:tail       # latest events
npm run fda:viewer     # web timeline (Gantt) at http://127.0.0.1:4600
npm run plan           # plan view (screens, tasks, design system) at #plan
npm run agents         # agents tab (engines, models, fallbacks) at #agents
npm run fda:demo       # smoke FDA (scout read-only)
npm run fda:quality    # lint/typecheck/build/test without agents
npm run loop:health    # five-dimension score of the project's agent work loop
npm run fda:rewind     # list a run's checkpoints and undo it (restore-only)
npm run wiki:check     # which ai-docs/wiki/ pages the code has outgrown
npm run security:scan  # L1 security scan (deterministic patterns, zero tokens)
```

`imp health`, `imp rewind`, `imp notify` and `imp settings` are the same
reporters under the brand launcher.

## SQL (run against imp/data/fia.db)

These match the real schema in `imp/modules/tracer.mjs` — check there before
inventing a column.

Recent sessions, with how each one ended:

```sql
SELECT fda_id, status, outcome, outcome_reason, substr(request,1,60) AS request,
       total_tokens, total_cost, started_at
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

Envelopes and gate results (they join on `phase_id`, not on each other):

```sql
SELECT agent, output_type, valid, attempt, created_at
FROM envelopes WHERE fda_id = ? ORDER BY created_at;

SELECT phase_id, gate, passed, attempt, violations_json
FROM gate_results WHERE fda_id = ? ORDER BY id;
```

Agent sessions (Pi session file / Claude CLI resume id):

```sql
SELECT agent, coding_agent, model, session_id, context_tokens, last_used_at
FROM agent_sessions WHERE fda_id = ?;
```

Runs that did not meet their goal, newest first:

```sql
SELECT fda_id, outcome, outcome_reason, substr(request,1,60) AS request, ended_at
FROM sessions
WHERE status = 'fail' OR (outcome IS NOT NULL AND outcome <> 'goal_met')
ORDER BY ended_at DESC LIMIT 20;
```

Which gate refuses most often across the project:

```sql
SELECT gate, COUNT(*) AS failures
FROM gate_results WHERE passed = 0 GROUP BY gate ORDER BY failures DESC;
```

Or use the helper: `node imp/scripts/fia-query.mjs sessions`.
