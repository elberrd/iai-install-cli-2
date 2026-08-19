import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  accessSync,
  appendFileSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import Database from 'better-sqlite3';
import {
  collectRunEvidence,
  collectWindowEvidence,
  parseSince,
  redactText,
  resolveEvolutionPaths,
  runCli,
} from '../fia-templates/scripts/evolution-evidence.mjs';
import { piSessionsDirFor } from '../fia-templates/scripts/pi-sessions.mjs';
import { Tracer } from '../fia-templates/modules/tracer.mjs';

const SCRIPT = join(import.meta.dirname, '..', 'fia-templates', 'scripts', 'evolution-evidence.mjs');
const PROMPT = join(import.meta.dirname, '..', 'pi-templates', '.pi', 'prompts', 'evolve.md');
const COOKBOOK = join(import.meta.dirname, '..', 'pi-templates', '.pi', 'skills', 'fia', 'cookbooks', 'evolution.md');
const NOW = '2026-08-18T15:00:00.000Z';
const SOURCE_CAP = 16 * 1024 * 1024;

function credentialUrl(scheme, user, password, host, path = '') {
  return `${scheme}://${user}:${password}@${host}${path}`;
}

const TRACE_SCHEMA = `
CREATE TABLE sessions (
  fda_id TEXT PRIMARY KEY, fda_name TEXT, request TEXT, status TEXT, engineer TEXT,
  started_at TEXT, ended_at TEXT, total_tokens INTEGER DEFAULT 0, total_cost REAL DEFAULT 0,
  outcome TEXT, outcome_reason TEXT
);
CREATE TABLE phases (
  phase_id TEXT PRIMARY KEY, fda_id TEXT, seq INTEGER, name TEXT, kind TEXT, owner TEXT,
  description TEXT, status TEXT, attempt INTEGER, error TEXT, started_at TEXT, ended_at TEXT
);
CREATE TABLE events (
  event_id TEXT PRIMARY KEY, fda_id TEXT, phase_id TEXT, parent_id TEXT, type TEXT, name TEXT,
  payload_json TEXT, tokens INTEGER, started_at TEXT, ended_at TEXT
);
CREATE TABLE envelopes (
  envelope_id TEXT PRIMARY KEY, fda_id TEXT, phase_id TEXT, agent TEXT, output_type TEXT,
  payload_json TEXT, valid INTEGER, attempt INTEGER, created_at TEXT
);
CREATE TABLE gate_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT, fda_id TEXT, phase_id TEXT, attempt INTEGER, gate TEXT,
  passed INTEGER, violations_json TEXT, checks_json TEXT, created_at TEXT
);
CREATE TABLE agent_sessions (
  fda_id TEXT, agent TEXT, coding_agent TEXT, model TEXT, session_id TEXT,
  context_tokens INTEGER, context_window INTEGER, created_at TEXT, last_used_at TEXT
);
`;

function freshRoot() {
  const root = mkdtempSync(join(tmpdir(), 'evolution-evidence-'));
  mkdirSync(join(root, 'imp', 'data', 'sessions'), { recursive: true });
  writeFileSync(
    join(root, 'imp', 'fia.config.yaml'),
    'defaults:\n  data_dir: imp/data\nobservability:\n  db: imp/data/fia.db\n',
  );
  return root;
}

function collectorEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of ['FIA_CONFIG', 'FIA_DB', 'FIA_TELEMETRY_DIR', 'PI_SESSIONS_DIR']) delete env[key];
  return { ...env, ...overrides };
}

function executableOnPath(name) {
  for (const directory of String(process.env.PATH || '').split(delimiter)) {
    const candidate = join(directory, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      /* keep searching the inherited PATH */
    }
  }
  throw new Error(`${name} is not executable on PATH`);
}

function openTrace(root, schema = TRACE_SCHEMA) {
  const db = new Database(join(root, 'imp', 'data', 'fia.db'));
  db.exec(schema);
  return db;
}

function sparseFile(path, size, prefix = '') {
  writeFileSync(path, prefix);
  const fd = openSync(path, 'r+');
  try {
    ftruncateSync(fd, size);
  } finally {
    closeSync(fd);
  }
}

function gitCommit(root) {
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Evolution Test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'evolution@example.test'], { cwd: root });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'feature.js'), 'export const delivered = true;\n');
  execFileSync('git', ['add', 'src/feature.js'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'deliver traced change'], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2026-08-18T14:04:00Z',
      GIT_COMMITTER_DATE: '2026-08-18T14:04:00Z',
    },
  });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

function seedCompleteRun(root, id = 'run_complete') {
  const sha = gitCommit(root);
  const db = openTrace(root);
  db.prepare(`INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    'fda_quick',
    'Implement the bounded change',
    'success',
    'engineer',
    '2026-08-18T14:00:00.000Z',
    '2026-08-18T14:10:00.000Z',
    1200,
    0.12,
    'goal_met',
    'acceptance passed',
  );
  db.prepare(`INSERT INTO phases VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'ph_plan',
    id,
    1,
    'plan',
    'agent',
    'planner',
    'plan the work',
    'success',
    0,
    null,
    '2026-08-18T14:00:00.000Z',
    '2026-08-18T14:01:00.000Z',
  );
  db.prepare(`INSERT INTO phases VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'ph_commit',
    id,
    2,
    'commit_code',
    'code',
    'git',
    'commit the work',
    'success',
    0,
    null,
    '2026-08-18T14:03:00.000Z',
    '2026-08-18T14:05:00.000Z',
  );
  const insertEvent = db.prepare(`INSERT INTO events VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?)`);
  insertEvent.run('evt_phase', id, 'ph_plan', 'phase_start', 'plan', '{}', null, '2026-08-18T14:00:00.000Z', null);
  insertEvent.run(
    'evt_attempt_1',
    id,
    'ph_plan',
    'run_end',
    'verification_failed',
    JSON.stringify({ outcome: 'verification_failed', reason: 'first verification failed', accepted: false }),
    null,
    '2026-08-18T14:02:00.000Z',
    null,
  );
  insertEvent.run(
    'evt_commit',
    id,
    'ph_commit',
    'log',
    'commit',
    JSON.stringify({ sha, files: 1 }),
    null,
    '2026-08-18T14:05:00.000Z',
    null,
  );
  insertEvent.run(
    'evt_tool',
    id,
    'ph_commit',
    'tool_call',
    'bash: npm test',
    JSON.stringify({ ok: true, authorization: 'Bearer should-never-leak' }),
    20,
    '2026-08-18T14:06:00.000Z',
    '2026-08-18T14:06:10.000Z',
  );
  insertEvent.run(
    'evt_attempt_2',
    id,
    'ph_commit',
    'run_end',
    'goal_met',
    JSON.stringify({ outcome: 'goal_met', reason: 'acceptance passed', accepted: true }),
    null,
    '2026-08-18T14:10:00.000Z',
    null,
  );
  db.prepare(`INSERT INTO envelopes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'env_plan',
    id,
    'ph_plan',
    'planner',
    'PlanOutput',
    JSON.stringify({
      summary: 'one-file plan',
      changed_files: ['src/feature.js'],
      api_key: 'do-not-leak',
      nested: {
        refreshToken: 'refresh-must-not-leak',
        clientSecret: 'client-must-not-leak',
        sessionCookie: 'cookie-must-not-leak',
        'client-secret': 'hyphen-client-must-not-leak',
        'api-key': 'hyphen-api-must-not-leak',
        'x-api-key': 'hyphen-x-api-must-not-leak',
        'set-cookie': 'hyphen-cookie-must-not-leak',
        credentials: 'plural-credentials-must-not-leak',
        secrets: 'plural-secrets-must-not-leak',
        tokens: 'plural-tokens-must-not-leak',
        tokensIn: 123,
        tokensOut: 456,
        total_tokens: 789,
      },
      databaseUrl: credentialUrl('postgres', 'trace-user', 'trace-pass', 'trace-db.test:5432', '/private'),
      docsUrl: 'https://docs.test/private?token=trace-token',
    }),
    1,
    1,
    '2026-08-18T14:01:00.000Z',
  );
  db.prepare(
    `INSERT INTO gate_results (fda_id, phase_id, attempt, gate, passed, violations_json, checks_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    'ph_commit',
    1,
    'quality',
    1,
    '[]',
    JSON.stringify([{ name: 'test', passed: true }]),
    '2026-08-18T14:09:00.000Z',
  );
  db.prepare(`INSERT INTO agent_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    'planner',
    'pi',
    'test/model',
    'pi-session-id',
    1000,
    10000,
    '2026-08-18T14:00:00.000Z',
    '2026-08-18T14:01:00.000Z',
  );
  db.close();

  const sessionDir = join(root, 'imp', 'data', 'sessions', id);
  mkdirSync(join(sessionDir, 'phase_results'), { recursive: true });
  mkdirSync(join(sessionDir, 'context_handoff'), { recursive: true });
  mkdirSync(join(sessionDir, 'planner', 'prompts'), { recursive: true });
  writeFileSync(join(root, 'brief.md'), '# Brief\n- [x] verified outcome\n');
  writeFileSync(join(sessionDir, 'brief_path'), join(root, 'brief.md'));
  writeFileSync(join(sessionDir, 'baseline.json'), JSON.stringify({ 'preexisting.txt': '1,abc' }));
  writeFileSync(join(sessionDir, 'agent_map.json'), JSON.stringify({ planner: { session_id: 'pi-session-id' } }));
  writeFileSync(
    join(sessionDir, 'phase_results', 'plan.json'),
    JSON.stringify({ status: 'success', summary: 'planned' }),
  );
  writeFileSync(join(sessionDir, 'context_handoff', 'plan.md'), 'The plan is bounded.');
  writeFileSync(join(sessionDir, 'planner', 'prompts', 'system.md'), 'Use Bearer extremely-secret-token-value');
  writeFileSync(join(sessionDir, 'planner', 'raw_output.jsonl'), 'DO_NOT_INCLUDE_RAW_TRANSCRIPT_CONTENT');
  writeFileSync(
    join(sessionDir, 'planner', 'engine_error.json'),
    JSON.stringify({ agent: 'planner', fda_id: id, coding_agent: 'pi', model: 'test/model', kind: 'crash' }),
  );
  writeFileSync(
    join(sessionDir, 'run_verdict.json'),
    JSON.stringify({ fda_id: id, outcome: 'goal_met', missing: [], redo: [], note: 'closed cleanly' }),
  );
  return { id, sha };
}

