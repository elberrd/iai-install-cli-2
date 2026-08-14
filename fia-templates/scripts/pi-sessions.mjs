/**
 * Pi session reader — parses ~/.pi/agent/sessions/<project-slug>/*.jsonl into
 * viewer-friendly summaries and event timelines (interactive sessions and the
 * subagent runs spawned from them). Read-only; parses are cached by mtime+size
 * so live polling stays cheap.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SAFE_SESSION_ID = /^[a-zA-Z0-9._-]+$/;
const SAFE_RUN_PATH = /^[a-zA-Z0-9_-]+\/run-\d+$/;
const SUBAGENT_NAME = /^subagent-(.+?)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-\d+)?$/;
const RUNNING_WINDOW_MS = 20_000;
// A quiet session is not finished — the engineer may just be reading or
// thinking. Only several minutes of silence (or an explicit end marker in the
// log) flips it to 'finished'; in between it is 'idle'.
const FINISHED_WINDOW_MS = 5 * 60_000;
const MAX_EVENTS = 800;
const MAX_SESSIONS = 60;

const cache = new Map(); // path → { mtimeMs, size, parsed }

/** Pi stores sessions per project under a slug of the cwd. */
export function piSessionsDirFor(cwd = process.cwd(), home = homedir()) {
  const slug = `-${cwd.replaceAll('/', '-')}--`;
  return join(home, '.pi', 'agent', 'sessions', slug);
}

export function isSafeSessionId(id) {
  return SAFE_SESSION_ID.test(id) && !id.includes('..');
}

export function isSafeRunPath(path) {
  return SAFE_RUN_PATH.test(path);
}

export function agentFromSessionName(name) {
  const m = SUBAGENT_NAME.exec(name || '');
  return m ? m[1] : null;
}

function truncate(s, n) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function firstText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  for (const block of content) if (block?.type === 'text') return block.text || '';
  return '';
}

/** One-line summary of a tool call's arguments (path, command, or first value). */
function argSummary(args) {
  let obj = args;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch { return truncate(obj, 90); }
  }
  if (!obj || typeof obj !== 'object') return '';
  for (const key of ['path', 'file', 'command', 'cmd', 'agent', 'pattern', 'url', 'query']) {
    if (obj[key] != null) return truncate(String(obj[key]), 90);
  }
  const first = Object.values(obj).find((v) => v != null);
  return first == null ? '' : truncate(typeof first === 'string' ? first : JSON.stringify(first), 90);
}

/**
 * Parse one pi session JSONL into { meta, events }. Events mirror the FDA
 * stream shape: { seq, type, name, payload, started_at, ended_at, ok }.
 */
export function parsePiSession(filePath) {
  const stat = statSync(filePath);
  const hit = cache.get(filePath);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.parsed;

  const meta = {
    name: '', cwd: '', startedAt: null, lastAt: null,
    provider: '', model: '', thinking: '',
    msgCount: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0,
    ended: false,
  };
  const events = [];
  const callIndex = new Map(); // toolCallId → index in events
  let seq = 0;
  const push = (ev) => { events.push({ seq: ++seq, ok: null, ended_at: null, ...ev }); };

  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const ts = e.timestamp || null;
    if (ts) { meta.lastAt = ts; if (!meta.startedAt) meta.startedAt = ts; }

    if (e.type === 'session') { meta.cwd = e.cwd || ''; continue; }
    if (e.type === 'session_info') { if (e.name) meta.name = e.name; continue; }
    if (e.type === 'session_end' || e.type === 'shutdown') { meta.ended = true; continue; }
    if (e.type === 'model_change') {
      meta.provider = e.provider || meta.provider;
      meta.model = e.modelId || meta.model;
      push({ type: 'log', name: `model → ${e.provider || ''}/${e.modelId || ''}`, started_at: ts });
      continue;
    }
    if (e.type === 'thinking_level_change') {
      meta.thinking = e.thinkingLevel || meta.thinking;
      push({ type: 'log', name: `thinking → ${e.thinkingLevel || ''}`, started_at: ts });
      continue;
    }
    if (e.type === 'custom_message') {
      push({ type: 'log', name: truncate(e.customType || 'custom', 90), payload: truncate(firstText(e.content), 400), started_at: ts });
      continue;
    }
    if (e.type !== 'message' || !e.message) continue;

    const m = e.message;
    if (m.role === 'user' || m.role === 'assistant') meta.msgCount += 1;
    if (m.role === 'user') {
      push({ type: 'user', name: truncate(firstText(m.content), 160), payload: truncate(firstText(m.content), 4000), started_at: ts });
      continue;
    }
    if (m.role === 'toolResult') {
      const idx = callIndex.get(m.toolCallId);
      if (idx != null) {
        events[idx].ended_at = m.timestamp || ts;
        events[idx].ok = !m.isError;
      }
      if (m.isError) {
        push({ type: 'error', name: truncate(`${m.toolName || 'tool'}: ${firstText(m.content)}`, 160), payload: truncate(firstText(m.content), 2000), started_at: ts });
      }
      continue;
    }
    if (m.role === 'assistant') {
      const usage = m.usage || {};
      meta.tokensIn += usage.input || 0;
      meta.tokensOut += usage.output || 0;
      for (const block of Array.isArray(m.content) ? m.content : []) {
        if (block?.type === 'text' && block.text?.trim()) {
          push({ type: 'assistant', name: truncate(block.text, 160), payload: truncate(block.text, 4000), started_at: ts });
        } else if (block?.type === 'toolCall') {
          meta.toolCalls += 1;
          const summary = argSummary(block.arguments);
          push({ type: 'tool_call', name: `${block.name}${summary ? `: ${summary}` : ''}`, payload: truncate(JSON.stringify(block.arguments), 2000), started_at: ts });
          if (block.id) callIndex.set(block.id, events.length - 1);
        }
      }
    }
  }

  const parsed = { meta, events: events.slice(-MAX_EVENTS) };
  cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, parsed });
  return parsed;
}

