---
description: Open the Agents tab — see and change which engine/model each FDA agent uses
argument-hint: ""
---
Open the visual agent-roster editor for this project.

1. Run `npm run agents -- --detach` — it starts (or reuses) the FIA viewer and
   opens the browser on the Agents tab. If the script does not exist or fails,
   tell me it can be opened later with `npm run agents` and continue.
2. Say, in these words: "I opened the Agents tab in your browser — it lives at
   http://127.0.0.1:4600#agents (or `npm run agents`). There you can see which
   engine and model each agent uses, check which engines are logged in, and
   change everything; Save writes imp/fia.config.yaml."
3. Remind me of two rules, briefly:
   - Claude inside Pi bills as per-token extra usage — Claude agents should use
     the `claude_code` engine (official `claude` CLI, plan limits).
   - Saving is locked while an FDA is running; changes apply from the next run.

Do NOT edit imp/fia.config.yaml yourself in this conversation — the page (or
the engineer by hand) owns that file.