test('parseSince accepts bounded durations and real UTC dates', () => {
  assert.deepEqual(parseSince('2d', NOW), {
    raw: '2d',
    kind: 'duration',
    since: '2026-08-16T15:00:00.000Z',
    until: NOW,
  });
  assert.equal(parseSince('2026-08-01', NOW).since, '2026-08-01T00:00:00.000Z');
  assert.throws(() => parseSince('0d', NOW), /between 1d/);
  assert.throws(() => parseSince('2026-02-30', NOW), /real calendar date/);
  assert.throws(() => parseSince('2027-01-01', NOW), /future/);
  assert.throws(() => parseSince('last week', NOW), /must be Nd/);
});

test('path resolution confines stores to --dir and only allows the derived default Pi store outside it', () => {
  const root = freshRoot();
  const outside = mkdtempSync(join(tmpdir(), 'evolution-path-outside-'));
  const configPath = join(root, 'imp', 'fia.config.yaml');
  const validConfig = 'defaults:\n  data_dir: imp/data\nobservability:\n  db: imp/data/fia.db\n';
  writeFileSync(join(outside, 'config.yaml'), validConfig);

  const defaults = resolveEvolutionPaths(root, collectorEnv());
  assert.equal(defaults.piDir, piSessionsDirFor(root));
  assert.equal(
    resolveEvolutionPaths(root, collectorEnv({ PI_SESSIONS_DIR: piSessionsDirFor(root) })).piDir,
    piSessionsDirFor(root),
  );
  assert.throws(
    () => resolveEvolutionPaths(root, collectorEnv({ FIA_CONFIG: join(outside, 'config.yaml') })),
    /config path escapes --dir/,
  );

  writeFileSync(configPath, `defaults:\n  data_dir: ${outside}\n`);
  assert.throws(() => resolveEvolutionPaths(root, collectorEnv()), /data path escapes --dir/);
  writeFileSync(configPath, validConfig);
  assert.throws(
    () => resolveEvolutionPaths(root, collectorEnv({ FIA_DB: join(outside, 'fia.db') })),
    /database path escapes --dir/,
  );
  assert.throws(
    () => resolveEvolutionPaths(root, collectorEnv({ FIA_TELEMETRY_DIR: outside })),
    /telemetry path escapes --dir/,
  );
  assert.throws(
    () => resolveEvolutionPaths(root, collectorEnv({ PI_SESSIONS_DIR: outside })),
    /Pi sessions path escapes --dir/,
  );

  const linkedStore = join(root, 'imp', 'linked-store');
  symlinkSync(outside, linkedStore);
  writeFileSync(configPath, 'defaults:\n  data_dir: imp/linked-store\n');
  assert.throws(() => resolveEvolutionPaths(root, collectorEnv()), /data path escapes --dir/);
  writeFileSync(configPath, validConfig);
  assert.throws(
    () => resolveEvolutionPaths(root, collectorEnv({ FIA_DB: join(linkedStore, 'fia.db') })),
    /database path escapes --dir/,
  );
  assert.throws(
    () => resolveEvolutionPaths(root, collectorEnv({ FIA_TELEMETRY_DIR: linkedStore })),
    /telemetry path escapes --dir/,
  );
  assert.throws(
    () => resolveEvolutionPaths(root, collectorEnv({ PI_SESSIONS_DIR: linkedStore })),
    /Pi sessions path escapes --dir/,
  );
  symlinkSync(join(outside, 'config.yaml'), join(root, 'imp', 'linked-config.yaml'));
  assert.throws(
    () => resolveEvolutionPaths(root, collectorEnv({ FIA_CONFIG: join(root, 'imp', 'linked-config.yaml') })),
    /config path escapes --dir/,
  );
});

test('an existing invalid FIA config aborts before lock and evidence decisions', () => {
  const root = freshRoot();
  writeFileSync(join(root, 'imp', 'fia.config.yaml'), 'defaults: [unterminated');
  assert.throws(
    () => collectWindowEvidence(root, '2d', { now: NOW, env: collectorEnv() }),
    /config exists but is unreadable or invalid/,
  );
});

test('redactText removes common credentials without erasing surrounding evidence', () => {
  const fakeOpenAiKey = ['sk', 'proj', 'abcdefghijkl'].join('-');
  const fakeGitHubToken = ['github', 'pat', 'abcdefghijklmnopqrst'].join('_');
  const basicAuth = ['Authorization', 'Basic abc123'].join(': ');
  const credentialUrls = [
    credentialUrl('https', 'alice', 'hunter2', 'example.test', '/path?token=raw'),
    credentialUrl('postgres', 'alice', 'pgpass', 'postgres.test:5432', '/app'),
    credentialUrl('postgresql', 'bob', 'pgpass2', 'postgresql.test', '/db'),
    credentialUrl('mysql', 'carol', 'mysqlpass', 'mysql.test', '/app'),
    credentialUrl('mongodb', 'dave', 'mongopass', 'mongo.test', '/app'),
    credentialUrl('mongodb+srv', 'eve', 'srvpass', 'cluster.test', '/app'),
    credentialUrl('redis', '', 'redispass', 'redis.test', '/0'),
    credentialUrl('rediss', 'frank', 'redisspass', 'rediss.test', '/1'),
    credentialUrl('amqp', 'grace', 'mqpass', 'mq.test', '/vhost'),
    credentialUrl('amqps', 'heidi', 'mqspass', 'mqs.test', '/vhost'),
  ].join(' ');
  const databaseUrl = credentialUrl('postgres', 'ian', 'keypass', 'db.test:5432', '/private');
  const redacted = redactText(
    `Bearer abc.def api_key=supersecret ${fakeOpenAiKey} ${credentialUrls} ` +
      `eyJabcdefghijk.abcdefghijkl.abcdefghijkl OPENAI_API_KEY=plainvalue ${basicAuth}\n` +
      `${fakeGitHubToken} {"refreshToken":"raw-refresh-secret"} ` +
      `DATABASE_URL=${databaseUrl} ` +
      'docsUrl=https://docs.test/internal/path?access_token=visible src/local.js:42',
  );
  assert.match(redacted, /Bearer \[REDACTED\]/);
  assert.match(redacted, /api_key=\[REDACTED\]/);
  assert.match(redacted, /https:\/\/example\.test\/\[REDACTED\]/);
  assert.match(redacted, /postgres:\/\/postgres\.test:5432\/\[REDACTED\]/);
  assert.match(redacted, /mongodb\+srv:\/\/cluster\.test\/\[REDACTED\]/);
  assert.match(redacted, /redis:\/\/redis\.test\/\[REDACTED\]/);
  assert.match(redacted, /amqps:\/\/mqs\.test\/\[REDACTED\]/);
  assert.match(redacted, /DATABASE_URL=postgres:\/\/db\.test:5432\/\[REDACTED\]/);
  assert.match(redacted, /docsUrl=https:\/\/docs\.test\/\[REDACTED\]/);
  assert.match(redacted, /src\/local\.js:42/);
  assert.match(redacted, /\[REDACTED_JWT\]/);
  assert.doesNotMatch(
    redacted,
    /supersecret|hunter2|token=raw|pgpass|pgpass2|mysqlpass|mongopass|srvpass|redispass|redisspass|mqpass|mqspass|keypass|internal\/path|access_token=visible|plainvalue|Basic abc123|raw-refresh-secret/,
  );
  assert.ok(!redacted.includes(fakeOpenAiKey));
  assert.ok(!redacted.includes(fakeGitHubToken));
});

