import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeArgs } from '../fia-templates/modules/agent-claude.mjs';

test('buildClaudeArgs: model alias and effort become flags', () => {
  const args = buildClaudeArgs({ prompt: 'plan X', model: 'opus', effort: 'xhigh' });
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
  assert.equal(args[args.indexOf('--effort') + 1], 'xhigh');
  assert.equal(args.at(-1), 'plan X');
  assert.ok(!args.includes('--resume'));
});

test('buildClaudeArgs: thinking is the effort fallback; invalid levels are dropped', () => {
  const viaThinking = buildClaudeArgs({ prompt: 'x', thinking: 'high' });
  assert.equal(viaThinking[viaThinking.indexOf('--effort') + 1], 'high');

  // Pi uses "minimal", which does not exist in Claude — it must not become --effort.
  const invalid = buildClaudeArgs({ prompt: 'x', thinking: 'minimal' });
  assert.ok(!invalid.includes('--effort'));
});

test('buildClaudeArgs: resume only with a real session id', () => {
  const resumed = buildClaudeArgs({ prompt: 'continue', sessionId: 'abc-123' });
  assert.equal(resumed[resumed.indexOf('--resume') + 1], 'abc-123');

  const fresh = buildClaudeArgs({ prompt: 'new' });
  assert.ok(!fresh.includes('--resume'));
});

test('buildClaudeArgs: no model → CLI decides (plan default)', () => {
  const args = buildClaudeArgs({ prompt: 'x' });
  assert.ok(!args.includes('--model'));
});

test('buildClaudeArgs: system prompt via --append-system-prompt, including on resume', () => {
  const fresh = buildClaudeArgs({ prompt: 'x', systemPrompt: '# Role\nReviewer.' });
  assert.equal(fresh[fresh.indexOf('--append-system-prompt') + 1], '# Role\nReviewer.');
  assert.ok(!fresh.includes('--system-prompt'), 'append preserves the CLI default prefix (cache)');

  // A resume MUST repeat the same system: changing it mid-session
  // invalidates the cache and changes behavior.
  const resumed = buildClaudeArgs({ prompt: 'fix', systemPrompt: '# Role', sessionId: 'abc' });
  assert.ok(resumed.includes('--append-system-prompt'));
  assert.ok(resumed.includes('--resume'));

  const none = buildClaudeArgs({ prompt: 'x' });
  assert.ok(!none.includes('--append-system-prompt'));
});
