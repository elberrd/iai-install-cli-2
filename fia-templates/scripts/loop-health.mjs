#!/usr/bin/env node
/**
 * Loop health — a deterministic, evidence-based score of the project's agent
 * work loop, across five dimensions:
 *
 *   task_understanding    did the loop start from a written, traceable goal?
 *   controlled_execution  did deterministic runs actually happen, on a decided stack?
 *   change_validation     was the change proved (quality scripts + gates that passed)?
 *   reliable_delivery     is the work committed, pushed, launchable?
 *   learning_capture      was what the project learned written down?
 *
 * Reading a diff cannot answer any of those questions. This report answers
 * them from evidence THIS harness already produces — the trace database
 * (imp/data/fia.db), the ai-docs/ documents and the launch check — so every
 * score is computed by code, never inferred by a model.
 *
 * The honesty rule: a dimension whose evidence is ABSENT is `unknown`, never
 * zero. "Configured" is not "used", and "not observed" is not "bad". An
 * unknown dimension contributes 0 to the score AND 0 to the maximum, and each
 * missing input is named in `gaps`, so the report says out loud what it could
 * not see. Every finding names the exact IMPACTUS command that repairs it.
 *
 * Read-only: nothing here mutates the project, except the HTML document
 * `--html` writes — and that write is refused while an FDA holds the run lock
 * (the run's permission gate would roll it back anyway).
 *
 * Usage:
 *   node imp/scripts/loop-health.mjs [--dir <root>] [--json] [--html <path>] [--strict]
 *     --json    pure JSON on stdout (the --html notice goes to stderr)
 *     --html    also write the self-contained HTML report (default path:
 *               imp/reports/loop-health.html)
 *     --strict  exit 1 when any dimension is `weak` (CI-friendly)
 *
 * Two env overrides keep the report testable and machine-friendly:
 * IAI_DECISION_LOG_NOW fixes the timestamp, FIA_BACKUPS_DIR replaces the
 * backup folder the launch check would otherwise look for under the home
 * directory.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPlanOverview, readPlanSpecs, readPlanTasks, readComponentRegistry } from './plan-docs.mjs';
import { openDb, specTraceability } from './fia-tui-data.mjs';
import { runLaunchChecks } from './fia-launch-check.mjs';
import { readLogs, now } from './decision-log.mjs';
import { activeFdaLock } from './fda-lock.mjs';

export const HTML_DEFAULT = join('imp', 'reports', 'loop-health.html');

/** The five dimensions, in their fixed report order. */
export const DIMENSIONS = Object.freeze([
  {
    id: 'task_understanding',
    title: 'Task understanding',
    what: 'The loop started from a written goal an agent can act on: specs, traceable requirements, a task index and a real PRD.',
  },
  {
    id: 'controlled_execution',
    title: 'Controlled execution',
    what: 'Deterministic FDA runs actually happened, reached their goal, and ran against a stack that was decided rather than guessed.',
  },
  {
    id: 'change_validation',
    title: 'Change validation',
    what: 'The change was proved: the quality commands exist and the test/lint/build gates really passed inside a run.',
  },
  {
    id: 'reliable_delivery',
    title: 'Reliable delivery',
    what: 'The work is delivered the way the project promises: no launch blockers, a clean and pushed tree, test users recorded, CI in place.',
  },
  {
    id: 'learning_capture',
    title: 'Learning capture',
    what: 'What the project decided and learned was written down: decision logs closed, the inbox drained, the component registry honest.',
  },
]);

const STATUS_ORDER = ['strong', 'partial', 'weak', 'unknown'];

// ── small helpers ────────────────────────────────────────────────────────────

/** Repo-relative path with forward slashes, so a finding reads the same on Windows. */
function relPath(root, abs) {
  const r = relative(root, abs);
  return (r && !r.startsWith('..') ? r : abs).replaceAll('\\', '/');
}

/** Every query is optional: a schema-less or half-written db degrades to []. */
function rows(db, sql) {
  try {
    return db.prepare(sql).all();
  } catch {
    /* no such table yet — the db file is created before the schema is applied */
    return [];
  }
}

function countBy(list, key) {
  const out = {};
  for (const r of list) out[String(r[key] ?? 'unknown')] = Number(r.n || 0);
  return out;
}

function topEntry(map) {
  let best = null;
  for (const [k, v] of Object.entries(map || {})) if (!best || v > best.count) best = { name: k, count: v };
  return best;
}

function sumValues(map) {
  return Object.values(map || {}).reduce((a, b) => a + Number(b || 0), 0);
}

// ── evidence ─────────────────────────────────────────────────────────────────

