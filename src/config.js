// Central configuration for the impactus installer.

// ── Community (student gate via device flow — sign-in is OPTIONAL) ───────────
// Signing in (ACTIVE subscription) unlocks the full installer; without it the
// CLI still delivers the harness + FIA ("guest mode" — steps/auth.js) but
// nothing from the templates. Login uses the OAuth 2.0 Device Authorization
// Grant (RFC 8628) against the /api/cli/* endpoints served by the community's
// Convex deployment (.convex.site); template AND harness are downloaded
// through it (tarball) — the harness even without a token, the templates only
// with one. The student never needs GitHub access, and the CLI has no
// direct-clone path.
//
// `apiBase` must point to the community's PRODUCTION deployment — the same one
// the www.impactus.academy site uses (verified against the production bundle).
// Override in dev/test: env IMPACTUS_API=https://<deployment>.convex.site
// (legacy CREATE_IAI_API still accepted) or the --api <url> flag.
// `checkoutUrl` is shown when access is inactive.
export const COMMUNITY = {
  name: 'IAI Cursos',
  apiBase: 'https://tidy-dodo-19.convex.site',
  checkoutUrl: 'https://www.impactus.academy',
};

// CLI token stored locally (~/.impactus-cli/auth.json, permission 600).
export const AUTH_FILE = 'auth.json';

// State folder in the home directory: token, keys pasted in the UI, and run
// logs. Installs made before the rebrand used `.create-iai` —
// src/lib/state-dir.js RENAMES that folder on first touch, so tokens, keys
// and logs survive without a re-login.
export const STATE_DIR = '.impactus-cli';
export const LEGACY_STATE_DIR = '.create-iai';

// ── Template catalog ─────────────────────────────────────────────────────────
// Single source of the installable templates. Downloads are ALWAYS gated: the
// CLI requests the template by `id` from the community API (paid-student
// token) — there is no direct GitHub clone. Each entry declares:
//   repo      — GitHub "owner/repo" served by the community BACKEND
//               (documentational here; the allowlist lives on the server);
//   available — publication gate: false hides/errors without a CLI release;
//   strip     — folders removed after download (development leftovers);
//   requires  — capabilities the pipeline turns on (see src/lib/pipeline.js):
//               'convex' | 'clerk' | 'shadcn' | 'storage' | 'mcps';
//   tenancy   — maps the legacy --tenancy flag and decides multi JWT/webhooks.
// To add a template: new entry here + repo in the community backend allowlist
// (cli-paid-gate.md, private impactus-internal-docs repo) — addons come from
// the template itself
// (template.addons.json, optional `groups`/`presets` fields).
// `label` is the friendly name (web UI + terminal); `badge` is the technical
// term shown as a tag next to the name; `description` is the plain-language
// card text for the web UI (the shorter `hint` goes in the terminal select).
export const TEMPLATES = {
  live1: {
    id: 'live1',
    repo: 'elberrd/live1',
    label: 'Custom system',
    badge: 'Single-tenant SaaS',
    hint: 'one app for a single business — the simplest base (Live 1)',
    description:
      'A system for one business or internal use: every user shares the same space. The simplest base — it is the Live 1 project.',
    available: true,
    strip: ['packages'],
    requires: ['convex', 'clerk', 'shadcn', 'storage', 'mcps'],
    tenancy: 'single',
  },
  live2: {
    id: 'live2',
    repo: 'elberrd/live2',
    label: 'Multi-company SaaS',
    badge: 'Multi-tenant SaaS',
    hint: 'each client company with separate data and billing + /admin (Live 2)',
    description:
      'A product to sell to multiple companies: each one with its own data, users, and billing, plus an /admin panel for you to manage everything. It is the Live 2 project.',
    available: true,
    strip: ['packages'],
    requires: ['convex', 'clerk', 'shadcn', 'storage', 'mcps'],
    tenancy: 'multi',
  },
};

export const DEFAULT_TEMPLATE_ID = 'live1';

// Harness — optional agent-workflow scaffold (/start, /dev, /sv, /test-ui, …)
// merged INTO the generated project as the last install step. Private
// repository, downloaded EXCLUSIVELY through the community's API — served
// even WITHOUT a token (the free tier: guests install harness + FIA); there
// is no direct GitHub clone.
// Merge rules (see src/steps/harness.js):
//   - files that already exist in the project are NEVER overwritten;
//   - the harness README.md is saved as imp/HARNESS.md (the project README wins);
//   - the harness AGENTS.md is APPENDED to the project's AGENTS.md between
//     harness markers, so both instruction sets coexist.
export const HARNESS = {
  // The harness guide lives inside imp/ — the project root stays clean
  // (only agent-discovery files like .claude/.cursor/.pi/AGENTS.md remain there).
  readmeAs: 'imp/HARNESS.md',
  markerStart: '<!-- harness-start -->',
  markerEnd: '<!-- harness-end -->',
  // Paths a template MAY own. The harness is the single source of the agent
  // material; a harness copy is only discarded (full mode) when the installed
  // template actually shipped that exact path — the template's variant wins
  // THERE, and the harness merge won't assemble a mixed version (the per-file
  // cp could add files that only exist in the harness variant). Every path
  // the template did not ship — and everything in harness-only mode — comes
  // from the harness.
  // (The asaas skill belongs to an addon and lives only in the templates.)
  templateOwnedPaths: ['frontend-profissional', 'design-system', 'security', 'backend-profissional'].flatMap(
    (skill) => [`.claude/skills/${skill}`, `.cursor/skills/${skill}`],
  ),
};

