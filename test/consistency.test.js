// Parity guards that keep docs, commands, prompts and config from drifting
// apart again (the english-first rename left dangling /comando references
// once — these tests make that class of desync a test failure):
//   (a) every slash-command cited in the workflow docs exists as a command
//       file (harness/.claude/commands/ or pi-templates/.pi/prompts/);
//   (b) every skill shipped for Claude also ships for Cursor, byte-identical;
//   (c) no pre-rename Portuguese command name survives anywhere;
//   (d) every agent prompt declared in fia.config.yaml exists on disk;
//   (e) each harness agent's frontmatter `name:` matches its filename.
//
// harness/ is a NESTED git repo (not tracked by this one), so a fresh CI
// checkout may not have it — harness-dependent tests skip loudly in that case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HARNESS = join(ROOT, 'harness');
const hasHarness = existsSync(join(HARNESS, '.claude', 'commands'));

// ── shared helpers ───────────────────────────────────────────────────────────

function walk(dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry);
    const s = statSync(p, { throwIfNoEntry: false });
    if (!s) continue; // dangling symlink
    if (s.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function mdFilesUnder(dir) {
  return existsSync(dir) ? walk(dir).filter((f) => f.endsWith('.md')) : [];
}

// Old PT command names retired by the english-first rename. They are the only
// names excused on the left side of a mapping arrow ("`/tema` → `/theme`"),
// and check (c) forbids them anywhere else.
const RENAMED_OLD_NAMES = new Set(['tarefa', 'mapear', 'ideia', 'absorver', 'componente', 'lancar', 'tema']);

/**
 * Slash-command candidates in a text. Deliberately strict about context so
 * `node:fs/promises`, `ai-docs/stack.md`, `https://x.com/y`, `</div>` and
 * `app/api/[[...route]]/route.ts` do NOT match:
 *   - not preceded by a word char, dot, colon, slash, hyphen or `<`
 *   - not followed by `.something` (file extensions) or more path segments
 */
function slashCommandsIn(text) {
  const out = [];
  for (const m of text.matchAll(/(?<![\w.:/<-])\/([a-z][a-z0-9-]{1,})(?![\w/-])(?!\.\w)/g)) {
    // "`/absorver` → `/absorb`" rows document the PT→EN rename on purpose —
    // but only the RETIRED names get that pass; a live command on the left of
    // a flow arrow ("/grill → /map") is still a reference to verify.
    if (RENAMED_OLD_NAMES.has(m[1]) && /^`?\s*(?:→|->)/.test(text.slice(m.index + m[0].length))) continue;
    out.push(m[1]);
  }
  return out;
}

// ── (a) every cited slash-command exists as a command/prompt file ────────────

// Built-in commands of the engines themselves (claude/pi/cursor CLIs) — real
// commands, just not files this repo ships.
const BUILTIN_COMMANDS = new Set(['help', 'login', 'logout', 'clear', 'config', 'model', 'compact', 'init', 'resume']);

// Tokens the strict regex still catches that are NOT slash-commands, reviewed
// one by one (mostly `X`/word constructs and app routes cited in the docs).
const NOT_COMMANDS = new Set([
  'aleatoriedade', // backend skill: "`Date.now()`/aleatoriedade proibidos"
  'cmdk', //          design-system skill: "(`Popover` + `Command`/cmdk)"
  'columns', //       design-system skill: "Table + columns" pattern prose
  'attachment', //    design.md: "image path(s)/attachment(s)"
  'auth', //          launch.md: "`BETTER_AUTH_URL`/auth callback URLs"
  'route', //         stack.md: Hono catch-all route example
  'dashboard', //     security skill: the `/dashboard(.*)` protected route
  'admin', //         README: the /admin app route (multi-tenant template)
  'group', //         README: "--preset`/group flags"
  'impeccable', //    /impeccable * commands come from the Impeccable plugin
  'ui-components', // the design-system registry PAGE (app route), not a command
  'date', //          frontend skill: "shadcn `Calendar`/date picker"
  'command', //       README troubleshooting: "A `/command` doesn't exist" placeholder
  'run', //           APPEND_SYSTEM: pi-subagents extension command ("/run scout …")
  'skill', //         APPEND_SYSTEM: Pi's skill invocation syntax ("/skill:fia")
  'sign-in', //       launch cookbook: app route smoke-tested after deploy
  'health', //        run_fda cookbook: example API endpoint in a task title
]);

test('slash-commands cited in workflow docs all exist as files', { skip: !hasHarness && 'harness/ not present (nested repo, absent on fresh checkout)' }, () => {
  // Scope: files that TALK ABOUT the workflow. harness/ai-docs and agent
  // definitions are excluded on purpose — they are full of HTML closing tags
  // and app-route examples that are not commands.
  const sources = [
    ...mdFilesUnder(join(HARNESS, '.claude', 'commands')),
    ...mdFilesUnder(join(HARNESS, '.cursor', 'commands')),
    ...mdFilesUnder(join(HARNESS, '.agents', 'commands')),
    ...mdFilesUnder(join(HARNESS, '.claude', 'skills')),
    ...mdFilesUnder(join(HARNESS, '.cursor', 'skills')),
    ...mdFilesUnder(join(HARNESS, '.agents', 'skills')),
    ...mdFilesUnder(join(HARNESS, 'docs')),
    ...mdFilesUnder(join(ROOT, 'pi-templates', '.pi')),
    join(HARNESS, 'AGENTS.md'),
    join(HARNESS, 'README.md'),
    join(ROOT, 'src', 'steps', 'finish.js'),
    join(ROOT, 'src', 'steps', 'fia.js'),
    join(ROOT, 'README.md'),
  ].filter((f) => existsSync(f));

  const known = new Set([
    ...readdirSync(join(HARNESS, '.claude', 'commands')).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')),
    ...readdirSync(join(ROOT, 'pi-templates', '.pi', 'prompts')).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')),
  ]);

  const problems = [];
  for (const file of sources) {
    const rel = relative(ROOT, file);
    for (const cmd of new Set(slashCommandsIn(readFileSync(file, 'utf8')))) {
      if (known.has(cmd) || BUILTIN_COMMANDS.has(cmd) || NOT_COMMANDS.has(cmd)) continue;
      problems.push(`${rel} cites /${cmd} but no harness/.claude/commands/${cmd}.md or pi-templates/.pi/prompts/${cmd}.md exists`);
    }
  }
  assert.deepEqual(problems, [], `dangling slash-command references:\n${problems.join('\n')}`);
});

// ── (a2) the post-install panel lists EVERY Pi prompt ────────────────────────

// The "FIA installed — how to use it" note is the only command list most
// people ever read: it is printed once, in the terminal, right after the
// install. New prompts kept landing in .pi/prompts/ without ever reaching it
// (/feature, /bug and /example were missing for releases) — check (a) only
// catches the opposite drift (a listed command with no file).
test('the FIA post-install note lists every Pi prompt', () => {
  const panel = readFileSync(join(ROOT, 'src', 'steps', 'fia.js'), 'utf8');
  const cited = new Set(slashCommandsIn(panel));
  const prompts = readdirSync(join(ROOT, 'pi-templates', '.pi', 'prompts'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''));
  assert.ok(prompts.length > 0, 'pi prompts exist');
  const missing = prompts.filter((p) => !cited.has(p));
  assert.deepEqual(missing, [], `commands shipped but absent from the install note: ${missing.map((m) => `/${m}`).join(', ')}`);
});

// ── (b) Claude skills ⊆ Cursor skills, byte-identical ────────────────────────

test('every harness/.claude skill ships identically in harness/.cursor', { skip: !hasHarness && 'harness/ not present (nested repo, absent on fresh checkout)' }, () => {
  // Cursor additionally carries cursor-only skills (project-workflow and the
  // workflow-* mirrors of the slash-commands, since Cursor routes by skill) —
  // extras are fine; what must never drift is the SHARED skill content.
  const claudeSkills = join(HARNESS, '.claude', 'skills');
  const cursorSkills = join(HARNESS, '.cursor', 'skills');
  const files = walk(claudeSkills).filter((f) => !f.endsWith('.gitkeep'));
  assert.ok(files.length > 0, 'claude skills exist');

  const problems = [];
  for (const file of files) {
    const rel = relative(claudeSkills, file);
    const twin = join(cursorSkills, rel);
    if (!existsSync(twin)) {
      problems.push(`missing in .cursor/skills: ${rel}`);
    } else if (!readFileSync(file).equals(readFileSync(twin))) {
      problems.push(`content differs: ${rel}`);
    }
  }
  assert.deepEqual(problems, [], `claude/cursor skills out of sync:\n${problems.join('\n')}`);
});

// ── (c) no pre-rename Portuguese slash-command survives ──────────────────────

const FORBIDDEN_PT = [...RENAMED_OLD_NAMES];

test('no old Portuguese slash-command names remain (english-first rename)', () => {
  const sources = [
    ...(hasHarness ? mdFilesUnder(HARNESS) : []),
    ...readdirSync(join(ROOT, 'src', 'steps')).filter((f) => f.endsWith('.js')).map((f) => join(ROOT, 'src', 'steps', f)),
    ...walk(join(ROOT, 'pi-templates')).filter((f) => /\.(md|ts|yaml)$/.test(f)),
    ...walk(join(ROOT, 'fia-templates', 'scripts')).filter((f) => f.endsWith('.mjs')),
    ...walk(join(ROOT, 'fia-templates', 'modules')).filter((f) => f.endsWith('.mjs')),
    ...mdFilesUnder(join(ROOT, 'fia-templates', 'data')),
    join(ROOT, 'DOCS.md'),
    join(ROOT, 'README.md'),
  ];
  const re = new RegExp(`(?<![\\w.:/<-])/(${FORBIDDEN_PT.join('|')})(?![\\w/-])`, 'g');
  const problems = [];
  for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(re)) {
      // Rename-mapping rows ("`/tema` → `/theme`") document the old name on
      // purpose — only a bare reference counts as a leftover.
      if (/^`?\s*(?:→|->)/.test(text.slice(m.index + m[0].length))) continue;
      problems.push(`${relative(ROOT, file)}: /${m[1]}`);
    }
  }
  assert.deepEqual(problems, [], `renamed PT commands resurfaced:\n${problems.join('\n')}`);
});

// ── (d) fia.config.yaml agent prompts exist where the config points ──────────

test('every agent prompt declared in fia.config.yaml exists on disk', () => {
  const cfg = parseYaml(readFileSync(join(ROOT, 'fia-templates', 'fia.config.yaml'), 'utf8'));
  assert.ok(Array.isArray(cfg.agents) && cfg.agents.length > 0, 'config declares agents');
  const problems = [];
  for (const agent of cfg.agents) {
    for (const kind of ['system', 'user']) {
      const declared = agent.prompt_engineering?.[kind];
      if (!declared) {
        problems.push(`agent "${agent.name}" declares no ${kind} prompt`);
        continue;
      }
      // In an installed project the runtime lives in imp/; in THIS repo the
      // same tree ships from fia-templates/ — map the prefix accordingly.
      const onDisk = join(ROOT, declared.replace(/^imp\//, 'fia-templates/'));
      if (!existsSync(onDisk)) problems.push(`agent "${agent.name}" ${kind} prompt missing: ${declared} (expected at ${relative(ROOT, onDisk)})`);
    }
  }
  assert.deepEqual(problems, [], `fia.config.yaml prompts out of sync:\n${problems.join('\n')}`);
});

// ── (e) harness agent frontmatter name matches the filename ──────────────────

test('harness agent frontmatter names match their filenames', { skip: !hasHarness && 'harness/ not present (nested repo, absent on fresh checkout)' }, () => {
  // Same rule for Cursor command files — the english-first rename once left
  // `name: tema` inside theme.md, which Cursor then exposed under /tema.
  const dirs = [join(HARNESS, '.claude', 'agents'), join(HARNESS, '.cursor', 'commands')];
  const problems = [];
  for (const dir of dirs) {
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    assert.ok(files.length > 0, `${relative(ROOT, dir)} has .md files`);
    for (const file of files) {
      const expected = file.replace(/\.md$/, '');
      const text = readFileSync(join(dir, file), 'utf8');
      const m = text.match(/^---\r?\n[\s\S]*?^name:\s*(\S+)\s*$/m);
      const rel = `${relative(ROOT, dir)}/${file}`;
      if (!m) problems.push(`${rel}: no frontmatter name:`);
      else if (m[1] !== expected) problems.push(`${rel}: frontmatter name "${m[1]}" != filename "${expected}"`);
    }
  }
  assert.deepEqual(problems, [], `agent name/filename mismatches:\n${problems.join('\n')}`);
});
