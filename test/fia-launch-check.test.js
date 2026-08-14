import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseEnvFile,
  looksLikeSecret,
  detectRung,
  stackServices,
  stackRunbooks,
  runLaunchChecks,
  renderReport,
} from '../fia-templates/scripts/fia-launch-check.mjs';

// ── pure helpers ─────────────────────────────────────────────────────────────

test('parseEnvFile: quotes, export, comments and malformed lines', () => {
  const env = parseEnvFile(
    ['# comment', 'A=1', 'export B="two"', "C='three'", 'INVALID LINE', '  D = spaced ', ''].join('\n'),
  );
  assert.deepEqual(env, { A: '1', B: 'two', C: 'three', D: 'spaced' });
  assert.deepEqual(parseEnvFile(null), {});
});

test('looksLikeSecret: catches secret-key prefixes, ignores public ones', () => {
  assert.equal(looksLikeSecret('sk_live_abc'), true);
  assert.equal(looksLikeSecret('sk_test_abc'), true);
  assert.equal(looksLikeSecret('whsec_abc'), true);
  assert.equal(looksLikeSecret('pk_test_abc'), false);
  assert.equal(looksLikeSecret('https://x.convex.cloud'), false);
  assert.equal(looksLikeSecret(''), false);
});

test('detectRung: local → beta → production', () => {
  assert.equal(detectRung({ clerkKey: undefined, vercelLinked: false }), 'local');
  assert.equal(detectRung({ clerkKey: 'pk_test_x', vercelLinked: true }), 'beta');
  assert.equal(detectRung({ clerkKey: 'pk_live_x', vercelLinked: false }), 'production');
  // SQL stacks have no Clerk key — a production URL on an own domain is the live signal.
  assert.equal(detectRung({ clerkKey: undefined, vercelLinked: true, prodUrl: 'https://app.example.com' }), 'production');
  assert.equal(detectRung({ clerkKey: undefined, vercelLinked: true, prodUrl: null }), 'beta');
});

test('stackServices: reads Summary/Layers only, ignores the instruction text', () => {
  assert.equal(stackServices(null), null, 'no manifest → null');
  const md = [
    '# Project stack',
    '',
    '> Rules: IAI preference is Next.js + Convex + Clerk + Vercel.',
    '> Convex backend ⇒ there is NO API layer.',
    '',
    '## Summary',
    '',
    '| Layer | Choice | Local docs |',
    '|---|---|---|',
    '| Database | Neon (serverless Postgres) | `ai-docs/apis/neon.md` |',
    '| Auth | Better Auth | `ai-docs/apis/better-auth.md` |',
    '| Deployment | Vercel | — |',
    '',
    '## Layers',
    '',
    '### ORM — Drizzle',
    '',
  ].join('\n');
  const declared = stackServices(md);
  assert.equal(declared.has('neon'), true);
  assert.equal(declared.has('better-auth'), true);
  assert.equal(declared.has('vercel'), true);
  assert.equal(declared.has('drizzle'), true);
  assert.equal(declared.has('convex'), false, 'Convex only appears in the instruction text');
  assert.equal(declared.has('clerk'), false, 'Clerk only appears in the instruction text');
});

test('stackRunbooks: decided rows with docs, pending rows skipped, automations flagged', () => {
  assert.deepEqual(stackRunbooks(null), [], 'no manifest → empty');
  const md = [
    '## Summary',
    '',
    '| Layer | Choice | Local docs |',
    '|---|---|---|',
    '| Frontend | Next.js (App Router) | — |',
    '| Database | Neon (Postgres serverless) | `ai-docs/apis/neon.md` (generate with /stack) |',
    '| Auth | ◌ decide later | — |',
    '| Automations / Jobs | Modal (external compute) | `ai-docs/apis/modal.md` (generate with /stack) |',
    '| Publishing | Vercel | `ai-docs/apis/vercel.md` |',
    '',
  ].join('\n');
  const rows = stackRunbooks(md);
  assert.equal(rows.length, 4, 'the pending Auth row is skipped');
  const neon = rows.find((r) => r.doc === 'ai-docs/apis/neon.md');
  assert.ok(neon && !neon.automations);
  const modal = rows.find((r) => r.automations);
  assert.equal(modal.external, true);
  assert.equal(modal.doc, 'ai-docs/apis/modal.md');
  const none = stackRunbooks(md.replace('Modal (external compute)', 'None (everything inside the app)'));
  assert.equal(none.find((r) => r.automations).external, false, '"none" is internal, not external');
});

