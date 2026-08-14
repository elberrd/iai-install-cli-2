import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../fia-templates/modules/agents.mjs';
import { ensure } from '../fia-templates/modules/session.mjs';
import { runQuality } from '../fia-templates/modules/quality.mjs';

const CONFIG_PATH = fileURLToPath(new URL('../fia-templates/fia.config.yaml', import.meta.url));

function initGitRepo(root) {
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'fia@test.dev'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'FIA Smoke'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, 'README.md'), '# smoke\n');
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' });
}

test('loadConfig: scout is read-only (writes: [])', () => {
  const cfg = loadConfig(CONFIG_PATH);
  const scout = cfg.agents.find((a) => a.name === 'scout');
  assert.ok(scout);
  assert.deepEqual(scout.writes, []);
});

test('smoke: fda_quality code phase with trivial command succeeds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-smoke-'));
  initGitRepo(root);
  process.chdir(root);

  const cfgPath = CONFIG_PATH;
  const cfg = loadConfig(cfgPath);
  cfg.defaults.data_dir = join(root, 'imp/data');
  cfg.observability.db = join(root, 'imp/data/fia.db');

  const run = ensure(cfg, 'smoke_quality');
  await run.runPhase(
    {
      name: 'quality',
      kind: 'code',
      owner: 'quality',
      description: 'smoke',
    },
    async () => {
      const result = await runQuality(run, [
        { name: 'noop', argv: ['node', '-e', 'process.exit(0)'], timeoutSeconds: 5 },
      ]);
      assert.equal(result.passed, true);
      return result;
    },
  );
  assert.equal(run.finish({ accepted: true }), 0);
});
