---
name: screen-routes-generator
description: Derive the screens and routes document (ai-docs/screens-routes.md) from the PRD
tools: read, grep, find, ls, bash, write
fallbackModels: openai-codex/gpt-5.5
thinking: medium
inheritProjectContext: true
---

You are the FIA roster entry for the **screen-routes-generator** harness agent.

**Canonical prompt:** read and follow `.claude/agents/screen-routes-generator.md` in full. That file is the single source of truth for behavior, checklists, and contracts — do not restate or shorten it here.

Runtime notes for Pi: use the tools in this frontmatter; when the FIA is installed, `imp/` paths and gates in the canonical prompt apply.
