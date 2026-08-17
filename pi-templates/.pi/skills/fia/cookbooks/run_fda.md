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

## How a run ended, and when it stops itself

Every run closes with ONE named outcome (`goal_met`, `verification_failed`,
`attempt_cap`, `no_progress`, `budget_exhausted`, `breadth_exceeded`,
`blocked_by_gate`, `engine_exhausted`, `aborted`, `failed`) — printed in the end
banner, stored on the session and shown by `npm run fda:sessions`. Report it to
the engineer verbatim; only `goal_met` is success. Full table: cookbook
`observability.md`.

Two of them are the run stopping ITSELF rather than failing, and they are good
news, not a defect:

- `no_progress` — a repair round changed nothing in the tree and the same checks
  kept failing (`stop.no_progress_window`, default 2 rounds). The comparison is
  content-based, so a repair that edited the same file again counts as progress,
  and a round whose repair was REPLAYED on `--resume` never counts at all. The
  run is genuinely stuck; more rounds would only spend the engineer's plan. Tell
  them WHAT kept failing and hand the decision back — do not re-run blindly.
- `attempt_cap` — the loop spent its `stop.attempt_cap` rounds (default 3) with
  the suite still red.

`budget_exhausted` and `breadth_exceeded` are off by default. All four live in
the optional `stop:` block of `imp/fia.config.yaml`; the code defaults apply when
it is absent, so never tell the engineer they must add it.

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

## Bounded continuation — resume the MISSING work, not the whole run

A run that closed `verification_failed` / `attempt_cap` / `no_progress` did real
work; what it lacks is a judgement about what is still owed. Blindly resuming
either repeats accepted work or stops at the same wall. So when the engineer says
what is missing — or when you reviewed the run and can say it yourself — record
it BEFORE resuming:

```bash
node imp/scripts/verdict.mjs set <fda_id> \
  --missing "the empty state is not handled" \
  --missing "no test covers the 403 path" \
  --redo review                      # phases whose saved result must NOT replay
node imp/fda_sdlc.mjs --fda-id <fda_id> --resume
```

The resumed run then drops the saved results of the phases named by `--redo` (so
they execute again), and hands EVERY agent phase the scope in writing with an
instruction not to re-open anything else. Look for `bounded_continuation` in the
trace. The verdict is **one-shot** — consumed by that run, so a later resume is
unrestricted again; record a new one if the work is still not done.

`--redo` names a phase OF THAT RUN, and the vocabulary is not shared: `review`
above is an `fda_sdlc` phase and does not exist in `fda_plan_build_test`, and a
repeated phase is counter-suffixed (`test_1`, `fix_1`). `set` checks each name
against the phases the run saved and refuses an unknown one with the list — so
copy the name from that list, never from this example.

Rules for you: `--missing` items are the GAP in plain English, never a design
(the agent reads the workspace and decides how). Never invent them — either the
engineer said it or you verified it in the code. `verdict show <fda_id>` reads
one back, `verdict clear <fda_id>` drops it, and `set` refuses while that run is
still in progress.
