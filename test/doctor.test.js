// `imp doctor` — the pure .mcp.json hygiene rule and the report contract
// (four sections, read-only, exit keyed to error-level findings only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpNpxFindings, collectDoctorReport } from '../src/steps/doctor.js';

test('mcpNpxFindings: npx server without -y is flagged; -y/--yes/non-npx are not', () => {
  const rows = mcpNpxFindings({
    mcpServers: {
      playwright: { command: 'npx', args: ['@playwright/mcp@latest'] },
      convex: { command: 'npx', args: ['-y', 'convex@latest', 'mcp', 'start'] },
      other: { command: 'npx', args: ['--yes', 'something'] },
      local: { command: 'node', args: ['server.mjs'] },
    },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].level, 'warn');
  assert.match(rows[0].msg, /"playwright"/);
  assert.match(rows[0].msg, /Connection closed/);
});

test('mcpNpxFindings: missing/odd shapes never throw and report nothing', () => {
  assert.deepEqual(mcpNpxFindings(null), []);
  assert.deepEqual(mcpNpxFindings({}), []);
  assert.deepEqual(mcpNpxFindings({ mcpServers: 'nope' }), []);
  assert.deepEqual(mcpNpxFindings({ mcpServers: { x: { command: 'npx' } } }).length, 1);
});

test('collectDoctorReport: four sections; outside a project the Project section only points at imp init', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-empty-'));
  process.env.PI_OFFLINE = '1'; // keep the update probe off the network
  try {
    const report = await collectDoctorReport({ cwd: dir, impactusVersion: '0.0.0' });
    assert.deepEqual(
      report.sections.map((s) => s.title),
      ['Engines (subscriptions)', 'Core CLIs', 'Pi & imp', 'Project'],
    );
    const project = report.sections.at(-1);
    assert.equal(project.rows.length, 1);
    assert.equal(project.rows[0].level, 'info');
    assert.match(project.rows[0].msg, /imp init/);
    // Engines are informative — a bare machine must never produce an error there.
    for (const row of report.sections[0].rows) assert.notEqual(row.level, 'error');
  } finally {
    delete process.env.PI_OFFLINE;
  }
});

test('collectDoctorReport: inside a project it audits the FIA runtime and .mcp.json hygiene', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-project-'));
  mkdirSync(join(dir, 'ai-docs'));
  mkdirSync(join(dir, 'imp', 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'imp', 'scripts', 'fia-tui.mjs'), '// stub');
  writeFileSync(join(dir, 'imp', 'fia.config.yaml'), 'agents: {}\n');
  writeFileSync(
    join(dir, '.mcp.json'),
    JSON.stringify({ mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp@latest'] } } }),
  );
  process.env.PI_OFFLINE = '1';
  try {
    const report = await collectDoctorReport({ cwd: dir, impactusVersion: '0.0.0' });
    const rows = report.sections.at(-1).rows;
    assert.ok(rows.some((r) => r.level === 'ok' && /FIA runtime present/.test(r.msg)));
    assert.ok(rows.some((r) => r.level === 'warn' && /"playwright"/.test(r.msg)));
    // Hygiene warnings alone never fail the checkup (exit stays 0).
    assert.ok(!rows.some((r) => r.level === 'error'));
  } finally {
    delete process.env.PI_OFFLINE;
  }
});

test('collectDoctorReport: a broken .mcp.json is an error (nothing loads until it parses)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-badmcp-'));
  mkdirSync(join(dir, 'ai-docs'));
  writeFileSync(join(dir, '.mcp.json'), '{ not json');
  process.env.PI_OFFLINE = '1';
  try {
    const report = await collectDoctorReport({ cwd: dir, impactusVersion: '0.0.0' });
    const rows = report.sections.at(-1).rows;
    assert.ok(rows.some((r) => r.level === 'error' && /\.mcp\.json/.test(r.msg)));
    assert.equal(report.ok, false);
  } finally {
    delete process.env.PI_OFFLINE;
  }
});
