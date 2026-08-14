#!/usr/bin/env node
/** FDA Document — write up recent changes. */
import { runFda, phaseParams } from './modules/fda-cli.mjs';
import { artifactsExist } from './modules/gates.mjs';

await runFda(
  async ({ run, prompt: raw }) => {
    const prompt = raw || 'Document the latest changes in this repository.';
    await run.runPhase(phaseParams('request', 'engineer', run.engineer, 'Capture what should be documented'), async (ph) => {
      ph.log({ input: prompt });
    });
    await run.runPhase(
      phaseParams('document', 'agent', 'documenter', 'Write user-facing documentation for the recent change'),
      async (ph) => ph.call({ outputType: 'DocumentOutput', prompt, gates: [artifactsExist] }),
    );
    return run.finish();
  },
  { agents: ['documenter'] },
);
