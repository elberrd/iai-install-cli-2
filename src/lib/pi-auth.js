import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run, which } from './proc.js';
import * as ui from './ui.js';

const PI_AUTH = join(homedir(), '.pi', 'agent', 'auth.json');
// Pi migrated from @mariozechner/pi-coding-agent (frozen at 0.73.1) to
// @earendil-works/pi-coding-agent — installing via the old package delivers an
// already-outdated Pi. `pi update` migrates old installations on its own.
const PI_PACKAGE = '@earendil-works/pi-coding-agent';

/** Providers required when FIA roster uses Pi (Codex). */
export const PI_CODEX_PROVIDERS = ['openai', 'openai-codex'];

export async function hasPi() {
  return which('pi');
}

export function readPiAuth() {
  if (!existsSync(PI_AUTH)) return null;
  try {
    return JSON.parse(readFileSync(PI_AUTH, 'utf8'));
  } catch {
    return null;
  }
}

export function piProviderLoggedIn(provider) {
  const auth = readPiAuth();
  if (!auth) return false;
  const entry = auth[provider];
  if (!entry) return false;
  if (entry.type === 'oauth' && entry.access) return true;
  if (entry.type === 'api_key' && entry.key) return true;
  return Boolean(entry.refresh || entry.token);
}

export function piCodexReady() {
  return PI_CODEX_PROVIDERS.some((p) => piProviderLoggedIn(p));
}

// ensurePiReady runs in the preflight AND in setupFia ("harness only" mode
// does not go through the FIA preflight) — the memo avoids repeating the
// network version check.
let piEnsured = false;

/**
 * Ensure the Pi CLI is installed and up to date — WITHOUT any interactive
 * login. The Codex login is the LAST step, after the installation is done:
 * the final notes say exactly what to type (`pi` → /login openai-codex).
 * We never open Pi mid-install: a Ctrl+C there killed the installer with the
 * stamp half done.
 */
export async function ensurePiReady() {
  if (piEnsured) return;
  if (!(await hasPi())) {
    ui.info(`Installing Pi: npm install -g ${PI_PACKAGE}`);
    // Captured (not inherited) output on purpose: on failure we need stderr to
    // tell the REAL cause apart (EACCES on a system-owned npm prefix is the
    // classic one) instead of parroting the command that just failed.
    const r = await run('npm', ['install', '-g', PI_PACKAGE], { timeout: 300_000 });
    if (!r.ok || !(await hasPi())) {
      throw piInstallError(r);
    }
    ui.success('Pi installed.');
  } else {
    await updatePiIfOutdated();
  }
  piEnsured = true;
}

/**
 * Turn a failed `npm install -g` result into an error that explains the CAUSE
 * and the exact recovery. EACCES means npm's global folder belongs to the
 * system (Node installed system-wide) — the fix is reinstalling Node in user
 * space, NEVER `sudo npm` (root-owned files break every future npm install).
 * Exported for tests. `err.name === 'PiInstallError'` lets callers degrade
 * instead of aborting the whole installation.
 */
export function piInstallError(result = {}) {
  const output = `${result.stderr || ''}\n${result.stdout || ''}`;
  const denied = /EACCES|EPERM|permission denied/i.test(output);
  const err = new Error(
    denied
      ? [
          'Pi could not be installed: npm has no permission to write global packages (EACCES).',
          'Cause: Node.js was installed system-wide, so its npm folder belongs to the system.',
          'Do NOT run it with sudo. Fix it by reinstalling Node.js in your user account:',
          '  • official installer: https://nodejs.org (recommended)',
          '  • or nvm: https://github.com/nvm-sh/nvm',
          `Then run:  npm install -g ${PI_PACKAGE}`,
        ].join('\n')
      : [
          `Pi could not be installed (npm install -g ${PI_PACKAGE} failed).`,
          (result.stderr || result.stdout || '').trim().split('\n').slice(-3).join('\n') || 'No output from npm.',
          `Install it manually with:  npm install -g ${PI_PACKAGE}`,
        ].join('\n'),
  );
  err.name = 'PiInstallError';
  return err;
}

