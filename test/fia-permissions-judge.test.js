// The two files that JUDGE the agent's work — the regression floor and the
// holdout probes — must stay agent-write-protected even when the student
// moves `defaults.data_dir`, and even with an empty protected_files config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isProtectedPath } from '../fia-templates/modules/permissions.mjs';

test('the judge paths are protected with no config at all', () => {
  assert.equal(isProtectedPath('imp/data/floor.json', []), true);
  assert.equal(isProtectedPath('imp/data/holdout/001-probe.mjs', []), true);
  assert.equal(isProtectedPath('app/page.tsx', []), false);
});

test('a moved data_dir carries the protection with it — and keeps the canonical one', () => {
  const moved = { defaults: { data_dir: '.fia/state' } };
  assert.equal(isProtectedPath('.fia/state/floor.json', [], moved), true);
  assert.equal(isProtectedPath('.fia/state/holdout/001.mjs', [], moved), true);
  assert.equal(isProtectedPath('imp/data/floor.json', [], moved), true, 'the canonical path stays protected too');
  assert.equal(isProtectedPath('.fia/state/notes.md', [], moved), false, 'only the judge files, not the whole data dir');
});

test('a trailing slash or ./ prefix in data_dir does not break the match', () => {
  for (const declared of ['./fia-state/', 'fia-state', './fia-state']) {
    const cfg = { defaults: { data_dir: declared } };
    assert.equal(isProtectedPath('fia-state/floor.json', [], cfg), true, declared);
  }
});

test('the checklist baseline is a judge file too — an agent cannot zero it', () => {
  assert.equal(isProtectedPath('imp/data/sessions/abc123/brief_checkboxes', []), true);
  const moved = { defaults: { data_dir: '.fia/state' } };
  assert.equal(isProtectedPath('.fia/state/sessions/abc/brief_checkboxes', [], moved), true);
});

test('the runtime\'s OWN state is never a judge file (it must stay writable by the runtime)', () => {
  for (const p of ['imp/data/fia.db', 'imp/data/sessions/abc/events.jsonl', 'imp/data/.fda.lock']) {
    assert.equal(isProtectedPath(p, []), false, p);
  }
});

test('a protected path inside the data dir is never waved through as "runtime state"', async () => {
  // Regression: the runtime-state skip (added so a moved data_dir does not turn
  // the run's own trace into a PermissionBreach) must not swallow the student's
  // protected_files — `imp/data/prompt_engineering/` holds the agents' own
  // instructions, and a builder that can rewrite its prompt can do anything.
  const { enforce } = await import('../fia-templates/modules/permissions.mjs');
  assert.equal(typeof enforce, 'function');
  const src = readFileSync(join(import.meta.dirname, '..', 'fia-templates', 'modules', 'permissions.mjs'), 'utf8');
  assert.match(
    src,
    /function isRuntimeState[\s\S]{0,600}?if \(isProtected\(/,
    'isRuntimeState must consult isProtected before classifying anything as runtime churn',
  );
  assert.equal(isProtectedPath('imp/data/prompt_engineering/builder/system.md', ['imp/data/prompt_engineering/']), true);
});
