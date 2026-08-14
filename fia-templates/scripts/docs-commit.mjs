#!/usr/bin/env node
/**
 * Docs commit — deterministic, pathspec-limited commit for ai-docs/ artifacts.
 *
 * Interview and mapping commands (/idea, /stack, /map, /component, /design,
 * /theme, decision-log close…) produce durable documents under ai-docs/.
 * Left uncommitted, they turn the working tree into a contamination
 * reservoir: the next FDA's commit can sweep them into an unrelated change
 * (the registry.md / stack.md case). This script is the code side of the
 * ritual — the agent decides WHEN and with WHAT message; the script owns
 * scope and safety:
 *
 *   - paths default to the whole ai-docs/ directory;
 *   - every path MUST live inside ai-docs/ — anything else is refused (code
 *     is committed by FDAs, never by this script);
 *   - refuses to run while a FIA run is active (imp/data/.fda.lock holding a
 *     live pid): a mid-run commit would blur that run's own commit scope;
 *   - nothing changed → exits 0 with "nothing to commit" (safe to re-run).
 *
 * Usage:
 *   node imp/scripts/docs-commit.mjs --message "docs(stack): decide backend" [path…]
 *   node imp/scripts/docs-commit.mjs --message "…" [--json] [--dir <project root>]
 */
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { commitPaths } from '../modules/git-helper.mjs';
import { activeFdaLock } from './fda-lock.mjs';

export { activeFdaLock };

export const DOCS_DIR = 'ai-docs';

/**
 * Every path must resolve INSIDE <root>/ai-docs — checked on the resolved
 * path, so neither `../escape` nor an absolute path outside the tree can
 * smuggle code into a docs commit. Returns the offending paths.
 */
export function invalidDocsPaths(root, paths) {
  const docsRoot = resolve(root, DOCS_DIR);
  return (paths || []).filter((p) => {
    const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
    const rel = relative(docsRoot, abs);
    return rel !== '' && (rel.startsWith('..') || isAbsolute(rel));
  });
}

function flagValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv) {
  const json = argv.includes('--json');
  const root = resolve(flagValue(argv, '--dir') || '.');
  const message = flagValue(argv, '--message');
  const fail = (msg) => {
    console.error(msg);
    process.exit(1);
  };
  if (!message || message.startsWith('--')) {
    fail('usage: docs-commit --message "docs(<command>): <what was decided>" [path…]  (paths default to ai-docs/)');
  }
  const paths = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--message' && argv[i - 1] !== '--dir');
  const targets = paths.length ? paths : [DOCS_DIR];
  const outside = invalidDocsPaths(root, targets);
  if (outside.length) {
    fail(`docs-commit only commits ai-docs/ paths — refused:\n- ${outside.join('\n- ')}\nCode is committed by FDA runs, never by this script.`);
  }
  const lock = activeFdaLock(root);
  if (lock) {
    fail(
      `a FIA run is active (fda_id ${lock.fda_id || 'unknown'}, pid ${lock.pid}) — a docs commit now would blur that run's commit scope.\n` +
        'Wait for the run to finish and try again.',
    );
  }
  const { sha, committed } = commitPaths(message, targets, root);
  if (json) {
    console.log(JSON.stringify({ sha, committed }));
    return;
  }
  console.log(sha ? `${sha.slice(0, 7)}  ${message}  (${committed.length} path${committed.length === 1 ? '' : 's'})` : 'nothing to commit — ai-docs/ is clean');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main(process.argv.slice(2));
