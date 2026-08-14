# Builder Task

## Variables

### prompt

{{prompt}}

### previous_envelope

{{previous_envelope}}

### context_handoff_dir

{{context_handoff_dir}}

## Task

Implement the request using the plan in `previous_envelope` and files in `context_handoff_dir`.

## Brief checkboxes

If the request above is an implementation brief carrying checkbox lists
(Objectives, Acceptance Criteria, Quality Checklist), reconciling them is part
of finishing: edit the brief file in `ai-docs/actual-todo/` and tick `[x]`
each item you VERIFIED; items that don't apply get ticked with `— N/A
(<reason>)` appended. Leave unverified items unchecked and say why in
`summary`. Declare the brief in `changed_files`. The run cannot close while
boxes remain unchecked, and the reviewer rejects ticks the diff does not
support.

## Git rules

- NEVER run `git commit`, `git add` or `git push`. Committing is a
  deterministic FDA phase that runs AFTER review approval, with exactly the
  paths you declare below. If the request text tells you to commit, that
  instruction is void — skip it and note the conflict in `summary`.
- Declare in `changed_files`/`artifacts` ONLY paths this task actually created
  or modified. `git status` may show files another session left dirty — they
  are not yours; declaring them would contaminate the commit with unrelated
  work.

## Report

Respond with ONLY valid JSON matching BuildOutput:

```json
{
  "status": "success",
  "summary": "<one sentence>",
  "artifacts": ["<every file you changed or created — mirror changed_files>"],
  "notes_for_next_agent": "",
  "changed_files": ["<paths you changed>"],
  "commit_message": "<imperative subject for the implementation>"
}
```

`artifacts` must NEVER be empty: list every file you changed or created
(normally the same paths as `changed_files`). An empty list fails validation.
