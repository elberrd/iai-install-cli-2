/**
 * Launch readiness checker — deterministic, READ-ONLY report of how close the
 * project is to going live. Nothing here publishes, deploys or mutates state;
 * it only inspects the working tree, git and local config, and prints a
 * red/green report the /launch command (and the student) can act on.
 *
 * Rungs:
 *   local      — never published (no Vercel link)
 *   beta       — linked/published on Vercel, but not all production signals
 *   production — own domain plus a complete live auth/backend/webhook set
 *
 * Stack-aware: the ai-docs/stack.md manifest decides which checks apply.
 * Convex/Clerk/Vercel checks only run when the stack declares them (or their
 * artifacts exist); an inapplicable check becomes 'skip', never 'fail'.
 *
 * Levels: blocker (must fix before going live) · warn (should fix) · info.
 * Never throws: a missing file/tool degrades to 'skip', not a crash.
 *
 * Usage:  node imp/scripts/fia-launch-check.mjs [--json] [--strict] [--dir <p>]
 *         --strict exits 1 when any blocker fails (CI-friendly).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readPlanTasks, readPlanSpecs } from './plan-docs.mjs';
import { qaEvidenceGaps } from '../modules/qa-gate.mjs';
import { hasSourcesGone, runWikiCheck } from './wiki-check.mjs';
import { runSecurityScan } from './security-scan.mjs';
import { validateUiContract } from './ui-contract.mjs';
import { verifyUiKitReceipt } from '../modules/ui-kit-receipt.mjs';
import { isMainModule } from '../modules/utils.mjs';

const MAX_SRC_FILES = 400; // security greps stay cheap even on big projects

// ── small pure helpers ───────────────────────────────────────────────────────

/** Parse .env-style text → { KEY: value } (quotes stripped, comments ignored). */
export function parseEnvFile(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** A NEXT_PUBLIC_* value that looks like a server secret reaches the browser. */
export function looksLikeSecret(value) {
  return /^(sk_live_|sk_test_|whsec_|re_[A-Za-z0-9]|sntrys_|xai-|AKIA)/.test(String(value || ''));
}

/** Which rung the project is on, from deterministic signals. */
export function detectRung({
  clerkKey,
  clerkSecretKey,
  convexProduction,
  webhookSecret,
  vercelLinked,
  prodUrl,
  usesClerk = Boolean(clerkKey),
  usesConvex = false,
}) {
  if (usesClerk) {
    const liveKeys =
      String(clerkKey || '').startsWith('pk_live_') &&
      String(clerkSecretKey || '').startsWith('sk_live_');
    if (liveKeys && prodUrl && webhookSecret && (!usesConvex || convexProduction)) {
      return 'production';
    }
  } else if (prodUrl) {
    // Stacks without Clerk use an own-domain URL as the live signal.
    return 'production';
  }
  if (vercelLinked) return 'beta';
  return 'local';
}

/**
 * Services the stack manifest DECLARES. Reads only the Summary table's Choice
 * column and the "### Layer — Option" headings — the manifest's instruction
 * text mentions every service by name, so a whole-file grep would misfire.
 * Returns null when there is no manifest (projects predating /stack).
 */
export function stackServices(stackMd) {
  if (stackMd == null) return null;
  const KNOWN = [
    [/convex/, 'convex'],
    [/clerk/, 'clerk'],
    [/vercel/, 'vercel'],
    [/\bneon\b/, 'neon'],
    [/supabase/, 'supabase'],
    [/better[ -]?auth/, 'better-auth'],
    [/drizzle/, 'drizzle'],
    [/prisma/, 'prisma'],
    [/\bmodal\b/, 'modal'],
  ];
  const declared = new Set();
  const collect = (text) => {
    const t = String(text).toLowerCase();
    for (const [re, token] of KNOWN) if (re.test(t)) declared.add(token);
  };
  let inSummary = false;
  for (const line of String(stackMd).split('\n')) {
    const h2 = /^##\s+(.+)/.exec(line);
    if (h2) inSummary = /^(summary|resumo)/i.test(h2[1].trim());
    const h3 = /^###\s+.+?—\s*(.+)$/.exec(line);
    if (h3) collect(h3[1]);
    if (inSummary && line.trim().startsWith('|')) {
      // | Layer | Choice | Local docs | → the Choice cell is index 2.
      const cells = line.split('|').map((c) => c.trim());
      if (cells.length >= 3 && cells[2] && !/^[-:\s]+$/.test(cells[2]) && !/^(choice|escolha)$/i.test(cells[2]))
        collect(cells[2]);
    }
  }
  return declared;
}

/**
 * Runbook inventory from the manifest's Summary table: one entry per DECIDED
 * layer, with the `ai-docs/apis/<tech>.md` doc its "Local docs" cell names
 * (null when the cell is "—"). Pending rows (◌ markers) are skipped. Each
 * entry also says whether it is the Automations layer and whether the choice
 * is an EXTERNAL service ("none"-style choices are internal by definition) —
 * an external automations layer is a second deploy target whose Production
 * runbook is the only launch recipe /launch has for it.
 */
export function stackRunbooks(stackMd) {
  if (stackMd == null) return [];
  const out = [];
  let inSummary = false;
  for (const line of String(stackMd).split('\n')) {
    const h2 = /^##\s+(.+)/.exec(line);
    if (h2) inSummary = /^(summary|resumo)/i.test(h2[1].trim());
    if (!inSummary || !line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 3) continue;
    const [, layer, choice] = cells;
    const docCell = cells[3] ?? '';
    if (!layer || /^(layer|camada)$/i.test(layer) || /^[-:\s]*$/.test(layer)) continue;
    if (!choice || /^[-:\s]*$/.test(choice) || /◌|decide later|decidir depois/i.test(choice)) continue;
    const doc = /ai-docs\/apis\/([a-z0-9-]+)\.md/i.exec(docCell)?.[0] ?? null;
    out.push({
      layer,
      choice,
      doc,
      automations: /automa|jobs/i.test(layer),
      external: !/^(none|no\b|n\/?a\b|not applicable|in-app|nenhum|—|-\s*$)/i.test(choice),
    });
  }
  return out;
}

// ── data gathering (all failure-tolerant) ────────────────────────────────────

function git(root, args) {
  try {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 15000 });
    return r.status === 0 ? (r.stdout || '').trim() : null;
  } catch {
    return null;
  }
}

