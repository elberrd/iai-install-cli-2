// Stack catalog — the single source of what the installer knows about layers
// and technologies. Everything is DATA-driven: the wizard (steps/stack.js),
// the ai-docs/stack.md manifest (lib/stack.js), and the tooling/documentation
// step (steps/stack-docs.js) read from here. Adding a new technology = a new
// entry here (skills/CLI/MCP/docs/envs) — without touching the logic.
//
// IAI's RECOMMENDED stack is still the live1/live2 template stack:
// Next.js + Convex (database+backend) + Clerk (auth) + Cloudflare R2 (files)
// + Vercel (publishing). The catalog widens the range: whoever skips Convex
// gets the Hono path (API layer) + Neon/Supabase (database) + Drizzle/Prisma
// (ORM).
//
// `depois` ("decide later") is a valid value in ANY category: the person
// decides later, talking to Pi (/idea extracts PRD + stack; /stack decides
// one layer).

/** Sentinel value: the layer stays pending and is decided later with Pi.
 *  (The literal 'depois' is kept for compatibility — it is a stored/CLI value.) */
export const STACK_LATER = 'depois';

// ── Categories (in the wizard's question order) ──────────────────────────────
// `askWhen(choices)` — the question only appears when it makes sense (e.g.,
// database and ORM only when the backend is NOT Convex). `forcedBy(choices)` —
// value imposed by the compatibility rules (e.g., Convex backend ⇒ Convex
// database).
export const STACK_CATEGORIES = [
  {
    id: 'frontend',
    label: 'Frontend',
    question: 'Frontend — what to build the screens with?',
    defaultId: 'nextjs',
  },
  {
    id: 'backend',
    label: 'Backend & API',
    question: 'Backend — how does the app talk to the data?',
    defaultId: 'convex',
  },
  {
    id: 'database',
    label: 'Database',
    question: 'Database — where does the data live?',
    defaultId: 'neon',
    // Convex already IS the database; the question only exists on the own-API path.
    askWhen: (c) => c.backend === 'hono',
    forcedBy: (c) => (c.backend === 'convex' ? 'convex' : c.backend === STACK_LATER ? STACK_LATER : null),
  },
  {
    id: 'orm',
    label: 'ORM',
    question: 'ORM — how does the code talk to the SQL database?',
    defaultId: 'drizzle',
    askWhen: (c) => c.backend === 'hono',
    forcedBy: (c) => (c.backend === 'convex' ? 'none' : c.backend === STACK_LATER ? STACK_LATER : null),
  },
  {
    id: 'auth',
    label: 'Authentication',
    question: 'Authentication — how do users sign in?',
    defaultId: 'clerk',
  },
  {
    id: 'blob',
    label: 'Files (blob)',
    question: 'Files — where to store uploads (photos, PDFs…)?',
    defaultId: 'r2',
  },
  {
    id: 'automations',
    label: 'Automations / Jobs',
    question: 'Automations — will anything run OUTSIDE the app (scheduled jobs, heavy processing)?',
    defaultId: 'none',
  },
  {
    id: 'deploy',
    label: 'Publishing',
    question: 'Publishing — where does the app go live? (Vercel is the only supported path today)',
    defaultId: 'vercel',
  },
];