/** Trace-db evidence. Never throws: absence and schema gaps are reported, not raised. */
function collectDbEvidence(root, dbPath, gaps) {
  const shown = relPath(root, dbPath);
  const out = {
    available: false,
    path: shown,
    hasSchema: false,
    hasOutcomeColumn: false,
    runs: 0,
    running: 0,
    finished: 0,
    succeeded: 0,
    byStatus: {},
    byOutcome: null,
    gateFailures: {},
    gatePasses: {},
    failedPhases: {},
  };
  let db = null;
  try {
    db = openDb(dbPath);
  } catch {
    /* corrupt or unreadable file — the report degrades to "no run evidence" */
    db = null;
  }
  if (!db) {
    gaps.push(`no FDA trace database at ${shown} — execution, gate and phase evidence could not be read`);
    return out;
  }
  out.available = true;
  try {
    const columns = rows(db, 'PRAGMA table_info(sessions)').map((c) => c.name);
    out.hasSchema = columns.includes('fda_id');
    // The `outcome` column is newer than the oldest databases in the field:
    // probe for it, and report its absence as a gap instead of crashing.
    out.hasOutcomeColumn = columns.includes('outcome');
    if (!out.hasSchema) {
      gaps.push(`${shown} exists but has no FIA schema yet — no run has been traced in this project`);
      return out;
    }
    out.byStatus = countBy(rows(db, 'SELECT status, COUNT(*) AS n FROM sessions GROUP BY status'), 'status');
    out.runs = sumValues(out.byStatus);
    out.running = out.byStatus.running || 0;
    out.finished = Math.max(0, out.runs - out.running);
    out.succeeded = out.byStatus.success || 0;
    if (out.hasOutcomeColumn) {
      out.byOutcome = countBy(rows(db, 'SELECT outcome, COUNT(*) AS n FROM sessions GROUP BY outcome'), 'outcome');
    } else {
      gaps.push(
        `${shown} has no sessions.outcome column (older schema) — why a run stopped could not be read, only its status`,
      );
    }
    out.gateFailures = countBy(
      rows(db, 'SELECT gate, COUNT(*) AS n FROM gate_results WHERE passed = 0 GROUP BY gate'),
      'gate',
    );
    out.gatePasses = countBy(
      rows(db, 'SELECT gate, COUNT(*) AS n FROM gate_results WHERE passed = 1 GROUP BY gate'),
      'gate',
    );
    out.failedPhases = countBy(
      rows(db, "SELECT name, COUNT(*) AS n FROM phases WHERE status = 'fail' GROUP BY name"),
      'name',
    );
  } finally {
    try {
      db.close();
    } catch {
      /* already closed — nothing to do */
    }
  }
  return out;
}

/**
 * `{{placeholder}}` count — same rule as project-mode.mjs: the CLI installs a
 * PRD TEMPLATE, so "PRD.md exists" is never evidence of a real product goal.
 */
function classifyPrd(aiDocsDir) {
  let text = null;
  try {
    text = readFileSync(join(aiDocsDir, 'PRD.md'), 'utf8');
  } catch {
    /* absent or unreadable — treated as missing */
  }
  if (text == null) return { state: 'missing', placeholders: 0, file: 'PRD.md' };
  const placeholders = (text.match(/\{\{[^{}]+\}\}/g) || []).length;
  return { state: placeholders > 0 ? 'template' : 'real', placeholders, file: 'PRD.md' };
}

/**
 * The whole raw bundle the report is computed from — collected once, embedded
 * in the report so every score is auditable without re-running anything.
 */
