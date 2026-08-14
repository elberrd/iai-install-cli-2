// Unit tests for wrapNoteText — the terminal-width wrap applied to every
// ui.note() before clack draws the box (clack pads all lines to the longest
// one with no width awareness; anything wider than the terminal shatters the
// frame).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapNoteText } from '../src/lib/ui.js';

const widest = (text) => Math.max(...text.split('\n').map((l) => l.length));

test('wrapNoteText: short content is untouched', () => {
  const msg = 'Commands:\n  /idea   short hint\n\ndone';
  assert.equal(wrapNoteText(msg, 80), msg);
});

test('wrapNoteText: long prose wraps within the terminal width', () => {
  const msg = 'FIA: run `pi`, type /login openai-codex (only that one) and then use /idea to shape the PRD in conversation before mapping.';
  const out = wrapNoteText(msg, 60);
  assert.ok(widest(out) <= 60 - 7, `widest line ${widest(out)} must fit 53 cols`);
  assert.equal(out.replaceAll('\n', ' ').replace(/ +/g, ' '), msg, 'no words lost');
});

test('wrapNoteText: command-table rows continue under the description column', () => {
  const msg = '  /quick      small change (≤3 files): triage — simple runs now with guardrails, complex routes to /feature or /bug';
  const out = wrapNoteText(msg, 70).split('\n');
  assert.ok(out.length >= 2, 'wrapped');
  assert.ok(out[0].startsWith('  /quick      small'), 'table head (token + column gap) kept verbatim');
  assert.match(out[1], /^ {14}\S/, 'continuation aligns under the description column');
});

test('wrapNoteText: a word longer than the width is hard-broken, never overflows', () => {
  const url = 'https://example.com/a/very/long/path/that/never/ends/and/keeps/going/forever/and/ever';
  const out = wrapNoteText(url, 40);
  assert.ok(widest(out) <= 40 - 7, 'no overflow — an overflowing word would re-shatter the box');
  assert.equal(out.replaceAll('\n', '').replace(/ +/g, ''), url.replace(/ +/g, ''), 'nothing lost');
});

test('wrapNoteText: falls back to 80 columns without a TTY width', () => {
  const long = 'x '.repeat(60).trim();
  const out = wrapNoteText(long, undefined);
  assert.ok(widest(out) <= 80 - 7);
});

test('wrapNoteText: never wraps below the minimum width', () => {
  const out = wrapNoteText('word '.repeat(20).trim(), 10);
  assert.ok(widest(out) <= 24, 'clamped to the 24-column floor');
  assert.ok(widest(out) > 10, 'floor wins over an absurdly narrow terminal');
});
