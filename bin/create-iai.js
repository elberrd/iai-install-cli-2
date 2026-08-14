#!/usr/bin/env node
// Thin entry point. All logic lives in ../src so it can be unit-tested and
// imported without the shebang. Keep this file tiny.

// Node version gate — the `engines` field doesn't block `npx` execution, so
// enforce it here with a clear message (before importing anything modern).
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(`impactus requires Node.js >= 22.12 (you are on ${process.versions.node}).`);
  console.error('Update at https://nodejs.org (current LTS) and try again.');
  process.exit(1);
}

const { parseArgs, helpText } = await import('../src/lib/args.js');
const { flags, errors, warnings } = parseArgs(process.argv.slice(2));

if (flags.help) {
  console.log(helpText());
  process.exit(0);
}
if (flags.version) {
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}
if (errors.length > 0) {
  for (const e of errors) console.error(`✗ ${e}`);
  console.error('\nUse --help to see the options.');
  process.exit(1);
}
// Non-fatal notices (deprecated aliases etc.) — printed, never abort.
for (const w of warnings ?? []) console.error(`! ${w}`);

// Access subcommands (device flow): authenticate/clear and exit.
if (flags.logout || flags.whoami || flags.login) {
  const { runLogout, runWhoami, ensureAuthenticated } = await import('../src/steps/auth.js');
  try {
    if (flags.logout) await runLogout(flags);
    else if (flags.whoami) await runWhoami(flags);
    else await ensureAuthenticated({ flags }); // --login: authenticate and exit
  } catch (err) {
    console.error(err?.message || String(err));
    process.exit(1);
  }
  process.exit(0);
}

// --verify: audits an already-installed project (touching nothing) and exits.
if (flags.verify) {
  const { runVerify } = await import('../src/steps/verify.js');
  const ok = await runVerify(flags).catch((err) => {
    console.error(err?.stack || String(err));
    return false;
  });
  process.exit(ok ? 0 : 1);
}

// --update-runtime: re-stamps the FIA/Pi runtime of an already-installed
// project from this package version and exits (config/data/local edits kept).
if (flags.updateRuntime) {
  const { runUpdateRuntime } = await import('../src/steps/update-runtime.js');
  const ok = await runUpdateRuntime(flags).catch((err) => {
    console.error(err?.stack || String(err));
    return false;
  });
  process.exit(ok ? 0 : 1);
}

// The TERMINAL assistant is the default entry point: `npx impactus`
// asks every decision right there and then executes. The web UI (building the
// command by clicking in the browser) is opt-in via --ui — see lib/pipeline.js.
const { wantsWebUi } = await import('../src/lib/pipeline.js');
if (wantsWebUi(flags)) {
  const { runUiServer } = await import('../src/steps/ui-server.js');
  await runUiServer(flags).catch((err) => {
    console.error(err?.stack || String(err));
    process.exit(1);
  });
  process.exit(0);
}

const { main } = await import('../src/main.js');
main(flags).catch(async (err) => {
  // main() handles its own cancel/exit paths; this is a last-resort guard.
  console.error(err?.stack || String(err));
  try {
    // Late dynamic import (same pattern as above): record the crash in the
    // run log too, so the file users attach to bug reports has it.
    const { getLogPath, logLine } = await import('../src/lib/log.js');
    if (getLogPath()) logLine(`FATAL (unhandled): ${err?.stack || String(err)}`);
  } catch {
    /* best-effort — never mask the original error */
  }
  process.exit(1);
});