export function collectEvidence(root = process.cwd(), opts = {}) {
  root = resolve(root);
  const aiDocsDir = opts.aiDocsDir ? resolve(opts.aiDocsDir) : join(root, 'ai-docs');
  const dbPath = opts.dbPath ? resolve(opts.dbPath) : join(root, 'imp', 'data', 'fia.db');
  const gaps = [];
  const aiDocs = existsSync(aiDocsDir);
  if (!aiDocs)
    gaps.push(`no ${relPath(root, aiDocsDir)}/ directory — specs, tasks, decisions and the inbox could not be read`);

  const db = collectDbEvidence(root, dbPath, gaps);
  const available = aiDocs || (db.available && db.hasSchema);

  let specsDoc = { available: false, specs: [], counts: { total: 0 } };
  let tasksDoc = { available: false, counts: { total: 0 }, indexFile: 'todos/task-master.md' };
  let overview = null;
  try {
    specsDoc = readPlanSpecs(aiDocsDir);
    tasksDoc = readPlanTasks(aiDocsDir);
    overview = readPlanOverview(aiDocsDir, root);
  } catch {
    /* the plan readers are tolerant by contract — this is belt and braces */
  }

  const traced = [];
  for (const spec of specsDoc.specs || []) {
    let t = { available: false, covered: 0, total: 0 };
    try {
      t = specTraceability(aiDocsDir, spec.file);
    } catch {
      /* unreadable spec — counted as untraced */
    }
    traced.push({ file: spec.file, status: spec.status, rows: t.total, covered: t.covered });
  }
  const specs = {
    available: Boolean(specsDoc.available),
    total: specsDoc.counts?.total || 0,
    withTraceability: traced.filter((s) => s.rows > 0 && s.covered > 0).length,
    rows: traced.reduce((n, s) => n + s.rows, 0),
    covered: traced.reduce((n, s) => n + s.covered, 0),
    files: traced,
  };

  const tasks = {
    available: Boolean(tasksDoc.available),
    total: tasksDoc.counts?.total || 0,
    counts: tasksDoc.counts || {},
    indexFile: tasksDoc.indexFile || 'todos/task-master.md',
    indexExists: existsSync(join(aiDocsDir, 'todos', 'task-master.md')),
  };

  let logs = [];
  try {
    logs = readLogs(root);
  } catch {
    /* unreadable decisions directory — treated as none */
  }
  const decisions = {
    total: logs.length,
    open: logs.filter((l) => l.status === 'open').length,
    closed: logs.filter((l) => l.status === 'closed').length,
    superseded: logs.filter((l) => l.status === 'superseded').length,
    commands: [...new Set(logs.map((l) => l.command))].sort(),
  };

  const inboxDoc = overview?.inbox || { available: false, open: 0, done: 0, total: 0 };
  const inbox = {
    available: Boolean(inboxDoc.available),
    open: inboxDoc.open || 0,
    done: inboxDoc.done || 0,
    total: inboxDoc.total || 0,
  };

  let registryDoc = { exists: false, entries: [] };
  try {
    registryDoc = readComponentRegistry(aiDocsDir);
  } catch {
    /* unreadable registry — treated as absent */
  }
  const registry = {
    exists: Boolean(registryDoc.exists),
    rows: (registryDoc.entries || []).length,
    planned: (registryDoc.entries || []).filter((e) => /^planned$/i.test(String(e.status || '').trim())).length,
  };

  let launch = { available: false, summary: null, rung: null, checks: {} };
  if (available) {
    try {
      // backupsDir: the launch check otherwise reads the developer's real
      // ~/Documents — the option (and FIA_BACKUPS_DIR) keeps that overridable.
      const backupsDir = opts.backupsDir || process.env.FIA_BACKUPS_DIR;
      const report = runLaunchChecks(root, { aiDocsDir, ...(backupsDir ? { backupsDir } : {}) });
      const checks = {};
      for (const c of report.checks) checks[c.id] = { status: c.status, level: c.level, detail: c.detail || null };
      launch = { available: true, summary: report.summary, rung: report.rung, checks };
    } catch {
      gaps.push('the launch check could not run — delivery readiness could not be read');
    }
  } else {
    gaps.push('the launch check was not run — there is no work loop to check yet');
  }

  return {
    root,
    project: basename(root) || 'project',
    generatedAt: opts.now || now(),
    aiDocsDir: relPath(root, aiDocsDir),
    aiDocs,
    available,
    db,
    specs,
    tasks,
    decisions,
    inbox,
    testCredentials: existsSync(join(aiDocsDir, 'test-credentials.md')),
    registry,
    prd: classifyPrd(aiDocsDir),
    launch,
    gaps,
  };
}

// ── scoring ──────────────────────────────────────────────────────────────────

/**
 * One criterion worth one point. `ok`: true = earned, false = a finding,
 * null = NOT OBSERVABLE — scored neither for nor against, and its `gap` is
 * reported instead. That third state is what keeps the report honest.
 */
function crit(id, ok, { severity = 'medium', summary = '', evidence = '', repair = '', gap = '' } = {}) {
  return { id, ok, severity, summary, evidence, repair, gap };
}

/** Read one launch-check status; an absent check is `null` (not observable). */
function checkStatus(evidence, id) {
  return evidence.launch?.checks?.[id]?.status ?? null;
}

function checkDetail(evidence, id) {
  return evidence.launch?.checks?.[id]?.detail || 'reported as failing, with no further detail';
}

/**
 * A launch check turned into a criterion: pass → earned, fail → finding,
 * skip/absent → gap (the launch check skips what does not apply, and "does not
 * apply" is exactly a thing this report must not score).
 */
function fromCheck(evidence, id, { severity, summary, repair, gap }) {
  const status = checkStatus(evidence, id);
  if (status === 'pass') return crit(id, true, { severity, summary, repair, evidence: 'launch check: pass' });
  if (status === 'fail')
    return crit(id, false, { severity, summary, repair, evidence: `launch check ${id}: ${checkDetail(evidence, id)}` });
  return crit(id, null, { severity, summary, repair, gap });
}

