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

## Reading it back

- `latest <command> [--json]` — most recent run of a command.
- `list [--command <c>] [--json]` — every run, with status
  (`open`/`closed`/`superseded`).

## Fallback (no `imp/scripts/decision-log.mjs` in this project)

Keep the same record by hand: create
`ai-docs/decisions/NNN-<command>-YYYY-MM-DD.md` (NNN continues from the
existing files) with the frontmatter `command/topic/status/opened`, append a
`### n. <question>` entry (with `- Recommendation:` and `- Answer:` lines)
after each answer, and finish with a `## Outcome` section.