// ── full report on a fabricated project ──────────────────────────────────────

/** Test project with deliberate defects — the checker flags them, never breaks. */
function seedProject() {
  const root = mkdtempSync(join(tmpdir(), 'launch-check-'));
  execSync('git init -q && git config user.email t@t.dev && git config user.name T', { cwd: root });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: { build: 'true', test: 'true' } }));
  // .env.local with a secret leaking via NEXT_PUBLIC_*
  writeFileSync(
    join(root, '.env.local'),
    ['CONVEX_DEPLOYMENT=dev:calm-otter-42', 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_abc', 'NEXT_PUBLIC_STRIPE_KEY=sk_live_oops'].join('\n'),
  );
  writeFileSync(join(root, '.gitignore'), '.env.local\n');
  // convex/ with a raw mutation and an http.ts WITHOUT verify
  mkdirSync(join(root, 'convex', 'lib'), { recursive: true });
  writeFileSync(join(root, 'convex', 'notes.ts'), 'export const list = query({ handler: async () => [] });\nexport const add = mutation({});\n');
  writeFileSync(join(root, 'convex', 'lib', 'auth.ts'), 'export const authedQuery = query;\n');
  writeFileSync(join(root, 'convex', 'http.ts'), 'export default http; // no signature verification\n');
  // UI with dangerouslySetInnerHTML
  mkdirSync(join(root, 'app'), { recursive: true });
  writeFileSync(join(root, 'app', 'page.tsx'), 'export default () => <div dangerouslySetInnerHTML={{ __html: x }} />;\n');
  execSync('git add -A && git commit -qm init', { cwd: root });
  return root;
}

test('runLaunchChecks: flags the planted defects and summarizes correctly', () => {
  const root = seedProject();
  const report = runLaunchChecks(root, { backupsDir: join(root, 'no-backups-here') });
  const by = Object.fromEntries(report.checks.map((c) => [c.id, c]));

  assert.equal(report.rung, 'local');
  assert.equal(by.git_repo.status, 'pass');
  assert.equal(by.clean_tree.status, 'pass');
  assert.equal(by.remote.status, 'fail', 'no origin');
  assert.equal(by.env_untracked.status, 'pass', '.env.local is in .gitignore');
  assert.equal(by.no_public_secrets.status, 'fail', 'NEXT_PUBLIC_STRIPE_KEY=sk_live leaks');
  assert.equal(by.no_public_secrets.level, 'blocker');
  assert.equal(by.raw_functions.status, 'fail', 'raw query/mutation outside lib');
  assert.match(by.raw_functions.detail, /notes\.ts/);
  assert.ok(!/lib/.test(by.raw_functions.detail || ''), 'convex/lib is exempt');
  assert.equal(by.webhook_verify.status, 'fail', 'http.ts without .verify(');
  assert.equal(by.webhook_verify.level, 'blocker');
  assert.equal(by.dangerous_html.status, 'fail');
  assert.equal(by.quality_scripts.status, 'fail', 'lint and typecheck missing');
  assert.match(by.quality_scripts.detail, /lint/);
  assert.equal(by.backup_exists.status, 'fail');
  assert.equal(by.error_monitor.status, 'fail', 'no Sentry');
  assert.equal(by.tasks_done.status, 'skip', 'no ai-docs');
  assert.ok(report.summary.blockers >= 2, 'public secret + webhook without verify');
  assert.ok(report.summary.passes >= 3);
});

