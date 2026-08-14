import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Quick-log (C6): the audit trail of /quick work. Small changes never touch
 * issues/task-master — this file is their only record, so the append must be
 * deterministic code, never an agent paraphrasing what it thinks it shipped.
 */

/** Seed header when the project has no quick-log yet (the harness ships one). */
const HEADER = `# Quick log

Audit trail of /quick changes — small work that never becomes tasks.
Format: \`## Q-NNN — <title> (YYYY-MM-DD)\` + \`Files: … · Verified: … · Commit: …\`.
`;

/** Next id: numbering continues from the highest existing entry, Q-001 first. */
export function nextQuickId(logText) {
  let max = 0;
  for (const m of String(logText || '').matchAll(/^## Q-(\d+)\b/gm)) {
    max = Math.max(max, Number(m[1]));
  }
  return `Q-${String(max + 1).padStart(3, '0')}`;
}

/** One C6 entry — pure string building, `—` for anything unknown. */
export function quickLogEntry({ id, title, date, files = [], verified = [], commit = '' }) {
  const fileList = files.length ? files.join(', ') : '—';
  const checks = verified.length ? verified.join('/') : '—';
  return `## ${id} — ${title} (${date})\nFiles: ${fileList} · Verified: ${checks} · Commit: ${commit || '—'}\n`;
}

/**
 * Append an entry (creating the file — and its folder — when the project has
 * none yet). Returns the id it assigned, so callers can report it.
 */
export function appendQuickLog(path, { title, date = new Date().toISOString().slice(0, 10), files, verified, commit } = {}) {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const id = nextQuickId(existing || '');
  const entry = quickLogEntry({ id, title, date, files, verified, commit });
  if (existing === null) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${HEADER}\n${entry}`);
  } else {
    const sep = existing.endsWith('\n') ? '\n' : '\n\n';
    writeFileSync(path, `${existing}${sep}${entry}`);
  }
  return id;
}

/**
 * Fill an entry's `Commit:` field once the sha exists (the entry is written
 * before the commit — it cannot name the commit that contains it). Returns
 * true when the file changed; a missing entry or an already-filled field is a
 * quiet no-op.
 */
export function setQuickLogCommit(path, id, sha) {
  if (!existsSync(path) || !id || !sha) return false;
  const text = readFileSync(path, 'utf8');
  // The body scan stops at the next `## ` heading — never fill a later entry.
  const entry = new RegExp(`(^## ${id} —[^\\n]*\\n(?:(?!^## )[^\\n]*\\n)*?[^\\n]*· Commit: )—`, 'm');
  if (!entry.test(text)) return false;
  writeFileSync(path, text.replace(entry, `$1${sha}`));
  return true;
}