function taskUnderstanding(e) {
  const specsFile = `${e.aiDocsDir}/specs/`;
  return [
    crit('specs_exist', e.specs.total > 0, {
      severity: 'high',
      summary: 'The project writes specs before it builds',
      evidence: e.specs.total > 0 ? `${e.specs.total} spec(s) in ${specsFile}` : `no spec files in ${specsFile}`,
      repair: '/spec',
    }),
    e.specs.total === 0
      ? crit('specs_traceability', null, {
          gap: `traceability was not judged — there is no spec in ${specsFile} to carry a Requirement/Scenario/Test table`,
        })
      : crit('specs_traceability', e.specs.withTraceability === e.specs.total && e.specs.covered > 0, {
          severity: 'high',
          summary: 'Every spec carries a filled traceability table',
          evidence: `${e.specs.withTraceability}/${e.specs.total} spec(s) with a covered traceability row (${e.specs.covered}/${e.specs.rows} rows name a test)`,
          repair: '/spec',
        }),
    crit('tasks_index', e.tasks.indexExists && e.tasks.total > 0, {
      severity: 'medium',
      summary: 'The work is broken into indexed tasks',
      evidence: e.tasks.indexExists
        ? `${e.aiDocsDir}/${e.tasks.indexFile} lists ${e.tasks.total} task(s)`
        : `no ${e.aiDocsDir}/${e.tasks.indexFile}`,
      repair: '/map',
    }),
    crit('prd_real', e.prd.state === 'real', {
      severity: e.prd.state === 'missing' ? 'medium' : 'high',
      summary: 'A real PRD describes what is being built',
      evidence:
        e.prd.state === 'real'
          ? `${e.aiDocsDir}/${e.prd.file} is filled in (no placeholders left)`
          : e.prd.state === 'template'
            ? `${e.aiDocsDir}/${e.prd.file} still has ${e.prd.placeholders} {{placeholder}}(s) — it is the installed template`
            : `no ${e.aiDocsDir}/${e.prd.file}`,
      repair: e.prd.state === 'template' ? '/prd' : '/idea',
    }),
  ];
}

function controlledExecution(e) {
  const db = e.db;
  const runsKnown = db.available && db.hasSchema;
  const blocked = db.byOutcome ? db.byOutcome.blocked_by_gate || 0 : null;
  const failedRuns = Math.max(0, db.finished - db.succeeded);
  const failedPhases = sumValues(db.failedPhases);
  const worstPhase = topEntry(db.failedPhases);
  return [
    runsKnown
      ? crit('runs_recorded', db.runs > 0, {
          severity: 'high',
          summary: 'Deterministic FDA runs are actually being used',
          evidence: db.runs > 0 ? `${db.runs} run(s) traced in ${db.path}` : `${db.path} has no traced run yet`,
          repair: '/task',
        })
      : crit('runs_recorded', null, {
          gap: `run history was not judged — no FDA run has ever been traced in ${db.path}`,
        }),
    runsKnown && db.finished > 0
      ? crit('runs_reach_their_goal', failedRuns / db.finished <= 0.34, {
          severity: 'high',
          summary: 'Runs mostly reach their goal instead of dying',
          evidence:
            `${db.succeeded}/${db.finished} finished run(s) succeeded` +
            (blocked == null ? ' (no outcome column — reasons unknown)' : ` · blocked_by_gate: ${blocked}`),
          repair: 'npm run tui',
        })
      : crit('runs_reach_their_goal', null, {
          gap: 'run outcomes were not judged — no FDA run has finished in this project yet',
        }),
    runsKnown && db.runs > 0
      ? crit('phases_not_thrashing', failedPhases <= db.runs, {
          severity: 'medium',
          summary: 'Phases are not thrashing inside the runs',
          evidence:
            failedPhases === 0
              ? 'no failed phase recorded'
              : `${failedPhases} failed phase attempt(s) across ${db.runs} run(s)` +
                (worstPhase ? ` — worst: ${worstPhase.name} (${worstPhase.count})` : ''),
          repair: 'npm run tui',
        })
      : crit('phases_not_thrashing', null, {
          gap: 'phase health was not judged — there is no traced run to read phases from',
        }),
    fromCheck(e, 'stack_decided', {
      severity: 'high',
      summary: 'The stack is decided, so runs build on known ground',
      repair: '/stack',
      gap: `the stack was not judged — no ${e.aiDocsDir}/stack.md manifest exists to compare against`,
    }),
  ];
}

const QUALITY_GATE = /(test|lint|type|build|typecheck)/i;

