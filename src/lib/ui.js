// Thin wrapper around @clack/prompts so the rest of the code stays terse and
// every prompt handles Ctrl-C/Esc (cancel) uniformly.
import { stripVTControlCharacters as stripAnsi } from 'node:util';
import * as p from '@clack/prompts';
import pc from 'picocolors';

export const color = pc;

export function intro(title) {
  p.intro(pc.bgCyan(pc.black(` ${title} `)));
}
export function outro(msg) {
  p.outro(msg);
}

// clack's note() sizes its box to the LONGEST line and pads every line to that
// width (with a trailing `│`) — it never looks at the terminal width. Anything
// wider than the terminal soft-wraps and shatters the frame (lonely `│`s,
// broken borders). So we wrap the content OURSELVES to the width the terminal
// has at print time; stdout.columns is live, so a note printed after a resize
// already adapts (text already printed is static scrollback — nothing can
// reflow it).
const NOTE_MAX_WIDTH = 96; // readability cap on ultra-wide terminals
const NOTE_OVERHEAD = 7; // '│  ' + padding + '│' + one safety column
const NOTE_MIN_WIDTH = 24; // below this, wrapping hurts more than it helps

/**
 * Word-wrap note content to fit the terminal. Continuation lines of
 * command-table rows (`  /idea       description…`) align under the
 * description column; other lines keep their own leading whitespace. Words
 * longer than the width (URLs) are hard-broken — an overflowing word would
 * re-shatter the box. Exported for tests.
 */
export function wrapNoteText(message, columns = process.stdout.columns) {
  const cols = Number.isInteger(columns) && columns > 0 ? columns : 80;
  const width = Math.max(NOTE_MIN_WIDTH, Math.min(cols - NOTE_OVERHEAD, NOTE_MAX_WIDTH));
  return String(message)
    .split('\n')
    .flatMap((line) => wrapLine(line, width))
    .join('\n');
}

function wrapLine(line, width) {
  if (stripAnsi(line).length <= width) return [line];
  // Command-table row (`  /idea       description…`): the head — token + its
  // column gap — stays VERBATIM on the first line, continuations align under
  // the description column.
  const table = line.match(/^(\s*\S+\s{2,})(\S.*)$/);
  if (table && stripAnsi(table[1]).length <= width - 16) {
    const indent = ' '.repeat(stripAnsi(table[1]).length);
    return wrapWords(table[2].trimEnd(), width - indent.length).map((c, i) =>
      i === 0 ? table[1] + c : indent + c,
    );
  }
  // Plain line: continuations keep the line's own leading whitespace.
  let lead = line.match(/^\s*/)[0];
  if (lead.length > width - 16) lead = '  ';
  return wrapWords(line.trim(), width - lead.length).map((c) => lead + c);
}

function wrapWords(text, width) {
  const out = [];
  let current = '';
  for (const word of text.split(/ +/)) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (current === '' || stripAnsi(candidate).length <= width) {
      current = candidate;
    } else {
      out.push(current);
      current = word;
    }
    // Hard-break a single word longer than the width (long URLs) — an
    // overflowing word would re-shatter the box.
    while (stripAnsi(current).length > width) {
      out.push(current.slice(0, width));
      current = current.slice(width);
    }
  }
  if (current !== '' || out.length === 0) out.push(current);
  return out;
}

export function note(message, title) {
  p.note(wrapNoteText(message), title);
}
export const step = (m) => p.log.step(m);

/** Progress header: `[3/15] Convex — provisioning`. */
export function phase(index, total, title) {
  p.log.step(pc.bold(pc.cyan(`[${index}/${total}] ${title}`)));
}
export const info = (m) => p.log.info(m);
export const success = (m) => p.log.success(m);
export const warn = (m) => p.log.warn(m);
export const error = (m) => p.log.error(m);
export const message = (m) => p.log.message(m);

/**
 * Print a cancel message and abort the run. Throws CancelError (instead of
 * exiting 0) so main.js can clean up temp files, offer rollback and exit 130 —
 * an explicit "no" at a prompt is a cancellation, not a success.
 */
export function bail(msg = 'Operation canceled.') {
  p.cancel(msg);
  throw new CancelError(msg);
}

/**
 * Thrown when the user cancels a prompt (Ctrl-C/Esc). It propagates up to the
 * catch in src/main.js (which matches `err?.name === 'CancelError'`) so the
 * run can roll back, log, and exit properly instead of dying mid-install with
 * a success exit code.
 */
export class CancelError extends Error {
  constructor(message = 'Operation canceled.') {
    super(message);
    this.name = 'CancelError';
  }
}

function guard(value) {
  if (p.isCancel(value)) throw new CancelError();
  return value;
}

export async function text(opts) {
  return guard(await p.text(opts));
}
export async function confirm(opts) {
  return guard(await p.confirm(opts));
}
export async function select(opts) {
  return guard(await p.select(opts));
}
export async function multiselect(opts) {
  return guard(await p.multiselect(opts));
}
export async function password(opts) {
  return guard(await p.password(opts));
}

/**
 * Run non-interactive async work under a spinner. NEVER use this to wrap a
 * command that inherits stdio — the spinner and the child fight over the TTY.
 */
export async function spin(startMsg, fn, stopMsg) {
  const s = p.spinner();
  s.start(startMsg);
  try {
    const result = await fn(s);
    s.stop(stopMsg || startMsg);
    return result;
  } catch (err) {
    s.stop(pc.red(`✗ ${startMsg}`));
    throw err;
  }
}
