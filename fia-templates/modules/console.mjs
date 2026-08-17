import { OUTCOMES, outcomeLabel } from './outcome.mjs';

// Outcomes where the work is recoverable and a NARROWED resume is the right
// next move: the run did real work, it just did not finish the job. A verdict
// tells the resumed run what is still owed instead of re-running everything.
const BOUNDABLE = new Set([OUTCOMES.VERIFICATION_FAILED, OUTCOMES.ATTEMPT_CAP, OUTCOMES.NO_PROGRESS]);

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
    // `outcome` is the NAMED terminal reason: the student reads WHY the run
    // ended, not just pass/fail. Absent (older callers) the banner is unchanged.
    sessionFinished(ok, tokens, cost, db, outcome = null) {
      const why = outcome ? ` (${outcomeLabel(outcome)})` : '';
      console.log(
        `\n══ ${ok ? 'ACCEPTED' : 'FAILED'}${why} — ${tokens} tokens, $${cost.toFixed(4)} — trace: ${db} ══\n`,
      );
    },
    /**
     * What to do next, printed by the run that did NOT meet its goal. Only the
     * exception paths used to say this (the error boundary and the stop-condition
     * panel), so an honest failure — a red suite, a spent attempt cap, a stall —
     * ended the session with a bare banner and an fda_id that had long scrolled
     * away. Deliberately NOT offering `imp rewind` here: these runs stop before
     * the commit phase, so there is nothing committed to rewind.
     */
    recoveryRoutes(fdaId, outcome, script) {
      const lines = [`  Run ${fdaId} — pick up where it stopped:`];
      lines.push(`    node imp/${script} --fda-id ${fdaId} --resume        # replays what already passed`);
      if (BOUNDABLE.has(outcome)) {
        lines.push(
          `    node imp/scripts/verdict.mjs set ${fdaId} --missing "<what is still missing>"`,
          '                                                       # then resume: only that work is redone',
        );
      }
      console.log(`${lines.join('\n')}\n`);
    },
  };
}
