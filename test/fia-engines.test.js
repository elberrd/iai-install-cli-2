// Behavioral tests for fia-templates/modules/engines.mjs — provider parsing,
// Pi provider readiness (auth.json vs env keys), hard-signal engine issues and
// the fallback resolution that runs at the start of every FDA.
//
// The module resolves ~/.pi/agent/auth.json ONCE at load time (module-level
// const), so HOME/USERPROFILE are pointed at a temp dir BEFORE the dynamic
// import below. Everything else (`piProviderReady`, `engineIssue`) accepts
// injected auth/env/engines objects; `resolveEngines` reads process.env at
// call time, so those tests swap PATH/env vars and restore them in finally.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Fake HOME before the import: auth.json lives under our control from here on.
const fakeHome = mkdtempSync(join(tmpdir(), 'fia-engines-home-'));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome; // Windows homedir()
const piDir = join(fakeHome, '.pi', 'agent');
mkdirSync(piDir, { recursive: true });

const {
  PI_ENV_KEYS,
  providerOfModel,
  piProviderReady,
  readPiAuth,
  engineIssue,
  resolveEngines,
  apiKeyProvider,
} = await import('../fia-templates/modules/engines.mjs');

// ── providerOfModel ──────────────────────────────────────────────────────────

test('providerOfModel: valid and degenerate model ids', () => {
  assert.equal(providerOfModel('openai-codex/gpt-5.6-sol'), 'openai-codex');
  assert.equal(providerOfModel('openrouter/moonshotai/kimi-k3'), 'openrouter');
  // No slash (claude_code style alias) → no Pi provider.
  assert.equal(providerOfModel('sonnet'), null);
  assert.equal(providerOfModel(''), null);
  assert.equal(providerOfModel(null), null);
  assert.equal(providerOfModel(undefined), null);
  // Degenerate but accepted: a leading slash yields an empty provider (the
  // caller treats a falsy provider as "no provider to check").
  assert.equal(providerOfModel('/gpt'), '');
  assert.equal(providerOfModel(42), null); // coerced to '42', no slash
});

// ── piProviderReady (injected auth + env) ────────────────────────────────────

test('piProviderReady: OAuth entry in auth.json wins without any env key', () => {
  const auth = { 'openai-codex': { type: 'oauth', access: 'tok', refresh: 'ref' } };
  assert.equal(piProviderReady('openai-codex', auth, {}), true);
  // access-only and refresh-only are both accepted.
  assert.equal(piProviderReady('openai-codex', { 'openai-codex': { type: 'oauth', access: 'x' } }, {}), true);
  assert.equal(piProviderReady('openai-codex', { 'openai-codex': { type: 'oauth', refresh: 'x' } }, {}), true);
  // oauth entry without any token is NOT ready (and openai-codex has no env fallback).
  assert.equal(piProviderReady('openai-codex', { 'openai-codex': { type: 'oauth' } }, {}), false);
});

test('piProviderReady: api_key entries and loose token shapes in auth.json', () => {
  assert.equal(piProviderReady('groq', { groq: { type: 'api_key', key: 'k' } }, {}), true);
  assert.equal(piProviderReady('groq', { groq: { type: 'api_key' } }, {}), false);
  // Unknown entry types still count when they carry a refresh/token field.
  assert.equal(piProviderReady('foo', { foo: { token: 't' } }, {}), true);
  assert.equal(piProviderReady('foo', { foo: { refresh: 'r' } }, {}), true);
});

test('piProviderReady: env var fallback per provider', () => {
  assert.equal(piProviderReady('openrouter', {}, { OPENROUTER_API_KEY: 'k' }), true);
  assert.equal(piProviderReady('openrouter', {}, {}), false);
  assert.equal(piProviderReady('openrouter', null, { OPENROUTER_API_KEY: 'k' }), true);
  // Provider without a mapped env var and without auth entry → not ready.
  assert.equal(piProviderReady('github-copilot', {}, {}), false);
  // Every declared env key actually flips readiness.
  for (const [provider, envKey] of Object.entries(PI_ENV_KEYS)) {
    assert.equal(piProviderReady(provider, {}, { [envKey]: 'x' }), true, `${provider} via ${envKey}`);
  }
});

test('readPiAuth: missing and corrupt auth.json both yield null', () => {
  assert.equal(readPiAuth(join(fakeHome, 'nope.json')), null);
  const corrupt = join(fakeHome, 'corrupt.json');
  writeFileSync(corrupt, '{not json');
  assert.equal(readPiAuth(corrupt), null);
});

// ── engineIssue (injected engines snapshot) ──────────────────────────────────

const OFFLINE = {
  claude_code: { installed: false, logged: null },
  pi: { installed: false, providers: {} },
  cursor: { installed: false, logged: null },
};
const ONLINE = {
  claude_code: { installed: true, logged: true },
  pi: { installed: true, providers: { 'openai-codex': true } },
  cursor: { installed: true, logged: null },
};

