---
description: Register an external reference (repo, code, docs, design) in the examples shelf — read it, bound it, index it
argument-hint: "[URL or existing slug + what you liked about it]"
---
Read `.pi/skills/fia/SKILL.md` and the cookbook `.pi/skills/fia/cookbooks/examples.md`, and follow it to the letter.

Reference: $@

The index `ai-docs/examples/registry.md` lists every example; the detail lives
in `ai-docs/examples/<slug>/NOTES.md`. In this order:

1. FETCH AND READ the source before writing anything — never register an
   example from the URL alone.
2. License, default branch, commit sha and stack are research, not questions.
   Ask me ONLY what you can't discover: what specifically I liked (if I didn't
   say) and the tags — lowercase keywords naming the FUNCTIONALITY, since
   that's how future tasks will find this entry. ONE question at a time.
3. Write `<slug>/NOTES.md` (Why this one · What to take · **What NOT to take**,
   which is never empty · References · Assets) and register ONE row between the
   `<!-- registry:start/end -->` markers, its Example cell written as the link
   `[<Name>](<slug>/NOTES.md)` — that link is what ties the row to its folder.
4. Already on the shelf? Update its NOTES.md in place — new link, new image,
   new finding — and never duplicate the row.
5. Images: I drop the files into `ai-docs/examples/<slug>/assets/` (or pass you
   the paths); record each one under `## Assets` with a one-line caption. Never
   invent an image you didn't receive.

Examples teach SHAPE, not source to paste: the default is to learn the approach
and write our own code in this project's conventions. `AGPL-3.0`/`GPL-*`/
`unknown` → never copy verbatim. Any verbatim copy gets reported, with its license.

Finish with: slug, kind, tags, license, the registry row — and what an upcoming
task can take from it.
