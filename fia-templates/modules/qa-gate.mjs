/**
 * QA scope resolution, video policy, report paths, and reviewer prompts for
 * the browser QA FDA (`fda_qa.mjs`). Unit/integration checks stay in
 * quality.mjs — this module is product verification only.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSurfaceLine, isFoundationBrief } from './gates.mjs';
import { readPlanMilestones, readPlanScreens, readPlanSpecs, readPlanTasks } from '../scripts/plan-docs.mjs';
import {
  loadUiContract,
  resolveUiImplementation,
  resolveUiRuleApplicability,
  UI_RULES,
  UiContractError,
} from '../scripts/ui-contract.mjs';

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
  const tokens = String(rawPrompt || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
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

const slash = (p) => String(p).replaceAll('\\', '/');

const scopeUiContracts = new WeakMap();

function routeDepthOf(routes) {
  if (!Array.isArray(routes) || routes.length === 0) return undefined;
  return Math.max(...routes.map((route) => String(route).split(/[?#]/, 1)[0].split('/').filter(Boolean).length));
}

function normalizeRoutes(routes) {
  if (!Array.isArray(routes)) return [];
  return [...new Set(routes.map((route) => String(route).trim()).filter(Boolean))];
}

function effectiveRoutes(scope, fallbackRoutes) {
  return Object.prototype.hasOwnProperty.call(scope || {}, 'routes')
    ? normalizeRoutes(scope.routes)
    : normalizeRoutes(fallbackRoutes);
}

function textMentionsScreen(markdown, screen) {
  const text = String(markdown || '');
  const lower = text.toLowerCase();
  const route = String(screen.route || '').trim();
  if (!route) return false;
  if (route === '/') {
    if (/`\/`|(?:route|rota|screen|tela|path)\s*:\s*\//i.test(text)) return true;
  } else if (lower.includes(route.toLowerCase())) {
    return true;
  }

  const component = String(screen.component || '').trim();
  if (component && lower.includes(component.toLowerCase())) return true;
  const componentLabel = component.replace(/(?:page|screen|view)$/i, '');
  if (componentLabel.length >= 4) {
    const escaped = componentLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(text)) return true;
  }

  const file = String(screen.file || '').trim();
  return Boolean(file && lower.includes(file.toLowerCase()));
}

/** Resolve only screen-matrix routes explicitly named by this QA scope. */
export function routesForQaScope(scope, repoRoot) {
  if (Object.prototype.hasOwnProperty.call(scope || {}, 'routes')) return normalizeRoutes(scope.routes);
  const taskNums = normalizeRoutes(scope?.taskNums || (scope?.num ? [scope.num] : []));
  const scopedDocs = taskNums.map((num) => readIssue(repoRoot, num)).filter(Boolean);
  if (!scopedDocs.length) return [];
  const screens = readPlanScreens(aiDocsDirOf(repoRoot)).screens || [];
  return normalizeRoutes(
    screens.filter((screen) => scopedDocs.some((markdown) => textMentionsScreen(markdown, screen))).map((screen) => screen.route),
  );
}

function withQaRoutes(scope, repoRoot) {
  return { ...scope, routes: routesForQaScope(scope, repoRoot) };
}

function contractForPrompt(scope, explicitContract) {
  const contract = explicitContract || scopeUiContracts.get(scope);
  if (!contract) {
    throw new UiContractError('Browser QA requires a validated ai-docs/ui/contract.json for every UI scope.');
  }
  return contract;
}

/**
 * Turn contract statuses into an applicability plan for browser QA. APPLY
 * means the rule must be exercised; SKIP retains its deterministic reason.
 * Compliance remains unknown until the authored test and reviewer prove it.
 */
export function uiQaRulePlan(contract, { routeDepth } = {}) {
  return Object.keys(UI_RULES).map((ruleId) => resolveUiRuleApplicability(contract, ruleId, { routeDepth }));
}

export function qaReportRelPath(scope, date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  return slash(join('ai-docs', 'qa', `${day}-${slugScope(scope)}.md`));
}