test('runLaunchChecks: dirty tree and committed .env.local become blockers', () => {
  const root = seedProject();
  execSync('git rm -q --cached -r . && rm .gitignore && git add -A && git commit -qm expose', { cwd: root });
  writeFileSync(join(root, 'novo.txt'), 'dirty');
  const report = runLaunchChecks(root, { backupsDir: join(root, 'nope') });
  const by = Object.fromEntries(report.checks.map((c) => [c.id, c]));
  assert.equal(by.clean_tree.status, 'fail');
  assert.equal(by.env_untracked.status, 'fail', '.env.local tracked by git');
  assert.match(by.env_untracked.fix, /ROTATE the exposed keys/);
});

test('runLaunchChecks: outside a git repo it degrades without breaking', () => {
  const root = mkdtempSync(join(tmpdir(), 'launch-nogit-'));
  writeFileSync(join(root, 'package.json'), '{}');
  const report = runLaunchChecks(root, { backupsDir: join(root, 'nope') });
  const by = Object.fromEntries(report.checks.map((c) => [c.id, c]));
  assert.equal(by.git_repo.status, 'fail');
  assert.equal(by.clean_tree, undefined, 'git checks are skipped without a repo');
  assert.equal(report.rung, 'local');
});

test('runLaunchChecks: stack manifest — pending blocks, decided passes, absent skips', () => {
  const root = seedProject();
  const aiDocs = join(root, 'ai-docs');
  mkdirSync(aiDocs, { recursive: true });

  // No manifest → skip (projects predating /stack keep working).
  let by = Object.fromEntries(runLaunchChecks(root).checks.map((c) => [c.id, c]));
  assert.equal(by.stack_decided.status, 'skip');

  // With pending items (◌ table marker) → blocker.
  writeFileSync(
    join(aiDocs, 'stack.md'),
    '# Project stack\n\n| Layer | Choice |\n|---|---|\n| Backend | ◌ decide later |\n\n- [ ] Backend & API\n',
  );
  by = Object.fromEntries(runLaunchChecks(root).checks.map((c) => [c.id, c]));
  assert.equal(by.stack_decided.status, 'fail');
  assert.equal(by.stack_decided.level, 'blocker');

  // The legacy pt-BR marker ("decidir depois") still blocks too.
  writeFileSync(
    join(aiDocs, 'stack.md'),
    '# Project stack\n\n| Layer | Choice |\n|---|---|\n| Backend | ◌ decidir depois |\n',
  );
  by = Object.fromEntries(runLaunchChecks(root).checks.map((c) => [c.id, c]));
  assert.equal(by.stack_decided.status, 'fail');

  // Everything decided → pass, even with the phrase "decide later" in the
  // manifest's instruction text (only real markers count).
  writeFileSync(
    join(aiDocs, 'stack.md'),
    '# Project stack\n\n> whatever is "decide later" STOPS.\n\n| Layer | Choice |\n|---|---|\n| Backend | Convex |\n',
  );
  by = Object.fromEntries(runLaunchChecks(root).checks.map((c) => [c.id, c]));
  assert.equal(by.stack_decided.status, 'pass');
});

test('runLaunchChecks: external automations without a Production runbook is a blocker', () => {
  const root = seedProject();
  const aiDocs = join(root, 'ai-docs');
  mkdirSync(join(aiDocs, 'apis'), { recursive: true });
  writeFileSync(
    join(aiDocs, 'stack.md'),
    [
      '## Summary',
      '',
      '| Layer | Choice | Local docs |',
      '|---|---|---|',
      '| Backend & API | Convex | — |',
      '| Automations / Jobs | Modal (external compute) | `ai-docs/apis/modal.md` (generate with /stack) |',
      '',
    ].join('\n'),
  );
  let by = Object.fromEntries(runLaunchChecks(root).checks.map((c) => [c.id, c]));
  assert.equal(by.automations_runbook.status, 'fail', 'no modal.md at all');
  assert.equal(by.automations_runbook.level, 'blocker');
  assert.match(by.automations_runbook.fix, /\/stack/);
  assert.equal(by.production_runbooks.status, 'fail', 'aggregate warn fails too');
  assert.equal(by.production_runbooks.level, 'warn');

  // Doc exists but without a Production section → still a blocker.
  writeFileSync(join(aiDocs, 'apis', 'modal.md'), '# Modal\n\n## Setup — development\n');
  by = Object.fromEntries(runLaunchChecks(root).checks.map((c) => [c.id, c]));
  assert.equal(by.automations_runbook.status, 'fail');

  // Production runbook written → pass (and the aggregate follows).
  writeFileSync(join(aiDocs, 'apis', 'modal.md'), '# Modal\n\n## Production\n\n1. `modal deploy automations/`\n');
  by = Object.fromEntries(runLaunchChecks(root).checks.map((c) => [c.id, c]));
  assert.equal(by.automations_runbook.status, 'pass');
  assert.equal(by.production_runbooks.status, 'pass');

  // Internal choice ("none") → the automations check does not exist.
  writeFileSync(
    join(aiDocs, 'stack.md'),
    '## Summary\n\n| Layer | Choice | Local docs |\n|---|---|---|\n| Automations / Jobs | None (everything inside the app) | — |\n',
  );
  by = Object.fromEntries(runLaunchChecks(root).checks.map((c) => [c.id, c]));
  assert.equal(by.automations_runbook, undefined);
});

