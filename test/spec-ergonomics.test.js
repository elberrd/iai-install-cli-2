import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { specHasDiagram, checkSpecDiagram } from '../fia-templates/modules/gates.mjs';
import { parseSpec, readPlanSpecs } from '../fia-templates/scripts/plan-docs.mjs';
import { DECISIONS_DIR } from '../fia-templates/scripts/decision-log.mjs';

const DECISION_LOG = join(import.meta.dirname, '..', 'fia-templates', 'scripts', 'decision-log.mjs');
const NOW = { IAI_DECISION_LOG_NOW: '2026-08-17T09:05:00' };

function cli(root, args, env = {}) {
  return execFileSync(process.execPath, [DECISION_LOG, ...args, '--dir', root], {
    encoding: 'utf8',
    env: { ...process.env, ...NOW, ...env },
  }).trim();
}

function freshRoot(prefix) {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

/** A spec whose Flow section carries a real mermaid diagram. */
function specWithDiagram(title) {
  return [
    `# Spec 0003 — ${title}`,
    '',
    'Status: defined',
    'Created: 2026-08-16 · Updated: 2026-08-17',
    '',
    '## Scope',
    'In: retrying failed webhooks.',
    '',
    '## Flow',
    '',
    '```mermaid',
    'flowchart TD',
    '  A[webhook received] --> B{signature ok?}',
    '  B -- no --> C[reject 401]',
    '  B -- yes --> D[enqueue]',
    '```',
    '',
  ].join('\n');
}

function specWithoutDiagram(title) {
  return [
    `# Spec 0004 — ${title}`,
    '',
    'Status: draft',
    '',
    '## Scope',
    'In: billing.',
    '',
    '## Flow',
    'Described in prose only.',
    '',
  ].join('\n');
}

function seedSpec(root, name, content, aiDocs = 'ai-docs') {
  const dir = join(root, aiDocs, 'specs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
  return join(dir, name);
}

// ── specHasDiagram ───────────────────────────────────────────────────────────

test('specHasDiagram: a plain mermaid block counts, prose alone does not', () => {
  assert.equal(specHasDiagram(specWithDiagram('Webhook retries')), true);
  assert.equal(specHasDiagram(specWithoutDiagram('Billing')), false);
  assert.equal(specHasDiagram(''), false);
  assert.equal(specHasDiagram(null), false);
  // A fence with no info string is not a diagram.
  assert.equal(specHasDiagram('```\nflowchart TD\n```\n'), false);
});

test('specHasDiagram: a mermaid fence quoted INSIDE another fence is content, not a diagram', () => {
  // Exactly what a spec (or this repo's own docs) does when it quotes the rule.
  const quotedInBackticks = [
    '# Spec 0005 — Docs',
    '',
    '````markdown',
    '```mermaid',
    'flowchart TD',
    '  A --> B',
    '```',
    '````',
    '',
  ].join('\n');
  assert.equal(specHasDiagram(quotedInBackticks), false);

  const quotedInTildes = ['# Spec 0006 — Docs', '', '~~~markdown', '```mermaid', 'flowchart TD', '```', '~~~', ''].join(
    '\n',
  );
  assert.equal(specHasDiagram(quotedInTildes), false);
});

test('specHasDiagram: CRLF parses the same; an indented fence is not at line start', () => {
  assert.equal(specHasDiagram('# Spec\r\n\r\n```mermaid\r\nflowchart TD\r\n  A --> B\r\n```\r\n'), true);
  assert.equal(specHasDiagram('  ```mermaid\n  flowchart TD\n  ```\n'), false);
  assert.equal(specHasDiagram('\t```mermaid\n\tflowchart TD\n\t```\n'), false);
});

// ── checkSpecDiagram ─────────────────────────────────────────────────────────

test('checkSpecDiagram: passes on a spec that carries a diagram', () => {
  const root = freshRoot('spec-diagram-ok');
  seedSpec(root, '0003-webhook-retries.md', specWithDiagram('Webhook retries'));
  const r = checkSpecDiagram({ specId: '0003', repoRoot: root });
  assert.equal(r.passed, true);
  assert.deepEqual(r.violations, []);
  assert.equal(r.checks[0].item, 'ai-docs/specs/0003-webhook-retries.md');
});

test('checkSpecDiagram: a spec without a diagram fails with an actionable English note', () => {
  const root = freshRoot('spec-diagram-missing');
  seedSpec(root, '0004-billing.md', specWithoutDiagram('Billing'));
  const r = checkSpecDiagram({ specId: '0004', repoRoot: root });
  assert.equal(r.passed, false);
  assert.equal(r.violations.length, 1);
  assert.match(r.violations[0], /^ai-docs\/specs\/0004-billing\.md: /);
  assert.match(r.violations[0], /mermaid/);
  assert.match(r.violations[0], /## Flow/);
});

test('checkSpecDiagram: a spec that only QUOTES a mermaid fence still fails', () => {
  const root = freshRoot('spec-diagram-quoted');
  seedSpec(
    root,
    '0005-docs.md',
    ['# Spec 0005 — Docs', '', '## Flow', '', '````markdown', '```mermaid', 'flowchart TD', '```', '````', ''].join(
      '\n',
    ),
  );
  const r = checkSpecDiagram({ specId: '0005', repoRoot: root });
  assert.equal(r.passed, false);
  assert.match(r.violations[0], /mermaid/);
});

test('checkSpecDiagram: an id with no matching file fails without throwing', () => {
  const root = freshRoot('spec-diagram-none');
  // No ai-docs/ at all — the reporter must degrade, never crash.
  const bare = checkSpecDiagram({ specId: '0009', repoRoot: root });
  assert.equal(bare.passed, false);
  assert.match(bare.violations[0], /spec file not found/);
  assert.match(bare.violations[0], /ai-docs\/specs\/0009-<slug>\.md/);

  seedSpec(root, '0003-webhook-retries.md', specWithDiagram('Webhook retries'));
  const stillMissing = checkSpecDiagram({ specId: '0009', repoRoot: root });
  assert.equal(stillMissing.passed, false);
  assert.match(stillMissing.violations[0], /spec file not found/);
});

test('checkSpecDiagram: the file is found by id whatever the slug is', () => {
  const root = freshRoot('spec-diagram-slug');
  seedSpec(root, '0007-a-very-odd-slug-nobody-would-guess.md', specWithDiagram('Odd slug'));
  const r = checkSpecDiagram({ specId: '0007', repoRoot: root });
  assert.equal(r.passed, true);
  assert.equal(r.checks[0].item, 'ai-docs/specs/0007-a-very-odd-slug-nobody-would-guess.md');
});

test('checkSpecDiagram: relative aiDocsDir resolves under repoRoot; absolute is honored', () => {
  const root = freshRoot('spec-diagram-dirs');
  seedSpec(root, '0003-webhook-retries.md', specWithDiagram('Webhook retries'), join('docs', 'plan'));
  const rel = checkSpecDiagram({ specId: '0003', aiDocsDir: join('docs', 'plan'), repoRoot: root });
  assert.equal(rel.passed, true);
  const abs = checkSpecDiagram({
    specId: '0003',
    aiDocsDir: join(root, 'docs', 'plan'),
    repoRoot: freshRoot('elsewhere'),
  });
  assert.equal(abs.passed, true);
  // Default aiDocsDir + a repoRoot that has no ai-docs/ → clean failure.
  assert.equal(checkSpecDiagram({ specId: '0003', repoRoot: root }).passed, false);
});

// ── plan-docs detection ──────────────────────────────────────────────────────

test('parseSpec: hasDiagram mirrors the gate (diagram, prose, quoted fence)', () => {
  assert.equal(parseSpec(specWithDiagram('Webhook retries')).hasDiagram, true);
  assert.equal(parseSpec(specWithoutDiagram('Billing')).hasDiagram, false);
  assert.equal(
    parseSpec('# Spec 0005 — Docs\n\n````markdown\n```mermaid\nflowchart TD\n```\n````\n').hasDiagram,
    false,
  );
  assert.equal(parseSpec('# Spec 0008 — CRLF\r\n\r\n```mermaid\r\nflowchart TD\r\n```\r\n').hasDiagram, true);
});

test('readPlanSpecs: carries hasDiagram and counts.withoutDiagram, reference spec still excluded', () => {
  const root = freshRoot('plan-diagram');
  const aiDocs = join(root, 'ai-docs');
  mkdirSync(join(aiDocs, 'specs'), { recursive: true });
  writeFileSync(
    join(aiDocs, 'specs', '0001-task-crud.md'),
    specWithDiagram('Task CRUD').replace('Spec 0003', 'Spec 0001'),
  );
  writeFileSync(
    join(aiDocs, 'specs', '0002-billing.md'),
    specWithoutDiagram('Billing').replace('Spec 0004', 'Spec 0002'),
  );
  writeFileSync(
    join(aiDocs, 'specs', '0003-webhooks.md'),
    specWithoutDiagram('Webhooks').replace('Spec 0004', 'Spec 0003'),
  );
  // Shipped reference example (never a live spec) — carries a diagram, still ignored.
  writeFileSync(
    join(aiDocs, 'specs', '0000-example.md'),
    specWithDiagram('Reference example').replace('Spec 0003', 'Spec 0000'),
  );
  writeFileSync(join(aiDocs, 'specs', 'README.md'), '# Not a spec\n');

  const r = readPlanSpecs(aiDocs);
  assert.equal(r.available, true);
  assert.deepEqual(
    r.specs.map((s) => [s.id, s.hasDiagram]),
    [
      ['0001', true],
      ['0002', false],
      ['0003', false],
    ],
  );
  assert.equal(r.counts.total, 3);
  assert.equal(r.counts.withoutDiagram, 2);

  // Missing directory → empty shape that still exposes the new counter.
  const missing = readPlanSpecs(join(root, 'nope'));
  assert.equal(missing.available, false);
  assert.equal(missing.counts.withoutDiagram, 0);
});

// ── decision log: accept the recommendation ──────────────────────────────────

test('decision-log --accepted records the recommendation as the answer', () => {
  const root = freshRoot('decision-accept');
  const rel = cli(root, ['open', 'stack', '--topic', 'stack choices']);
  assert.equal(rel, join(DECISIONS_DIR, '001-stack-2026-08-17.md'));

  assert.equal(cli(root, ['log', '1', '--q', 'Which database?', '--rec', 'Convex', '--accepted']), 'logged #1');
  const content = readFileSync(join(root, rel), 'utf8');
  assert.match(content, /### 1\. Which database\?/);
  assert.match(content, /^- Recommendation: Convex$/m);
  assert.match(content, /^- Answer: Convex \(accepted\)$/m);
});

test('decision-log: numbering stays max+1 after an accepted entry, and --a is unchanged', () => {
  const root = freshRoot('decision-accept-mix');
  const rel = cli(root, ['open', 'stack']);
  assert.equal(cli(root, ['log', '1', '--q', 'Which database?', '--rec', 'Convex', '--accepted']), 'logged #1');
  assert.equal(cli(root, ['log', '1', '--q', 'Which host?', '--rec', 'Vercel', '--a', 'Fly.io'], {}), 'logged #2');
  assert.equal(cli(root, ['log', '1', '--q', 'Who uses it?', '--a', 'admin + attendant']), 'logged #3');

  const content = readFileSync(join(root, rel), 'utf8');
  // The typed answer wins over the recommendation, verbatim, with no marker.
  assert.match(content, /### 2\. Which host\?\n- Recommendation: Vercel\n- Answer: Fly\.io\n/);
  // An entry without --rec still has no Recommendation line.
  assert.doesNotMatch(content.split('### 3.')[1], /Recommendation:/);
  assert.match(content, /^- Answer: admin \+ attendant$/m);
});

test('decision-log: --accepted refuses a missing --rec or a simultaneous --a, cleanly, exit 1', () => {
  const root = freshRoot('decision-accept-bad');
  cli(root, ['open', 'stack']);

  try {
    cli(root, ['log', '1', '--q', 'Which database?', '--accepted']);
    assert.fail('--accepted without --rec should exit 1');
  } catch (err) {
    assert.equal(err.status, 1);
    assert.match(String(err.stderr), /--accepted needs --rec/);
    assert.ok(!String(err.stderr).includes('at '), 'clean message, not a stack trace');
  }

  try {
    cli(root, ['log', '1', '--q', 'Which database?', '--rec', 'Convex', '--a', 'Postgres', '--accepted']);
    assert.fail('--accepted together with --a should exit 1');
  } catch (err) {
    assert.equal(err.status, 1);
    assert.match(String(err.stderr), /mutually exclusive/);
    assert.ok(!String(err.stderr).includes('at '), 'clean message, not a stack trace');
  }

  // Neither --a nor --accepted is still the original usage error.
  try {
    cli(root, ['log', '1', '--q', 'Which database?', '--rec', 'Convex']);
    assert.fail('log without an answer should exit 1');
  } catch (err) {
    assert.equal(err.status, 1);
    assert.match(String(err.stderr), /usage: decision-log log/);
  }

  // Nothing was written by any of the three refusals.
  const content = readFileSync(join(root, DECISIONS_DIR, '001-stack-2026-08-17.md'), 'utf8');
  assert.doesNotMatch(content, /### 1\./);
});