// FIA — the IAI Agent Factory (deterministic FDA runner + Pi config)
// Stamped from bundled templates; merge is non-destructive (skip existing files).
// Installed under `imp/` in the project (the impactus folder — the FIA runtime,
// HARNESS.md and iai.config.json all live there; the root keeps only the
// agent-discovery files). Projects stamped by older versions used `fia/` —
// `migrateLegacyFiaLayout` (src/steps/update-runtime.js) renames them.
export const FIA = {
  fiaTemplateDir: 'fia-templates',
  piTemplateDir: 'pi-templates/.pi',
  // The folder the FIA template tree is stamped into (project-root relative).
  runtimeDir: 'imp',
  gitignoreEntries: [
    'imp/node_modules/',
    'imp/data/sessions/',
    'imp/data/fia.db',
    'imp/data/fia.db-wal',
    'imp/data/fia.db-shm',
    'imp/data/backups/',
    'imp/data/handoff/',
    'imp/.runtime-backup-*/',
  ],
  // Runtime update contract (`--update-runtime`). The stamp records a manifest
  // (sha1 per stamped file); a later update compares the on-disk sha against it
  // to tell "unmodified since stamp" (safe overwrite) from "edited by the
  // student" (confirm / --force, always with a backup).
  runtimeManifest: 'imp/.runtime-manifest.json',
  runtimeBackupPrefix: 'imp/.runtime-backup-',
  // Paths `--update-runtime` may add/overwrite (project-root relative;
  // trailing slash = whole folder, `*` = one path segment). Everything else
  // the templates ship — imp/fia.config.yaml (the student's roster) and
  // imp/data/ (editable agent prompts, runtime DB) — is user material and is
  // NEVER touched by the update.
  runtimeUpdatablePaths: [
    'imp/modules/',
    'imp/fda_*.mjs',
    'imp/scripts/',
    'imp/package.json',
    '.pi/skills/fia/',
    '.pi/prompts/',
    '.pi/extensions/',
  ],
  npmScripts: {
    'fda:demo': 'node imp/fda_prompt.mjs "Summarize this repo in one sentence" --agent scout',
    'fda:quality': 'node imp/fda_quality.mjs "quality gate"',
    'fda:sessions': 'node imp/scripts/fia-query.mjs sessions',
    'fda:phases': 'node imp/scripts/fia-query.mjs phases',
    'fda:tail': 'node imp/scripts/fia-query.mjs tail',
    'fda:viewer': 'node imp/scripts/fia-viewer.mjs',
    // "Plan" tab of the viewer: everything /map created (screens, tasks, design system).
    plan: 'node imp/scripts/fia-viewer.mjs --view plan',
    // "Agents" tab: see and edit which engine/model each FDA agent uses.
    agents: 'node imp/scripts/fia-viewer.mjs --view agents',
    // Launch readiness (read-only): blockers/warnings before publishing.
    'launch:check': 'node imp/scripts/fia-launch-check.mjs',
    // Dev-env preflight (read-only): the keys the declared stack needs in .env.local.
    'env:check': 'node imp/scripts/env-preflight.mjs',
    // Single-run lock probe (read-only): is an FDA active in this repo right now?
    'fda:status': 'node imp/scripts/fda-lock.mjs status',
    // Pathspec-limited commit of ai-docs/ artifacts (docs only, refuses mid-FDA).
    'docs:commit': 'node imp/scripts/docs-commit.mjs',
    // Continue the newest interactive Pi conversation in the `claude` CLI
    // (continuation prompt + transcript on disk — works while Codex is down).
    handoff: 'node imp/scripts/handoff.mjs',
    // Terminal dashboard (read-only): tasks, specs, milestones and runs in the
    // terminal — the TUI twin of the web viewer (decision record: tui-plan.md,
    // private impactus-internal-docs repo).
    tui: 'node imp/scripts/fia-tui.mjs',
  },
};

// Impeccable (impeccable.style) — open-source design skill (Apache-2.0, no
// account/key; runs within the subscriptions). Installed via `npx impeccable`
// at PROJECT scope. Always `--no-hooks`: its PostToolUse hook writes to
// `.impeccable/` on every edit, which the FDA permission gate would revert as
// an external change on every phase. The `/impeccable …` commands remain
// available in interactive sessions (Claude Code, Cursor, and Pi).
export const IMPECCABLE = {
  package: 'impeccable@latest',
  // `engines.node` of the impeccable package — the CLI floor matches it
  // (>= 22.12) since the Ink 7 migration, so the skip below is vestigial.
  minNode: '22.12.0',
  // Base providers: the harness always stamps .claude/ and .cursor/; `pi` is
  // added when FIA was installed.
  baseProviders: ['claude', 'cursor'],
  installedMarker: '.claude/skills/impeccable',
};

