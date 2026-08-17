/**
 * Plan docs reader — parses the /map (and /start) artifacts under ai-docs/
 * into viewer-friendly shapes: screens/routes, task breakdown, design system,
 * workflow progress, milestones, specs, the examples library and the idea
 * inbox. Read-only; parses are cached by mtime+size so live polling stays
 * cheap. Nothing here throws: a missing document yields an empty shape, an
 * unparseable table falls back to raw markdown for the UI to render.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { parse as parseYaml, parseDocument } from 'yaml';

const MAX_DOC_BYTES = 512 * 1024;
const MAX_ISSUES = 300;
const ISSUE_FILE = /^(\d{1,3})-([A-Za-z0-9][A-Za-z0-9-]*)\.md$/;
const SAFE_DOC_PATH = /^[a-zA-Z0-9][a-zA-Z0-9._/ -]*\.(md|ya?ml|json|txt)$/;

const cache = new Map(); // path → { mtimeMs, size, value }

/** Read + build with an mtime+size cache. Never throws: missing/broken → null. */
function cached(path, build) {
  let st;
  try {
    st = statSync(path);
  } catch {
    cache.delete(path);
    return null;
  }
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
  let value = null;
  try {
    value = build(readFileSync(path, 'utf8').slice(0, MAX_DOC_BYTES), st);
  } catch {
    value = null;
  }
  cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}

/** Unfilled template placeholders ({{X}} / {{X | default}}) and blanks → null. */
export function clean(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === 'null' || /^\{\{[^}]*\}\}$/.test(s)) return null;
  return s;
}

function cleanList(v) {
  if (!Array.isArray(v)) return [];
  return v.map(clean).filter(Boolean);
}

function fileInfo(absPath, relPath, label) {
  try {
    const st = statSync(absPath);
    return { path: relPath, label, kind: kindOf(relPath), exists: true, bytes: st.size, updatedAt: new Date(st.mtimeMs).toISOString() };
  } catch {
    return { path: relPath, label, kind: kindOf(relPath), exists: false, bytes: 0, updatedAt: null };
  }
}

function kindOf(p) {
  if (/\.ya?ml$/i.test(p)) return 'yaml';
  if (/\.json$/i.test(p)) return 'json';
  if (/\.md$/i.test(p)) return 'md';
  return 'txt';
}

// ── Markdown tables ──────────────────────────────────────────────────────────