/**
 * Best-effort: `pi update` when the npm registry has a newer version.
 * Never fatal — without network (or with the update failing), we continue
 * with the current version.
 */
async function updatePiIfOutdated() {
  const installed = await piVersion();
  const latest = await latestPiVersion();
  if (!installed || !latest || !isNewer(latest, installed)) return;
  ui.info(`Updating Pi ${installed} → ${latest}…`);
  await run('pi', ['update'], { timeout: 180_000 });
  const now = await piVersion();
  if (now && !isNewer(latest, now)) {
    ui.success(`Pi updated (${now}).`);
  } else {
    ui.warn(`Could not update Pi automatically — continuing with ${installed}. Run \`pi update\` later.`);
  }
}

export async function piVersion() {
  const r = await run('pi', ['--version'], { timeout: 15_000 });
  return r.ok ? parseSemver(r.stdout || r.stderr) : null;
}

async function latestPiVersion() {
  const r = await run('npm', ['view', PI_PACKAGE, 'version'], { timeout: 8_000 });
  return r.ok ? parseSemver(r.stdout) : null;
}

/** First x.y.z found in the text (`pi --version` prints "pi vX.Y.Z"). */
export function parseSemver(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text));
  return m ? m[0] : null;
}

/**
 * Semver "a is newer than b", including prerelease precedence (impactus lives
 * on 2.0.0-alpha.N, so `x.y.z` alone would call every alpha bump "equal"):
 * core x.y.z compares numerically; on a tie a release beats a prerelease, and
 * prereleases compare dot-segment-wise (numeric segments numerically, the
 * rest as ASCII, numeric < alphanumeric — the semver spec order).
 */
export function isNewer(a, b) {
  return compareVersions(a, b) > 0;
}

function compareVersions(a, b) {
  const [coreA, preA] = splitPrerelease(a);
  const [coreB, preB] = splitPrerelease(b);
  const pa = coreA.split('.').map(Number);
  const pb = coreB.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  if (preA === null && preB === null) return 0;
  if (preA === null) return 1; // release > any prerelease of the same core
  if (preB === null) return -1;
  const sa = preA.split('.');
  const sb = preB.split('.');
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    if (sa[i] === undefined) return -1; // shorter prerelease is older
    if (sb[i] === undefined) return 1;
    const na = /^\d+$/.test(sa[i]) ? Number(sa[i]) : null;
    const nb = /^\d+$/.test(sb[i]) ? Number(sb[i]) : null;
    if (na !== null && nb !== null) {
      if (na !== nb) return na > nb ? 1 : -1;
    } else if (na !== null) {
      return -1; // numeric identifiers sort below alphanumeric ones
    } else if (nb !== null) {
      return 1;
    } else if (sa[i] !== sb[i]) {
      return sa[i] > sb[i] ? 1 : -1;
    }
  }
  return 0;
}

function splitPrerelease(version) {
  const s = String(version).trim();
  const dash = s.indexOf('-');
  if (dash === -1) return [s, null];
  return [s.slice(0, dash), s.slice(dash + 1)];
}

// pi-web-access gives child subagents real web tools (web_search,
// fetch_content, get_search_content) — the pi-subagents packaged `researcher`
// declares them in its allowlist and hard-fails without the provider. It is
// zero-config: Exa MCP needs no API key and Codex auth is reused when present.
export const PI_PACKAGES = ['pi-subagents', 'pi-mcp-adapter', 'pi-web-access'];

/**
 * The package a settings entry points AT — the npm name's last segment, or
 * the basename of a git/path source: `npm:@acme/pi-subagents@2.0.0`,
 * `git:github.com/acme/pi-subagents.git#main` and `file:../pi-subagents` all
 * identify `pi-subagents`; `npm:pi-subagents-extras@1.0.0` does NOT — a name
 * that merely CONTAINS ours is a different package.
 */