// MCP servers to register in the generated project via the Claude Code CLI.
// `add` uses `claude mcp add <name> <cmd> [args...]`.
// `addJson` uses `claude mcp add-json <name> '<json>'`.
export const MCPS = [
  {
    name: 'playwright',
    // `--` keeps `-y` out of claude's own flag parsing; without `-y`, npx asks
    // "Ok to proceed?" on a cold cache and the MCP stdio channel dies
    // ("Connection closed" — the classic first-run-on-Windows report).
    args: ['mcp', 'add', 'playwright', '--', 'npx', '-y', '@playwright/mcp@latest'],
  },
  {
    name: 'convex',
    args: [
      'mcp',
      'add-json',
      'convex',
      JSON.stringify({ command: 'npx', args: ['-y', 'convex@latest', 'mcp', 'start'] }),
    ],
  },
];

// shadcn/ui — preset (visual) + ready-made blocks.
// The template already ships with shadcn/ui configured; this step lets you
// apply a custom preset (generated at ui.shadcn.com/create → "Get Code") and
// choose which block to install. `defaultBlock` keeps the classic behavior
// (`npx shadcn@latest add sidebar-07`) as the pre-selected option.
export const SHADCN = {
  defaultBlock: 'sidebar-07',
  blocks: [
    { name: 'sidebar-07', description: 'sidebar that collapses to icons' },
    { name: 'dashboard-01', description: 'dashboard with sidebar, charts, and data table' },
    { name: 'sidebar-01', description: 'simple sidebar with section navigation' },
    { name: 'login-01', description: 'simple login page' },
  ],
  blocksUrl: 'https://ui.shadcn.com/blocks',
  createUrl: 'https://ui.shadcn.com/create',
};

// The Clerk JWT template Convex expects. convex/auth.config.ts pins
// applicationID:"convex", which must equal this template's `aud` claim, and
// Convex looks up the token template by this exact name.
export const CLERK_JWT_TEMPLATE = {
  name: 'convex',
  claims: { aud: 'convex' },
  lifetime: 3600,
};

// live2 (multi-tenant) uses the SAME simple template: organizations belong to
// the APP (Convex tables — organizations/memberships), not to Clerk. The JWT
// only authenticates identity; the active organization comes from
// `users.activeOrgId` in the database. No org claims.

export const ENV_FILE = '.env.local';
export const ENV_EXAMPLE = '.env.example';

// ── Addons ───────────────────────────────────────────────────────────────────
// The template ships with EVERY addon implemented and wired. At install time
// the user picks what to keep; `src/steps/addons.js` then REMOVES everything
// that wasn't chosen, guided by the template's `template.addons.json` manifest
// (files to delete, package.json deps/scripts to prune, `live1:addon:<id>`
// marker blocks to strip). This keeps generated projects clean — no dead code,
// no unused dependencies.
export const ADDONS_MANIFEST_FILE = 'template.addons.json';
// Lives inside imp/ (the impactus folder). Readers fall back to the legacy
// root-level `iai.config.json` for projects installed by older versions.
export const ADDONS_CONFIG_FILE = 'imp/iai.config.json';
export const LEGACY_ADDONS_CONFIG_FILE = 'iai.config.json';

// Prompt groups (multiselect unless `single`). `recommended` = pre-selected in
// interactive mode AND the default under `--yes`.
export const ADDON_GROUPS = [
  {
    id: 'quality',
    flag: 'addons',
    title: 'Quality & DX',
    options: [
      { value: 'commitlint', label: 'Commitlint', hint: 'Conventional Commits on commit-msg', recommended: true },
      { value: 'knip', label: 'Knip', hint: 'detects dead dependencies/files (npm run check:deps)', recommended: true },
      { value: 'analyzer', label: 'Bundle analyzer', hint: 'npm run build-stats', recommended: true },
    ],
  },
  {
    id: 'observability',
    flag: 'observability',
    title: 'Observability',
    options: [
      { value: 'sentry', label: 'Sentry', hint: 'error monitoring + Spotlight in dev', recommended: true },
      { value: 'logging', label: 'Structured logging', hint: 'LogTape (JSON in production)', recommended: false },
    ],
  },
  {
    id: 'analytics',
    flag: 'analytics',
    title: 'Analytics',
    single: true,
    options: [
      { value: 'none', label: 'None', recommended: true },
      { value: 'posthog', label: 'PostHog', hint: 'product analytics + feature flags' },
      { value: 'vercel-analytics', label: 'Vercel Analytics', hint: 'simple web analytics' },
    ],
  },
  {
    id: 'security',
    flag: 'security',
    title: 'Security',
    options: [
      { value: 'csp', label: 'Full CSP', hint: 'Content-Security-Policy ready for Clerk+Convex', recommended: true },
      { value: 'rate-limit', label: 'Rate limiting', hint: 'per-user limits on mutations (Convex)', recommended: true },
    ],
  },
  {
    id: 'emails',
    flag: 'emails',
    title: 'Transactional emails',
    single: true,
    options: [
      { value: 'none', label: 'None', recommended: true },
      { value: 'resend', label: 'Resend', hint: 'welcome email via Convex component' },
    ],
  },
  {
    id: 'platform',
    flag: 'platform',
    title: 'Platform',
    options: [
      {
        value: 'notifications',
        label: 'In-app notifications',
        hint: 'bell in the header + typed registry (email channel alongside Resend)',
        recommended: false,
      },
    ],
  },
  {
    id: 'payments',
    flag: 'payments',
    title: 'Payments',
    single: true,
    options: [
      { value: 'none', label: 'None', recommended: true },
      { value: 'stripe', label: 'Stripe', hint: 'checkout + portal + webhook → Convex' },
      { value: 'asaas', label: 'Asaas', hint: 'Pix/boleto/card (BR) — subscription + webhook' },
      { value: 'clerk-billing', label: 'Clerk Billing', hint: 'PricingTable hosted by Clerk' },
    ],
  },
];

