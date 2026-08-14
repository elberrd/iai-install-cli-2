import process from 'node:process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { has, run, runInherit } from '../lib/proc.js';
import { ensurePiReady, piCodexReady } from '../lib/pi-auth.js';
import { osKind, detectPackageManagers } from '../lib/platform.js';
import * as ui from '../lib/ui.js';

const CLAUDE_INSTALL_HINT = {
  mac: 'curl -fsSL https://claude.ai/install.sh | bash   (or: brew install --cask claude-code)',
  linux: 'curl -fsSL https://claude.ai/install.sh | bash',
  windows: 'irm https://claude.ai/install.ps1 | iex   (or: winget install Anthropic.ClaudeCode)',
};

// ── Gate 0: Claude Code (checked first of all) ──────────────────────────────

export async function ensureClaudeCode(flags = {}) {
  ui.step('Checking Claude Code…');
  if (!(await has('claude'))) {
    ui.error('Claude Code not found.');
    ui.note(
      [
        'Install Claude Code and log in before continuing:',
        '',
        `  ${CLAUDE_INSTALL_HINT[osKind()]}`,
        '',
        'Then log in by running:  claude   (finish in the browser)',
        '',
        'Run this installer again when you are done.',
      ].join('\n'),
      'Claude Code is required',
    );
    process.exit(1);
  }

  // No reliable scriptable login gate for `claude` — best-effort heuristic.
  if (!(await detectClaudeLogin())) {
    ui.warn("I couldn't confirm whether you are logged in to Claude Code.");
    const ok = flags.yes
      ? true // non-interactive mode assumes the login was done
      : await ui.confirm({
          message: 'Have you already logged in to Claude Code (ran `claude` and authenticated)?',
          initialValue: true,
        });
    if (!ok) {
      ui.note(
        'Run `claude`, finish the login in the browser and run this installer again.',
        'Log in to Claude Code',
      );
      process.exit(1);
    }
  }
  ui.success('Claude Code ready.');
}

/**
 * Ensure the Pi CLI (install/update) when FIA will be installed. NO login
 * here: the Codex `/login` is the user's last step, AFTER the install
 * finishes — opening Pi mid-install invited a Ctrl+C that killed the stamp
 * halfway. Claude Code is checked separately in ensureClaudeCode.
 */
export async function ensureFiaAuth(flags = {}) {
  if (flags.skipFia || flags.fia === false) {
    ui.info('FIA disabled — Pi/Codex is not required for this install.');
    return;
  }
  ui.step('Checking Pi (FIA)…');
  await ensurePiReady();
  if (piCodexReady()) {
    ui.success('Pi/Codex ready for FDAs.');
  } else {
    ui.info('Codex login not done yet — that is fine: the install finishes everything and the login is the last step.');
  }
}

async function detectClaudeLogin() {
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) return true;
  const credFile = join(homedir(), '.claude', '.credentials.json');
  try {
    if (existsSync(credFile) && statSync(credFile).size > 0) return true;
  } catch {
    /* ignore */
  }
  if (osKind() === 'mac') {
    // Claude Code stores its OAuth token in the login keychain. The service
    // name has varied across versions, so probe the known candidates.
    for (const service of ['Claude Code-credentials', 'Claude Code', 'claude-code']) {
      if ((await run('security', ['find-generic-password', '-s', service])).ok) return true;
    }
  }
  return false;
}

// ── CLIs: Git, GitHub CLI, Vercel CLI ───────────────────────────────────────

/**
 * @param {object} opts
 * @param {boolean} [opts.vercel] - prepare the Vercel CLI (only if deploy is possible).
 * @param {boolean} [opts.gh] - install the gh binary at all. "Harness only"
 *   installs with a community token never touch GitHub — installing gh there
 *   is dead weight; it stays in as a dev fallback when there is no token.
 * @param {boolean} [opts.ghAuth] - require gh LOGIN. The binary is installed
 *   either way (used by `gh repo create` in the GitHub step), but the login
 *   only makes sense when a push to GitHub may still happen.
 */
export async function ensureCliTools({ vercel = true, gh = true, ghAuth = true, flags = {} } = {}) {
  const pms = await detectPackageManagers();
  await ensureGit(pms, flags);
  if (gh) await ensureGh(pms, flags, { requireAuth: ghAuth });
  else ui.info('GitHub CLI (gh) not needed for this install — skipped.');
  // The Vercel CLI is only needed when the template (and the deploy) are in.
  // In "harness only" mode — and when the deploy was declined — it's optional.
  if (vercel) await ensureVercel(pms, flags);
}

