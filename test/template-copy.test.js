import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { copyTemplateTree } from '../src/steps/project.js';

/** Writes `files` ({rel: content}) under `root`, creating parent dirs. */
function seed(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

const tmp = () => mkdtempSync(join(tmpdir(), 'tpl-copy-'));

test('no protected paths: same-named files are overwritten (template status quo)', async () => {
  const src = seed(tmp(), { 'app/page.tsx': 'template\n', 'CLAUDE.md': 'template\n' });
  const dest = seed(tmp(), { 'app/page.tsx': 'mine\n', 'CLAUDE.md': 'mine\n' });
  await copyTemplateTree(src, dest);
  assert.equal(readFileSync(join(dest, 'app', 'page.tsx'), 'utf8'), 'template\n');
  assert.equal(readFileSync(join(dest, 'CLAUDE.md'), 'utf8'), 'template\n');
});

test("protected paths keep the project's version and still gain missing files", async () => {
  const src = seed(tmp(), {
    'app/page.tsx': 'template\n',
    'CLAUDE.md': 'template\n',
    '.claude/settings.json': 'template\n',
    '.claude/commands/dev.md': 'template\n',
  });
  const dest = seed(tmp(), {
    'app/page.tsx': 'mine\n',
    'CLAUDE.md': 'mine\n',
    '.claude/settings.json': 'mine\n',
  });
  await copyTemplateTree(src, dest, { protect: ['.claude', 'CLAUDE.md'] });
  // Unprotected app code follows the template (documented full-mode behavior).
  assert.equal(readFileSync(join(dest, 'app', 'page.tsx'), 'utf8'), 'template\n');
  // Protected collisions: the project's version wins…
  assert.equal(readFileSync(join(dest, 'CLAUDE.md'), 'utf8'), 'mine\n');
  assert.equal(readFileSync(join(dest, '.claude', 'settings.json'), 'utf8'), 'mine\n');
  // …and what the project did not have still lands (per-file merge).
  assert.equal(readFileSync(join(dest, '.claude', 'commands', 'dev.md'), 'utf8'), 'template\n');
});

test('protected path absent from the template: destination stays untouched', async () => {
  const src = seed(tmp(), { 'app/page.tsx': 'template\n' });
  const dest = seed(tmp(), { '.cursorrules': 'mine\n' });
  await copyTemplateTree(src, dest, { protect: ['.cursorrules'] });
  assert.equal(readFileSync(join(dest, '.cursorrules'), 'utf8'), 'mine\n');
  assert.equal(existsSync(join(dest, 'app', 'page.tsx')), true);
});

test('a protected prefix does not shield look-alike siblings (.claude vs .claude2)', async () => {
  const src = seed(tmp(), { '.claude2/x.md': 'template\n', '.claude/x.md': 'template\n' });
  const dest = seed(tmp(), { '.claude2/x.md': 'mine\n', '.claude/x.md': 'mine\n' });
  await copyTemplateTree(src, dest, { protect: ['.claude'] });
  assert.equal(readFileSync(join(dest, '.claude', 'x.md'), 'utf8'), 'mine\n', 'protected');
  assert.equal(readFileSync(join(dest, '.claude2', 'x.md'), 'utf8'), 'template\n', 'not protected');
});
