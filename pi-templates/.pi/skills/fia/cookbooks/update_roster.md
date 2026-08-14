# Update the roster

The roster lives in `imp/fia.config.yaml` (FDAs) and `.pi/agents/*.md` (interactive pi-subagents). Keep the two aligned: same names, same `writes`, same purpose.

## The visual way — /agents (recommended)

`/agents` (inside `pi`) or `npm run agents` opens the FIA viewer's "Agents" tab
(http://127.0.0.1:4600#agents). There the student sees the engine login status
(claude/pi/cursor), changes each FDA agent's engine, model and reasoning, and
edits an optional `fallbacks:` chain — no YAML by hand. Save writes
`imp/fia.config.yaml` preserving comments (a backup is kept; saving is locked
while an FDA runs). Recommend it first; the manual edit below covers the same
ground and the fields' meaning.

## Engines — every agent picks its own engine + model

FDAs never name models — they name agents. The engine/model pair lives ONLY in `imp/fia.config.yaml`:

| `coding_agent` | Runs on | Login/keys | `model` format |
|---|---|---|---|
| `claude_code` | official `claude` CLI | `claude` once (Pro/Max plan limits) | alias `sonnet`/`opus`/`haiku`/`fable` or full name; `effort: low\|medium\|high\|xhigh\|max\|ultracode` |
| `pi` | Pi headless | subscriptions: `pi` → `/login openai-codex` or `github-copilot`; API keys via env | `provider/model-id`; `thinking: minimal\|low\|medium\|high` (Codex reasoning effort) |
| `cursor` | Cursor Agent CLI | `cursor-agent login` (Cursor subscription) | id from `cursor-agent --list-models`; effort variants live in the id (e.g. `sonnet-4.5-thinking`) |

Pi API-key providers (any of them, per agent): `openrouter/…` (OPENROUTER_API_KEY — one key, every model), `xai/…` (XAI_API_KEY — Grok), `groq/…`, `google/…` (GEMINI_API_KEY), `fireworks/…`, `deepseek/…`, `mistral/…` and more (see Pi providers doc). List models inside `pi` with `/model`.

Rule of thumb: heavy reasoning (planner, reviewer) on a frontier model; volume work (builder, scout, documenter) on a fast/cheap one — different providers in the SAME run is the point.

WARNING: Claude INSIDE Pi bills as per-token "extra usage" — to spend plan limits, always use `coding_agent: claude_code`.

## Fallbacks — per-agent `fallbacks:` chain

Each agent may declare an ordered `fallbacks:` list (engine/model entries, same
fields as the primary). It is tried at RUN START only, when the primary engine
is unavailable — binary missing, or provider without login/key. The switch is
logged and traced as `engine_fallback` — never silent, and never mid-run: a run
that started on an engine finishes on it. Edit the chain visually in `/agents`
or by hand in `imp/fia.config.yaml`.

## Add or change an agent (FDAs)

1. Edit `imp/fia.config.yaml` — the file is protected for agents; the ENGINEER edits it (or uses `/agents`):
   - `coding_agent: claude_code | pi | cursor` (table above)
   - `model`, `thinking` (`low|medium|high`)
   - `fallbacks:` — optional ordered chain (section above)
   - `writes:` allowlist — `[]` = read-only; omitted = anything except `protected_files`
   - `prompt_engineering.system/user` — paths under `imp/data/prompt_engineering/<name>/`
2. Create `system.md` (role + Report JSON contract matching the zod schema) and `user.md` (placeholders `{{prompt}}`, `{{previous_envelope}}`, `{{context_handoff_dir}}`). Copy an existing agent's pair as base.
3. Validate: any FDA run calls `validate(cfg, [...])` and fails fast on missing prompts or bad `coding_agent`. A missing API key does NOT fail at startup — it fails when that agent runs (or triggers the agent's `fallbacks:` chain, when one is declared).

## Mirror in interactive Pi (optional)

Add `.pi/agents/<name>.md` with pi-subagents frontmatter so the orchestrator can delegate ad hoc. Interactive subagents run as Pi children — use Codex/Copilot/API-key models there; route Claude work through FDAs (it bills on the plan only via the official CLI).

## Never

- Don't point two engines at the same credential store, and don't import tokens from `~/.claude` / `~/.codex` — rotating refresh tokens invalidate each other. Each engine logs in through its own product.
