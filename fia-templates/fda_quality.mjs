#!/usr/bin/env node
/** FDA Quality — lint/typecheck/build/test without agents. */
import { runFda, phaseParams } from './modules/fda-cli.mjs';
import { runQuality } from './modules/quality.mjs';

await runFda(
  async ({ run, prompt }) => {
    await run.runPhase(phaseParams('request', 'engineer', run.engineer, 'Record why quality checks are running'), async (ph) => {
      ph.log({ input: prompt || 'quality gate' });
    });

    const quality = await run.runPhase(
      phaseParams('quality', 'code', 'quality', 'Run lint, typecheck, build, and test as deterministic code phases'),
      async (ph) => {
        const result = await runQuality(run);
        ph.log({ passed: result.passed, failures: result.failures.length });
        return result;
      },
    );

    return run.finish({ accepted: quality.passed, reason: 'quality checks failed' });
  },
  { agents: [] },
);
