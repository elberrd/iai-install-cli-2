/**
 * QA scope resolution, video policy, report paths, and reviewer prompts for
 * the browser QA FDA (`fda_qa.mjs`). Unit/integration checks stay in
 * quality.mjs — this module is product verification only.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSurfaceLine, isFoundationBrief } from './gates.mjs';
import {
  readPlanMilestones,
  readPlanSpecs,
  readPlanTasks,
} from '../scripts/plan-docs.mjs';

export const QA_VIDEO_DEFAULT = 'retain-on-failure';
export const QA_VIDEO_VALUES = new Set(['off', 'on', 'retain-on-failure']);

/** Same tolerance pattern as stopPolicyOf — absent block → code default. */
export function qaPolicyOf(cfg) {
  const raw = cfg?.qa && typeof cfg.qa === 'object' ? cfg.qa : {};
  const policy = { video: QA_VIDEO_DEFAULT, warnings: [] };
  if (raw.video == null) return policy;
  const value = String(raw.video).trim();
  if (!QA_VIDEO_VALUES.has(value)) {
    policy.warnings.push(
      `qa.video: ${JSON.stringify(raw.video)} is not valid — keeping the default "${QA_VIDEO_DEFAULT}".`,
    );
    return policy;
  }
  policy.video = value;
  return policy;
}

/** Strip `--video` flags from the engineer prompt before scope parsing. */
export function parseQaCli(rawPrompt, cfg = {}) {
  const policy = qaPolicyOf(cfg);
  let videoCli = null;
  const parts = [];
  const tokens = String(rawPrompt || '').trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--video' && tokens[i + 1]) {
      videoCli = tokens[++i];
      continue;
    }
    if (token.startsWith('--video=')) {
      videoCli = token.slice('--video='.length);
      continue;
    }
    parts.push(token);
  }
  return {
    scopeRaw: parts.join(' ').trim(),
    video: resolveVideoPolicy(videoCli, policy.video),
    warnings: policy.warnings,
  };
}

export function resolveVideoPolicy(cliValue, configDefault = QA_VIDEO_DEFAULT) {
  const raw = String(cliValue ?? configDefault).trim();
  if (!QA_VIDEO_VALUES.has(raw)) return QA_VIDEO_DEFAULT;
  return raw;
}

function aiDocsDirOf(repoRoot) {
  return join(repoRoot, process.env.FIA_AI_DOCS || 'ai-docs');
}

function slugScope(scope) {
  if (scope.kind === 'milestone') return scope.id.toLowerCase();
  if (scope.kind === 'spec') return scope.id;
  if (scope.kind === 'task') return `task-${scope.num}`;
  return 'qa';
}

export function qaReportRelPath(scope, date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  return join('ai-docs', 'qa', `${day}-${slugScope(scope)}.md`);
}

export function qaArtifactDir(runId) {
  return join('imp', 'data', 'qa', runId);
}

/** List committed QA reports under ai-docs/qa/. */
export function listQaReports(repoRoot) {
  const dir = join(aiDocsDirOf(repoRoot), 'qa');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith('.md'))
    .map((file) => {
      const abs = join(dir, file);
      let body = '';
      try {
        body = readFileSync(abs, 'utf8');
      } catch {
        /* unreadable */
      }
      const passed = /^\s*Status:\s*passed\s*$/im.test(body);
      const skipped = /^\s*Status:\s*skipped\s*$/im.test(body);
      const scopeLine = (/^\s*Scope:\s*(.+)$/im.exec(body) || [])[1]?.trim() || file;
      return { file: join('ai-docs', 'qa', file), passed, skipped, scopeLine, body };
    });
}

function readIssue(repoRoot, taskNum) {
  const tasks = readPlanTasks(aiDocsDirOf(repoRoot));
  const hit = tasks.tasks.find((t) => t.num === taskNum.padStart(2, '0'));
  if (!hit?.file) return null;
  try {
    return readFileSync(join(repoRoot, 'ai-docs', hit.file), 'utf8');
  } catch {
    return hit.markdown || null;
  }
}

