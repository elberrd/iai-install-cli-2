import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Tracer } from '../fia-templates/modules/tracer.mjs';
import { Run } from '../fia-templates/modules/runner.mjs';
import { EngineFailure, engineAdapters, execute } from '../fia-templates/modules/agents.mjs';
import { ensure } from '../fia-templates/modules/session.mjs';
import { ENGINE_ERROR_FILE } from '../fia-templates/modules/continuation.mjs';

// Relay legs run against IN-PROCESS engine fakes swapped into the exported
// engineAdapters dispatch table — no CLI is ever spawned. git is only used by
// the permission snapshots, against a throwaway repo.

function initGitRepo(root) {
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'fia@test.dev'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'FIA Relay'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, 'README.md'), '# relay\n');
  // Real installs gitignore imp/ (ensureFiaGitignore) — without this the trace
  // db's WAL files look like unauthorized writes to the permission gate.
  writeFileSync(join(root, '.gitignore'), 'imp/\npe/\n');
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' });
}

/** A run whose builder is claude_code(sonnet) with a cursor(composer) fallback. */
function makeSetup(relay) {
  const root = mkdtempSync(join(tmpdir(), 'fia-relay-'));
  initGitRepo(root);
  process.chdir(root);
  const promptsDir = join(root, 'pe');
  mkdirSync(promptsDir, { recursive: true });
  writeFileSync(join(promptsDir, 'system.md'), 'You are the builder.');
  writeFileSync(join(promptsDir, 'user.md'), 'Task: {{prompt}}');
  const cfg = {
    defaults: { data_dir: join(root, 'imp/data'), ...(relay ? { relay } : {}) },
    observability: { db: join(root, 'imp/data/fia.db') },
    agents: [
      {
        name: 'builder',
        coding_agent: 'claude_code',
        model: 'sonnet',
        writes: [],
        tools: ['read'],
        fallbacks: [{ coding_agent: 'cursor', model: 'composer' }],
        prompt_engineering: { system: join(promptsDir, 'system.md'), user: join(promptsDir, 'user.md') },
      },
    ],
  };
  const tracer = new Tracer(cfg.observability.db, join(cfg.defaults.data_dir, 'sessions', 'run1', 'events.jsonl'));
  tracer.sessionStart('run1', 'Tester', 'fda_test');
  const run = new Run(cfg, 'run1', tracer, 'Tester');
  const phase = {
    phase_id: 'run1_01_build',
    fda_id: 'run1',
    params: { name: 'build', owner: 'builder', kind: 'agent' },
  };
  const call = { prompt: 'build the thing', outputType: 'GenericOutput', gates: [] };
  return { root, cfg, run, phase, call };
}

/** PATH gets a dir of fake binaries PREPENDED (git must stay reachable). */
async function withBins(bins, fn) {
  const binDir = mkdtempSync(join(tmpdir(), 'fia-relay-bin-'));
  for (const bin of bins) writeFileSync(join(binDir, bin), '#!/bin/sh\n');
  const savedPath = process.env.PATH;
  process.env.PATH = binDir + (savedPath ? `${delimiter}${savedPath}` : '');
  try {
    return await fn();
  } finally {
    process.env.PATH = savedPath;
  }
}

async function withAdapters(fakes, fn) {
  const saved = { ...engineAdapters };
  Object.assign(engineAdapters, fakes);
  try {
    return await fn();
  } finally {
    Object.assign(engineAdapters, saved);
  }
}

const okResult = () => ({
  text: JSON.stringify({ status: 'success', summary: 'done' }),
  returncode: 0,
  tokens: 100,
  cost: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  session_id: 'sess-new',
});

const deadResult = (text) => ({
  text,
  returncode: 1,
  tokens: 500,
  cost: 0.01,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  session_id: '',
});

