import { phaseParams } from './fda-cli.mjs';
import { artifactsExist, verdictConsistent, parseSurfaceLine } from './gates.mjs';
import { runTestsForBrief } from './quality.mjs';
import * as git from './git-helper.mjs';

/** Component/page files — the surfaces the UI-conformance rubric applies to. */
export const FRONTEND_FILE = /\.(tsx|jsx|vue|svelte)$/i;

/**
 * The default UI-conformance contract, mirrored from the harness's
 * `ai-docs/ui/patterns.md`. It lives in CODE (not in prompt_engineering/)
 * deliberately: modules/ reach existing installs via --update-runtime, the
 * prompt material does not. patterns.md, when the project keeps one,
 * overrides these defaults — the rubric says so.
 */
const UI_RUBRIC = [
  'Field validation errors render INLINE with the field: a short, specific message below/beside the field (the form library\'s message slot), an error border, aria-invalid + aria-describedby, and focus moving to the first invalid field on submit. A top-of-page banner, a card-header message, or a toast as the ONLY display of a field error is a violation.',
  'Validation runs on blur and on submit, the error clears once the value becomes valid, and labels are persistent (a placeholder is never the label).',
  'Every mutation/submit announces its outcome — success AND failure — through the project\'s toast system (e.g. sonner), fired only AFTER the operation resolves. A silent failure, or success shown before the operation resolved, is a violation.',
  'Create/edit flows follow the project\'s interaction pattern: by default an explicit button (or row click) opens a modal Dialog holding the form, and destructive actions confirm through an AlertDialog-style dialog. A create form permanently inlined on a list page is a violation unless ai-docs/ui/patterns.md or the brief explicitly chose it.',
  'Native browser alert()/confirm()/prompt() are never used.',
  'UI components come from the project\'s component registry (ai-docs/components/registry.md) when it keeps one — no ad-hoc duplicate of a component the registry already covers.',
  'Lists of records render through the registry\'s default table component (the shared DataTable) when the registry has one — a hand-rolled <table>, a bare primitive-Table composition, or a second per-screen table implementation is a violation.',
  'Fields whose data has a known domain (state/UF, country, timezone, language, fixed categories) or a normalizable format (CEP, phone, CPF/CNPJ, money, civil dates) use their semantic component — a picker fed by the canonical source, or a masked+validated input (a CEP field with its address lookup) — storing the canonical code, never the typed label. A free-text input for such data is a violation.',
  'Submit buttons disable while submitting; async views have explicit loading and empty states.',
];

function checkPrompt(files) {
  return [
    'Audit ONLY the UI conformance of the frontend files listed below — the functional review happens elsewhere; do not re-review the task.',
    'Read `ai-docs/ui/patterns.md` and `ai-docs/components/registry.md` first when they exist: patterns.md is the project\'s interaction-pattern contract and OVERRIDES the rubric defaults below. `.claude/skills/design-system/references/semantic-fields.md`, when the project ships it, is the catalog behind the semantic-field item.',
    '',
    'Frontend files this run changed:',
    ...files.map((f) => `- ${f}`),
    '',
    'Rubric — emit ONE finding per item ({requirement, met, evidence}, evidence citing file/line or the concrete gap):',
    ...UI_RUBRIC.map((r, i) => `${i + 1}. ${r}`),
    '',
    'Scope discipline: judge only what these files implement. Files with no user-facing form or flow (pure types, tests, config) satisfy every item — say so in the evidence. Never demand work beyond the rubric. Set approved=true ONLY when every applicable item is met; otherwise list exactly what must change in `blocking`.',
  ].join('\n');
}

/**
 * Deterministic UI-conformance close-out, same shape as the checklist gate:
 * audit → one builder repair round when violations were found → re-audit,
 * failing the run if violations survive. The audit is an agent (a form that
 * hides its errors in a banner is not grep-detectable), but the REFUSAL is
 * code — the gate throws, no prompt can talk it out of that.
 *
 * Arms itself: an explicit `Surface:` line without `ui` stands it down;
 * otherwise any run that changed frontend component files is audited (briefs
 * predating the `Surface:` convention still get the check).
 *
 * Returns the repair envelope (for commit-path inclusion), or null when the
 * gate was skipped or the first audit approved.
 */
