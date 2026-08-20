#!/usr/bin/env node
// Env preflight — deterministic dev-env gate for the foundation task.
//
// Reads ai-docs/stack.md (the manifest is the source of truth), derives the
// dev keys the DECLARED stack reads at build/boot time, and checks .env.local.
// The task-sequencer runs this BEFORE writing the foundation brief, so a
// missing Convex/Clerk/database key surfaces as one cheap command with an
// exact fix — not as a rejected review after the whole scaffold was built
// (`npm run build` crashing on prerender because the provider read an env
// var that never existed).
//
// Usage: node imp/scripts/env-preflight.mjs [--json] [--dir <root>]
// Exit 0 = every required key present (or nothing declared); 1 = keys missing.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnvFile, stackServices } from './fia-launch-check.mjs';

/**
 * One rule per service the manifest can declare, listing ONLY the keys whose
 * absence breaks `npm run build` or the dev boot of the scaffold — runtime
 * optionals (R2, Modal, Vercel) are launch-check territory, not preflight.
 * `fix` is copy-pastable: the gate's report is the remediation, no research.
 */
const RULES = [
  {
    service: 'convex',
    when: (s) => s.has('convex'),
    keys: ['NEXT_PUBLIC_CONVEX_URL', 'CONVEX_DEPLOYMENT'],
    fix: 'npm install convex && npx convex dev --once — logs in on first run, creates the dev deployment and writes both keys to .env.local',
  },
  {
    service: 'clerk',
    when: (s) => s.has('clerk'),
    keys: ['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY'],
    fix: 'run the Impactus installer — or manually: `npx -y clerk@3.1.0 auth login`, then `npx -y clerk@3.1.0 link`, then `npx -y clerk@3.1.0 env pull --instance dev --file .env.local` to link a dev app and write both keys',
  },
  {
    service: 'database',
    when: (s) => s.has('neon') || s.has('drizzle') || s.has('prisma'),
    keys: ['DATABASE_URL'],
    fix: 'Neon: npx neon-new@latest --yes creates a dev database with no account (claim it later) — otherwise paste the dev DATABASE_URL into .env.local',
  },
  {
    service: 'supabase',
    when: (s) => s.has('supabase'),
    keys: ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'],
    fix: 'supabase dashboard → Project Settings → API — the engineer pastes URL + anon key into .env.local',
  },
  {
    service: 'better-auth',
    when: (s) => s.has('better-auth'),
    keys: ['BETTER_AUTH_SECRET'],
    fix: 'openssl rand -base64 32 → paste as BETTER_AUTH_SECRET in .env.local',
  },
];

/**
 * Run the preflight against `root`. Pure-ish: reads disk, writes nothing.
 * No manifest → passes with `manifest: false` — the gate only enforces what
 * `ai-docs/stack.md` declares; it never guesses a stack to demand keys for.
 */
export function runEnvPreflight(root = process.cwd(), opts = {}) {
  root = resolve(root);
  const aiDocsDir = opts.aiDocsDir || process.env.FIA_AI_DOCS || join(root, 'ai-docs');
  const manifestPath = join(aiDocsDir, 'stack.md');
  const stackMd = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : null;
  const services = stackServices(stackMd);

  const envPath = join(root, '.env.local');
  const env = parseEnvFile(existsSync(envPath) ? readFileSync(envPath, 'utf8') : '');

  const required = [];
  if (services) {
    for (const rule of RULES) {
      if (!rule.when(services)) continue;
      for (const key of rule.keys) {
        required.push({ key, service: rule.service, present: Boolean(env[key]), fix: rule.fix });
      }
    }
  }
  const missing = required.filter((r) => !r.present);
  return {
    passed: missing.length === 0,
    manifest: services !== null,
    envFile: existsSync(envPath),
    services: services ? [...services].sort() : [],
    required,
    missing,
  };
}

export function renderPreflight(report) {
  const lines = ['Env preflight — dev keys the declared stack reads at build/boot', ''];
  if (!report.manifest) {
    lines.push('○ no ai-docs/stack.md — nothing declared, nothing to require (run /stack to decide the stack first)');
    return lines.join('\n');
  }
  if (!report.required.length) {
    lines.push(`✓ the declared stack (${report.services.join(', ') || 'none recognized'}) needs no dev keys before the scaffold`);
    return lines.join('\n');
  }
  for (const r of report.required) {
    lines.push(`${r.present ? '✓' : '✗'} ${r.key}  (${r.service})`);
  }
  if (report.missing.length) {
    if (!report.envFile) lines.push('', '.env.local does not exist yet.');
    lines.push('', 'Fix, per service:');
    for (const fix of [...new Set(report.missing.map((r) => r.fix))]) lines.push(`- ${fix}`);
    lines.push('', 'Then re-run: node imp/scripts/env-preflight.mjs');
  } else {
    lines.push('', 'All present — the foundation build can read everything it needs.');
  }
  return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

// realpath both sides: Node realpaths the ESM entry for import.meta.url, so a
// symlinked invocation path would otherwise make the CLI a silent no-op.
const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  }
})();
if (isMain) {
  const argv = process.argv.slice(2);
  const dirIx = argv.indexOf('--dir');
  const root = dirIx !== -1 && argv[dirIx + 1] ? resolve(argv[dirIx + 1]) : process.cwd();
  const report = runEnvPreflight(root);
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else console.log(renderPreflight(report));
  if (!report.passed) process.exit(1);
}
