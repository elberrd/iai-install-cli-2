import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HARNESS = join(ROOT, 'harness');
const hasHarness = existsSync(join(HARNESS, '.claude', 'commands', 'start.md'));

function read(...parts) {
  return readFileSync(join(ROOT, ...parts), 'utf8');
}

function includesAll(text, needles, label) {
  const normalizedText = text.replace(/\s+/g, ' ');
  for (const needle of needles) {
    const normalizedNeedle = needle.replace(/\s+/g, ' ');
    assert.ok(normalizedText.includes(normalizedNeedle), `${label} must include ${JSON.stringify(needle)}`);
  }
}

const ARCHITECTURE_TRIGGERS = [
  'a new external integration or service',
  'a second runtime/deploy target or external job',
  'a new data domain, central relationship, migration or backfill',
  'auth, roles, tenancy, payments, PII, secrets or another trust boundary',
  'a public contract, storage choice or other expensive-to-reverse decision',
  'two or more materially different solution approaches',
  'uncertainty that needs a spike or experiment',
];

const ARCHITECTURE_HEADINGS = [
  '## Problem & goals',
  '## Trigger assessment',
  '## Approaches considered',
  '## Recommended approach',
  '## Key decisions',
  '### Stack and existing-system reuse',
  '### Domain and data shape',
  '### Boundaries and contracts',
  '## Missing pieces',
  '## Risks',
  '## Spikes and experiments',
  '## Open questions',
  '## Downstream planning constraints',
];

test('Pi /idea produces an evidence-backed falsifiable PRD in both project modes', () => {
  const idea = read('pi-templates', '.pi', 'prompts', 'idea.md');

  includesAll(
    idea,
    [
      'Evidence is not an assumption',
      'Read any references passed in `$@`',
      'TBD — needs validation',
      'solution-independent',
      'job to be done (JTBD)',
      'explicit non-users',
      'RIGHT condition',
      'WRONG / counter-signal',
      'why now',
      'guardrails',
      'metric, target, timeframe and how it is measured',
      'thinnest end-to-end MVP slice',
      'APPEND a `## Module: <name>` chapter',
      'Every module outcome and guardrail metric uses metric, target, timeframe and how measured',
      'known-domain field in its data delta keeps the protected `semantic type`',
      'NEVER rewrite the rest of the PRD',
      'semantic type',
      '## Launch criteria',
    ],
    'Pi /idea',
  );
});

test('Pi /grill stress-tests falsifiability before implementation detail', () => {
  const grill = read('pi-templates', '.pi', 'prompts', 'grill.md');

  includesAll(
    grill,
    [
      'evidence vs assumptions',
      'read the target and every reference supplied',
      'interviews, tickets, analytics or research',
      'problem thesis, JTBD and non-users',
      'RIGHT condition',
      'WRONG / counter-signal',
      'why now',
      'guardrails',
      'thinnest end-to-end MVP slice',
      'outcome metrics',
      'TBD — needs validation',
    ],
    'Pi /grill',
  );
  assert.ok(grill.indexOf('evidence vs assumptions') < grill.indexOf('actors/permissions'));
});

test('Pi /prd reviews the complete falsifiability contract without editing', () => {
  const prd = read('pi-templates', '.pi', 'prompts', 'prd.md');

  includesAll(
    prd,
    [
      'evidence is separated from assumptions',
      'TBD — needs validation',
      'solution-independent',
      'JTBD',
      'explicit non-users',
      'RIGHT and WRONG/counter-signals',
      'thinnest end-to-end slice',
      'metric, target, timeframe and how it is measured',
      'why now and guardrails',
      'module chapters apply the same contract',
      'semantic type',
      'Do NOT edit the PRD',
    ],
    'Pi /prd',
  );
});

test('architecture is a conditional /map checkpoint with one canonical artifact', () => {
  const map = read('pi-templates', '.pi', 'prompts', 'map.md');
  const cookbook = read('pi-templates', '.pi', 'skills', 'fia', 'cookbooks', 'architecture.md');

  includesAll(map, ARCHITECTURE_TRIGGERS, 'Pi /map triggers');
  includesAll(cookbook, ARCHITECTURE_TRIGGERS, 'architecture cookbook triggers');
  includesAll(cookbook, ARCHITECTURE_HEADINGS, 'architecture artifact');
  includesAll(
    cookbook,
    [
      'architecture checkpoint skipped',
      'open map --topic "architecture: <scope>"',
      'Status: ready | provisional',
      'Question · Smallest spike · Timebox · Decision rule · Blocks',
      'A blocking open question without a decision rule stops task generation',
      'Spikes are ordinary issues, not a new `Kind`',
      'Alternatives that were not selected are context, never tasks',
    ],
    'architecture cookbook',
  );
  assert.equal(existsSync(join(ROOT, 'pi-templates', '.pi', 'prompts', 'architecture.md')), false);
});

test('Pi /stack stays authoritative over architecture', () => {
  const stack = read('pi-templates', '.pi', 'prompts', 'stack.md');
  includesAll(
    stack,
    ['source of truth', 'architecture.md', 'NEVER overrides', 'new global service/layer'],
    'Pi /stack',
  );
});