// Every selectable addon id (derived from the groups above).
export const ALL_ADDON_IDS = ADDON_GROUPS.flatMap((g) =>
  g.options.map((o) => o.value).filter((v) => v !== 'none'),
);

// `--preset` shortcuts. `padrao` mirrors the recommended set.
export const ADDON_PRESETS = {
  minimo: [],
  padrao: ADDON_GROUPS.flatMap((g) =>
    g.options.filter((o) => o.recommended && o.value !== 'none').map((o) => o.value),
  ),
  saas: [
    'commitlint',
    'knip',
    'analyzer',
    'sentry',
    'logging',
    'posthog',
    'csp',
    'rate-limit',
    'notifications',
    'resend',
    'stripe',
  ],
};

// `completo` predates the english-first rename and was always identical to
// `saas`. It stays resolvable (old commands/configs keep working — parseArgs
// normalizes it with a deprecation warning) but is NON-enumerable so preset
// pickers built from Object.keys() no longer list it.
Object.defineProperty(ADDON_PRESETS, 'completo', { value: ADDON_PRESETS.saas, enumerable: false });

// Post-install pointers shown in the final summary for addons that still need
// an external account/key to fully activate (everything degrades gracefully
// until then).
export const ADDON_NOTES = {
  sentry: 'Sentry: create the project at sentry.io and fill NEXT_PUBLIC_SENTRY_DSN in .env.local. Local dev: npm run dev:spotlight (http://localhost:8969).',
  posthog: 'PostHog: create the project at posthog.com and fill NEXT_PUBLIC_POSTHOG_KEY in .env.local.',
  resend:
    'Resend: npx convex env set RESEND_API_KEY re_...  (test mode active until RESEND_TEST_MODE=false). For production, verify a domain and also set EMAIL_FROM ("Name <noreply@your-domain.com>") on Convex. Keys: https://resend.com/api-keys',
  stripe: 'Stripe: set STRIPE_SECRET_KEY, STRIPE_PRICE_ID, STRIPE_WEBHOOK_SECRET, and SITE_URL on Convex (npx convex env set ...) and point the webhook to <deployment>.convex.site/stripe-webhook. Keys: https://dashboard.stripe.com/apikeys',
  asaas:
    'Asaas: set ASAAS_API_KEY, ASAAS_VALUE, ASAAS_WEBHOOK_TOKEN, and ASAAS_ENV (production to hit the real API; without it the sandbox is used) on Convex (npx convex env set ...) and create the webhook pointing to <deployment>.convex.site/asaas-webhook. Sandbox: https://sandbox.asaas.com · API key: Minha Conta → Integrações → API.',
  'clerk-billing': 'Clerk Billing: enable Billing in the Clerk dashboard and create the plans — the /dashboard/billing page already renders the PricingTable.',
};