test('redactText catches secret key segments, quoted assignments, flags and complete cookie headers', () => {
  const redacted = redactText(
    [
      'AWS_SECRET_ACCESS_KEY=aws-middle-marker',
      'AWS_SECRET_ACCESS_KEY="aws quoted value"',
      '"JWT_SECRET_KEY": "jwt-colon-value"',
      "clientSecretValue='camel-secret-value'",
      'credentials=plural-credentials-value',
      'secrets: plural-secrets-value',
      'tokens=plural-tokens-value',
      'TOKEN=single-token-value',
      '--token flag-token-value',
      '--token=equals-flag-token-value',
      'cookie=topsecret123',
      'Cookie: sessionid=cookie-session; csrf=cookie-csrf',
      'Set-Cookie: sid=set-cookie-session; HttpOnly; Secure',
      'Authorization: Custom auth-header-topsecret123',
      'secretary=keep-this-reasonable-non-secret',
    ].join('\n'),
  );
  assert.match(redacted, /AWS_SECRET_ACCESS_KEY=\[REDACTED\]/);
  assert.match(redacted, /AWS_SECRET_ACCESS_KEY="\[REDACTED\]"/);
  assert.match(redacted, /"JWT_SECRET_KEY": "\[REDACTED\]"/);
  assert.match(redacted, /clientSecretValue='\[REDACTED\]'/);
  assert.match(redacted, /credentials=\[REDACTED\]/);
  assert.match(redacted, /secrets: \[REDACTED\]/);
  assert.match(redacted, /tokens=\[REDACTED\]/);
  assert.match(redacted, /TOKEN=\[REDACTED\]/);
  assert.match(redacted, /--token \[REDACTED\]/);
  assert.match(redacted, /--token=\[REDACTED\]/);
  assert.match(redacted, /cookie=\[REDACTED\]/);
  assert.match(redacted, /^Cookie: \[REDACTED\]$/m);
  assert.match(redacted, /^Set-Cookie: \[REDACTED\]$/m);
  assert.match(redacted, /^Authorization: \[REDACTED\]$/m);
  assert.match(redacted, /secretary=keep-this-reasonable-non-secret/);
  assert.doesNotMatch(
    redacted,
    /aws-middle-marker|aws quoted value|jwt-colon-value|camel-secret-value|plural-credentials-value|plural-secrets-value|plural-tokens-value|single-token-value|flag-token-value|topsecret123|cookie-session|cookie-csrf|set-cookie-session|HttpOnly|Secure|auth-header-topsecret123/,
  );
});

test('reactive collector joins trace, artifacts and a trace-attributed commit without raw transcripts', () => {
  const root = freshRoot();
  const { id, sha } = seedCompleteRun(root);
  writeFileSync(join(root, 'noise.txt'), 'not part of the FDA commit trace\n');
  execFileSync('git', ['add', 'noise.txt'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'unrelated concurrent commit'], { cwd: root });
  const unrelatedSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const db = new Database(join(root, 'imp', 'data', 'fia.db'));
  db.prepare(`INSERT INTO events VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?)`).run(
    'evt_not_a_commit_phase',
    id,
    'ph_plan',
    'log',
    'plan',
    JSON.stringify({ sha: unrelatedSha, note: 'a content hash, not a commit phase result' }),
    null,
    '2026-08-18T14:07:00.000Z',
    null,
  );
  db.close();
  const largeResult = join(root, 'imp', 'data', 'sessions', id, 'phase_results', 'zz-large.json');
  writeFileSync(largeResult, JSON.stringify({ status: 'success', summary: 'x'.repeat(25_000) }));
  const evidence = collectRunEvidence(root, id, { now: NOW });

  assert.equal(evidence.schema_version, 1);
  assert.equal(evidence.mode, 'reactive');
  assert.equal(evidence.run.session.outcome, 'goal_met');
  assert.deepEqual(
    evidence.run.attempts.map((event) => event.name),
    ['verification_failed', 'goal_met'],
  );
  assert.equal(evidence.run.phases.length, 2);
  assert.equal(evidence.run.envelopes[0].payload.api_key, '[REDACTED]');
  assert.deepEqual(evidence.run.envelopes[0].payload.nested, {
    refreshToken: '[REDACTED]',
    clientSecret: '[REDACTED]',
    sessionCookie: '[REDACTED]',
    'client-secret': '[REDACTED]',
    'api-key': '[REDACTED]',
    'x-api-key': '[REDACTED]',
    'set-cookie': '[REDACTED]',
    credentials: '[REDACTED]',
    secrets: '[REDACTED]',
    tokens: '[REDACTED]',
    tokensIn: 123,
    tokensOut: 456,
    total_tokens: 789,
  });
  assert.equal(evidence.run.envelopes[0].payload.databaseUrl, 'postgres://trace-db.test:5432/[REDACTED]');
  assert.equal(evidence.run.envelopes[0].payload.docsUrl, 'https://docs.test/[REDACTED]');
  assert.equal(evidence.run.gates[0].checks[0].passed, true);
  assert.equal(evidence.run.agent_sessions[0].model, 'test/model');
  assert.equal(evidence.run.commits[0].sha, sha);
  assert.equal(evidence.run.commits.length, 1);
  assert.notEqual(evidence.run.commits[0].sha, unrelatedSha);
  assert.equal(evidence.run.commits[0].attribution, 'trace');
  assert.equal(evidence.run.commits[0].confidence, 'high');
  assert.deepEqual(
    evidence.run.commits[0].files.map((file) => file.path),
    ['src/feature.js'],
  );
  assert.equal(evidence.run.artifacts.phase_results[0].data.summary, 'planned');
  const parsedLargeResult = evidence.run.artifacts.phase_results.find((item) => item.path.endsWith('zz-large.json'));
  assert.equal(parsedLargeResult.truncated, true);
  assert.equal(parsedLargeResult.data.invalid_json, undefined);
  assert.equal(parsedLargeResult.data.summary.endsWith('…'), true);
  assert.ok(
    evidence.gaps.some(
      (gap) =>
        gap.includes('phase_results/zz-large.json.summary') && gap.includes('string length 25000 capped at 20000'),
    ),
  );
  assert.equal(evidence.run.artifacts.current_verdict.outcome, 'goal_met');
  assert.equal(evidence.run.artifacts.engine_errors.planner.kind, 'crash');
  assert.equal(evidence.run.artifacts.raw_outputs[0].bytes > 0, true);

  const serialized = JSON.stringify(evidence);
  assert.doesNotMatch(serialized, /DO_NOT_INCLUDE_RAW_TRANSCRIPT_CONTENT/);
  assert.doesNotMatch(
    serialized,
    /extremely-secret-token-value|should-never-leak|do-not-leak|refresh-must-not-leak|client-must-not-leak|cookie-must-not-leak|hyphen-client-must-not-leak|hyphen-api-must-not-leak|hyphen-x-api-must-not-leak|hyphen-cookie-must-not-leak|plural-credentials-must-not-leak|plural-secrets-must-not-leak|plural-tokens-must-not-leak|trace-user|trace-pass|trace-token/,
  );
  assert.match(serialized, /\[REDACTED\]/);
});

test('reactive collector reports contextual array, object, depth and commit-file truncation gaps', () => {
  const root = freshRoot();
  const { id } = seedCompleteRun(root, 'sanitizer_observability');
  const oversizedArray = Array.from({ length: 5001 }, () => 0);
  const oversizedObject = Object.fromEntries(
    Array.from({ length: 151 }, (_, index) => [`entry_${String(index).padStart(3, '0')}`, index]),
  );
  const tooDeep = { a: { b: { c: { d: { e: { f: { g: { hidden: true } } } } } } } };
  const payload = { oversizedArray, oversizedObject, tooDeep };

  const bulkDir = join(root, 'bulk');
  mkdirSync(bulkDir);
  for (let index = 0; index < 121; index += 1) {
    writeFileSync(join(bulkDir, `file-${String(index).padStart(3, '0')}.txt`), `${index}\n`);
  }
  execFileSync('git', ['add', 'bulk'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'many bounded files'], { cwd: root });
  const manyFilesSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  const db = new Database(join(root, 'imp', 'data', 'fia.db'));
  db.prepare('UPDATE envelopes SET payload_json=? WHERE envelope_id=?').run(JSON.stringify(payload), 'env_plan');
  db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(
    JSON.stringify({ ok: true, ...payload }),
    'evt_tool',
  );
  db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(
    JSON.stringify({ sha: manyFilesSha }),
    'evt_commit',
  );
  db.close();

  const evidence = collectRunEvidence(root, id, { now: NOW });
  const envelopePayload = evidence.run.envelopes[0].payload;
  const toolPayload = evidence.run.events.tool_samples[0].payload;
  assert.equal(envelopePayload.oversizedArray.length, 5000);
  assert.equal(Object.keys(envelopePayload.oversizedObject).length, 150);
  assert.equal(toolPayload.oversizedArray.length, 5000);
  assert.equal(Object.keys(toolPayload.oversizedObject).length, 150);
  assert.match(JSON.stringify(envelopePayload.tooDeep), /\[DEPTH_LIMIT\]/);
  assert.match(JSON.stringify(toolPayload.tooDeep), /\[DEPTH_LIMIT\]/);
  assert.equal(evidence.run.commits[0].files.length, 120);

  assert.ok(
    evidence.gaps.some(
      (gap) => gap.includes('envelopes[0].payload_json.oversizedArray') && gap.includes('capped at 5000'),
    ),
  );
  assert.ok(
    evidence.gaps.some(
      (gap) => gap.includes('envelopes[0].payload_json.oversizedObject') && gap.includes('capped at 150'),
    ),
  );
  assert.ok(evidence.gaps.some((gap) => gap.includes('events[') && gap.includes('.payload_json.oversizedArray')));
  assert.ok(evidence.gaps.some((gap) => gap.includes('sanitized with truncation: depth capped at 7')));
  assert.ok(evidence.gaps.some((gap) => gap.includes('commit ') && gap.includes('files truncated to 120 entries')));
  assert.equal(evidence.limits.max_sanitization_gap_notices, 100);
  assert.equal(JSON.stringify(evidence).length < 250_000, true);
});