test('harness PRD template separates evidence, assumptions, hypothesis and measurement', {
  skip: !hasHarness && 'harness/ not present (nested repo, absent on fresh checkout)',
}, () => {
  const prd = read('harness', 'ai-docs', 'PRD.md');
  includesAll(
    prd,
    [
      '### Evidence',
      '### Assumptions & validation',
      '### Product thesis / differentiator',
      '### Why now',
      '### Guardrails',
      'TBD — needs validation',
      'State the problem without prescribing a feature or technology',
      'Context / trigger',
      'Job to be done (JTBD)',
      '### Explicit non-users',
      '### Falsifiable product hypothesis',
      '**RIGHT condition:**',
      '**WRONG / counter-signal:**',
      '### MVP experiment — thinnest end-to-end slice',
      '| Metric | Target | Timeframe | How measured |',
      '## 3. MVP / v1 Scope',
      '## Launch criteria',
      'semantic type',
      'ai-docs/stack.md` is the source of truth',
      '**Decision log:**',
    ],
    'harness PRD template',
  );
});

test('Claude /start uses the same architecture triggers without changing six-step resume schema', {
  skip: !hasHarness && 'harness/ not present (nested repo, absent on fresh checkout)',
}, () => {
  const start = read('harness', '.claude', 'commands', 'start.md');
  const map = read('pi-templates', '.pi', 'prompts', 'map.md');
  const schema = parseYaml(read('harness', 'ai-docs', 'start', 'map-start.yaml'));

  includesAll(start, ARCHITECTURE_TRIGGERS, 'Claude /start triggers');
  includesAll(start, ARCHITECTURE_HEADINGS, 'Claude /start artifact');
  includesAll(
    start,
    [
      'architecture checkpoint skipped',
      'open map --topic',
      '"architecture: <scope>"',
      'NOT a workflow step',
      'Status: ready | provisional',
      'blocking open question without a decision rule stops task generation',
      'Rejected alternatives stay as context and never become tasks',
    ],
    'Claude /start',
  );
  for (const trigger of ARCHITECTURE_TRIGGERS) {
    assert.ok(map.includes(trigger) && start.includes(trigger), `shared trigger drifted: ${trigger}`);
  }
  assert.deepEqual(Object.keys(schema.workflow_progress.steps), [
    'step_1_verify_prd',
    'step_2_screens_routes',
    'step_3_task_master',
    'step_4_start_mapper',
    'step_5_component_architect',
    'step_6_ui_component_page',
  ]);
  assert.equal(schema.ai_docs.prd.path, 'ai-docs/PRD.md');
  assert.equal(schema.ai_docs.architecture.path, 'ai-docs/architecture.md');
  assert.equal(existsSync(join(HARNESS, '.claude', 'commands', 'architecture.md')), false);
  assert.equal(existsSync(join(HARNESS, '.cursor', 'commands', 'architecture.md')), false);
});

test('harness grill and stack enforce falsifiability and manifest ownership', {
  skip: !hasHarness && 'harness/ not present (nested repo, absent on fresh checkout)',
}, () => {
  const grill = read('harness', '.claude', 'commands', 'grill.md');
  const stack = read('harness', '.claude', 'commands', 'stack.md');

  includesAll(
    grill,
    [
      'Evidence vs assumptions',
      'read the target and every reference supplied',
      'interviews, tickets, analytics or research',
      'context/trigger + JTBD',
      'explicit non-users',
      'RIGHT condition',
      'WRONG / counter-signal',
      'Why now',
      'Guardrails',
      'Thinnest end-to-end MVP slice',
      'TBD — needs validation',
    ],
    'Claude /grill',
  );
  includesAll(stack, ['architecture.md', 'NEVER overrides', 'new global service/layer'], 'Claude /stack');
});

test('planning agents consume architecture and treat provisional spikes safely', {
  skip: !hasHarness && 'harness/ not present (nested repo, absent on fresh checkout)',
}, () => {
  const mapper = read('harness', '.claude', 'agents', 'start-mapper.md');
  const tasks = read('harness', '.claude', 'agents', 'task-master-generator.md');

  includesAll(
    mapper,
    ['ai-docs/architecture.md', 'ai_docs.architecture', 'remove that optional entry', 'rejected alternatives are not the map'],
    'start-mapper',
  );
  includesAll(
    tasks,
    [
      'Plan only the recommended approach',
      'blocking open question with no decision rule',
      'status is `provisional`',
      'at the front of the DAG',
      'ordinary issues, not a new `Kind`',
      'Mode: prototype',
      'update to `ai-docs/architecture.md`',
      '/ Architecture section Z',
      'rejected alternatives produced no tasks',
    ],
    'task-master-generator',
  );
});

test('Cursor-only workflow skills carry the planning checkpoint until mirrors sync', {
  skip: !hasHarness && 'harness/ not present (nested repo, absent on fresh checkout)',
}, () => {
  const grill = read('harness', '.cursor', 'skills', 'workflow-grill', 'SKILL.md');
  const start = read('harness', '.cursor', 'skills', 'workflow-start', 'SKILL.md');
  const router = read('harness', '.cursor', 'skills', 'project-workflow', 'SKILL.md');

  includesAll(
    grill,
    [
      'evidence vs assumptions',
      'read the target and supplied references',
      'interviews, tickets, analytics or research',
      'RIGHT condition',
      'WRONG / counter-signal',
      'why now',
      'guardrails',
      'TBD — needs validation',
    ],
    'Cursor workflow-grill',
  );
  includesAll(start, ARCHITECTURE_TRIGGERS, 'Cursor workflow-start triggers');
  includesAll(start, ['Conditional architecture checkpoint', 'architecture checkpoint skipped', 'open map --topic', 'provisional', 'Rejected alternatives never become tasks'], 'Cursor workflow-start');
  includesAll(router, ['conditional', 'architecture checkpoint', 'not a separate command or seventh resume step'], 'Cursor project-workflow');
});
