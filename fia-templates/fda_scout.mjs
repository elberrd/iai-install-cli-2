#!/usr/bin/env node
/** FDA Scout — read-only recon. */
import { runFda, phaseParams } from './modules/fda-cli.mjs';
import { artifactsExist } from './modules/gates.mjs';

await runFda(
  async ({ run, prompt }) => {
    await run.runPhase(phaseParams('request', 'engineer', run.engineer, 'Capture the recon request'), async (ph) => {
      ph.log({ input: prompt });
    });
    await run.runPhase(
      phaseParams('scout', 'agent', 'scout', 'Map the codebase for the ask without modifying product code'),
      async (ph) => {
        await ph.call({ outputType: 'ScoutOutput', prompt, gates: [artifactsExist] });
      },
    );
    return run.finish();
  },
  { agents: ['scout'] },
);
