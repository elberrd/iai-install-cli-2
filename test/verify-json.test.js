// `--verify --json`: the machine-readable report ({ ok, errors, warnings })
// and the bin dispatch that prints ONLY JSON on stdout, exit code unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectFindings, jsonReport } from '../src/steps/verify.js';

const BIN = fileURLToPath(new URL('../bin/create-iai.js', import.meta.url));

async function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'create-iai-verify-json-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  return dir;
}

function runBin(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { timeout: 30000, killSignal: 'SIGKILL' }, (error, stdout, stderr) =>
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

test('jsonReport: maps findings to { ok, errors, warnings }', () => {
  const report = jsonReport([
    { level: 'ok', msg: 'fine' },
    { level: 'warn', msg: 'pending key' },
    { level: 'error', msg: 'broken thing' },
  ]);
  assert.deepEqual(report, { ok: false, errors: ['broken thing'], warnings: ['pending key'] });

  const clean = jsonReport([
    { level: 'ok', msg: 'fine' },
    { level: 'warn', msg: 'w' },
  ]);
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.errors, []);
});

test('jsonReport over collectFindings: harness-only fixture → ok true', async () => {
  const dir = await fixture({
    'HARNESS.md': '# harness\n',
    'ai-docs/PRD.md': '# prd\n',
    'package.json': JSON.stringify({ name: 'my-app' }),
  });
  const report = jsonReport(await collectFindings(dir));
  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
});

test('jsonReport: agent-skills coverage lands in warnings, exit code unchanged', async () => {
  // Lock entry with no folder for either engine — warning-level, never fatal.
  const dir = await fixture({
    'HARNESS.md': '# harness\n',
    'ai-docs/PRD.md': '# prd\n',
    'package.json': JSON.stringify({ name: 'my-app' }),
    'skills-lock.json': JSON.stringify({ version: 1, skills: { neon: { source: 'neondatabase/agent-skills' } } }),
    '.pi/prompts/fia.md': '# fia\n',
  });
  const report = jsonReport(await collectFindings(dir));
  assert.equal(report.ok, true);
  assert.ok(report.warnings.some((m) => m.includes('.agents/skills/') && m.includes('neon')));
  // No .pi/skills/ copy exists → nothing duplicated, so no Pi warning at all.
  assert.ok(!report.warnings.some((m) => m.includes('.pi/skills/')));
});

test('bin: --verify --json prints pure JSON, exit 0 on a clean project', async () => {
  const dir = await fixture({
    'HARNESS.md': '# harness\n',
    'ai-docs/PRD.md': '# prd\n',
    'package.json': JSON.stringify({ name: 'my-app' }),
  });
  const res = await runBin(['--verify', '--json', '--dir', dir]);
  assert.equal(res.code, 0);
  // stdout must be ONLY the JSON — parse the whole thing, no clack chrome.
  const report = JSON.parse(res.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
  assert.ok(Array.isArray(report.warnings));
});

test('bin: --verify --json exits 1 with the errors listed on a broken project', async () => {
  const dir = await fixture({
    'package.json': JSON.stringify({ name: 'my-app' }),
    'iai.config.json': JSON.stringify({ addons: [] }),
    'template.addons.json': JSON.stringify({ addons: {} }), // leftover manifest = error
    '.env.local': 'NEXT_PUBLIC_CONVEX_URL=https://x.convex.cloud\n',
  });
  const res = await runBin(['--verify', '--json', '--dir', dir]);
  assert.equal(res.code, 1);
  const report = JSON.parse(res.stdout);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((m) => m.includes('template.addons.json')));
});
