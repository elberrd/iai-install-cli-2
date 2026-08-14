# Run FDA

Never implement in place of an FDA. Launch and observe.

```bash
node imp/fda_scout.mjs "map auth flow"
node imp/fda_plan.mjs "add /health endpoint"
node imp/fda_plan_build_test.mjs "implement the plan" --fda-id <id from plan run>
node imp/fda_sdlc.mjs "full feature from ai-docs issue"
```

Watch:

```bash
npm run fda:sessions
npm run fda:phases -- <fda_id>
npm run fda:tail -- <fda_id>
```

## Re-running a failed FDA (resume)

When an FDA fails mid-run and the engineer chooses "re-run", NEVER start from
zero — phases that already succeeded are replayed from their saved results:

```bash
node imp/fda_sdlc.mjs "<same prompt>" --fda-id <failed run id> --resume
```

Only the failed phase and everything after it execute again. This is the
default for any re-run; a fresh run (no `--resume`) is only for when the
engineer explicitly wants to redo the whole flow.

When the ENGINE itself died (expired login, plan limit, crash, provider
outage), the resume also continues on that agent's `fallbacks:` chain instead
of retrying the engine that already proved it cannot finish — and the
substitute is handed the interrupted attempt's transcript so it picks up where
the work stopped. Expect `engine_fallback` / `engine_relay` /
`engine_continuation` in the trace; with no viable fallback the resume retries
the original engine out loud (limits reset, outages end).
