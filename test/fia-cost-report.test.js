import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { costReportRows, parseCostReportId } from '../fia-templates/scripts/cost-report.mjs';

const QUERY = fileURLToPath(new URL('../fia-templates/scripts/fia-query.mjs', import.meta.url));

test('costReportRows: separates fresh input, cache and output and names the phase', () => {
  const [row] = costReportRows([
    {
      fda_id: 'run-1',
      phase_id: 'run-1_02_fix_1',
      phase: 'fix_1',
      agent: 'builder',
      total: 100,
      payload_json: JSON.stringify({
        coding_agent: 'pi',
        model: 'openai-codex/gpt',
        input: 30,
        output: 20,
        cache_read: 40,
        cache_write: 10,
        cost: 0.25,
      }),
    },
  ]);

  assert.deepEqual(row, {
    fda_id: 'run-1',
    phase: 'fix_1',
    agent: 'builder',
    engine: 'pi',
    model: 'openai-codex/gpt',
    total: 100,
    fresh: 30,
    cache_read: 40,
    cache_write: 10,
    output: 20,
    cost: 0.25,
    cache_pct: 50,
  });
});

test('costReportRows: legacy events stay explicit instead of folding output into fresh input', () => {
  const [row] = costReportRows([
    {
      fda_id: 'old',
      phase_id: 'old_01_build',
      phase: null,
      agent: 'builder',
      total: 75,
      payload_json: JSON.stringify({ cache_read: 50, cache_write: 5 }),
    },
  ]);
  assert.equal(row.phase, 'old_01_build');
  assert.equal(row.fresh, null);
  assert.equal(row.output, null);
  assert.equal(row.cache_pct, null);
  assert.equal(row.cache_read, 50);
});

test('parseCostReportId: accepts safe ids and refuses to widen an invalid filter', () => {
  assert.equal(parseCostReportId(undefined), null);
  assert.equal(parseCostReportId('run_123-abc'), 'run_123-abc');
  assert.throws(() => parseCostReportId('../all'), /letters, digits/);
});

test('fia-query cost-report: joins phase names and rejects an invalid CLI filter', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fia-cost-report-')), 'fia.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE phases (phase_id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY, fda_id TEXT, phase_id TEXT, type TEXT, name TEXT,
      payload_json TEXT, tokens INTEGER, started_at TEXT
    );
  `);
  db.prepare('INSERT INTO phases (phase_id, name) VALUES (?, ?)').run('run1_02_build', 'build');
  db.prepare(
    'INSERT INTO events (event_id, fda_id, phase_id, type, name, payload_json, tokens, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    'evt1',
    'run1',
    'run1_02_build',
    'agent_end',
    'builder',
    JSON.stringify({ coding_agent: 'pi', model: 'gpt', input: 6, output: 2, cache_read: 2, cache_write: 0 }),
    10,
    '2026-08-18T12:00:00.000Z',
  );
  db.close();

  const output = execFileSync(process.execPath, [QUERY, 'cost-report', 'run1', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, FIA_DB: dbPath },
  });
  const rows = JSON.parse(output);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].phase, 'build');
  assert.equal(rows[0].fresh, 6);
  assert.equal(rows[0].output, 2);

  const invalid = spawnSync(process.execPath, [QUERY, 'cost-report', '../all'], {
    encoding: 'utf8',
    env: { ...process.env, FIA_DB: dbPath },
  });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /letters, digits/);
  assert.doesNotMatch(invalid.stdout, /run1/);
});
