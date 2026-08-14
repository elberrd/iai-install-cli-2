// Official skills + official CLIs for the chosen addons.
//
// "The CLI always helps a lot": for each chosen integration that HAS official
// tooling (Stripe, Sentry, Resend…) this step:
//   1. installs the official agent skills into the project (via the skills.sh
//      CLI, same mechanism as the Convex/Clerk/Cloudflare skills the template
//      already uses);
//   2. checks whether the official CLI is installed — offering to install it
//      via Homebrew/npm when it isn't;
//   3. offers the login (`stripe login`, `sentry-cli login`, `resend login`)
//      and shows the dashboard link where the keys live.
// Everything is best-effort and skippable — no failure here aborts the install.
import { ADDON_TOOLING } from '../config.js';
import { has, run, runInherit } from '../lib/proc.js';
import { installProjectSkills } from '../lib/skills.js';
import * as ui from '../lib/ui.js';

export async function setupIntegrations(ctx) {
  const chosen = ctx.addons ?? [];
  const withTooling = chosen.filter((id) => ADDON_TOOLING[id]);
  if (withTooling.length === 0) {
    ui.info('No chosen integration needs extra skills/CLIs.');
    return;
  }

  for (const id of withTooling) {
    const tooling = ADDON_TOOLING[id];

    // 1. Official skills → inside the project (registered in skills-lock.json).
    if (tooling.skills) {
      await installProjectSkills(ctx.dir, tooling.skills);
    }

    // No official tooling (e.g. Asaas) → point to the right links.
    if (tooling.note) {
      ui.note(tooling.note, `${id} — no official CLI`);
    }

    // 2 + 3. Official CLI: install (optional) and log in (optional).
    if (tooling.cli) {
      await ensureIntegrationCli(tooling.cli, ctx);
    }
  }
}

/**
 * (Optionally) ensures an integration's official CLI + login.
 * Exported: the stack step (steps/stack-docs.js) uses the SAME flow for the
 * CLIs of the chosen technologies (Neon, Supabase, wrangler, Vercel…).
 */
export async function ensureIntegrationCli(cli, ctx) {
  const { flags = {} } = ctx;

  // A CLI is only offered ONCE per install — the database provisioning step
  // (steps/stack-docs.js) may ensure it before the tooling step runs.
  ctx.cliEnsured ??= new Set();
  if (ctx.cliEnsured.has(cli.bin)) return;
  ctx.cliEnsured.add(cli.bin);

  if (await has(cli.bin)) {
    ui.success(`${cli.name} already installed.`);
  } else if (flags.yes) {
    ui.info(`${cli.name} not found. To install later: ${installHint(cli)}`);
    return;
  } else {
    const wants = await ui.confirm({
      message: `Install ${cli.name} now? (recommended — you and the agent will use it directly)`,
      initialValue: true,
    });
    if (!wants) {
      ui.info(`Ok. To install later: ${installHint(cli)}`);
      if (cli.dashboardUrl) ui.info(`Keys/dashboard: ${cli.dashboardUrl}`);
      return;
    }
    const ok = await installIntegrationCli(cli);
    if (!ok) {
      ui.warn(`Couldn't install ${cli.name}. Install manually: ${installHint(cli)}`);
      if (cli.dashboardUrl) ui.info(`Keys/dashboard: ${cli.dashboardUrl}`);
      return;
    }
    ui.success(`${cli.name} installed.`);
  }

  // Login (interactive only; opens the browser on the account already logged into Chrome).
  if (!flags.yes) {
    const login = await ui.confirm({
      message: `Log in now? (${cli.bin} ${cli.loginArgs.join(' ')} — ${cli.loginHint})`,
      initialValue: false,
    });
    if (login) {
      const r = await runInherit(cli.bin, cli.loginArgs);
      if (r.ok) ui.success(`${cli.name} authenticated.`);
      else ui.warn(`Login not confirmed. Run later: ${cli.bin} ${cli.loginArgs.join(' ')}`);
    }
  }
  if (cli.dashboardUrl) ui.info(`Keys/dashboard: ${cli.dashboardUrl}`);
}

/** Installs the CLI preferring Homebrew (macOS/Linux), falling back to npm -g / pip. */
async function installIntegrationCli(cli) {
  if (cli.install.brew && (await has('brew'))) {
    const r = await ui.spin(`brew install ${cli.install.brew}…`, () =>
      run('brew', ['install', cli.install.brew], { timeout: 300000 }),
    );
    if (r.ok && (await has(cli.bin))) return true;
  }
  if (cli.install.npm) {
    const r = await ui.spin(`npm install -g ${cli.install.npm}…`, () =>
      run('npm', ['install', '-g', cli.install.npm], { timeout: 300000 }),
    );
    if (r.ok && (await has(cli.bin))) return true;
  }
  // Python CLIs (e.g. Modal): pip3 first, then pip — whichever exists.
  if (cli.install.pip) {
    const pip = (await has('pip3')) ? 'pip3' : (await has('pip')) ? 'pip' : null;
    if (pip) {
      const r = await ui.spin(`${pip} install ${cli.install.pip}…`, () =>
        run(pip, ['install', cli.install.pip], { timeout: 300000 }),
      );
      if (r.ok && (await has(cli.bin))) return true;
    }
  }
  return false;
}

function installHint(cli) {
  const parts = [];
  if (cli.install.brew) parts.push(`brew install ${cli.install.brew}`);
  if (cli.install.npm) parts.push(`npm install -g ${cli.install.npm}`);
  if (cli.install.pip) parts.push(`pip install ${cli.install.pip}`);
  if (cli.install.docsUrl) parts.push(cli.install.docsUrl);
  return parts.join('  or  ') || '';
}
