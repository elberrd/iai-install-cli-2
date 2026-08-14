// Official agent skills (skills.sh CLI): the argv shape of the single
// `skills add` call (Claude Code + Cursor — Pi discovers .agents/skills/
// natively, so there is no second call and no .pi/ copy), plus the pruner
// that removes the .pi/skills/ copies older installer versions left behind
// (they double every skill in Pi's discovery and open each session with a
// "Skill conflicts" panel). The runner is injected (no npx in tests) and
// nothing here may ever throw: a skills hiccup must not abort an install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installProjectSkills,
  prunePiSkillCopies,
  skillsAddArgs,
  SKILL_AGENTS_MAIN,
} from '../src/lib/skills.js';

const R2 = {
  label: 'Cloudflare (R2) + wrangler',
  source: 'cloudflare/skills',
  skills: ['cloudflare', 'wrangler'],
  docsUrl: 'https://github.com/cloudflare/skills',
};

/**
 * Temp project, optionally already stamped with the FIA's .pi/ folder and with
 * a skills-lock.json (`lock` may be an object or raw text, to fake a broken one).
 */
function project({ pi = false, lock } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'create-iai-skills-'));
  if (pi) mkdirSync(join(dir, '.pi'), { recursive: true });
  if (lock !== undefined) {
    writeFileSync(join(dir, 'skills-lock.json'), typeof lock === 'string' ? lock : JSON.stringify(lock), 'utf8');
  }
  return dir;
}

/** A lockfile as `skills add` writes it: one entry per skill, source repeated. */
const LOCK = {
  version: 1,
  skills: {
    cloudflare: { source: 'cloudflare/skills', sourceType: 'github', skillPath: 'cloudflare' },
    wrangler: { source: 'cloudflare/skills', sourceType: 'github', skillPath: 'wrangler' },
    resend: { source: 'resend/resend-skills', sourceType: 'github', skillPath: 'resend' },
  },
};

/** Stamp a skill folder (with a SKILL.md, like the real CLIs) under `base`. */
function stampSkill(dir, base, name) {
  const folder = join(dir, ...base, name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: x\n---\n`, 'utf8');
}

/**
 * Test seam for installProjectSkills: records every argv and replays canned
 * results (default: success). `spin` runs the work with no clack spinner.
 */
function fakeDeps(results = []) {
  const calls = [];
  let i = 0;
  return {
    calls,
    spin: (_start, fn) => fn(),
    run: async (cmd, args, opts) => {
      calls.push({ cmd, args, cwd: opts?.cwd });
      const result = results[i++];
      if (result instanceof Error) throw result;
      return result ?? { ok: true, exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

test('skillsAddArgs: non-interactive command for the skills.sh CLI (Claude Code + Cursor)', () => {
  assert.deepEqual(skillsAddArgs(R2), [
    '-y',
    'skills',
    'add',
    'cloudflare/skills',
    '--skill',
    'cloudflare',
    '--skill',
    'wrangler',
    '-y',
    '-a',
    'claude-code',
    'cursor',
  ]);
});

test('skillsAddArgs: a source with no explicit skill list', () => {
  assert.deepEqual(skillsAddArgs({ source: 'resend/resend-skills', skills: [] }), [
    '-y',
    'skills',
    'add',
    'resend/resend-skills',
    '-y',
    '-a',
    'claude-code',
    'cursor',
  ]);
});

test('skillsAddArgs: the variadic -a stays last so no flag is read as an agent', () => {
  const args = skillsAddArgs(R2, SKILL_AGENTS_MAIN);
  assert.deepEqual(args.slice(-SKILL_AGENTS_MAIN.length - 1), ['-a', ...SKILL_AGENTS_MAIN]);
  // Comma form is invalid in this CLI — the agents must stay separate items.
  assert.ok(!args.some((a) => a.includes(',')));
});

test('installProjectSkills: exactly ONE call — .pi/ present or not, Pi reads .agents/skills/ itself', async () => {
  for (const pi of [true, false]) {
    const dir = project({ pi });
    const deps = fakeDeps();
    assert.equal(await installProjectSkills(dir, R2, deps), true);
    assert.equal(deps.calls.length, 1);
    assert.deepEqual(deps.calls[0].args, skillsAddArgs(R2, SKILL_AGENTS_MAIN));
    assert.equal(deps.calls[0].cmd, 'npx');
    assert.equal(deps.calls[0].cwd, dir);
  }
});

test('installProjectSkills: a failed install → false, never a throw', async () => {
  const dir = project({ pi: true });
  assert.equal(await installProjectSkills(dir, R2, fakeDeps([{ ok: false, exitCode: 1, stdout: '', stderr: 'network' }])), false);
  assert.equal(await installProjectSkills(dir, R2, fakeDeps([new Error('spawn ENOENT')])), false);
});

// ── Pruning the .pi/skills/ copies the old two-invocation flow left behind ──

test('prunePiSkillCopies: removes lock-recorded copies that exist in .agents/skills/ too', async () => {
  const dir = project({ pi: true, lock: LOCK });
  for (const name of ['cloudflare', 'wrangler', 'resend']) {
    stampSkill(dir, ['.agents', 'skills'], name);
    stampSkill(dir, ['.pi', 'skills'], name);
  }
  // Harness-owned skill: lives in .pi/skills/ but is NOT in the lockfile.
  stampSkill(dir, ['.pi', 'skills'], 'fia');

  assert.equal(await prunePiSkillCopies(dir), 3);
  for (const name of ['cloudflare', 'wrangler', 'resend']) {
    assert.ok(!existsSync(join(dir, '.pi', 'skills', name)), `${name} copy should be gone`);
    assert.ok(existsSync(join(dir, '.agents', 'skills', name)), `${name} canonical must stay`);
  }
  assert.ok(existsSync(join(dir, '.pi', 'skills', 'fia')), 'harness-owned skills are untouched');
});

test('prunePiSkillCopies: keeps a copy whose .agents/ canonical is missing — never orphans a skill', async () => {
  const dir = project({ pi: true, lock: LOCK });
  stampSkill(dir, ['.pi', 'skills'], 'resend'); // copy exists, canonical does not
  assert.equal(await prunePiSkillCopies(dir), 0);
  assert.ok(existsSync(join(dir, '.pi', 'skills', 'resend')));
});

test('prunePiSkillCopies: no lockfile, broken lockfile or nothing to remove → 0, never throws', async () => {
  assert.equal(await prunePiSkillCopies(project({ pi: true })), 0);
  assert.equal(await prunePiSkillCopies(project({ pi: true, lock: '{ not json' })), 0);
  assert.equal(await prunePiSkillCopies(project({ pi: true, lock: LOCK })), 0); // entries recorded, no folders on disk
});