export function qaArtifactDir(runId) {
  return slash(join('imp', 'data', 'qa', runId));
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
      return { file: slash(join('ai-docs', 'qa', file)), passed, skipped, scopeLine, body };
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

/** Pure surface classification; contract loading happens only for UI scopes. */
function scopeContainsUi(scope, repoRoot) {
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

/**
 * True when the scope needs browser QA. UI scopes fail closed when their
 * deterministic contract is missing or invalid; API-only scopes do not need
 * a UI contract and remain a reasoned SKIP in fda_qa.mjs.
 */
export function scopeNeedsUi(scope, repoRoot) {
  const needsUi = scopeContainsUi(scope, repoRoot);
  if (!needsUi) return false;
  const contract = loadUiContract(repoRoot, { required: true });
  scopeUiContracts.set(scope, contract);
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
  const needle = scope.kind === 'milestone' ? scope.id : scope.kind === 'spec' ? scope.id : `task-${scope.num}`;
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
    return { scope: withQaRoutes(scopeFromMilestone(m), repoRoot), inferred: false, reports };
  }
  if (token?.kind === 'spec') {
    const s = specById(specs.specs, token.id);
    if (!s) throw new Error(`spec ${token.id} not found under ai-docs/specs/`);
    return { scope: withQaRoutes(scopeFromSpec(s), repoRoot), inferred: false, reports };
  }
  if (token?.kind === 'task') {
    const t = taskByNum(tasks.tasks, token.num);
    if (!t) throw new Error(`task ${token.num} not found in ai-docs/todos/issues/`);
    return { scope: withQaRoutes(scopeFromTask(t), repoRoot), inferred: false, reports };
  }

  const candidates = [];
  for (const m of milestones.milestones) {
    const refs = m.tasks || [];
    if (!refs.length) continue;
    const allDone = refs.every((r) => r.status === 'done');
    if (!allDone) continue;
    const sc = withQaRoutes(scopeFromMilestone(m), repoRoot);
    if (hasPassingReport(reports, sc)) continue;
    candidates.push(sc);
  }
  for (const s of specs.specs) {
    if (!s.tasks?.length) continue;
    const allDone = s.tasks.every((num) => taskByNum(tasks.tasks, num)?.status === 'done');
    if (!allDone) continue;
    const sc = withQaRoutes(scopeFromSpec(s), repoRoot);
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
  routes = [],
  contract: explicitContract,
  kitReceipt,
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
    ...(kitReceipt ? [`- UI kit receipt: ${kitReceipt.ok ? 'verified' : 'failed'}`] : []),
    '',
  ];
  const contract = explicitContract || scopeUiContracts.get(scope);
  if (contract) {
    const plan = uiQaRulePlan(contract, { routeDepth: routeDepthOf(effectiveRoutes(scope, routes)) });
    lines.push(
      '## UI contract',
      `Profile: ${contract.profile}`,
      `Schema: ${contract.schemaVersion}`,
      'Implementations:',
      ...IMPLEMENTATION_SURFACES.map((surface) => implementationLine(contract, surface)),
      ...rulePlanLines(plan),
      '',
    );
  }
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

export function writeQaReport(repoRoot, scope, body, date = new Date()) {
  const rel = qaReportRelPath(scope, date);
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

function rulePlanLines(plan) {
  return plan.map(({ label, ruleId, status, reason }) => `- ${label} ${ruleId} — ${status} (${reason})`);
}

function ruleApplies(plan, ruleId) {
  return plan.some((item) => item.ruleId === ruleId && item.applicable);
}

const IMPLEMENTATION_SURFACES = Object.freeze(['app_shell', 'breadcrumb', 'theme', 'data_table', 'kanban']);

function implementationLine(contract, surface) {
  const selection = resolveUiImplementation(contract, surface);
  if (selection.isCanonical) return `- ${surface}: canonical fallback preset ${selection.preset}`;
  const target = selection.package || selection.path || '(project-defined)';
  return `- ${surface}: ${selection.mode} ${target} — explicit choice; canonical source installation is forbidden for this surface`;
}

function canonicalTableSelected(contract) {
  return resolveUiImplementation(contract, 'data_table').isCanonical;
}

export function authorPrompt(scope, { routes = [], credentialsHint = '', contract: explicitContract } = {}) {
  const contract = contractForPrompt(scope, explicitContract);
  const scopedRoutes = effectiveRoutes(scope, routes);
  const routeDepth = routeDepthOf(scopedRoutes);
  const plan = uiQaRulePlan(contract, { routeDepth });
  const lines = [
    `Write or update durable Playwright tests under \`e2e/\` that prove the QA scope below.`,
    'Use role/label selectors — never invent credentials; read ai-docs/test-credentials.md when sign-in is required.',
    'Viewports are configured in playwright.config.ts at exactly 360, 768, and 1440 CSS pixels — write ONE test flow, not three copies.',
    'Cover every exit condition listed. Assert no console errors, unexpected 4xx/5xx responses, or page-level horizontal overflow on each viewport project.',
    'Exercise the responsive flow at 100%, 125%, and 200% zoom; controls, text, focus, and owned scrollers must remain usable and contained.',
    '',
    `Scope: ${scope.label}`,
    `UI contract: schema ${contract.schemaVersion}, profile ${contract.profile}`,
    '',
    'Implementation selections (explicit library/custom/project choices win; canonical is fallback only):',
    ...IMPLEMENTATION_SURFACES.map((surface) => implementationLine(contract, surface)),
    '',
    'Deterministic rule applicability (retain every SKIP and its reason in test comments/report evidence):',
    ...rulePlanLines(plan),
  ];
  if (scope.doneWhen?.length) {
    lines.push('', 'Exit conditions:', ...scope.doneWhen.map((d) => `- ${d}`));
  }
  if (scopedRoutes.length) {
    lines.push('', 'Routes from ai-docs/screens-routes.md:', ...scopedRoutes.slice(0, 12).map((r) => `- ${r}`));
  }
  if (credentialsHint) lines.push('', credentialsHint);

  if (ruleApplies(plan, 'theme.user_switcher')) {
    lines.push(
      '',
      'Theme matrix:',
      '- Exercise system, light, and dark presentation. For system, emulate both light and dark OS preferences; persist and reload each explicit override.',
      '- Assert readable semantic-token contrast and no flash into the wrong theme before hydration.',
    );
  }

  if (ruleApplies(plan, 'navigation.breadcrumb')) {
    lines.push(
      '',
      'Navigation hierarchy:',
      '- On nested routes, assert the breadcrumb exposes parent links, marks the current page, and remains keyboard operable without duplicating the page title.',
    );
  }

  if (ruleApplies(plan, 'components.data_table')) {
    lines.push(
      '',
      'Selected shared DataTable/data grid (base):',
      '- Prove the registry-selected shared implementation is used with semantic accessible table/grid structure, stable row identity, contained horizontal scrolling, and no ad-hoc second table implementation.',
      '- Exercise global search unless a scoped approved waiver records why it is inapplicable, plus one Filter control that adds a type-adapted column filter; never accept a toolbar row of per-column filter buttons.',
      '- Open each compatible column filter/action from a visible header button/left-click, right-click, and Shift+F10 or the Context Menu key; prove base sort, filter, hide, and reset behavior through pointer and keyboard paths.',
      '- Apply and remove filters; compact removable filter chips remain in a stable reserved lane, Clear filters resets them all, and toolbar height is identical before, during, and after filtering.',
      '- Exercise column visibility, pagination/truthful count summary, selection/actions when permitted, and loading/empty/no-results/error/long-content states.',
      canonicalTableSelected(contract)
        ? '- Canonical preset receipt: inspect the call site; advancedControls is omitted (its default is false), and prove no advanced-only UI is rendered while every base header sort/filter/hide/clear action remains available.'
        : '- Selected implementation receipt: prove its base configuration does not enable advanced-only UI while every base header sort/filter/hide/clear action remains available; do not demand FIA canonical component names or props.',
    );
  }

  if (ruleApplies(plan, 'data_table.advanced_controls')) {
    lines.push(
      '',
      'Advanced DataTable:',
      canonicalTableSelected(contract)
        ? '- Canonical preset receipt: inspect the call site and require advancedControls={true}; this prop is passed only because data_table.advanced_controls is APPLY.'
        : "- Selected implementation receipt: require its explicit advanced-mode configuration only because data_table.advanced_controls is APPLY; do not demand the canonical advancedControls prop.",
      '- Exercise the ordered grouping lane: reorder/remove its chips, add with + Level only to a maximum of three levels, and expand/collapse individual groups plus all groups through semantic aria-expanded controls.',
      '- Assert each group badge and the result summary use the truthful leaf-record count. Collapse and expand groups and prove the summary never uses group rows or currently expanded leaf DOM rows.',
      '- Through the same accessible header menu, prove advanced group/ungroup, pin/unpin, move, sizing, and density actions; none may appear when this rule is SKIP.',
      '- Change every supported versioned per-user view field (search, filters, sort, grouping, visibility, order, widths, pinning, density and page size), reload to prove persistence, invoke Restore defaults, reload again, and prove the complete schema-default view survives.',
      '- When header drag reorder is enabled, prove its dedicated column-drag handle, insertion indicator, legal drop, cancel/rollback, pinned/utility constraints, and menu and keyboard fallback. Dragging the label must not steal sort/menu activation.',
      '- Exercise empty, one-row, many-row, long-label, grouped, resized, and horizontally scrolled states with a sticky header, without clipping menus or moving controls outside their owner.',
      '- For large/unknown remote data, prove server-side sorting, filtering, and pagination operate over the full result set and use backend totals. Permit virtualization only for many already-loaded rows; never accept it as a reason to download an unbounded set or replace the selected implementation\'s data model.',
    );
  }

  if (ruleApplies(plan, 'components.kanban')) {
    lines.push(
      '',
      'Professional Kanban:',
      '- For every card, compare its bounding box with the bounding box of every child, drag handle, and action control; nothing may escape the card or column except an intentional portalled overlay.',
      '- Exercise empty, one-card, many-card, long-title, narrow viewport, board scroll, and 100%/125%/200% zoom states; overflow belongs to the board scroller, never the page.',
    );
  }
  if (ruleApplies(plan, 'quality.drag_geometry')) {
    lines.push(
      '- Prove DragOverlay alignment: the overlay preserves the source card dimensions and remains aligned with the pointer through pickup, cross-column scroll, drop, and cancel.',
    );
  }
  if (ruleApplies(plan, 'quality.drag_alternative')) {
    lines.push(
      '- Prove the non-drag alternative: a visible Move to action and keyboard path can perform the same legal move, with focus restored and errors recoverable.',
    );
  }

  lines.push(
    '',
    'Emit BuildOutput with changed_files listing every e2e file you touched.',
    'Do NOT modify application source — tests only.',
  );
  return lines.join('\n');
}

const QA_AUDIT_RUBRIC = Object.freeze([
  {
    ruleId: 'quality.responsive_layout',
    requirement:
      'Responsive evidence covers exact widths 360, 768, and 1440 plus 100%, 125%, and 200% zoom; text, controls, and owned scrollers remain usable.',
  },
  {
    ruleId: 'quality.overflow_containment',
    requirement:
      'DOM bounding box evidence proves content stays inside its component or an explicit local scroller; there is no accidental page-level horizontal overflow.',
  },
  {
    ruleId: 'quality.keyboard_access',
    requirement:
      'The exercised flows are keyboard operable. Interaction contracts in design-system references/interaction.md hold: pointer affordances, yellow <mark> search matches, trigger-width overlays, and keyboard-openable menus.',
  },
  {
    ruleId: 'quality.focus_visibility',
    requirement:
      'Focus is visible, follows a coherent order, enters and leaves overlays correctly, and returns to the invoking control.',
  },
  {
    ruleId: 'quality.error_recovery',
    requirement:
      'Console has no uncaught errors; unexpected network 4xx/5xx is absent; failures expose recovery without losing user work.',
  },
  {
    ruleId: 'shell.app_shell',
    requirement:
      'The project-selected shared app shell and PageHeader remain responsive, aligned, and free of duplicated page chrome.',
  },
  {
    ruleId: 'navigation.breadcrumb',
    requirement:
      'Nested routes expose a keyboard-operable breadcrumb with valid parents and the current page, without duplicating the page title.',
  },
  {
    ruleId: 'theme.user_switcher',
    requirement:
      'System, light, and dark modes are exercised, persist correctly, honor OS preference in system mode, and use semantic tokens without theme flash.',
  },
  {
    ruleId: 'components.data_table',
    requirement:
      'Screenshots and DOM evidence show the registry-selected shared DataTable/data-grid with semantic accessible table/grid structure rather than an ad-hoc duplicate. The professional base proves global search unless a scoped approved waiver applies; one Filter control; per-column filters from a visible header button/left-click, right-click, and Shift+F10 or the Context Menu key; compact removable filter chips plus Clear filters without toolbar-height jumps; compatible sort/filter/hide/reset actions; visibility; pagination with truthful count summary; and loading/empty/no-results/error/long-content states contained. Base configuration exposes no advanced-only UI and retains all base header sort/filter/hide/clear behavior.',
  },
  {
    ruleId: 'data_table.advanced_controls',
    requirement:
      "Advanced actions appear only when this rule applies and the selected implementation's explicit advanced configuration is active. Evidence proves the ordered grouping lane (+ Level, maximum three), aria-expanded groups and truthful leaf-record count independent of expanded DOM leaves; compatible group/ungroup, pin/unpin, move, sizing and density actions; versioned per-user view state persists after reload, Restore defaults is invoked, then another reload proves the complete reset; optional reorder uses a dedicated column-drag handle, insertion indicator, cancel/rollback and menu/keyboard fallback; a sticky header stays contained; server-side sorting, filtering, and pagination use full-set backend totals for large/unknown data, while virtualization is limited to many already-loaded rows.",
  },
  {
    ruleId: 'components.kanban',
    requirement:
      'Kanban card and child bounding box evidence proves containment across long content, empty/many-card columns, board scroll, narrow widths, and zoom.',
  },
  {
    ruleId: 'quality.drag_geometry',
    requirement:
      'DragOverlay preserves the source card dimensions and pointer alignment during pickup, scrolling, cross-column movement, drop, and cancel.',
  },
  {
    ruleId: 'quality.drag_alternative',
    requirement:
      'A visible Move to action and keyboard path provide the same legal Kanban movement with focus restoration and recoverable failure.',
  },
]);

export function auditPrompt(scope, { artifactDir, e2eSummary = '', routes = [], contract: explicitContract } = {}) {
  const contract = contractForPrompt(scope, explicitContract);
  const plan = uiQaRulePlan(contract, { routeDepth: routeDepthOf(effectiveRoutes(scope, routes)) });
  const applicable = QA_AUDIT_RUBRIC.filter(({ ruleId }) => ruleApplies(plan, ruleId));
  const canonicalSpecific = [];
  if (canonicalTableSelected(contract) && ruleApplies(plan, 'components.data_table')) {
    canonicalSpecific.push({
      ruleId: 'components.data_table',
      requirement:
        'Canonical preset receipt proves the shared table is the FIA TanStack DataTable and base call sites omit advancedControls (default false).',
    });
  }
  if (canonicalTableSelected(contract) && ruleApplies(plan, 'data_table.advanced_controls')) {
    canonicalSpecific.push({
      ruleId: 'data_table.advanced_controls',
      requirement:
        'Canonical preset receipt proves advanced call sites pass advancedControls={true} only while the advanced rule is APPLY.',
    });
  }
  return [
    `Audit the browser QA run for scope: ${scope.label}.`,
    'Read screenshots and Playwright output under:',
    artifactDir,
    '',
    e2eSummary ? `E2E summary:\n${e2eSummary}\n` : '',
    `UI contract: schema ${contract.schemaVersion}, profile ${contract.profile}`,
    'Implementation selections (explicit library/custom/project choices win; canonical is fallback only):',
    ...IMPLEMENTATION_SURFACES.map((surface) => implementationLine(contract, surface)),
    '',
    'Rule decisions (APPLY is audited; SKIP is retained with its deterministic reason):',
    ...rulePlanLines(plan),
    '',
    'Rubric — one finding per APPLY item ({requirement, met, evidence}):',
    ...applicable.map(({ ruleId, requirement }, index) => `${index + 1}. [${ruleId}] ${requirement}`),
    ...canonicalSpecific.map(
      ({ ruleId, requirement }, index) => `${applicable.length + index + 1}. [${ruleId}] ${requirement}`,
    ),
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