/**
 * Per-OS install command for a given tool, or null if none is available.
 *
 * `gh` on apt is the special case: it does NOT exist in the Debian/Ubuntu
 * repositories, only in GitHub CLI's own signed repository. `apt-get install
 * -y gh` fails with "Unable to locate package gh" — hence the script that
 * registers the key and the source before installing (docs:
 * cli.github.com/packages).
 */
export function installPlan(tool, pms) {
  const os = osKind();
  if (tool === 'vercel') {
    // No first-party brew/winget/choco formula → npm global on every OS.
    return { bin: 'npm', args: ['install', '-g', 'vercel'] };
  }
  if (os === 'mac' && pms.brew) return { bin: 'brew', args: ['install', tool] };
  if (os === 'linux' && pms['apt-get'] && tool === 'gh') {
    return { bin: 'bash', args: ['-c', GH_APT_SCRIPT] };
  }
  if (os === 'linux' && pms['apt-get']) {
    // `apt-get update` first: on an image with a stale index the install fails.
    return { bin: 'bash', args: ['-c', `set -e; sudo apt-get update; sudo apt-get install -y ${tool}`] };
  }
  if (os === 'linux' && pms.dnf) return { bin: 'sudo', args: ['dnf', 'install', '-y', tool] };
  if (os === 'windows' && pms.winget) {
    const id = tool === 'gh' ? 'GitHub.cli' : 'Git.Git';
    return { bin: 'winget', args: ['install', '--id', id, '-e', '--source', 'winget'] };
  }
  if (os === 'windows' && pms.choco) return { bin: 'choco', args: ['install', tool, '-y'] };
  return null;
}

// Official GitHub CLI steps for Debian/Ubuntu.
const GH_APT_SCRIPT = [
  'set -e',
  'sudo mkdir -p -m 755 /etc/apt/keyrings',
  'curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null',
  'sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg',
  'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null',
  'sudo apt-get update',
  'sudo apt-get install -y gh',
].join('\n');

// Where winget/choco put each tool on Windows. A fresh install updates the
// PATH in the registry, but NOT in this already-running process — so the
// post-install check would fail even after a successful install. Appending
// the known dir to process.env.PATH fixes this run (children inherit it).
const WINDOWS_INSTALL_DIRS = {
  git: ['C:\\Program Files\\Git\\cmd'],
  gh: ['C:\\Program Files\\GitHub CLI'],
};

async function refreshWindowsPath(tool) {
  if (osKind() !== 'windows') return;
  for (const dir of WINDOWS_INSTALL_DIRS[tool] || []) {
    if (existsSync(dir) && !(process.env.PATH || '').includes(dir)) {
      process.env.PATH = `${process.env.PATH};${dir}`;
    }
  }
}

async function installOrInstruct(tool, plan, { docsUrl, manualHint, verify, flags = {} } = {}) {
  const check = verify || (() => has(tool));
  if (plan) {
    ui.info(`Installing ${tool}: ${plan.bin} ${plan.args.join(' ')}`);
    const r = await runInherit(plan.bin, plan.args);
    if (r.ok) {
      await refreshWindowsPath(tool);
      if (await check()) {
        ui.success(`${tool} installed.`);
        return;
      }
    }
    ui.warn(`I couldn't install ${tool} automatically.`);
  } else {
    ui.warn(`No known package manager to install ${tool} automatically.`);
  }

  // `--yes` promises to ask NOTHING: a question here would hang the process
  // forever (CI, sandbox, any non-interactive stdin). Fail explicitly.
  if (flags.yes) {
    ui.error(
      [
        `${tool} is not installed and the auto-install failed — with --yes I can't ask.`,
        `Install it manually and run again:`,
        `  ${manualHint || `See: ${docsUrl}`}`,
      ].join('\n'),
    );
    process.exit(1);
  }

  ui.note(
    [
      `Install ${tool} manually:`,
      `  ${manualHint || `See: ${docsUrl}`}`,
      '',
      'When you are done, confirm to continue.',
    ].join('\n'),
    `Install ${tool}`,
  );
  const done = await ui.confirm({ message: `Have you installed ${tool}?`, initialValue: true });
  await refreshWindowsPath(tool);
  if (!done || !(await check())) {
    ui.error(`${tool} is still not available. Aborting.`);
    process.exit(1);
  }
  ui.success(`${tool} ready.`);
}

