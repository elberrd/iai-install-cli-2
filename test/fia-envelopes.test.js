import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractJson,
  GenericOutputSchema,
  PlanOutputSchema,
  ReviewOutputSchema,
  ScoutOutputSchema,
} from '../fia-templates/modules/envelopes.mjs';

test('extractJson: pulls object from fenced block', () => {
  const text = 'Here is the report:\n```json\n{"status":"success","summary":"ok"}\n```\n';
  const obj = extractJson(text);
  assert.equal(obj.status, 'success');
  assert.equal(obj.summary, 'ok');
});

test('extractJson: bare JSON in prose', () => {
  const obj = extractJson('Answer: {"status":"fail","summary":"nope"} end.');
  assert.equal(obj.status, 'fail');
});

test('GenericOutputSchema: defaults optional fields', () => {
  const parsed = GenericOutputSchema.parse({ status: 'success' });
  assert.deepEqual(parsed.artifacts, []);
  assert.equal(parsed.notes_for_next_agent, '');
});

test('PlanOutputSchema: commit_message default', () => {
  const parsed = PlanOutputSchema.parse({ status: 'success', summary: 'plan ready' });
  assert.equal(parsed.commit_message, '');
});

test('ScoutOutputSchema: findings array', () => {
  const parsed = ScoutOutputSchema.parse({
    status: 'success',
    summary: 'found routes',
    findings: [{ file: 'src/main.js', note: 'entry' }],
  });
  assert.equal(parsed.findings.length, 1);
});

test('ReviewOutputSchema: rejects invalid status', () => {
  assert.throws(() => ReviewOutputSchema.parse({ status: 'maybe', summary: 'x' }));
});
