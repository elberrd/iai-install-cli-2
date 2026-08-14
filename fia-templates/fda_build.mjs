#!/usr/bin/env node
/** FDA Build — implement from plan envelope. */
import { runFda, phaseParams } from './modules/fda-cli.mjs';
import { artifactsExist } from './modules/gates.mjs';

await runFda(
  async ({ run, prompt }) => {
    await run.runPhase(phaseParams('request', 'engineer', run.engineer, 'Capture the build request'), async (ph) => {
      ph.log({ input: prompt });
    });
    await run.runPhase(
      phaseParams('build', 'agent', 'builder', 'Implement the plan exactly as specified'),
      async (ph) => ph.call({ outputType: 'BuildOutput', prompt, gates: [artifactsExist] }),
    );
    return run.finish();
  },
  { agents: ['builder'] },
);