// ── Options per category ─────────────────────────────────────────────────────
// Fields on each option:
//   label/hint  — wizard text (plain language);
//   role        — one sentence for the ai-docs/stack.md manifest;
//   docs        — official URLs (the 1st is the main one); `llms` — llms.txt if any;
//   cli         — official CLI (same shape as ADDON_TOOLING.cli in config.js);
//   mcp         — official MCP server: argv for `claude mcp add …`;
//   skills      — official agent skills (source for `npx skills add`);
//   envs        — dev × production split: where each key lives in each environment;
//   testUsers   — auth options only: the provider's native test-user mechanism +
//                 the project rule (one test user per profile, recorded in
//                 ai-docs/test-credentials.md); rendered in the manifest;
//   onlyWhen    — the option is only offered when the condition holds (e.g.,
//                 Supabase Storage only with a Supabase database).
export const STACK_OPTIONS = {
  frontend: [
    {
      id: 'nextjs',
      label: 'Next.js (App Router)',
      hint: 'recommended — the React framework the templates and the harness already master',
      role: 'Screens, routes, and pages of the app (React + App Router).',
      docs: ['https://nextjs.org/docs'],
      envs: {
        dev: [{ key: 'npm run dev', note: 'local server at http://localhost:3000' }],
        prod: [{ key: 'build on Vercel', note: 'the deploy runs `next build` automatically' }],
      },
    },
  ],
  backend: [
    {
      id: 'convex',
      label: 'Convex (database + backend together)',
      hint: 'recommended — no API layer to write: database, functions, and realtime ready',
      role: 'Full backend: database, server functions, and realtime — the frontend connects directly, without an API layer.',
      docs: ['https://docs.convex.dev'],
      cli: {
        bin: 'convex',
        name: 'Convex CLI',
        install: { npm: 'convex' },
        viaNpx: true,
        loginArgs: ['login'],
        loginHint: 'opens the browser to log in to your Convex account',
        dashboardUrl: 'https://dashboard.convex.dev',
      },
      mcp: { name: 'convex', addArgs: ['mcp', 'add-json', 'convex', JSON.stringify({ command: 'npx', args: ['-y', 'convex@latest', 'mcp', 'start'] })] },
      skills: { label: 'Convex', source: 'get-convex/agent-skills', skills: [] },
      envs: {
        dev: [
          { key: 'CONVEX_DEPLOYMENT', note: '.env.local — DEV deployment (created by `npx convex dev`)' },
          { key: 'NEXT_PUBLIC_CONVEX_URL', note: '.env.local — dev deployment URL' },
        ],
        prod: [
          { key: 'CONVEX_DEPLOY_KEY', note: 'Vercel (production) — generated in the Convex dashboard, Production deployment' },
          { key: 'backend envs', note: '`npx convex env set <KEY> <value> --prod` (mirror the dev ones)' },
        ],
      },
    },
    {
      id: 'hono',
      label: 'Own API with Hono',
      hint: 'for those NOT using Convex: lightweight API layer — requires SQL database + ORM',
      role: "The app's API layer (HTTP routes). Runs inside Next.js on Vercel (route handler) — no separate server.",
      docs: ['https://hono.dev/docs', 'https://hono.dev/docs/getting-started/nextjs'],
      notes:
        'Standard with Next.js: app/api/[[...route]]/route.ts with `handle(app)` from `hono/vercel` — a single deploy for frontend and API (it becomes a Vercel Function). Hono has no official skill/MCP.',
      envs: {
        dev: [{ key: '(no env of its own)', note: 'the Hono routes come up together with the Next.js `npm run dev`' }],
        prod: [{ key: '(no env of its own)', note: 'deployed together with Next.js on Vercel' }],
      },
    },
  ],
  database: [
    {
      id: 'convex',
      label: 'Convex (built into the backend)',
      hint: 'already included with the Convex backend choice',
      role: 'Database built into Convex (documents + indexes, native realtime).',
      docs: ['https://docs.convex.dev/database'],
    },
    {
      id: 'neon',
      label: 'Neon (Postgres serverless)',
      hint: 'recommended on the SQL path — the installer creates a database on the spot, no account (claim later)',
      role: 'Managed serverless Postgres database (branches per environment; dev and production separated).',
      docs: ['https://neon.com/docs', 'https://neon.com/docs/reference/neon-launchpad'],
      llms: 'https://neon.com/docs/llms.txt',
      cli: {
        bin: 'neon',
        name: 'Neon CLI',
        install: { npm: 'neon', docsUrl: 'https://neon.com/docs/cli/install' },
        loginArgs: ['auth'],
        loginHint: 'opens the browser to log in to your Neon account',
        dashboardUrl: 'https://console.neon.tech',
      },
      mcp: { name: 'neon', addArgs: ['mcp', 'add', '--transport', 'http', 'neon', 'https://mcp.neon.tech/mcp'] },
      skills: {
        label: 'Neon',
        source: 'neondatabase/agent-skills',
        skills: ['neon', 'neon-postgres', 'claimable-postgres', 'neon-postgres-branches'],
      },
      // Neon Launchpad (neon.new): instant Postgres WITHOUT an account —
      // returns DATABASE_URL + claim URL (expires in 72h if unclaimed). This
      // is what lets the installer deliver a ready database and leave the
      // claim for later.
      claim: { api: 'https://neon.new/api/v1/database', claimNote: 'claim within 72h to make the database yours' },
      envs: {
        dev: [
          { key: 'DATABASE_URL', note: '.env.local — connection string (pooled) of the DEV database' },
          { key: 'DATABASE_URL_DIRECT', note: '.env.local — direct connection (no pooler) used by migrations' },
        ],
        prod: [{ key: 'DATABASE_URL', note: 'Vercel (production) — connection string of the PRODUCTION branch/project' }],
      },
    },
    {
      id: 'supabase',
      label: 'Supabase (Postgres + platform)',
      hint: "managed Postgres with a full dashboard (the platform's own optional auth and storage)",
      role: 'Postgres database managed by the Supabase platform (separate projects for dev and production).',
      docs: ['https://supabase.com/docs'],
      cli: {
        bin: 'supabase',
        name: 'Supabase CLI',
        install: { brew: 'supabase/tap/supabase', docsUrl: 'https://supabase.com/docs/guides/local-development/cli/getting-started' },
        loginArgs: ['login'],
        loginHint: 'opens the browser to log in to your Supabase account',
        dashboardUrl: 'https://supabase.com/dashboard',
      },
      // The official MCP needs a personal access token (PAT) or the
      // per-project URL from the dashboard — it can't be registered without
      // interaction; /stack guides you through it.
      mcpNote: 'Official MCP: project dashboard → "MCP connection" tab (or @supabase/mcp-server-supabase with a PAT).',
      skills: { label: 'Supabase', source: 'supabase/agent-skills', skills: [] },
      envs: {
        dev: [{ key: 'DATABASE_URL', note: '.env.local — connection string of the DEV project (or local `supabase start`)' }],
        prod: [{ key: 'DATABASE_URL', note: 'Vercel (production) — connection string of the PRODUCTION project' }],
      },
    },
  ],
  orm: [
    {
      id: 'none',
      label: 'No ORM',
      hint: 'Convex makes an ORM unnecessary',
      role: 'No ORM — Convex accesses its own database.',
      docs: [],
      // With an own API (Hono) the ORM is mandatory in our guided model —
      // "no ORM" only exists as the forced value of the Convex path.
      onlyWhen: (c) => c.backend !== 'hono',
    },
    {
      id: 'drizzle',
      label: 'Drizzle ORM',
      hint: 'recommended — lightweight, SQL-first, migrations with drizzle-kit',
      role: 'TypeScript ORM between the code and Postgres (schema in code + migrations with drizzle-kit).',
      docs: ['https://orm.drizzle.team/docs/overview', 'https://orm.drizzle.team/docs/get-started/neon-new'],
      notes:
        'With Neon: @neondatabase/serverless driver (drizzle-orm/neon-http) and migrations ALWAYS on the direct connection (DATABASE_URL_DIRECT). With Supabase: postgres-js driver on the pooler in session mode.',
      envs: {
        dev: [{ key: 'npx drizzle-kit push/migrate', note: 'applies the schema to the DEV database' }],
        prod: [{ key: 'npx drizzle-kit migrate', note: 'runs the migrations on the PRODUCTION database (at deploy, never a direct push)' }],
      },
    },
    {
      id: 'prisma',
      label: 'Prisma ORM',
      hint: 'established alternative — its own schema + prisma migrate',
      role: 'TypeScript ORM between the code and Postgres (schema.prisma + prisma migrate).',
      docs: ['https://www.prisma.io/docs'],
      envs: {
        dev: [{ key: 'npx prisma migrate dev', note: 'applies migrations to the DEV database' }],
        prod: [{ key: 'npx prisma migrate deploy', note: 'runs the migrations on the PRODUCTION database' }],
      },
    },
  ],
  auth: [
    {
      id: 'clerk',
      label: 'Clerk',
      hint: 'recommended — ready-made login (social, 2FA, user management) without auth code',
      role: 'Authentication and user management (ready-made sign-in/sign-up screens, separate dev and production instances).',
      docs: ['https://clerk.com/docs'],
      skills: { label: 'Clerk', source: 'clerk/skills', skills: [] },
      mcpNote: 'Official MCP: `npx @clerk/agent-toolkit -p local-mcp --secret-key sk_…` (needs the secret key — /stack guides you through it).',
      testUsers:
        'Clerk dev instances ship with test mode ON: any email with the `+clerk_test` subaddress (e.g. `admin+clerk_test@example.com`) verifies with the fixed code `424242` — no real email sent (test phones `+1 (XXX) 555-0100..0199`, same code). The code replaces email VERIFICATION; an instance that signs in by password still needs one — seed it and reference it as an env var name in `.env.local`. Create ONE test user per profile/role and record them in `ai-docs/test-credentials.md`. Never enable test mode in production.',
      envs: {
        dev: [
          { key: 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', note: '.env.local — pk_test_… (development instance)' },
          { key: 'CLERK_SECRET_KEY', note: '.env.local — sk_test_…' },
        ],
        prod: [
          { key: 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', note: "Vercel (production) — pk_live_… from Clerk's PRODUCTION INSTANCE" },
          { key: 'CLERK_SECRET_KEY', note: 'Vercel (production) — sk_live_…' },
        ],
      },
    },
    {
      id: 'better-auth',
      label: 'Better Auth',
      hint: 'open-source, no external service — lives in YOUR SQL database',
      role: 'Open-source authentication inside the app itself (tables in your SQL database; no external service).',
      docs: ['https://www.better-auth.com/docs'],
      skills: { label: 'Better Auth', source: 'better-auth/skills', skills: [] },
      notes: 'CLI: `npx @better-auth/cli init|generate` (the schema goes into your ORM; migrations via drizzle-kit/prisma).',
      testUsers:
        'No provider test mode: seed ONE test user per profile/role with a dev-only script (e.g. `scripts/seed-test-users.ts` calling the sign-up API against the DEV database). The password comes from `TEST_USER_PASSWORD` in `.env.local` (named in `.env.example`, never committed); record emails + roles in `ai-docs/test-credentials.md`. Never seed production.',
      onlyWhen: (c) => c.backend !== 'convex',
      envs: {
        dev: [
          { key: 'BETTER_AUTH_SECRET', note: '.env.local — generated secret (openssl rand -base64 32)' },
          { key: 'BETTER_AUTH_URL', note: '.env.local — http://localhost:3000' },
        ],
        prod: [
          { key: 'BETTER_AUTH_SECRET', note: 'Vercel (production) — production-OWN secret (never the dev one)' },
          { key: 'BETTER_AUTH_URL', note: 'Vercel (production) — https://your-domain.com' },
        ],
      },
    },
  ],
  blob: [
    {
      id: 'r2',
      label: 'Cloudflare R2',
      hint: 'recommended — cheap, no egress cost, CORS configurable per environment',
      role: 'Storage for files uploaded by users (S3-compatible bucket).',
      docs: ['https://developers.cloudflare.com/r2/'],
      cli: {
        bin: 'wrangler',
        name: "Wrangler (Cloudflare's CLI)",
        install: { npm: 'wrangler' },
        loginArgs: ['login'],
        loginHint: 'opens the browser to log in to your Cloudflare account',
        dashboardUrl: 'https://dash.cloudflare.com',
      },
      skills: { label: 'Cloudflare (R2) + wrangler', source: 'cloudflare/skills', skills: ['cloudflare', 'wrangler'] },
      envs: {
        dev: [{ key: 'R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET', note: 'backend (Convex env or .env.local) — dev bucket with CORS for localhost:3000' }],
        prod: [{ key: 'the same 4 keys', note: 'production environment — its own bucket (or the same one) with CORS for the real domain' }],
      },
    },
    {
      id: 'convex-storage',
      label: 'Convex Storage',
      hint: 'zero configuration — files inside Convex itself',
      role: 'File storage built into Convex (no extra configuration).',
      docs: ['https://docs.convex.dev/file-storage'],
      onlyWhen: (c) => c.backend === 'convex' || c.backend === STACK_LATER,
    },
    {
      id: 'supabase-storage',
      label: 'Supabase Storage',
      hint: 'files inside the same Supabase project as the database',
      role: 'File storage built into the Supabase project.',
      docs: ['https://supabase.com/docs/guides/storage'],
      onlyWhen: (c) => c.database === 'supabase',
    },
  ],
  automations: [
    {
      id: 'none',
      label: 'None (everything inside the app)',
      hint: 'recommended to start — scheduled work fits Convex scheduled functions or Vercel crons',
      role: 'No external automation layer — scheduled/background work runs inside the backend (Convex scheduled functions or Vercel crons).',
      docs: [],
    },
    {
      id: 'modal',
      label: 'Modal (external compute)',
      hint: 'jobs outside the app: cron, queues, GPU, long-running Python — its own deploy',
      role: 'Automations and jobs OUTSIDE the app: scheduled/triggered functions on Modal (serverless compute with its own deploy, separate from the app on Vercel).',
      docs: ['https://modal.com/docs'],
      cli: {
        bin: 'modal',
        name: 'Modal CLI',
        install: { pip: 'modal', docsUrl: 'https://modal.com/docs/guide' },
        loginArgs: ['setup'],
        loginHint: 'opens the browser to authenticate your Modal workspace',
        dashboardUrl: 'https://modal.com/apps',
      },
      notes:
        'Automation code lives in its own folder (default `automations/`) and each job ships with `modal deploy` — a SECOND deploy target alongside Vercel, so the Production runbook in ai-docs/apis/modal.md is mandatory before /launch (the launch checker blocks without it).',
      envs: {
        dev: [{ key: 'modal setup', note: 'one-time browser login — `modal run automations/<job>.py` executes in your workspace' }],
        prod: [
          { key: 'modal deploy automations/', note: 'publishes the jobs (cron/webhook triggers are declared in the code)' },
          { key: 'MODAL_TOKEN_ID / MODAL_TOKEN_SECRET', note: 'only where the app/CI triggers jobs remotely (`modal token new`) — Vercel production envs, never .env.local in git' },
        ],
      },
    },
  ],
  deploy: [
    {
      id: 'vercel',
      label: 'Vercel',
      hint: 'the only supported path today — deploys Next.js (and Hono along with it, if any)',
      role: 'App publishing (preview and production; separate production envs via `vercel env`).',
      docs: ['https://vercel.com/docs'],
      cli: {
        bin: 'vercel',
        name: 'Vercel CLI',
        install: { npm: 'vercel' },
        loginArgs: ['login'],
        loginHint: 'opens the browser to log in to your Vercel account',
        dashboardUrl: 'https://vercel.com/dashboard',
      },
      mcp: { name: 'vercel', addArgs: ['mcp', 'add', '--transport', 'http', 'vercel', 'https://mcp.vercel.com'] },
      envs: {
        dev: [{ key: '(nothing to configure)', note: 'dev is local — Vercel only comes in at deploy' }],
        prod: [{ key: 'vercel env add <KEY> production', note: 'ALL production envs live on Vercel (never in .env.local)' }],
      },
    },
  ],
};

// ── Recommended stack (the live1/live2 template stack) ───────────────────────
export const RECOMMENDED_STACK = {
  frontend: 'nextjs',
  backend: 'convex',
  database: 'convex',
  orm: 'none',
  auth: 'clerk',
  blob: 'r2',
  automations: 'none',
  deploy: 'vercel',
};

/** Looks up a category option by id (null for `depois`/unknown). */
export function stackOption(categoryId, optionId) {
  if (!optionId || optionId === STACK_LATER) return null;
  return (STACK_OPTIONS[categoryId] ?? []).find((o) => o.id === optionId) ?? null;
}
