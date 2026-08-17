# Decision log — every interview answer becomes an official, versioned record

Interview commands (`/idea`, `/grill`, `/stack`, `/spec`, `/feature`, `/theme`,
`/design`, `/kit`) ask ONE question at a time — and each answer is a product decision.
Without a record, those answers die with the chat session: a crash before the
wrap-up loses everything, and the next command re-asks what was already decided.

The record is deterministic — **code owns naming, numbering, timestamps, format
and lifecycle** (`imp/scripts/decision-log.mjs`); you only call it at the right
moments. Files live in `ai-docs/decisions/` as `NNN-<command>-YYYY-MM-DD.md`,
one file per run. Running the same command again creates a NEW file — earlier
runs stay as history (versioning by sequence + date; a still-open log of the
same command is marked `superseded` automatically).

## The protocol (MANDATORY in every interview command)

1. **Before the first question** — check what is already decided, then open:

   ```
   node imp/scripts/decision-log.mjs list --json
   node imp/scripts/decision-log.mjs open <command> --topic "<one-line topic>"
   ```

   Read recent related logs (same command, or `/idea`/`/grill` logs touching
   this topic) BEFORE interviewing: **never re-ask a decided question — confirm
   it in passing instead** ("last time you decided X — still true?").
   `open` prints the file path; use it (or its `NNN` id) in the calls below.

2. **After EACH answered question** — immediately, never batched at the end:

   ```
   node imp/scripts/decision-log.mjs log <id> --q "<question>" --rec "<your recommendation>" --a "<the user's answer>"
   ```

   Record the user's real answer (short is fine — "yes", "option B"). A
   decision that surfaced outside the Q&A rhythm:
   `… note <id> --text "<decision>"`.

   **Always carry a recommendation, and always offer to accept it.** Every
   question names the recommended option first and marks it `(Recommended)`, and
   the user may answer "accept" / "recommended" / "go with yours" — or, at the
   top of the interview, "accept all recommended" to take every default and skip
   straight to the artifact. An accepted recommendation is recorded with
   `--accepted` instead of echoing the text back into `--a`:

   ```
   node imp/scripts/decision-log.mjs log <id> --q "<question>" --rec "<your recommendation>" --accepted
   ```

   That writes `- Answer: <recommendation> (accepted)`, so a later reader can
   tell a deliberate choice from a default that was waved through. `--accepted`
   requires `--rec` and refuses a simultaneous `--a`. Never use it for a
   question the user actually answered, and never invent an acceptance — offer,
   then wait.

3. **At the wrap-up** — after writing the artifacts (PRD, spec, manifest…):

   ```
   node imp/scripts/decision-log.mjs close <id> --outcome "<one line>" --artifact ai-docs/PRD.md --artifact ai-docs/stack.md
   ```

   Then make the record durable — the log and the artifacts it names are
   documents, and uncommitted documents contaminate the next FDA's commit:

   ```
   node imp/scripts/docs-commit.mjs --message "docs(<command>): <one-line outcome>" ai-docs
   ```

   (The script only accepts `ai-docs/` paths and refuses while an FDA is
   active — in that case commit right after the run finishes.)

The log NEVER replaces the artifact — the PRD/spec/manifest remains the source
of truth for WHAT was decided; the log preserves the interview itself (question,
recommendation, answer) for audit and reuse.

`/onboarding` uses the same script as a **resume rail** rather than an
interview log: `open onboarding` when the tour starts, one `note <id> --text
"stage <name>: done|skipped|report-only (…)"` after each stage, `close` at the
wrap-up. `latest onboarding --json` is how an interrupted tour finds where it
stopped — an `open` log means resume from its last stage note; never `open`
again mid-tour (that would supersede the trail).

## Reading it back

- `latest <command> [--json]` — most recent run of a command.
- `list [--command <c>] [--json]` — every run, with status
  (`open`/`closed`/`superseded`).

## Fallback (no `imp/scripts/decision-log.mjs` in this project)

Keep the same record by hand: create
`ai-docs/decisions/NNN-<command>-YYYY-MM-DD.md` (NNN continues from the
existing files) with the frontmatter `command/topic/status/opened`, append a
`### n. <question>` entry (with `- Recommendation:` and `- Answer:` lines)
after each answer — writing `- Answer: <recommendation> (accepted)` when the
user took the recommendation — and finish with a `## Outcome` section.
