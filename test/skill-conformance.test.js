// Every SKILL.md we ship must satisfy the Agent Skills spec, because the
// tooling that reads them (the skills.sh CLI, Cursor, Codex, Amp…) SKIPS a
// skill whose frontmatter does not parse — silently. That is how
// `design-system`, `security` and `examples` shipped for weeks with a
// multi-line `description:` that YAML read as nested keys: nothing errored,
// the skills were simply never loaded.
//
// The spec (agentskills.io) allows exactly six keys and requires `name` to
// match the parent directory name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The six keys the Agent Skills spec allows. Anything else is rejected by
 *  claude.ai and the Skills API even when Claude Code tolerates it. */
const ALLOWED_KEYS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);

/** Every `<root>/**\/<name>/SKILL.md` we ship, as {path, dir}. */
function findSkills(root) {
  const out = [];
  if (!existsSync(root)) return out;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      // Skip symlinked mirrors: the same file would be asserted twice, and a
      // broken link is the mirror test's job, not this one.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(p);
      else if (entry.name === 'SKILL.md') out.push({ path: p, dir: basename(dir) });
    }
  };
  walk(root);
  return out;
}

function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return m ? m[1] : null;
}

const skills = [...findSkills(join(REPO, 'harness')), ...findSkills(join(REPO, 'pi-templates'))];

test('there are shipped skills to check', () => {
  assert.ok(skills.length > 0, 'no SKILL.md found — the discovery walk is broken');
});

for (const skill of skills) {
  const rel = skill.path.slice(REPO.length + 1);

  test(`${rel}: frontmatter is valid YAML with a spec-compliant name`, () => {
    const raw = readFileSync(skill.path, 'utf8');
    const block = frontmatter(raw);
    assert.ok(block, 'missing --- frontmatter block');

    let meta;
    assert.doesNotThrow(() => {
      meta = parseYaml(block);
    }, 'frontmatter does not parse as YAML — the skill will be skipped silently');
    assert.ok(meta && typeof meta === 'object', 'frontmatter is not a mapping');

    assert.equal(typeof meta.name, 'string', '`name` is required');
    assert.equal(typeof meta.description, 'string', '`description` is required');
    // A multi-line description without a `>`/`|` marker parses as extra keys
    // (or throws) — this catches it even if a future YAML lib is lenient.
    assert.ok(meta.description.length > 0 && meta.description.length <= 1024, '`description` must be 1–1024 chars');
    assert.match(meta.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, '`name` must be lowercase kebab-case');
    assert.equal(meta.name, skill.dir, '`name` must match the parent directory name');
  });

  test(`${rel}: frontmatter carries only spec-allowed keys`, () => {
    const meta = parseYaml(frontmatter(readFileSync(skill.path, 'utf8')));
    const extra = Object.keys(meta).filter((k) => !ALLOWED_KEYS.has(k));
    assert.deepEqual(
      extra,
      [],
      `keys outside the spec are rejected by claude.ai and the Skills API: ${extra.join(', ')}`,
    );
  });
}

test('harness .agents/skills entries are directory symlinks, not flat .md files', () => {
  const dir = join(REPO, 'harness', '.agents', 'skills');
  if (!existsSync(dir)) return;
  const flat = readdirSync(dir).filter((n) => n.endsWith('.md'));
  assert.deepEqual(
    flat,
    [],
    // Measured: `npx skills list` enumerates a directory symlink and ignores a
    // flat <name>.md entirely, so a flat mirror is invisible to every agent
    // that reads .agents/skills (Cursor, Codex, Cline, Amp…).
    `flat skill files are not discoverable — link the directory instead: ${flat.join(', ')}`,
  );
  for (const name of readdirSync(dir)) {
    const target = join(dir, name, 'SKILL.md');
    assert.ok(statSync(target).isFile(), `${name} must resolve to a directory containing SKILL.md`);
  }
});
