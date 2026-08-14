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
