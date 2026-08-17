import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Tracer } from '../fia-templates/modules/tracer.mjs';
import { Run } from '../fia-templates/modules/runner.mjs';
import { engineAdapters, execute } from '../fia-templates/modules/agents.mjs';
import { PermissionBreach } from '../fia-templates/modules/permissions.mjs';

function initGitRepo(root) {
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'fia@test.dev'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'FIA PermRetry'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, 'README.md'), '# perm-retry\n');
  writeFileSync(join(root, '.gitignore'), 'imp/\npe/\n');
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' });
}

function makeSetup() {
  const root = mkdtempSync(join(tmpdir(), 'fia-perm-retry-'));
  initGitRepo(root);
  process.chdir(root);
  const promptsDir = join(root, 'pe');
  mkdirSync(promptsDir, { recursive: true });
  writeFileSync(join(promptsDir, 'system.md'), 'You are the reviewer.');
  writeFileSync(join(promptsDir, 'user.md'), 'Task: {{prompt}}');
  const cfg = {
    defaults: { data_dir: join(root, 'imp/data') },
    observability: { db: join(root, 'imp/data/fia.db') },
    agents: [
      {
        name: 'reviewer',
        coding_agent: 'claude_code',
        model: 'sonnet',
        writes: [],
        tools: ['read'],
        prompt_engineering: { system: join(promptsDir, 'system.md'), user: join(promptsDir, 'user.md') },
      },
    ],
  };
  const tracer = new Tracer(cfg.observability.db, join(cfg.defaults.data_dir, 'sessions', 'run1', 'events.jsonl'));
  tracer.sessionStart('run1', 'Tester', 'fda_test');
  const run = new Run(cfg, 'run1', tracer, 'Tester');
  const phase = {
    phase_id: 'run1_01_ui_check',
    fda_id: 'run1',
    params: { name: 'ui_check', owner: 'reviewer', kind: 'agent' },
  };
  const call = { prompt: 'audit the UI', outputType: 'GenericOutput', gates: [] };
  return { root, run, phase, call };
}

async function withAdapters(fakes, fn) {
  const saved = { ...engineAdapters };
  Object.assign(engineAdapters, fakes);
  try {
    return await fn();
  } finally {
    Object.assign(engineAdapters, saved);
  }
}

const okResult = () => ({
  text: JSON.stringify({ status: 'success', summary: 'done' }),
  returncode: 0,
  tokens: 100,
  cost: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  session_id: 'sess-new',
});

const readEvents = (run) =>
  readFileSync(join(run.sessionDir, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

test('execute: a fully-rolled-back allowlist breach retries the phase once and succeeds', async () => {
  const { root, run, phase, call } = makeSetup();
  let calls = 0;
  let secondPrompt = '';
  await withAdapters(
    {
      claude_code: async (req) => {
        calls += 1;
        if (calls === 1) {
          writeFileSync(join(root, 'sneak.txt'), 'outside the reviewer allowlist\n');
          return okResult();
        }
        secondPrompt = req.prompt;
        return okResult();
      },
    },
    async () => {
      const envelope = await execute(run, phase, call);
      assert.equal(envelope.status, 'success');
    },
  );
  assert.equal(calls, 2, 'the phase must run a second time after the rollback');
  assert.equal(existsSync(join(root, 'sneak.txt')), false, 'the violating file stays gone');
  assert.match(secondPrompt, /## Permission retry \(automatic, once\)/);
  assert.match(secondPrompt, /sneak\.txt/);
  const events = readEvents(run);
  assert.ok(events.some((e) => e.name === 'permission_retry'));
});

test('execute: a second allowlist breach is not retried — it surfaces', async () => {
  const { root, run, phase, call } = makeSetup();
  let calls = 0;
  await withAdapters(
    {
      claude_code: async () => {
        calls += 1;
        writeFileSync(join(root, 'sneak.txt'), `outside again ${calls}\n`);
        return okResult();
      },
    },
    async () => {
      await assert.rejects(execute(run, phase, call), PermissionBreach);
    },
  );
  assert.equal(calls, 2, 'exactly one automatic retry, never a third attempt');
  assert.equal(existsSync(join(root, 'sneak.txt')), false);
});

test('execute: an unrecoverable breach is not retried', async () => {
  const { root, run, phase, call } = makeSetup();
  writeFileSync(join(root, '.env.local'), 'SECRET=original\n');
  let calls = 0;
  await withAdapters(
    {
      claude_code: async () => {
        calls += 1;
        writeFileSync(join(root, '.env.local'), 'SECRET=rewritten-by-the-agent-xxxx\n');
        return okResult();
      },
    },
    async () => {
      await assert.rejects(
        execute(run, phase, call),
        (err) => err instanceof PermissionBreach && /NOT restorable/.test(err.message),
      );
    },
  );
  assert.equal(calls, 1, 'unrecoverable must fail immediately — retrying risks more of the only copy');
  assert.equal(readFileSync(join(root, '.env.local'), 'utf8'), 'SECRET=rewritten-by-the-agent-xxxx\n');
});
