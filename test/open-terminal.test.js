import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTerminalCommands } from '../src/lib/open-terminal.js';

test('openTerminalCommands: mac opens Terminal.app already in the folder', () => {
  const cmds = openTerminalCommands('darwin', '/tmp/meu-app');
  assert.deepEqual(cmds, [{ cmd: 'open', args: ['-a', 'Terminal', '/tmp/meu-app'] }]);
});

test('openTerminalCommands: windows opens a new Prompt inheriting the cwd', () => {
  const cmds = openTerminalCommands('win32', 'C:\\projetos\\meu-app');
  assert.equal(cmds.length, 1);
  const [c] = cmds;
  assert.equal(c.cmd, 'cmd');
  assert.equal(c.cwd, 'C:\\projetos\\meu-app');
  // `start` needs the empty title before the command.
  assert.deepEqual(c.args, ['/c', 'start', '', 'cmd']);
});

test('openTerminalCommands: linux tries the common emulators, all with cwd', () => {
  const cmds = openTerminalCommands('linux', '/tmp/meu-app');
  assert.ok(cmds.length >= 3, 'more than one candidate (none is guaranteed)');
  assert.equal(cmds[0].cmd, 'x-terminal-emulator', 'the Debian alternative comes first');
  assert.ok(cmds.every((c) => c.cwd === '/tmp/meu-app'));
});

test('openTerminalCommands: unknown platform → no candidates', () => {
  assert.deepEqual(openTerminalCommands('freebsd', '/tmp'), []);
});
