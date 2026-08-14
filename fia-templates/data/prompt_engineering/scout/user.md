# Scout Task

## Variables

### prompt

{{prompt}}

### previous_envelope

{{previous_envelope}}

### context_handoff_dir

{{context_handoff_dir}}

## Task

Investigate what `prompt` asks about. ALWAYS write your findings report to
`{{context_handoff_dir}}/scout_findings.md` and list that exact path in
`artifacts` — a missing or unlisted report fails validation.

## Report

Respond with ONLY valid JSON matching ScoutOutput:

```json
{
  "status": "success",
  "summary": "<one sentence>",
  "findings": [{ "file": "src/example.ts", "note": "<why it matters>" }],
  "artifacts": ["{{context_handoff_dir}}/scout_findings.md"]
}
```
