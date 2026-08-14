#!/usr/bin/env node
/**
 * imp handoff — continue an interrupted interactive Pi conversation in the
 * `claude` CLI (session continuation in the Orca style, subscriptions only).
 * Lives OUTSIDE Pi on purpose: when the Codex provider is down, Pi is down
 * with it — the student runs `imp handoff` (or `npm run handoff`) in the
 * project folder and keeps going on the Claude plan.
 *
 * No session transplant and no API keys: the new engine gets a continuation
 * preamble (the FDA relay's, modules/continuation.mjs) pointing at the Pi
 * session transcript on disk as read-only reference.
 *
 *   node imp/scripts/handoff.mjs           hand the newest Pi session to claude
 *     --list                               show recent sessions and exit
 *     --session <id>                       hand a specific session over
 *     --full                               ask claude to read the whole transcript first
 *     --print                              print the prompt + command, launch nothing
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildContinuationPreamble } from '../modules/continuation.mjs';
import { isSafeSessionId, listPiSessions, piSessionsDirFor } from './pi-sessions.mjs';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : undefined;
};

const dir = piSessionsDirFor();
const sessions = listPiSessions(dir);

if (has('--list')) {
  if (!sessions.length) {
    console.log(`No Pi sessions found for this folder (${dir}).`);
    process.exit(0);
  }
  for (const s of sessions.slice(0, 15)) {
    const model = [s.provider, s.model].filter(Boolean).join('/');
    console.log(`${s.id}  [${s.state}]  ${model}  ${s.request.slice(0, 60)}`);
  }
  console.log('\nHand one over with:  imp handoff --session <id>');
  process.exit(0);
}

let session;
const wanted = valueOf('--session');
if (wanted) {
  if (!isSafeSessionId(wanted)) {
    console.error(`Invalid session id: ${wanted}`);
    process.exit(1);
  }
  session = sessions.find((s) => s.id === wanted);
  if (!session) {
    console.error(`Session ${wanted} not found in ${dir} — see the options with: imp handoff --list`);
    process.exit(1);
  }
} else {
  session = sessions[0];
  if (!session) {
    console.error(`No Pi sessions found for this folder (${dir}).`);
    console.error('Start one with `imp` first — handoff continues an existing conversation.');
    process.exit(1);
  }
}

const transcriptPath = join(dir, `${session.id}.jsonl`);
const model = [session.provider, session.model].filter(Boolean).join('/') || 'unknown model';
const preamble = buildContinuationPreamble({
  marker: { coding_agent: 'pi', model, kind: 'handoff' },
  transcriptPath,
});
const fullNote = has('--full')
  ? 'Read the COMPLETE session transcript above before answering — I asked for a full handoff.\n\n'
  : '';
const prompt =
  preamble +
  fullNote +
  'Pick up the conversation recorded in that transcript. If its last request is\n' +
  'unfinished, continue it now; otherwise summarize where things stand and wait\n' +
  'for my next instruction.';

// The prompt is kept on disk next to the run data: reference for the student,
// paste material when `claude` is not installed, and the test surface.
const outDir = join('imp', 'data', 'handoff');
mkdirSync(outDir, { recursive: true });
const promptPath = join(outDir, `${session.id}-${Date.now()}.md`);
writeFileSync(promptPath, prompt);

console.log(`Handing over Pi session ${session.id} (${model})`);
console.log(`  transcript: ${transcriptPath}`);
console.log(`  prompt:     ${promptPath}`);

if (has('--print')) {
  console.log('\nRun it yourself with:');
  console.log(`  claude "$(cat ${relative(process.cwd(), promptPath) || promptPath})"`);
  console.log('\n──── prompt ────');
  console.log(prompt);
  process.exit(0);
}

// Hand the prompt to the interactive `claude` CLI as one argv entry — no shell,
// no quoting. If the CLI is missing (ENOENT — on Windows the .cmd shim resolves
// only through a shell), degrade to the saved prompt instead of aborting.
const child = spawn('claude', [prompt], { stdio: 'inherit' });
child.on('error', () => {
  console.error('\nCould not launch the `claude` CLI (not installed, or not on PATH).');
  console.error('Install it with:  npm install -g @anthropic-ai/claude-code');
  console.error(`Your handoff prompt is saved — paste it yourself:  claude "$(cat ${promptPath})"`);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 0));