function changeValidation(e) {
  const db = e.db;
  const passes = Object.entries(db.gatePasses).filter(([g]) => QUALITY_GATE.test(g));
  const failures = Object.entries(db.gateFailures);
  const worstFailure = topEntry(db.gateFailures);
  const gateRows = sumValues(db.gatePasses) + sumValues(db.gateFailures);
  return [
    fromCheck(e, 'quality_scripts', {
      severity: 'high',
      summary: 'The quality commands the gates depend on exist',
      repair: 'npm run launch:check',
      gap: 'the quality commands were not judged — package.json could not be read',
    }),
    gateRows > 0
      ? crit('quality_gates_passed', passes.length > 0, {
          severity: 'high',
          summary: 'The test/lint/build gates really passed inside a run',
          evidence:
            passes.length > 0
              ? `gates passed: ${passes.map(([g, n]) => `${g}×${n}`).join(', ')}`
              : `${gateRows} gate result(s) recorded, none of them a passing test/lint/build gate`,
          repair: 'npm run launch:check',
        })
      : crit('quality_gates_passed', null, {
          gap: 'gate results were not judged — no run has recorded a gate result in the trace database',
        }),
    gateRows > 0
      ? crit('no_dominant_gate_failure', !worstFailure || worstFailure.count < 3, {
          severity: 'medium',
          summary: 'No single gate keeps failing run after run',
          evidence: worstFailure
            ? `most-failed gate: ${worstFailure.name} (${worstFailure.count} failure(s)); ${failures.length} gate(s) failed at least once`
            : 'no gate failure recorded',
          repair: 'npm run tui',
        })
      : crit('no_dominant_gate_failure', null, {
          gap: 'repeated gate failures were not judged — the trace database holds no gate results',
        }),
    e.specs.total > 0
      ? crit('specs_have_tests', e.specs.rows > 0 && e.specs.covered === e.specs.rows, {
          severity: 'medium',
          summary: 'Every specified requirement names the test that proves it',
          evidence: `${e.specs.covered}/${e.specs.rows} traceability row(s) name a test`,
          repair: '/spec',
        })
      : crit('specs_have_tests', null, {
          gap: 'requirement-level proof was not judged — there is no spec to trace tests from',
        }),
  ];
}

function reliableDelivery(e) {
  const summary = e.launch?.summary;
  return [
    summary
      ? crit('no_launch_blockers', summary.blockers === 0, {
          severity: 'high',
          summary: 'No launch blocker is open',
          evidence: `launch check: ${summary.blockers} blocker(s), ${summary.warns} warning(s), ${summary.passes} pass(es)`,
          repair: 'npm run launch:check',
        })
      : crit('no_launch_blockers', null, { gap: 'launch blockers were not judged — the launch check did not run' }),
    fromCheck(e, 'clean_tree', {
      severity: 'medium',
      summary: 'The working tree is committed',
      repair: 'npm run docs:commit',
      gap: 'the working tree was not judged — this project is not a git repository',
    }),
    fromCheck(e, 'pushed', {
      severity: 'medium',
      summary: 'Commits are pushed to the remote',
      repair: 'npm run launch:check',
      gap: 'pushing was not judged — the branch has no remote to compare against',
    }),
    fromCheck(e, 'test_credentials', {
      severity: 'medium',
      summary: 'Test users are recorded in the roster',
      repair: '/launch',
      gap: `test users were not judged — the launch check only demands ${e.aiDocsDir}/test-credentials.md when the stack declares auth`,
    }),
    fromCheck(e, 'ci_workflow', {
      severity: 'low',
      summary: 'A CI workflow guards the repository',
      repair: '/launch',
      gap: 'CI was not judged — the launch check reported no workflow status',
    }),
  ];
}

function learningCapture(e) {
  const d = e.decisions;
  return [
    crit('decisions_logged', d.total > 0, {
      severity: 'medium',
      summary: 'Interview answers become versioned decision logs',
      evidence:
        d.total > 0
          ? `${d.total} decision log(s) in ${e.aiDocsDir}/decisions/`
          : `no decision log in ${e.aiDocsDir}/decisions/`,
      repair: '/idea',
    }),
    d.total > 0
      ? crit('decisions_closed', d.open <= 1, {
          severity: 'low',
          summary: 'Decision logs get closed, not abandoned',
          evidence: `${d.closed} closed · ${d.open} open · ${d.superseded} superseded`,
          repair: '/guide',
        })
      : crit('decisions_closed', null, {
          gap: 'decision-log discipline was not judged — no decision log exists to close',
        }),
    e.inbox.available
      ? crit('inbox_drained', e.inbox.open <= 3, {
          severity: 'low',
          summary: 'The inbox is being drained, not hoarded',
          evidence: `${e.inbox.open} open item(s), ${e.inbox.done} promoted in ${e.aiDocsDir}/inbox.md`,
          repair: '/quick',
        })
      : crit('inbox_drained', null, { gap: `the inbox was not judged — there is no ${e.aiDocsDir}/inbox.md` }),
    e.registry.exists && e.registry.rows > 0
      ? crit('registry_built', e.registry.planned === 0, {
          severity: 'medium',
          summary: 'No component registry row is still only planned',
          evidence: `${e.registry.rows} registry row(s), ${e.registry.planned} still planned`,
          repair: '/component',
        })
      : crit('registry_built', null, {
          gap: `the component registry was not judged — ${e.aiDocsDir}/components/registry.md is ${e.registry.exists ? 'empty' : 'absent'}`,
        }),
  ];
}

