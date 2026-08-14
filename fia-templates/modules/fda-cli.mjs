import { parseArgs } from 'node:util';
import { basename } from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig, validate } from './agents.mjs';
import { ensure } from './session.mjs';
import { resolvePrompt } from './utils.mjs';

export function parseFdaArgs(argv, { agentDefault } = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', default: 'imp/fia.config.yaml' },
      'fda-id': { type: 'string' },
      resume: { type: 'boolean', default: false },
      agent: { type: 'string', default: agentDefault },
      debug: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });
  if (values.help) {
    console.log('Usage: node imp/fda_*.mjs "<prompt>" [--config imp/fia.config.yaml] [--fda-id id] [--resume] [--debug]');
    console.log('  --resume  with --fda-id: skip phases that already succeeded in that run (reuses saved results).');
    console.log('            The prompt may be omitted — the one saved with the original run is reused.');
    console.log('  --debug   print the full technical stack trace when a run fails');
    console.log('  Agent phases get 1 automatic correction round by default when a gate fails (retries: 1).');
    process.exit(0);
  }
  const promptArg = positionals.join(' ').trim();
  if (values.resume && !values['fda-id']) {
    console.error('--resume requires --fda-id <id> of the failed run (see `npm run fda:sessions`)');
    process.exit(1);
  }
  // On resume the prompt is optional: runFda() reloads the one saved in the trace.
  if (!promptArg && !(values.resume && values['fda-id'])) {
    console.error('Missing prompt argument');
    process.exit(1);
  }
  return {
    prompt: promptArg,
    config: values.config,
    fdaId: values['fda-id'] || null,
    resume: values.resume,
    agent: values.agent,
    debug: values.debug,
  };
}

export function phaseParams(name, kind, owner, description, extra = {}) {
  if (!description || description.trim().toLowerCase() === name.replace(/_/g, ' ')) {
    throw new Error(`phase ${name}: description is required and must explain intent`);
  }
  // Agent phases get one automatic correction round by default: a failed gate
  // is re-prompted once before the run fails. Code/engineer phases get none.
  return { name, kind, owner, description, retries: kind === 'agent' ? 1 : 0, ...extra };
}

/** The prompt saved with the original run (sessions.request), for --resume. */
function savedRequest(cfg, fdaId) {
  const dbPath = cfg.observability?.db || `${cfg.defaults?.data_dir || 'imp/data'}/fia.db`;
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare('SELECT request FROM sessions WHERE fda_id=?').get(fdaId);
    db.close();
    return row?.request || '';
  } catch {
    return '';
  }
}

/**
 * Shared prologue + error boundary for every fda_*.mjs script: parse args, load
 * and validate the config, ensure the session, then run `main`. Any failure is
 * reported as a short human message (reason + fda_id + the exact resume
 * command) instead of a raw stack trace — the stack only shows with --debug.
 *
 * `main({ run, cfg, prompt, args })` must return the process exit code
 * (usually `run.finish(...)`).
 */
export async function runFda(main, { agents = [], agentDefault } = {}) {
  const script = basename(process.argv[1] || 'fda.mjs');
  let args;
  try {
    args = parseFdaArgs(process.argv.slice(2), { agentDefault });
  } catch (error) {
    console.error(`Invalid arguments: ${String(error?.message || error)}`);
    console.error(`Run \`node imp/${script} --help\` to see the accepted options.`);
    process.exit(1);
  }
  let run = null;
  try {
    const cfg = loadConfig(args.config);
    if (!args.prompt && args.resume && args.fdaId) {
      args.prompt = savedRequest(cfg, args.fdaId);
      if (!args.prompt) {
        console.error(`No saved prompt found for run ${args.fdaId} — pass the prompt again:`);
        console.error(`  node imp/${script} "<prompt>" --fda-id ${args.fdaId} --resume`);
        process.exit(1);
      }
    }
    const required = typeof agents === 'function' ? agents(args) : agents;
    if (required.length) validate(cfg, required);
    run = ensure(cfg, args.fdaId, { resume: args.resume });
    const prompt = resolvePrompt(args.prompt);
    const exitCode = await main({ run, cfg, prompt, args });
    process.exit(exitCode ?? 0);
  } catch (error) {
    const fdaId = run?.fdaId || args.fdaId || null;
    console.error(`\n✗ FIA run failed: ${String(error?.message || error)}`);
    if (fdaId) {
      console.error('  Nothing is lost — resume from the phase that failed with:');
      console.error(`    node imp/${script} --fda-id ${fdaId} --resume`);
    }
    if (args.debug || process.env.FIA_DEBUG) console.error(`\n${error?.stack || error}`);
    else console.error('  (add --debug to see the full technical stack trace)');
    process.exit(1);
  }
}
