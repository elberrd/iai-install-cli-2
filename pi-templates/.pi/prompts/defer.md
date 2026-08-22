---
description: Postpone a task that cannot proceed right now (missing API keys, a pending decision) — sealed probes quarantined reversibly — or resume one
argument-hint: "[e.g. \"21\", \"resume 21\", or empty to list what is deferred]"
---
Defer or resume a roadmap task for me, through the script — never by hand. $@

1. Run `node imp/scripts/task-defer.mjs list --json` and show the current
   state in one short block: each deferred task (number, title, reason) and
   each quarantined probe. If I gave no arguments and nothing is deferred,
   say so and ask which task I want to postpone.

2. When I name a task to DEFER (any phrasing — "defer 21", "skip the
   benchmark task for now", "I'll add the API keys later"): confirm in ONE
   sentence what will happen (status → deferred, its sealed holdout probes
   renamed `NN-*` → `_NN-*`, content untouched, reversible), and on my yes run:

   `node imp/scripts/task-defer.mjs <n> --yes --reason "<my reason, short>"`

   NEVER `mv` files in `imp/data/holdout/` yourself, never edit the probe,
   and never change `**Status:**` lines by hand for this — the script is the
   only writer, and it refuses while an FDA run is live.

3. When I ask to RESUME ("resume 21", "retomar", "bring it back"), run:

   `node imp/scripts/task-defer.mjs resume <n> --yes`

   Then offer the next step: `/task <n>` runs it now that the blocker is gone
   (the run will ask again for whatever the task needs — keys, budget).

4. Report exactly what the script printed — the quarantined/restored probe
   names and the resume command — and remind me the launch check (`npm run
   launch:check`) will keep warning about every open deferral until it is
   resumed or consciously shipped without.