/** True when the scope has nothing to exercise in a browser. */
export function scopeNeedsUi(scope, repoRoot) {
  if (scope.kind === 'task') {
    const md = readIssue(repoRoot, scope.num) || '';
    const surface = parseSurfaceLine(md);
    if (surface && !surface.includes('ui')) return false;
    if (isFoundationBrief(md)) return true;
    return surface ? surface.includes('ui') : true;
  }
  const tasks = scope.taskNums || [];
  if (!tasks.length) return true;
  let sawUi = false;
  let allApiOnly = true;
  for (const num of tasks) {
    const md = readIssue(repoRoot, num) || '';
    const surface = parseSurfaceLine(md);
    if (isFoundationBrief(md)) {
      sawUi = true;
      allApiOnly = false;
      continue;
    }
    if (!surface) {
      sawUi = true;
      allApiOnly = false;
      continue;
    }
    if (surface.includes('ui')) {
      sawUi = true;
      allApiOnly = false;
    } else if (!surface.includes('api')) {
      allApiOnly = false;
    }
  }
  if (allApiOnly && !sawUi) return false;
  return true;
}

function parseScopeToken(raw) {
  const t = String(raw || '').trim();
  if (!t) return null;
  const milestone = /^(?:milestone\s*)?(m\d{1,3})\b/i.exec(t);
  if (milestone) return { kind: 'milestone', id: milestone[1].toUpperCase() };
  const task = /^(?:task\s*)?(\d{1,3})\b/i.exec(t);
  if (task) return { kind: 'task', num: task[1].padStart(2, '0') };
  const spec = /^(?:spec\s*)?(#?\d{4})\b/i.exec(t);
  if (spec) return { kind: 'spec', id: spec[1].replace(/^#/, '').padStart(4, '0') };
  return null;
}

function milestoneById(milestones, id) {
  const want = id.toUpperCase();
  return milestones.find((m) => m.id.toUpperCase() === want) || null;
}

function specById(specs, id) {
  const want = id.padStart(4, '0');
  return specs.find((s) => s.id === want) || null;
}

function taskByNum(tasks, num) {
  const want = num.padStart(2, '0');
  return tasks.find((t) => t.num === want) || null;
}

function scopeFromMilestone(m) {
  return {
    kind: 'milestone',
    id: m.id,
    label: `${m.id}${m.name ? ` — ${m.name}` : ''}`,
    doneWhen: m.doneWhen || [],
    taskNums: (m.tasks || []).map((r) => (typeof r === 'string' ? r : r.num)).filter(Boolean),
    goal: m.goal || null,
  };
}

function scopeFromSpec(s) {
  return {
    kind: 'spec',
    id: s.id,
    label: `Spec ${s.id}${s.title ? ` — ${s.title}` : ''}`,
    doneWhen: [],
    scenarios: [],
    taskNums: s.tasks || [],
    file: s.file,
  };
}

function scopeFromTask(t) {
  return {
    kind: 'task',
    num: t.num,
    label: `Task ${t.num}${t.title ? ` — ${t.title}` : ''}`,
    doneWhen: (t.criteria || []).map((c) => c.text).filter(Boolean),
    taskNums: [t.num],
    issueFile: t.file,
  };
}

function hasPassingReport(reports, scope) {
  const needle =
    scope.kind === 'milestone'
      ? scope.id
      : scope.kind === 'spec'
        ? scope.id
        : `task-${scope.num}`;
  return reports.some(
    (r) => r.passed && (r.file.includes(needle.toLowerCase()) || r.scopeLine.includes(scope.id || scope.num)),
  );
}

/**
 * Resolve QA scope from a raw token or infer the latest milestone/spec whose
 * tasks are all done and that lacks a passing report.
 */
export function resolveQaScope(scopeRaw, repoRoot) {
  const aiDocs = aiDocsDirOf(repoRoot);
  const tasks = readPlanTasks(aiDocs);
  const milestones = readPlanMilestones(aiDocs, tasks.tasks);
  const specs = readPlanSpecs(aiDocs);
  const reports = listQaReports(repoRoot);
  const token = parseScopeToken(scopeRaw);

  if (token?.kind === 'milestone') {
    const m = milestoneById(milestones.milestones, token.id);
    if (!m) throw new Error(`milestone ${token.id} not found in ai-docs/milestones.md`);
    return { scope: scopeFromMilestone(m), inferred: false, reports };
  }
  if (token?.kind === 'spec') {
    const s = specById(specs.specs, token.id);
    if (!s) throw new Error(`spec ${token.id} not found under ai-docs/specs/`);
    return { scope: scopeFromSpec(s), inferred: false, reports };
  }
  if (token?.kind === 'task') {
    const t = taskByNum(tasks.tasks, token.num);
    if (!t) throw new Error(`task ${token.num} not found in ai-docs/todos/issues/`);
    return { scope: scopeFromTask(t), inferred: false, reports };
  }

  const candidates = [];
  for (const m of milestones.milestones) {
    const refs = m.tasks || [];
    if (!refs.length) continue;
    const allDone = refs.every((r) => r.status === 'done');
    if (!allDone) continue;
    const sc = scopeFromMilestone(m);
    if (hasPassingReport(reports, sc)) continue;
    candidates.push(sc);
  }
  for (const s of specs.specs) {
    if (!s.tasks?.length) continue;
    const allDone = s.tasks.every((num) => taskByNum(tasks.tasks, num)?.status === 'done');
    if (!allDone) continue;
    const sc = scopeFromSpec(s);
    if (hasPassingReport(reports, sc)) continue;
    candidates.push(sc);
  }
  if (candidates.length === 1) return { scope: candidates[0], inferred: true, reports };
  if (candidates.length > 1) {
    return {
      ambiguous: true,
      candidates: candidates.map((c) => c.label),
      reports,
    };
  }
  throw new Error(
    'could not infer a QA scope — pass M1, a spec id (NNNN), or a task number (NN), or finish a milestone/spec whose tasks are all done',
  );
}

export function formatQaReport({
  scope,
  date = new Date(),
  e2ePassed,
  auditPassed,
  skipped = false,
  skipReason = '',
  doneWhen = [],
  artifactDir,
  fdaId,
  notes = '',
}) {
  const status = skipped ? 'skipped' : e2ePassed && auditPassed ? 'passed' : 'failed';
  const lines = [
    `# QA report — ${scope.label}`,
    '',
    `Date: ${date.toISOString().slice(0, 10)}`,
    `Scope: ${scope.label}`,
    `Status: ${status}`,
    `FDA: ${fdaId || '(manual)'}`,
    '',
    '## Results',
    `- E2E (Playwright): ${skipped ? 'skipped' : e2ePassed ? 'passed' : 'failed'}`,
    `- Design audit: ${skipped ? 'skipped' : auditPassed ? 'passed' : 'failed'}`,
    '',
  ];
  if (skipped && skipReason) {
    lines.push('## Skip reason', skipReason, '');
  }
  if (doneWhen.length) {
    lines.push('## Exit conditions', ...doneWhen.map((d) => `- ${d}`), '');
  }
  if (artifactDir) {
    lines.push('## Artifacts', `- ${artifactDir}`, '');
  }
  if (notes) lines.push('## Notes', notes, '');
  return `${lines.join('\n').trimEnd()}\n`;
}

export function writeQaReport(repoRoot, scope, body) {
  const rel = qaReportRelPath(scope);
  const abs = join(repoRoot, rel);
  mkdirSync(join(repoRoot, 'ai-docs', 'qa'), { recursive: true });
  writeFileSync(abs, body, 'utf8');
  return rel;
}

/** Launch-check helper: warn when a milestone is marked done without QA evidence. */
export function qaEvidenceGaps(repoRoot) {
  const aiDocs = aiDocsDirOf(repoRoot);
  const tasks = readPlanTasks(aiDocs);
  const milestones = readPlanMilestones(aiDocs, tasks.tasks);
  const reports = listQaReports(repoRoot);
  const gaps = [];
  for (const m of milestones.milestones) {
    if (m.status !== 'done') continue;
    const sc = scopeFromMilestone(m);
    if (!scopeNeedsUi(sc, repoRoot)) continue;
    if (hasPassingReport(reports, sc)) continue;
    gaps.push(m.id);
  }
  return gaps;
}

export function authorPrompt(scope, { routes = [], credentialsHint = '' } = {}) {
  const lines = [
    `Write or update durable Playwright tests under \`e2e/\` that prove the QA scope below.`,
    'Use role/label selectors — never invent credentials; read ai-docs/test-credentials.md when sign-in is required.',
    'Viewports are configured in playwright.config.ts (mobile/tablet/desktop projects) — write ONE test flow, not three copies.',
    'Cover every exit condition listed. Assert no console errors and no horizontal overflow on each viewport project.',
    '',
    `Scope: ${scope.label}`,
  ];
  if (scope.doneWhen?.length) {
    lines.push('', 'Exit conditions:', ...scope.doneWhen.map((d) => `- ${d}`));
  }
  if (routes.length) {
    lines.push('', 'Routes from ai-docs/screens-routes.md:', ...routes.slice(0, 12).map((r) => `- ${r}`));
  }
  if (credentialsHint) lines.push('', credentialsHint);
  lines.push(
    '',
    'Emit BuildOutput with changed_files listing every e2e file you touched.',
    'Do NOT modify application source — tests only.',
  );
  return lines.join('\n');
}

const QA_AUDIT_RUBRIC = [
  'Screenshots and DOM evidence show registry components (ai-docs/components/registry.md) — no ad-hoc duplicates of covered primitives.',
  'Layout respects ai-docs/ui/patterns.md when present (dialogs, toasts, inline validation).',
  'Theme uses semantic tokens — no raw hex outside approved theme decisions.',
  'Responsive: no horizontal overflow at mobile (375), tablet (768), and desktop (1280) widths.',
  'Console: no uncaught errors during the exercised flows.',
  'Network: no 4xx/5xx on API calls triggered by the flow (except expected auth redirects).',
  'Interaction contracts (design-system references/interaction.md): pointer cursor on clickable controls; yellow <mark> on typed search/filter matches; Combobox/MultiSelect popover at least as wide as the trigger; calendar caption jumps month and year; DataTable filters are header/Filter + chips, not a toolbar row of per-column buttons; /ui-components cards isolate one registry component.',
];

export function auditPrompt(scope, { artifactDir, e2eSummary = '' }) {
  return [
    `Audit the browser QA run for scope: ${scope.label}.`,
    'Read screenshots and Playwright output under:',
    artifactDir,
    '',
    e2eSummary ? `E2E summary:\n${e2eSummary}\n` : '',
    'Rubric — one finding per item ({requirement, met, evidence}):',
    ...QA_AUDIT_RUBRIC.map((r, i) => `${i + 1}. ${r}`),
    '',
    'Set approved=true ONLY when every item is met; otherwise list blocking fixes.',
    'Do NOT request code changes here — report gaps only.',
  ].join('\n');
}

export function preflightFailMessage(_repoRoot) {
  return (
    'Playwright is not ready for browser QA. From the project root run:\n' +
    '  npm install -D @playwright/test\n' +
    '  npx playwright install chromium\n' +
    'Then re-run: node imp/fda_qa.mjs "<scope>"'
  );
}
