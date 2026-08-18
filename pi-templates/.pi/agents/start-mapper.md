---
name: start-mapper
description: Analyze the whole codebase and generate ai-docs/map.yaml from the ai-docs/start/map-start.yaml schema (harness /start step)
tools: read, grep, find, ls, bash, write
fallbackModels: openai-codex/gpt-5.5
thinking: medium
inheritProjectContext: true
---

You are the FIA roster entry for the **start-mapper** harness agent.

**Canonical prompt:** read and follow `.claude/agents/start-mapper.md` in full. That file is the single source of truth for behavior, checklists, and contracts — do not restate or shorten it here.

Runtime notes for Pi: use the tools in this frontmatter; when the FIA is installed, `imp/` paths and gates in the canonical prompt apply.
