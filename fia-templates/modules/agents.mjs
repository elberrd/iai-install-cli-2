import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import * as agentPi from './agent-pi.mjs';
import * as agentClaude from './agent-claude.mjs';
import * as agentCursor from './agent-cursor.mjs';
import * as prompts from './prompts.mjs';
import * as permissions from './permissions.mjs';
import { makeStreamRecorder } from './stream-events.mjs';
import { extractJson, getOutputSchema } from './envelopes.mjs';
import { gateReport } from './gates.mjs';

const JSON_FIX_ATTEMPTS = 2;

export class GateFailure extends Error {}

export function loadConfig(path = 'imp/fia.config.yaml') {
  const raw = parseYaml(readFileSync(path, 'utf8')) || {};
  const defaults = raw.defaults || {};
  for (const agent of raw.agents || []) {
    for (const key of [
      'coding_agent',
      'model',
      'thinking',
      'effort',
      'tools',
      'writes',
      'harness_engineering',
      'fallbacks',
    ]) {
      if (defaults[key] !== undefined && agent[key] === undefined) agent[key] = defaults[key];
    }
    if (!agent.harness_engineering) agent.harness_engineering = defaults.harness_engineering || [];
  }
  return raw;
}

export function resolve(cfg, name) {
  const agent = (cfg.agents || []).find((a) => a.name === name);
  if (!agent) {
    const available = (cfg.agents || []).map((a) => a.name).join(', ');
    throw new Error(`agent "${name}" is not defined in the config — available: ${available}`);
  }
  return agent;
}

export function validate(cfg, required) {
  const problems = [];
  // Remember which agents this FDA actually uses — engine fallback resolution
  // (session.ensure) fails fast only for these, and merely warns for the rest.
  Object.defineProperty(cfg, '_required', { value: [...required], enumerable: false, configurable: true });
  for (const name of required) {
    try {
      const agent = resolve(cfg, name);
      if (!['pi', 'claude_code', 'cursor'].includes(agent.coding_agent)) {
        problems.push(`agent ${name}: coding_agent ${agent.coding_agent} not supported`);
      }
      for (const [i, fb] of (Array.isArray(agent.fallbacks) ? agent.fallbacks : []).entries()) {
        if (
          !fb ||
          !['pi', 'claude_code', 'cursor'].includes(fb.coding_agent) ||
          typeof fb.model !== 'string' ||
          !fb.model.trim()
        ) {
          problems.push(`agent ${name}: fallbacks[${i}] needs coding_agent (pi|claude_code|cursor) and a model`);
        }
      }
      for (const [label, ref] of [
        ['system', agent.prompt_engineering?.system],
        ['user', agent.prompt_engineering?.user],
      ]) {
        try {
          readFileSync(ref);
        } catch {
          problems.push(`agent ${name}: ${label} prompt not found: ${ref}`);
        }
      }
    } catch (e) {
      problems.push(e.message);
    }
  }
  if (problems.length) {
    throw new Error('config validation failed:\n- ' + problems.join('\n- '));
  }
}

/**
 * Session to RESUME for engines that mint their own ids (claude, cursor):
 * only a session we actually saw before counts — passing an invented id to
 * `--resume` would fail. Pi keeps its session in a file, so it never resumes by id.
 */
function resumeSessionId(run, agent) {
  const entry = run.agentMap[agent.name];
  if (entry && entry.model === agent.model && entry.session_id) return entry.session_id;
  return null;
}