test(
  'commit evidence distinguishes name-status and numstat failures while preserving available paths',
  { skip: process.platform === 'win32' && 'the fault-injection shim is a POSIX shell executable' },
  () => {
    const root = freshRoot();
    const { id } = seedCompleteRun(root, 'partial_git_show');
    const realGit = executableOnPath('git');
    const fakeBin = mkdtempSync(join(tmpdir(), 'evolution-fake-git-'));
    const fakeGit = join(fakeBin, 'git');
    writeFileSync(
      fakeGit,
      `#!/bin/sh
mode="$EVOLUTION_TEST_GIT_FAILURE"
for arg in "$@"; do
  if [ "$mode" = "numstat" ] && [ "$arg" = "--numstat" ]; then exit 70; fi
  if [ "$mode" = "name-status" ] && [ "$arg" = "--name-status" ]; then exit 71; fi
done
exec ${JSON.stringify(realGit)} "$@"
`,
    );
    chmodSync(fakeGit, 0o755);

    const originalPath = process.env.PATH;
    const originalFailure = process.env.EVOLUTION_TEST_GIT_FAILURE;
    let noCounts;
    let noPaths;
    try {
      process.env.PATH = `${fakeBin}${delimiter}${originalPath}`;
      process.env.EVOLUTION_TEST_GIT_FAILURE = 'numstat';
      noCounts = collectRunEvidence(root, id, { now: NOW });
      process.env.EVOLUTION_TEST_GIT_FAILURE = 'name-status';
      noPaths = collectRunEvidence(root, id, { now: NOW });
    } finally {
      process.env.PATH = originalPath;
      if (originalFailure === undefined) delete process.env.EVOLUTION_TEST_GIT_FAILURE;
      else process.env.EVOLUTION_TEST_GIT_FAILURE = originalFailure;
    }

    assert.deepEqual(
      noCounts.run.commits[0].files.map((file) => file.path),
      ['src/feature.js'],
    );
    assert.equal(Object.hasOwn(noCounts.run.commits[0].files[0], 'additions'), false);
    assert.ok(noCounts.gaps.some((gap) => gap.includes('git show --numstat failed')));
    assert.equal(
      noCounts.gaps.some((gap) => gap.includes('git show --name-status failed')),
      false,
    );
    assert.equal(noPaths.run.commits[0].files.length, 0);
    assert.ok(noPaths.gaps.some((gap) => gap.includes('git show --name-status failed')));
    assert.equal(
      noPaths.gaps.some((gap) => gap.includes('git show --numstat failed')),
      false,
    );
  },
);

test('trace SQL bounds oversized TEXT and BLOB cells before run and window rows reach JavaScript', () => {
  const root = freshRoot();
  const { id } = seedCompleteRun(root, 'oversized_db_cells');
  const db = new Database(join(root, 'imp', 'data', 'fia.db'));
  const tail = 'OVERSIZED_DB_TAIL_MUST_NOT_REACH_OUTPUT';
  const oversizedText = `${'x'.repeat(2 * 1024 * 1024)}${tail}`;
  db.exec('ALTER TABLE sessions ADD COLUMN plugin_blob BLOB');
  db.prepare('UPDATE sessions SET request=?, plugin_blob=zeroblob(?) WHERE fda_id=?').run(
    oversizedText,
    8 * 1024 * 1024,
    id,
  );
  db.prepare('UPDATE phases SET error=? WHERE phase_id=?').run(oversizedText, 'ph_plan');
  db.prepare('UPDATE events SET payload_json=zeroblob(?) WHERE event_id=?').run(8 * 1024 * 1024, 'evt_tool');
  db.prepare('UPDATE gate_results SET violations_json=zeroblob(?) WHERE fda_id=?').run(8 * 1024 * 1024, id);
  db.prepare(
    `INSERT INTO events
       (event_id, fda_id, phase_id, parent_id, type, name, payload_json, tokens, started_at, ended_at)
     VALUES (?, ?, ?, '', 'engine_error', 'oversized payload', zeroblob(?), NULL, ?, NULL)`,
  ).run('evt_oversized_window', id, 'ph_plan', 8 * 1024 * 1024, '2026-08-18T14:08:00.000Z');
  db.close();

  const run = collectRunEvidence(root, id, { now: NOW });
  assert.equal(run.run.session.request.length, 20_000);
  assert.equal(run.run.session.request.endsWith('…'), true);
  assert.equal(run.run.phases[0].error.length, 20_000);
  assert.equal(Object.hasOwn(run.run.session, 'plugin_blob'), false);
  assert.ok(run.gaps.some((gap) => gap.includes('sessions database cells') && gap.includes('request')));
  assert.ok(run.gaps.some((gap) => gap.includes('events database cells') && gap.includes('payload_json')));
  assert.ok(run.gaps.some((gap) => gap.includes('gate_results database cells') && gap.includes('violations_json')));

  const window = collectWindowEvidence(root, '2d', { now: NOW, env: collectorEnv() });
  assert.equal(window.window.trace.runs[0].request.length, 20_000);
  assert.equal(window.window.trace.failed_phase_examples[0].error.length, 20_000);
  assert.ok(window.gaps.some((gap) => gap.includes('window sessions database cells') && gap.includes('request')));
  assert.ok(window.gaps.some((gap) => gap.includes('window events database cells') && gap.includes('payload_json')));

  const serializedRun = JSON.stringify(run);
  const serializedWindow = JSON.stringify(window);
  assert.equal(serializedRun.length < 250_000, true);
  assert.equal(serializedWindow.length < 250_000, true);
  assert.doesNotMatch(serializedRun, new RegExp(tail));
  assert.doesNotMatch(serializedWindow, new RegExp(tail));
  assert.doesNotMatch(
    readFileSync(SCRIPT, 'utf8'),
    /SELECT\s+\*\s+FROM\s+(sessions|phases|events|envelopes|gate_results|agent_sessions)/i,
  );
});

test('new trace databases install evolution indexes and avoid a sorted event scan', () => {
  const root = freshRoot();
  const dbPath = join(root, 'imp', 'data', 'indexed-fia.db');
  const tracer = new Tracer(dbPath, join(root, 'imp', 'data', 'indexed-events.jsonl'));
  const indexes = new Set(
    tracer.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%_evolution_%'")
      .all()
      .map((row) => row.name),
  );
  for (const name of [
    'idx_sessions_evolution_window',
    'idx_phases_evolution_fda',
    'idx_events_evolution_fda',
    'idx_events_evolution_fda_type',
    'idx_envelopes_evolution_fda_created',
    'idx_gate_results_evolution_fda',
  ]) {
    assert.equal(indexes.has(name), true, `missing ${name}`);
  }
  const eventPlan = tracer.db
    .prepare('EXPLAIN QUERY PLAN SELECT 1 FROM events WHERE fda_id=? ORDER BY rowid DESC LIMIT ?')
    .all('run', 10)
    .map((row) => row.detail)
    .join('\n');
  assert.match(eventPlan, /USING (?:COVERING )?INDEX idx_events_evolution_fda(?:\s|$)/);
  assert.doesNotMatch(eventPlan, /USE TEMP B-TREE|SCAN events/i);
  for (const [sql, parameters] of [
    [
      `SELECT 1 FROM sessions
       WHERE COALESCE(ended_at, started_at) >= ? AND started_at <= ?
       ORDER BY COALESCE(ended_at, started_at) DESC, started_at DESC LIMIT ?`,
      ['2026-08-01T00:00:00.000Z', NOW, 201],
    ],
    ['SELECT 1 FROM phases WHERE fda_id=? ORDER BY seq, rowid LIMIT ?', ['run', 5001]],
    ['SELECT 1 FROM gate_results WHERE fda_id=? ORDER BY id LIMIT ?', ['run', 5001]],
    [
      `SELECT 1 FROM events WHERE fda_id=?
       AND type IN ('engine_fallback','engine_relay','engine_error','engine_continuation','bounded_continuation')
       ORDER BY type, name, rowid LIMIT ?`,
      ['run', 5001],
    ],
  ]) {
    const plan = tracer.db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...parameters)
      .map((row) => row.detail)
      .join('\n');
    assert.doesNotMatch(plan, /USE TEMP B-TREE|\bSCAN\s+(sessions|phases|gate_results|events)\b/i);
  }
  tracer.db.close();
});

