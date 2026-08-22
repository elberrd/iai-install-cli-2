#!/usr/bin/env node
/**
 * task-defer — postpone a roadmap task WITHOUT weakening the holdout.
 *
 * The situation this exists for: a task cannot proceed right now for a reason
 * outside the code — missing API keys, a provider decision, a paid account the
 * student will only create later. The task's sealed probes in imp/data/holdout/
 * would keep failing every later run, and agents cannot touch that directory
 * (it judges them), so the escape hatch used to be a hand-typed `mv`. This is
 * that hatch as a first-class, reversible, ledgered command:
 *
 *   imp defer                     current deferrals (tasks + quarantined probes)
 *   imp defer <n> [--reason "…"]  defer task n: its probes NN-*.mjs are renamed
 *                                 to _NN-*.mjs (the runner's "not a probe"
 *                                 prefix — content untouched), the task goes
 *                                 `deferred` in the issue file AND the index,
 *                                 and the deferral is ledgered + noted in
 *                                 ai-docs/inbox.md so it cannot be forgotten
 *   imp defer resume <n>          bring it back: probes restored, status
 *                                 `pending`, ledger entry closed
 *   imp defer list --json         machine-readable state
 *   Flags: --yes (skip the confirmation; required off-TTY) · --reason "…"
 *
 * This is the ENGINEER's command. It refuses inside an FDA phase (FIA_FDA_RUN)
 * and while a run is live (.fda.lock) — a builder must never be able to
 * postpone the probe that judges it. Probes are renamed, never edited or
 * deleted; `resume` restores the exact sealed content. The launch check warns
 * about every open deferral, so shipping without one is a conscious call.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { activeFdaLock } from './fda-lock.mjs';
import { readPlanTasks } from './plan-docs.mjs';
import { holdoutDir } from '../modules/holdout.mjs';
import { dataDirOf, isMainModule, nowIso } from '../modules/utils.mjs';

export const LEDGER_FILE = 'deferrals.json';

const PROBE_NAME = /^(_?)(\d{1,3})-.+\.mjs$/;

/** Two task numbers name the same task regardless of zero-padding. */
const sameTask = (a, b) => Number(a) === Number(b);

// ── probes ───────────────────────────────────────────────────────────────────

/** The holdout probe files that belong to task `num` → { active, quarantined } (names). */
export function probesOfTask(dataDir, num) {
  const dir = holdoutDir(dataDir);
  const active = [];
  const quarantined = [];
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return { active, quarantined };
  }
  for (const name of names.sort()) {
    const m = PROBE_NAME.exec(name);
    if (!m || !sameTask(m[2], num)) continue;
    (m[1] ? quarantined : active).push(name);
  }
  return { active, quarantined };
}

/** Every `_NN-*.mjs` in the holdout — probes currently out of the gate. */
export function listQuarantinedProbes(dataDir) {
  const dir = holdoutDir(dataDir);
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .sort()
    .map((name) => {
      const m = PROBE_NAME.exec(name);
      return m && m[1] ? { name, task: m[2] } : null;
    })
    .filter(Boolean);
}

/** `NN-*.mjs` → `_NN-*.mjs`. Rename only — sealed content is never touched. */
export function quarantineProbes(dataDir, num) {
  const dir = holdoutDir(dataDir);
  const { active } = probesOfTask(dataDir, num);
  const moved = [];
  for (const name of active) {
    const to = `_${name}`;
    if (existsSync(join(dir, to))) {
      throw new Error(`cannot quarantine ${name}: ${to} already exists in ${dir} — resolve the collision by hand`);
    }
    renameSync(join(dir, name), join(dir, to));
    moved.push(name);
  }
  return { moved };
}

/** `_NN-*.mjs` → `NN-*.mjs` — the exact sealed probe re-enters the gate. */
export function restoreProbes(dataDir, num) {
  const dir = holdoutDir(dataDir);
  const { quarantined } = probesOfTask(dataDir, num);
  const restored = [];
  for (const name of quarantined) {
    const to = name.slice(1);
    if (existsSync(join(dir, to))) {
      throw new Error(`cannot restore ${name}: ${to} already exists in ${dir} — resolve the collision by hand`);
    }
    renameSync(join(dir, name), join(dir, to));
    restored.push(to);
  }
  return { restored };
}

