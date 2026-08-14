# Create a new FDA

An FDA is one deterministic Node script: phases own sequencing, agents work inside bounded phases, gates verify claims. Copy the closest starter and adapt.

## Steps

1. Pick a starter to copy (never edit the starters in place):
   - single agent → `imp/fda_prompt.mjs`
   - read-only recon → `imp/fda_scout.mjs`
   - multi-phase pipeline → `imp/fda_plan_build_test.mjs` or `imp/fda_sdlc.mjs`
2. `cp imp/fda_plan.mjs imp/fda_<name>.mjs` and edit:
   - `validate(cfg, [...])` — declare every agent the FDA uses
   - phases via `run.runPhase(phaseParams(name, kind, owner, description), fn)`
     - `kind: 'engineer'` — capture the ask (`ph.log({ input })`)
     - `kind: 'agent'` — `ph.call({ outputType, prompt, previous, gates })`
     - `kind: 'code'` — deterministic commands (quality, git)
   - end with `process.exit(run.finish({ accepted, reason }))` — success only if the goal was conquered, not merely "phases ran"
3. Choose the envelope: `GenericOutput`, `PlanOutput`, `BuildOutput`, `ScoutOutput`, `ReviewOutput`, `DocumentOutput`, `VerifyOutput` (see `imp/modules/envelopes.mjs`). New shape → new zod schema there + update the agent's `system.md` Report contract to match.
4. Pick gates from `imp/modules/gates.mjs`: `artifactsExist`, `filesNonEmpty`, `diffMatchesClaims`, `verdictConsistent`. Violations are sent back to the same session as a correction.
5. Smoke it: `node imp/fda_<name>.mjs "test request"` then `npm run fda:phases -- <fda_id>`.

## Rules

- Known commands (lint, test, build, git) are `code` phases — never delegated to an agent.
- `imp/modules/`, `imp/fia.config.yaml` and the starter `fda_*.mjs` are protected paths.
- Prompts live in `imp/data/prompt_engineering/{agent}/` with `{{prompt}}`, `{{previous_envelope}}`, `{{context_handoff_dir}}` placeholders.