const CRITERIA = {
  task_understanding: taskUnderstanding,
  controlled_execution: controlledExecution,
  change_validation: changeValidation,
  reliable_delivery: reliableDelivery,
  learning_capture: learningCapture,
};

function statusFor(score, max) {
  if (max === 0) return 'unknown';
  if (score >= 0.8 * max) return 'strong';
  if (score >= 0.4 * max) return 'partial';
  return 'weak';
}

/** Grade every dimension; internal twin of scoreDimensions that also collects gaps. */
function gradeAll(evidence) {
  const dimensions = [];
  const gaps = [];
  for (const meta of DIMENSIONS) {
    const criteria = evidence.available ? CRITERIA[meta.id](evidence) : [];
    let score = 0;
    let max = 0;
    const findings = [];
    for (const c of criteria) {
      if (c.ok == null) {
        if (c.gap) gaps.push(c.gap);
        continue;
      }
      max += 1;
      if (c.ok) score += 1;
      else
        findings.push({ id: c.id, severity: c.severity, summary: c.summary, evidence: c.evidence, repair: c.repair });
    }
    dimensions.push({
      id: meta.id,
      title: meta.title,
      what: meta.what,
      score,
      max,
      // How many criteria this dimension HAS, against the `max` that could be
      // judged. Without it a dimension can read "strong (1/1)" off one lucky
      // criterion while the other three were never observed — technically
      // honest, and exactly the wrong impression.
      criteria: criteria.length,
      status: statusFor(score, max),
      findings,
    });
  }
  return { dimensions, gaps };
}

/** The dimensions array of the report — scored purely from the evidence bundle. */
export function scoreDimensions(evidence) {
  return gradeAll(evidence).dimensions;
}

/** Collect, score and summarize. Read-only: nothing on disk changes. */
export function runLoopHealth(root = process.cwd(), opts = {}) {
  const evidence = collectEvidence(root, opts);
  const { dimensions, gaps } = gradeAll(evidence);
  const summary = { score: 0, max: 0, percent: null, strong: 0, partial: 0, weak: 0, unknown: 0 };
  for (const d of dimensions) {
    summary.score += d.score;
    summary.max += d.max;
    summary[d.status] += 1;
  }
  summary.percent = summary.max > 0 ? Math.round((summary.score / summary.max) * 100) : null;
  const allGaps = [...evidence.gaps, ...gaps];
  if (!evidence.available) {
    allGaps.unshift(
      'nothing could be scored — this project has neither an ai-docs/ directory nor a traced FDA run, so it has no work loop yet',
    );
  }
  return {
    available: evidence.available,
    root: evidence.root,
    dimensions,
    summary,
    evidence,
    gaps: [...new Set(allGaps)],
  };
}

// ── text rendering ───────────────────────────────────────────────────────────

const GLYPH = { strong: '✓', partial: '~', weak: '✗', unknown: '○' };

/** Human report. Pure string building. */
export function renderLoopHealth(report) {
  const e = report.evidence || {};
  const lines = ['Loop health — how well this project runs its agent work loop (read-only report)'];
  if (!report.available) {
    lines.push(
      '',
      'Nothing to score: there is no ai-docs/ directory and no traced FDA run in this project,',
      'so the loop has not started yet.',
      '',
      'Start it: /onboarding on an existing codebase, /idea on a new one.',
    );
    return lines.join('\n');
  }
  const s = report.summary;
  lines.push(`Project: ${e.project || basename(report.root)}   Generated: ${e.generatedAt || 'unknown'}`);
  lines.push(
    `Score: ${s.score}/${s.max}${s.percent == null ? '' : ` (${s.percent}%)`}  ·  ` +
      STATUS_ORDER.map((k) => `${s[k]} ${k}`).join(' · '),
  );
  for (const d of report.dimensions) {
    lines.push(
      '',
      `${GLYPH[d.status]} ${d.title} — ${d.status}${d.max ? ` (${d.score}/${d.max})` : ' (not observed)'}` +
        (d.max && d.criteria > d.max ? ` · only ${d.max} of ${d.criteria} criteria could be judged` : ''),
    );
    lines.push(`    ${d.what}`);
    if (!d.findings.length) {
      lines.push(d.max ? '    nothing to repair here' : '    no evidence for this dimension — see the gaps below');
      continue;
    }
    for (const f of d.findings) {
      lines.push(`    [${f.severity}] ${f.summary}`);
      lines.push(`        evidence: ${f.evidence}`);
      lines.push(`        repair:   ${f.repair}`);
    }
  }
  lines.push('', 'Gaps — what could not be observed');
  if (!report.gaps.length) lines.push('  (none — every dimension had evidence)');
  for (const g of report.gaps) lines.push(`  - ${g}`);
  return lines.join('\n');
}

