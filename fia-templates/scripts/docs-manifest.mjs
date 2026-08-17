/**
 * Canonical project documentation inventory — which ai-docs/ artifacts exist,
 * which command creates them, and what to run when one is missing.
 *
 * Read-only. Nothing here throws: a missing path is simply `exists: false`.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** @typedef {'file' | 'dir'} DocKind */

/**
 * @typedef {Object} DocEntry
 * @property {string} id
 * @property {string} label
 * @property {string} path project-relative path (file or directory)
 * @property {DocKind} kind
 * @property {string} command slash command that creates this (e.g. "/map")
 * @property {boolean} optional when false, listed as a core planning doc
 */

/** Core docs the IAI workflow expects after the usual command chain. */
export const DOC_MANIFEST = [
  { id: 'prd', label: 'Product requirements', path: 'ai-docs/PRD.md', kind: 'file', command: '/idea', optional: false },
  { id: 'stack', label: 'Stack manifest', path: 'ai-docs/stack.md', kind: 'file', command: '/stack', optional: false },
  { id: 'map', label: 'Project map', path: 'ai-docs/map.yaml', kind: 'file', command: '/map', optional: false },
  { id: 'screens', label: 'Screens & routes', path: 'ai-docs/screens-routes.md', kind: 'file', command: '/map', optional: false },
  { id: 'task-master', label: 'Task index', path: 'ai-docs/todos/task-master.md', kind: 'file', command: '/map', optional: false },
  { id: 'issues', label: 'Task issues', path: 'ai-docs/todos/issues', kind: 'dir', command: '/map', optional: false },
  { id: 'specs', label: 'Feature specs', path: 'ai-docs/specs', kind: 'dir', command: '/map', optional: false },
  { id: 'milestones', label: 'Milestones', path: 'ai-docs/milestones.md', kind: 'file', command: '/map', optional: false },
  { id: 'components-registry', label: 'Component registry', path: 'ai-docs/components/registry.md', kind: 'file', command: '/map', optional: true },
  { id: 'ideal-components', label: 'Ideal components brief', path: 'ai-docs/components/ideal-components.md', kind: 'file', command: '/map', optional: true },
  { id: 'apis', label: 'API research notes', path: 'ai-docs/apis', kind: 'dir', command: '/stack', optional: true },
  { id: 'research', label: 'Research ledger', path: 'ai-docs/research', kind: 'dir', command: '/stack', optional: true },
  { id: 'decisions', label: 'Decision logs', path: 'ai-docs/decisions', kind: 'dir', command: '/idea', optional: true },
  { id: 'inbox', label: 'Inbox', path: 'ai-docs/inbox.md', kind: 'file', command: '/note', optional: true },
  { id: 'launch', label: 'Launch checklist', path: 'ai-docs/launch.md', kind: 'file', command: '/launch', optional: true },
  { id: 'conventions', label: 'Conventions (brownfield)', path: 'ai-docs/conventions.md', kind: 'file', command: '/absorb', optional: true },
  { id: 'prd-as-built', label: 'PRD as-built (brownfield)', path: 'ai-docs/PRD-as-built.md', kind: 'file', command: '/absorb', optional: true },
  { id: 'wiki', label: 'Project wiki', path: 'ai-docs/wiki', kind: 'dir', command: '/absorb', optional: true },
  { id: 'examples', label: 'Examples registry', path: 'ai-docs/examples/registry.md', kind: 'file', command: '/example', optional: true },
  { id: 'ui-patterns', label: 'UI patterns', path: 'ai-docs/ui/patterns.md', kind: 'file', command: '/theme', optional: true },
  { id: 'kit-report', label: 'Design kit report', path: 'ai-docs/kit-report.md', kind: 'file', command: '/kit', optional: true },
  { id: 'quick-log', label: 'Quick triage log', path: 'ai-docs/todos/quick-log.md', kind: 'file', command: '/quick', optional: true },
];

function dirHasFiles(root, rel) {
  try {
    const entries = readdirSync(join(root, rel));
    return entries.some((n) => !n.startsWith('.'));
  } catch {
    return false;
  }
}

/**
 * @param {string} root project root
 * @returns {Array<DocEntry & { exists: boolean, mtime: string | null, size: number | null, file_count?: number }>}
 */
export function docsStatus(root) {
  return DOC_MANIFEST.map((entry) => {
    const abs = join(root, entry.path);
    if (entry.kind === 'dir') {
      const exists = dirHasFiles(root, entry.path);
      let mtime = null;
      let file_count = 0;
      if (exists) {
        try {
          for (const name of readdirSync(abs)) {
            if (name.startsWith('.')) continue;
            file_count += 1;
            const st = statSync(join(abs, name));
            const t = st.mtime.toISOString();
            if (!mtime || t > mtime) mtime = t;
          }
        } catch {
          /* unreadable dir */
        }
      }
      return { ...entry, exists, mtime, size: null, file_count };
    }
    if (!existsSync(abs)) return { ...entry, exists: false, mtime: null, size: null };
    try {
      const st = statSync(abs);
      return { ...entry, exists: true, mtime: st.mtime.toISOString(), size: st.size };
    } catch {
      return { ...entry, exists: false, mtime: null, size: null };
    }
  });
}

/** Missing core (non-optional) docs, in workflow order. */
export function missingCoreDocs(root) {
  return docsStatus(root).filter((d) => !d.optional && !d.exists);
}