// ── Per-addon tooling: official skills + official CLI ────────────────────────
// Researched in the official docs (Jul/2026). Each entry may have:
//   skills — source for `npx skills add` (empty list = ALL skills from the source)
//   cli    — official binary: how to install, how to log in, where the keys live
//   note   — notice when no official tooling exists (e.g., Asaas is REST-only)
export const ADDON_TOOLING = {
  stripe: {
    skills: { label: 'Stripe', source: 'https://docs.stripe.com', skills: [] },
    cli: {
      bin: 'stripe',
      name: 'Stripe CLI',
      install: { brew: 'stripe/stripe-cli/stripe', docsUrl: 'https://docs.stripe.com/stripe-cli#install' },
      loginArgs: ['login'],
      loginHint: 'opens the browser to pair with your Stripe account',
      dashboardUrl: 'https://dashboard.stripe.com/apikeys',
    },
  },
  sentry: {
    // The source has ~35 skills (SDKs for every platform) — we install only
    // the ones relevant to this Next.js stack.
    skills: {
      label: 'Sentry',
      source: 'getsentry/sentry-for-ai',
      skills: ['sentry-nextjs-sdk', 'sentry-get-started', 'sentry-debug-issue', 'sentry-fix-issues'],
    },
    cli: {
      bin: 'sentry-cli',
      name: 'Sentry CLI',
      install: { npm: '@sentry/cli', brew: 'getsentry/tools/sentry-cli', docsUrl: 'https://docs.sentry.io/cli/installation/' },
      loginArgs: ['login'],
      loginHint: 'opens the browser to create the auth token',
      dashboardUrl: 'https://sentry.io/settings/auth-tokens/',
    },
  },
  resend: {
    skills: { label: 'Resend', source: 'resend/resend-skills', skills: [] },
    cli: {
      bin: 'resend',
      name: 'Resend CLI',
      install: { npm: 'resend-cli', brew: 'resend/cli/resend', docsUrl: 'https://resend.com/docs/cli' },
      loginArgs: ['login'],
      loginHint: 'opens the browser (or use: resend login --key re_...)',
      dashboardUrl: 'https://resend.com/api-keys',
    },
  },
  asaas: {
    note: [
      'Asaas has no official CLI or skills — the integration is 100% REST API.',
      'The PROJECT skill (.claude/skills/asaas/SKILL.md) already ships in the',
      'template with the API mapped (customers, subscriptions, webhooks, sandbox).',
      '',
      'Accounts: production https://www.asaas.com  ·  sandbox https://sandbox.asaas.com',
      'API key: dashboard → Minha Conta → Integrações → API',
    ].join('\n'),
  },
};