/** "Auth Required" → "authrequired"; "Localização" → "localizacao". */
export function normKey(h) {
  return String(h || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Extract EVERY table from a markdown document, tagged with the nearest
 * heading above it. Purely positional and tolerant: accepts rows without
 * leading/trailing pipes, missing/extra cells, and separators with or
 * without alignment colons. Tables inside code fences are ignored.
 */
export function parseMdTables(md) {
  const lines = String(md || '').split('\n');
  const out = [];
  let heading = '';
  let level = 0;
  let inFence = false;

  const isRow = (l) => typeof l === 'string' && l.includes('|') && l.trim().length > 1;
  const isSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(l || '');
  const cells = (l) => {
    let s = l.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map((c) => c.trim());
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) {
      level = h[1].length;
      heading = h[2].trim();
      continue;
    }
    if (!isRow(l) || !isSep(lines[i + 1])) continue;

    const headers = cells(l);
    const keys = headers.map(normKey);
    const raw = [];
    let j = i + 2;
    for (; j < lines.length && isRow(lines[j]) && !isSep(lines[j]); j++) raw.push(cells(lines[j]));
    out.push({
      heading,
      level,
      headers,
      keys,
      raw,
      rows: raw.map((r) => {
        const o = { _cells: r };
        keys.forEach((k, n) => {
          if (k && o[k] === undefined) o[k] = r[n] == null ? '' : r[n];
        });
        return o;
      }),
    });
    i = j - 1;
  }
  return out;
}

/** First non-empty value among the aliased columns of a parsed row. */
function pick(row, aliases) {
  for (const a of aliases) if (row[a]) return row[a];
  return '';
}

// ── Screens & routes (screens-routes.md) ─────────────────────────────────────

const ROUTE_KEYS = ['route', 'rota', 'path', 'caminho'];
const COMP_KEYS = ['screencomponent', 'component', 'componente', 'screen', 'tela'];
const FILE_KEYS = ['filelocation', 'suggestedlocation', 'location', 'arquivo', 'localizacao', 'file'];
const AUTH_KEYS = ['authrequired', 'auth', 'autenticacao', 'requerauth'];
const NOTE_KEYS = ['status', 'notes', 'observacoes', 'notas'];
const STATUS_RANK = { implemented: 3, partial: 2, todo: 1 };

/**
 * ✅ / 🔄 / ⏳ (and their textual forms) → implemented | partial | todo.
 * Order matters: "To Be Implemented" contains "implemented".
 */
export function statusFromText(txt, fallback = null) {
  const t = String(txt || '');
  if (/🔄|\bpartial\b|parcial/i.test(t)) return 'partial';
  if (/⏳|to be implemented|a implementar|\bpending\b|pendente|\btodo\b/i.test(t)) return 'todo';
  if (/✅|\bimplemented\b|implementad|\bdone\b|\bpronto\b/i.test(t)) return 'implemented';
  return fallback;
}

/** Row status: the status/notes cell decides; emojis anywhere override; else the table heading. */
function rowStatus(row, base) {
  const fromCell = statusFromText(pick(row, NOTE_KEYS), null);
  if (fromCell) return fromCell;
  const all = (row._cells || []).join(' ');
  if (all.includes('🔄')) return 'partial';
  if (all.includes('⏳')) return 'todo';
  if (all.includes('✅')) return 'implemented';
  return base;
}

/** Slice a markdown doc into heading sections (##/### and deeper). */
function mdSections(md) {
  const lines = String(md || '').split('\n');
  const sections = [];
  let cur = null;
  let inFence = false;
  for (const l of lines) {
    if (l.trimStart().startsWith('```')) inFence = !inFence;
    const h = !inFence && /^(#{2,6})\s+(.*)$/.exec(l);
    if (h) {
      cur = { id: `s${sections.length}`, title: h[2].trim(), level: h[1].length, markdown: '' };
      sections.push(cur);
      continue;
    }
    if (cur) cur.markdown += (cur.markdown ? '\n' : '') + l;
  }
  return sections;
}

export function readPlanScreens(aiDocsDir) {
  const empty = {
    available: false,
    file: 'screens-routes.md',
    updatedAt: null,
    summary: [],
    screens: [],
    counts: { implemented: 0, partial: 0, todo: 0, total: 0 },
    sections: [],
    fallbackMarkdown: null,
    parseWarnings: [],
  };
  const parsed = cached(join(aiDocsDir, 'screens-routes.md'), (md, st) => {
    const tables = parseMdTables(md);
    const parseWarnings = [];

    const summary = [];
    const byRoute = new Map();
    for (const t of tables) {
      if (t.keys.includes('category') && t.keys.some((k) => k.includes('implemented'))) {
        for (const r of t.rows) {
          summary.push({
            category: pick(r, ['category', 'categoria']),
            implemented: pick(r, ['implemented', 'implementadas', 'implementada']),
            todo: pick(r, ['tobeimplemented', 'aimplementar', 'todo']),
            partial: pick(r, ['partial', 'parcial', 'parciais']),
          });
        }
        continue;
      }
      if (!t.keys.some((k) => ROUTE_KEYS.includes(k))) continue;
      const base = statusFromText(t.heading, 'todo');
      for (const r of t.rows) {
        const route = pick(r, ROUTE_KEYS).replace(/[`*]/g, '').trim();
        if (!route) continue;
        const screen = {
          route,
          component: pick(r, COMP_KEYS).replace(/[`*]/g, '').trim(),
          file: pick(r, FILE_KEYS).replace(/[`*]/g, '').trim(),
          auth: pick(r, AUTH_KEYS),
          status: rowStatus(r, base),
          notes: pick(r, NOTE_KEYS),
          sectionId: null,
        };
        const prev = byRoute.get(route);
        if (!prev || (STATUS_RANK[screen.status] || 0) >= (STATUS_RANK[prev.status] || 0)) byRoute.set(route, screen);
      }
    }

    const sections = mdSections(md);
    const screens = [...byRoute.values()];
    for (const s of screens) {
      const hit = sections.find(
        (sec) => sec.title.toLowerCase().includes(s.route.toLowerCase()) || (s.component && sec.title.toLowerCase().includes(s.component.toLowerCase())),
      );
      if (hit) s.sectionId = hit.id;
    }
    if (!screens.length) parseWarnings.push('No route table recognized — showing the original document.');

    const counts = { implemented: 0, partial: 0, todo: 0, total: screens.length };
    for (const s of screens) counts[s.status] = (counts[s.status] || 0) + 1;

    return {
      available: true,
      file: 'screens-routes.md',
      updatedAt: new Date(st.mtimeMs).toISOString(),
      summary,
      screens,
      counts,
      sections,
      fallbackMarkdown: screens.length ? null : md,
      parseWarnings,
    };
  });
  return parsed || empty;
}

// ── Tasks (todos/issues/*.md × todos/task-master.md) ─────────────────────────

const META_ALIASES = {
  status: ['status'],
  blockedBy: ['blockedby', 'bloqueadopor', 'bloqueadapor', 'dependede', 'depende'],
  priority: ['priority', 'prioridade'],
  complexity: ['complexity', 'complexidade'],
  milestone: ['milestone', 'marco', 'entrega'],
};

/** Accepts "**Status:** x", "**Status**: x", "- **Status:** x" and "Status: x". */
export function parseMetaLines(md) {
  const found = {};
  const re = /^[-*\s]*(?:\*\*)?\s*([A-Za-zÀ-ÿ ]+?)\s*(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.+?)\s*(?:\*\*)?\s*$/gm;
  let m;
  while ((m = re.exec(md))) {
    const key = normKey(m[1]);
    for (const [field, aliases] of Object.entries(META_ALIASES)) {
      if (aliases.includes(key) && found[field] == null) found[field] = m[2].trim();
    }
  }
  return found;
}

export function normStatus(s) {
  const t = String(s || '').replace(/[`*]/g, '').trim();
  if (/done|conclu|finaliz/i.test(t)) return 'done';
  if (/in.?progress|em.?andamento|fazendo/i.test(t)) return 'in-progress';
  if (/blocked|bloquead/i.test(t)) return 'blocked';
  if (/defer|adiad|later/i.test(t)) return 'deferred';
  return 'pending';
}

/** "None"/"—"/"-"/"Nenhum" → []; "01, 03" (or markdown links) → ['01','03']. */
export function parseBlockers(s) {
  const t = String(s || '').trim();
  if (!t || /^(none|nenhum(a)?|-|—|–|n\/a)$/i.test(t)) return [];
  return [...new Set([...t.matchAll(/\d{1,3}/g)].map((m) => m[0].padStart(2, '0')))];
}

const SECTION_ALIASES = {
  delivers: ['whatitdelivers', 'oqueentrega', 'oqueelaentrega'],
  scope: ['scope', 'escopo'],
  seams: ['seamstotest', 'costurasparatestar', 'costuras'],
  criteria: ['acceptancecriteria', 'criteriosdeaceite', 'criteriodeaceite'],
};

function parseIssueFile(md) {
  const title = (/^#\s+(.*)$/m.exec(md)?.[1] || '')
    .replace(/^(task|tarefa|issue)\s*\d+\s*[—–:-]\s*/i, '')
    .trim();
  const meta = parseMetaLines(md);
  const sections = {};
  for (const sec of mdSections(md)) {
    const key = normKey(sec.title);
    for (const [field, aliases] of Object.entries(SECTION_ALIASES)) {
      if (aliases.some((a) => key.startsWith(a)) && sections[field] == null) sections[field] = sec.markdown.trim();
    }
  }
  const criteriaSrc = sections.criteria != null ? sections.criteria : md;
  const criteria = [...criteriaSrc.matchAll(/^\s*[-*]\s*\[([ xX])\]\s*(.+)$/gm)].map((m) => ({
    text: m[2].trim(),
    done: m[1] !== ' ',
  }));
  return { title, meta, sections, criteria, markdown: md };
}

export function readPlanTasks(aiDocsDir) {
  const issuesDir = join(aiDocsDir, 'todos', 'issues');
  const indexPath = join(aiDocsDir, 'todos', 'task-master.md');
  const empty = {
    available: false,
    indexFile: 'todos/task-master.md',
    issuesDir: 'todos/issues',
    updatedAt: null,
    tasks: [],
    counts: { total: 0, done: 0, inProgress: 0, pending: 0, blocked: 0, deferred: 0 },
    frontier: [],
    next: null,
    graph: [],
    inventory: null,
    parseWarnings: [],
  };

  let names = [];
  try {
    names = readdirSync(issuesDir).filter((n) => ISSUE_FILE.test(n));
  } catch {
    names = [];
  }
  names.sort((a, b) => Number(ISSUE_FILE.exec(a)[1]) - Number(ISSUE_FILE.exec(b)[1]));
  if (names.length > MAX_ISSUES) names = names.slice(0, MAX_ISSUES);

  const byNum = new Map();
  let updatedAt = null;
  for (const name of names) {
    const [, rawNum, slug] = ISSUE_FILE.exec(name);
    const num = rawNum.padStart(2, '0');
    const parsed = cached(join(issuesDir, name), (md, st) => ({ ...parseIssueFile(md), mtime: new Date(st.mtimeMs).toISOString() }));
    if (!parsed) continue;
    if (!updatedAt || parsed.mtime > updatedAt) updatedAt = parsed.mtime;
    byNum.set(num, {
      num,
      slug,
      file: `todos/issues/${name}`,
      title: parsed.title || slug.replace(/-/g, ' '),
      status: normStatus(parsed.meta.status),
      indexStatus: null,
      statusMismatch: false,
      blockedBy: parseBlockers(parsed.meta.blockedBy),
      blocks: [],
      priority: clean(parsed.meta.priority),
      complexity: clean(parsed.meta.complexity),
      milestone: clean(parsed.meta.milestone),
      delivers: parsed.sections.delivers || null,
      scope: parsed.sections.scope || null,
      seams: parsed.sections.seams || null,
      criteria: parsed.criteria,
      hasIssue: true,
      markdown: parsed.markdown,
    });
  }

  const parseWarnings = [];
  const index = cached(indexPath, (md, st) => {
    const tables = parseMdTables(md);
    const table = tables.find((t) => t.keys.includes('status') && (t.keys.includes('task') || t.keys.includes('tarefa')));
    const invSection = mdSections(md).find((s) => /implementation inventory|inventario/i.test(s.title));
    return { table, inventory: invSection ? invSection.markdown.trim() : null, mtime: new Date(st.mtimeMs).toISOString() };
  });
  if (index) {
    if (!updatedAt || index.mtime > updatedAt) updatedAt = index.mtime;
    for (const row of index.table ? index.table.rows : []) {
      const first = (row._cells || [])[0] || '';
      const taskCell = pick(row, ['task', 'tarefa']);
      const num = (/\d{1,3}/.exec(first) || /\d{1,3}/.exec(taskCell) || [])[0];
      if (!num) continue;
      const key = num.padStart(2, '0');
      const title = (/\[([^\]]+)\]/.exec(taskCell) || [])[1] || taskCell.replace(/[`*]/g, '').trim();
      const indexStatus = pick(row, ['status']);
      const existing = byNum.get(key);
      if (existing) {
        existing.indexStatus = indexStatus || null;
        existing.statusMismatch = Boolean(indexStatus) && normStatus(indexStatus) !== existing.status;
        if (!existing.priority) existing.priority = clean(pick(row, ['priority', 'prioridade']));
        if (!existing.complexity) existing.complexity = clean(pick(row, ['complexity', 'complexidade']));
        if (!existing.milestone) existing.milestone = clean(pick(row, ['milestone', 'marco']));
        if (!existing.blockedBy.length) existing.blockedBy = parseBlockers(pick(row, ['blockedby', 'bloqueadopor']));
      } else {
        byNum.set(key, {
          num: key,
          slug: null,
          file: null,
          title,
          status: normStatus(indexStatus),
          indexStatus: indexStatus || null,
          statusMismatch: false,
          blockedBy: parseBlockers(pick(row, ['blockedby', 'bloqueadopor'])),
          blocks: [],
          priority: clean(pick(row, ['priority', 'prioridade'])),
          complexity: clean(pick(row, ['complexity', 'complexidade'])),
          milestone: clean(pick(row, ['milestone', 'marco'])),
          delivers: null,
          scope: null,
          seams: null,
          criteria: [],
          hasIssue: false,
          markdown: null,
        });
      }
    }
    if (!index.table) parseWarnings.push('Task table not recognized in task-master.md.');
  }

  if (!byNum.size) return { ...empty, available: Boolean(index) || names.length > 0, parseWarnings };

  const tasks = [...byNum.values()].sort((a, b) => Number(a.num) - Number(b.num));
  const statusOf = (num) => byNum.get(num)?.status;
  const graph = [];
  for (const t of tasks) {
    for (const b of t.blockedBy) {
      graph.push({ from: b, to: t.num });
      const blocker = byNum.get(b);
      if (blocker) blocker.blocks.push(t.num);
    }
  }
  // Frontier: pending tasks whose known blockers are all done (unknown → treated as done).
  const frontier = tasks
    .filter((t) => t.status === 'pending' && t.blockedBy.every((b) => statusOf(b) === undefined || statusOf(b) === 'done'))
    .map((t) => t.num);
  const counts = { total: tasks.length, done: 0, inProgress: 0, pending: 0, blocked: 0, deferred: 0 };
  for (const t of tasks) {
    if (t.status === 'done') counts.done++;
    else if (t.status === 'in-progress') counts.inProgress++;
    else if (t.status === 'blocked') counts.blocked++;
    else if (t.status === 'deferred') counts.deferred++;
    else counts.pending++;
  }

  return {
    available: true,
    indexFile: 'todos/task-master.md',
    issuesDir: 'todos/issues',
    updatedAt,
    tasks,
    counts,
    frontier,
    next: frontier[0] || null,
    graph,
    inventory: index ? index.inventory : null,
    parseWarnings,
  };
}

// ── Milestones, specs & inbox (milestones.md, specs/*.md, inbox.md) ──────────

const SPEC_FILE = /^(\d{1,4})-([A-Za-z0-9][A-Za-z0-9-]*)\.md$/;
const MILESTONE_HEAD = /^(?:milestone|m)\s*(\d{1,3})\b\s*[—–:.-]*\s*(.*)$/i;
const MAX_GATE_LOG = 12;

/** First "Name: value" line in a block; tolerant of **bold** and list dashes. */
function metaLine(md, names) {
  const re = new RegExp(`^[-*\\s]*(?:\\*\\*)?\\s*(?:${names})\\s*(?:\\*\\*)?\\s*:\\s*(?:\\*\\*)?\\s*(.+?)\\s*(?:\\*\\*)?\\s*$`, 'im');
  return (re.exec(md) || [])[1] || '';
}

/**
 * Milestones (ai-docs/milestones.md) — `## M1 — <name>` sections with Goal /
 * Done when / Tasks / Status lines. Status is DECLARED, never derived: a
 * milestone only flips when someone edits the file (resolved task refs are
 * progress, not completion). Placeholder-only sections are dropped.
 */
export function parseMilestones(md) {
  const out = [];
  for (const sec of mdSections(md)) {
    if (sec.level !== 2) continue;
    const h = MILESTONE_HEAD.exec(sec.title.trim());
    if (!h) continue;
    const body = sec.markdown;
    const statusRaw = clean(metaLine(body, 'status'));
    const doneWhen = [];
    const lines = body.split('\n');
    let i = lines.findIndex((l) => /^[-*\s]*(?:\*\*)?\s*(?:done when|pronto quando)\b/i.test(l));
    if (i !== -1) {
      for (i += 1; i < lines.length; i++) {
        const b = /^\s*[-*]\s+(?:\[[ xX]\]\s*)?(.+)$/.exec(lines[i]);
        if (b) {
          const item = clean(b[1]);
          if (item) doneWhen.push(item);
          continue;
        }
        if (!lines[i].trim()) continue;
        break;
      }
    }
    const m = {
      id: `M${h[1]}`,
      name: clean(h[2].replace(/[`*]/g, '')),
      goal: clean(metaLine(body, 'goal|objetivo')),
      doneWhen,
      // The template line "pending | in-progress | done" is not a declaration.
      status: statusRaw && statusRaw.includes('|') ? 'pending' : normStatus(statusRaw),
      statusRaw,
      // Trailing parenthetical stripped so "(filled 2026-08-12)" adds no refs;
      // clean() first, or the template's `Tasks: {{01, 02, 05}}` would read as
      // three real refs and keep the placeholder milestone alive.
      tasks: parseBlockers(clean(metaLine(body, 'tasks|tarefas').replace(/\([^)]*\)\s*$/, '')) || ''),
    };
    if (!m.name && !m.goal && !m.doneWhen.length && !m.tasks.length) continue; // pure template ghost
    out.push(m);
  }
  return out;
}

/**
 * Milestones resolved against the task index: each task ref gains the status
 * from readPlanTasks (unknown ref → known:false, never counted as done).
 * Resolution happens per call — only the markdown parse is cached — so task
 * status changes show up without touching milestones.md.
 */
export function readPlanMilestones(aiDocsDir, tasks = []) {
  const empty = { available: false, file: 'milestones.md', updatedAt: null, milestones: [], parseWarnings: [] };
  const parsed = cached(join(aiDocsDir, 'milestones.md'), (md, st) => ({
    milestones: parseMilestones(md),
    mtime: new Date(st.mtimeMs).toISOString(),
  }));
  if (!parsed) return empty;
  const byNum = new Map((Array.isArray(tasks) ? tasks : []).map((t) => [t.num, t]));
  const milestones = parsed.milestones.map((m) => {
    const refs = m.tasks.map((num) => {
      const t = byNum.get(num);
      return { num, known: Boolean(t), status: t ? t.status : null, title: t ? t.title : null };
    });
    const done = refs.filter((r) => r.status === 'done').length;
    return { ...m, tasks: refs, progress: { done, total: refs.length } };
  });
  const parseWarnings = milestones.length ? [] : ['No milestones recognized in milestones.md.'];
  return { available: true, file: 'milestones.md', updatedAt: parsed.mtime, milestones, parseWarnings };
}

/** draft | defined | in-progress | done. Draft first: the unfilled template
 *  line lists every option and must land on the least-finished one. */
export function normSpecStatus(s) {
  const t = String(s || '').replace(/[`*]/g, '').trim();
  if (/draft|rascunho/i.test(t)) return 'draft';
  if (/defined|definid/i.test(t)) return 'defined';
  if (/in.?progress|andamento/i.test(t)) return 'in-progress';
  if (/done|conclu/i.test(t)) return 'done';
  return 'draft';
}

/**
 * Does the spec carry a mermaid diagram? Only a fence OPENED at line start with
 * ```mermaid counts: a ```mermaid line inside an already-open ~~~ or ````
 * block is quoted content (specs do quote the rule), and an indented fence is
 * not at line start. Implemented locally on purpose — scripts/ imports only its
 * siblings — so this is the TWIN of `specHasDiagram` in
 * `fia-templates/modules/gates.mjs` (that one gates, this one only reports) and
 * the two must agree.
 * Caveat: `cached()` truncates a document at MAX_DOC_BYTES, so a diagram past
 * 512KB reads as absent here — detection only, never a refusal.
 */
function hasMermaidFence(md) {
  let fence = null;
  for (const line of String(md || '').split(/\r?\n/)) {
    const f = /^(\s*)(`{3,}|~{3,})\s*(.*)$/.exec(line);
    if (!f) continue;
    const ch = f[2][0];
    if (fence) {
      if (ch === fence) fence = null;
      continue;
    }
    fence = ch;
    if (!f[1] && ch === '`' && /^mermaid\b/i.test(f[3].trim())) return true;
  }
  return false;
}

/**
 * One spec file (ai-docs/specs/NNNN-slug.md): id + title from the
 * `# Spec 0003 — <Title>` H1, header Status/Created/Updated/Tasks lines and
 * the append-only `## Gate log` lines. Anything absent → null/[], never throws.
 */
export function parseSpec(md) {
  const h1 = (/^#\s+(.*)$/m.exec(md) || [])[1] || '';
  const m = /^spec\s*#?\s*(\d{1,4})\s*[—–:.-]*\s*(.*)$/i.exec(h1.trim());
  const id = m ? m[1].padStart(4, '0') : null;
  const statusRaw = clean(metaLine(md, 'status'));
  const gateLog = [];
  for (const sec of mdSections(md)) {
    if (!/gate\s*log/i.test(sec.title)) continue;
    for (const line of sec.markdown.split('\n')) {
      const t = clean(line.replace(/^\s*[-*]\s*/, ''));
      if (t) gateLog.push(t);
      if (gateLog.length >= MAX_GATE_LOG) break;
    }
    break;
  }
  return {
    id,
    title: clean((m ? m[2] : h1).replace(/[`*]/g, '')),
    status: normSpecStatus(statusRaw),
    statusRaw,
    created: (/created\s*:\s*(\d{4}-\d{2}-\d{2})/i.exec(md) || [])[1] || null,
    updated: (/updated\s*:\s*(\d{4}-\d{2}-\d{2})/i.exec(md) || [])[1] || null,
    tasks: parseBlockers(clean(metaLine(md, 'tasks|tarefas').replace(/\([^)]*\)\s*$/, '')) || ''),
    gateLog,
    hasDiagram: hasMermaidFence(md),
  };
}

export function readPlanSpecs(aiDocsDir) {
  const specsDir = join(aiDocsDir, 'specs');
  const empty = {
    available: false,
    dir: 'specs',
    updatedAt: null,
    specs: [],
    counts: { total: 0, draft: 0, defined: 0, inProgress: 0, done: 0, withoutDiagram: 0 },
  };
  let names;
  try {
    // `0000-example.md` is the shipped reference example — it documents the
    // format and never counts as a live spec (the commands say the same).
    names = readdirSync(specsDir).filter((n) => SPEC_FILE.test(n) && !/^0{1,4}-/.test(n));
  } catch {
    return empty;
  }
  names.sort();
  if (names.length > MAX_ISSUES) names = names.slice(0, MAX_ISSUES);
  const specs = [];
  let updatedAt = null;
  for (const name of names) {
    const [, rawId, slug] = SPEC_FILE.exec(name);
    const parsed = cached(join(specsDir, name), (md, st) => ({ ...parseSpec(md), mtime: new Date(st.mtimeMs).toISOString() }));
    if (!parsed) continue;
    if (!updatedAt || parsed.mtime > updatedAt) updatedAt = parsed.mtime;
    specs.push({
      id: parsed.id || rawId.padStart(4, '0'),
      file: `specs/${name}`,
      title: parsed.title || slug.replace(/-/g, ' '),
      status: parsed.status,
      statusRaw: parsed.statusRaw,
      created: parsed.created,
      updated: parsed.updated,
      tasks: parsed.tasks,
      gateLog: parsed.gateLog,
      hasDiagram: Boolean(parsed.hasDiagram),
    });
  }
  const counts = { total: specs.length, draft: 0, defined: 0, inProgress: 0, done: 0, withoutDiagram: 0 };
  for (const s of specs) {
    if (s.status === 'done') counts.done++;
    else if (s.status === 'in-progress') counts.inProgress++;
    else if (s.status === 'defined') counts.defined++;
    else counts.draft++;
    if (!s.hasDiagram) counts.withoutDiagram++;
  }
  return { available: true, dir: 'specs', updatedAt, specs, counts };
}

/** `- [ ]` = open idea, `- [x]` = promoted. Pure count, order-free. */
export function countInbox(md) {
  const t = String(md || '');
  const open = (t.match(/^\s*[-*]\s*\[ \]/gm) || []).length;
  const done = (t.match(/^\s*[-*]\s*\[[xX]\]/gm) || []).length;
  return { open, done, total: open + done };
}

export function readPlanInbox(aiDocsDir) {
  const empty = { available: false, file: 'inbox.md', open: 0, done: 0, total: 0, updatedAt: null };
  const parsed = cached(join(aiDocsDir, 'inbox.md'), (md, st) => ({
    available: true,
    file: 'inbox.md',
    ...countInbox(md),
    updatedAt: new Date(st.mtimeMs).toISOString(),
  }));
  return parsed || empty;
}

// ── Examples library (examples/registry.md) ──────────────────────────────────

/**
 * The rows of a `<!-- registry:start -->` / `<!-- registry:end -->` registry:
 * the block between the markers (the whole document when they are absent),
 * minus HTML comments and fenced code. Shared by the examples registry and the
 * component registry — both templates ship their sample rows inside ```…```
 * fences, and both get commented-out rows from time to time. Only TERMINATED
 * comments are stripped: a stray `<!--` must not swallow the real rows until
 * the end of the file.
 */
function registryBlock(text) {
  const s = String(text || '');
  const start = s.indexOf('<!-- registry:start -->');
  const end = s.indexOf('<!-- registry:end -->');
  const block = start !== -1 && end !== -1 ? s.slice(start, end) : s;
  return block.replace(/<!--[\s\S]*?-->/g, '').replace(/```[\s\S]*?```/g, '');
}

/** `0000-example-entry` is the shipped reference entry — same device (and same
 *  guard) as `ai-docs/specs/0000-example.md`: it documents the format and never
 *  counts as a real example. */
const REFERENCE_SLUG = /^0{1,4}-/;
const EXAMPLE_SLUG = /^[a-z0-9][a-z0-9._-]*$/i;

function slugify(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** `[Cal.com](cal-com/NOTES.md)` → `cal-com`; anything odd → null. */
function slugFromDocLink(target) {
  const parts = String(target || '')
    .split(/[#?]/)[0]
    .split('/')
    .filter((p) => p && p !== '.' && p !== 'ai-docs' && p !== 'examples' && !/\.\w+$/.test(p));
  const dir = parts.pop();
  return dir && EXAMPLE_SLUG.test(dir) ? dir.toLowerCase() : null;
}

/** Cell that holds a URL: unwraps a markdown link, drops `—`/`n/a` fillers. */
function cellUrl(v) {
  const t = clean(v);
  if (!t) return null;
  const link = /\[[^\]]*\]\(([^)]+)\)/.exec(t);
  const raw = (link ? link[1] : t).replace(/[`*<>]/g, '').trim();
  if (!raw || /^[-—–]+$/.test(raw) || /^n\/?a$/i.test(raw)) return null;
  return raw;
}

/**
 * License risk for the copy guardrail: examples teach shape, not source to
 * paste. GPL-family and unstated licenses are `restricted` — read and
 * reimplement, never copy verbatim. `n/a` (docs and design references, where
 * there is no code to copy) is `none`; every other SPDX id is `permissive`.
 */
export function licenseRisk(v) {
  const t = (clean(v) || '').replace(/[`*]/g, '').trim();
  if (!t || /^[-—–]+$/.test(t)) return 'restricted';
  if (/^n\/?a$/i.test(t)) return 'none';
  if (/gpl|unknown|unclear|proprietary|\?/i.test(t)) return 'restricted';
  return 'permissive';
}

/** referenced (link only) · excerpted (NOTES.md quotes code) · archived.
 *  Referenced is the fallback: the least-committing state of the three. */
export function normExampleStatus(s) {
  const t = String(s || '').replace(/[`*]/g, '').trim();
  if (/excerpt|trecho/i.test(t)) return 'excerpted';
  if (/archiv|arquivad/i.test(t)) return 'archived';
  return 'referenced';
}

/**
 * Examples library (ai-docs/examples/registry.md) — the shelf of external
 * references agents consult BEFORE inventing a shape. Same marker discipline as
 * the component registry; one row is
 * `| Example | Kind | Tags | Source | What to take | License | Status |`.
 * Kind vocabulary is `repo|code|docs|design`, but an off-vocabulary word passes
 * through untouched (the UI shows what the file says). Tolerant: header,
 * separator, fenced and commented rows are skipped, rows that are still pure
 * `{{placeholder}}` are dropped, and a duplicated slug keeps the first row.
 */
export function parseExamples(md) {
  const out = [];
  const seen = new Set();
  for (const line of registryBlock(md).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) continue;
    // Table header/separator rows are not entries (includes `:---:` alignment).
    if (/^:?-+:?$/.test(cells[0]) || /^(example|exemplo)$/i.test(cells[0])) continue;
    const link = /\[([^\]]*)\]\(([^)]+)\)/.exec(cells[0]);
    const name = clean((link ? link[1] : cells[0]).replace(/[`*]/g, ''));
    if (!name) continue;
    const slug = (link && slugFromDocLink(link[2])) || slugify(name);
    if (!slug || REFERENCE_SLUG.test(slug) || seen.has(slug)) continue;
    const tags = (clean(cells[2]) || '')
      .replace(/[`*]/g, '')
      .split(/[,;·]/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s && !/^[-—–]+$/.test(s));
    const e = {
      slug,
      name,
      kind: (clean(cells[1]) || '').replace(/[`*]/g, '').toLowerCase() || null,
      tags,
      source: cellUrl(cells[3]),
      take: clean((cells[4] || '').replace(/[`*]/g, '')),
      license: clean((cells[5] || '').replace(/[`*]/g, '')),
      licenseRisk: licenseRisk(cells[5]),
      status: normExampleStatus(cells[6]),
    };
    // A row with nothing but a name is a template ghost, not a reference.
    if (!e.kind && !e.tags.length && !e.source && !e.take) continue;
    seen.add(slug);
    out.push(e);
  }
  return out;
}

/**
 * The registry resolved against disk: each entry gains the `NOTES.md` path when
 * the detail page exists. The existsSync check happens per call — only the
 * markdown parse is cached — so an entry registered before its NOTES.md picks
 * the link up as soon as the file lands.
 */
export function readPlanExamples(aiDocsDir) {
  const empty = {
    available: false,
    file: 'examples/registry.md',
    dir: 'examples',
    updatedAt: null,
    examples: [],
    counts: { total: 0, referenced: 0, excerpted: 0, archived: 0, restricted: 0 },
  };
  const parsed = cached(join(aiDocsDir, 'examples', 'registry.md'), (md, st) => ({
    examples: parseExamples(md),
    mtime: new Date(st.mtimeMs).toISOString(),
  }));
  if (!parsed) return empty;
  const examples = parsed.examples.map((e) => {
    const rel = `examples/${e.slug}/NOTES.md`;
    return { ...e, file: existsSync(join(aiDocsDir, rel)) ? rel : null };
  });
  const counts = { total: examples.length, referenced: 0, excerpted: 0, archived: 0, restricted: 0 };
  for (const e of examples) {
    counts[e.status] = (counts[e.status] || 0) + 1;
    if (e.licenseRisk === 'restricted') counts.restricted++;
  }
  return { available: true, file: 'examples/registry.md', dir: 'examples', updatedAt: parsed.mtime, examples, counts };
}

// ── Design system (map.yaml + disk) ──────────────────────────────────────────

export function readMap(aiDocsDir) {
  const parsed = cached(join(aiDocsDir, 'map.yaml'), (text) => {
    try {
      return { data: parseYaml(text) || {}, error: null };
    } catch (e1) {
      // Second chance for a half-filled map.yaml ({{X}} placeholders, etc.)
      try {
        return { data: parseDocument(text, { logLevel: 'silent' }).toJS() || {}, error: null };
      } catch {
        return { data: {}, error: String(e1?.message || e1) };
      }
    }
  });
  return parsed || { data: {}, error: null };
}

const CATEGORY_LABELS = {
  buttons: 'Buttons',
  forms: 'Forms',
  inputs: 'Inputs',
  masked_inputs: 'Masked inputs',
  selects: 'Selects',
  checkboxes_radios: 'Checkbox / Radio',
  switches: 'Switches',
  data_display: 'Data display',
  tables: 'Tables',
  cards: 'Cards',
  feedback: 'Feedback',
  toasts: 'Toasts',
  alerts: 'Alerts',
  modals: 'Modals',
  navigation: 'Navigation',
  layout: 'Layout',
};
const catLabel = (k) => CATEGORY_LABELS[k] || k.replace(/_/g, ' ');

function cleanComponents(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const comp = {
      name: clean(item.name),
      path: clean(item.path),
      library: clean(item.library),
      status: clean(item.status),
      variants: cleanList(item.variants),
      sizes: cleanList(item.sizes),
      features: cleanList(item.features),
      mask: clean(item.mask),
      validation: clean(item.validation),
    };
    // Items that are still 100% template placeholders would show up as ghosts.
    if (comp.name || comp.path) out.push(comp);
  }
  return out;
}

/**
 * Component registry (ai-docs/components/registry.md) — the design system's
 * source of truth. Tolerant parse of the markdown table between the
 * `<!-- registry:start -->` / `<!-- registry:end -->` markers.
 * Current format: 9 columns (…| Status | Role | When to use); legacy 8-column
 * rows (without Role) remain valid.
 * @returns {{exists: boolean, entries: Array<{name:string,category:string,origin:string,file:string,install:string,url:string,status:string,papel:string,when:string}>}}
 */
export function readComponentRegistry(aiDocsDir) {
  const path = join(aiDocsDir, 'components', 'registry.md');
  if (!existsSync(path)) return { exists: false, entries: [] };
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { exists: true, entries: [] };
  }
  const entries = [];
  for (const line of registryBlock(text).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.split('|').slice(1, -1).map((c) => c.replace(/[`*]/g, '').trim());
    if (cells.length < 3) continue;
    // Table header/separator rows are not entries (includes `:---:` alignment).
    if (/^:?-+:?$/.test(cells[0]) || /^(componente|component)$/i.test(cells[0])) continue;
    const [name, category, origin, file, install, url, status] = cells;
    if (!name) continue;
    // 9 columns = current format (with Role); 8 = legacy format (without Role).
    const papel = cells.length >= 9 ? cells[7] : '';
    const when = cells.length >= 9 ? cells[8] : cells[7];
    entries.push({
      name,
      category: category || '',
      origin: origin || '',
      file: file === '—' ? '' : file || '',
      install: install === '—' ? '' : install || '',
      url: url === '—' ? '' : url || '',
      status: status || '',
      papel: papel === '—' ? '' : papel || '',
      when: when || '',
    });
  }
  return { exists: true, entries };
}

const UI_PAGE_CANDIDATES = [
  'app/ui-components/page.tsx',
  'app/ui-components/page.jsx',
  'src/app/ui-components/page.tsx',
  'app/(app)/ui-components/page.tsx',
  'app/(dashboard)/ui-components/page.tsx',
  'pages/ui-components.tsx',
];

export function readPlanDesign(aiDocsDir, projectRoot = process.cwd()) {
  const { data: map } = readMap(aiDocsDir);
  const rc = map?.reusable_components || {};
  const ds = rc.design_system || {};

  const categories = [];
  for (const [key, value] of Object.entries(rc)) {
    if (key === 'design_system' || key === 'documentation') continue;
    if (Array.isArray(value)) {
      const items = cleanComponents(value);
      if (items.length) categories.push({ key, label: catLabel(key), items });
    } else if (value && typeof value === 'object') {
      for (const [subKey, subValue] of Object.entries(value)) {
        const items = cleanComponents(subValue);
        if (items.length) categories.push({ key: `${key}.${subKey}`, label: `${catLabel(key)} · ${catLabel(subKey)}`, items });
      }
    }
  }

  const libraries = [];
  for (const [key, value] of Object.entries(map?.stack?.components || {})) {
    if (!clean(key) || !value || typeof value !== 'object') continue;
    libraries.push({
      key,
      library: clean(value.library),
      status: clean(value.status),
      skill: clean(value.skill),
      description: clean(value.description),
    });
  }

  const routePath = clean(map?.workflow_progress?.steps?.step_6_ui_component_page?.result?.route_path) || '/ui-components';
  const uiPageFile = UI_PAGE_CANDIDATES.find((p) => existsSync(join(projectRoot, p))) || null;

  const docs = { idealComponents: fileInfo(join(aiDocsDir, 'components', 'ideal-components.md'), 'components/ideal-components.md', 'Ideal components'), libraries: [] };
  try {
    for (const entry of readdirSync(join(aiDocsDir, 'components'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      let count = 0;
      try {
        count = readdirSync(join(aiDocsDir, 'components', entry.name)).filter((f) => f.endsWith('.md')).length;
      } catch {
        count = 0;
      }
      docs.libraries.push({ name: entry.name, files: count });
    }
  } catch {
    /* no components dir yet */
  }

  return {
    designSystem: { library: clean(ds.primary_library), themeConfig: clean(ds.theme_config), globalStyles: clean(ds.global_styles) },
    categories,
    libraries,
    registry: readComponentRegistry(aiDocsDir),
    uiPage: { route: routePath, exists: Boolean(uiPageFile), file: uiPageFile },
    docs,
    counts: { total: categories.reduce((n, c) => n + c.items.length, 0), categories: categories.length },
  };
}

// ── Workflow progress ("what has already run") ───────────────────────────────

function normWfStatus(s) {
  const t = clean(s);
  if (!t) return 'not_started';
  if (/completed|conclu/i.test(t)) return 'completed';
  if (/in.?progress|andamento/i.test(t)) return 'in_progress';
  if (/skip/i.test(t)) return 'skipped';
  if (/fail|falh/i.test(t)) return 'failed';
  return 'not_started';
}

/** Does this /start step have its artifact on disk? YAML is often left stale. */
function workflowStepEvidence(key, aiDocsDir, uiPageExists) {
  if (!aiDocsDir) return false;
  const k = String(key || '');
  const has = (...rels) => rels.some((rel) => existsSync(join(aiDocsDir, rel)));
  if (/prd/i.test(k)) return has('PRD.md', 'PRD-as-built.md');
  if (/screens/i.test(k)) return has('screens-routes.md');
  if (/task_master|task-master/i.test(k)) return has('todos/task-master.md');
  if (/mapper|start_mapper/i.test(k)) return has('map.yaml');
  if (/component_architect|component-architect/i.test(k)) {
    return has('components/registry.md', 'components/ideal-components.md');
  }
  if (/ui_component|ui-component/i.test(k)) return Boolean(uiPageExists);
  return false;
}

/**
 * Trust the YAML when it already recorded a real outcome. Promote only
 * `not_started` (or a blank) when the artifact is sitting on disk — that is
 * the /map path, which writes the files and often never stamps workflow_progress.
 */
function reconcileWfStatus(declared, hasEvidence) {
  if (declared === 'skipped' || declared === 'failed' || declared === 'completed' || declared === 'in_progress') {
    return declared;
  }
  return hasEvidence ? 'completed' : declared;
}

function detailLines(result) {
  const out = [];
  if (!result || typeof result !== 'object') return out;
  for (const [k, v] of Object.entries(result)) {
    if (Array.isArray(v)) {
      if (v.length) out.push(`${k}: ${v.length}`);
      continue;
    }
    if (v === true) {
      out.push(k);
      continue;
    }
    if (v === false || v == null) continue;
    const s = clean(v);
    if (s && s !== '0') out.push(`${k}: ${s}`);
  }
  return out;
}

export function readPlanWorkflow(map, aiDocsDir = null, { uiPageExists = false } = {}) {
  const wp = map?.workflow_progress || {};
  const steps = Object.entries(wp.steps || {})
    .map(([key, v]) => {
      const declared = normWfStatus(v?.status);
      const hasEvidence = workflowStepEvidence(key, aiDocsDir, uiPageExists);
      return {
        key,
        order: Number((/^step_(\d+)/.exec(key) || [])[1] || 99),
        name: clean(v?.name) || key.replace(/^step_\d+_/, '').replace(/_/g, ' '),
        status: reconcileWfStatus(declared, hasEvidence),
        declared,
        evidenced: hasEvidence,
        completedAt: clean(v?.completed_at),
        details: detailLines(v?.result),
      };
    })
    .sort((a, b) => a.order - b.order);
  const done = steps.filter((s) => s.status === 'completed' || s.status === 'skipped').length;
  let status = normWfStatus(wp.workflow_status);
  if (steps.length && done === steps.length) status = 'completed';
  else if (steps.some((s) => s.status === 'in_progress')) status = 'in_progress';
  else if (steps.some((s) => s.status === 'completed') && status === 'not_started') status = 'in_progress';
  return {
    status,
    startedAt: clean(wp.started_at),
    lastUpdated: clean(wp.last_updated),
    steps,
  };
}

// ── Overview + document index/reader ─────────────────────────────────────────

export function listPlanDocs(aiDocsDir) {
  const out = [];
  const add = (rel, label) => {
    const info = fileInfo(join(aiDocsDir, rel), rel, label);
    if (info.exists) out.push(info);
  };
  if (existsSync(join(aiDocsDir, 'PRD.md'))) add('PRD.md', 'PRD — what the app is');
  else add('prd.md', 'PRD — what the app is');
  add('map.yaml', 'Project map');
  add('screens-routes.md', 'Screens and routes');
  add('milestones.md', 'Milestones');
  add('inbox.md', 'Idea inbox');
  add('todos/task-master.md', 'Task index');
  add('components/ideal-components.md', 'Ideal components');
  add('examples/registry.md', 'Example library');
  const addDir = (relDir, labelFor) => {
    try {
      const names = readdirSync(join(aiDocsDir, relDir)).filter((n) => n.endsWith('.md'));
      names.sort();
      for (const n of names.slice(0, MAX_ISSUES)) add(`${relDir}/${n}`, labelFor(n));
    } catch {
      /* dir absent */
    }
  };
  // examples/<slug>/*.md — one folder per registry entry, NOTES.md being the
  // detail page (assets/ holds images, which this index does not serve). The
  // 0000 reference entry is listed here — it documents the format — exactly
  // like specs/0000-example.md.
  try {
    const slugs = readdirSync(join(aiDocsDir, 'examples'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    for (const slug of slugs.slice(0, MAX_ISSUES)) {
      const label = `Example — ${slug.replace(/-/g, ' ')}`;
      addDir(`examples/${slug}`, (n) => (/^notes\.md$/i.test(n) ? label : `${label} · ${n.replace(/\.md$/, '')}`));
    }
  } catch {
    /* no examples dir yet */
  }
  addDir('specs', (n) => {
    const m = SPEC_FILE.exec(n);
    return m ? `Spec ${m[1].padStart(4, '0')} — ${m[2].replace(/-/g, ' ')}` : n;
  });
  addDir('todos/issues', (n) => {
    const m = ISSUE_FILE.exec(n);
    return m ? `Task ${m[1].padStart(2, '0')} — ${m[2].replace(/-/g, ' ')}` : n;
  });
  addDir('actual-todo', (n) => `Active task — ${n.replace(/\.md$/, '')}`);
  addDir('apis', (n) => `API — ${n.replace(/\.md$/, '')}`);
  return out;
}

export function readPlanOverview(aiDocsDir, projectRoot = process.cwd()) {
  const available = existsSync(aiDocsDir);
  const { data: map, error: mapError } = readMap(aiDocsDir);
  const screens = readPlanScreens(aiDocsDir);
  const tasks = readPlanTasks(aiDocsDir);
  const design = readPlanDesign(aiDocsDir, projectRoot);
  const milestones = readPlanMilestones(aiDocsDir, tasks.tasks);
  const specs = readPlanSpecs(aiDocsDir);
  const inbox = readPlanInbox(aiDocsDir);
  const examples = readPlanExamples(aiDocsDir);
  const p = map?.project || {};
  const st = map?.stack || {};
  const nextTask = tasks.next ? tasks.tasks.find((t) => t.num === tasks.next) : null;
  return {
    available,
    dir: aiDocsDir,
    mapError,
    project: {
      name: clean(p.name),
      description: clean(p.description),
      version: clean(p.version),
      status: clean(p.status),
      audience: cleanList(p.audience),
    },
    stack: {
      framework: clean(st.frontend?.framework?.name),
      frameworkVersion: clean(st.frontend?.framework?.version),
      styling: clean(st.frontend?.styling?.name),
      uiLibrary: clean(st.frontend?.ui_library?.name),
      icons: clean(st.frontend?.icons?.name),
      state: clean(st.frontend?.state_management),
      database: clean(st.backend?.database?.name),
      auth: clean(st.backend?.authentication?.name),
      hosting: clean(st.backend?.hosting?.name),
    },
    workflow: readPlanWorkflow(map, aiDocsDir, { uiPageExists: Boolean(design.uiPage?.exists) }),
    milestones,
    specs,
    inbox,
    examples,
    counts: {
      screens: screens.counts,
      tasks: tasks.counts,
      components: design.counts,
      specs: specs.counts.total,
      examples: examples.counts.total,
      inboxOpen: inbox.open,
      docs: listPlanDocs(aiDocsDir).length,
    },
    next: nextTask
      ? { num: nextTask.num, title: nextTask.title, priority: nextTask.priority, complexity: nextTask.complexity, milestone: nextTask.milestone }
      : null,
    frontier: tasks.frontier,
    files: listPlanDocs(aiDocsDir),
  };
}

export function isSafeDocPath(p) {
  return typeof p === 'string' && p.length < 300 && SAFE_DOC_PATH.test(p) && !p.split('/').includes('..');
}

/** Raw read of ONE document under ai-docs/ (the UI renders it). */
export function readPlanDoc(aiDocsDir, relPath) {
  if (!isSafeDocPath(relPath)) return null;
  const base = resolve(aiDocsDir);
  const abs = resolve(base, relPath);
  if (abs !== base && !abs.startsWith(base + sep)) return null;
  if (!existsSync(abs)) return { path: relPath, exists: false, kind: kindOf(relPath), text: '', truncated: false, bytes: 0, updatedAt: null };
  const raw = readFileSync(abs, 'utf8');
  const st = statSync(abs);
  return {
    path: relPath,
    exists: true,
    kind: kindOf(relPath),
    text: raw.slice(0, MAX_DOC_BYTES),
    truncated: raw.length > MAX_DOC_BYTES,
    bytes: raw.length,
    updatedAt: new Date(st.mtimeMs).toISOString(),
  };
}
