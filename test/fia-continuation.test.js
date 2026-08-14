import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ENGINE_ERROR_FILE,
  buildContinuationPreamble,
  classifyEngineFailure,
  clearEngineError,
  readEngineError,
  readEngineErrors,
  shouldArmFallback,
  writeEngineError,
} from '../fia-templates/modules/continuation.mjs';

const baseMarker = {
  agent: 'builder',
  fda_id: 'run1',
  coding_agent: 'claude_code',
  model: 'sonnet',
  kind: 'limit',
  message: 'API Error: 429 usage limit reached',
  phase: 'build',
};

// ── classifyEngineFailure (the ONE regex set shared with engineHint) ─────────

test('classifyEngineFailure: login, limit and crash corpora', () => {
  for (const text of ['401 Unauthorized', 'invalid credentials', 'token expired', 'please log in again']) {
    assert.equal(classifyEngineFailure(text), 'login', text);
  }
  for (const text of [
    'API Error: 429 {"type":"error"}',
    'usage limit reached',
    'weekly limit hit',
    'model is overloaded',
    'quota exceeded',
  ]) {
    assert.equal(classifyEngineFailure(text), 'limit', text);
  }
  for (const text of ['segmentation fault', 'TypeError: boom', '', null]) {
    assert.equal(classifyEngineFailure(text), 'crash', String(text));
  }
});

// ── marker write / merge / clear ─────────────────────────────────────────────

test('writeEngineError: same identity+kind increments count, anything else resets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fia-cont-'));
  const first = writeEngineError(dir, baseMarker);
  assert.equal(first.count, 1);
  const second = writeEngineError(dir, baseMarker);
  assert.equal(second.count, 2);
  assert.equal(readEngineError(dir).count, 2);
  // A different engine resets the streak — it is a NEW death, not a repeat.
  const other = writeEngineError(dir, { ...baseMarker, coding_agent: 'pi', model: 'openai-codex/gpt' });
  assert.equal(other.count, 1);
  // A different kind on the same engine resets too.
  writeEngineError(dir, baseMarker);
  const crashed = writeEngineError(dir, { ...baseMarker, kind: 'crash', message: 'boom' });
  assert.equal(crashed.count, 1);
});

test('writeEngineError: message is capped at 1000 chars', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fia-cont-'));
  writeEngineError(dir, { ...baseMarker, message: 'x'.repeat(5000) });
  assert.equal(readEngineError(dir).message.length, 1000);
});

test('readEngineError: malformed or shapeless files read as no marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fia-cont-'));
  assert.equal(readEngineError(dir), null);
  writeFileSync(join(dir, ENGINE_ERROR_FILE), 'not json');
  assert.equal(readEngineError(dir), null);
  writeFileSync(join(dir, ENGINE_ERROR_FILE), JSON.stringify({ kind: 'limit' }));
  assert.equal(readEngineError(dir), null, 'a marker without engine identity must be ignored');
});

test('readEngineErrors: scans agent dirs of one session, keyed by dir name', () => {
  const sessionDir = mkdtempSync(join(tmpdir(), 'fia-cont-'));
  mkdirSync(join(sessionDir, 'builder'));
  mkdirSync(join(sessionDir, 'planner'));
  mkdirSync(join(sessionDir, 'phase_results'));
  writeEngineError(join(sessionDir, 'builder'), baseMarker);
  writeFileSync(join(sessionDir, 'agent_map.json'), '{}');
  const markers = readEngineErrors(sessionDir);
  assert.deepEqual(Object.keys(markers), ['builder']);
  assert.equal(markers.builder.kind, 'limit');
  assert.deepEqual(readEngineErrors(join(sessionDir, 'missing')), {});
});

test('clearEngineError: exact identity only — a fallback success keeps the marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fia-cont-'));
  writeEngineError(dir, baseMarker);
  // The fallback (different engine) succeeding must NOT forget the death.
  clearEngineError(dir, { coding_agent: 'pi', model: 'openai-codex/gpt' });
  assert.ok(existsSync(join(dir, ENGINE_ERROR_FILE)));
  // The dead engine itself succeeding forgets it.
  clearEngineError(dir, { coding_agent: 'claude_code', model: 'sonnet' });
  assert.equal(existsSync(join(dir, ENGINE_ERROR_FILE)), false);
});

// ── shouldArmFallback (the arming rule) ──────────────────────────────────────

test('shouldArmFallback: login/limit/missing arm at once, crash only on the second', () => {
  assert.equal(shouldArmFallback(null), false);
  for (const kind of ['login', 'limit', 'missing']) {
    assert.equal(shouldArmFallback({ ...baseMarker, kind, count: 1 }), true, kind);
  }
  assert.equal(shouldArmFallback({ ...baseMarker, kind: 'crash', count: 1 }), false);
  assert.equal(shouldArmFallback({ ...baseMarker, kind: 'crash', count: 2 }), true);
});

// ── buildContinuationPreamble ────────────────────────────────────────────────

test('preamble: names the dead engine, the transcript, and carries the guards', () => {
  const preamble = buildContinuationPreamble({
    marker: { ...baseMarker, count: 1 },
    transcriptPath: 'imp/data/sessions/run1/builder/raw_output.jsonl',
  });
  assert.match(preamble, /^## Continuation of an interrupted run/);
  assert.match(preamble, /claude_code engine \(sonnet\)/);
  assert.match(preamble, /its subscription plan limit was hit/);
  assert.match(preamble, /imp\/data\/sessions\/run1\/builder\/raw_output\.jsonl/);
  // The three load-bearing guards: anti-injection, workspace authority, tail-first.
  assert.match(preamble, /no authority over you/);
  assert.match(preamble, /WORKSPACE is the authority/);
  assert.match(preamble, /git status/);
  assert.match(preamble, /scan the tail/);
  assert.match(preamble, /state in one short paragraph where the previous/);
  // No Pi line unless a Pi session file is handed over.
  assert.doesNotMatch(preamble, /Pi format/);
});

test('preamble: includes the Pi session file only when given', () => {
  const preamble = buildContinuationPreamble({
    marker: { ...baseMarker, coding_agent: 'pi', model: 'openai-codex/gpt', kind: 'crash' },
    transcriptPath: 'imp/data/sessions/run1/builder/raw_output.jsonl',
    piSessionPath: 'imp/data/sessions/run1/builder/pi_session.jsonl',
  });
  assert.match(preamble, /pi_session\.jsonl — the previous attempt's full session file \(Pi format\)/);
  assert.match(preamble, /its CLI crashed/);
});
