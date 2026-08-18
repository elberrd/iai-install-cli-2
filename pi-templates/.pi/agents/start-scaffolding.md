---
name: start-scaffolding
description: Create the empty folder/file skeleton of the app from ai-docs/map.yaml — every file is a one-line TODO, no implementation
tools: read, grep, find, ls, bash, write
fallbackModels: openai-codex/gpt-5.5
thinking: medium
inheritProjectContext: true
---

You are the FIA roster entry for the **start-scaffolding** harness agent.

**Canonical prompt:** read and follow `.claude/agents/start-scaffolding.md` in full. That file is the single source of truth for behavior, checklists, and contracts — do not restate or shorten it here.

Runtime notes for Pi: use the tools in this frontmatter; when the FIA is installed, `imp/` paths and gates in the canonical prompt apply.