/** 'running' (writing now) · 'idle' (quiet, still open) · 'finished'. */
export function sessionState(filePath, meta) {
  let age;
  try { age = Date.now() - statSync(filePath).mtimeMs; } catch { return 'finished'; }
  if (age < RUNNING_WINDOW_MS) return 'running';
  if (meta?.ended || age >= FINISHED_WINDOW_MS) return 'finished';
  return 'idle';
}

/** Subagent runs of a session: <dir>/<sessionId>/<runId>/run-N/session.jsonl */
export function listSubruns(dir, sessionId) {
  const base = join(dir, sessionId);
  if (!existsSync(base)) return [];
  const runs = [];
  for (const runId of readdirSync(base, { withFileTypes: true })) {
    if (!runId.isDirectory()) continue;
    const runDir = join(base, runId.name);
    for (const attempt of readdirSync(runDir, { withFileTypes: true })) {
      if (!attempt.isDirectory() || !/^run-\d+$/.test(attempt.name)) continue;
      const file = join(runDir, attempt.name, 'session.jsonl');
      if (!existsSync(file)) continue;
      try {
        const { meta, events } = parsePiSession(file);
        const task = events.find((ev) => ev.type === 'user')?.name || '';
        const state = sessionState(file, meta);
        runs.push({
          path: `${runId.name}/${attempt.name}`,
          agent: agentFromSessionName(meta.name) || runId.name,
          name: meta.name,
          model: meta.model, provider: meta.provider, thinking: meta.thinking,
          startedAt: meta.startedAt, lastAt: meta.lastAt,
          msgCount: meta.msgCount, toolCalls: meta.toolCalls,
          tokensOut: meta.tokensOut,
          running: state === 'running',
          state,
          task,
        });
      } catch { /* unreadable run — skip */ }
    }
  }
  runs.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  return runs;
}

/** All interactive sessions of the project dir, newest first. */
export function listPiSessions(dir) {
  if (!existsSync(dir)) return [];
  // Stat first, parse later: sort by mtime and only parse the newest
  // MAX_SESSIONS files — old projects accumulate hundreds of session logs.
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const file = join(dir, entry.name);
    try {
      files.push({ file, id: entry.name.slice(0, -'.jsonl'.length), mtimeMs: statSync(file).mtimeMs });
    } catch { /* vanished mid-listing — skip */ }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const sessions = [];
  for (const { file, id } of files.slice(0, MAX_SESSIONS)) {
    try {
      const { meta, events } = parsePiSession(file);
      const firstUser = events.find((ev) => ev.type === 'user');
      const state = sessionState(file, meta);
      sessions.push({
        id,
        name: meta.name || truncate(firstUser?.name || id, 70),
        request: firstUser ? firstUser.name : '',
        startedAt: meta.startedAt, lastAt: meta.lastAt,
        provider: meta.provider, model: meta.model, thinking: meta.thinking,
        msgCount: meta.msgCount, toolCalls: meta.toolCalls,
        tokensIn: meta.tokensIn, tokensOut: meta.tokensOut,
        running: state === 'running',
        state,
        subagents: listSubruns(dir, id).length,
      });
    } catch { /* unreadable session — skip */ }
  }
  sessions.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return sessions;
}

/** Full detail of one session: meta + events + its subagent runs. */
export function readPiSession(dir, id) {
  const file = join(dir, `${id}.jsonl`);
  if (!isSafeSessionId(id) || !existsSync(file)) return null;
  const { meta, events } = parsePiSession(file);
  const state = sessionState(file, meta);
  return {
    id, meta, events,
    running: state === 'running',
    state,
    subruns: listSubruns(dir, id),
  };
}

/** Detail of one subagent run (`runPath` = "<runId>/run-N"). */
export function readPiRun(dir, id, runPath) {
  if (!isSafeSessionId(id) || !isSafeRunPath(runPath)) return null;
  const file = join(dir, id, runPath, 'session.jsonl');
  if (!existsSync(file)) return null;
  const { meta, events } = parsePiSession(file);
  const state = sessionState(file, meta);
  return { id, path: runPath, agent: agentFromSessionName(meta.name) || runPath.split('/')[0], meta, events, running: state === 'running', state };
}
