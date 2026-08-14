import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { countPlaceholders, classifyPrd, detectMode } from '../fia-templates/scripts/project-mode.mjs';

const SCRIPT = join(import.meta.dirname, '..', 'fia-templates', 'scripts', 'project-mode.mjs');

function project(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'project-mode-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

test('countPlaceholders: {{…}} markers only', () => {
  assert.equal(countPlaceholders('# {{name}}\n{{vision}} and {name} and {{a b}}'), 3);
  assert.equal(countPlaceholders('all filled in'), 0);
  assert.equal(countPlaceholders(null), 0);
});

test('classifyPrd: missing / template / real (both PRD.md and prd.md)', () => {
  assert.equal(classifyPrd(project()).state, 'missing');
  const tpl = project({ 'ai-docs/PRD.md': '# {{product}}\nVision: {{vision}}' });
  assert.deepEqual(classifyPrd(tpl), { state: 'template', placeholders: 2, path: 'ai-docs/PRD.md' });
  const real = project({ 'ai-docs/prd.md': '# CRM\nVision: recover patients' });
  assert.deepEqual(classifyPrd(real), { state: 'real', placeholders: 0, path: 'ai-docs/prd.md' });
});

test('detectMode: fresh template install (PRD with placeholders + starter code) is GREENFIELD', () => {
  const root = project({
    'ai-docs/PRD.md': '# {{product}}\n{{vision}}',
    'app/page.tsx': 'export default () => null', // starter code must not flip the mode
    'package.json': '{}',
  });
  const report = detectMode(root);
  assert.equal(report.mode, 'greenfield');
  assert.match(report.evidence.join('\n'), /the installed template, not a real PRD/);
});

test('detectMode: empty folder is greenfield; real PRD alone is IDEATION', () => {
  assert.equal(detectMode(project()).mode, 'greenfield');
  const root = project({ 'ai-docs/PRD.md': '# CRM\nAll decided.' });
  assert.equal(detectMode(root).mode, 'ideation');
});

test('detectMode: map.yaml, task-master.md or PRD-as-built.md each mean BROWNFIELD', () => {
  const byMap = project({ 'ai-docs/map.yaml': 'screens: []', 'ai-docs/PRD.md': '# {{p}}' });
  assert.equal(detectMode(byMap).mode, 'brownfield'); // even with a template PRD — work started
  const byTasks = project({ 'ai-docs/todos/task-master.md': '# tasks' });
  assert.equal(detectMode(byTasks).mode, 'brownfield');
  const byAbsorb = project({ 'ai-docs/PRD-as-built.md': '# as built' });
  assert.equal(detectMode(byAbsorb).mode, 'brownfield');
});

test('CLI: --json reports mode and evidence', () => {
  const root = project({ 'ai-docs/map.yaml': 'x: 1' });
  const out = JSON.parse(execFileSync(process.execPath, [SCRIPT, '--json', '--dir', root], { encoding: 'utf8' }));
  assert.equal(out.mode, 'brownfield');
  assert.equal(out.signals.mapYaml, true);
  assert.ok(Array.isArray(out.evidence) && out.evidence.length > 0);
});