test('engineIssue: missing binaries produce recovery instructions', () => {
  const claude = engineIssue({ coding_agent: 'claude_code', model: 'opus' }, OFFLINE);
  assert.match(claude, /claude CLI not found on PATH/);
  assert.match(claude, /npm install -g @anthropic-ai\/claude-code/); // cause + exact fix

  const cursor = engineIssue({ coding_agent: 'cursor', model: 'x' }, OFFLINE);
  assert.match(cursor, /cursor-agent not found on PATH/);

  const pi = engineIssue({ coding_agent: 'pi', model: 'openai-codex/gpt' }, OFFLINE);
  assert.match(pi, /pi not found on PATH/);
});

test('engineIssue: installed engines pass; Pi still needs a ready provider', () => {
  assert.equal(engineIssue({ coding_agent: 'claude_code', model: 'opus' }, ONLINE), null);
  assert.equal(engineIssue({ coding_agent: 'cursor', model: 'x' }, ONLINE), null);
  assert.equal(engineIssue({ coding_agent: 'pi', model: 'openai-codex/gpt' }, ONLINE), null);

  // OAuth provider not logged in → points at /login, never at an API key.
  const oauth = engineIssue({ coding_agent: 'pi', model: 'github-copilot/gpt' }, ONLINE);
  assert.match(oauth, /not logged in/);
  assert.match(oauth, /\/login github-copilot/);

  // Env-key provider names the exact variable that is missing.
  const envKey = engineIssue({ coding_agent: 'pi', model: 'groq/llama' }, ONLINE);
  assert.match(envKey, /GROQ_API_KEY/);

  assert.match(engineIssue({ coding_agent: 'nope', model: 'x' }, ONLINE), /unknown coding_agent "nope"/);
});

// ── apiKeyProvider (per-token billing warning source) ────────────────────────

test('apiKeyProvider: only Pi with a non-OAuth provider bills per token', () => {
  assert.equal(apiKeyProvider({ coding_agent: 'claude_code', model: 'opus' }), null);
  assert.equal(apiKeyProvider({ coding_agent: 'cursor', model: 'x' }), null);
  // Subscription OAuth providers run inside the plan → no warning.
  assert.equal(apiKeyProvider({ coding_agent: 'pi', model: 'openai-codex/gpt-5.6-sol' }), null);
  assert.equal(apiKeyProvider({ coding_agent: 'pi', model: 'github-copilot/gpt' }), null);
  // API-key providers are flagged (warning only — never a block).
  assert.equal(apiKeyProvider({ coding_agent: 'pi', model: 'openrouter/x/y' }), 'openrouter');
});

// ── resolveEngines (real checkEngines against a controlled PATH/HOME) ────────

/** Run fn with PATH pointing at a dir of fake binaries and no PI_* env keys. */
function withEnvironment({ bins = [], env = {} }, fn) {
  const binDir = mkdtempSync(join(tmpdir(), 'fia-engines-bin-'));
  for (const bin of bins) writeFileSync(join(binDir, bin), '#!/bin/sh\n');
  const saved = {};
  const touched = ['PATH', ...Object.values(PI_ENV_KEYS), ...Object.keys(env)];
  for (const key of touched) saved[key] = process.env[key];
  try {
    process.env.PATH = binDir;
    for (const key of Object.values(PI_ENV_KEYS)) delete process.env[key];
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('resolveEngines: falls back down the chain when the primary is unavailable', () => {
  // Machine state: only `pi` on PATH, logged into openai-codex via auth.json.
  writeFileSync(join(piDir, 'auth.json'), JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'tok' } }));
  withEnvironment({ bins: ['pi'] }, () => {
    const cfg = {
      agents: [
        {
          name: 'planner',
          coding_agent: 'claude_code',
          model: 'opus',
          effort: 'high',
          fallbacks: [{ coding_agent: 'pi', model: 'openai-codex/gpt-5.6-sol', thinking: 'high' }],
        },
        { name: 'builder', coding_agent: 'pi', model: 'openai-codex/gpt-5.6-sol' },
      ],
    };
    const { decisions } = resolveEngines(cfg);

    const planner = decisions.find((d) => d.agent === 'planner');
    assert.equal(planner.changed, true);
    assert.deepEqual(planner.from, { coding_agent: 'claude_code', model: 'opus' });
    assert.deepEqual(planner.to, { coding_agent: 'pi', model: 'openai-codex/gpt-5.6-sol' });
    assert.match(planner.reason, /claude CLI not found/);
    // The cfg agent is mutated in place — the run uses the fallback engine.
    assert.equal(cfg.agents[0].coding_agent, 'pi');
    assert.equal(cfg.agents[0].thinking, 'high');
    // OAuth fallback stays inside the subscription: no per-token flag.
    assert.equal(planner.api_key_provider, undefined);

    const builder = decisions.find((d) => d.agent === 'builder');
    assert.equal(builder.changed, false);
    assert.equal(builder.blocked, undefined);
  });
});

