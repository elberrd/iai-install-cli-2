# CLAUDE.md — impactus (the IAI installer)

## What this is

`impactus` is the IAI installer CLI, published on npm. Students run
`npx impactus` (or the `imp` brand launcher) to stamp a project with the agent
harness plus the FIA — the IAI Agent Factory: Pi as the interactive agent,
deterministic FDAs (fully-automated dev agents), and subscription-based auth
(Claude only through the official `claude` CLI, Codex through Pi — never API
keys or extra usage).

- `bin/create-iai.js` — the installer entry (`npx impactus`, `imp init`).
- `bin/imp.js` — the `imp` launcher: a thin brand wrapper over the real `pi`
  binary, **not a Pi fork**. `init`/`update`/`tui`/`help` are imp commands;
  everything else passes straight through to `pi` (stdout must stay
  byte-identical for piped runs).
- `src/steps/` — the install pipeline, one step per file (preflight, template,
  clerk, convex, stack, fia, verify, update-runtime, finish…).
- `src/lib/` — shared helpers (proc, ui, skills, pi-auth, args…).
- `fia-templates/` — the `imp/` runtime stamped into projects (FDA scripts,
  sequencers, TUI, gates).
- `pi-templates/` — the project `.pi/` (prompts, the `fia` skill + cookbooks,
  extensions).
- `harness/`, `live1/`, `live2/` — the harness and the two live templates
  (separate repos checked out here; the harness is the single source of truth
  for skills/commands — templates never carry their own copies).
- `test/` — `node:test` suite. `DOCS.md` — the deep documentation. Internal
  planning/design docs live in the private `impactus-internal-docs` repo —
  never add them back here (this repo is public).

## Commands

```bash
npm test          # full suite (node test/run.mjs)
npm run lint      # eslint
npm run sync:skills   # regenerates .cursor/skills mirrors (never edit those by hand)
```

## Hard rules

- Node floor is **>= 22.12** everywhere (repo, templates, generated projects).
- Everything that ships (CLI output, templates, prompts, docs) is **English**.
  Commit messages are Portuguese, matching the history.
- Nothing about optional extras (skills, Impeccable, addons) may ever abort an
  install — degrade with a warning and print the manual command.
- Skills topology: the canonical copy lives in `.agents/skills/<name>/`;
  Claude Code symlinks it, Cursor and Pi read it directly. Never reintroduce
  copies in `.pi/skills/` (Pi dedupes by realpath — a copy means a "Skill
  conflicts" panel at every launch).
- A new student-facing command must be registered everywhere it is listed
  (prompt file, `fia` SKILL.md routing, `finish.js` panels, README, DOCS).
- Run `npm test` and `npm run lint` before committing. Commit/push only when
  the user asks.

## Lessons

`lessons.md` at the repo root (local-only: gitignored, never committed) is
the living log of recurring problems and their fixes. **Check it before debugging a symptom that feels familiar**, and
append a new entry (symptom → cause → fix → guard) whenever a notable bug is
identified and corrected.