test('runLaunchChecks: auth in the stack expects the test-credentials roster', () => {
  const root = seedProject();
  const aiDocs = join(root, 'ai-docs');
  mkdirSync(aiDocs, { recursive: true });
  writeFileSync(
    join(aiDocs, 'stack.md'),
    '## Summary\n\n| Layer | Choice | Local docs |\n|---|---|---|\n| Auth | Clerk | — |\n',
  );

  // No roster file at all → warn-level fail with the recipe in the fix.
  let by = Object.fromEntries(runLaunchChecks(root).checks.map((c) => [c.id, c]));
  assert.equal(by.test_credentials.status, 'fail', 'no roster file');
  assert.equal(by.test_credentials.level, 'warn');
  assert.match(by.test_credentials.fix, /\+clerk_test/);

  // Template shipped but empty between the markers → still fail; the example
  // table BELOW the markers must not satisfy the gate.
  writeFileSync(
    join(aiDocs, 'test-credentials.md'),
    [
      '# Test credentials',
      '',
      '<!-- credentials:start -->',
      '',
      '| Profile | Email | Password / code | Notes |',
      '| --- | --- | --- | --- |',
      '',
      '<!-- credentials:end -->',
      '',
      '| admin | `admin+clerk_test@example.com` | code `424242` | example row |',
      '',
    ].join('\n'),
  );
  by = Object.fromEntries(runLaunchChecks(root).checks.map((c) => [c.id, c]));
  assert.equal(by.test_credentials.status, 'fail', 'example rows outside the markers do not count');

  // A real row inside the markers → pass.
  writeFileSync(
    join(aiDocs, 'test-credentials.md'),
    [
      '<!-- credentials:start -->',
      '',
      '| Profile | Email | Password / code | Notes |',
      '| --- | --- | --- | --- |',
      '| admin | `admin+clerk_test@example.com` | code `424242` (Clerk test mode) | full access |',
      '',
      '<!-- credentials:end -->',
      '',
    ].join('\n'),
  );
  by = Object.fromEntries(runLaunchChecks(root).checks.map((c) => [c.id, c]));
  assert.equal(by.test_credentials.status, 'pass');

  // No auth in the stack — and no Clerk key in .env.local (the key alone is
  // a legit auth signal) → the check does not exist.
  writeFileSync(join(aiDocs, 'stack.md'), '## Summary\n\n| Layer | Choice | Local docs |\n|---|---|---|\n| Backend & API | Convex | — |\n');
  writeFileSync(join(root, '.env.local'), 'CONVEX_DEPLOYMENT=dev:calm-otter-42\n');
  by = Object.fromEntries(runLaunchChecks(root).checks.map((c) => [c.id, c]));
  assert.equal(by.test_credentials, undefined);
});

// ── SQL stack (Better Auth + Neon) — Convex/Clerk checks must not apply ──────

