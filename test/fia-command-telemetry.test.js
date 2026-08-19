import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { docsStatus, missingCoreDocs, DOC_MANIFEST } from '../fia-templates/scripts/docs-manifest.mjs';
import { readCommandTelemetry } from '../fia-templates/scripts/fia-tui-data.mjs';

test('docsStatus: missing core docs list commands to run', () => {
  const root = mkdtempSync(join(tmpdir(), 'imp-docs-'));
  const rows = docsStatus(root);
  assert.ok(rows.length >= DOC_MANIFEST.length);
  const prd = rows.find((r) => r.id === 'prd');
  assert.equal(prd.exists, false);
  assert.equal(prd.command, '/idea');

  mkdirSync(join(root, 'ai-docs'), { recursive: true });
  writeFileSync(join(root, 'ai-docs/PRD.md'), '# PRD\n');
  writeFileSync(join(root, 'ai-docs/stack.md'), '# stack\n');
  const partial = docsStatus(root);
  assert.equal(partial.find((r) => r.id === 'prd').exists, true);
  assert.equal(partial.find((r) => r.id === 'map').exists, false);
  assert.equal(partial.find((r) => r.id === 'architecture').optional, true);
  assert.equal(partial.find((r) => r.id === 'architecture').command, '/map');
  assert.equal(partial.find((r) => r.id === 'investigations').optional, true);
  assert.equal(partial.find((r) => r.id === 'investigations').command, '/bug');

  const missing = missingCoreDocs(root);
  assert.ok(missing.some((m) => m.id === 'map'));
  assert.ok(!missing.some((m) => m.id === 'prd'));
});

test('docsStatus: directory entries report file_count when populated', () => {
  const root = mkdtempSync(join(tmpdir(), 'imp-docs-dir-'));
  mkdirSync(join(root, 'ai-docs/specs'), { recursive: true });
  writeFileSync(join(root, 'ai-docs/specs/0001-one.md'), 'spec');
  const row = docsStatus(root).find((r) => r.id === 'specs');
  assert.equal(row.exists, true);
  assert.equal(row.file_count, 1);
});

test('readCommandTelemetry: aggregates NDJSON and live snapshot', () => {
  const root = mkdtempSync(join(tmpdir(), 'imp-tel-'));
  const tel = join(root, 'imp/data/telemetry');
  mkdirSync(tel, { recursive: true });
  const id = 'cmd-11111111-1111-1111-1111-111111111111';
  const ndjson = join(tel, 'commands.ndjson');
  const lines = [
    JSON.stringify({
      type: 'command_start',
      command_id: id,
      command: 'map',
      args: 'greenfield',
      session_id: 'sess-a',
      started_at: '2026-08-17T10:00:00.000Z',
    }),
    JSON.stringify({
      type: 'usage',
      command_id: id,
      at: '2026-08-17T10:01:00.000Z',
      role: 'assistant',
      tokens_in: 1000,
      tokens_out: 200,
      cache_read: 0,
      cache_write: 0,
      cost: 0.05,
    }),
    JSON.stringify({
      type: 'phase_start',
      command_id: id,
      phase_id: 't1',
      label: 'subagent: start-mapper',
      started_at: '2026-08-17T10:00:30.000Z',
    }),
    JSON.stringify({
      type: 'phase_end',
      command_id: id,
      phase_id: 't1',
      ended_at: '2026-08-17T10:05:00.000Z',
      tokens_in: 800,
      tokens_out: 150,
      cost: 0.04,
    }),
    JSON.stringify({
      type: 'doc_written',
      command_id: id,
      path: 'ai-docs/map.yaml',
      at: '2026-08-17T10:05:01.000Z',
    }),
    JSON.stringify({
      type: 'command_end',
      command_id: id,
      command: 'map',
      reason: 'settled',
      ended_at: '2026-08-17T10:10:00.000Z',
      settled_at: '2026-08-17T10:09:00.000Z',
      tokens_in: 1000,
      tokens_out: 200,
      cache_read: 0,
      cache_write: 0,
      cost: 0.05,
      docs_written: ['ai-docs/map.yaml'],
      phases: [{ id: 't1', label: 'subagent: start-mapper', started_at: '2026-08-17T10:00:30.000Z', ended_at: '2026-08-17T10:05:00.000Z', tokens_in: 800, tokens_out: 150, cost: 0.04 }],
    }),
    '{not valid json',
  ];
  writeFileSync(ndjson, `${lines.join('\n')}\n`);

  writeFileSync(
    join(tel, 'live.json'),
    `${JSON.stringify({
      id: 'live-222',
      command: 'stack',
      args: '',
      session_id: 'sess-b',
      started_at: new Date(Date.now() - 60_000).toISOString(),
      tokens_in: 500,
      tokens_out: 80,
      cache_read: 0,
      cache_write: 0,
      cost: 0.01,
      docs_written: [],
      phases: [],
      current_activity: 'bash npm run plan',
      status: 'running',
    })}\n`,
  );

  const out = readCommandTelemetry(root);
  assert.equal(out.available, true);
  assert.equal(out.live.command, 'stack');
  assert.equal(out.live.tokens_in, 500);
  assert.ok(out.history.some((r) => r.command === 'map' && r.tokens_in === 1000));
  assert.equal(out.totals.commands, 1);
  assert.equal(out.totals.cost, 0.05);
});

test('readCommandTelemetry: empty when no telemetry dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'imp-tel-empty-'));
  const out = readCommandTelemetry(root);
  assert.equal(out.available, false);
  assert.equal(out.live, null);
  assert.deepEqual(out.history, []);
});
