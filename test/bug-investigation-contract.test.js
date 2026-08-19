import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HARNESS = join(ROOT, 'harness');
const hasHarness = existsSync(join(HARNESS, '.claude'));
const skipHarness = !hasHarness && 'private harness checkout not present';

function read(...parts) {
  return readFileSync(join(ROOT, ...parts), 'utf8');
}

function oneLine(text) {
  return text.replace(/\s+/g, ' ');
}

const bugPrompts = [
  ['Pi', read('pi-templates', '.pi', 'prompts', 'bug.md')],
  ...(hasHarness ? [['Claude', read('harness', '.claude', 'commands', 'bug.md')]] : []),
];

for (const [engine, source] of bugPrompts) {
  const prompt = oneLine(source);

  test(`${engine} /bug selects a proportional investigation path`, () => {
    assert.match(prompt, /Use `direct` only when ALL are true/i);
    assert.match(prompt, /Use `rca` when ANY (?:of those )?conditions? is false/i);
    assert.match(prompt, /intermittent/i);
    assert.match(prompt, /security/i);
    assert.match(prompt, /auth/i);
    assert.match(prompt, /permissions/i);
    assert.match(prompt, /destructive data/);
    assert.match(prompt, /schema/);
    assert.match(prompt, /migrations/);
    assert.match(prompt, /severity is not CRITICAL/i);
    assert.match(prompt, /why → because/);
  });

  test(`${engine} /bug persists investigation metadata and evidence`, () => {
    for (const field of [
      'Investigation: direct | rca',
      'Severity: critical | high | medium | low',
      'Confidence: high | medium | low',
      'RCA: ai-docs/investigations/NN-bug-<slug>.md | not-required',
      'RCA review: pending | approved | not-required',
    ]) {
      assert.ok(prompt.includes(field), `missing metadata field: ${field}`);
    }
    assert.match(prompt, /file:line/);
    assert.match(prompt, /complexity \(1–10\)/i);
    assert.match(prompt, /blast radius/i);
    assert.match(prompt, /cause chain|evidence chain/);
    assert.match(prompt, /smallest fix/i);
    assert.match(prompt, /rejected alternatives/i);
  });

  test(`${engine} /bug gates risky or uncertain RCA on a human`, () => {
    assert.match(
      prompt,
      /(?:when confidence is LOW|for LOW confidence)[^.]*?(?:severity is CRITICAL|CRITICAL severity)/i,
    );
    assert.match(prompt, /RCA review: pending/);
    assert.match(prompt, /WAIT for explicit approval/i);
    assert.match(prompt, /never approve it yourself/i);
    assert.match(prompt, /RED test/i);
    assert.match(prompt, /fail on (?:a real |an )?ASSERTION/i);
  });
}

test('task-sequencer enforces the RCA gate before claiming and relays evidence', { skip: skipHarness }, () => {
  const agent = read('harness', '.claude', 'agents', 'task-sequencer.md');
  const gate = agent.indexOf('**Bug investigation gate — check BEFORE claiming.**');
  const claim = agent.indexOf('### Step 3: Claim the task');
  assert.ok(gate >= 0 && gate < claim, 'bug investigation gate must run before claim');
  assert.match(agent.slice(gate, claim), /RCA review: pending[^]*STOP/i);
  assert.match(agent.slice(gate, claim), /do not claim the issue and do not write a\s+brief/i);
  assert.match(agent.slice(gate, claim), /existing, readable file/i);
  assert.match(agent.slice(gate, claim), /legacy issue[^]*let it proceed/i);
  assert.match(agent.slice(gate, claim), /If any investigation field exists[^]*complete five-field block/i);
  assert.match(agent.slice(gate, claim), /Investigation: direct` requires HIGH confidence/i);
  assert.match(agent.slice(gate, claim), /Severity: critical` or `Confidence: low` requires `RCA review: approved`/i);
  assert.match(
    agent.slice(gate, claim),
    /security, authorization\/permissions, privacy,[^]*payments, destructive data/i,
  );

  const template = agent.slice(agent.indexOf('# Task [NN]:'), agent.indexOf('### Step 7b:'));
  assert.match(template, /Investigation: direct \| rca/);
  assert.match(template, /RCA review: pending \| approved \| not-required/);
  assert.match(template, /## Root-cause evidence/);
  assert.match(template, /Evidence anchors/);
  assert.match(template, /Smallest fix/);
  assert.match(agent, /read it completely[^]*Distill its\s+verified cause/i);
});

const absorbPrompts = [
  ['Pi', read('pi-templates', '.pi', 'prompts', 'absorb.md')],
  ...(hasHarness ? [['Claude', read('harness', '.claude', 'commands', 'absorb.md')]] : []),
];

for (const [engine, source] of absorbPrompts) {
  const prompt = oneLine(source);

  test(`${engine} /absorb uses one canonical, on-demand project skill`, () => {
    assert.match(prompt, /single canonical file `.agents\/skills\/project\/SKILL\.md`/);
    assert.match(prompt, /load it on demand rather than on every turn/i);
    assert.match(prompt, /\.claude\/skills\/project/);
    assert.match(prompt, /`\.\.\/\.\.\/\.agents\/skills\/project`/);
    assert.match(prompt, /Never create `\.pi\/skills\/project` or\s+`\.cursor\/skills\/project` copies/i);
  });

  test(`${engine} /absorb preserves legacy project skills until authority is explicit`, () => {
    assert.match(
      prompt,
      /inspect legacy `\.claude\/skills\/project`,\s+`\.cursor\/skills\/project`, and `\.pi\/skills\/project` paths/i,
    );
    assert.match(prompt, /preserve it/i);
    assert.match(prompt, /ask which version is authoritative/i);
    assert.match(prompt, /Never overwrite, delete\s+or silently merge/i);
  });
}

test('project-knowledge-audit separates state, history and intent with evidence', { skip: skipHarness }, () => {
  const skill = read('harness', '.claude', 'skills', 'project-knowledge-audit', 'SKILL.md');

  for (const loadedSurface of [
    'AGENTS.md',
    'CLAUDE.md',
    '.claude/rules/',
    'alwaysApply: true',
    '.pi/APPEND_SYSTEM.md',
  ]) {
    assert.ok(skill.includes(loadedSurface), `missing loaded surface: ${loadedSurface}`);
  }

  assert.match(skill, /\| Current state \|/);
  assert.match(skill, /\| Event history \|/);
  assert.match(skill, /\| Contract or intent \|/);
  assert.match(skill, /\*\*confirmed\*\*/);
  assert.match(skill, /\*\*contradicted\*\*/);
  assert.match(skill, /\*\*unsupported\*\*/);
  assert.match(skill, /npm run wiki:check -- --json/);
  assert.match(skill, /node imp\/scripts\/wiki-check\.mjs --json/);
  assert.match(skill, /merge-base/);
  assert.match(skill, /new evidence, impact,\s+confidence/i);
  assert.match(skill, /smallest durable correction/i);
  assert.match(skill, /Never read, print, or diff secret values/i);
  assert.match(skill, /read-only and advisory by default/i);
  assert.match(skill, /only when the user\s+explicitly asks/i);
  assert.match(skill, /Contradicted now[^]*Unsupported[^]*Durable invariant to add[^]*Checked; no edit/);
});

test('the investigations directory is present in the shipped harness', { skip: skipHarness }, () => {
  assert.ok(existsSync(join(HARNESS, 'ai-docs', 'investigations', '.gitkeep')));
});