/** Project on the SQL path: Hono + Neon + Drizzle + Better Auth, no convex/. */
function seedSqlProject() {
  const root = mkdtempSync(join(tmpdir(), 'launch-sql-'));
  execSync('git init -q && git config user.email t@t.dev && git config user.name T', { cwd: root });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'x', scripts: { lint: 'true', typecheck: 'true', test: 'true', build: 'true' } }),
  );
  writeFileSync(join(root, '.env.local'), 'DATABASE_URL=postgresql://u:p@x.neon.tech/db\n');
  writeFileSync(join(root, '.gitignore'), '.env.local\n.env.production\n.vercel\n');
  const aiDocs = join(root, 'ai-docs');
  mkdirSync(aiDocs, { recursive: true });
  writeFileSync(
    join(aiDocs, 'stack.md'),
    [
      '# Project stack',
      '',
      '> Rules: IAI preference is Next.js + Convex + Clerk + Vercel. Convex backend ⇒ no ORM.',
      '',
      '## Summary',
      '',
      '| Layer | Choice | Local docs |',
      '|---|---|---|',
      '| Frontend | Next.js (App Router) | — |',
      '| Backend & API | Hono | — |',
      '| Database | Neon (serverless Postgres) | `ai-docs/apis/neon.md` |',
      '| ORM | Drizzle | `ai-docs/apis/drizzle.md` |',
      '| Auth | Better Auth | `ai-docs/apis/better-auth.md` |',
      '| Deployment | Vercel | — |',
      '',
    ].join('\n'),
  );
  execSync('git add -A && git commit -qm init', { cwd: root });
  return root;
}

test('runLaunchChecks: SQL stack — Convex checks skip, backup fix is stack-aware', () => {
  const root = seedSqlProject();
  const report = runLaunchChecks(root, { backupsDir: join(root, 'no-backups') });
  const by = Object.fromEntries(report.checks.map((c) => [c.id, c]));

  assert.equal(by.stack_decided.status, 'pass');
  assert.equal(by.raw_functions.status, 'skip', 'no Convex in the stack');
  assert.match(by.raw_functions.detail, /does not use Convex/);
  assert.equal(by.convex_build_cmd, undefined, 'Convex production checks not added');
  assert.equal(by.convex_dev_local, undefined);
  assert.equal(by.clerk_keys, undefined, 'no Clerk key, no Clerk check');
  assert.equal(by.backup_exists.status, 'fail');
  assert.match(by.backup_exists.fix, /pg_dump/, 'SQL backup command, not convex export');
  assert.ok(!/convex export/.test(by.backup_exists.fix));
  assert.equal(by.prod_url.status, 'skip', 'no production URL yet');
  const failing = report.checks.filter((c) => c.status === 'fail').map((c) => c.id);
  assert.ok(!failing.some((id) => /convex|clerk/.test(id)), `no Convex/Clerk failures: ${failing}`);
});

test('runLaunchChecks: SQL stack reaches beta and production rungs', () => {
  const root = seedSqlProject();
  assert.equal(runLaunchChecks(root).rung, 'local');

  // Linked on Vercel → beta.
  mkdirSync(join(root, '.vercel'), { recursive: true });
  writeFileSync(join(root, '.vercel', 'project.json'), '{"projectId":"x"}');
  assert.equal(runLaunchChecks(root).rung, 'beta');

  // Production URL on an own domain → production, even without Clerk keys.
  writeFileSync(join(root, '.env.production'), 'NEXT_PUBLIC_APP_URL=https://app.example.com\n');
  const report = runLaunchChecks(root);
  assert.equal(report.rung, 'production');
  const by = Object.fromEntries(report.checks.map((c) => [c.id, c]));
  assert.equal(by.prod_url.status, 'pass');

  // A vercel.app preview URL is beta, not production.
  writeFileSync(join(root, '.env.production'), 'NEXT_PUBLIC_APP_URL=https://x.vercel.app\n');
  assert.equal(runLaunchChecks(root).rung, 'beta');
});