// ── task status (issue file + index — the two places the golden rule names) ──

/** Rewrite the `**Status:**` (or plain `Status:`) meta line → { md, changed }. */
export function setIssueStatus(md, status) {
  for (const re of [/^(\s*(?:[-*]\s*)?\*\*Status:\*\*\s*).+$/im, /^(\s*(?:[-*]\s*)?Status:\s*).+$/im]) {
    if (re.test(md)) return { md: md.replace(re, `$1${status}`), changed: true };
  }
  return { md, changed: false };
}

const cellKey = (s) => String(s).replace(/[^a-z0-9#]/gi, '').toLowerCase();

/**
 * Rewrite task `num`'s Status cell in the index table → { md, changed }.
 * Finds the table whose header has a Status column next to a Task/#/Tarefa
 * column, locates the row by the first task number in it, and swaps only that
 * cell — every other byte of the file (links, spacing, notes) stays put.
 */
export function setIndexStatus(md, num, status) {
  const lines = md.split('\n');
  let statusCol = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) {
      statusCol = -1;
      continue;
    }
    const parts = line.split('|');
    const offset = parts[0].trim() === '' ? 1 : 0;
    const cells = parts.slice(offset, parts.length - (parts[parts.length - 1].trim() === '' ? 1 : 0));
    if (statusCol === -1) {
      const keys = cells.map(cellKey);
      const sc = keys.indexOf('status');
      if (sc !== -1 && keys.some((k) => k === 'task' || k === 'tarefa' || k === '#')) statusCol = sc;
      continue;
    }
    if (cells.every((c) => /^\s*:?-{2,}:?\s*$/.test(c))) continue; // separator row
    const n = (/\d{1,3}/.exec(cells[0] || '') || /\d{1,3}/.exec(cells[1] || '') || [])[0];
    if (!n || !sameTask(n, num)) continue;
    parts[offset + statusCol] = ` ${status} `;
    lines[i] = parts.join('|');
    return { md: lines.join('\n'), changed: true };
  }
  return { md, changed: false };
}

function writeStatus(root, task, status) {
  const result = { issue: false, index: false };
  if (task?.file) {
    const p = join(root, 'ai-docs', task.file);
    try {
      const r = setIssueStatus(readFileSync(p, 'utf8'), status);
      if (r.changed) writeFileSync(p, r.md);
      result.issue = r.changed;
    } catch {
      /* a missing/unreadable issue file degrades to the index-only write */
    }
  }
  const indexPath = join(root, 'ai-docs', 'todos', 'task-master.md');
  try {
    const r = setIndexStatus(readFileSync(indexPath, 'utf8'), task.num, status);
    if (r.changed) writeFileSync(indexPath, r.md);
    result.index = r.changed;
  } catch {
    /* no index — issue-only projects still get the probe quarantine */
  }
  return result;
}

// ── ledger + inbox (the trail that keeps a deferral from being forgotten) ────

export function loadLedger(dataDir) {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, LEDGER_FILE), 'utf8'));
    if (raw && typeof raw === 'object' && raw.deferred && typeof raw.deferred === 'object') return raw;
  } catch {
    /* absent or unreadable → fresh ledger; the filesystem stays the truth */
  }
  return { version: 1, deferred: {} };
}

export function saveLedger(dataDir, ledger) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, LEDGER_FILE), JSON.stringify(ledger, null, 2) + '\n');
}

function noteInbox(root, line) {
  const p = join(root, 'ai-docs', 'inbox.md');
  try {
    const cur = existsSync(p) ? readFileSync(p, 'utf8') : '# Inbox\n';
    writeFileSync(p, `${cur.replace(/\n*$/, '\n')}${line}\n`);
    return true;
  } catch {
    return false; // the inbox is a courtesy — the ledger and the rename are the record
  }
}

function tickInbox(root, num) {
  const p = join(root, 'ai-docs', 'inbox.md');
  try {
    const cur = readFileSync(p, 'utf8');
    const re = new RegExp(`^(\\s*[-*]\\s*)\\[ \\](\\s*Task ${Number(num)} deferred\\b.*)$`, 'm');
    if (!re.test(cur)) return false;
    writeFileSync(p, cur.replace(re, '$1[x]$2'));
    return true;
  } catch {
    return false;
  }
}

