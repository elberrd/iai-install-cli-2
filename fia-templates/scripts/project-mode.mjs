/**
 * Project mode detector — deterministic answer to "what kind of project is
 * this?", so interview commands (/idea first of all) branch on evidence
 * instead of guessing from the presence of files.
 *
 * The trap this exists for: the CLI's full install ships a PRD TEMPLATE
 * (full of `{{placeholders}}`) plus a complete starter codebase — so neither
 * "PRD.md exists" nor "there is code here" means the person has a real
 * product. The reliable signals, in order of authority:
 *
 *   brownfield — work on a real system already started:
 *                ai-docs/map.yaml (mapped), ai-docs/todos/task-master.md
 *                (tasks generated) or ai-docs/PRD-as-built.md (/absorb ran).
 *   ideation   — a REAL PRD exists (no {{placeholders}} left) but nothing was
 *                built from it yet: the person is still shaping the idea —
 *                re-running /idea means revising, not adding a module.
 *   greenfield — no PRD, or the PRD is still the template (any
 *                {{placeholder}} counts: the starter's code does NOT make a
 *                project brownfield).
 *
 * What stays with the AI on purpose: recognizing a hand-built app that was
 * never absorbed (real code, no ai-docs trail). Code cannot tell a starter
 * from a product — the interviewing agent can, and routes to /absorb.
 *
 * Usage:  node imp/scripts/project-mode.mjs [--json] [--dir <p>]
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Count `{{…}}` placeholders in a document. */
export function countPlaceholders(text) {
  return (String(text ?? '').match(/\{\{[^{}]+\}\}/g) || []).length;
}

/** Classify ai-docs/PRD.md → { state: 'missing'|'template'|'real', placeholders, path }. */
export function classifyPrd(root) {
  const dir = join(root, 'ai-docs');
  // List the directory instead of existsSync-ing candidate names: on
  // case-insensitive filesystems (macOS) existsSync('PRD.md') matches prd.md
  // and the reported path would carry the wrong casing.
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return { state: 'missing', placeholders: 0, path: null };
  }
  const name = names.find((n) => n.toLowerCase() === 'prd.md');
  if (!name) return { state: 'missing', placeholders: 0, path: null };
  let text;
  try {
    text = readFileSync(join(dir, name), 'utf8');
  } catch {
    return { state: 'missing', placeholders: 0, path: null };
  }
  const placeholders = countPlaceholders(text);
  return {
    state: placeholders > 0 ? 'template' : 'real',
    placeholders,
    path: `ai-docs/${name}`,
  };
}

/** Deterministic project mode + the evidence behind it. */
export function detectMode(root) {
  const prd = classifyPrd(root);
  const signals = {
    mapYaml: existsSync(join(root, 'ai-docs', 'map.yaml')),
    taskMaster: existsSync(join(root, 'ai-docs', 'todos', 'task-master.md')),
    asBuiltPrd: existsSync(join(root, 'ai-docs', 'PRD-as-built.md')),
  };
  const evidence = [];
  if (signals.mapYaml) evidence.push('ai-docs/map.yaml exists (project was mapped)');
  if (signals.taskMaster) evidence.push('ai-docs/todos/task-master.md exists (tasks were generated)');
  if (signals.asBuiltPrd) evidence.push('ai-docs/PRD-as-built.md exists (/absorb ran)');
  if (prd.state === 'template') evidence.push(`${prd.path} still has ${prd.placeholders} {{placeholder}}(s) — the installed template, not a real PRD`);
  if (prd.state === 'real') evidence.push(`${prd.path} is filled in (no placeholders left)`);
  if (prd.state === 'missing') evidence.push('no ai-docs/PRD.md');

  let mode = 'greenfield';
  if (signals.mapYaml || signals.taskMaster || signals.asBuiltPrd) mode = 'brownfield';
  else if (prd.state === 'real') mode = 'ideation';
  return { mode, prd, signals, evidence };
}

export function renderReport(report) {
  return [
    `mode: ${report.mode}`,
    ...report.evidence.map((e) => `  - ${e}`),
  ].join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const dirIx = argv.indexOf('--dir');
  const root = dirIx !== -1 && argv[dirIx + 1] ? resolve(argv[dirIx + 1]) : process.cwd();
  const report = detectMode(root);
  console.log(argv.includes('--json') ? JSON.stringify(report, null, 2) : renderReport(report));
}