function sourcePackageIdentity(source) {
  const s = String(source)
    .replace(/^[a-z][\w+.-]*:/i, '') // protocol — npm:, git:, file:, https:…
    .replace(/[#?].*$/, ''); // git ref / query string
  const base = s.split(/[\\/]/).filter(Boolean).pop() || '';
  return base.replace(/\.git$/i, '').replace(/@[^@]*$/, ''); // version/tag spec
}

/**
 * Which of OUR packages a (re-)pin may refresh, name → 'refresh' | 'custom'.
 * `pi install` REPLACES a settings entry when the package name matches, so a
 * blind refresh would stomp an entry the student pointed somewhere else — a
 * fork, a git/path source, a dist-tag pin. Ownership rule: only an entry we
 * could have written ourselves (`npm:<name>` or `npm:<name>@x.y.z`) is ours
 * to move; any other source whose IDENTITY is the package (a scoped fork, a
 * git checkout, a dist-tag pin) is the student's and stays untouched.
 * Unrelated packages that merely contain the name never flag ours. An absent
 * entry is 'refresh' — installing the missing package is exactly what
 * install/update promise.
 */
export function piPackageRefreshPlan(settings) {
  const plan = Object.fromEntries(PI_PACKAGES.map((name) => [name, 'refresh']));
  const entries = Array.isArray(settings?.packages) ? settings.packages : [];
  for (const entry of entries) {
    const source = String((typeof entry === 'string' ? entry : entry?.source) ?? '');
    for (const name of PI_PACKAGES) {
      if (new RegExp(`^npm:${name}(@\\d+\\.\\d+\\.\\d+(?:-[\\w.-]+)?)?$`).test(source)) continue; // ours-shaped
      if (sourcePackageIdentity(source) === name) plan[name] = 'custom';
    }
  }
  return plan;
}

/**
 * Install (or refresh) the Pi extension packages, PINNED to the exact latest
 * npm version. The pin is the branding lever: Pi's startup update check skips
 * exact-pinned packages, so students never see the pi-branded "Package
 * Updates Available — run pi update --extensions" panel; `imp update` calls
 * this again, and Pi replaces a settings entry when the package name matches,
 * so the pin moves forward instead of piling up. Entries the student
 * customized (see piPackageRefreshPlan) are never overwritten — they come
 * back in `skipped` for the caller to report, with the manual command.
 * Offline (npm view failing) degrades to the unpinned source — the install
 * still works, Pi's own panel covers updates until the next pinned refresh.
 * @returns {Promise<{skipped: string[]}>}
 */
export async function installPiPackages(cwd) {
  const plan = piPackageRefreshPlan(readPiSettings());
  for (const name of PI_PACKAGES) {
    if (plan[name] === 'custom') continue;
    const view = await run('npm', ['view', name, 'version'], { timeout: 15_000 });
    const version = view.ok ? exactVersion(view.stdout) : null;
    const source = version ? `npm:${name}@${version}` : `npm:${name}`;
    const r = await run('pi', ['install', source], { cwd });
    if (!r.ok) {
      throw new Error(`Failed to install ${source}:\n${r.stderr || r.stdout}`);
    }
  }
  return { skipped: PI_PACKAGES.filter((name) => plan[name] === 'custom') };
}

/** The trimmed output of `npm view <pkg> version` iff it is an exact semver. */
function exactVersion(text) {
  const s = String(text ?? '').trim();
  return /^\d+\.\d+\.\d+(-[\w.-]+)?$/.test(s) ? s : null;
}

/**
 * Silent update probe for the `imp` launcher. `imp` starts Pi with
 * PI_SKIP_VERSION_CHECK=1 — Pi's startup notice is pi-branded ("Run pi
 * update"), which contradicts the imp-first workflow the harness teaches —
 * and prints these lines AFTER the session ends instead (printed before, the
 * TUI would immediately repaint over them). The other pi-branded panel
 * ("Package Updates Available") needs no suppression: the harness packages
 * are exact-pinned (see installPiPackages), which excludes them from Pi's own
 * check — their pins are compared here instead. Never rejects; resolves []
 * when offline, opted out (IMP_SKIP_VERSION_CHECK/PI_OFFLINE) or current.
 */
export async function collectUpdateNotices(installedImpactus) {
  if (process.env.PI_OFFLINE || process.env.IMP_SKIP_VERSION_CHECK) return [];
  const checks = [
    async () => {
      const latest = await npmLatest('impactus');
      return latest && isNewer(latest, installedImpactus) ? [`impactus ${installedImpactus} → ${latest}`] : [];
    },
    async () => {
      const [installed, latest] = await Promise.all([piVersion(), npmLatest(PI_PACKAGE)]);
      return installed && latest && isNewer(latest, installed) ? [`pi ${installed} → ${latest}`] : [];
    },
    async () => {
      const rows = await Promise.all(
        Object.entries(readPiPackagePins()).map(async ([name, pinned]) => {
          const latest = await npmLatest(name);
          return latest && isNewer(latest, pinned) ? `${name} ${pinned} → ${latest}` : null;
        }),
      );
      return rows.filter(Boolean);
    },
  ];
  const results = await Promise.all(checks.map((fn) => fn().catch(() => [])));
  return results.flat();
}

/** Latest published version of an npm package — respects the user's .npmrc. */
async function npmLatest(pkg) {
  const r = await run('npm', ['view', pkg, 'version'], { timeout: 10_000 });
  const version = r.ok ? String(r.stdout).trim() : '';
  return version || null;
}

/** Pi's user settings (~/.pi/agent/settings.json), or null when missing/unreadable. */
function readPiSettings() {
  try {
    return JSON.parse(readFileSync(join(homedir(), '.pi', 'agent', 'settings.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * State of each of OUR extension packages in Pi's user settings, for
 * `imp doctor`: 'pinned <x.y.z>' (ours, exact-pinned), 'custom' (the student
 * pointed it elsewhere — never touched) or 'missing' (not installed yet).
 */
export function piPackageStatus() {
  const settings = readPiSettings();
  const plan = piPackageRefreshPlan(settings);
  const pins = readPiPackagePins();
  const entries = Array.isArray(settings?.packages) ? settings.packages : [];
  const installed = new Set(
    entries
      .map((entry) => sourcePackageIdentity(String((typeof entry === 'string' ? entry : entry?.source) ?? '')))
      .filter((name) => PI_PACKAGES.includes(name)),
  );
  return Object.fromEntries(
    PI_PACKAGES.map((name) => {
      if (plan[name] === 'custom') return [name, 'custom'];
      if (pins[name]) return [name, `pinned ${pins[name]}`];
      // Present but unpinned: the offline fallback of installPiPackages —
      // installed, just waiting for the next online `imp update` to pin it.
      return [name, installed.has(name) ? 'unpinned' : 'missing'];
    }),
  );
}

/** The exact-version pins of our packages in Pi's user settings, name → pin. */
function readPiPackagePins() {
  const pins = {};
  const packages = readPiSettings()?.packages;
  for (const entry of Array.isArray(packages) ? packages : []) {
    const source = typeof entry === 'string' ? entry : entry?.source;
    const m = /^npm:([\w-]+)@(\d+\.\d+\.\d+(?:-[\w.-]+)?)$/.exec(String(source ?? ''));
    if (m && PI_PACKAGES.includes(m[1])) pins[m[1]] = m[2];
  }
  return pins;
}

/**
 * Make `imp` (the impactus brand launcher) real on PATH. Students run
 * `npx impactus`, and npx leaves NO bin behind — without a global install the
 * final notes could only instruct `pi`. Installs impactus@latest globally
 * (same semantics as `imp update`), skips when `imp` already exists, and NEVER
 * fails the installation — the caller records the result in ctx.impGlobal and
 * the final notes fall back to `pi` wording when it is false.
 * @returns {Promise<boolean>} true when `imp` is usable on PATH.
 */
export async function ensureImpGlobal() {
  if (await which('imp')) return true;
  try {
    await ui.spin(
      'Installing the `imp` command (npm install -g impactus)…',
      async () => {
        const r = await run('npm', ['install', '-g', 'impactus@latest'], { timeout: 300_000 });
        if (!r.ok || !(await which('imp'))) {
          throw new Error(`npm install -g impactus failed:\n${(r.stderr || r.stdout || '').trim()}`);
        }
      },
      '`imp` command installed (global).',
    );
    return true;
  } catch {
    ui.warn(
      'The global `imp` command could not be installed — nothing else is affected: ' +
        'open the agent with `pi` (same thing, without the banner). ' +
        'To get `imp` later, run: npm install -g impactus',
    );
    return false;
  }
}