test('indexed proactive queries apply the global row limit without a scan/sort gap', () => {
  const root = freshRoot();
  const tracer = new Tracer(
    join(root, 'imp', 'data', 'fia.db'),
    join(root, 'imp', 'data', 'sessions', 'indexed-window', 'events.jsonl'),
  );
  const insertSession = tracer.db.prepare(
    `INSERT INTO sessions
       (fda_id, fda_name, request, status, engineer, started_at, ended_at, outcome)
     VALUES (?, 'indexed', 'request', 'fail', 'engineer', ?, ?, 'blocked_by_gate')`,
  );
  insertSession.run('indexed_a', '2026-08-18T12:00:00.000Z', '2026-08-18T12:10:00.000Z');
  insertSession.run('indexed_b', '2026-08-18T11:00:00.000Z', '2026-08-18T11:10:00.000Z');
  const insertPhase = tracer.db.prepare(
    `INSERT INTO phases
       (phase_id, fda_id, seq, name, status, error, started_at, ended_at)
     VALUES (?, 'indexed_a', ?, 'quality', 'fail', 'bounded failure', ?, ?)`,
  );
  tracer.db.transaction(() => {
    for (let index = 0; index < 6000; index += 1) {
      insertPhase.run(`indexed_phase_${index}`, index, '2026-08-18T12:01:00.000Z', '2026-08-18T12:02:00.000Z');
    }
  })();
  tracer.db.close();

  const evidence = collectWindowEvidence(root, '2d', { now: NOW, env: collectorEnv() });
  assert.equal(evidence.window.trace.runs.length, 2);
  assert.deepEqual(evidence.window.trace.failed_phases[0], {
    name: 'quality',
    count: 5000,
    distinct_runs: 1,
  });
  assert.ok(evidence.gaps.some((gap) => gap.includes('window phases truncated to 5000 rows')));
  assert.equal(
    evidence.gaps.some((gap) => gap.includes('scan/sort-prone')),
    false,
  );
});

test('large legacy tables without suitable indexes are skipped before scan or sort', () => {
  const root = freshRoot();
  const db = openTrace(root);
  const insertSession = db.prepare(
    `INSERT INTO sessions
       (fda_id, fda_name, request, status, engineer, started_at, ended_at, outcome)
     VALUES (?, 'legacy', 'bounded request', 'success', 'engineer', ?, ?, 'goal_met')`,
  );
  const insertPhase = db.prepare(
    `INSERT INTO phases
       (rowid, phase_id, fda_id, seq, name, status, started_at, ended_at)
     VALUES (?, ?, 'legacy_target', ?, 'quality', 'success', ?, ?)`,
  );
  db.transaction(() => {
    for (let index = 0; index < 10_001; index += 1) {
      const target = index === 0;
      insertSession.run(
        target ? 'legacy_target' : `old_${index}`,
        target ? '2026-08-18T13:00:00.000Z' : '2020-01-01T00:00:00.000Z',
        target ? '2026-08-18T13:01:00.000Z' : '2020-01-01T00:01:00.000Z',
      );
      insertPhase.run(
        -20_000 + index,
        `legacy_phase_${index}`,
        index,
        '2026-08-18T13:00:00.000Z',
        '2026-08-18T13:01:00.000Z',
      );
    }
  })();
  db.exec('CREATE INDEX legacy_phases_partial_order ON phases(fda_id, seq DESC)');
  const partialOrderPlan = db
    .prepare('EXPLAIN QUERY PLAN SELECT 1 FROM phases WHERE fda_id=? ORDER BY seq, rowid LIMIT ?')
    .all('legacy_target', 5001)
    .map((row) => row.detail)
    .join('\n');
  assert.match(partialOrderPlan, /USE TEMP B-TREE FOR LAST TERM OF ORDER BY/i);
  db.close();

  const run = collectRunEvidence(root, 'legacy_target', { now: NOW });
  assert.equal(run.run.session.fda_id, 'legacy_target');
  assert.equal(run.run.phases.length, 0);
  assert.ok(
    run.gaps.some(
      (gap) =>
        gap.includes('phases skipped: scan/sort-prone legacy phases table rowid span 10001') &&
        gap.includes('exceeds 10000'),
    ),
  );

  const window = collectWindowEvidence(root, '2d', { now: NOW, env: collectorEnv() });
  assert.equal(window.window.trace.runs.length, 0);
  assert.ok(
    window.gaps.some(
      (gap) =>
        gap.includes('window sessions skipped: scan/sort-prone legacy sessions table') && gap.includes('exceeds 10000'),
    ),
  );
});

test('reactive artifacts never read .env* content and bound the brief_path marker', () => {
  const root = freshRoot();
  const { id } = seedCompleteRun(root, 'dotenv_artifacts');
  const sessionDir = join(root, 'imp', 'data', 'sessions', id);
  const secret = 'DOTENV_CONTENT_MUST_NEVER_LEAK';
  writeFileSync(
    join(root, '.env'),
    `DATABASE_URL=${credentialUrl('postgres', 'user', secret, 'db.test', '/private')}\n`,
  );
  writeFileSync(join(sessionDir, 'brief_path'), join(root, '.env'));
  writeFileSync(join(sessionDir, 'phase_results', '.env.local'), JSON.stringify({ secret }));
  writeFileSync(join(sessionDir, 'planner', 'prompts', '.env.production'), secret);

  const evidence = collectRunEvidence(root, id, { now: NOW });
  assert.doesNotMatch(JSON.stringify(evidence), new RegExp(secret));
  assert.equal(evidence.run.artifacts.brief, null);
  assert.ok(evidence.gaps.some((gap) => gap.includes('refused .env* artifact')));
  assert.ok(evidence.gaps.some((gap) => gap.includes('phase_results/.env.local')));
  assert.ok(evidence.gaps.some((gap) => gap.includes('.env.production')));

  writeFileSync(join(sessionDir, 'brief_path'), 'x'.repeat(4097));
  const oversizedMarker = collectRunEvidence(root, id, { now: NOW });
  assert.equal(oversizedMarker.run.artifacts.brief, null);
  assert.ok(oversizedMarker.gaps.some((gap) => gap.includes('oversized brief_path marker')));
});

test('artifact discovery bounds top-level entries and recursive empty directories with observable gaps', () => {
  const entryRoot = freshRoot();
  const { id: entryId } = seedCompleteRun(entryRoot, 'artifact_entry_budget');
  const entrySession = join(entryRoot, 'imp', 'data', 'sessions', entryId);
  for (let index = 0; index < 520; index += 1) {
    mkdirSync(join(entrySession, `empty-agent-${String(index).padStart(4, '0')}`));
  }
  const entryEvidence = collectRunEvidence(entryRoot, entryId, { now: NOW });
  assert.ok(entryEvidence.gaps.some((gap) => gap.includes('artifact discovery truncated at 512 entries')));

  const directoryRoot = freshRoot();
  const { id: directoryId } = seedCompleteRun(directoryRoot, 'artifact_directory_budget');
  const handoffDir = join(directoryRoot, 'imp', 'data', 'sessions', directoryId, 'context_handoff');
  for (let index = 0; index < 140; index += 1) {
    mkdirSync(join(handoffDir, `empty-${String(index).padStart(4, '0')}`));
  }
  const directoryEvidence = collectRunEvidence(directoryRoot, directoryId, { now: NOW });
  assert.ok(directoryEvidence.gaps.some((gap) => gap.includes('or 128 directories')));
  assert.equal(JSON.stringify(entryEvidence).length < 250_000, true);
  assert.equal(JSON.stringify(directoryEvidence).length < 250_000, true);
  assert.doesNotMatch(readFileSync(SCRIPT, 'utf8'), /readdirSync/);
});

test('reactive collector tolerates an old partial schema and marks corrupt payloads as gaps', () => {
  const root = freshRoot();
  const db = openTrace(
    root,
    `CREATE TABLE sessions (fda_id TEXT PRIMARY KEY, request TEXT, status TEXT, started_at TEXT, ended_at TEXT);
     CREATE TABLE events (event_id TEXT PRIMARY KEY, fda_id TEXT, phase_id TEXT, type TEXT, name TEXT, payload_json TEXT, started_at TEXT);`,
  );
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run(
    'legacy_run',
    'old request',
    'fail',
    '2026-08-17T10:00:00.000Z',
    '2026-08-17T10:01:00.000Z',
  );
  db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'evt_bad',
    'legacy_run',
    '',
    'error',
    'legacy error',
    '{not json',
    '2026-08-17T10:00:30.000Z',
  );
  db.close();
  mkdirSync(join(root, 'imp', 'data', 'sessions', 'legacy_run'), { recursive: true });

  const evidence = collectRunEvidence(root, 'legacy_run', { now: NOW });
  assert.equal(evidence.run.session.status, 'fail');
  assert.equal(evidence.run.events.failures[0].payload.invalid_json, true);
  assert.ok(evidence.gaps.some((gap) => gap.includes('invalid JSON')));
  assert.ok(evidence.gaps.some((gap) => gap.includes('phases')));
  assert.ok(evidence.gaps.some((gap) => gap.includes('git repository unavailable')));
});

