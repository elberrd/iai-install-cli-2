/**
 * Engine readiness — deterministic, local-only checks of which coding engines
 * (claude_code, pi, cursor) can actually run on this machine, plus the
 * fallback resolution used at the start of every FDA run.
 *
 * Hard signals only: a missing binary, or a Pi provider with neither an OAuth
 * entry in ~/.pi/agent/auth.json nor its API-key env var. Soft signals (e.g.
 * "claude is installed but we cannot prove it is logged in") are reported for
 * display but never trigger a fallback — the engine itself is the authority.
 *
 * Fallbacks are declared per agent in imp/fia.config.yaml:
 *   fallbacks:
 *     - { coding_agent: pi, model: openai-codex/gpt-5.6-sol, thinking: high }
 * Resolution happens ONCE, at run start — never mid-run.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';

const PI_AUTH_PATH = join(homedir(), '.pi', 'agent', 'auth.json');

/** Pi providers that authenticate through an env var instead of /login. */
export const PI_ENV_KEYS = {
  openrouter: 'OPENROUTER_API_KEY',
  xai: 'XAI_API_KEY',
  groq: 'GROQ_API_KEY',
  google: 'GEMINI_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

/** Providers whose login lives in ~/.pi/agent/auth.json (subscription OAuth). */
export const PI_OAUTH_PROVIDERS = ['openai-codex', 'github-copilot'];

export const ENGINE_NAMES = ['claude_code', 'pi', 'cursor'];
export const ENGINE_BINS = { claude_code: 'claude', pi: 'pi', cursor: 'cursor-agent' };

/** Is `bin` reachable on PATH? (no shell involved; Windows gets .exe/.cmd) */
export function binOnPath(bin, env = process.env) {
  const dirs = String(env.PATH || '').split(delimiter);
  const names = process.platform === 'win32' ? [bin, `${bin}.exe`, `${bin}.cmd`] : [bin];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      if (existsSync(join(dir, name))) return true;
    }
  }
  return false;
}

export function readPiAuth(path = PI_AUTH_PATH) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** First path segment of a Pi model id ("openrouter/x/y" → "openrouter"). */
export function providerOfModel(model) {
  const i = String(model || '').indexOf('/');
  return i === -1 ? null : String(model).slice(0, i);
}

/** Can Pi reach this provider right now? OAuth entry or API-key env var. */
export function piProviderReady(provider, auth = readPiAuth(), env = process.env) {
  const entry = auth?.[provider];
  if (entry) {
    if (entry.type === 'oauth' && (entry.access || entry.refresh)) return true;
    if (entry.type === 'api_key' && entry.key) return true;
    if (entry.refresh || entry.token) return true;
  }
  const envKey = PI_ENV_KEYS[provider];
  return Boolean(envKey && env[envKey]);
}

/**
 * Best-effort "is claude logged in" — display only, never a fallback trigger.
 * ~/.claude.json carries the account after any successful login; on macOS the
 * actual credential may live in the Keychain, so absence proves nothing.
 */
function claudeLoggedHint() {
  try {
    const cfgPath = join(homedir(), '.claude.json');
    if (existsSync(join(homedir(), '.claude', '.credentials.json'))) return true;
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      if (cfg && (cfg.oauthAccount || cfg.hasCompletedOnboarding)) return true;
    }
  } catch {
    /* display hint only — never block on a parse error */
  }
  return null; // unknown
}

/**
 * The generic `agent` binary name only counts as Cursor when it proves itself:
 * anything could ship a binary called "agent", so `agent --version` must
 * mention cursor before the engine is considered installed under that name.
 */