async function send(run, phase, agent, promptText, systemText, sessionMeta) {
  const agentDir = join(run.sessionDir, agent.name);
  mkdirSync(agentDir, { recursive: true });
  const rawOutputPath = join(agentDir, 'raw_output.jsonl');
  const sessionFile = join(agentDir, 'pi_session.jsonl');
  const onEvent = makeStreamRecorder(run, phase, agent);

  if (agent.coding_agent === 'claude_code') {
    return agentClaude.runClaude(
      {
        prompt: promptText,
        systemPrompt: systemText,
        model: agent.model,
        effort: agent.effort,
        thinking: agent.thinking,
        sessionId: sessionMeta.sessionId,
        rawOutputPath,
        cwd: run.repoRoot,
        env: run.env,
      },
      {
        onEvent,
        onSpawn: (pid) => run.tracer.processStart(run.fdaId, 'agent', agent.name, pid, `claude ${agent.name}`),
        onExit: (pid) => run.tracer.processEnd(run.fdaId, pid),
      },
    );
  }

  if (agent.coding_agent === 'cursor') {
    return agentCursor.runCursor(
      {
        prompt: promptText,
        systemPrompt: systemText,
        model: agent.model,
        sessionId: sessionMeta.sessionId,
        rawOutputPath,
        cwd: run.repoRoot,
        env: run.env,
      },
      {
        onEvent,
        onSpawn: (pid) => run.tracer.processStart(run.fdaId, 'agent', agent.name, pid, `cursor ${agent.name}`),
        onExit: (pid) => run.tracer.processEnd(run.fdaId, pid),
      },
    );
  }

  return agentPi.runPi(
    {
      prompt: promptText,
      systemPrompt: systemText,
      model: agent.model,
      thinking: agent.thinking || 'medium',
      sessionFile,
      rawOutputPath,
      tools: agent.tools,
      extensions: agent.harness_engineering || [],
      cwd: run.repoRoot,
      env: run.env,
    },
    {
      onEvent,
      onSpawn: (pid) => run.tracer.processStart(run.fdaId, 'agent', agent.name, pid, `pi ${agent.name}`),
      onExit: (pid) => run.tracer.processEnd(run.fdaId, pid),
    },
  );
}

/**
 * Does the raw engine output contain an actual Report envelope? ANY `{...}` is
 * not enough — CLI error payloads like `API Error: 429 {"type":"error",...}`
 * parse as JSON but must NOT suppress the fail-fast path (they would only die
 * later as a misleading "never produced valid JSON"). Every envelope schema
 * requires a string `status`, so that field is the discriminator.
 */
function containsEnvelope(text) {
  try {
    const payload = extractJson(text);
    return Boolean(payload) && typeof payload.status === 'string';
  } catch {
    return false;
  }
}

/** Last ~10 stderr lines recorded in raw_output.jsonl (fallback: output tail). */
function stderrTail(rawOutputPath, fallbackText) {
  let lines = [];
  try {
    lines = readFileSync(rawOutputPath, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('[stderr]'))
      .map((l) => l.slice('[stderr]'.length).trim())
      .filter(Boolean);
  } catch {
    /* no raw output captured */
  }
  if (!lines.length)
    lines = String(fallbackText || '')
      .split('\n')
      .filter((l) => l.trim());
  return lines.slice(-10);
}

/** Recovery hint matched against the failure text — cause + exact command. */
function engineHint(text, agent) {
  const t = String(text).toLowerCase();
  if (
    /log ?in|logged out|log out|credential|unauthorized|unauthenticated|authentication|auth error|401|token expired|expired token/.test(
      t,
    )
  ) {
    const cmd =
      { claude_code: '`claude`', pi: '`pi` and then /login', cursor: '`cursor-agent login`' }[agent.coding_agent] ||
      agent.coding_agent;
    return `This looks like a login problem. Open a terminal, run ${cmd}, sign in again, then re-run this FDA.`;
  }
  if (
    /rate limit|rate-limit|limit reached|usage limit|weekly limit|too many requests|429|quota|overloaded|capacity/.test(
      t,
    )
  ) {
    return 'This looks like your subscription plan limit. Limits reset on their own — wait a while and re-run this FDA. No extra payment is needed.';
  }
  return `The ${agent.coding_agent} CLI exited with an error before answering. Re-run this FDA; if it persists, run the CLI by hand to see the problem.`;
}

