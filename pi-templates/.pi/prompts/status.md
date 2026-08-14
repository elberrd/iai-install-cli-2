---
description: Project progress — tasks, milestones, specs, inbox, latest runs and viewer
---
Read `.pi/skills/fia/SKILL.md` if you haven't yet in this session.

Show me, short and in tables (a file that doesn't exist → skip its line, don't complain):

1. Tasks: status of each issue in `ai-docs/todos/task-master.md` (pending / in-progress / done / blocked)
2. Milestones: from `ai-docs/milestones.md` — per milestone, done tasks vs total and the declared `Status:` (report it as written, never flip it yourself)
3. Specs: from `ai-docs/specs/*.md` — id, title and `Status:` (draft / defined / in-progress / done). `0000-example.md` is the reference example, never a live spec — leave it out of the list and the counts
4. Inbox: count of unchecked items in `ai-docs/inbox.md` (piling up → suggest /quick or /feature to promote them)
5. Latest runs: `npm run fda:sessions`
6. If any run failed, the phase and the error (`npm run fda:phases -- <fda_id>`)

Remind me that the live graph lives at `npm run fda:viewer` (http://127.0.0.1:4600), that the full plan — screens, tasks, design system — lives at `npm run plan` (the "Plan" tab of the same viewer), and that `npm run tui` shows all of this live in the terminal. Do not execute any task — just report.
