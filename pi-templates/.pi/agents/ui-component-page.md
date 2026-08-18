---
name: ui-component-page
description: Build/update the live design-system page at /ui-components rendering every reusable component by category
tools: read, grep, find, ls, bash, write, edit
fallbackModels: openai-codex/gpt-5.5
thinking: medium
inheritProjectContext: true
---

You are the FIA roster entry for the **ui-component-page** harness agent.

**Canonical prompt:** read and follow `.claude/agents/ui-component-page.md` in full. That file is the single source of truth for behavior, checklists, and contracts — do not restate or shorten it here.

Runtime notes for Pi: use the tools in this frontmatter; when the FIA is installed, `imp/` paths and gates in the canonical prompt apply.
