#!/usr/bin/env node
/** FDA QA — browser verification at milestone, spec, or task boundaries. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runFda, phaseParams } from './modules/fda-cli.mjs';
import { artifactsExist, verdictConsistent } from './modules/gates.mjs';
import {
  auditPrompt,
  authorPrompt,
  formatQaReport,
  parseQaCli,
  preflightFailMessage,
  qaArtifactDir,
  resolveQaScope,
  routesForQaScope,
  scopeNeedsUi,
  writeQaReport,
} from './modules/qa-gate.mjs';
import {
  ensurePlaywrightSetup,
  preflightPlaywright,
  runPlaywrightE2e,
} from './modules/qa-playwright.mjs';
import { loadUiContract } from './scripts/ui-contract.mjs';
import { verifyUiKitReceipt } from './modules/ui-kit-receipt.mjs';

function credentialsHint(repoRoot) {
  const path = join(repoRoot, 'ai-docs', 'test-credentials.md');
  if (!existsSync(path)) {
    return 'No ai-docs/test-credentials.md yet — use Clerk test mode (+clerk_test / 424242) or skip auth-only flows.';
  }
  return 'Sign-in roster: ai-docs/test-credentials.md (never paste real secrets into tests).';
}

await runFda(
  async ({ run, cfg, prompt }) => {
    const cli = parseQaCli(prompt, cfg);
    for (const w of cli.warnings) run.console.note(w);

    await run.runPhase(phaseParams('request', 'engineer', run.engineer, 'Capture the QA scope and video policy'), async (ph) => {
      ph.log({ input: cli.scopeRaw || '(infer)', video: cli.video });
    });

    const resolved = await run.runPhase(
      phaseParams('scope', 'code', 'quality', 'Resolve milestone, spec, or task scope from ai-docs planning artifacts'),
      async (ph) => {
        const out = resolveQaScope(cli.scopeRaw, run.repoRoot);
        if (out.ambiguous) {
          throw new Error(
            `multiple scopes qualify for QA — pick one: ${out.candidates.join('; ')}`,
          );
        }
        const { scope, inferred } = out;
        ph.log({ scope: scope.label, kind: scope.kind, inferred });
        if (!scopeNeedsUi(scope, run.repoRoot)) {
          ph.log({ skipped: 'scope has no user-facing UI to exercise in a browser' });
          return { scope, skip: true, skipReason: 'API-only or non-UI scope — browser QA does not apply' };
        }
        const routes = routesForQaScope(scope, run.repoRoot);
        const contract = loadUiContract(run.repoRoot, { required: true });
        const kitReceipt = verifyUiKitReceipt(run.repoRoot, contract);
        if (kitReceipt.required && !kitReceipt.ok) {
          throw new Error(
            `ui kit receipt incomplete before browser QA: ${kitReceipt.errors
              .map((error) => error.code)
              .join(', ')}\n` +
              'Recover: `node .agents/scripts/ui-kit.mjs verify --target . --json` re-inspects the selected implementations and re-stamps ai-docs/ui/kit-receipt.json (legitimate edits to an alternate entrypoint need exactly this); a missing receipt means the kit was never installed — run `node .agents/scripts/ui-kit.mjs install --target . --json` (brownfield: /kit) first.',
          );
        }
        return {
          scope: { ...scope, routes },
          skip: false,
          routes,
          contract,
          kitReceipt,
        };
      },
    );

    if (resolved.skip) {
      const body = formatQaReport({
        scope: resolved.scope,
        e2ePassed: false,
        auditPassed: false,
        skipped: true,
        skipReason: resolved.skipReason,
        fdaId: run.fdaId,
      });
      const reportPath = writeQaReport(run.repoRoot, resolved.scope, body);
      await run.runPhase(
        phaseParams('gate', 'code', 'quality', 'Record skipped QA — no browser work required'),
        async (ph) => {
          ph.log({ report: reportPath, skipped: true });
        },
      );
      return run.finish({ accepted: true, reason: resolved.skipReason });
    }

    const artifactRelDir = qaArtifactDir(run.fdaId);

    await run.runPhase(
      phaseParams('preflight', 'code', 'quality', 'Verify Playwright and the test:e2e script are available before authoring'),
      async (ph) => {
        const check = await preflightPlaywright(run.repoRoot);
        if (!check.ok) {
          ph.log({ problems: check.problems });
          throw new Error(`${preflightFailMessage(run.repoRoot)}\n(${check.problems.join('; ')})`);
        }
        await ensurePlaywrightSetup(run.repoRoot, {
          artifactRelDir,
          videoPolicy: cli.video,
        });
        ph.log({ ready: true, artifact_dir: artifactRelDir });
      },
    );

    await run.runPhase(
      phaseParams('author', 'agent', 'builder', 'Author durable Playwright tests under e2e/ for the resolved scope'),
      async (ph) =>
        ph.call({
          outputType: 'BuildOutput',
          prompt: authorPrompt(resolved.scope, {
            routes: resolved.routes,
            credentialsHint: credentialsHint(run.repoRoot),
            contract: resolved.contract,
          }),
          gates: [artifactsExist],
        }),
    );

    const e2e = await run.runPhase(
      phaseParams('e2e', 'code', 'quality', 'Run Playwright e2e with configured viewports and optional video capture'),
      async (ph) => {
        const result = await runPlaywrightE2e(run, {
          artifactRelDir,
          videoPolicy: cli.video,
        });
        ph.log({ passed: result.passed, artifact_dir: artifactRelDir });
        return result;
      },
    );

    let auditSummary = '';
    try {
      auditSummary = readFileSync(e2e.output_artifact, 'utf8').slice(-3000);
    } catch {
      /* log may be absent on catastrophic failure */
    }

    const audit = await run.runPhase(
      phaseParams(
        'audit',
        'agent',
        'reviewer',
        'Audit screenshots and Playwright output against registry, patterns, and responsiveness',
        { retries: 1, replay: false },
      ),
      async (ph) =>
        ph.call({
          outputType: 'ReviewOutput',
          prompt: auditPrompt(resolved.scope, {
            artifactDir: artifactRelDir,
            e2eSummary: auditSummary,
            routes: resolved.routes,
            contract: resolved.contract,
          }),
          gates: [verdictConsistent],
        }),
    );

    const reportBody = formatQaReport({
      scope: resolved.scope,
      e2ePassed: e2e.passed,
      auditPassed: audit.approved,
      doneWhen: resolved.scope.doneWhen || [],
      artifactDir: artifactRelDir,
      fdaId: run.fdaId,
      notes: audit.summary || '',
      routes: resolved.routes,
      contract: resolved.contract,
      kitReceipt: resolved.kitReceipt,
    });

    const reportPath = await run.runPhase(
      phaseParams('report', 'code', 'quality', 'Write the durable QA report under ai-docs/qa/'),
      async (ph) => {
        const rel = writeQaReport(run.repoRoot, resolved.scope, reportBody);
        ph.log({ report: rel });
        return rel;
      },
    );

    await run.runPhase(
      phaseParams('gate', 'code', 'quality', 'Refuse to close while e2e or the design audit failed'),
      async (ph) => {
        if (!e2e.passed) {
          throw new Error(`Playwright e2e failed — see ${artifactRelDir}/playwright.log`);
        }
        if (!audit.approved) {
          const blocking = [...(audit.blocking || []), ...(audit.findings || []).filter((f) => !f.met).map((f) => f.requirement)];
          throw new Error(`QA design audit failed:\n- ${blocking.join('\n- ')}`);
        }
        ph.log({ report: reportPath, passed: true });
      },
    );

    return run.finish({
      accepted: true,
      reason: 'browser QA passed',
    });
  },
  { agents: ['builder', 'reviewer'] },
);
