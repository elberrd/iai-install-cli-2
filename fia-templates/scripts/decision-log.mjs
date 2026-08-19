/**
 * Decision log — deterministic, versioned record of interview answers.
 *
 * Interview commands (/idea, /grill, /stack, /spec, /feature, /theme, /design)
 * ask ONE question at a time and the user's answers are product decisions.
 * This script is the code side of that ritual: it owns file naming, numbering,
 * timestamps, format and lifecycle, so no answer depends on the agent
 * remembering to write things down at the end. The agent only calls:
 *
 *   open  — before the first question (creates the versioned file)
 *   log   — after EACH answered question (append-as-you-go: a crashed
 *           session loses nothing already answered)
 *   note  — a decision that surfaced outside the Q&A rhythm
 *   close — at wrap-up (outcome + artifacts + status)
 *
 * Files live in ai-docs/decisions/ as NNN-<command>-YYYY-MM-DD.md — one file
 * per run, never rewritten by a later run. Running /idea again simply opens
 * 002-idea-…; the previous log stays as history (an open log of the same
 * command is marked "superseded" so only one can be active). `latest` and
 * `list --json` are the read side: commands consult them before re-asking
 * what is already decided.
 *
 * Usage:
 *   node imp/scripts/decision-log.mjs open <command> [--topic "…"] [--json]
 *   node imp/scripts/decision-log.mjs log <id|path> --q "…" [--rec "…"] --a "…"
 *   node imp/scripts/decision-log.mjs log <id|path> --q "…" --rec "…" --accepted
 *   node imp/scripts/decision-log.mjs log <id|path> --q "…" --a "…" --kind product --self
 *   node imp/scripts/decision-log.mjs note <id|path> --text "…"
 *   node imp/scripts/decision-log.mjs close <id|path> [--outcome "…"] [--artifact <p>]…
 *   node imp/scripts/decision-log.mjs find --q "…" [--json]
 *   node imp/scripts/decision-log.mjs latest [command] [--json]
 *   node imp/scripts/decision-log.mjs list [--command <c>] [--json]
 * All subcommands accept --dir <project root> (default: cwd).
 *
 * Kinds (`--kind product|judgement`): a PRODUCT value (a default, a name, a
 * layout) an agent may choose alone — record it with `--self` and carry on;
 * a JUDGEMENT value (a floor, a lock, a tolerance) is never the agent's to
 * choose, because choosing one is tuning the judge — `--self` is refused for
 * it in code. `find` is the ask-once rule: consult it before re-asking a
 * question an earlier interview already answered, and reference the entry
 * instead of asking again.
 *
 * `--accepted` is the beginner's exit from an open question: the student takes
 * the recommendation instead of typing an answer. It REQUIRES --rec and refuses
 * a simultaneous --a, and the entry records the recommendation as the answer
 * with a literal marker, so the file stays unambiguous about who decided:
 *
 *   ### 3. Which database?
 *   - Recommendation: Convex
 *   - Answer: Convex (accepted)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DECISIONS_DIR = join('ai-docs', 'decisions');

// ── small pure helpers ───────────────────────────────────────────────────────

/** Local timestamp `YYYY-MM-DD HH:mm` (IAI_DECISION_LOG_NOW overrides, for tests). */
export function now() {
  const fixed = process.env.IAI_DECISION_LOG_NOW;
  const d = fixed ? new Date(fixed) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** One line, trimmed — frontmatter values and headings must never break the format. */
export function oneLine(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parse the `--- … ---` frontmatter block → { fields, bodyStart } (null if absent). */
export function parseFrontmatter(content) {
  // CRLF-tolerant: on Windows (`core.autocrlf=true` is Git for Windows' own
  // recommendation) a committed log comes back from a clone or a checkout with
  // \r\n. An LF-only pattern silently matches nothing, and every reader —
  // list, latest, find — then behaves as if the project had no decision logs
  // at all.
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(String(content ?? ''));
  if (!m) return null;
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return { fields, bodyStart: m[0].length };
}

/** Next 3-digit sequence from existing `NNN-…` file names (gaps never reused). */
export function nextSequence(names) {
  let max = 0;
  for (const name of names ?? []) {
    const m = /^(\d+)-/.exec(name);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return String(max + 1).padStart(3, '0');
}

/** Count `### ` entries already in a log body → next entry number. */
export function nextEntryNumber(content) {
  // Only OUR numbered entries count — a pasted multi-line answer containing a
  // markdown `### heading` must not inflate the sequence. Max+1, not count+1,
  // so a hand-deleted entry can never cause a duplicate number.
  const numbers = [...String(content ?? '').matchAll(/^### (\d+)\./gm)].map((m) => Number(m[1]));
  return numbers.length ? Math.max(...numbers) + 1 : 1;
}

// ── store ────────────────────────────────────────────────────────────────────

function dirFor(root) {
  return join(root, DECISIONS_DIR);
}

/** All parseable logs in ai-docs/decisions/, oldest first. Malformed files are skipped. */
export function readLogs(root) {
  const dir = dirFor(root);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (!/^\d+-.*\.md$/.test(name)) continue; // README.md, hand notes, …
    const file = join(dir, name);
    let fm;
    try {
      fm = parseFrontmatter(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!fm?.fields.command) continue;
    out.push({
      seq: parseInt(name, 10),
      file: join(DECISIONS_DIR, name),
      command: fm.fields.command,
      topic: fm.fields.topic || '',
      status: fm.fields.status || 'open',
      opened: fm.fields.opened || '',
      closed: fm.fields.closed || '',
      artifacts: fm.fields.artifacts || '',
    });
  }
  return out;
}

/** `<id|path>` → absolute file path (id = the numeric prefix, "7" or "007"). */
export function resolveLog(root, ref) {
  const asPath = isAbsolute(ref) ? ref : join(root, ref);
  if (/\.md$/.test(ref) && existsSync(asPath)) return asPath;
  if (/^\d+$/.test(ref)) {
    const seq = parseInt(ref, 10);
    const hit = readLogs(root).find((l) => l.seq === seq);
    if (hit) return join(root, hit.file);
  }
  return null;
}

function rewriteField(content, key, value) {
  const fm = parseFrontmatter(content);
  if (!fm) return content;
  const head = content.slice(0, fm.bodyStart);
  if (new RegExp(`^${key}:`, 'm').test(head)) {
    return content.replace(new RegExp(`^${key}:.*$`, 'm'), `${key}: ${value}`) ;
  }
  return content.replace(/\n---\n/, `\n${key}: ${value}\n---\n`);
}

// ── lifecycle ────────────────────────────────────────────────────────────────

/** Create a new versioned log; any open log of the same command becomes superseded. */
export function openLog(root, command, topic) {
  const dir = dirFor(root);
  mkdirSync(dir, { recursive: true });
  for (const prev of readLogs(root)) {
    if (prev.command === command && prev.status === 'open') {
      const file = join(root, prev.file);
      writeFileSync(file, rewriteField(readFileSync(file, 'utf8'), 'status', 'superseded'));
    }
  }
  const stamp = now();
  const seq = nextSequence(readdirSync(dir));
  const name = `${seq}-${command}-${stamp.slice(0, 10)}.md`;
  const title = topic ? ` — ${oneLine(topic)}` : '';
  const content = [
    '---',
    `command: ${command}`,
    `topic: ${topic ? oneLine(topic) : '—'}`,
    'status: open',
    `opened: ${stamp}`,
    '---',
    '',
    `# Decision log — /${command}${title}`,
    '',
    'One entry per answered question, appended as the interview happens',
    '(`imp/scripts/decision-log.mjs`). Later runs read this before re-asking.',
    '',
    '## Decisions',
    '',
  ].join('\n');
  writeFileSync(join(dir, name), content);
  return join(DECISIONS_DIR, name);
}

/**
 * The two kinds of value a decision can set. A PRODUCT value — a price, a
 * default, a name, a layout — an agent may choose on its own, record here and
 * carry on; the log is the audit trail. A JUDGEMENT value — a floor, a lock,
 * a tolerance, a gate threshold — is never the agent's to choose, because
 * choosing one is tuning the judge that grades the agent's own work. Code
 * enforces the half it can see: `self` (the agent chose without asking) is
 * only accepted together with `kind: 'product'`.
 */
export const DECISION_KINDS = ['product', 'judgement'];

/**
 * Append one answered question. Returns the entry number.
 * `accepted: true` means the student took the recommendation instead of typing
 * an answer: the answer line becomes the recommendation plus the literal
 * ` (accepted)` marker. This is the SINGLE writer for both forms — the accepted
 * shape is not a second format, only a different answer text. Without a
 * recommendation there is nothing to accept, so it degrades to the plain answer
 * (the CLI refuses that combination up front).
 * `self: true` records a decision the AGENT made without asking — allowed only
 * for product values (see DECISION_KINDS); the entry says so in plain text,
 * so the file stays unambiguous about who decided.
 */
export function logEntry(file, { question, recommendation, answer, accepted, kind, self }) {
  if (kind !== undefined && !DECISION_KINDS.includes(kind)) {
    throw new Error(`unknown decision kind "${kind}" — use product or judgement`);
  }
  if (self && kind !== 'product') {
    throw new Error(
      'a self-chosen decision must be kind "product" — a judgement value (floor, lock, tolerance, gate threshold) ' +
        'is never the agent\'s to choose: choosing one is tuning the judge. Ask the student and record their answer.',
    );
  }
  const content = readFileSync(file, 'utf8');
  const n = nextEntryNumber(content);
  const lines = [`### ${n}. ${oneLine(question)}`];
  if (kind) lines.push(`- Kind: ${kind}`);
  const rec = recommendation ? oneLine(recommendation) : '';
  if (rec) lines.push(`- Recommendation: ${rec}`);
  const answerText = accepted && rec ? `${rec} (accepted)` : String(answer ?? '').trim();
  lines.push(`- Answer: ${self ? `${answerText} (chosen by the agent)` : answerText}`, '');
  writeFileSync(file, content.replace(/\n*$/, '\n\n') + lines.join('\n'));
  return n;
}

/** Parse a log body's numbered entries → [{ n, question, kind, answer }]. */
export function parseEntries(content) {
  const entries = [];
  const re = /^### (\d+)\.\s*(.*)$/gm;
  const text = String(content ?? '');
  let m;
  while ((m = re.exec(text))) {
    const block = text.slice(m.index, text.indexOf('\n### ', m.index + 1) === -1 ? undefined : text.indexOf('\n### ', m.index + 1));
    const answer = /^- Answer:\s*(.*)$/m.exec(block)?.[1]?.trim() ?? '';
    const kind = /^- Kind:\s*(.*)$/m.exec(block)?.[1]?.trim() ?? '';
    entries.push({ n: Number(m[1]), question: m[2].trim(), kind, answer });
  }
  return entries;
}

/** Case/whitespace-insensitive needle for ask-once matching. */
function normalizeQuestion(text) {
  return oneLine(text).toLowerCase().replace(/[?.:!]+$/, '');
}

/**
 * Ask-once: has this question (or one containing it) already been answered in
 * ANY log? Commands consult this BEFORE re-asking — a second task that needs
 * the same answer references the entry and carries on. Substring match on the
 * normalized question, newest answers last (the last hit is the current one).
 */
export function findEntries(root, query) {
  const needle = normalizeQuestion(query);
  if (!needle) return [];
  const hits = [];
  for (const log of readLogs(root)) {
    let content = '';
    try {
      content = readFileSync(join(root, log.file), 'utf8');
    } catch {
      continue;
    }
    for (const entry of parseEntries(content)) {
      if (normalizeQuestion(entry.question).includes(needle)) {
        hits.push({ file: log.file, seq: log.seq, command: log.command, status: log.status, ...entry });
      }
    }
  }
  return hits;
}

/** Append a free-form decision that surfaced outside the Q&A rhythm. */
export function noteEntry(file, text) {
  const content = readFileSync(file, 'utf8');
  writeFileSync(file, content.replace(/\n*$/, '\n\n') + `- Note (${now()}): ${String(text ?? '').trim()}\n`);
}

/** Close the log: outcome section + artifacts + `status: closed`. */
export function closeLog(file, { outcome, artifacts = [] }) {
  let content = readFileSync(file, 'utf8');
  const fm = parseFrontmatter(content);
  if (fm?.fields.status === 'closed') throw new Error(`already closed: ${basename(file)}`);
  const stamp = now();
  content = rewriteField(content, 'status', 'closed');
  content = rewriteField(content, 'closed', stamp);
  if (artifacts.length) content = rewriteField(content, 'artifacts', artifacts.join(', '));
  const lines = ['## Outcome', `- Result: ${outcome ? oneLine(outcome) : 'closed without summary'}`];
  if (artifacts.length) lines.push(`- Artifacts: ${artifacts.join(', ')}`);
  lines.push(`- Closed: ${stamp}`, '');
  writeFileSync(file, content.replace(/\n*$/, '\n\n') + lines.join('\n'));
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function flagValue(argv, flag) {
  const ix = argv.indexOf(flag);
  return ix !== -1 && argv[ix + 1] !== undefined ? argv[ix + 1] : undefined;
}

function flagValues(argv, flag) {
  const out = [];
  for (let i = 0; i < argv.length - 1; i++) if (argv[i] === flag) out.push(argv[i + 1]);
  return out;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

export function main(argv) {
  const cmd = argv[0];
  const root = resolve(flagValue(argv, '--dir') ?? process.cwd());
  const json = argv.includes('--json');

  if (cmd === 'open') {
    const command = argv[1];
    if (!command || command.startsWith('--')) fail('usage: decision-log open <command> [--topic "…"]');
    // The command goes into the filename verbatim — a slash ("open /idea")
    // would crash on ENOENT mid-interview, a space would shard the store.
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(command))
      fail(`invalid command name "${command}" — use the bare lowercase name (letters, digits, dashes): open idea, never open /idea`);
    const rel = openLog(root, command, flagValue(argv, '--topic'));
    console.log(json ? JSON.stringify({ file: rel }) : rel);
    return;
  }

  if (cmd === 'log' || cmd === 'note' || cmd === 'close') {
    const ref = argv[1];
    if (!ref || ref.startsWith('--')) fail(`usage: decision-log ${cmd} <id|path> …`);
    const file = resolveLog(root, ref);
    if (!file) fail(`decision log not found: ${ref} (looked in ${DECISIONS_DIR}/)`);
    if (cmd === 'log') {
      const question = flagValue(argv, '--q');
      const answer = flagValue(argv, '--a');
      const recommendation = flagValue(argv, '--rec');
      const accepted = argv.includes('--accepted');
      const kind = flagValue(argv, '--kind');
      const self = argv.includes('--self');
      if (accepted && !recommendation)
        fail('--accepted needs --rec "…" — the accepted answer IS the recommendation, so there must be one to accept');
      if (accepted && answer !== undefined)
        fail('--accepted and --a are mutually exclusive — either accept the recommendation or record a typed answer, never both');
      if (self && accepted)
        fail('--self and --accepted are mutually exclusive — accepted means the STUDENT took the recommendation; self means the agent chose alone');
      if (kind !== undefined && !DECISION_KINDS.includes(kind))
        fail(`--kind must be one of: ${DECISION_KINDS.join(', ')}`);
      if (self && kind !== 'product')
        fail('--self requires --kind product — a judgement value (floor, lock, tolerance, gate threshold) is never the agent\'s to choose; ask the student instead');
      if (!question || (answer === undefined && !accepted))
        fail('usage: decision-log log <id|path> --q "…" [--rec "…"] [--kind product|judgement] [--self] (--a "…" | --accepted)');
      let n;
      try {
        n = logEntry(file, { question, recommendation, answer, accepted, kind, self });
      } catch (err) {
        fail(err.message);
      }
      console.log(json ? JSON.stringify({ entry: n }) : `logged #${n}`);
    } else if (cmd === 'note') {
      const text = flagValue(argv, '--text');
      if (!text) fail('usage: decision-log note <id|path> --text "…"');
      noteEntry(file, text);
      console.log('noted');
    } else {
      try {
        closeLog(file, { outcome: flagValue(argv, '--outcome'), artifacts: flagValues(argv, '--artifact') });
      } catch (err) {
        fail(err.message);
      }
      console.log('closed');
    }
    return;
  }

  if (cmd === 'find') {
    // Ask-once: consult BEFORE re-asking a question any earlier interview
    // already answered. The LAST hit is the current answer; reference its
    // file+entry instead of opening a new round of the same interview.
    const query = flagValue(argv, '--q');
    if (!query) fail('usage: decision-log find --q "…" [--json]');
    const hits = findEntries(root, query);
    if (json) return console.log(JSON.stringify(hits, null, 2));
    // Deliberately NOT "this question is new": the match is a substring of the
    // RECORDED question, so a long query ("Which auth provider should we use
    // for the admin panel?") misses a short entry ("Which auth provider?").
    // Claiming newness on one miss is how the ask-once rule would re-ask the
    // very question it exists to prevent.
    if (!hits.length) {
      return console.log(
        'no log matched that wording — retry with 2-4 distinctive words (e.g. "auth provider", then "auth") before treating the question as new',
      );
    }
    for (const h of hits) {
      console.log(`${h.file} #${h.n}${h.kind ? ` [${h.kind}]` : ''}  ${h.question} → ${h.answer}`);
    }
    return;
  }

  if (cmd === 'latest') {
    const command = argv[1] && !argv[1].startsWith('--') ? argv[1] : undefined;
    const logs = readLogs(root).filter((l) => !command || l.command === command);
    const hit = logs[logs.length - 1] ?? null;
    if (json) return console.log(JSON.stringify(hit));
    if (!hit) fail(`no decision logs${command ? ` for /${command}` : ''} in ${DECISIONS_DIR}/`);
    console.log(hit.file);
    return;
  }

  if (cmd === 'list') {
    const command = flagValue(argv, '--command');
    const logs = readLogs(root).filter((l) => !command || l.command === command);
    if (json) return console.log(JSON.stringify(logs, null, 2));
    if (!logs.length) return console.log(`no decision logs in ${DECISIONS_DIR}/`);
    for (const l of logs) {
      console.log(
        `${String(l.seq).padStart(3, '0')}  ${l.command.padEnd(8)}  ${l.status.padEnd(10)}  ${l.opened.slice(0, 10)}  ${l.topic}`,
      );
    }
    return;
  }

  fail('usage: decision-log <open|log|note|close|find|latest|list> …  (see the header of this file)');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main(process.argv.slice(2));
