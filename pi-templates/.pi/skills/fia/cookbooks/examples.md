# Examples — the shelf of external references

`ai-docs/examples/registry.md` is the INDEX of external references worth
learning from — repos, code files, docs pages, visual design — curated by the
engineer. Agents consult it BEFORE inventing a shape for a non-trivial feature,
screen or flow. Same marker discipline as the component registry, with one
crucial difference: this is a **shelf, not a mandate** — nothing ever fails
because an example wasn't used. This cookbook backs `/example`.

## Files

```
ai-docs/examples/
  registry.md          # the index (markers + table + rules)
  <slug>/
    NOTES.md           # the detail
    assets/            # images (screenshots, diagrams)
```

The `0000-*` entry is a REFERENCE entry: it shows the format and never counts
as a real example.

## The table (real rows ALWAYS between the `<!-- registry:start/end -->` markers)

```
| Example | Kind | Tags | Source | What to take | License | Status |
|---|---|---|---|---|---|---|
```

- **Example**: the name as a link to its own notes —
  `[<Name>](<slug>/NOTES.md)`. The link is what ties the row to its folder (and
  what the Plan page opens); a bare name only survives while it slugifies back
  to the folder exactly.
- **Kind** (fixed): `repo` · `code` · `docs` · `design`
- **Tags**: lowercase, comma-separated, naming the FUNCTIONALITY (`auth`,
  `billing`, `multi-tenant`, `onboarding`, `data-table`, `realtime`,
  `file-upload`, `dashboard`…). This is the search key — tasks are matched
  against this column.
- **Source**: the URL. The pinned commit lives in NOTES.md, not in the table.
- **What to take**: ONE line, the specific thing worth learning. Never "it's a
  good project".
- **License**: SPDX id (`MIT`, `Apache-2.0`, `AGPL-3.0`, `unknown`; `n/a` for
  docs/design). Load-bearing — see the license rule below.
- **Status**: `referenced` (link only) · `excerpted` (NOTES.md quotes code) ·
  `archived` (kept for history, not for new work).

## NOTES.md — the detail

```markdown
# <Name>

Source: <url> @ <commit-sha-or-version> · License: <SPDX> · Added: YYYY-MM-DD
Kind: <repo|code|docs|design> · Tags: <a, b, c>

## Why this one
<1–3 lines: the specific thing it does better than the obvious approach>

## What to take
- `path/in/that/repo.ts` — <what is interesting there, and why>

## What NOT to take
- <stack mismatch, dated pattern, or anything that would be wrong here>

## References
- <url> — <what it shows>

## Assets
- assets/<file>.png — <what it shows>
```

`## What NOT to take` is MANDATORY and never empty — an example nobody has
bounded is an example that gets copied wholesale.

## /example — register with minimum friction

Input: a URL (repo, file, docs page) or an existing slug, plus what the
engineer liked about it. Flow:

1. **Read before writing** — fetch and read the source. Registering from a URL
   alone is forbidden.
2. **Research, don't interview**: license, default branch, commit sha and stack
   are yours to find out. Ask ONLY what can't be discovered — what specifically
   they liked (when unstated) and the tags — ONE question at a time, with a
   recommendation.
3. **Write + register**: `<slug>/NOTES.md`, then ONE row between the
   `<!-- registry:start/end -->` markers, with `[<Name>](<slug>/NOTES.md)` in
   the Example cell.
4. **Existing example** (new link, new image, new finding): update NOTES.md in
   place; never duplicate the row.
5. **Images**: the engineer drops files into `ai-docs/examples/<slug>/assets/`
   (or passes the paths); each one gets a `## Assets` line with a one-line
   caption. Never invent an image you didn't receive.
6. **Report**: slug, kind, tags, license, the row — and what an upcoming task
   can take from it.

## The license rule (what makes the shelf safe)

Examples teach **shape**, not source to paste.

1. Default action: learn the approach and write our own code, in this project's
   conventions.
2. Verbatim copying is allowed ONLY when the license permits it AND the
   attribution it demands is added. `AGPL-3.0`, `GPL-*` and `unknown` → never
   copy verbatim; read and reimplement.
3. Any verbatim copy is called out in the task summary, with the license.

## How agents use the shelf

1. Before designing a non-trivial feature, screen or flow: match the task's
   nouns against the Tags column, read the matching NOTES.md, and only then
   open the real source.
2. Briefs (task-sequencer) carry a `## Reference examples` section when there
   is a match — slug, what to take, license — cited the same way registry
   components are.
3. Anti-patterns: citing an example you never opened; copying a pattern that
   entry's "What NOT to take" forbids; treating an empty registry as a blocker
   (it's a normal state, and the shelf is never a gate).
