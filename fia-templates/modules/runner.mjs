import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as fs from 'node:fs';
import { createConsole } from './console.mjs';
import { execute } from './agents.mjs';
import { loadOrCreateBaseline } from './git-helper.mjs';
import { nowIso } from './utils.mjs';

export class PhaseHandle {
  constructor(run, phase) {
    this.run = run;
    this.phase = phase;
  }

  log(payload) {
    this.run.tracer.event({
      fda_id: this.run.fdaId,
      phase_id: this.phase.phase_id,
      type: 'log',
      name: this.phase.params.name,
      payload,
    });
    this.run.console.note(Object.entries(payload).map(([k, v]) => `${k}: ${v}`).join(', '));
    if (this.phase.params.kind === 'engineer' && payload.input) {
      this.run.tracer.sessionRequest(this.run.fdaId, String(payload.input));
    }
  }

  call(call) {
    if (this.phase.params.kind !== 'agent') {
      throw new Error('ph.call() is only valid inside an agent phase');
    }
    return execute(this.run, this.phase, call);
  }
}

// One process-level handler: Ctrl+C / kill marks the session as failed in the
// trace (no eternal 'running' orphans) and exits with the conventional code.
let activeRun = null;
let signalsInstalled = false;
function installSignalHandlers() {
  if (signalsInstalled) return;
  signalsInstalled = true;
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.on(signal, () => {
      try {
        activeRun?.tracer.sessionFinish(activeRun.fdaId, false);
      } catch {
        /* best effort — the exit must not be blocked */
      }
      process.exit(code);
    });
  }
}

export class Run {
  constructor(cfg, fdaId, tracer, engineer, { resume = false } = {}) {
    this.cfg = cfg;
    this.fdaId = fdaId;
    this.tracer = tracer;
    this.console = createConsole(tracer, fdaId);
    this.engineer = engineer;
    this.resume = resume;
    this.phases = [];
    this.tokens = 0;
    this.cost = 0;
    this._seq = tracer.maxPhaseSeq(fdaId);
    this.repoRoot = process.cwd();
    this.fs = fs;
    this.env = { ...process.env };
    this.sessionDir = join(cfg.defaults?.data_dir || 'imp/data', 'sessions', fdaId);
    fs.mkdirSync(this.sessionDir, { recursive: true });
    this.contextHandoffDir = join(this.sessionDir, 'context_handoff');
    fs.mkdirSync(this.contextHandoffDir, { recursive: true });
    this._agentMapPath = join(this.sessionDir, 'agent_map.json');
    this.agentMap = existsSync(this._agentMapPath)
      ? JSON.parse(readFileSync(this._agentMapPath, 'utf8'))
      : {};
    this.phaseResultsDir = join(this.sessionDir, 'phase_results');
    fs.mkdirSync(this.phaseResultsDir, { recursive: true });
    // Pre-flight photo of the working tree (content fingerprint per dirty
    // path), persisted with the session and reloaded on --resume. The commit
    // phases diff against it so pre-existing dirt — docs and WIP another
    // session left behind — never gets swept into a FIA commit.
    this.baseline = loadOrCreateBaseline(this.sessionDir, this.repoRoot);
    this.replayed = 0;
    activeRun = this;
    installSignalHandlers();
  }

  saveAgentMap(agent, entry) {
    this.agentMap[agent] = entry;
    writeFileSync(this._agentMapPath, JSON.stringify(this.agentMap, null, 2));
  }

  addUsage(tokens, cost) {
    this.tokens += tokens;
    this.cost += cost;
    this.tracer.sessionAddUsage(this.fdaId, tokens, cost);
  }

  async runPhase(params, fn) {
    // Resume: a phase that already succeeded in this fda_id is not re-executed —
    // its persisted result is replayed so later phases see the same inputs.
    // EXCEPT kind 'code' (tests, commits): those verify the CURRENT tree and
    // always re-run — replaying a saved failed suite result would be a no-op.
    // A phase declared `replay: false` re-runs too: a verdict about the
    // CURRENT tree (ui_verify) must never be replayed from before a hand-fix,
    // or a failed gate becomes a permanent dead end on --resume.
    const resultFile = join(this.phaseResultsDir, `${params.name}.json`);
    if (this.resume && params.kind !== 'code' && params.replay !== false && existsSync(resultFile)) {
      const saved = JSON.parse(readFileSync(resultFile, 'utf8'));
      this.tracer.event({
        fda_id: this.fdaId,
        phase_id: '',
        type: 'log',
        name: `${params.name}: reused (resume)`,
        payload: { resumed: true },
      });
      this.console.note(`phase ${params.name}: reused from the previous run (resume)`);
      this.replayed += 1;
      return saved.result;
    }
    this._seq += 1;
    const phase = {
      phase_id: `${this.fdaId}_${String(this._seq).padStart(2, '0')}_${params.name}`,
      fda_id: this.fdaId,
      seq: this._seq,
      params,
      status: 'running',
      attempt: 0,
      error: null,
      started_at: nowIso(),
      ended_at: null,
    };
    this.phases.push(phase);
    this.tracer.phaseUpsert(phase);
    this.tracer.event({
      fda_id: this.fdaId,
      phase_id: phase.phase_id,
      type: 'phase_start',
      name: params.name,
      payload: { kind: params.kind, owner: params.owner, description: params.description },
    });
    this.console.phaseStarted(phase);
    const t0 = Date.now();
    const handle = new PhaseHandle(this, phase);
    try {
      const result = await fn(handle);
      try {
        writeFileSync(resultFile, JSON.stringify({ status: 'success', result: result ?? null }, null, 2));
      } catch {
        /* non-serializable result — phase will simply re-run on resume */
      }
      phase.status = 'success';
      phase.ended_at = nowIso();
      this.tracer.phaseUpsert(phase);
      this.tracer.event({
        fda_id: this.fdaId,
        phase_id: phase.phase_id,
        type: 'phase_end',
        name: params.name,
        payload: { status: 'success' },
      });
      this.console.phaseEnded(phase, (Date.now() - t0) / 1000);
      return result;
    } catch (error) {
      phase.status = 'fail';
      phase.error = String(error.message || error).slice(0, 1000);
      phase.ended_at = nowIso();
      this.tracer.phaseUpsert(phase);
      this.tracer.event({
        fda_id: this.fdaId,
        phase_id: phase.phase_id,
        type: 'error',
        name: params.name,
        payload: { error: phase.error },
      });
      this.tracer.sessionFinish(this.fdaId, false);
      this.console.phaseEnded(phase, (Date.now() - t0) / 1000);
      this.console.sessionFinished(false, this.tokens, this.cost, this.cfg.observability?.db);
      throw error;
    }
  }

  finish({ accepted = true, reason = '' } = {}) {
    // Replayed phases count as successful work: a resumed run where everything
    // was reused (and nothing newly executed failed) is still a success.
    const phasesOk =
      this.phases.length + this.replayed > 0 && this.phases.every((p) => p.status === 'success');
    const ok = phasesOk && accepted;
    if (phasesOk && !accepted) {
      const note = reason || 'the run acceptance criterion was not met';
      this.tracer.event({
        fda_id: this.fdaId,
        phase_id: this.phases.at(-1)?.phase_id || '',
        type: 'error',
        name: 'not_accepted',
        payload: { reason: note },
      });
      this.console.note(`not accepted: ${note}`);
    }
    this.tracer.sessionFinish(this.fdaId, ok);
    this.console.sessionFinished(ok, this.tokens, this.cost, this.cfg.observability?.db);
    return ok ? 0 : 1;
  }
}
