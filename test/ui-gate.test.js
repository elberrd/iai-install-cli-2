import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSurfaceLine } from '../fia-templates/modules/gates.mjs';
import { FRONTEND_FILE, runUiGate } from '../fia-templates/modules/ui-gate.mjs';

// ── parseSurfaceLine ─────────────────────────────────────────────────────────

test('parseSurfaceLine: no Surface line → null (the gate still self-arms on files)', () => {
  assert.equal(parseSurfaceLine('# Task 05\n\nSpec: 0002 (S-1)\n\n## Overview'), null);
  assert.equal(parseSurfaceLine(''), null);
  assert.equal(parseSurfaceLine(null), null);
});

test('parseSurfaceLine: single and multi-token lines, lowercased and trimmed', () => {
  assert.deepEqual(parseSurfaceLine('Surface: ui'), ['ui']);
  assert.deepEqual(parseSurfaceLine('Surface: UI, API'), ['ui', 'api']);
  assert.deepEqual(parseSurfaceLine('Surface:  api '), ['api']);
});

test('parseSurfaceLine: matches at line start anywhere in the brief, not mid-line', () => {
  const brief = '# Task\n\nSpec: 0001 (S-1)\nSurface: ui\n\ntext mentioning Surface: api inline';
  assert.deepEqual(parseSurfaceLine(brief), ['ui']);
  assert.equal(parseSurfaceLine('the Surface: ui convention'), null);
});

test('parseSurfaceLine: empty token list → null', () => {
  assert.equal(parseSurfaceLine('Surface: ,'), null);
});

// ── runUiGate ────────────────────────────────────────────────────────────────

/** A git repo whose only change vs the (empty) baseline is one .tsx file. */
function uiFixture({ testExit = 0 } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'ui-gate-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { test: `node -e "process.exit(${testExit})"` } }) + '\n',
  );
  mkdirSync(join(repo, 'app'), { recursive: true });
  writeFileSync(join(repo, 'app', 'Form.tsx'), 'export const Form = () => null;\n');
  return repo;
}

/**
 * A minimal Run double: executes phases inline, records their params, and
 * scripts what each agent phase returns. Carries the members runSpec needs so
 * the real ui_retest phase can spawn the fixture's npm test.
 */
function fakeUiRun(repo, { onCall }) {
  const params = [];
  let seq = 0;
  const run = {
    repoRoot: repo,
    baseline: {},
    fdaId: 'ui-test',
    env: process.env,
    console: { note: () => {} },
    tracer: { event: () => {} },
    contextHandoffDir: mkdtempSync(join(tmpdir(), 'ui-gate-handoff-')),
    phases: [],
    params,
    runPhase: async (p, fn) => {
      params.push(p);
      seq += 1;
      run.phases.push({ phase_id: `t_${p.name}`, seq, params: p });
      return fn({ log: () => {}, call: async (call) => onCall(p.name, call) });
    },
  };
  return run;
}

const UI_BRIEF = '# Task 07: Patient form\n\nSpec: 0003 (S-1)\n\nBuild the patient create form.';

test('runUiGate: reject → repair → approve → retest green; ui_verify never replays', async () => {
  const repo = uiFixture({ testExit: 0 });
  const fix = { status: 'success', changed_files: ['app/Form.tsx'], artifacts: [] };
  const run = fakeUiRun(repo, {
    onCall: (name) => {
      if (name === 'ui_check') return { approved: false, blocking: ['field errors render in a banner'], findings: [] };
      if (name === 'fix_ui') return fix;
      if (name === 'ui_verify') return { approved: true, findings: [] };
      throw new Error(`unexpected agent phase ${name}`);
    },
  });
  assert.equal(await runUiGate(run, UI_BRIEF), fix);
  assert.deepEqual(
    run.params.map((p) => p.name),
    ['ui_scope', 'ui_check', 'fix_ui', 'ui_verify', 'ui_gate', 'ui_retest'],
  );
  const verify = run.params.find((p) => p.name === 'ui_verify');
  assert.equal(verify.replay, false, 'ui_verify must never replay a stale verdict on --resume');
});

test('runUiGate: repair round breaks the suite → ui_retest refuses the close', async () => {
  const repo = uiFixture({ testExit: 1 });
  const run = fakeUiRun(repo, {
    onCall: (name) => {
      if (name === 'ui_check') return { approved: false, blocking: ['x'], findings: [] };
      if (name === 'fix_ui') return { status: 'success', changed_files: ['app/Form.tsx'], artifacts: [] };
      if (name === 'ui_verify') return { approved: true, findings: [] };
      throw new Error(`unexpected agent phase ${name}`);
    },
  });
  await assert.rejects(() => runUiGate(run, UI_BRIEF), /suite went red after the UI repair round/);
});

test('runUiGate: verify still rejecting → the gate throws before any retest', async () => {
  const repo = uiFixture();
  const run = fakeUiRun(repo, {
    onCall: (name) => {
      if (name === 'ui_check') return { approved: false, blocking: ['x'], findings: [] };
      if (name === 'fix_ui') return { status: 'success', changed_files: [], artifacts: [] };
      if (name === 'ui_verify') return { approved: false, blocking: ['still broken'], findings: [] };
      throw new Error(`unexpected agent phase ${name}`);
    },
  });
  await assert.rejects(() => runUiGate(run, UI_BRIEF), /ui conformance incomplete/);
  assert.ok(!run.params.some((p) => p.name === 'ui_retest'), 'no retest after a refused gate');
});

test('runUiGate: Surface without ui stands the gate down', async () => {
  const repo = uiFixture();
  const run = fakeUiRun(repo, { onCall: () => assert.fail('no agent phase may run') });
  assert.equal(await runUiGate(run, 'Surface: api\n\nBackend-only task.'), null);
  assert.deepEqual(
    run.params.map((p) => p.name),
    ['ui_scope'],
  );
});

// ── FRONTEND_FILE ────────────────────────────────────────────────────────────

test('FRONTEND_FILE: component files arm the gate, everything else does not', () => {
  for (const f of ['app/pacientes/page.tsx', 'src/Form.jsx', 'src/App.vue', 'lib/Card.svelte', 'UPPER.TSX']) {
    assert.ok(FRONTEND_FILE.test(f), `${f} should count as frontend`);
  }
  for (const f of ['convex/schema.ts', 'app/api/route.ts', 'styles.css', 'page.tsx.bak', 'notes.md', 'x.test.ts']) {
    assert.ok(!FRONTEND_FILE.test(f), `${f} should NOT count as frontend`);
  }
});
