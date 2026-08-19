#!/usr/bin/env node
/**
 * FIA compatibility wrapper. The canonical runner belongs to the harness so
 * `/start` and `/dev` work even when FIA/Pi was declined or could not install.
 */
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function option(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index !== -1 && argv[index + 1] ? argv[index + 1] : fallback;
}

export async function runCli(argv = process.argv.slice(2)) {
  const target = resolve(option(argv, '--target', option(argv, '--dir', process.cwd())));
  const runner = join(target, '.agents', 'scripts', 'ui-kit.mjs');
  if (!existsSync(runner)) {
    throw new Error(
      `Universal UI-kit runner is missing: ${runner}. ` +
        'Re-run `npx impactus --dir . --harness-only` to refresh the harness.',
    );
  }
  const module = await import(pathToFileURL(runner).href);
  return await module.runCli(argv);
}

const isMain =
  process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  try {
    process.exitCode = await runCli();
  } catch (error) {
    if (process.argv.includes('--json')) {
      console.error(JSON.stringify({ status: 'conflict', error: error.message, details: [] }, null, 2));
    } else {
      console.error(`CONFLICT canonical UI kit: ${error.message}`);
    }
    process.exitCode = 1;
  }
}