// ── External services: keys, automation, and AI prompts ──────────────────────
// Single source of truth for HOW each external service in the template
// (Clerk, Convex, Stripe, Asaas, Resend, Sentry, PostHog, R2) gets activated.
// Feeds three consumers:
//   1. the web UI (--ui): "Integrations & keys" cards with the copyable AI
//      prompt and the fields to paste the keys (saved only on the machine);
//   2. the `steps/service-keys.js` step: applies the keys (Convex env/.env.local),
//      creates webhooks via API, and prints the same prompts in the terminal;
//   3. the tests — which guarantee the env names match the template.
//
// `when`  — when the service is relevant: { always } | { addon } | { storage }.
// `setup` — 'auto' (the CLI does everything at install), 'partial' (part is
//           automatic) or 'keys' (needs dashboard keys — optional, degrades
//           gracefully).
// `purpose` — one PLAIN-LANGUAGE sentence saying what the service does in the
//   app (web UI).
// `envs[].source` — where the value comes from:
//   'dashboard' → the service dashboard (goes into the AI prompt and the
//                 requested return);
//   'user'      → user decision (field with a default; not in the prompt);
//   'generate'  → generated locally (e.g., webhook token);
//   'auto'      → the CLI itself sets it during install.
// `envs[].target` — where the key is written: 'convex' (deployment, mirrored
//   into .env.local for documentation) or 'local' (.env.local, read by Next.js).
export const SERVICES = [
  {
    id: 'clerk',
    label: 'Clerk (authentication)',
    when: { always: true },
    setup: 'auto',
    autoNote:
      'App, keys, and the "convex" JWT template are created automatically by the CLI — you only confirm the login in the browser. The user-sync webhook is offered during install.',
    dashboardUrl: 'https://dashboard.clerk.com',
    envs: [],
  },
  {
    id: 'convex',
    label: 'Convex (backend + database)',
    when: { always: true },
    setup: 'auto',
    autoNote: 'Project and dev deployment created automatically (browser login).',
    dashboardUrl: 'https://dashboard.convex.dev',
    envs: [],
  },
  {
    id: 'stripe',
    label: 'Stripe (payments)',
    purpose: 'Charge card subscriptions inside your app.',
    when: { addon: 'stripe' },
    setup: 'keys',
    dashboardUrl: 'https://dashboard.stripe.com/test/apikeys',
    keyNote: 'TEST MODE only (sk_test_…) in development — never use live keys here.',
    envs: [
      {
        key: 'STRIPE_SECRET_KEY',
        label: 'Secret key (test mode)',
        target: 'convex',
        secret: true,
        source: 'dashboard',
        pattern: '^(sk|rk)_test_[A-Za-z0-9]+$',
        patternHint: 'sk_test_…',
        hint: 'Developers → API keys (with Test mode ON)',
      },
      {
        key: 'STRIPE_PRICE_ID',
        label: 'Price ID (recurring price)',
        target: 'convex',
        source: 'dashboard',
        pattern: '^price_[A-Za-z0-9]+$',
        patternHint: 'price_…',
        hint: 'Product catalog → your product → recurring price',
      },
      {
        key: 'STRIPE_WEBHOOK_SECRET',
        label: 'Webhook signing secret',
        target: 'convex',
        secret: true,
        source: 'auto',
        pattern: '^whsec_[A-Za-z0-9]+$',
        autoHint: 'the CLI creates the /stripe-webhook endpoint via API at install and captures the secret',
      },
      {
        key: 'SITE_URL',
        label: 'Public app URL',
        target: 'convex',
        source: 'auto',
        default: 'http://localhost:3000',
        autoHint: 'set to http://localhost:3000 (dev)',
      },
    ],
    prompt: {
      url: 'https://dashboard.stripe.com',
      steps: [
        'Turn on TEST MODE (the "Test mode" toggle, top right of the dashboard). All steps below happen in test mode.',
        'Go to Developers → API keys and copy the TEST "Secret key" (starts with sk_test_). If hidden, click "Reveal test key".',
        'Go to Product catalog → "+ Add product". Create the product "{{PROJECT}} Subscription" with a monthly RECURRING price (e.g., $49.90). Save.',
        'Open the created product and copy the price ID (starts with price_ — it is on the price row, "…" menu → "Copy price ID").',
      ],
      rules: [
        'NEVER turn off Test mode, never create or reveal live-mode keys (sk_live_).',
        'Do not change any other account settings.',
      ],
    },
  },
  {
    id: 'asaas',
    label: 'Asaas (Pix/boleto/card)',
    purpose: 'Charge subscriptions via Pix, boleto, or card (Brazil).',
    when: { addon: 'asaas' },
    setup: 'keys',
    dashboardUrl: 'https://www.asaas.com',
    envs: [
      {
        key: 'ASAAS_API_KEY',
        label: 'API key',
        target: 'convex',
        secret: true,
        source: 'dashboard',
        pattern: '^\\$?aact_[A-Za-z0-9_:=]+$',
        patternHint: '$aact_…',
        hint: 'dashboard → Minha Conta → Integrações → API',
      },
      {
        key: 'ASAAS_ENV',
        label: 'Environment (production or sandbox)',
        target: 'convex',
        source: 'user',
        default: 'production',
        pattern: '^(production|sandbox)$',
        patternHint: 'production | sandbox',
        hint: 'production uses api.asaas.com; sandbox is the test environment',
      },
      {
        key: 'ASAAS_VALUE',
        label: 'Monthly subscription amount',
        target: 'convex',
        source: 'user',
        default: '49.90',
        pattern: '^\\d+([.]\\d{1,2})?$',
        patternHint: 'e.g.: 49.90',
      },
      {
        key: 'ASAAS_WEBHOOK_TOKEN',
        label: 'Webhook token (generated locally)',
        target: 'convex',
        secret: true,
        source: 'generate',
        autoHint: 'randomly generated — the webhook created at install uses the same value',
      },
      {
        key: 'SITE_URL',
        label: 'Public app URL',
        target: 'convex',
        source: 'auto',
        default: 'http://localhost:3000',
        autoHint: 'set to http://localhost:3000 (dev)',
      },
    ],
    prompt: {
      url: 'https://www.asaas.com',
      steps: [
        'Do the flow in the PRODUCTION account (https://www.asaas.com). (If I ask for sandbox, use https://sandbox.asaas.com — everything else is the same.)',
        'Go to Minha Conta → Integrações → API.',
        'Generate (or copy, if it already exists) the API key — it starts with $aact_.',
      ],
      rules: ['Do not create charges or change customer data — only copy the API key.'],
    },
  },
  {
    id: 'resend',
    label: 'Resend (transactional emails)',
    purpose: 'Send automatic emails from the app (e.g., welcome email).',
    when: { addon: 'resend' },
    setup: 'keys',
    dashboardUrl: 'https://resend.com/api-keys',
    keyNote:
      'The template starts in test mode (delivery only to your Resend account email). For production: verify a domain and set EMAIL_FROM and RESEND_TEST_MODE=false.',
    envs: [
      {
        key: 'RESEND_API_KEY',
        label: 'API key',
        target: 'convex',
        secret: true,
        source: 'dashboard',
        pattern: '^re_[A-Za-z0-9_]+$',
        patternHint: 're_…',
        hint: 'resend.com → API Keys → Create',
      },
      {
        key: 'SITE_URL',
        label: 'Public app URL (links in emails)',
        target: 'convex',
        source: 'auto',
        default: 'http://localhost:3000',
        autoHint: 'set to http://localhost:3000 (dev)',
      },
    ],
    prompt: {
      url: 'https://resend.com/api-keys',
      steps: [
        'Click "Create API Key". Name: "{{PROJECT}} (impactus)". Permission: "Sending access". Domain: All domains.',
        'Copy the created key (starts with re_ — it is shown only ONCE).',
      ],
      rules: ['Do not delete or change existing keys.'],
    },
  },
  {
    id: 'sentry',
    label: 'Sentry (error monitoring)',
    purpose: 'Alert you when the app errors out for some user.',
    when: { addon: 'sentry' },
    setup: 'keys',
    dashboardUrl: 'https://sentry.io',
    envs: [
      {
        key: 'NEXT_PUBLIC_SENTRY_DSN',
        label: 'Project DSN',
        target: 'local',
        source: 'dashboard',
        pattern: '^https://[^\\s@]+@[^\\s]+/\\d+$',
        patternHint: 'https://…@…ingest…sentry.io/…',
        hint: 'Settings → Projects → your project → Client Keys (DSN)',
      },
    ],
    prompt: {
      url: 'https://sentry.io',
      steps: [
        'If it does not exist yet, create a project: Projects → "Create Project" → Next.js platform → name "{{PROJECT}}". You can skip the SDK install step (the project already ships configured).',
        'Open the project → Settings → Client Keys (DSN) and copy the DSN (URL https://…@…ingest…/…).',
      ],
      rules: ['Do not invite members or change organization settings.'],
    },
  },
  {
    id: 'posthog',
    label: 'PostHog (product analytics)',
    purpose: 'Show how people use your app (statistics).',
    when: { addon: 'posthog' },
    setup: 'keys',
    dashboardUrl: 'https://app.posthog.com',
    envs: [
      {
        key: 'NEXT_PUBLIC_POSTHOG_KEY',
        label: 'Project API key',
        target: 'local',
        source: 'dashboard',
        pattern: '^phc_[A-Za-z0-9]+$',
        patternHint: 'phc_…',
        hint: 'Settings → Project → Project API Key',
      },
      {
        key: 'NEXT_PUBLIC_POSTHOG_HOST',
        label: 'Region host',
        target: 'local',
        source: 'dashboard',
        default: 'https://us.i.posthog.com',
        pattern: '^https://[a-z]+\\.i\\.posthog\\.com$',
        patternHint: 'https://us.i.posthog.com or https://eu.i.posthog.com',
      },
    ],
    prompt: {
      url: 'https://app.posthog.com',
      steps: [
        'If it does not exist yet, create a project named "{{PROJECT}}" (you can skip the install onboarding).',
        'Go to Settings → Project and copy the "Project API Key" (starts with phc_).',
        'Also note the account region: US → https://us.i.posthog.com · EU → https://eu.i.posthog.com.',
      ],
      rules: ['Do not change feature flags or existing settings.'],
    },
  },
  {
    id: 'r2',
    label: 'Cloudflare R2 (files)',
    purpose: 'Store the files users upload in the app.',
    when: { storage: 'r2' },
    setup: 'partial',
    dashboardUrl: 'https://dash.cloudflare.com',
    autoNote:
      'In the interactive install, wrangler configures the bucket and CORS by itself. The S3 API token is born in the dashboard — the prompt below creates the bucket, the CORS, and the token, and returns the four keys.',
    envs: [
      {
        key: 'R2_ACCOUNT_ID',
        label: 'Account ID',
        target: 'convex',
        source: 'dashboard',
        pattern: '^[a-f0-9]{32}$',
        patternHint: '32 hexadecimal characters',
        hint: 'Cloudflare → R2 → Overview (next to "Account ID") — wrangler also discovers it by itself',
      },
      {
        key: 'R2_ACCESS_KEY_ID',
        label: 'Access Key ID',
        target: 'convex',
        source: 'dashboard',
        pattern: '^[A-Za-z0-9]{16,64}$',
        patternHint: 'S3 token key',
        hint: 'R2 → Manage API Tokens → Create',
      },
      {
        key: 'R2_SECRET_ACCESS_KEY',
        label: 'Secret Access Key',
        target: 'convex',
        secret: true,
        source: 'dashboard',
        pattern: '^[A-Za-z0-9]{32,128}$',
        patternHint: 'shown only once when the token is created',
      },
      {
        key: 'R2_BUCKET',
        label: 'Bucket',
        target: 'convex',
        source: 'dashboard',
        pattern: '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$',
        patternHint: 'e.g.: my-app-files',
        hint: 'created by the AI prompt — or by wrangler in the interactive install',
      },
    ],
    prompt: {
      url: 'https://dash.cloudflare.com',
      steps: [
        'Go to R2 (side menu). If asked to enable R2, enable it (free plan).',
        'Note the "Account ID" shown in the R2 overview (right sidebar).',
        'Create a bucket: "Create bucket", name "{{PROJECT}}-files" (adjust if the name is invalid/taken; only lowercase letters, numbers, and hyphens), automatic location.',
        'In the created bucket: Settings → CORS Policy → Edit and paste EXACTLY: {"rules":[{"allowed":{"origins":["http://localhost:3000"],"methods":["GET","PUT"],"headers":["Content-Type"]},"maxAgeSeconds":3600}]} — save.',
        'Back in R2 → "Manage R2 API Tokens" (or API → Manage API Tokens) → "Create API Token". Name: "{{PROJECT}} (impactus)". Permission: "Object Read & Write" restricted to the created bucket. TTL: Forever.',
        'Create the token and copy the "Access Key ID" and the "Secret Access Key" (the Secret is shown only ONCE).',
      ],
      rules: ['Do not create tokens with Admin permission — only "Object Read & Write".'],
    },
  },
];

