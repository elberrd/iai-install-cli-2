// `imp doctor` — the pure .mcp.json hygiene rule and the report contract
// (four sections, read-only, exit keyed to error-level findings only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mcpNpxFindings, collectDoctorReport } from '../src/steps/doctor.js';

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A project stamped with EXACTLY the templates this package ships. */
function stampProject(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, 'ai-docs'));
  cpSync(join(PKG_ROOT, 'fia-templates'), join(dir, 'imp'), { recursive: true });
  cpSync(join(PKG_ROOT, 'pi-templates', '.pi'), join(dir, '.pi'), { recursive: true });
  return dir;
}

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
    assert.ok(rows.some((r) => r.level === 'warn' && /"playwright"/.test(r.msg)));
    assert.ok(
      !rows.some((r) => r.level === 'ok' && /FIA runtime present/.test(r.msg)),
      'an incomplete runtime is never also reported as present — that contradiction is the bug',
    );
    // This fixture has a two-file imp/ — which is exactly the state that used to
    // be reported as a healthy runtime. The runtime imports itself, so an
    // incomplete one cannot load at all: doctor must name it, and it is an
    // ERROR because nothing in the FIA works until it is repaired.
    const incomplete = rows.find((r) => r.level === 'error' && /runtime file\(s\) are missing/.test(r.msg));
    assert.ok(incomplete, 'an incomplete runtime is detected, not reported green');
    assert.match(incomplete.msg, /imp fix/, 'and it names the command that repairs it');
  } finally {
    delete process.env.PI_OFFLINE;
  }
});

test('collectDoctorReport: a COMPLETE runtime raises no incompleteness error', async () => {
  // The counterpart of the test above: with every runtime code file present,
  // doctor must stay quiet — otherwise the check is just noise on every project.
  const dir = mkdtempSync(join(tmpdir(), 'doctor-complete-'));
  mkdirSync(join(dir, 'ai-docs'));
  const { listTemplateFiles, isRuntimeCode } = await import('../src/lib/runtime-health.js');
  const files = (await listTemplateFiles()).filter(isRuntimeCode);
  assert.ok(files.length > 20, 'the templates really do ship a runtime');
  for (const rel of files) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), '// stub');
  }
  writeFileSync(join(dir, 'imp', 'fia.config.yaml'), 'agents: {}\n');
  process.env.PI_OFFLINE = '1';
  try {
    const report = await collectDoctorReport({ cwd: dir, impactusVersion: '0.0.0' });
    const rows = report.sections.at(-1).rows;
    assert.ok(!rows.some((r) => /runtime file\(s\) are missing/.test(r.msg)), 'no false alarm');
    assert.ok(rows.some((r) => r.level === 'ok' && /FIA runtime present/.test(r.msg)));
  } finally {
    delete process.env.PI_OFFLINE;
  }
});

test('collectDoctorReport: a runtime stamped from these templates is reported as current', async () => {
  const dir = stampProject('doctor-current-');
  process.env.PI_OFFLINE = '1';
  try {
    const report = await collectDoctorReport({ cwd: dir, impactusVersion: '9.9.9' });
    const rows = report.sections.at(-1).rows;
    assert.ok(
      rows.some((r) => r.level === 'ok' && /Runtime matches the impactus 9\.9\.9 templates/.test(r.msg)),
      'a runtime identical to the bundled templates is current, and doctor says so',
    );
    assert.ok(!rows.some((r) => /differ from the impactus/.test(r.msg)), 'no staleness false alarm');
  } finally {
    delete process.env.PI_OFFLINE;
  }
});

test('collectDoctorReport: runtime code behind the bundled templates is an error naming --update-runtime', async () => {
  // The silence this pins: nothing in the CLI ever told a student their runtime
  // was behind, so a project stayed on the release it was stamped with.
  const dir = stampProject('doctor-stale-');
  writeFileSync(join(dir, 'imp', 'modules', 'agents.mjs'), '// the previous release of this file\n');
  process.env.PI_OFFLINE = '1';
  try {
    const report = await collectDoctorReport({ cwd: dir, impactusVersion: '9.9.9' });
    const rows = report.sections.at(-1).rows;
    const stale = rows.find((r) => r.level === 'error' && /runtime code file\(s\) differ from the impactus/.test(r.msg));
    assert.ok(stale, 'a runtime code file behind the templates is an error, not silence');
    assert.match(stale.msg, /imp\/modules\/agents\.mjs/, 'and it names the file');
    assert.match(stale.msg, /npx impactus --update-runtime/, 'and the command that fixes it');
    assert.equal(report.ok, false);
  } finally {
    delete process.env.PI_OFFLINE;
  }
});

test('collectDoctorReport: a runtime stamped by another impactus version is named', async () => {
  const dir = stampProject('doctor-skew-');
  writeFileSync(
    join(dir, 'imp', '.runtime-manifest.json'),
    JSON.stringify({ impactus: '2.0.0-alpha.9', stamped_at: new Date().toISOString(), files: {} }),
  );
  process.env.PI_OFFLINE = '1';
  try {
    const report = await collectDoctorReport({ cwd: dir, impactusVersion: '2.0.0-alpha.14' });
    const rows = report.sections.at(-1).rows;
    const skew = rows.find((r) => /stamped by impactus 2\.0\.0-alpha\.9/.test(r.msg));
    assert.ok(skew, 'the version recorded in imp/.runtime-manifest.json is reported when it differs');
    assert.match(skew.msg, /2\.0\.0-alpha\.14/, 'next to the version actually running');
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