// ── HTML rendering ───────────────────────────────────────────────────────────

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape every interpolated value — evidence strings carry paths, quotes and tags. */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

const STYLE = `
:root{
  --bg:#f7f7f5; --panel:#ffffff; --ink:#191917; --muted:#5c5c55; --line:#e3e2dd;
  --accent:#3d5a80; --strong:#1c6b45; --partial:#8a5b06; --weak:#a32e1c; --unknown:#6b6b63;
  --chip:#f0efeb;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#131311; --panel:#1c1c19; --ink:#f0efe9; --muted:#a5a49b; --line:#2f2f2a;
    --accent:#9db8d8; --strong:#63c795; --partial:#e0b25c; --weak:#f08b78; --unknown:#9a998f;
    --chip:#262622;
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:2rem 1rem 4rem}
main{max-width:60rem;margin:0 auto}
h1{font-size:1.5rem;margin:0 0 .25rem}
h2{font-size:1.05rem;margin:0}
p{margin:.35rem 0}
.sub{color:var(--muted);font-size:.9rem;margin-bottom:1.5rem}
.total{background:var(--panel);border:1px solid var(--line);border-radius:.75rem;padding:1rem 1.25rem;margin-bottom:1.5rem}
.pct{font-size:2.1rem;font-weight:650;letter-spacing:-.02em}
.bar{height:.5rem;background:var(--chip);border-radius:.25rem;overflow:hidden;margin:.6rem 0 .5rem}
.bar span{display:block;height:100%;background:var(--accent)}
.chips{display:flex;flex-wrap:wrap;gap:.4rem;font-size:.8rem}
.chip{background:var(--chip);border-radius:1rem;padding:.15rem .6rem;color:var(--muted)}
.card{background:var(--panel);border:1px solid var(--line);border-left:.25rem solid var(--line);border-radius:.75rem;padding:1rem 1.25rem;margin-bottom:1rem}
.card.strong{border-left-color:var(--strong)} .card.partial{border-left-color:var(--partial)}
.card.weak{border-left-color:var(--weak)} .card.unknown{border-left-color:var(--unknown)}
.head{display:flex;flex-wrap:wrap;gap:.5rem;align-items:baseline;justify-content:space-between}
.badge{font-size:.75rem;text-transform:uppercase;letter-spacing:.06em;font-weight:650}
.strong .badge{color:var(--strong)} .partial .badge{color:var(--partial)}
.weak .badge{color:var(--weak)} .unknown .badge{color:var(--unknown)}
.what{color:var(--muted);font-size:.9rem;margin:.4rem 0 .8rem}
.finding{border-top:1px solid var(--line);padding-top:.7rem;margin-top:.7rem}
.finding .title{font-weight:600}
.sev{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;border:1px solid var(--line);border-radius:.3rem;padding:.05rem .35rem;margin-right:.4rem;color:var(--muted)}
.ev{color:var(--muted);font-size:.88rem;margin:.3rem 0}
code{background:var(--chip);border-radius:.25rem;padding:.1rem .35rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em}
.ok{color:var(--muted);font-size:.9rem}
ul{margin:.4rem 0 0;padding-left:1.2rem}
li{margin:.25rem 0;color:var(--muted)}
footer{color:var(--muted);font-size:.8rem;margin-top:2rem}
`;

function htmlDimension(d) {
  const out = [];
  out.push(`<section class="card ${esc(d.status)}">`);
  out.push('<div class="head">');
  out.push(`<h2>${esc(d.title)}</h2>`);
  const coverage = d.max && d.criteria > d.max ? ` · ${d.max}/${d.criteria} criteria judged` : '';
  out.push(
    `<span class="badge">${esc(d.status)}${d.max ? ` · ${d.score}/${d.max}` : ' · not observed'}${esc(coverage)}</span>`,
  );
  out.push('</div>');
  out.push(`<p class="what">${esc(d.what)}</p>`);
  if (!d.findings.length) {
    out.push(
      `<p class="ok">${d.max ? 'Nothing to repair here.' : 'No evidence for this dimension — see the gaps below.'}</p>`,
    );
  }
  for (const f of d.findings) {
    out.push('<div class="finding">');
    out.push(`<p class="title"><span class="sev">${esc(f.severity)}</span>${esc(f.summary)}</p>`);
    out.push(`<p class="ev">Evidence: ${esc(f.evidence)}</p>`);
    out.push(`<p class="ev">Repair: <code>${esc(f.repair)}</code></p>`);
    out.push('</div>');
  }
  out.push('</section>');
  return out.join('\n');
}