test('resolveEngines: agent with no viable fallback is blocked with the primary reason', () => {
  withEnvironment({ bins: [] }, () => {
    const cfg = {
      agents: [
        {
          name: 'stranded',
          coding_agent: 'claude_code',
          model: 'opus',
          fallbacks: [{ coding_agent: 'cursor', model: 'sonnet-4.5' }],
        },
      ],
    };
    const { decisions } = resolveEngines(cfg);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].blocked, true);
    assert.equal(decisions[0].changed, false);
    // The reason is the PRIMARY engine's issue — the message the user must fix first.
    assert.match(decisions[0].reason, /claude CLI not found/);
    // Blocked agents keep their configured engine (nothing mutated).
    assert.equal(cfg.agents[0].coding_agent, 'claude_code');
  });
});

test('resolveEngines: `required` restricts which agents are inspected', () => {
  withEnvironment({ bins: ['pi'] }, () => {
    const cfg = {
      agents: [
        { name: 'planner', coding_agent: 'pi', model: 'openai-codex/gpt' },
        { name: 'reviewer', coding_agent: 'claude_code', model: 'sonnet' },
      ],
    };
    const { decisions } = resolveEngines(cfg, ['planner']);
    // Only the required agent gets a decision; the broken reviewer is not
    // touched (its FDA does not need it). Fast-failing on blocked REQUIRED
    // agents is the caller's job (fda-cli) — resolveEngines only reports.
    assert.deepEqual(decisions.map((d) => d.agent), ['planner']);
  });
});

test('resolveEngines: flags per-token billing on the engine that actually runs', () => {
  withEnvironment({ bins: ['pi'], env: { OPENROUTER_API_KEY: 'k' } }, () => {
    const cfg = { agents: [{ name: 'scout', coding_agent: 'pi', model: 'openrouter/moonshotai/kimi-k3' }] };
    const { decisions } = resolveEngines(cfg);
    assert.equal(decisions[0].changed, false);
    // Loud warning material — the run is NOT blocked, only flagged.
    assert.equal(decisions[0].api_key_provider, 'openrouter');
  });
});

// ── resolveEngines with runtimeFailures (resume relay arming) ────────────────

test('resolveEngines: a runtime marker arms the chain even with the binary present', () => {
  withEnvironment({ bins: ['claude', 'cursor-agent'] }, () => {
    const cfg = {
      agents: [
        {
          name: 'builder',
          coding_agent: 'claude_code',
          model: 'sonnet',
          fallbacks: [{ coding_agent: 'cursor', model: 'composer' }],
        },
      ],
    };
    const { decisions } = resolveEngines(cfg, null, {
      runtimeFailures: { builder: { coding_agent: 'claude_code', model: 'sonnet', kind: 'limit', count: 1 } },
    });
    assert.equal(decisions[0].changed, true);
    assert.equal(decisions[0].runtime, true);
    assert.equal(decisions[0].kind, 'limit');
    assert.match(decisions[0].reason, /failed during the interrupted run \(limit\)/);
    assert.equal(cfg.agents[0].coding_agent, 'cursor');
  });
});

test('resolveEngines: a marker for a DIFFERENT identity is ignored (roster edited since)', () => {
  withEnvironment({ bins: ['claude'] }, () => {
    const cfg = { agents: [{ name: 'builder', coding_agent: 'claude_code', model: 'opus' }] };
    const { decisions } = resolveEngines(cfg, null, {
      runtimeFailures: { builder: { coding_agent: 'claude_code', model: 'sonnet', kind: 'limit', count: 1 } },
    });
    assert.equal(decisions[0].changed, false);
    assert.equal(decisions[0].retry_failed_engine, undefined);
    assert.equal(cfg.agents[0].model, 'opus');
  });
});

test('resolveEngines: a fallback equal to the dead identity is skipped', () => {
  withEnvironment({ bins: ['claude', 'cursor-agent'] }, () => {
    const cfg = {
      agents: [
        {
          name: 'builder',
          coding_agent: 'claude_code',
          model: 'sonnet',
          // First entry repeats the dead engine — walking onto it would just
          // die again; the chain must land on cursor.
          fallbacks: [
            { coding_agent: 'claude_code', model: 'sonnet' },
            { coding_agent: 'cursor', model: 'composer' },
          ],
        },
      ],
    };
    const { decisions } = resolveEngines(cfg, null, {
      runtimeFailures: { builder: { coding_agent: 'claude_code', model: 'sonnet', kind: 'login', count: 1 } },
    });
    assert.deepEqual(decisions[0].to, { coding_agent: 'cursor', model: 'composer' });
  });
});

test('resolveEngines: runtime-only failure with no fallback yields retry, never blocked', () => {
  withEnvironment({ bins: ['claude'] }, () => {
    const cfg = { agents: [{ name: 'builder', coding_agent: 'claude_code', model: 'sonnet' }] };
    const { decisions } = resolveEngines(cfg, null, {
      runtimeFailures: { builder: { coding_agent: 'claude_code', model: 'sonnet', kind: 'limit', count: 1 } },
    });
    assert.equal(decisions[0].blocked, undefined);
    assert.equal(decisions[0].retry_failed_engine, true);
    assert.match(decisions[0].reason, /failed during the interrupted run/);
    assert.equal(cfg.agents[0].coding_agent, 'claude_code');
  });
});
