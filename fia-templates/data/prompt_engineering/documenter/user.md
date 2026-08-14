# Documenter Task

## Variables

### prompt

{{prompt}}

### previous_envelope

{{previous_envelope}}

### context_handoff_dir

{{context_handoff_dir}}

## Task

Write documentation for the change described in `prompt` and `previous_envelope`.

## Git rules

NEVER run `git commit`, `git add` or `git push` — the FDA commits your
document in its own deterministic phase, using the paths you declare below.
Declare ONLY files this task wrote or documented; files another session left
dirty are not yours.

## Report

Respond with ONLY valid JSON matching DocumentOutput:

```json
{
  "status": "success",
  "summary": "<one sentence>",
  "document_path": "app_docs/change.md",
  "documented_files": ["<files documented>"],
  "commit_message": "docs: <subject>",
  "artifacts": ["app_docs/change.md"]
}
```
