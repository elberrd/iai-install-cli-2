export function createConsole(_tracer, _fdaId) {
  return {
    note(msg) {
      console.log(`  · ${msg}`);
    },
    phaseStarted(phase) {
      console.log(`\n▶ [${phase.params.kind}] ${phase.params.name} — ${phase.params.description}`);
    },
    phaseEnded(phase, seconds) {
      const icon = phase.status === 'success' ? '✓' : '✗';
      console.log(`${icon} ${phase.params.name} (${seconds.toFixed(1)}s)`);
    },
    agentStarted(name, model, sessionId) {
      console.log(`  agent ${name} (${model}) session=${sessionId.slice(0, 12)}…`);
    },
    agentFinished(name, tokens, cost) {
      console.log(`  agent ${name} done — ${tokens} tokens, $${cost.toFixed(4)}`);
    },
    gateResult(name, report) {
      if (report.passed) console.log(`  gate ${name}: ok`);
      else console.log(`  gate ${name}: FAIL — ${report.violations.join('; ')}`);
    },
    retry(name, attempt, max, reason) {
      console.log(`  retry ${name} ${attempt}/${max}: ${reason}`);
    },
    envelopeSummary(envelope) {
      console.log(`  envelope: ${envelope.status} — ${envelope.summary?.slice(0, 120) || '(no summary)'}`);
    },
    sessionStarted(fdaId, engineer) {
      console.log(`\n══ FIA run ${fdaId} (engineer: ${engineer}) ══`);
    },
    engineFallback(agent, from, to, reason) {
      console.log(
        `  ⚠ ${agent}: ${from.coding_agent} (${from.model}) unavailable — ${reason}\n` +
          `    → falling back to ${to.coding_agent} (${to.model}) for this run`,
      );
    },
    engineRelay(agent, from, to, kind) {
      console.log(
        `  ⚠ ${agent}: ${from.coding_agent} (${from.model}) died mid-run (${kind})\n` +
          `    → relaying to ${to.coding_agent} (${to.model}) and continuing this phase`,
      );
    },
    engineContinuation(agent, transcriptPath) {
      console.log(`  · ${agent}: handing over the interrupted attempt's transcript (${transcriptPath})`);
    },
    engineRetry(agent, reason) {
      console.log(`  ⚠ ${agent}: ${reason}`);
    },
    sessionFinished(ok, tokens, cost, db) {
      console.log(`\n══ ${ok ? 'ACCEPTED' : 'FAILED'} — ${tokens} tokens, $${cost.toFixed(4)} — trace: ${db} ══\n`);
    },
  };
}
