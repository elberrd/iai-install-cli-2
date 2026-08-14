// Portable test entry: `npm test` → `node test/run.mjs`.
//
// Why not `node --test <something>`: a bare `node --test` discovers test files
// recursively from the cwd and picks up the nested live1/live2/estudo repos;
// a `test/` directory argument is treated as a module and fails; and the
// `test/*.test.js` shell glob does not expand on Windows (cmd). Listing the
// files explicitly and spawning the runner works the same on every OS and on
// Node 20+.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const testDir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => join(testDir, f));

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
