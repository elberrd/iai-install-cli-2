#!/usr/bin/env node
/** FDA Plan — planner only. */
import { runFda, phaseParams } from './modules/fda-cli.mjs';
import { artifactsExist, filesNonEmpty } from './modules/gates.mjs';

await runFda(
  async ({ run, prompt }) => {
    await run.runPhase(phaseParams('request', 'engineer', run.engineer, 'Capture the planning request'), async (ph) => {
      ph.log({ input: prompt });
    });
    const plan = await run.runPhase(
      phaseParams('plan', 'agent', 'planner', 'Turn the request into an implementable plan'),
      async (ph) => ph.call({ outputType: 'PlanOutput', prompt, gates: [artifactsExist, filesNonEmpty] }),
    );
    return run.finish({ accepted: plan?.status === 'success' });
  },
  { agents: ['planner'] },
);