// Extra keys (outside the field catalog) that `--keys` also accepts —
// production-only optionals mentioned in the notes; applied straight to the
// target.
export const EXTRA_SERVICE_KEYS = {
  EMAIL_FROM: { target: 'convex', service: 'resend' },
  RESEND_TEST_MODE: { target: 'convex', service: 'resend' },
  ASAAS_DESCRIPTION: { target: 'convex', service: 'asaas' },
};

// Every key the installer recognizes in a `--keys` file: the catalog above
// + the documentational extras.
export const KNOWN_SERVICE_KEYS = [
  ...SERVICES.flatMap((s) => s.envs.map((e) => e.key)),
  ...Object.keys(EXTRA_SERVICE_KEYS),
];

// The --tenancy flag is the legacy shortcut to choose between live1 and live2;
// the source of truth is the TEMPLATES catalog above (--template-id). In live2
// organizations belong to the APP (Convex) — Clerk only authenticates
// identity, so the JWT template is the same as live1's. Spec/history:
// live2-spec.md in the private impactus-internal-docs repo.

// Clerk → Convex webhook (user sync). The route is served from the Convex
// deployment's .site domain; the signing secret is set on the Convex
// deployment (read by convex/http.ts at runtime).
// The webhook is OPTIONAL in both templates: `users.ensure` syncs the user on
// the first authenticated load; the webhook keeps the mirror fresh and cleans
// up deleted accounts. Organizations do NOT go through here (they belong to
// the app).
export const CLERK_WEBHOOK = {
  route: '/clerk-users-webhook',
  secretEnv: 'CLERK_WEBHOOK_SECRET',
  events: ['user.created', 'user.updated', 'user.deleted'],
};

