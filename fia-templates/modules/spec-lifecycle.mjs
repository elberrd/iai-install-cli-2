import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import { phaseParams } from './fda-cli.mjs';
import { parseSpecLine } from './gates.mjs';

const SPEC_FILE = /^(\d{4})-[A-Za-z0-9][A-Za-z0-9-]*\.md$/;
const ISSUE_FILE = /^(\d+)-[A-Za-z0-9][A-Za-z0-9-]*\.md$/;

function clean(value) {
  return String(value || '').replace(/[`*]/g, '').trim();
}

/** First plain/bold `Name: value` metadata line. */
function metaLine(md, names) {
  const re = new RegExp(
    `^[-*\\s]*(?:\\*\\*)?\\s*(?:${names})\\s*(?:\\*\\*)?\\s*:\\s*(?:\\*\\*)?\\s*(.+?)\\s*(?:\\*\\*)?\\s*$`,
    'im',
  );
  return clean((re.exec(String(md || '')) || [])[1]);
}

function taskNumbers(value) {
  return [...String(value || '').matchAll(/\b(\d{1,4})\b/g)].map((m) => m[1].padStart(2, '0'));
}

function statusIsDone(md) {
  return /done|conclu/i.test(metaLine(md, 'status'));
}

/**
 * The roadmap issue carried by a generated brief. Only its numeric id is
 * trusted: the path is documentation authored by an agent and is never used
 * directly for filesystem access.
 */
export function briefIssueNumber(md, briefPath = null) {
  const linked = /^\s*>?\s*Issue\s*:\s*`([^`]+)`\s*$/im.exec(String(md || ''));
  const fromLink = linked ? ISSUE_FILE.exec(basename(linked[1].replaceAll('\\', '/'))) : null;
  if (fromLink) return fromLink[1].padStart(2, '0');
  const fromBrief = briefPath ? ISSUE_FILE.exec(basename(briefPath)) : null;
  return fromBrief ? fromBrief[1].padStart(2, '0') : null;
}

function findNumberedFile(dir, id, pattern) {
  let names = [];
  try {
    names = readdirSync(dir).filter((name) => pattern.test(name));
  } catch {
    return null;
  }
  const wanted = String(Number(id));
  return names.sort().find((name) => String(Number((pattern.exec(name) || [])[1])) === wanted) || null;
}

function replaceStatus(md, status) {
  const line = /^(\s*[-*]?\s*(?:\*\*)?\s*Status\s*(?:\*\*)?\s*:\s*)(?:\*\*)?.*?(?:\*\*)?\s*$/im;
  if (line.test(md)) return md.replace(line, `$1${status}`);
  const h1End = md.indexOf('\n');
  return h1End === -1 ? `${md}\n\nStatus: ${status}\n` : `${md.slice(0, h1End + 1)}\nStatus: ${status}\n${md.slice(h1End + 1)}`;
}

function replaceUpdatedDate(md, date) {
  if (!/\bUpdated\s*:\s*\d{4}-\d{2}-\d{2}/i.test(md)) return md;
  return md.replace(/(\bUpdated\s*:\s*)\d{4}-\d{2}-\d{2}/i, `$1${date}`);
}

function appendDeliveryGate(md, line) {
  if (/^\s*[-*]?\s*Delivery Gate\s*:\s*passed\b/im.test(md)) return md;
  const heading = /^##\s+Gate log\s*$/im.exec(md);
  if (!heading) return `${md.replace(/\s*$/, '')}\n\n## Gate log\n\n- ${line}\n`;
  const bodyStart = heading.index + heading[0].length;
  const next = /^##\s+/gm;
  next.lastIndex = bodyStart;
  const following = next.exec(md);
  const sectionEnd = following ? following.index : md.length;
  const before = md.slice(0, sectionEnd).replace(/\s*$/, '');
  const after = md.slice(sectionEnd);
  return `${before}\n- ${line}\n${after}`;
}

function relativePath(repoRoot, path) {
  return (isAbsolute(path) ? relative(repoRoot, path) : path).replaceAll('\\', '/');
}

/**
 * Close the spec linked by this successful FDA run when this is its last
 * linked task. The current issue is treated as delivered because this helper
 * only runs after the suite and every close-out gate passed; the issue/index
 * status itself remains owned by the task workflow.
 *
 * Fail closed on incomplete planning metadata: no Tasks line, an unknown task,
 * or another task not marked done leaves the spec untouched and returns the
 * exact reason for the trace. Re-running is idempotent.
 */
export function reconcileSpecDelivery({
  repoRoot = process.cwd(),
  aiDocsDir = process.env.FIA_AI_DOCS || 'ai-docs',
  prompt = '',
  briefPath = null,
  fdaId = '',
  date = new Date().toISOString().slice(0, 10),
} = {}) {
  const ref = parseSpecLine(prompt);
  if (!ref) return { status: 'skipped', reason: 'the brief has no Spec: line', changed_files: [] };

  const aiDocs = isAbsolute(aiDocsDir) ? aiDocsDir : join(repoRoot, aiDocsDir);
  const specsDir = join(aiDocs, 'specs');
  const specName = findNumberedFile(specsDir, ref.specId, SPEC_FILE);
  if (!specName) {
    return { status: 'pending', spec: ref.specId, reason: `spec ${ref.specId} was not found`, changed_files: [] };
  }

  const specPath = join(specsDir, specName);
  const original = readFileSync(specPath, 'utf8');
  const linkedTasks = taskNumbers(metaLine(original, 'tasks|tarefas'));
  if (!linkedTasks.length) {
    return {
      status: 'pending',
      spec: ref.specId,
      reason: 'the spec has no linked Tasks: list, so completion cannot be proven',
      changed_files: [],
    };
  }

  const currentTask = briefIssueNumber(prompt, briefPath);
  if (!currentTask) {
    return {
      status: 'pending',
      spec: ref.specId,
      reason: 'the current roadmap issue cannot be identified from the brief',
      changed_files: [],
    };
  }
  if (!linkedTasks.some((task) => Number(task) === Number(currentTask))) {
    return {
      status: 'pending',
      spec: ref.specId,
      reason: `current task ${currentTask} is not listed on the spec's Tasks: line`,
      changed_files: [],
    };
  }
  const issuesDir = join(aiDocs, 'todos', 'issues');
  const pending = [];
  const unknown = [];
  for (const task of linkedTasks) {
    if (currentTask && Number(task) === Number(currentTask)) continue;
    const name = findNumberedFile(issuesDir, task, ISSUE_FILE);
    if (!name) {
      unknown.push(task);
      continue;
    }
    if (!statusIsDone(readFileSync(join(issuesDir, name), 'utf8'))) pending.push(task);
  }
  if (unknown.length || pending.length) {
    const parts = [];
    if (pending.length) parts.push(`tasks not done: ${pending.join(', ')}`);
    if (unknown.length) parts.push(`task files not found: ${unknown.join(', ')}`);
    return { status: 'pending', spec: ref.specId, reason: parts.join('; '), pending, unknown, changed_files: [] };
  }

  const evidence = `Delivery Gate: passed — ${date} — FDA${fdaId ? ` ${fdaId}` : ''}: suite green, coverage check ok`;
  let updated = appendDeliveryGate(original, evidence);
  updated = replaceStatus(updated, 'done');
  updated = replaceUpdatedDate(updated, date);
  if (updated === original) {
    return { status: 'already-done', spec: ref.specId, tasks: linkedTasks, changed_files: [] };
  }
  writeFileSync(specPath, updated);
  return {
    status: 'closed',
    spec: ref.specId,
    tasks: linkedTasks,
    evidence,
    changed_files: [relativePath(repoRoot, specPath)],
  };
}

/** Deterministic, traced close-out used by the tested task FDAs. */
export async function runSpecDeliveryClose(run, prompt, briefPath) {
  return run.runPhase(
    phaseParams('spec_close', 'code', 'planning', 'Close the linked spec when its final task passed every delivery gate'),
    async (ph) => {
      const result = reconcileSpecDelivery({
        repoRoot: run.repoRoot,
        aiDocsDir: run.env.FIA_AI_DOCS || 'ai-docs',
        prompt,
        briefPath,
        fdaId: run.fdaId,
      });
      if (result.status === 'closed' || result.status === 'already-done') {
        ph.log({ spec: result.spec, status: result.status, tasks: result.tasks.join(',') });
      } else {
        ph.log({ spec: result.spec || 'none', status: result.status, reason: result.reason });
      }
      return result;
    },
  );
}