// ── guards ───────────────────────────────────────────────────────────────────

/** Why this command may not run now — null when it may. Fails toward refusal. */
export function deferGuard(root, env = process.env) {
  if (env.FIA_FDA_RUN) {
    return (
      'refusing inside an FDA phase — deferring a task (and its sealed probes) is the ' +
      "engineer's call, never a running agent's. Ask the engineer to run `imp defer` in a terminal."
    );
  }
  const lock = activeFdaLock(root);
  if (lock) {
    return (
      `an FDA run is active (fda_id ${lock.fda_id || 'unknown'}, pid ${lock.pid}) — ` +
      'wait for it to finish or stop it (`imp stop`), then retry.'
    );
  }
  return null;
}

// ── the two operations ───────────────────────────────────────────────────────

/**
 * Defer task `num`: quarantine its probes, set `deferred` in both status
 * places, ledger it, note the inbox. Throws with the reason when it must not
 * run (guard, done task, nothing to defer).
 */
export function deferTask({ root = process.cwd(), env = process.env } = {}, num, { reason = '' } = {}) {
  root = resolve(root);
  const blocked = deferGuard(root, env);
  if (blocked) throw new Error(blocked);
  const dataDir = dataDirOf(root);
  const plan = readPlanTasks(join(root, 'ai-docs'));
  const task = plan.tasks.find((t) => sameTask(t.num, num));
  const probes = probesOfTask(dataDir, num);
  if (!task && !probes.active.length && !probes.quarantined.length) {
    throw new Error(`no task ${num} in ai-docs/todos and no holdout probe named ${num}-*.mjs — nothing to defer`);
  }
  if (task?.status === 'done') throw new Error(`Task ${task.num} is done — a finished task is history, not a deferral`);

  const { moved } = quarantineProbes(dataDir, num);
  const status = task && task.status !== 'deferred' ? writeStatus(root, task, 'deferred') : { issue: false, index: false };

  const ledger = loadLedger(dataDir);
  const key = String(Number(num));
  ledger.deferred[key] = {
    task: task?.num || key,
    title: task?.title || null,
    reason: reason || null,
    at: nowIso(),
    probes: [...moved, ...probes.quarantined],
  };
  saveLedger(dataDir, ledger);
  noteInbox(
    root,
    `- [ ] Task ${Number(num)} deferred${reason ? ` — ${reason}` : ''} (probes quarantined; resume: \`imp defer resume ${Number(num)}\`)`,
  );
  return {
    num: task?.num || key,
    title: task?.title || null,
    alreadyDeferred: task?.status === 'deferred',
    probes: moved,
    probesAlreadyQuarantined: probes.quarantined,
    status,
  };
}

/**
 * Resume task `num`: restore its sealed probes, set `pending` in both status
 * places, close the ledger entry. Throws when there is nothing to resume.
 */
export function resumeTask({ root = process.cwd(), env = process.env } = {}, num) {
  root = resolve(root);
  const blocked = deferGuard(root, env);
  if (blocked) throw new Error(blocked);
  const dataDir = dataDirOf(root);
  const plan = readPlanTasks(join(root, 'ai-docs'));
  const task = plan.tasks.find((t) => sameTask(t.num, num));
  const probes = probesOfTask(dataDir, num);
  const ledger = loadLedger(dataDir);
  const key = String(Number(num));
  if (!probes.quarantined.length && task?.status !== 'deferred' && !ledger.deferred[key]) {
    throw new Error(`task ${num} is not deferred — nothing to resume`);
  }
  const { restored } = restoreProbes(dataDir, num);
  const status = task?.status === 'deferred' ? writeStatus(root, task, 'pending') : { issue: false, index: false };
  if (ledger.deferred[key]) {
    delete ledger.deferred[key];
    saveLedger(dataDir, ledger);
  }
  tickInbox(root, num);
  return { num: task?.num || key, title: task?.title || null, probes: restored, status };
}

