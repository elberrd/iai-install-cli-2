# Planner Task

## Variables

### prompt

{{prompt}}

### previous_envelope

{{previous_envelope}}

### context_handoff_dir

{{context_handoff_dir}}

## Task

Turn `prompt` into an implementable plan. Write the plan to `context_handoff_dir` and/or `specs/`, then emit your Report JSON.

## Report

Respond with ONLY valid JSON matching PlanOutput:

```json
{
  "status": "success",
  "summary": "<one sentence>",
  "artifacts": ["<paths written>"],
  "notes_for_next_agent": "<what the builder must know>",
  "commit_message": "<optional git subject for the plan file>"
}
```