test('renderReport: groups by section, shows fix only on failure and closes with a summary', () => {
  const root = seedProject();
  const out = renderReport(runLaunchChecks(root, { backupsDir: join(root, 'nope') }));
  assert.match(out, /Current rung: LOCAL/);
  assert.match(out, /Versioning/);
  assert.match(out, /Security/);
  assert.match(out, /→ /, 'fix hint present on failures');
  assert.match(out, /blocker\(s\)/);
  assert.match(out, /nothing was published/);
});

test('registry_seeded/registry_planned: blind registry warns, planned rows warn, seeded passes', () => {
  const root = seedProject();
  let by = Object.fromEntries(runLaunchChecks(root).checks.map((c) => [c.id, c]));
  assert.equal(by.registry_seeded.status, 'skip', 'no registry and no reusable components → skip');
  assert.equal(by.registry_planned, undefined, 'planned check needs registry rows');

  // Reusable components in the code but no registry → BLIND registry warning
  // (the reuse lock has nothing to defend). Blank lines around the rows mimic
  // prettier's markdown formatting — the parser must tolerate them.
  mkdirSync(join(root, 'components', 'ui'), { recursive: true });
  for (let i = 0; i < 5; i++) {
    writeFileSync(join(root, 'components', 'ui', `comp${i}.tsx`), 'export const C = () => null;\n');
  }
  by = Object.fromEntries(runLaunchChecks(root).checks.map((c) => [c.id, c]));
  assert.equal(by.registry_seeded.status, 'fail');
  assert.equal(by.registry_seeded.level, 'warn');
  assert.match(by.registry_seeded.fix, /\/kit/);

  const row = (name, status) =>
    `| ${name} | data | project | components/${name.toLowerCase()}.tsx | — | — | ${status} | — | every ${name} need |`;
  const registry = (rows) =>
    ['# Component registry', '', '<!-- registry:start -->', '', ...rows, '', '<!-- registry:end -->', ''].join('\n');
  mkdirSync(join(root, 'ai-docs', 'components'), { recursive: true });
  const regPath = join(root, 'ai-docs', 'components', 'registry.md');

  writeFileSync(regPath, registry([row('DataTable', 'installed'), row('Combobox', 'installed')]));
  by = Object.fromEntries(runLaunchChecks(root).checks.map((c) => [c.id, c]));
  assert.equal(by.registry_seeded.status, 'pass');
  assert.equal(by.registry_planned.status, 'pass');

  writeFileSync(regPath, registry([row('DataTable', 'installed'), row('Kanban', 'planned'), row('MultiSelect', 'planned')]));
  by = Object.fromEntries(runLaunchChecks(root).checks.map((c) => [c.id, c]));
  assert.equal(by.registry_planned.status, 'fail');
  assert.equal(by.registry_planned.level, 'warn');
  assert.match(by.registry_planned.detail, /Kanban, MultiSelect/);
});

test('theme_tokens: hardcoded hex in UI components warns, token-based UI passes', () => {
  const root = seedProject();
  mkdirSync(join(root, 'components', 'emails'), { recursive: true });
  writeFileSync(join(root, 'components', 'good.tsx'), 'export const G = () => <div className="text-primary" />;\n');
  // react-email templates inline styles by design — never flagged
  writeFileSync(join(root, 'components', 'emails', 'welcome.tsx'), 'export const W = () => <div style={{ color: "#1a2b3c" }} />;\n');
  let by = Object.fromEntries(runLaunchChecks(root).checks.map((c) => [c.id, c]));
  assert.equal(by.theme_tokens.status, 'pass');

  // A 6-digit hex in a component fails; a 3-digit anchor-like value does not
  // (deliberately unmatched — "#faq"-style hrefs collide with 3-digit hex).
  writeFileSync(join(root, 'components', 'anchor.tsx'), 'export const A = () => <a href="#faq">faq</a>;\n');
  writeFileSync(join(root, 'components', 'bad.tsx'), 'export const B = () => <div style={{ color: "#1a2b3c" }} />;\n');
  by = Object.fromEntries(runLaunchChecks(root).checks.map((c) => [c.id, c]));
  assert.equal(by.theme_tokens.status, 'fail');
  assert.match(by.theme_tokens.detail, /components\/bad\.tsx/);
  assert.equal(by.theme_tokens.level, 'warn');
});