function gh(root, args) {
  try {
    const r = spawnSync('gh', args, { cwd: root, encoding: 'utf8', timeout: 20000 });
    return r.status === 0 ? (r.stdout || '').trim() : null;
  } catch {
    return null;
  }
}

function readIf(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function readJsonIf(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Recursively list files under dir (bounded), skipping heavy/irrelevant trees. */
function listFiles(dir, exts, acc = [], depth = 0) {
  if (acc.length >= MAX_SRC_FILES || depth > 6) return acc;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (acc.length >= MAX_SRC_FILES) break;
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '_generated') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) listFiles(p, exts, acc, depth + 1);
    else if (exts.some((x) => e.name.endsWith(x))) acc.push(p);
  }
  return acc;
}

// ── the checks ───────────────────────────────────────────────────────────────

/**
 * Run every launch check against `root`. Pure-ish: reads disk/git, writes
 * nothing. Returns { rung, checks[], summary } — see renderReport for shape.
 */
export function runLaunchChecks(root = process.cwd(), opts = {}) {
  root = resolve(root);
  const aiDocsDir = opts.aiDocsDir || process.env.FIA_AI_DOCS || join(root, 'ai-docs');
  // Repo-relative path for reports — always forward slashes, so a finding
  // reads the same (and diffs the same) on Windows and POSIX.
  const rel = (f) => f.slice(root.length + 1).replaceAll('\\', '/');
  const checks = [];
  const add = (section, id, level, status, label, detail = null, fix = null) =>
    checks.push({ section, id, level, status, label, ...(detail ? { detail } : {}), ...(fix ? { fix } : {}) });

  const env = parseEnvFile(readIf(join(root, '.env.local')));
  const pkg = readJsonIf(join(root, 'package.json')) || {};
  const vercelLinked = existsSync(join(root, '.vercel', 'project.json'));

  // Which services this project actually uses: the stack manifest decides;
  // artifacts on disk count too (older projects have no manifest).
  const stackMd = readIf(join(aiDocsDir, 'stack.md'));
  const declared = stackServices(stackMd);
  const clerkKey = env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || '';
  const usesConvex =
    Boolean(declared?.has('convex')) || existsSync(join(root, 'convex')) || Boolean(env.CONVEX_DEPLOYMENT);
  const usesClerk = Boolean(declared?.has('clerk')) || Boolean(clerkKey);
  const usesSql =
    Boolean(
      declared?.has('neon') || declared?.has('supabase') || declared?.has('drizzle') || declared?.has('prisma'),
    ) || Boolean(env.DATABASE_URL);
  // No manifest → assume Vercel (the only supported deploy path today).
  const usesVercel = declared ? declared.has('vercel') || vercelLinked : true;

  // Production signal for stacks without Clerk: a production URL on the
  // project's own domain (not localhost, not *.vercel.app).
  const prodEnv = {
    ...parseEnvFile(readIf(join(root, '.env.production'))),
    ...parseEnvFile(readIf(join(root, '.env.production.local'))),
  };
  const ownDomain = (v) =>
    /^https:\/\//i.test(String(v || '')) && !/localhost|127\.0\.0\.1|\.vercel\.app/i.test(String(v || ''));
  const prodUrl =
    ['NEXT_PUBLIC_APP_URL', 'NEXT_PUBLIC_SITE_URL', 'BETTER_AUTH_URL', 'APP_URL', 'SITE_URL']
      .map((k) => prodEnv[k] || env[k])
      .find(ownDomain) || null;
  const productionClerkKey =
    prodEnv.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || (clerkKey.startsWith('pk_live_') ? clerkKey : '');
  const localClerkSecret = env.CLERK_SECRET_KEY || '';
  const productionClerkSecret =
    prodEnv.CLERK_SECRET_KEY || (localClerkSecret.startsWith('sk_live_') ? localClerkSecret : '');
  const productionWebhookSecret =
    prodEnv.CLERK_WEBHOOK_SIGNING_SECRET || prodEnv.CLERK_WEBHOOK_SECRET || '';
  // Production markers count only from the production env mirror: a prod:
  // CONVEX_DEPLOYMENT inside .env.local is the misconfiguration
  // convex_dev_local warns about, never a green production signal.
  const productionConvex = Boolean(
    prodEnv.CONVEX_DEPLOY_KEY || /^(?:prod|production):/.test(prodEnv.CONVEX_DEPLOYMENT || ''),
  );

  const rung = detectRung({
    clerkKey: productionClerkKey,
    clerkSecretKey: productionClerkSecret,
    convexProduction: productionConvex,
    webhookSecret: productionWebhookSecret,
    vercelLinked,
    prodUrl,
    usesClerk,
    usesConvex,
  });

  // ── Versioning ──
  const inRepo = git(root, ['rev-parse', '--is-inside-work-tree']) === 'true';
  add(
    'Versioning',
    'git_repo',
    'blocker',
    inRepo ? 'pass' : 'fail',
    'Project versioned with git',
    null,
    inRepo ? null : 'git init && git add -A && git commit',
  );
  if (inRepo) {
    const dirty = git(root, ['status', '--porcelain']);
    add(
      'Versioning',
      'clean_tree',
      'blocker',
      dirty === '' ? 'pass' : 'fail',
      'No uncommitted changes',
      dirty ? `${dirty.split('\n').length} pending file(s)` : null,
      dirty ? 'commit before publishing (/sv)' : null,
    );

    const remote = git(root, ['remote', 'get-url', 'origin']);
    add(
      'Versioning',
      'remote',
      'warn',
      remote ? 'pass' : 'fail',
      'Remote repository (GitHub) configured',
      remote || null,
      remote ? null : 'create it with: gh repo create --private --source . --push',
    );

    if (remote) {
      const ahead = git(root, ['rev-list', '--count', '@{upstream}..HEAD']);
      if (ahead == null)
        add(
          'Versioning',
          'pushed',
          'warn',
          'skip',
          'Commits pushed to the remote',
          'branch has no upstream',
          'git push -u origin HEAD',
        );
      else
        add(
          'Versioning',
          'pushed',
          'warn',
          ahead === '0' ? 'pass' : 'fail',
          'Commits pushed to the remote',
          ahead === '0' ? null : `${ahead} unpushed commit(s)`,
          ahead === '0' ? null : 'git push',
        );

      const run = gh(root, ['run', 'list', '--limit', '1', '--json', 'conclusion,status,displayTitle']);
      if (run == null) add('Versioning', 'ci_green', 'warn', 'skip', 'CI green on GitHub', 'gh unavailable', null);
      else {
        let last = null;
        try {
          [last] = JSON.parse(run);
        } catch {
          /* the report degrades, never breaks */
        }
        // Repo with a remote but NO Actions run yet: `gh run list` returns
        // "[]" with exit 0 — that's a skip (nothing to demand), not a fail.
        if (!last) add('Versioning', 'ci_green', 'warn', 'skip', 'CI green on GitHub', 'no Actions run yet', null);
        else {
          const ok = last.conclusion === 'success';
          const title = `${last.displayTitle} → ${last.conclusion || last.status}`;
          add(
            'Versioning',
            'ci_green',
            'warn',
            ok ? 'pass' : 'fail',
            'CI green on GitHub',
            title,
            ok ? null : 'gh run watch',
          );
        }
      }
    }
  }
  const hasCi = existsSync(join(root, '.github', 'workflows'));
  add(
    'Versioning',
    'ci_workflow',
    'info',
    hasCi ? 'pass' : 'fail',
    'CI workflow present (.github/workflows)',
    null,
    hasCi ? null : 'the template ships ci.yml — check whether it was removed',
  );

  // ── Work ──
  const plan = readPlanTasks(aiDocsDir);
  if (!plan.available && plan.counts.total === 0) {
    add(
      'Work',
      'tasks_done',
      'info',
      'skip',
      'Plan tasks completed',
      'no ai-docs/todos — project has no mapped plan',
      null,
    );
  } else {
    const open = plan.counts.pending + plan.counts.inProgress + plan.counts.blocked;
    add(
      'Work',
      'tasks_done',
      'warn',
      open === 0 ? 'pass' : 'fail',
      'Plan tasks completed',
      open === 0 ? `${plan.counts.done}/${plan.counts.total} done` : `${open} open of ${plan.counts.total}`,
      open === 0 ? null : 'finish with /goal (or launch anyway, knowingly)',
    );
  }
  // Milestones marked done should carry browser QA evidence (ai-docs/qa/).
  {
    if (!existsSync(join(aiDocsDir, 'milestones.md'))) {
      add('Work', 'qa_evidence', 'info', 'skip', 'QA reports for done milestones', 'no ai-docs/milestones.md', null);
    } else {
      try {
        const gaps = qaEvidenceGaps(root);
        add(
          'Work',
          'qa_evidence',
          'warn',
          gaps.length === 0 ? 'pass' : 'fail',
          'QA reports for done milestones',
          gaps.length ? `missing for: ${gaps.join(', ')}` : 'every done milestone with UI has a passing report',
          gaps.length ? `run /qa ${gaps[0]} — browser evidence before treating the milestone as truly done` : null,
        );
      } catch {
        add(
          'Work',
          'qa_evidence',
          'warn',
          'fail',
          'QA reports for done milestones',
          'QA applicability could not be resolved from the validated UI contract',
          'resolve the UI contract blocker below, then run /qa for each done UI milestone',
        );
      }
    }
  }
  // Stack manifest: a "decide later" layer = launching without knowing what you
  // are launching — /launch treats it as a blocker and sends you to /stack.
  if (stackMd == null) {
    add(
      'Work',
      'stack_decided',
      'info',
      'skip',
      'Stack manifest (ai-docs/stack.md)',
      'no manifest — project predates /stack',
      null,
    );
  } else {
    // Only REAL pending markers (the manifest's instruction text mentions
    // "decide later" even when everything is decided): ◌ in the Summary
    // table and open checklist items in the Pending section.
    // Matches both the English marker and the legacy pt-BR one ("decidir depois").
    const tablePending = (stackMd.match(/◌\s*(decide later|decidir depois)/gi) || []).length;
    const listPending = (stackMd.match(/^- \[ \]/gm) || []).length;
    const pendings = Math.max(tablePending, listPending);
    add(
      'Work',
      'stack_decided',
      'blocker',
      pendings === 0 ? 'pass' : 'fail',
      'Stack decided (no "decide later")',
      pendings ? `${pendings} pending item(s) in the manifest` : null,
      pendings ? 'run /stack (or /idea) to decide before launching' : null,
    );
  }

  let validatedUiContract = null;
  // Deterministic UI applicability: any shipped frontend must have the same
  // validated contract planning agents, FDA gates and browser QA consume.
  // A game may legitimately skip enterprise capabilities; a missing/invalid
  // decision record is the blocker, not the skip itself.
  {
    const uiRoots = ['app', 'pages', 'components', 'src']
      .map((dir) => join(root, dir))
      .filter((dir) => existsSync(dir));
    const uiFiles = uiRoots.reduce(
      (count, dir) => count + listFiles(dir, ['.tsx', '.jsx', '.vue', '.svelte', '.astro']).length,
      0,
    );
    const frontendDeclared = /\|\s*Frontend\s*\|/i.test(stackMd || '');
    if (uiFiles === 0 && !frontendDeclared) {
      add(
        'Work',
        'ui_contract',
        'info',
        'skip',
        'UI applicability contract validated',
        'no frontend surfaces detected',
        null,
      );
    } else {
      const contractPath = join(aiDocsDir, 'ui', 'contract.json');
      const contract = readJsonIf(contractPath);
      const validation = contract ? validateUiContract(contract) : null;
      const valid = validation?.ok === true;
      if (valid) validatedUiContract = contract;
      const detail = valid
        ? `${contract.profile}; ${Object.values(contract.rules).filter((rule) => ['not_applicable', 'waived'].includes(rule.status)).length} explicit skip(s)`
        : !existsSync(contractPath)
          ? 'ai-docs/ui/contract.json is missing'
          : validation
            ? validation.errors
                .slice(0, 3)
                .map((error) => `${error.path}: ${error.message}`)
                .join('; ')
            : 'ai-docs/ui/contract.json is not valid JSON';
      add(
        'Work',
        'ui_contract',
        'blocker',
        valid ? 'pass' : 'fail',
        'UI applicability contract validated',
        detail,
        valid
          ? null
          : 'run /ui-contract, confirm the product profile, then run `node .agents/scripts/ui-contract.mjs check --json`',
      );
    }
  }

  // Executable UI evidence. Registry rows are documentation, not proof that
  // the canonical source still matches the shipped manifest (or that an
  // explicitly selected library/custom implementation exists). This blocker
  // deliberately stays separate from ui_contract so its repair is precise.
  if (!validatedUiContract) {
    add(
      'Work',
      'ui_kit_receipt',
      'info',
      'skip',
      'UI kit receipt matches executable source',
      'no validated applicable UI contract',
      null,
    );
  } else {
    const kit = verifyUiKitReceipt(root, validatedUiContract);
    const detail = kit.ok
      ? kit.outcome === 'skip'
        ? 'no active shared UI-kit surface in this product profile'
        : `${kit.canonical.length} canonical + ${kit.alternate.length} explicit alternate surface(s) verified`
      : kit.errors
          .slice(0, 4)
          .map((error) => `${error.code}${error.path ? ` (${Array.isArray(error.path) ? error.path.join(' | ') : error.path})` : ''}`)
          .join('; ');
    add(
      'Work',
      'ui_kit_receipt',
      kit.required ? 'blocker' : 'info',
      kit.ok ? (kit.outcome === 'skip' ? 'skip' : 'pass') : 'fail',
      'UI kit receipt matches executable source',
      detail,
      kit.ok
        ? null
        : 'run `node .agents/scripts/ui-kit.mjs install --target . --json`, materialize any explicitly selected library/custom surface, then run `node .agents/scripts/ui-kit.mjs verify --target . --json`',
    );
  }

  // Production runbooks: /launch executes ai-docs/apis/<tech>.md § Production
  // for each decided tech — a missing runbook sends you to /stack, never to
  // improvisation. Doc paths in the manifest are project-root-relative.
  const runbooks = stackRunbooks(stackMd);
  const readDoc = (docPath) => readIf(join(aiDocsDir, docPath.replace(/^ai-docs\//, '')));
  const hasProdSection = (text) => text != null && /^#{2,3}\s.*(production|produção)/im.test(text);
  const withDocs = runbooks.filter((r) => r.doc);
  if (withDocs.length) {
    const missing = withDocs.filter((r) => !hasProdSection(readDoc(r.doc)));
    add(
      'Work',
      'production_runbooks',
      'warn',
      missing.length === 0 ? 'pass' : 'fail',
      'Production runbooks written (ai-docs/apis/*.md § Production)',
      missing.length ? `missing: ${missing.map((r) => r.doc).join(', ')}` : `${withDocs.length} runbook(s) present`,
      missing.length ? 'run /stack <tech> — /launch executes each doc’s Production section' : null,
    );
  }

  // Test users: the auth convention — one dev test user per profile/role,
  // recorded in the ai-docs/test-credentials.md roster (profile → email →
  // where the password/code lives; never a real secret). Only rows between
  // the credentials:start/end markers count — the file's example table below
  // them must not satisfy the gate. Warning-level: launch can proceed, but
  // /test-ui and every QA flow reads this roster.
  {
    const usesAuth = Boolean(declared?.has('clerk') || declared?.has('better-auth')) || Boolean(clerkKey);
    if (usesAuth) {
      const credsMd = readIf(join(aiDocsDir, 'test-credentials.md'));
      const block =
        /<!--\s*credentials:start\s*-->([\s\S]*?)<!--\s*credentials:end\s*-->/.exec(credsMd || '')?.[1] ??
        credsMd ??
        '';
      const rosterRows = block
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('|') && /@/.test(l) && !/\{\{|<set-/.test(l));
      add(
        'Work',
        'test_credentials',
        'warn',
        rosterRows.length > 0 ? 'pass' : 'fail',
        'Test users recorded (ai-docs/test-credentials.md)',
        rosterRows.length
          ? `${rosterRows.length} test user(s) in the roster`
          : credsMd == null
            ? 'no roster file'
            : 'no filled rows between the credentials markers',
        rosterRows.length
          ? null
          : 'create one dev test user per profile/role (Clerk test mode: `+clerk_test` emails, fixed code 424242) and record them in the roster — the auth doc’s § Test users has the recipe',
      );
    }
  }

  const scripts = pkg.scripts || {};
  const missing = ['lint', 'typecheck', 'test', 'build'].filter(
    (s) => !scripts[s] && !(s === 'typecheck' && scripts['type-check']),
  );
  add(
    'Work',
    'quality_scripts',
    'warn',
    missing.length === 0 ? 'pass' : 'fail',
    'Quality commands in package.json',
    missing.length ? `missing: ${missing.join(', ')}` : null,
    missing.length ? 'the FDA gates and CI depend on them' : null,
  );

  // Docs sync: schema/deps moved but the docs did not. Warning-level on
  // purpose — stale docs mislead every future agent, but never block a launch
  // by themselves. Compares last-commit times (git log), so it only sees
  // committed history; an uncommitted schema edit is the clean_tree check's job.
  if (inRepo) {
    const lastCommitTs = (path) => {
      const out = git(root, ['log', '-1', '--format=%ct', '--', path]);
      return out ? Number(out) : 0;
    };
    const schemaish = ['convex/schema.ts', 'drizzle/', 'prisma/schema.prisma', 'migrations/', 'package.json']
      .map((p) => ({ p, ts: lastCommitTs(p) }))
      .filter((e) => e.ts > 0);
    if (!schemaish.length) {
      add(
        'Work',
        'docs_sync',
        'info',
        'skip',
        'Docs in sync with schema/deps',
        'no schema-ish files in git history yet',
        null,
      );
    } else if (stackMd == null && !existsSync(join(aiDocsDir, 'specs'))) {
      add(
        'Work',
        'docs_sync',
        'info',
        'skip',
        'Docs in sync with schema/deps',
        'no ai-docs/stack.md or ai-docs/specs/ to compare against',
        null,
      );
    } else {
      const docsTs = Math.max(lastCommitTs(join(aiDocsDir, 'stack.md')), lastCommitTs(join(aiDocsDir, 'specs')));
      const newest = schemaish.reduce((a, e) => (e.ts > a.ts ? e : a));
      const stale = newest.ts > docsTs;
      add(
        'Work',
        'docs_sync',
        'warn',
        stale ? 'fail' : 'pass',
        'Docs in sync with schema/deps',
        stale ? `${newest.p} committed after ai-docs/stack.md and ai-docs/specs/` : null,
        stale ? 'update ai-docs/stack.md (and the affected spec) — stale docs mislead every future agent' : null,
      );
    }
  }

  // Repo wiki freshness. Warning-level: a stale wiki page is worse than no page
  // at all, because every agent that trusts it wastes a round on outdated
  // architecture — but a stale page never breaks a deploy. Zero tokens: the
  // check is a content digest of each page's declared sources (wiki-check.mjs).
  {
    const wiki = runWikiCheck(root, { aiDocsDir });
    // The directory alone proves nothing: the harness SHIPS ai-docs/wiki/ with
    // its README explainer and a wiki-plan.yaml, so `available` is true on every
    // installed project. A wiki with zero pages is "not built yet", not a pass.
    if (!wiki.available || wiki.summary.total === 0) {
      add(
        'Work',
        'wiki_fresh',
        'info',
        'skip',
        'Repo wiki matches the code it describes',
        wiki.available ? 'ai-docs/wiki/ has no pages yet' : 'no ai-docs/wiki/ yet',
        'run /absorb to build one — agents then answer from it instead of re-reading the repo',
      );
    } else {
      // Three ways a wiki stops describing the code, and this row used to count
      // only the first: STALE (a declared source changed), SOURCES GONE (every
      // path the page declares was deleted or renamed — the page describes code
      // that no longer exists and can never go stale again), and NOTHING
      // CHECKABLE (no page declares `sources:` at all, so a clean report proves
      // nothing was verified). Counting stale alone printed a green "matches the
      // code it describes" over `0 fresh · 0 stale · 4 unverifiable`.
      const stale = wiki.pages.filter((p) => p.status === 'stale').map((p) => p.file);
      const gone = wiki.pages.filter(hasSourcesGone).map((p) => p.file);
      const unverifiable = wiki.summary.unverifiable || 0;
      const nothingCheckable = unverifiable === wiki.summary.total;
      const named = [...stale, ...gone];
      const detail = named.length
        ? named.slice(0, 5).join(', ') + (named.length > 5 ? ` (+${named.length - 5})` : '')
        : nothingCheckable
          ? `${wiki.summary.total} page(s), none declaring sources: — nothing is being checked`
          : unverifiable
            ? `${wiki.summary.fresh} verified, ${unverifiable} page(s) declare no sources: and cannot be`
            : null;
      const fix = gone.length
        ? 'those pages point only at paths that no longer exist — rewrite them with /absorb, then `node imp/scripts/wiki-check.mjs --stamp`'
        : stale.length
          ? 'run /absorb to refresh the stale pages (hand-written <!-- human --> blocks are preserved), then `node imp/scripts/wiki-check.mjs --stamp`'
          : 'no page declares `sources:`, so freshness is never checked — re-run /absorb to wire each page to the files it describes';
      const failing = stale.length > 0 || gone.length > 0 || nothingCheckable;
      add(
        'Work',
        'wiki_fresh',
        'warn',
        failing ? 'fail' : 'pass',
        'Repo wiki matches the code it describes',
        detail,
        failing ? fix : null,
      );
    }
  }

  // Specs without a diagram. Warning-level: the prose is the contract, but a
  // ```mermaid flow is what makes a spec readable at a glance — and /spec asks
  // for one under `## Flow`, so a spec without it skipped a step.
  {
    const specs = readPlanSpecs(aiDocsDir);
    if (!specs.available || specs.counts.total === 0) {
      add('Work', 'spec_diagrams', 'info', 'skip', 'Every spec carries a flow diagram', 'no specs yet', null);
    } else {
      const missing = specs.specs.filter((s) => !s.hasDiagram).map((s) => s.id);
      add(
        'Work',
        'spec_diagrams',
        'warn',
        missing.length === 0 ? 'pass' : 'fail',
        'Every spec carries a flow diagram',
        missing.length
          ? `no \`\`\`mermaid block in spec ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ` (+${missing.length - 6})` : ''}`
          : null,
        missing.length ? 'add a `## Flow` mermaid diagram to each — /spec writes one for new specs' : null,
      );
    }
  }

  // Theme tokens: colors belong to the theme CSS variables (/theme), never
  // hardcoded in components — the design-system skill's rule 8, enforced.
  // Only 6/8-digit hex is matched: 3-digit collides with anchors ("#faq") and
  // 6-digit anchor ids are almost never valid hex. Warning-level: charts and
  // one-offs exist, but each one is a drift the next /theme cannot restyle.
  {
    const uiDirs = ['components', 'app', 'src/components', 'src/app']
      .map((d) => join(root, d))
      .filter((d) => existsSync(d));
    if (uiDirs.length) {
      const hex = /#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\b/;
      const offenders = [];
      for (const dir of uiDirs) {
        for (const f of listFiles(dir, ['.tsx', '.jsx'])) {
          if (/[/\\]emails?[/\\]/.test(f)) continue; // react-email inlines styles by design
          if (hex.test(readIf(f) || '')) offenders.push(rel(f));
        }
      }
      add(
        'Work',
        'theme_tokens',
        'warn',
        offenders.length === 0 ? 'pass' : 'fail',
        'No hardcoded hex colors in UI components',
        offenders.length
          ? offenders.slice(0, 5).join(', ') + (offenders.length > 5 ? ` (+${offenders.length - 5})` : '')
          : null,
        offenders.length
          ? 'use the theme CSS variables — raw hex is invisible to /theme (design-system skill, rule 8)'
          : null,
      );
    }
  }

  // Component registry, two failure modes. (1) BLIND registry: the code has
  // reusable components but the registry knows none of them — the reuse lock
  // the task briefs enforce has nothing to defend, so every screen is free to
  // hand-roll a duplicate (typical of a harness dropped onto an existing app
  // whose /kit or /absorb never ran). (2) A row still `planned` at launch is
  // a component the design system promised (core kit or /component) and
  // nobody built. Both warning-level: a deliberately deferred component
  // (Kanban, charts) is legitimate, but each should be a conscious call at
  // launch, not a leftover.
  {
    const registryMd = readIf(join(aiDocsDir, 'components', 'registry.md'));
    const body =
      registryMd == null ? '' : /<!-- registry:start -->([\s\S]*?)<!-- registry:end -->/.exec(registryMd)?.[1] || '';
    const rows = body
      .split('\n')
      .map((line) => line.split('|').map((c) => c.trim()))
      .filter((cells) => cells.length > 8);
    // Any conventional component root counts — the "harness dropped onto a
    // real app" case keeps its components in src/components/, app/components/
    // or src/ui/ at least as often as in components/.
    const codeComponents = ['components', 'src/components', 'app/components', 'src/ui']
      .map((d) => join(root, d))
      .filter((d) => existsSync(d))
      .reduce((n, d) => n + listFiles(d, ['.tsx']).length, 0);
    if (rows.length === 0 && codeComponents >= 5) {
      add(
        'Work',
        'registry_seeded',
        'warn',
        'fail',
        'Component registry knows the components the code has',
        `${codeComponents} component files under components/, ${registryMd == null ? 'no ai-docs/components/registry.md' : 'zero registry rows'}`,
        'run /kit (inventory + gap audit) — a blind registry cannot enforce component reuse',
      );
    } else if (rows.length === 0) {
      add(
        'Work',
        'registry_seeded',
        'info',
        'skip',
        'Component registry knows the components the code has',
        'no registry rows and no reusable component files yet',
        null,
      );
    } else {
      add(
        'Work',
        'registry_seeded',
        'warn',
        'pass',
        'Component registry knows the components the code has',
        null,
        null,
      );
      const stillPlanned = rows.filter((cells) => cells[7] === 'planned').map((cells) => cells[1]);
      add(
        'Work',
        'registry_planned',
        'warn',
        stillPlanned.length === 0 ? 'pass' : 'fail',
        'No component registry row left planned',
        stillPlanned.length
          ? `still planned: ${stillPlanned.slice(0, 6).join(', ')}${stillPlanned.length > 6 ? ` (+${stillPlanned.length - 6})` : ''}`
          : null,
        stillPlanned.length
          ? 'install it (/component) or drop the row — a planned row is a promise the reuse lock relies on (design-system skill, references/core-kit.md)'
          : null,
      );
    }
  }

  // ── Secrets ──
  if (inRepo) {
    const tracked = (git(root, ['ls-files', '.env', '.env.local', '.env.production', '.env.production.local', '.env.development', '.env.development.local']) || '')
      .split('\n')
      .filter(Boolean);
    add(
      'Secrets',
      'env_untracked',
      'blocker',
      tracked.length === 0 ? 'pass' : 'fail',
      'No .env with secrets inside the repo',
      tracked.length ? `in git: ${tracked.join(', ')}` : null,
      tracked.length ? 'git rm --cached <file> and add it to .gitignore NOW — then ROTATE the exposed keys' : null,
    );
  }
  add(
    'Secrets',
    'env_example',
    'warn',
    existsSync(join(root, '.env.example')) ? 'pass' : 'fail',
    '.env.example (names only) present',
    null,
    'document the variables without values',
  );
  const leaked = Object.entries(env).filter(([k, v]) => k.startsWith('NEXT_PUBLIC_') && looksLikeSecret(v));
  add(
    'Secrets',
    'no_public_secrets',
    'blocker',
    leaked.length === 0 ? 'pass' : 'fail',
    'No secret in a NEXT_PUBLIC_* variable',
    leaked.length ? leaked.map(([k]) => k).join(', ') : null,
    leaked.length ? "NEXT_PUBLIC_* reaches everyone's browser — rename it and ROTATE the key" : null,
  );

  // ── Security (deterministic greps; the security skill is the full standard) ──
  if (usesConvex) {
    const convexFiles = listFiles(join(root, 'convex'), ['.ts']);
    const rawFns = [];
    for (const f of convexFiles) {
      if (/[/\\]lib[/\\]/.test(f)) continue;
      const src = readIf(f) || '';
      if (/=\s*(query|mutation)\s*\(/.test(src)) rawFns.push(rel(f));
    }
    add(
      'Security',
      'raw_functions',
      'warn',
      rawFns.length === 0 ? 'pass' : 'fail',
      'No raw query/mutation outside convex/lib',
      rawFns.length ? rawFns.slice(0, 5).join(', ') : null,
      rawFns.length ? 'use authedQuery/authedMutation (security skill, pillar 1)' : null,
    );
  } else {
    add(
      'Security',
      'raw_functions',
      'info',
      'skip',
      'No raw query/mutation outside convex/lib',
      'stack does not use Convex',
      null,
    );
  }

  // One L1 scan serves both checks below (security-scan.mjs owns the rule table
  // and its own wider file walk — app/, components/, src/, lib/, pages/ — so a
  // `src/`-layout project is no longer silently unscanned).
  {
    const scan = runSecurityScan(root);
    const where = (hits) =>
      hits
        .slice(0, 5)
        .map((f) => `${f.file}:${f.line}`)
        .join(', ') + (hits.length > 5 ? ` (+${hits.length - 5})` : '');

    const danger = scan.findings.filter((f) => f.ruleId === 'dangerous_html');
    add(
      'Security',
      'dangerous_html',
      'warn',
      danger.length === 0 ? 'pass' : 'fail',
      'No dangerouslySetInnerHTML',
      danger.length ? where(danger) : null,
      danger.length ? 'never with user content — React escapes by default' : null,
    );

    // The rest of the L1 pack as one line. A TRUNCATED scan must never report
    // 'pass': a partial scan that says clean is the worst failure mode there is.
    const highs = scan.findings.filter((f) => f.severity === 'high');
    if (!scan.available) {
      add(
        'Security',
        'security_l1',
        'info',
        'skip',
        'L1 security scan clean (deterministic patterns)',
        'no source roots to scan',
        null,
      );
    } else if (scan.summary.truncated) {
      add(
        'Security',
        'security_l1',
        'warn',
        'fail',
        'L1 security scan clean (deterministic patterns)',
        `scan stopped at the ${scan.summary.filesScanned}-file cap — the result is partial`,
        'rescan a subtree: node imp/scripts/security-scan.mjs --dir <subdir>',
      );
    } else {
      add(
        'Security',
        'security_l1',
        'warn',
        highs.length === 0 ? 'pass' : 'fail',
        'L1 security scan clean (deterministic patterns)',
        highs.length
          ? where(highs)
          : `${scan.summary.filesScanned} file(s) scanned, ${scan.summary.medium} medium / ${scan.summary.low} low`,
        highs.length
          ? 'see every finding with: node imp/scripts/security-scan.mjs (the security skill is the full standard)'
          : null,
      );
    }
  }

  const httpTs = readIf(join(root, 'convex', 'http.ts'));
  if (httpTs == null)
    add(
      'Security',
      'webhook_verify',
      'info',
      'skip',
      'Webhooks verify their signature',
      usesConvex ? 'no convex/http.ts' : 'no convex/http.ts (stack does not use Convex)',
      null,
    );
  else
    add(
      'Security',
      'webhook_verify',
      'blocker',
      /(?:\.verify|\bverifyWebhook)\s*\(/.test(httpTs) ? 'pass' : 'fail',
      'Webhooks verify their signature',
      null,
      'verify the signature (official Clerk helper / Stripe) over the RAW body before any JSON.parse',
    );

  // ── Production ──
  if (usesVercel)
    add(
      'Production',
      'vercel_linked',
      'info',
      vercelLinked ? 'pass' : 'fail',
      'Project linked on Vercel',
      null,
      vercelLinked ? null : 'vercel link (/launch does this for you)',
    );
  else
    add(
      'Production',
      'vercel_linked',
      'info',
      'skip',
      'Project linked on Vercel',
      'deploy layer not decided in ai-docs/stack.md',
      'decide the deploy layer with /stack',
    );
  if (usesConvex) {
    const vercelJson = readJsonIf(join(root, 'vercel.json'));
    const buildCmd = vercelJson?.buildCommand || '';
    add(
      'Production',
      'convex_build_cmd',
      'info',
      /convex deploy/.test(buildCmd) ? 'pass' : 'skip',
      'Vercel build publishes production Convex',
      buildCmd || 'no vercel.json',
      /convex deploy/.test(buildCmd) ? 'requires CONVEX_DEPLOY_KEY (Production) in the Vercel envs' : null,
    );
    const dep = env.CONVEX_DEPLOYMENT || '';
    if (dep)
      add(
        'Production',
        'convex_dev_local',
        'info',
        'pass',
        'Local backend points at the DEV deployment',
        dep.startsWith('dev:') ? dep : `${dep} (warning: does not look like dev)`,
        'normal — production is published via npx convex deploy',
      );
  }
  if (usesClerk) {
    const livePair =
      productionClerkKey.startsWith('pk_live_') && productionClerkSecret.startsWith('sk_live_');
    add(
      'Production',
      'clerk_keys',
      'production',
      livePair ? 'pass' : 'fail',
      'Clerk Production uses a matching pk_live_/sk_live_ pair',
      livePair ? null : 'development or incomplete Clerk key pair',
      livePair
        ? null
        : 'configure both live keys in Vercel Production AND record them in .env.production.local (gitignored) so this check can see them — pk_test_/sk_test_ stay in local/Preview and the explicit beta rung',
    );
    const prodWebhookOk = productionWebhookSecret.startsWith('whsec_');
    add(
      'Production',
      'clerk_production_webhook',
      'production',
      prodWebhookOk ? 'pass' : 'fail',
      'Clerk Production webhook signing secret configured',
      prodWebhookOk ? null : productionWebhookSecret ? 'invalid signing-secret format' : 'not found in production env metadata',
      prodWebhookOk
        ? null
        : 'create the webhook in the Clerk production instance, set CLERK_WEBHOOK_SIGNING_SECRET on Convex Production (npx convex env set … --prod), and record it in .env.production.local (gitignored) so this check can see it',
    );
    add(
      'Production',
      'production_domain',
      'production',
      prodUrl ? 'pass' : 'fail',
      'Production URL uses the final own domain',
      prodUrl || 'no own-domain URL in .env.production(.local)',
      prodUrl ? null : 'attach the domain, then record NEXT_PUBLIC_APP_URL (or NEXT_PUBLIC_SITE_URL) in .env.production.local',
    );
  }
  if (usesConvex)
    add(
      'Production',
      'convex_production',
      'production',
      productionConvex ? 'pass' : 'fail',
      'Convex Production deployment is explicit',
      productionConvex ? null : 'no production deploy key/deployment marker found',
      productionConvex
        ? null
        : 'configure CONVEX_DEPLOY_KEY in Vercel Production or record a prod: CONVEX_DEPLOYMENT in .env.production.local',
    );
  if (!usesClerk && (usesSql || declared)) {
    // The production signal for SQL stacks (Better Auth + Neon/Supabase).
    add(
      'Production',
      'prod_url',
      'info',
      prodUrl ? 'pass' : 'skip',
      'Production URL on your own domain',
      prodUrl || 'none found in .env.production or .env.local',
      prodUrl
        ? null
        : 'after attaching your domain, set NEXT_PUBLIC_APP_URL in .env.production (and on Vercel) — this is what marks the production rung',
    );
  }
  // Automations layer (Modal etc.): a SECOND deploy target — its Production
  // runbook is the ONLY recipe /launch has for it, so a missing/empty doc is
  // a blocker (the app recipes are inline in the command; this one is not).
  const automation = runbooks.find((r) => r.automations && r.external);
  if (automation) {
    const ok = automation.doc != null && hasProdSection(readDoc(automation.doc));
    add(
      'Production',
      'automations_runbook',
      'blocker',
      ok ? 'pass' : 'fail',
      `Automations runbook ready (${automation.choice})`,
      ok
        ? automation.doc
        : automation.doc
          ? `${automation.doc} has no Production section`
          : 'manifest names no ai-docs/apis/<tech>.md doc',
      ok
        ? null
        : 'run /stack — the automations service deploys separately (e.g. `modal deploy`); /launch needs its Production runbook',
    );
  }

  // ── Operations ──
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const hasSentry = Boolean(deps['@sentry/nextjs']) || existsSync(join(root, 'sentry.server.config.ts'));
  add(
    'Operations',
    'error_monitor',
    'warn',
    hasSentry ? 'pass' : 'fail',
    'Error monitor (Sentry) in the project',
    null,
    hasSentry
      ? 'confirm SENTRY_AUTH_TOKEN in the build for readable source maps'
      : "without it you never hear about your users' errors",
  );
  const backups = [];
  const backupDirs = opts.backupsDir
    ? [opts.backupsDir]
    : [join(homedir(), 'Documents', 'convex-backups'), join(homedir(), 'Documents', 'db-backups')];
  for (const bdir of backupDirs) {
    try {
      backups.push(...readdirSync(bdir).filter((n) => !n.startsWith('.')));
    } catch {
      /* missing folder = no backup yet */
    }
  }
  // The fix command depends on the stack — never send `convex export` to a SQL project.
  const backupFix = usesConvex
    ? 'run /sv (npx convex export)'
    : usesSql
      ? 'run /sv (pg_dump "$DATABASE_URL" > backup.sql)'
      : 'export your database with /sv';
  add(
    'Operations',
    'backup_exists',
    'warn',
    backups.length > 0 ? 'pass' : 'fail',
    'At least one database backup exists',
    backups.length ? `${backups.length} file(s)` : null,
    backups.length ? 'rehearse a RESTORE once (on a test deployment) — an untested backup is not a backup' : backupFix,
  );

  // Production-rung requirements (level 'production') fail closed for the
  // production rung but are NOT publish blockers for a beta/preview — they
  // get their own bucket so `--strict`, /launch and loop-health stay green on
  // a healthy dev/beta project.
  const summary = { blockers: 0, productionGaps: 0, warns: 0, passes: 0, skips: 0 };
  for (const c of checks) {
    if (c.status === 'pass') summary.passes++;
    else if (c.status === 'skip') summary.skips++;
    else if (c.level === 'blocker') summary.blockers++;
    else if (c.level === 'production') summary.productionGaps++;
    else summary.warns++;
  }
  return { rung, checks, summary, root };
}

// ── rendering ────────────────────────────────────────────────────────────────

const RUNG_LABEL = {
  local: 'LOCAL — the app has never been published',
  beta: 'BETA/PREVIEW — linked on Vercel; production requirements are not complete',
  production: 'PRODUCTION — live keys, backend, webhook, and own domain detected',
};

/** Human report. Pure string building — easy to test. */
export function renderReport(report) {
  const glyph = (c) =>
    c.status === 'pass' ? '✓' : c.status === 'skip' ? '–' : c.level === 'blocker' ? '✗' : c.level === 'production' ? '▲' : '!';
  const lines = [];
  lines.push('Launch readiness — report (nothing was published by this command)');
  lines.push(`Current rung: ${RUNG_LABEL[report.rung] || report.rung}`);
  let section = null;
  for (const c of report.checks) {
    if (c.section !== section) {
      section = c.section;
      lines.push('', `${section}`);
    }
    lines.push(`  ${glyph(c)} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
    if (c.status === 'fail' && c.fix) lines.push(`      → ${c.fix}`);
  }
  const s = report.summary;
  const prodGaps = s.productionGaps || 0;
  lines.push(
    '',
    `Result: ${s.passes} ok · ${s.blockers} blocker(s) · ${prodGaps} production requirement(s) open (▲) · ${s.warns} warning(s) · ${s.skips} n/a`,
  );
  lines.push(
    s.blockers > 0
      ? 'Fix the blockers (✗) before publishing. /launch (in pi) walks you through each one.'
      : report.rung === 'production'
        ? 'All green on the essentials. Run this report again after every big change.'
        : prodGaps > 0
          ? `No blockers for a beta/preview publish. ${prodGaps} production requirement(s) (▲) stay open until the production rung — /launch Step 4 resolves them.`
          : 'No blockers — /launch (in pi) takes you to the next rung.',
  );
  return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const isMain = isMainModule(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const dirIx = argv.indexOf('--dir');
  const root = dirIx !== -1 && argv[dirIx + 1] ? resolve(argv[dirIx + 1]) : process.cwd();
  const report = runLaunchChecks(root);
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else console.log(renderReport(report));
  if (argv.includes('--strict') && report.summary.blockers > 0) process.exit(1);
}
