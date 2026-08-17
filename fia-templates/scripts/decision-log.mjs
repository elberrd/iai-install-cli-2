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
 *   node imp/scripts/decision-log.mjs note <id|path> --text "…"
 *   node imp/scripts/decision-log.mjs close <id|path> [--outcome "…"] [--artifact <p>]…
 *   node imp/scripts/decision-log.mjs latest [command] [--json]
 *   node imp/scripts/decision-log.mjs list [--command <c>] [--json]
 * All subcommands accept --dir <project root> (default: cwd).
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
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(String(content ?? ''));
  if (!m) return null;
  const fields = {};
  for (const line of m[1].split('\n')) {
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
 * Append one answered question. Returns the entry number.
 * `accepted: true` means the student took the recommendation instead of typing
 * an answer: the answer line becomes the recommendation plus the literal
 * ` (accepted)` marker. This is the SINGLE writer for both forms — the accepted
 * shape is not a second format, only a different answer text. Without a
 * recommendation there is nothing to accept, so it degrades to the plain answer
 * (the CLI refuses that combination up front).
 */
export function logEntry(file, { question, recommendation, answer, accepted }) {
  const content = readFileSync(file, 'utf8');
  const n = nextEntryNumber(content);
  const lines = [`### ${n}. ${oneLine(question)}`];
  const rec = recommendation ? oneLine(recommendation) : '';
  if (rec) lines.push(`- Recommendation: ${rec}`);
  lines.push(`- Answer: ${accepted && rec ? `${rec} (accepted)` : String(answer ?? '').trim()}`, '');
  writeFileSync(file, content.replace(/\n*$/, '\n\n') + lines.join('\n'));
  return n;
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
      if (accepted && !recommendation)
        fail('--accepted needs --rec "…" — the accepted answer IS the recommendation, so there must be one to accept');
      if (accepted && answer !== undefined)
        fail('--accepted and --a are mutually exclusive — either accept the recommendation or record a typed answer, never both');
      if (!question || (answer === undefined && !accepted))
        fail('usage: decision-log log <id|path> --q "…" [--rec "…"] (--a "…" | --accepted)');
      const n = logEntry(file, { question, recommendation, answer, accepted });
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

  fail('usage: decision-log <open|log|note|close|latest|list> …  (see the header of this file)');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main(process.argv.slice(2));