test('reactive collector falls back to the selected session events.jsonl when fia.db is absent', () => {
  const root = freshRoot();
  const id = 'jsonl_only';
  const sessionDir = join(root, 'imp', 'data', 'sessions', id);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, 'events.jsonl'),
    [
      JSON.stringify({
        event_id: 'one',
        fda_id: id,
        ts: '2026-08-18T10:00:00.000Z',
        type: 'log',
        name: 'request',
        payload: { input: 'fallback request' },
      }),
      JSON.stringify({
        event_id: 'two',
        fda_id: id,
        ts: '2026-08-18T10:02:00.000Z',
        type: 'run_end',
        name: 'blocked_by_gate',
        payload: { outcome: 'blocked_by_gate', reason: 'quality', accepted: false },
      }),
    ].join('\n'),
  );

  const evidence = collectRunEvidence(root, id, { now: NOW });
  assert.equal(evidence.sources.db.available, false);
  assert.equal(evidence.sources.events_jsonl.available, true);
  assert.equal(evidence.run.session.source, 'events_jsonl');
  assert.equal(evidence.run.session.request, 'fallback request');
  assert.equal(evidence.run.session.outcome, 'blocked_by_gate');
  assert.equal(evidence.run.attempts.length, 1);
});

test('fallback JSONL scans only a bounded physical-line tail and aggregates invalid lines', () => {
  const root = freshRoot();
  const id = 'million_line_tail';
  const sessionDir = join(root, 'imp', 'data', 'sessions', id);
  mkdirSync(sessionDir, { recursive: true });
  const validEnd = JSON.stringify({
    event_id: 'bounded_end',
    fda_id: id,
    ts: '2026-08-18T10:00:00.000Z',
    type: 'run_end',
    name: 'goal_met',
    payload: { outcome: 'goal_met', accepted: true },
  });
  writeFileSync(join(sessionDir, 'events.jsonl'), `${'x\n'.repeat(1_000_000)}${validEnd}\n`);

  const evidence = collectRunEvidence(root, id, { now: NOW });
  assert.equal(evidence.run.session.outcome, 'goal_met');
  assert.ok(evidence.gaps.some((gap) => gap.includes('last 5000 physical lines')));
  assert.equal(evidence.gaps.filter((gap) => gap.includes('invalid JSONL line')).length, 1);
  assert.ok(evidence.gaps.some((gap) => gap.includes('4999 invalid JSONL line(s)')));
  assert.equal(JSON.stringify(evidence).length < 250_000, true);
});

test('evidence gap overflow keeps an explicit marker inside the output cap', () => {
  const root = freshRoot();
  const id = 'bounded_gap_output';
  const db = openTrace(root);
  db.prepare(`INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    'fda_test',
    'bounded gaps',
    'success',
    'engineer',
    '2026-08-18T10:00:00.000Z',
    '2026-08-18T10:01:00.000Z',
    0,
    0,
    'goal_met',
    'done',
  );
  const insertEnvelope = db.prepare(`INSERT INTO envelopes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (let index = 0; index < 5001; index += 1) {
      insertEnvelope.run(
        `invalid_${index}`,
        id,
        '',
        'tester',
        'InvalidOutput',
        '{invalid',
        0,
        1,
        `2026-08-18T10:00:${String(index % 60).padStart(2, '0')}.000Z`,
      );
    }
  })();
  db.close();
  const sessionDir = join(root, 'imp', 'data', 'sessions', id);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, 'events.jsonl'),
    `${'bad\n'.repeat(6000)}${JSON.stringify({
      event_id: 'end',
      fda_id: id,
      ts: '2026-08-18T10:01:00.000Z',
      type: 'run_end',
      name: 'goal_met',
      payload: { outcome: 'goal_met', accepted: true },
    })}\n`,
  );

  const evidence = collectRunEvidence(root, id, { now: NOW });
  assert.equal(evidence.gaps.length, 5000);
  assert.match(evidence.gaps.at(-1), /^additional evidence gaps omitted by the 5000-item cap:/);
  assert.equal(evidence.run.session.outcome, 'goal_met');
});

test('reactive collector rejects unsafe, unknown and live-run targets', async () => {
  const root = freshRoot();
  assert.throws(() => collectRunEvidence(root, '../escape', { now: NOW }), /invalid --run/);
  assert.throws(() => collectRunEvidence(root, 'missing', { now: NOW }), /unknown FIA run/);

  const lockPath = join(root, 'imp', 'data', '.fda.lock');
  writeFileSync(lockPath, '{"pid":');
  assert.throws(() => collectRunEvidence(root, 'missing', { now: NOW }), /lock exists but is unreadable or invalid/);
  writeFileSync(lockPath, '{}');
  assert.throws(() => collectRunEvidence(root, 'missing', { now: NOW }), /lock exists but is unreadable or invalid/);
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, fda_id: 'same_process' }));
  assert.throws(() => collectRunEvidence(root, 'same_process', { now: NOW }), /is active/);

  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    writeFileSync(lockPath, JSON.stringify({ pid: holder.pid, fda_id: 'active_run', started_at: NOW }));
    assert.throws(() => collectRunEvidence(root, 'active_run', { now: NOW }), /is active/);
  } finally {
    holder.kill('SIGTERM');
  }
});

test('session JSONL fallback refuses a symlink that escapes the project', () => {
  const root = freshRoot();
  const outside = mkdtempSync(join(tmpdir(), 'evolution-outside-'));
  writeFileSync(
    join(outside, 'events.jsonl'),
    JSON.stringify({
      fda_id: 'linked_session',
      type: 'log',
      name: 'request',
      payload: { input: 'OUTSIDE_SESSION_SECRET' },
    }),
  );
  symlinkSync(outside, join(root, 'imp', 'data', 'sessions', 'linked_session'));

  const evidence = collectRunEvidence(root, 'linked_session', { now: NOW });
  assert.equal(evidence.run.session, null);
  assert.ok(evidence.gaps.some((gap) => gap.includes('unsafe session directory')));
  assert.doesNotMatch(JSON.stringify(evidence), /OUTSIDE_SESSION_SECRET/);
});