// Payment webhooks the CLI creates VIA API at install (when the service key
// was provided). Routes/events mirror the template's convex/http.ts.
export const PAYMENT_WEBHOOKS = {
  stripe: {
    route: '/stripe-webhook',
    events: ['checkout.session.completed', 'customer.subscription.updated', 'customer.subscription.deleted'],
  },
  asaas: {
    route: '/asaas-webhook',
    events: [
      'PAYMENT_CONFIRMED',
      'PAYMENT_RECEIVED',
      'PAYMENT_OVERDUE',
      'PAYMENT_REFUNDED',
      'SUBSCRIPTION_DELETED',
      'SUBSCRIPTION_INACTIVATED',
    ],
  },
};

// Safe, public Clerk routing defaults. These normally live in .env.example, but
// that file is gitignored in the template and may be absent from the download —
// so the installer writes them itself to guarantee a complete .env.local.
export const CLERK_ROUTING_DEFAULTS = {
  NEXT_PUBLIC_CLERK_SIGN_IN_URL: '/sign-in',
  NEXT_PUBLIC_CLERK_SIGN_UP_URL: '/sign-up',
  NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL: '/',
  NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL: '/',
};

// Env vars copied from .env.local to the Vercel project (production) during
// the optional deploy step. CONVEX_DEPLOYMENT is deliberately absent — it's a
// CLI-only var, not needed at runtime.
export const DEPLOY_ENV_KEYS = [
  'NEXT_PUBLIC_CONVEX_URL',
  'NEXT_PUBLIC_CONVEX_SITE_URL',
  'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
  'CLERK_SECRET_KEY',
  ...Object.keys(CLERK_ROUTING_DEFAULTS),
];

// Official agent skills auto-installed when the user picks an OPTIONAL
// integration. Installed into the generated project with the skills.sh CLI
// by `installProjectSkills` (src/lib/skills.js) — TWO invocations, one per
// engine group (`-a claude-code cursor`, then `-a pi`); see that file for why
// a single call cannot cover all three. It also updates the committed
// skills-lock.json — same mechanism used by the template's pre-installed
// Convex/Clerk skills.
export const OPTIONAL_SKILLS = {
  r2: {
    label: 'Cloudflare (R2) + wrangler',
    source: 'cloudflare/skills', // official Cloudflare repo
    skills: ['cloudflare', 'wrangler'],
    docsUrl: 'https://github.com/cloudflare/skills',
  },
};

// Cloudflare R2 — optional blob storage for the "Documentos" page. When all
// four are set on the Convex deployment the app uploads files to R2; otherwise
// it falls back to Convex's built-in storage. Read by the CONVEX backend, so
// the installer sets them with `npx convex env set` (and mirrors them into
// .env.local for documentation). `secret: true` uses a masked prompt.
export const R2_ENV_VARS = [
  {
    key: 'R2_ACCOUNT_ID',
    label: 'Account ID',
    hint: 'Cloudflare → R2 → Overview (next to "Account ID")',
    secret: false,
  },
  {
    key: 'R2_ACCESS_KEY_ID',
    label: 'Access Key ID',
    hint: 'Cloudflare → R2 → Manage API Tokens → Create',
    secret: false,
  },
  {
    key: 'R2_SECRET_ACCESS_KEY',
    label: 'Secret Access Key',
    hint: 'Shown only once when the API token is created',
    secret: true,
  },
  {
    key: 'R2_BUCKET',
    label: 'Bucket',
    hint: 'Name of the R2 bucket where files will be stored',
    secret: false,
  },
];
