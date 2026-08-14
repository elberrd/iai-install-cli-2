import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPiArgs } from '../fia-templates/modules/agent-pi.mjs';
import { buildCursorArgs } from '../fia-templates/modules/agent-cursor.mjs';

// Per-engine system prompt delivery is the contract audited in Aug/2026:
// claude/pi via --append-system-prompt on EVERY invocation; cursor (no flag)
// prepended only to the FIRST prompt of the session.

test('buildPiArgs: basic flags and prompt last', () => {
  const args = buildPiArgs({ prompt: 'do X', sessionFile: '/tmp/s.jsonl', model: 'openai-codex/gpt-5.6-sol' });
  assert.equal(args[args.indexOf('--session') + 1], '/tmp/s.jsonl');
  assert.equal(args[args.indexOf('--model') + 1], 'openai-codex/gpt-5.6-sol');
  assert.equal(args[args.indexOf('--thinking') + 1], 'medium', 'default');
  assert.equal(args.at(-1), 'do X');
});

test('buildPiArgs: system via --append-system-prompt, before tools/extensions', () => {
  const args = buildPiArgs({
    prompt: 'x',
    sessionFile: 's.jsonl',
    model: 'm',
    systemPrompt: '# Scout',
    tools: ['read', 'grep'],
    extensions: ['.pi/extensions/fia-guard.ts'],
  });
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], '# Scout');
  assert.equal(args[args.indexOf('--tools') + 1], 'read,grep');
  assert.equal(args[args.indexOf('-e') + 1], '.pi/extensions/fia-guard.ts');
  assert.equal(args.at(-1), 'x');
  assert.ok(!buildPiArgs({ prompt: 'x', sessionFile: 's', model: 'm' }).includes('--append-system-prompt'));
});

test('buildCursorArgs: system prepended only to the first prompt of the session', () => {
  const fresh = buildCursorArgs({ prompt: 'do X', systemPrompt: '# Builder' });
  assert.equal(fresh.at(-1), '# Builder\n\n---\n\ndo X');

  // Resume: the role is already in the history — repeating it would inflate the context.
  const resumed = buildCursorArgs({ prompt: 'fix', systemPrompt: '# Builder', sessionId: 'chat-1' });
  assert.equal(resumed.at(-1), 'fix');
  assert.equal(resumed[resumed.indexOf('--resume') + 1], 'chat-1');

  const none = buildCursorArgs({ prompt: 'y' });
  assert.equal(none.at(-1), 'y');
});