/**
 * One self-contained HTML document: no external CSS, font, script or image —
 * a student's report has to open with no network at all.
 */
export function renderLoopHealthHtml(report) {
  const e = report.evidence || {};
  const s = report.summary || { score: 0, max: 0, percent: null };
  const title = `Loop health — ${esc(e.project || basename(report.root || 'project'))}`;
  const parts = [];
  // A real document, not a fragment: without the doctype the browser renders it
  // in quirks mode, and without the charset every em dash and · garbles.
  parts.push('<!doctype html>');
  parts.push('<html lang="en">');
  parts.push('<head>');
  parts.push('<meta charset="utf-8">');
  parts.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  parts.push(`<title>${title}</title>`);
  parts.push(`<style>${STYLE}</style>`);
  parts.push('</head>');
  parts.push('<body>');
  parts.push('<main>');
  parts.push(`<h1>${title}</h1>`);
  parts.push(
    `<p class="sub">Generated ${esc(e.generatedAt || 'unknown')} · read-only report, computed from this project’s own evidence</p>`,
  );
  if (!report.available) {
    parts.push(
      '<div class="total"><p class="pct">—</p><p>Nothing to score: this project has no <code>ai-docs/</code> directory and no traced FDA run, so its work loop has not started yet.</p><p class="ok">Start it: <code>/onboarding</code> on an existing codebase, <code>/idea</code> on a new one.</p></div>',
    );
  } else {
    const pct = s.percent == null ? '—' : `${s.percent}%`;
    parts.push('<div class="total">');
    parts.push(`<p class="pct">${esc(pct)}</p>`);
    parts.push(
      `<div class="bar"><span style="width:${s.percent == null ? 0 : Math.max(0, Math.min(100, s.percent))}%"></span></div>`,
    );
    parts.push(`<p>${esc(`${s.score} of ${s.max} observable point(s) earned`)}</p>`);
    parts.push(
      `<div class="chips">${STATUS_ORDER.map((k) => `<span class="chip">${esc(`${s[k] ?? 0} ${k}`)}</span>`).join('')}</div>`,
    );
    parts.push('</div>');
    for (const d of report.dimensions) parts.push(htmlDimension(d));
  }
  parts.push('<section class="card unknown">');
  parts.push('<div class="head"><h2>Gaps — what could not be observed</h2></div>');
  if (!report.gaps?.length) parts.push('<p class="ok">None — every dimension had evidence.</p>');
  else parts.push(`<ul>${report.gaps.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>`);
  parts.push('</section>');
  parts.push(
    '<footer>Every score here is computed by code from the trace database, the ai-docs documents and the launch check. An unknown dimension is never counted as a failure.</footer>',
  );
  parts.push('</main>');
  parts.push('</body>');
  parts.push('</html>');
  return parts.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function flagValue(argv, flag) {
  const i = argv.indexOf(flag);
  const v = i !== -1 ? argv[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : undefined;
}

export function main(argv) {
  const root = resolve(flagValue(argv, '--dir') || process.cwd());
  const json = argv.includes('--json');
  const wantHtml = argv.includes('--html');
  const htmlPath = wantHtml ? resolve(root, flagValue(argv, '--html') || HTML_DEFAULT) : null;

  // A live FDA holds the run lock: its permission gate attributes every write
  // to the current phase agent and rolls back what the phase did not declare,
  // so writing the report now would simply be reverted (see docs-commit.mjs).
  if (wantHtml) {
    const lock = activeFdaLock(root);
    if (lock) {
      console.error(
        `a FIA run is active (fda_id ${lock.fda_id || 'unknown'}, pid ${lock.pid}) — writing the loop-health report now would be rolled back by that run's permission gate.\n` +
          'Nothing was written. Wait for the run to finish, then re-run this command.',
      );
      return 1;
    }
  }

  const report = runLoopHealth(root);
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderLoopHealth(report));

  if (htmlPath) {
    try {
      mkdirSync(dirname(htmlPath), { recursive: true });
      writeFileSync(htmlPath, renderLoopHealthHtml(report));
      const line = `HTML report written to ${relPath(root, htmlPath)}`;
      // stdout stays pure JSON under --json, so the notice goes to stderr.
      if (json) console.error(line);
      else console.log(`\n${line}`);
    } catch (err) {
      console.error(`could not write the HTML report to ${relPath(root, htmlPath)}: ${err.message}`);
      return 1;
    }
  }

  if (argv.includes('--strict') && report.dimensions.some((d) => d.status === 'weak')) return 1;
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) process.exit(main(process.argv.slice(2)));