export async function runUiGate(run, prompt) {
  const scope = await run.runPhase(
    phaseParams('ui_scope', 'code', 'quality', 'Decide whether the run changed frontend files that need the UI-conformance audit'),
    async (ph) => {
      const surface = parseSurfaceLine(prompt);
      if (surface && !surface.includes('ui')) {
        ph.log({ skipped: `the brief declares Surface: ${surface.join(', ')} — ui is not in it` });
        return { skip: true };
      }
      const uiFiles = git.runChangedPaths(run.repoRoot, run.baseline).filter((f) => FRONTEND_FILE.test(f));
      if (!uiFiles.length) {
        ph.log({ skipped: 'the run changed no frontend component files' });
        return { skip: true };
      }
      ph.log({ ui_files: uiFiles.length });
      return { skip: false, uiFiles };
    },
  );
  if (scope.skip) return null;

  const check = await run.runPhase(
    phaseParams('ui_check', 'agent', 'reviewer', 'Audit the changed frontend files against the UI-conformance rubric', { retries: 1 }),
    async (ph) => ph.call({ outputType: 'ReviewOutput', prompt: checkPrompt(scope.uiFiles), gates: [verdictConsistent] }),
  );
  if (check.approved) return null;

  const problems = [
    ...(check.blocking || []),
    ...(check.findings || []).filter((f) => !f.met).map((f) => `${f.requirement}${f.evidence ? ` — ${f.evidence}` : ''}`),
  ];
  const fix = await run.runPhase(
    phaseParams('fix_ui', 'agent', 'builder', 'Repair the UI-conformance violations found in the changed frontend files', { retries: 1 }),
    async (ph) =>
      ph.call({
        outputType: 'BuildOutput',
        prompt: [
          'The implementation works and the tests are green, but the frontend files this run changed violate the project\'s interaction patterns (`ai-docs/ui/patterns.md`; the audit below cites the defaults). Fix ONLY these violations — no scope expansion, no refactors beyond them:',
          ...problems.map((p) => `- ${p}`),
          '',
          'Declare every file you touch in `changed_files`.',
        ].join('\n'),
        previous: check,
        gates: [artifactsExist],
      }),
  );

  const verify = await run.runPhase(
    // replay: false — this verdict is about the CURRENT tree. Replaying a
    // rejecting envelope on --resume would make a failed gate a permanent
    // dead end (the engineer's hand-fix could never be seen); re-auditing
    // costs one reviewer call and keeps resume honest.
    phaseParams('ui_verify', 'agent', 'reviewer', 'Re-audit the frontend files after the repair round', { retries: 1, replay: false }),
    async (ph) =>
      ph.call({
        outputType: 'ReviewOutput',
        prompt: checkPrompt([...new Set([...scope.uiFiles, ...(fix.changed_files || []).filter((f) => FRONTEND_FILE.test(f))])]),
        previous: fix,
        gates: [verdictConsistent],
      }),
  );

  await run.runPhase(
    phaseParams('ui_gate', 'code', 'quality', 'Refuse to close the run while UI-conformance violations remain'),
    async (ph) => {
      if (!verify.approved) {
        const remaining = [
          ...(verify.blocking || []),
          ...(verify.findings || []).filter((f) => !f.met).map((f) => f.requirement),
        ];
        throw new Error(`ui conformance incomplete:\n- ${remaining.join('\n- ')}`);
      }
      ph.log({ ui: 'conformance verified' });
    },
  );

  // The repair round rewrote production code AFTER the run's test phase — the
  // suite must be green on the tree that will actually be committed, so re-run
  // it here, in code, before the gate lets the run proceed.
  await run.runPhase(
    phaseParams('ui_retest', 'code', 'quality', 'Re-run the suite after the UI repair round touched production code'),
    async (ph) => {
      const result = await runTestsForBrief(run, prompt);
      ph.log({ passed: result.passed, checks: result.checks.map((c) => c.name).join('+') });
      if (!result.passed) {
        throw new Error(`the suite went red after the UI repair round:\n${result.failures.join('\n')}`);
      }
    },
  );
  return fix;
}
