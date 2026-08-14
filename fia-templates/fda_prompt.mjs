#!/usr/bin/env node
/** FDA Prompt — one agent, one prompt, traced end-to-end. */
import { runFda, phaseParams } from './modules/fda-cli.mjs';
import { resolve as resolveAgent } from './modules/agents.mjs';
import { artifactsExist, filesNonEmpty } from './modules/gates.mjs';

await runFda(
  async ({ run, prompt, args }) => {
    const agent = args.agent;
    // Artifact gates only apply to agents that MAY write files. A read-only
    // agent (writes: []) cannot create artifacts by construction — demanding
    // one would fail every run — so it is held to envelope validation alone.
    const writes = resolveAgent(run.cfg, agent).writes;
    const readOnly = Array.isArray(writes) && writes.length === 0;
    await run.runPhase(
      phaseParams('request', 'engineer', run.engineer, 'Capture the incoming ask from the engineer'),
      async (ph) => {
        ph.log({ input: prompt });
      },
    );
    await run.runPhase(
      phaseParams('prompt', 'agent', agent, `Send the request to ${agent} and parse its typed envelope`),
      async (ph) => {
        await ph.call({
          outputType: 'GenericOutput',
          prompt,
          gates: readOnly ? [] : [artifactsExist, filesNonEmpty],
        });
      },
    );
    return run.finish();
  },
  { agents: (args) => [args.agent], agentDefault: 'builder' },
);