const readEvents = (run) =>
  readFileSync(join(run.sessionDir, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

test('relay auto: engine death (limit) relays to the fallback with the continuation preamble', async () => {
  const { cfg, run, phase, call } = makeSetup();
  // The death happens on a CORRECTION send (after a gate failure), so the dead
  // leg has real spend on the books — proving it stays stamped on the engine
  // that burned it, never re-attributed to the substitute.
  phase.params.retries = 1;
  let gateCalls = 0;
  call.gates = [
    function needs_tests() {
      gateCalls += 1;
      return gateCalls === 1 ? ['must include tests'] : [];
    },
  ];
  const calls = { claude: 0, cursor: 0 };
  let cursorPrompt = '';
  await withBins(['cursor-agent'], () =>
    withAdapters(
      {
        claude_code: async () => {
          calls.claude += 1;
          return calls.claude === 1 ? okResult() : deadResult('API Error: 429 usage limit reached');
        },
        cursor: async (req) => {
          calls.cursor += 1;
          cursorPrompt = req.prompt;
          return okResult();
        },
      },
      async () => {
        const envelope = await execute(run, phase, call);
        assert.equal(envelope.status, 'success');
      },
    ),
  );
  assert.equal(calls.claude, 2, 'first send ok, gate-correction send dies');
  assert.equal(calls.cursor, 1);

  // The dead engine's marker survives the fallback's success (identity differs),
  // so a later --resume keeps preferring the fallbacks.
  const marker = JSON.parse(readFileSync(join(run.sessionDir, 'builder', ENGINE_ERROR_FILE), 'utf8'));
  assert.equal(marker.coding_agent, 'claude_code');
  assert.equal(marker.kind, 'limit');

  const events = readEvents(run);
  const byType = (t) => events.filter((e) => e.type === t);
  assert.equal(byType('engine_error').length, 1);
  assert.equal(byType('engine_relay').length, 1);
  assert.equal(byType('engine_continuation').length, 1);
  // The dead leg's spend is stamped on the engine that burned it…
  const spend = byType('agent_spend');
  assert.equal(spend.length, 1);
  assert.equal(spend[0].payload.model, 'sonnet');
  assert.equal(spend[0].payload.failed, true);
  // …and the successful leg's on the substitute. Never both for one attempt.
  const end = byType('agent_end');
  assert.equal(end.length, 1);
  assert.equal(end[0].payload.model, 'composer');

  // The handover prompt reached the substitute AND the audit copy on disk.
  assert.match(cursorPrompt, /^## Continuation of an interrupted run/);
  assert.match(cursorPrompt, /Task: build the thing/);
  assert.match(readFileSync(join(run.sessionDir, 'builder', 'prompts', 'user.md'), 'utf8'), /^## Continuation/);

  // The roster agent was mutated in place: later phases stay on the substitute.
  assert.equal(cfg.agents[0].coding_agent, 'cursor');
});

test('relay off: the run dies with the engine; the marker is still written; no relay', async () => {
  const { cfg, run, phase, call } = makeSetup('off');
  await withBins(['cursor-agent'], () =>
    withAdapters(
      {
        claude_code: async () => deadResult('API Error: 429 usage limit reached'),
      },
      async () => {
        await assert.rejects(execute(run, phase, call), EngineFailure);
      },
    ),
  );
  assert.ok(existsSync(join(run.sessionDir, 'builder', ENGINE_ERROR_FILE)));
  const events = readEvents(run);
  assert.equal(events.filter((e) => e.type === 'engine_error').length, 1);
  assert.equal(events.filter((e) => e.type === 'engine_relay').length, 0);
  assert.equal(cfg.agents[0].coding_agent, 'claude_code', 'off must never switch engines');
});

test('crash: first crash retries the same engine with the preamble; success clears the marker', async () => {
  const { run, phase, call } = makeSetup();
  let claudeCalls = 0;
  let secondPrompt = '';
  await withBins(['cursor-agent'], () =>
    withAdapters(
      {
        claude_code: async (req) => {
          claudeCalls += 1;
          if (claudeCalls === 1) return deadResult('segmentation fault');
          secondPrompt = req.prompt;
          return okResult();
        },
      },
      async () => {
        const envelope = await execute(run, phase, call);
        assert.equal(envelope.status, 'success');
      },
    ),
  );
  assert.equal(claudeCalls, 2, 'one cold retry on the SAME engine');
  assert.match(secondPrompt, /^## Continuation of an interrupted run/);
  const events = readEvents(run);
  assert.equal(events.filter((e) => e.type === 'engine_relay').length, 0);
  // The engine that died later succeeded — the death is forgotten.
  assert.equal(existsSync(join(run.sessionDir, 'builder', ENGINE_ERROR_FILE)), false);
});

test('crash: the second consecutive crash walks the chain', async () => {
  const { run, phase, call } = makeSetup();
  const calls = { claude: 0, cursor: 0 };
  await withBins(['cursor-agent'], () =>
    withAdapters(
      {
        claude_code: async () => {
          calls.claude += 1;
          return deadResult('segmentation fault');
        },
        cursor: async () => {
          calls.cursor += 1;
          return okResult();
        },
      },
      async () => {
        const envelope = await execute(run, phase, call);
        assert.equal(envelope.status, 'success');
      },
    ),
  );
  assert.equal(calls.claude, 2);
  assert.equal(calls.cursor, 1);
  const events = readEvents(run);
  assert.equal(events.filter((e) => e.type === 'engine_relay').length, 1);
  const marker = JSON.parse(readFileSync(join(run.sessionDir, 'builder', ENGINE_ERROR_FILE), 'utf8'));
  assert.equal(marker.kind, 'crash');
  assert.equal(marker.count, 2);
});

test('relay: chain exhausted rethrows the engine failure (normal fail + resume hint path)', async () => {
  const { run, phase, call } = makeSetup();
  await withBins([], () =>
    // cursor-agent NOT on the fake PATH prefix — but it may exist on the real
    // machine, so the fallback fake also dies to prove exhaustion either way.
    withAdapters(
      {
        claude_code: async () => deadResult('API Error: 429 usage limit reached'),
        cursor: async () => deadResult('API Error: 429 usage limit reached'),
      },
      async () => {
        await assert.rejects(execute(run, phase, call), EngineFailure);
      },
    ),
  );
});

test('resume: ensure() walks the fallbacks when the interrupted run left a marker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-relay-ensure-'));
  const dataDir = join(root, 'data');
  mkdirSync(join(dataDir, 'sessions', 'r9', 'builder'), { recursive: true });
  writeFileSync(
    join(dataDir, 'sessions', 'r9', 'builder', ENGINE_ERROR_FILE),
    JSON.stringify({ agent: 'builder', coding_agent: 'claude_code', model: 'sonnet', kind: 'limit', count: 1 }),
  );
  const cfg = {
    defaults: { data_dir: dataDir },
    observability: { db: join(root, 'fia.db') },
    agents: [
      {
        name: 'builder',
        coding_agent: 'claude_code',
        model: 'sonnet',
        fallbacks: [{ coding_agent: 'cursor', model: 'composer' }],
      },
    ],
  };
  await withBins(['claude', 'cursor-agent'], async () => {
    ensure(cfg, 'r9', { resume: true });
    assert.equal(cfg.agents[0].coding_agent, 'cursor', 'marker must arm the chain even with the binary present');
    const events = readFileSync(join(dataDir, 'sessions', 'r9', 'events.jsonl'), 'utf8');
    assert.match(events, /engine_fallback/);
    assert.match(events, /"runtime":true/);
    assert.match(events, /failed during the interrupted run \(limit\)/);
  });
});

test('resume: marker with no viable fallback retries the primary loudly (never blocks)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-relay-ensure-'));
  const dataDir = join(root, 'data');
  mkdirSync(join(dataDir, 'sessions', 'r10', 'builder'), { recursive: true });
  writeFileSync(
    join(dataDir, 'sessions', 'r10', 'builder', ENGINE_ERROR_FILE),
    JSON.stringify({ agent: 'builder', coding_agent: 'claude_code', model: 'sonnet', kind: 'limit', count: 1 }),
  );
  const cfg = {
    defaults: { data_dir: dataDir },
    observability: { db: join(root, 'fia.db') },
    agents: [{ name: 'builder', coding_agent: 'claude_code', model: 'sonnet' }],
  };
  await withBins(['claude'], async () => {
    ensure(cfg, 'r10', { resume: true });
    assert.equal(cfg.agents[0].coding_agent, 'claude_code');
    const events = readFileSync(join(dataDir, 'sessions', 'r10', 'events.jsonl'), 'utf8');
    assert.match(events, /engine_retry_after_failure/);
  });
});

test('resume: a crash marker with count 1 does NOT arm the chain at ensure()', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-relay-ensure-'));
  const dataDir = join(root, 'data');
  mkdirSync(join(dataDir, 'sessions', 'r11', 'builder'), { recursive: true });
  writeFileSync(
    join(dataDir, 'sessions', 'r11', 'builder', ENGINE_ERROR_FILE),
    JSON.stringify({ agent: 'builder', coding_agent: 'claude_code', model: 'sonnet', kind: 'crash', count: 1 }),
  );
  const cfg = {
    defaults: { data_dir: dataDir },
    observability: { db: join(root, 'fia.db') },
    agents: [
      {
        name: 'builder',
        coding_agent: 'claude_code',
        model: 'sonnet',
        fallbacks: [{ coding_agent: 'cursor', model: 'composer' }],
      },
    ],
  };
  await withBins(['claude', 'cursor-agent'], async () => {
    ensure(cfg, 'r11', { resume: true });
    assert.equal(cfg.agents[0].coding_agent, 'claude_code', 'single crash retries the chosen engine');
  });
});