/**
 * `which git` is not enough on macOS: a fresh Mac ships /usr/bin/git as a
 * shim for the Xcode Command Line Tools, so git looks "installed" while it
 * cannot actually run. `git --version` is the real probe — and when the CLT
 * are missing it also makes macOS open the "Install Command Line Developer
 * Tools?" dialog, which IS the native git installer there.
 */
async function gitWorks() {
  if (!(await has('git'))) return false;
  return (await run('git', ['--version'])).ok;
}

async function ensureGit(pms, flags = {}) {
  ui.step('Checking Git…');
  if (await gitWorks()) {
    ui.success('Git installed.');
    return;
  }
  ui.warn('Git not found — installing…');
  await installOrInstruct('git', installPlan('git', pms), {
    docsUrl: 'https://git-scm.com/downloads',
    manualHint:
      osKind() === 'mac'
        ? 'xcode-select --install   (accept the "Install Command Line Developer Tools" dialog — it may already be on screen)'
        : undefined,
    verify: gitWorks,
    flags,
  });
}

async function ensureGh(pms, flags = {}, { requireAuth = true } = {}) {
  ui.step('Checking the GitHub CLI (gh)…');
  if (!(await has('gh'))) {
    ui.warn('gh not found — installing…');
    await installOrInstruct('gh', installPlan('gh', pms), {
      docsUrl: 'https://cli.github.com',
      manualHint:
        osKind() === 'linux'
          ? 'Signed repository: https://github.com/cli/cli/blob/trunk/docs/install_linux.md'
          : undefined,
      flags,
    });
  } else {
    ui.success('gh installed.');
  }

  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
    ui.success('gh authenticated (environment token).');
    return;
  }
  if ((await run('gh', ['auth', 'status'])).ok) {
    ui.success('gh authenticated.');
    return;
  }
  // With no push planned, the gh login is pure friction: the template and the
  // harness ALWAYS come through the community gate — gh only exists to create
  // the repo and push.
  if (!requireAuth) {
    ui.info('gh not logged in — that is fine: nothing will be sent to GitHub in this install.');
    return;
  }
  // `gh auth login` is interactive (opens the browser and waits): under --yes
  // it would hang the process. Same rule as the device flow in steps/auth.js.
  if (flags.yes) {
    ui.error(
      [
        'gh is not authenticated and --yes cannot open the interactive login.',
        'Run `gh auth login` once, or set GH_TOKEN in the environment.',
      ].join('\n'),
    );
    process.exit(1);
  }
  ui.warn('You need to log in to the GitHub CLI.');
  ui.info('Opening `gh auth login` — recommended: GitHub.com › HTTPS › login via browser.');
  await runInherit('gh', ['auth', 'login']);
  if (!(await run('gh', ['auth', 'status'])).ok) {
    ui.error('gh login not confirmed. Run `gh auth login` and run the installer again.');
    process.exit(1);
  }
  ui.success('gh authenticated.');
}

async function ensureVercel(pms, flags = {}) {
  ui.step('Checking the Vercel CLI…');
  if (!(await has('vercel'))) {
    ui.warn('vercel not found — installing…');
    await installOrInstruct('vercel', installPlan('vercel', pms), {
      docsUrl: 'https://vercel.com/docs/cli',
      flags,
    });
  } else {
    ui.success('vercel installed.');
  }

  if (process.env.VERCEL_TOKEN) {
    ui.success('vercel authenticated (VERCEL_TOKEN).');
    return;
  }
  const who = await run('vercel', ['whoami']);
  if (who.ok) {
    ui.success(`vercel authenticated (${who.stdout.trim()}).`);
    return;
  }
  // `vercel login` opens a device flow in the browser and waits —
  // impossible under --yes.
  if (flags.yes) {
    ui.error(
      [
        'vercel is not authenticated and --yes cannot open the interactive login.',
        'Run `vercel login` once, set VERCEL_TOKEN, or use --skip-deploy.',
      ].join('\n'),
    );
    process.exit(1);
  }
  ui.warn('You need to log in to the Vercel CLI.');
  ui.info('Opening `vercel login` — follow the instructions.');
  await runInherit('vercel', ['login']);
  if (!(await run('vercel', ['whoami'])).ok) {
    ui.error('vercel login not confirmed. Run `vercel login` and run the installer again.');
    process.exit(1);
  }
  ui.success('vercel authenticated.');
}
