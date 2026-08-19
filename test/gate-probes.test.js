// The gate self-test (imp/scripts/gate-probes.mjs) run against THIS repo's
// templates: every deliberate defect must be caught and every clean control
// must pass. This is the harness measuring itself — until a defect has been
// injected and caught, there is no evidence any gate can fail at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dirname, '..', 'fia-templates', 'scripts', 'gate-probes.mjs');

test('gate probes: all red probes caught, all controls green, exit 0', () => {
  const out = execFileSync(process.execPath, [SCRIPT, '--json'], { encoding: 'utf8' });
  const report = JSON.parse(out);
  assert.equal(report.healthy, true, JSON.stringify(report.results.filter((r) => !r.ok), null, 2));
  assert.equal(report.caught, report.red, 'every injected defect must go red');
  assert.equal(report.controls_ok, report.controls, 'every clean control must pass');
  assert.ok(report.red >= 10, 'the defect catalog must not silently shrink');
  assert.ok(report.controls >= 3, 'controls keep an always-red gate from passing the self-test');
});

test('gate probes: the human output carries the greppable summary marker', () => {
  const out = execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.match(out, /GATE_PROBES total=\d+ caught=\d+\/\d+ controls=\d+\/\d+/);
});
