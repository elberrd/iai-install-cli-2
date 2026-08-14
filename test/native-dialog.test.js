import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickFolderCommands } from '../src/lib/native-dialog.js';

test('pickFolderCommands: macOS uses osascript with choose folder and default location', () => {
  const [spec] = pickFolderCommands('darwin', '/Users/x/dev');
  assert.equal(spec.cmd, 'osascript');
  const script = spec.args.join(' ');
  assert.ok(script.includes('choose folder'));
  assert.ok(script.includes('POSIX file "/Users/x/dev"'));
  // activate inside a try: brings the dialog to the front without breaking on failure
  assert.ok(script.includes('System Events'));
});

test('pickFolderCommands: macOS escapes quotes and backslashes in the path', () => {
  const [spec] = pickFolderCommands('darwin', '/tmp/pasta "x"\\y');
  const script = spec.args.join(' ');
  assert.ok(script.includes('/tmp/pasta \\"x\\"\\\\y'));
});

test('pickFolderCommands: macOS without startDir emits no default location', () => {
  const [spec] = pickFolderCommands('darwin');
  assert.ok(!spec.args.join(' ').includes('default location'));
});

test('pickFolderCommands: Windows uses powershell -STA and doubles single quotes', () => {
  const [spec] = pickFolderCommands('win32', "C:\\Users\\o'brien");
  assert.equal(spec.cmd, 'powershell');
  assert.ok(spec.args.includes('-STA'));
  const script = spec.args[spec.args.length - 1];
  assert.ok(script.includes('FolderBrowserDialog'));
  assert.ok(script.includes("C:\\Users\\o''brien"));
});

test('pickFolderCommands: Linux tries zenity and then kdialog', () => {
  const specs = pickFolderCommands('linux', '/home/x');
  assert.deepEqual(specs.map((s) => s.cmd), ['zenity', 'kdialog']);
  // zenity needs the trailing slash to open INSIDE the starting folder
  assert.ok(specs[0].args.some((a) => a === '--filename=/home/x/'));
  assert.ok(specs[1].args.includes('/home/x'));
});

test('pickFolderCommands: platform without a dialog returns an empty list', () => {
  assert.deepEqual(pickFolderCommands('aix', '/x'), []);
});