test('proactive collector aggregates FIA, command and Pi evidence while excluding assistant text', () => {
  const root = freshRoot();
  const db = openTrace(root);
  const insertSession = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const [index, outcome] of ['blocked_by_gate', 'goal_met'].entries()) {
    insertSession.run(
      `window_${index}`,
      'fda_test',
      `request ${index}`,
      outcome === 'goal_met' ? 'success' : 'fail',
      'engineer',
      `2026-08-17T1${index}:00:00.000Z`,
      `2026-08-17T1${index}:10:00.000Z`,
      100,
      0.01,
      outcome,
      outcome,
    );
    db.prepare(`INSERT INTO phases VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      `window_phase_${index}`,
      `window_${index}`,
      1,
      'quality',
      'code',
      'quality',
      'check',
      'fail',
      0,
      'test failed',
      `2026-08-17T1${index}:01:00.000Z`,
      `2026-08-17T1${index}:02:00.000Z`,
    );
    db.prepare(
      `INSERT INTO gate_results (fda_id, phase_id, attempt, gate, passed, violations_json, checks_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `window_${index}`,
      `window_phase_${index}`,
      1,
      'quality',
      0,
      JSON.stringify(['test failed']),
      JSON.stringify([]),
      `2026-08-17T1${index}:03:00.000Z`,
    );
  }
  db.prepare(
    `INSERT INTO gate_results (fda_id, phase_id, attempt, gate, passed, violations_json, checks_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'window_0',
    'window_phase_0',
    2,
    'quality',
    0,
    JSON.stringify(['same run failed again']),
    JSON.stringify([]),
    '2026-08-17T10:03:30.000Z',
  );
  db.prepare(`INSERT INTO events VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?)`).run(
    'window_event',
    'window_0',
    'window_phase_0',
    'engine_relay',
    'builder',
    JSON.stringify({ from: 'one', to: 'two' }),
    null,
    '2026-08-17T10:04:00.000Z',
    null,
  );
  db.prepare(`INSERT INTO events VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?)`).run(
    'window_continuation',
    'window_0',
    '',
    'log',
    'bounded_continuation',
    JSON.stringify({ missing: ['one bounded item'], redo: ['quality'] }),
    null,
    '2026-08-17T10:05:00.000Z',
    null,
  );
  db.close();

  const telemetryDir = join(root, 'imp', 'data', 'telemetry');
  mkdirSync(telemetryDir, { recursive: true });
  writeFileSync(
    join(telemetryDir, 'commands.ndjson'),
    [
      JSON.stringify({
        type: 'command_start',
        command_id: 'cmd_1',
        command: 'bug',
        args: 'api_key=hidden-value',
        session_id: 'pi_1',
        started_at: '2026-08-17T12:00:00.000Z',
      }),
      JSON.stringify({ type: 'doc_written', command_id: 'cmd_1', path: 'ai-docs/bugs/one.md' }),
      JSON.stringify({
        type: 'command_end',
        command_id: 'cmd_1',
        command: 'bug',
        ended_at: '2026-08-17T12:05:00.000Z',
        tokens_in: 10,
        tokens_out: 20,
      }),
      JSON.stringify({
        type: 'command_start',
        command_id: 'cmd_2',
        command: 'bug',
        args: 'retry',
        session_id: 'pi_1',
        started_at: '2026-08-17T12:06:00.000Z',
      }),
      JSON.stringify({
        type: 'command_end',
        command_id: 'cmd_2',
        command: 'bug',
        ended_at: '2026-08-17T12:07:00.000Z',
      }),
    ].join('\n'),
  );

  const piDir = join(root, 'pi-sessions');
  mkdirSync(piDir, { recursive: true });
  writeFileSync(
    join(piDir, 'pi_1.jsonl'),
    [
      JSON.stringify({ type: 'session', timestamp: '2026-08-17T13:00:00.000Z', cwd: root }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-08-17T13:01:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Please retry; password=hunter2' }] },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-08-17T13:02:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'ASSISTANT_PRIVATE_REASONING' },
            { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { cmd: 'npm test' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-08-17T13:03:00.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call_1',
          toolName: 'bash',
          isError: true,
          content: [{ type: 'text', text: 'test failed' }],
        },
      }),
      JSON.stringify({ type: 'session_end', timestamp: '2026-08-17T13:04:00.000Z' }),
    ].join('\n'),
  );

  const evidence = collectWindowEvidence(root, '2d', {
    now: NOW,
    env: { ...process.env, PI_SESSIONS_DIR: piDir },
  });
  assert.equal(evidence.mode, 'proactive');
  assert.equal(evidence.window.trace.runs.length, 2);
  assert.deepEqual(evidence.window.trace.failed_phases[0], { name: 'quality', count: 2, distinct_runs: 2 });
  assert.deepEqual(evidence.window.trace.gate_failures[0], { name: 'quality', count: 3, distinct_runs: 2 });
  assert.equal(evidence.window.trace.continuations[0].name, 'bounded_continuation');
  assert.deepEqual(evidence.window.commands.command_counts[0], { name: 'bug', count: 2, distinct_sessions: 1 });
  assert.deepEqual(evidence.window.pi.tool_counts[0], { name: 'bash', count: 1, distinct_sessions: 1 });
  assert.equal(evidence.window.pi.assistant_messages_included, false);

  const serialized = JSON.stringify(evidence);
  assert.doesNotMatch(serialized, /ASSISTANT_PRIVATE_REASONING|hunter2|hidden-value/);
  assert.match(serialized, /Please retry; password=\[REDACTED\]/);
});

test('proactive collector ignores Pi sessions whose cwd does not resolve to the selected project', () => {
  const root = freshRoot();
  const outside = mkdtempSync(join(tmpdir(), 'evolution-pi-cwd-outside-'));
  const piDir = join(root, 'pi-sessions');
  mkdirSync(piDir, { recursive: true });
  writeFileSync(
    join(piDir, 'wrong-project.jsonl'),
    [
      JSON.stringify({ type: 'session', timestamp: '2026-08-17T13:00:00.000Z', cwd: outside }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-08-17T13:01:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'WRONG_PROJECT_CONTENT_MUST_NOT_LEAK' }] },
      }),
    ].join('\n'),
  );

  const evidence = collectWindowEvidence(root, '2d', {
    now: NOW,
    env: collectorEnv({ PI_SESSIONS_DIR: piDir }),
  });
  assert.equal(evidence.window.pi.sessions.length, 0);
  assert.ok(evidence.gaps.some((gap) => gap.includes('has no matching project cwd')));
  assert.doesNotMatch(JSON.stringify(evidence), /WRONG_PROJECT_CONTENT_MUST_NOT_LEAK/);
});

test('Pi collection enforces global byte and source-event budgets across sessions', () => {
  const byteRoot = freshRoot();
  const bytePiDir = join(byteRoot, 'pi-sessions');
  mkdirSync(bytePiDir, { recursive: true });
  const sessionPrefix = `${JSON.stringify({
    type: 'session',
    timestamp: '2026-08-17T13:00:00.000Z',
    cwd: byteRoot,
  })}\n`;
  sparseFile(join(bytePiDir, 'one.jsonl'), 9 * 1024 * 1024, sessionPrefix);
  sparseFile(join(bytePiDir, 'two.jsonl'), 9 * 1024 * 1024, sessionPrefix);
  const byteEvidence = collectWindowEvidence(byteRoot, '2d', {
    now: NOW,
    env: collectorEnv({ PI_SESSIONS_DIR: bytePiDir }),
  });
  assert.equal(byteEvidence.window.pi.sessions.length, 1);
  assert.equal(byteEvidence.window.pi.budget.bytes_read, 9 * 1024 * 1024);
  assert.equal(byteEvidence.window.pi.budget.max_bytes, SOURCE_CAP);
  assert.ok(byteEvidence.gaps.some((gap) => gap.includes('Pi byte budget exhausted')));

  const eventRoot = freshRoot();
  const eventPiDir = join(eventRoot, 'pi-sessions');
  mkdirSync(eventPiDir, { recursive: true });
  const lines = [JSON.stringify({ type: 'session', timestamp: '2026-08-17T13:00:00.000Z', cwd: eventRoot })];
  for (let index = 1; index < 5000; index += 1) {
    lines.push(JSON.stringify({ type: 'noop', timestamp: '2026-08-17T13:00:01.000Z', index }));
  }
  lines.push(
    JSON.stringify({
      type: 'message',
      timestamp: '2026-08-17T13:00:02.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'EVENT_OVER_BUDGET_MUST_NOT_LEAK' }] },
    }),
  );
  writeFileSync(join(eventPiDir, 'event-cap.jsonl'), lines.join('\n'));
  const eventEvidence = collectWindowEvidence(eventRoot, '2d', {
    now: NOW,
    env: collectorEnv({ PI_SESSIONS_DIR: eventPiDir }),
  });
  assert.equal(eventEvidence.window.pi.budget.source_events_read, 5000);
  assert.equal(eventEvidence.window.pi.budget.max_source_events, 5000);
  assert.ok(eventEvidence.gaps.some((gap) => gap.includes('Pi event budget exhausted')));
  assert.doesNotMatch(JSON.stringify(eventEvidence), /EVENT_OVER_BUDGET_MUST_NOT_LEAK/);
});

test('Pi session discovery stops enumerating after its global entry budget', () => {
  const root = freshRoot();
  const piDir = join(root, 'pi-sessions');
  mkdirSync(piDir, { recursive: true });
  for (let index = 0; index < 520; index += 1) {
    writeFileSync(join(piDir, `noise-${String(index).padStart(4, '0')}.txt`), 'not a Pi session');
  }
  const evidence = collectWindowEvidence(root, '2d', {
    now: NOW,
    env: collectorEnv({ PI_SESSIONS_DIR: piDir }),
  });
  assert.equal(evidence.window.pi.available, true);
  assert.equal(evidence.window.pi.sessions.length, 0);
  assert.ok(evidence.gaps.some((gap) => gap.includes('Pi session discovery truncated at 512 entries')));
});

test('proactive collector preserves more than 100 bounded records and reports missing legacy tables', () => {
  const root = freshRoot();
  const db = openTrace(
    root,
    `CREATE TABLE sessions (
       fda_id TEXT PRIMARY KEY, status TEXT, outcome TEXT, started_at TEXT, ended_at TEXT
     );`,
  );
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run(
    'legacy_window',
    'success',
    'goal_met',
    '2026-08-17T09:00:00.000Z',
    '2026-08-17T09:01:00.000Z',
  );
  db.close();
  const telemetryDir = join(root, 'imp', 'data', 'telemetry');
  mkdirSync(telemetryDir, { recursive: true });
  const lines = [];
  for (let index = 0; index < 105; index += 1) {
    lines.push(
      JSON.stringify({
        type: 'command_start',
        command_id: `many_${index}`,
        command: 'status',
        started_at: '2026-08-17T12:00:00.000Z',
      }),
      JSON.stringify({
        type: 'command_end',
        command_id: `many_${index}`,
        command: 'status',
        ended_at: '2026-08-17T12:00:01.000Z',
      }),
    );
  }
  writeFileSync(join(telemetryDir, 'commands.ndjson'), lines.join('\n'));

  const evidence = collectWindowEvidence(root, '2d', {
    now: NOW,
    env: { ...process.env, PI_SESSIONS_DIR: join(root, 'no-pi-sessions') },
  });
  assert.equal(evidence.window.commands.commands.length, 105);
  assert.equal(evidence.window.commands.totals.commands, 105);
  assert.ok(evidence.gaps.some((gap) => gap.includes('no readable phases table')));
  assert.ok(evidence.gaps.some((gap) => gap.includes('no readable gate_results table')));
  assert.ok(evidence.gaps.some((gap) => gap.includes('no readable events table')));
});

test('telemetry stays at imp/data when the FDA trace data_dir is customized', () => {
  const root = freshRoot();
  writeFileSync(
    join(root, 'imp', 'fia.config.yaml'),
    'defaults:\n  data_dir: custom/fia-data\nobservability:\n  db: custom/fia-data/fia.db\n',
  );
  const telemetryDir = join(root, 'imp', 'data', 'telemetry');
  mkdirSync(telemetryDir, { recursive: true });
  writeFileSync(
    join(telemetryDir, 'commands.ndjson'),
    [
      JSON.stringify({
        type: 'command_start',
        command_id: 'fixed_telemetry',
        command: 'status',
        started_at: '2026-08-17T12:00:00.000Z',
      }),
      JSON.stringify({
        type: 'command_end',
        command_id: 'fixed_telemetry',
        command: 'status',
        ended_at: '2026-08-17T12:01:00.000Z',
      }),
    ].join('\n'),
  );

  const evidence = collectWindowEvidence(root, '2d', {
    now: NOW,
    env: { ...process.env, PI_SESSIONS_DIR: join(root, 'no-pi-sessions') },
  });
  assert.equal(evidence.sources.command_telemetry.path, join('imp', 'data', 'telemetry'));
  assert.equal(evidence.window.commands.available, true);
  assert.equal(evidence.window.commands.commands[0].id, 'fixed_telemetry');
});

test('command telemetry parses only a bounded tail without splitting a million-line source', () => {
  const root = freshRoot();
  const telemetryDir = join(root, 'imp', 'data', 'telemetry');
  mkdirSync(telemetryDir, { recursive: true });
  const start = JSON.stringify({
    type: 'command_start',
    command_id: 'tail_command',
    command: 'status',
    session_id: 'tail_session',
    started_at: '2026-08-17T12:00:00.000Z',
  });
  const end = JSON.stringify({
    type: 'command_end',
    command_id: 'tail_command',
    command: 'status',
    ended_at: '2026-08-17T12:01:00.000Z',
  });
  writeFileSync(join(telemetryDir, 'commands.ndjson'), `${'{}\n'.repeat(1_000_000)}${start}\n${end}\n`);

  const evidence = collectWindowEvidence(root, '2d', {
    now: NOW,
    env: collectorEnv({ PI_SESSIONS_DIR: join(root, 'no-pi-sessions') }),
  });
  assert.equal(evidence.window.commands.commands[0].id, 'tail_command');
  assert.equal(evidence.window.commands.budget.source_lines_read, 5000);
  assert.equal(evidence.window.commands.budget.max_source_lines, 5000);
  assert.ok(evidence.gaps.some((gap) => gap.includes('command telemetry truncated to its last 5000 physical lines')));
  assert.equal(JSON.stringify(evidence).length < 250_000, true);
});

test('large source files are tailed, truncated or skipped before unbounded reads', () => {
  const fallbackRoot = freshRoot();
  const fallbackId = 'large_jsonl';
  const fallbackDir = join(fallbackRoot, 'imp', 'data', 'sessions', fallbackId);
  mkdirSync(fallbackDir, { recursive: true });
  const eventsPath = join(fallbackDir, 'events.jsonl');
  sparseFile(eventsPath, SOURCE_CAP + 1024);
  appendFileSync(
    eventsPath,
    `\n${JSON.stringify({
      event_id: 'bounded_tail',
      fda_id: fallbackId,
      ts: '2026-08-18T10:00:00.000Z',
      type: 'run_end',
      name: 'goal_met',
      payload: { outcome: 'goal_met', accepted: true },
    })}\n`,
  );
  const fallback = collectRunEvidence(fallbackRoot, fallbackId, { now: NOW });
  assert.equal(fallback.run.session.outcome, 'goal_met');
  assert.ok(fallback.gaps.some((gap) => gap.includes('only its bounded tail was read')));

  const sourceRoot = freshRoot();
  const telemetryDir = join(sourceRoot, 'imp', 'data', 'telemetry');
  const piDir = join(sourceRoot, 'pi-sessions');
  mkdirSync(telemetryDir, { recursive: true });
  mkdirSync(piDir, { recursive: true });
  sparseFile(join(telemetryDir, 'commands.ndjson'), SOURCE_CAP + 1);
  sparseFile(join(piDir, 'huge.jsonl'), SOURCE_CAP + 1);
  const window = collectWindowEvidence(sourceRoot, '2d', {
    now: NOW,
    env: { ...process.env, PI_SESSIONS_DIR: piDir },
  });
  assert.equal(window.window.commands.available, false);
  assert.equal(window.window.pi.sessions.length, 0);
  assert.ok(window.gaps.some((gap) => gap.includes('commands.ndjson') && gap.includes('byte cap')));
  assert.ok(window.gaps.some((gap) => gap.includes('Pi byte budget exhausted')));

  const artifactRoot = freshRoot();
  const { id } = seedCompleteRun(artifactRoot, 'large_artifacts');
  const sessionDir = join(artifactRoot, 'imp', 'data', 'sessions', id);
  const hugePrompt = join(sessionDir, 'planner', 'prompts', 'huge.md');
  const hugeJson = join(sessionDir, 'phase_results', 'zz-too-large.json');
  sparseFile(hugePrompt, SOURCE_CAP + 1, 'bounded prompt prefix');
  sparseFile(hugeJson, 2 * 1024 * 1024 + 1, '{');
  const artifacts = collectRunEvidence(artifactRoot, id, { now: NOW });
  const promptRecord = artifacts.run.artifacts.prompts.find((item) => item.path.endsWith('huge.md'));
  const jsonRecord = artifacts.run.artifacts.phase_results.find((item) => item.path.endsWith('zz-too-large.json'));
  assert.equal(promptRecord.truncated, true);
  assert.equal(promptRecord.content.length <= 20_000, true);
  assert.equal(jsonRecord.truncated, true);
  assert.equal(jsonRecord.data, null);
  assert.ok(artifacts.gaps.some((gap) => gap.includes('JSON artifact cap')));
});

test('CLI enforces exactly one target and emits machine-only JSON', () => {
  const root = freshRoot();
  const id = 'cli_jsonl';
  const sessionDir = join(root, 'imp', 'data', 'sessions', id);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, 'events.jsonl'),
    JSON.stringify({
      event_id: 'end',
      fda_id: id,
      ts: '2026-08-18T10:00:00.000Z',
      type: 'run_end',
      name: 'goal_met',
      payload: { outcome: 'goal_met', accepted: true },
    }),
  );
  assert.throws(() => runCli([], { stdout: { write() {} }, now: NOW }), /exactly one/);
  assert.throws(() => runCli(['--run', id, '--since', '1d'], { stdout: { write() {} }, now: NOW }), /exactly one/);
  assert.throws(
    () => runCli(['--run', id, '--run', 'another'], { stdout: { write() {} }, now: NOW }),
    /duplicate argument/,
  );

  const output = execFileSync(process.execPath, [SCRIPT, '--run', id, '--dir', root], { encoding: 'utf8' });
  const parsed = JSON.parse(output);
  assert.equal(parsed.target.fda_id, id);
  assert.equal(parsed.mode, 'reactive');
  assert.equal(output.trimStart().startsWith('{'), true);
});

test('prompt and cookbook pin the safety, evidence and report contracts', () => {
  const prompt = readFileSync(PROMPT, 'utf8');
  const cookbook = readFileSync(COOKBOOK, 'utf8');
  assert.match(prompt, /^---\ndescription:/);
  assert.match(prompt, /--run <fda_id> \| --since/);
  assert.match(prompt, /evolution-evidence\.mjs/);
  assert.match(prompt, /Only after it is\s+complete may you inspect a diff/);
  assert.match(prompt, /only under `imp\/reports\/evolution\/`/);
  assert.match(prompt, /no scripts, no external resources/);
  assert.match(prompt, /re-run the same `evolution-evidence\.mjs` collector target/);
  assert.match(prompt, /untrusted inert data/);
  assert.match(prompt, /Never review the current working-tree\s+diff, open any `\.env\*` path/);

  assert.match(cookbook, /deterministic code selects, bounds and redacts evidence/);
  assert.match(cookbook, /attribution: trace/);
  assert.match(cookbook, /Never edit or\ncommit `AGENTS\.md`/);
  assert.match(cookbook, /Raw agent\/Pi transcripts are deliberately\nexcluded/);
  assert.match(cookbook, /No attributable Git commit/);
  assert.match(cookbook, /single high-severity incident/);
  assert.match(cookbook, /Every proposed finding/);
  assert.match(cookbook, /do not open any `\.env\*` path or hunk/);
});