function agentBinIsCursor(env = process.env) {
  if (!binOnPath('agent', env)) return false;
  try {
    const out = execFileSync('agent', ['--version'], {
      env,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return /cursor/i.test(out);
  } catch {
    return false; // not executable, hung, or not Cursor — never block on it
  }
}

/**
 * Snapshot of every engine's state on this machine.
 * `logged: null` means "cannot tell locally" (the CLI itself is the authority).
 */
export function checkEngines(env = process.env) {
  const auth = readPiAuth() || {};
  const providers = {};
  const names = new Set([...PI_OAUTH_PROVIDERS, ...Object.keys(PI_ENV_KEYS), ...Object.keys(auth)]);
  for (const p of names) providers[p] = piProviderReady(p, auth, env);
  return {
    claude_code: { installed: binOnPath(ENGINE_BINS.claude_code, env), logged: claudeLoggedHint() },
    pi: { installed: binOnPath(ENGINE_BINS.pi, env), providers },
    // Cursor ships as `cursor-agent`, but the adapter also accepts the newer
    // `agent` binary name — the latter only after `agent --version` proves it
    // is actually Cursor (the name is too generic to trust on its own).
    cursor: { installed: binOnPath(ENGINE_BINS.cursor, env) || agentBinIsCursor(env), logged: null },
  };
}

/**
 * Hard-signal reason why `{ coding_agent, model }` cannot run, or null when it
 * can (as far as local checks can tell).
 */
export function engineIssue({ coding_agent, model }, engines) {
  if (coding_agent === 'claude_code') {
    return engines.claude_code.installed ? null : 'claude CLI not found on PATH (npm install -g @anthropic-ai/claude-code, then run `claude` once to log in)';
  }
  if (coding_agent === 'cursor') {
    return engines.cursor.installed ? null : 'cursor-agent not found on PATH (curl https://cursor.com/install -fsS | bash, then `cursor-agent login`)';
  }
  if (coding_agent === 'pi') {
    if (!engines.pi.installed) return 'pi not found on PATH (npm install -g @earendil-works/pi-coding-agent)';
    const provider = providerOfModel(model);
    if (provider && !engines.pi.providers[provider]) {
      const envKey = PI_ENV_KEYS[provider];
      return envKey
        ? `Pi provider "${provider}" has no ${envKey} set`
        : `Pi provider "${provider}" is not logged in (run \`pi\`, then /login ${provider})`;
    }
    return null;
  }
  return `unknown coding_agent "${coding_agent}"`;
}

/**
 * Resolve the effective engine for each agent, walking its fallback chain when
 * the primary is hard-unavailable. MUTATES cfg agents in place and returns
 * { engines, decisions } — one decision per inspected agent:
 *   { agent, changed:false }                              primary is fine
 *   { agent, changed:true, from, to, reason }             fell back
 *   { agent, changed:false, blocked:true, reason }        nothing available
 */
/**
 * Provider the EFFECTIVE engine bills per token through (API key), or null when
 * it runs inside a subscription (claude_code, cursor, Pi OAuth providers).
 * Used to print a loud warning at run start — never to block anything.
 */
export function apiKeyProvider(agent) {
  if (agent.coding_agent !== 'pi') return null;
  const provider = providerOfModel(agent.model);
  if (!provider || PI_OAUTH_PROVIDERS.includes(provider)) return null;
  return provider;
}

export function resolveEngines(cfg, required = null) {
  const engines = checkEngines();
  const decisions = [];
  for (const agent of cfg.agents || []) {
    if (required && !required.includes(agent.name)) continue;
    const reason = engineIssue(agent, engines);
    let decision;
    if (!reason) {
      decision = { agent: agent.name, changed: false };
    } else {
      const chain = Array.isArray(agent.fallbacks) ? agent.fallbacks : [];
      const pick = chain.find((fb) => fb && !engineIssue(fb, engines));
      if (pick) {
        const from = { coding_agent: agent.coding_agent, model: agent.model };
        agent.coding_agent = pick.coding_agent;
        agent.model = pick.model;
        if (pick.effort !== undefined) agent.effort = pick.effort;
        if (pick.thinking !== undefined) agent.thinking = pick.thinking;
        decision = {
          agent: agent.name,
          changed: true,
          from,
          to: { coding_agent: pick.coding_agent, model: pick.model },
          reason,
        };
      } else {
        decision = { agent: agent.name, changed: false, blocked: true, reason };
      }
    }
    // Flag per-token billing on the engine that will ACTUALLY run (post-fallback).
    const provider = decision.blocked ? null : apiKeyProvider(agent);
    if (provider) decision.api_key_provider = provider;
    decisions.push(decision);
  }
  return { engines, decisions };
}