/** Read-only state for `list`/`--json` and the launch check. */
export function deferState({ root = process.cwd() } = {}) {
  root = resolve(root);
  const dataDir = dataDirOf(root);
  const plan = readPlanTasks(join(root, 'ai-docs'));
  const quarantined = listQuarantinedProbes(dataDir);
  const deferredTasks = plan.tasks.filter((t) => t.status === 'deferred').map((t) => ({ num: t.num, title: t.title }));
  return { deferredTasks, quarantined, ledger: loadLedger(dataDir).deferred };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const USAGE = `Usage:
  imp defer                     current deferrals (tasks + quarantined probes)
  imp defer <n> [--reason "…"]  defer task n — probes quarantined (reversible),
                                status deferred in issue + index, ledger + inbox
  imp defer resume <n>          bring it back — probes restored, status pending
  imp defer list [--json]       machine-readable state
Flags: --yes (skip the confirmation; required when not on a TTY)`;

function parseArgv(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') flags.json = true;
    else if (arg === '--yes' || arg === '-y') flags.yes = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--reason') flags.reason = argv[++i] || '';
    else positional.push(arg);
  }
  return { flags, positional };
}

function printState(state) {
  if (!state.deferredTasks.length && !state.quarantined.length) {
    console.log('No deferred tasks and no quarantined holdout probes.');
    return;
  }
  for (const t of state.deferredTasks) {
    const entry = state.ledger[String(Number(t.num))];
    const why = entry?.reason ? ` — ${entry.reason}` : '';
    console.log(`⏸ Task ${t.num}${t.title ? ` — ${t.title}` : ''}${why}`);
  }
  for (const p of state.quarantined) console.log(`   probe out of the gate: ${p.name}`);
  console.log('Resume one: imp defer resume <n>');
}

async function confirm(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

export async function runCli(argv, { root = process.cwd(), env = process.env } = {}) {
  const { flags, positional } = parseArgv(argv);
  if (flags.help) {
    console.log(USAGE);
    return 0;
  }
  const first = positional[0];

  if (!first || first === 'list') {
    let state;
    try {
      state = deferState({ root });
    } catch (err) {
      console.error(`✖ ${err?.message || err}`);
      return 1;
    }
    if (flags.json) console.log(JSON.stringify(state, null, 2));
    else {
      printState(state);
      if (!first) console.log(`\n${USAGE}`);
    }
    return 0;
  }

  const resume = first === 'resume';
  const num = resume ? positional[1] : first;
  if (!num || !/^\d{1,3}$/.test(String(num))) {
    console.error(`✖ expected a task number${resume ? ' after resume' : ''} — e.g. \`imp defer ${resume ? 'resume ' : ''}21\`\n${USAGE}`);
    return 1;
  }

  if (!flags.yes) {
    const what = resume
      ? `Resume task ${Number(num)} — restore its sealed probes and set it pending?`
      : `Defer task ${Number(num)} — quarantine its sealed probes and mark it deferred (reversible)?`;
    const ok = await confirm(what);
    if (!ok) {
      console.error(
        process.stdin.isTTY && process.stdout.isTTY
          ? 'Nothing changed.'
          : '✖ not a terminal — deferring is the engineer\'s call, so confirm it explicitly with --yes.',
      );
      return 1;
    }
  }

  try {
    if (resume) {
      const r = resumeTask({ root, env }, num);
      console.log(`✔ Task ${Number(r.num)}${r.title ? ` — ${r.title}` : ''} resumed.`);
      for (const p of r.probes) console.log(`  probe back in the gate: ${p}`);
      console.log('  Run it when ready: /task ' + Number(r.num) + ' (inside Pi).');
    } else {
      const r = deferTask({ root, env }, num, { reason: flags.reason });
      console.log(`✔ Task ${Number(r.num)}${r.title ? ` — ${r.title}` : ''} deferred${r.alreadyDeferred ? ' (was already marked deferred)' : ''}.`);
      for (const p of r.probes) console.log(`  probe quarantined (content untouched): ${p} → _${p}`);
      if (!r.probes.length && !r.probesAlreadyQuarantined.length) console.log('  no sealed probes carried this task number — status and ledger updated.');
      console.log(`  Bring it back later: imp defer resume ${Number(r.num)}`);
    }
    return 0;
  } catch (err) {
    console.error(`✖ ${err?.message || err}`);
    return 1;
  }
}

const isMain = isMainModule(import.meta.url);
if (isMain) process.exit(await runCli(process.argv.slice(2)));
