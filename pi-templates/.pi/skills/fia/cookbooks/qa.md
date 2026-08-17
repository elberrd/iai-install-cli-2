# Browser QA — `/qa`

Product verification at **milestone**, **spec**, or **task** boundaries.
Per-task FDAs already run `npm run test`, spec coverage, the checklist gate,
and the UI-conformance rubric on changed files. `/qa` adds what those cannot:
**real browser flows**, **responsive viewports**, and a **durable report**.

Unit and integration tests are **not** repeated here.

## When to run

| Situation | Run `/qa`? |
| --- | --- |
| After each `/task` | No — too slow; the task FDA already gated |
| After the last task of a milestone (greenfield `/goal`) | **Suggest** `/qa M1` — do not auto-run |
| After a `/feature` spec batch completes | **Suggest** `/qa NNNN` |
| Standalone brownfield slice | `/qa NN` or `/qa` with a explicit task |
| `/quick` | Never suggest QA |
| Before `/launch` | `launch:check` warns if a `done` milestone lacks a report |

## Scope argument

One of:

- `M1` — milestone exit conditions from `ai-docs/milestones.md` (`Done when:`)
- `NNNN` — spec id; BDD scenarios + linked tasks
- `NN` — single task issue
- *(omit)* — infer the latest milestone/spec whose tasks are all `done` and
  that has no passing report in `ai-docs/qa/`

If inference finds more than one candidate, ask the engineer to pick.

## Command

```bash
node imp/fda_qa.mjs "<scope>" [--video retain-on-failure]
# or
npm run fda:qa -- "<scope>" [--video on]
```

### Video policy

Default: **`retain-on-failure`** (keeps disk use small on green runs).

| Value | Behavior |
| --- | --- |
| `off` | No video files |
| `retain-on-failure` | Video only when a test fails (default) |
| `on` | Keep video for every run (large) |

Project override in `imp/fia.config.yaml`:

```yaml
# qa:
#   video: retain-on-failure
```

## What the FDA does

1. **scope** (code) — resolve milestone/spec/task; skip cleanly when the scope
   is API-only (`Surface: api` with no UI).
2. **preflight** (code) — ensure `@playwright/test`, Chromium, `test:e2e`, and
   `playwright.config.ts` exist (installs into the **project**, never the CLI).
3. **author** (builder agent) — write/update committed tests under `e2e/`.
4. **e2e** (code) — `npm run test:e2e` with mobile/tablet/desktop projects;
   Playwright starts `npm run dev` via `webServer`.
5. **audit** (reviewer agent) — screenshots + logs vs registry, patterns, theme
   tokens, overflow, console errors.
6. **report** (code) — `ai-docs/qa/YYYY-MM-DD-<scope>.md`
7. **gate** (code) — fail the run if e2e or audit failed. **No fix loop** —
   failures go to `/bug` or `/task`.

## Artifacts

| Kind | Location | Committed? |
| --- | --- | --- |
| Report | `ai-docs/qa/*.md` | Yes — agents and launch-check read it |
| Video, traces, HTML report | `imp/data/qa/<fda-id>/` | No — gitignored |

First run on a project adds `e2e/`, `playwright.config.ts`, and
`test:e2e` in the project `package.json`. It does **not** fold e2e into
`npm test` or `fda_quality`.

## Spec Delivery Gate

A green `/qa NNNN` is valid **Delivery Gate** evidence — append to the spec's
`## Gate log` and flip `Status: done` manually when satisfied:

```text
Delivery Gate: passed — YYYY-MM-DD — /qa 0007 green, report ai-docs/qa/…
```

## Milestone honesty

Milestone `Status:` is **declared**, never auto-flipped. After `/qa M1` passes,
the engineer edits `ai-docs/milestones.md` to `Status: done` when the
`Done when:` bullets are truly verified.

## vs `/test-ui` (Harness)

`/test-ui` in Claude Code/Cursor is an interactive MCP walk — great for
exploration and fixes. `/qa` in Pi is the **FDA path** that persists evidence
for milestones, specs, and launch-check.
