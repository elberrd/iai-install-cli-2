#!/usr/bin/env node
import Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const dbPath = process.env.FIA_DB || 'imp/data/fia.db';
// --json → machine-readable output (Pi and scripts consume it; no formatting).
const argv = process.argv.slice(2);
const json = argv.includes('--json');
const positional = argv.filter((a) => a !== '--json');
const cmd = positional[0] || 'sessions';
const arg = positional[1];
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;
const emit = (rows) => (json ? console.log(JSON.stringify(rows, null, 2)) : console.table(rows));

if (!existsSync(dbPath)) {
  console.error(`No trace db at ${dbPath}. Run an FDA first.`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });

if (cmd === 'sessions') {
  // `relayed` counts engine switches (run-start fallback + mid-run relay) so
  // a run that finished on a substitute engine is visible at a glance.
  const rows = db
    .prepare(
      `SELECT s.fda_id, s.status, s.engineer, substr(s.request,1,60) AS request, s.total_tokens,
              (SELECT COUNT(*) FROM events e WHERE e.fda_id = s.fda_id
                 AND e.type IN ('engine_fallback','engine_relay')) AS relayed
       FROM sessions s ORDER BY s.started_at DESC LIMIT 20`,
    )
    .all();
  emit(rows);
} else if (cmd === 'phases') {
  if (!arg) {
    console.error('Usage: node imp/scripts/fia-query.mjs phases <fda_id>');
    process.exit(1);
  }
  const rows = db.prepare('SELECT seq, name, kind, owner, status FROM phases WHERE fda_id=? ORDER BY seq').all(arg);
  emit(rows);
} else if (cmd === 'models') {
  // Per-LLM lifetime ledger (tokens/cost stamped at spend time — see
  // fia-tui-data.mjs modelUsage): switching models keeps each one's history.
  const { modelUsage } = await import('./fia-tui-data.mjs');
  const usage = modelUsage(db);
  const rows = usage.rows.map((r) => ({
    engine: r.coding_agent,
    model: r.model,
    runs: r.runs,
    tokens: r.tokens,
    cost: Number(r.cost.toFixed(4)),
    last_used: r.last_used,
  }));
  if (usage.unattributed > 0) {
    rows.push({
      engine: '—',
      model: '(recorded before model stamping)',
      runs: null,
      tokens: usage.unattributed,
      cost: null,
      last_used: null,
    });
  }
  emit(rows);
} else if (cmd === 'tail') {
  if (!arg || !SAFE_ID.test(arg)) {
    console.error('Usage: node imp/scripts/fia-query.mjs tail <fda_id>  (letters, digits, - and _ only)');
    process.exit(1);
  }
  // Sessions live next to the db — respect FIA_DB instead of assuming imp/data.
  const path = join(dirname(dbPath), 'sessions', arg, 'events.jsonl');
  if (!existsSync(path)) {
    console.error(`No events at ${path}`);
    process.exit(1);
  }
  const lines = readFileSync(path, 'utf8').trim().split('\n').slice(-20);
  for (const line of lines) console.log(line);
} else {
  console.error('Commands: sessions [--json] | phases <fda_id> [--json] | models [--json] | tail <fda_id>');
  process.exit(1);
}