async function parseWithRetries(run, phase, call, result, sendFn) {
  const schema = getOutputSchema(call.outputType);
  for (let attempt = 1; attempt <= JSON_FIX_ATTEMPTS + 1; attempt++) {
    try {
      const payload = extractJson(result.text);
      return { envelope: schema.parse(payload), attempt };
    } catch (error) {
      if (attempt > JSON_FIX_ATTEMPTS) {
        throw new Error(`${phase.params.owner} never produced valid ${call.outputType} JSON: ${error.message}`);
      }
      run.console.retry(phase.params.owner, attempt, JSON_FIX_ATTEMPTS, String(error.message));
      const fields = Object.keys(schema.shape || {}).join(', ');
      result = await sendFn(
        `Your response was not valid JSON (${error.message}). Respond again with ONLY a JSON object with fields: ${fields}. No prose.`,
      );
    }
  }
}

export async function execute(run, phase, call) {
  const agent = resolve(run.cfg, phase.params.owner);
  const variables = {
    prompt: call.prompt,
    previous_envelope: call.previous ? JSON.stringify(call.previous, null, 2) : '(none)',
    context_handoff_dir: run.contextHandoffDir,
  };
  const systemText = prompts.render(agent.prompt_engineering.system, variables);
  const userText = prompts.render(agent.prompt_engineering.user, variables);
  const agentDir = join(run.sessionDir, agent.name);
  mkdirSync(join(agentDir, 'prompts'), { recursive: true });
  prompts.savePromptDir(join(agentDir, 'prompts'), 'system.md', systemText);
  prompts.savePromptDir(join(agentDir, 'prompts'), 'user.md', userText);

  // Resume only a session we've actually seen; engines mint the real id on the
  // first send and corrections MUST continue that same session.
  let sessionId = resumeSessionId(run, agent);
  run.tracer.event({
    fda_id: run.fdaId,
    phase_id: phase.phase_id,
    type: 'agent_start',
    name: agent.name,
    payload: { model: agent.model, coding_agent: agent.coding_agent, session_id: sessionId || '(new)' },
  });
  run.console.agentStarted(agent.name, agent.model, sessionId || '(new)');

  const treeBefore = permissions.snapshot(run);
  const rawOutputPath = join(agentDir, 'raw_output.jsonl');
  let spentTokens = 0;
  let spentCost = 0;
  let spentCacheRead = 0;
  let spentCacheWrite = 0;
  // Set true the moment enforce STARTS on the happy path, so the error path
  // never runs it twice (a PermissionBreach from enforce itself included).
  let enforced = false;

  const doSend = async (promptText) => {
    const result = await send(run, phase, agent, promptText, systemText, { sessionId });
    if (result.returncode === 127) {
      throw new Error(`${agent.name} (${agent.coding_agent}): ${result.text}`);
    }
    // Any other non-zero exit without a parseable envelope (not logged in, plan
    // limit, invalid session…) fails IMMEDIATELY with the engine's own words —
    // burning JSON-fix attempts on it would only hide the real cause.
    if (result.returncode !== 0 && !containsEnvelope(result.text)) {
      const tail = stderrTail(rawOutputPath, result.text);
      throw new Error(
        `${agent.name} (${agent.coding_agent}) exited with code ${result.returncode} without a report.\n` +
          (tail.length ? `Engine output (last lines):\n  ${tail.join('\n  ')}\n` : '') +
          engineHint(`${tail.join('\n')}\n${result.text}`, agent),
      );
    }
    if (result.session_id) sessionId = result.session_id;
    run.addUsage(result.tokens, result.cost);
    spentTokens += result.tokens;
    spentCost += result.cost;
    spentCacheRead += result.cache_read_tokens || 0;
    spentCacheWrite += result.cache_write_tokens || 0;
    return result;
  };

  try {
    let result = await doSend(userText);
    let { envelope, attempt } = await parseWithRetries(run, phase, call, result, doSend);

    for (let gateAttempt = 1; gateAttempt <= Math.max(1, (phase.params.retries || 0) + 1); gateAttempt++) {
      const violations = [];
      for (const gate of call.gates || []) {
        const raw = gate(envelope, run);
        const report = raw.checks ? raw : gateReportFromList(raw);
        run.tracer.gateRow(phase, gate.name || 'gate', report, gateAttempt);
        run.tracer.event({
          fda_id: run.fdaId,
          phase_id: phase.phase_id,
          type: report.passed ? 'gate_pass' : 'gate_fail',
          name: gate.name || 'gate',
          payload: { attempt: gateAttempt, checks: report.checks.length, violations: report.violations },
        });
        run.console.gateResult(gate.name || 'gate', report);
        violations.push(...report.violations);
      }
      if (!violations.length) break;
      if (gateAttempt > (phase.params.retries || 0)) {
        throw new GateFailure(`${agent.name} failed gates:\n- ${violations.join('\n- ')}`);
      }
      const correction =
        'Your previous response failed validation:\n- ' +
        violations.join('\n- ') +
        '\n\nFix these problems, then re-emit ONLY your Report JSON.';
      result = await doSend(correction);
      ({ envelope, attempt } = await parseWithRetries(run, phase, call, result, doSend));
    }

    enforced = true;
    permissions.enforce(run, phase, agent, treeBefore);

    writeFileSync(
      join(agentDir, 'envelope.json'),
      JSON.stringify({ agent_name: agent.name, output_type: call.outputType, attempt, ...envelope }, null, 2),
    );
    run.tracer.envelopeRow(phase, agent.name, call.outputType, JSON.stringify(envelope), true, attempt);
    run.console.envelopeSummary(envelope);

    run.saveAgentMap(agent.name, {
      session_id: sessionId || result.session_id || '',
      model: agent.model,
      coding_agent: agent.coding_agent,
    });
    run.tracer.agentSessionRow(
      run.fdaId,
      agent,
      sessionId || result.session_id || '',
      result.context_tokens || 0,
      result.context_window || 0,
    );
    run.tracer.event({
      fda_id: run.fdaId,
      phase_id: phase.phase_id,
      type: 'agent_end',
      name: agent.name,
      tokens: spentTokens,
      // cache_read/cache_write measure the phase's hit rate (cached reads cost
      // ~10% of input on both plans) — a sharp drop = unstable prefix.
      // model/coding_agent stamp the spend at the moment it happened: the
      // per-LLM usage ledger groups by THIS, so editing the roster later (or a
      // fallback on a future run) never re-attributes what this model spent.
      payload: {
        cost: spentCost,
        cache_read: spentCacheRead,
        cache_write: spentCacheWrite,
        model: agent.model,
        coding_agent: agent.coding_agent,
      },
    });
    run.console.agentFinished(agent.name, spentTokens, spentCost);

    if (envelope.status !== 'success') {
      throw new Error(`${agent.name} reported status=${envelope.status}: ${envelope.summary}`);
    }
    return envelope;
  } catch (error) {
    // A failing run must not leave unauthorized writes behind: enforce (and
    // roll back) on the error path too — but a secondary breach never masks
    // the original failure, it is logged and appended as a note.
    if (!enforced) {
      try {
        permissions.enforce(run, phase, agent, treeBefore);
      } catch (breach) {
        run.tracer.event({
          fda_id: run.fdaId,
          phase_id: phase.phase_id,
          type: 'error',
          name: 'permission_breach_during_failure',
          payload: { agent: agent.name, error: String(breach.message || breach).slice(0, 1000) },
        });
        try {
          error.message += `\n(also: unauthorized changes were rolled back — ${String(breach.message || breach)})`;
        } catch {
          /* read-only message — the original error still propagates */
        }
      }
    }
    // The tokens this attempt burned are already in the session totals
    // (addUsage runs on every send) — stamp them for the per-LLM ledger too,
    // or every failed phase's spend silently vanishes from the Agents tab.
    // A distinct type keeps timeline consumers of `agent_end` unaffected.
    if (spentTokens > 0) {
      try {
        run.tracer.event({
          fda_id: run.fdaId,
          phase_id: phase.phase_id,
          type: 'agent_spend',
          name: agent.name,
          tokens: spentTokens,
          payload: {
            cost: spentCost,
            cache_read: spentCacheRead,
            cache_write: spentCacheWrite,
            model: agent.model,
            coding_agent: agent.coding_agent,
            failed: true,
          },
        });
      } catch {
        /* tracing must never mask the original failure */
      }
    }
    throw error;
  }
}

function gateReportFromList(list) {
  const report = gateReport();
  for (const v of list || []) report.check(String(v), false, String(v));
  return report;
}
