// Import-only smoke test: every module in src/steps/, src/lib/ and
// fia-templates/modules/ must load without throwing. This catches broken
// named imports (`SyntaxError: The requested module … does not provide an
// export named …`) and load-time crashes that unit tests miss because they
// only import the modules they exercise.
//
// Nothing is executed beyond the module body — no function calls, no side
// effects on the project. All modules in these folders are currently
// side-effect-free at load time (verified: no top-level process.argv reads,
// spawns or writes); if one ever needs load-time work, add it to SKIP below
// with a comment explaining why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Modules that cannot be imported without side effects (none today).
// Format: 'src/steps/example.js': 'reason'
const SKIP = {};

const DIRS = [
  { dir: 'src/steps', ext: /\.js$/ },
  { dir: 'src/lib', ext: /\.js$/ },
  { dir: 'fia-templates/modules', ext: /\.mjs$/ },
];

for (const { dir, ext } of DIRS) {
  const files = readdirSync(join(ROOT, dir)).filter((f) => ext.test(f)).sort();
  assert.ok(files.length > 0, `${dir} should contain modules`);

  test(`import: every module in ${dir} loads`, async (t) => {
    for (const file of files) {
      const rel = `${dir}/${file}`;
      if (SKIP[rel]) {
        t.diagnostic(`skipped ${rel}: ${SKIP[rel]}`);
        continue;
      }
      await t.test(rel, async () => {
        // A broken export/import or load-time throw rejects here with the
        // original error message, pointing straight at the offending file.
        await import(pathToFileURL(join(ROOT, rel)).href);
      });
    }
  });
}
