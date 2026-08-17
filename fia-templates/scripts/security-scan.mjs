#!/usr/bin/env node
/**
 * L1 security scanner — deterministic, READ-ONLY, zero tokens.
 *
 * A rule table of conservative textual patterns run over the project's source
 * roots. This is layer 1 only: it finds the mistakes a regex can prove are
 * there (a secret literal committed in code, `eval(`, a NEXT_PUBLIC_ variable
 * whose NAME says "secret"). Semantic review — authorization models, tenant
 * isolation, business-rule bypasses — stays with the `security` skill; nothing
 * here replaces it.
 *
 * Why it exists as its own script: the launch check greps three of these
 * patterns, but only at launch time and only under app/ + components/, so a
 * `src/`-layout project was silently unscanned. This runs anywhere, prints a
 * machine-readable report (--json), speaks SARIF for CI code-scanning
 * (--sarif) and can gate a pipeline (--fail-on high).
 *
 * Design rules kept on purpose:
 *   - A false positive is worse than a miss. Students who learn to ignore the
 *     report get nothing out of it, so every pattern is narrow and every
 *     known-legitimate shape (tagged `sql` templates, NEXT_PUBLIC_*_ANON_KEY,
 *     the SVG xmlns URL) is excluded explicitly.
 *   - Never throws. A missing root, an unreadable file or a binary blob
 *     degrades to "nothing found here", never to a crash.
 *   - Deterministic: sorted file walk, stable severity/file/line ordering, so
 *     two runs over the same tree produce byte-identical output.
 *
 * Usage:
 *   node imp/scripts/security-scan.mjs [--dir <root>] [--json] [--sarif]
 *                                      [--fail-on high|medium|low]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Severity order, most serious first — the index IS the ranking. */
export const SEVERITIES = Object.freeze(['high', 'medium', 'low']);

/** Default source roots: every conventional layout, so `src/` is never missed. */
const SOURCE_ROOTS = Object.freeze(['app', 'components', 'src', 'lib', 'pages']);
const SOURCE_EXTS = Object.freeze(['.ts', '.tsx', '.js', '.jsx', '.mjs']);

const DEFAULT_MAX_FILES = 1500;
const DEFAULT_MAX_DEPTH = 8;
const EXCERPT_MAX = 160;

/** Directories that never hold reviewable source. */
const SKIP_DIRS = Object.freeze(['node_modules', 'dist', 'build', 'coverage', '.next', '_generated']);

const SARIF_SCHEMA = 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json';
const SARIF_LEVEL = Object.freeze({ high: 'error', medium: 'warning', low: 'note' });

/**
 * The rule table. `id` is a PUBLIC CONTRACT (CI configs and the launch check
 * key off it) — never rename one, only add.
 *
 * Rule shape:
 *   { id, severity, title, roots, exts, pattern, fix }
 *   pattern         — matched per LINE, so the line number is exact. Declared
 *                     WITHOUT the `g` flag by convention: a global regex
 *                     carries `lastIndex` between calls and would skip hits
 *                     from one file to the next. scanText resets it anyway.
 *   absentPattern   — optional, FILE-level veto: when it matches anywhere in
 *                     the file, the rule stays quiet for that file. This is
 *                     how "X without a sibling Y" rules are expressed instead
 *                     of contorting a single regex into a negative lookahead
 *                     over the whole file.
 *   basenamePattern — optional: only files whose basename matches are scanned.
 *   excludePathPattern — optional: repo-relative (forward-slash) paths that
 *                     match are skipped.
 */
export const RULES = Object.freeze([
  {
    id: 'dangerous_html',
    severity: 'medium',
    title: 'dangerouslySetInnerHTML renders unescaped HTML',
    roots: SOURCE_ROOTS,
    exts: SOURCE_EXTS,
    pattern: /dangerouslySetInnerHTML/,
    fix: 'Render the value as text (React escapes by default) or sanitize it server-side before injecting HTML.',
  },
  {
    id: 'raw_sql_interpolation',
    // Only the UNSAFE shapes: a template literal with `${}` passed INTO a
    // query call, or a quoted string concatenated with `+`. A tagged template
    // (sql`... ${id}`) has no `(` after the tag and is parameterized by the
    // driver, so it must never fire here.
    severity: 'high',
    title: 'SQL built by string interpolation or concatenation',
    roots: SOURCE_ROOTS,
    exts: SOURCE_EXTS,
    pattern: /\b(?:query|execute|raw|sql)\s*\(\s*(?:`[^`]*\$\{|'[^']*'\s*\+|"[^"]*"\s*\+)/,
    fix: 'Pass the values as query parameters (placeholders or a tagged sql`` template) instead of building the string.',
  },
  {
    id: 'jwt_decode_without_verify',
    // decode() only base64-decodes: the signature is never checked, so the
    // claims are attacker-controlled. A file that also verifies somewhere is
    // assumed to be doing the decode for display/logging — that is the
    // documented veto, and it is deliberately generous (a miss beats noise).
    severity: 'high',
    title: 'JWT decoded without verifying its signature',
    roots: SOURCE_ROOTS,
    exts: SOURCE_EXTS,
    pattern: /\bjwtDecode\s*\(|\bjwt\s*\.\s*decode\s*\(/,
    // `\bverif` catches verify( / .verify( / verifyToken; `[a-z]Verif` catches
    // the camelCase forms (jwtVerify, getVerified) whose V has no word boundary.
    absentPattern: /\bverif|[a-z]Verif/,
    fix: 'Verify the token signature (jwtVerify / jose / the provider SDK) before trusting any claim.',
  },
  {
    id: 'public_env_secret',
    // A NEXT_PUBLIC_/VITE_/PUBLIC_ variable is inlined into the browser
    // bundle, so a secret-sounding NAME is already the bug. Two branches:
    //   1. the name contains SECRET/PRIVATE/TOKEN/PASSWORD — always wrong;
    //   2. the name ends in _KEY — wrong UNLESS it is one of the five keys
    //      that are public BY DESIGN: PUBLISHABLE_KEY (Clerk/Stripe),
    //      API_KEY (public browser API keys), ANON_KEY (Supabase),
    //      PUBLIC_KEY and POSTHOG_KEY (PostHog's browser Project API key —
    //      `phc_…`, which THIS installer prompts for and the live templates
    //      ship; without it the product's own analytics addon produced seven
    //      HIGH findings on a day-one install and told the student to rotate
    //      a key that is public by design). Those five are excluded by a
    //      tempered match so NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY stays silent
    //      while NEXT_PUBLIC_SIGNING_KEY does not.
    severity: 'high',
    title: 'Secret-looking value exposed in a browser-visible env variable',
    roots: SOURCE_ROOTS,
    exts: SOURCE_EXTS,
    pattern:
      /\b(?:NEXT_PUBLIC|VITE|PUBLIC)_(?:[A-Z0-9_]*(?:SECRET|PRIVATE|TOKEN|PASSWORD)[A-Z0-9_]*|(?:(?!PUBLISHABLE_KEY\b|API_KEY\b|ANON_KEY\b|PUBLIC_KEY\b|POSTHOG_KEY\b)[A-Z0-9_])*_KEY)\b/,
    fix: 'Drop the public prefix, read the value only on the server, and rotate the key that was already exposed.',
  },
  {
    id: 'eval_usage',
    severity: 'high',
    title: 'Code built and executed at runtime (eval / new Function)',
    roots: SOURCE_ROOTS,
    exts: SOURCE_EXTS,
    pattern: /\beval\s*\(|\bnew\s+Function\s*\(/,
    fix: 'Replace the dynamic evaluation with an explicit lookup table or a parser that only accepts known input.',
  },
  {
    id: 'child_process_shell_true',
    severity: 'high',
    title: 'Child process spawned through a shell (shell: true)',
    roots: SOURCE_ROOTS,
    exts: SOURCE_EXTS,
    pattern: /shell:\s*true/,
    fix: 'Spawn the binary with an argument array and no shell, so no input can be interpreted as a shell command.',
  },
  {
    id: 'http_url',
    // Loopback addresses are dev URLs, and the w3.org/schema namespaces are
    // XML identifiers that are never fetched — excluding them keeps this low
    // rule from drowning every SVG component in noise.
    severity: 'low',
    title: 'Plaintext http:// URL',
    roots: SOURCE_ROOTS,
    exts: SOURCE_EXTS,
    pattern: /\bhttp:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|www\.w3\.org|schemas?\.|json-schema\.org)/,
    fix: 'Use https:// — a plaintext request leaks its payload and can be rewritten in transit.',
  },
  {
    id: 'missing_auth_check',
    // A mutating route handler with no mention of auth/session anywhere in the
    // file is an unauthenticated write endpoint. The veto is file-level and
    // generous on purpose (any auth/session mention silences it).
    severity: 'medium',
    title: 'Mutating route handler with no authentication check',
    roots: SOURCE_ROOTS,
    exts: SOURCE_EXTS,
    basenamePattern: /^(?:route\.tsx?|\+server\.ts)$/,
    pattern: /^\s*export\s+(?:async\s+)?(?:function|const|let)\s+(?:POST|PUT|PATCH|DELETE)\b/,
    absentPattern: /\bauth\b|auth\s*\(|currentUser|session|clerkClient/i,
    fix: 'Resolve the caller (auth() / getAuth() / the session) at the top of the handler and reject when there is none.',
  },
  {
    id: 'convex_missing_args_validator',
    // Convex validates nothing by itself: a function without `args:` accepts
    // whatever the client sends. File-level veto, mirroring the launch check's
    // convex/lib + _generated exclusions.
    severity: 'medium',
    title: 'Convex function without an args validator',
    roots: Object.freeze(['convex']),
    exts: Object.freeze(['.ts']),
    pattern: /\b(?:internalMutation|internalAction|internalQuery|mutation|action|query)\s*\(\s*\{/,
    absentPattern: /\bargs\s*:/,
    excludePathPattern: /\/lib\/|\/_generated\//,
    fix: 'Declare args with v.* validators for every field the function accepts.',
  },
  {
    id: 'hardcoded_secret_literal',
    // The same prefixes the launch check already trusts, but required to sit
    // inside a quote and to carry a realistic tail — so "re_render" and a bare
    // process.env read never fire.
    severity: 'high',
    title: 'Live-looking secret hardcoded in source',
    roots: SOURCE_ROOTS,
    exts: SOURCE_EXTS,
    pattern:
      /['"`](?:sk_(?:live|test)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}|re_[A-Za-z0-9]{16,}|sntrys_[A-Za-z0-9]{8,}|xai-[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{12,})/,
    fix: 'Move the value to .env.local, read it from process.env on the server, and rotate the exposed key.',
  },
]);

// ── small tolerant helpers ───────────────────────────────────────────────────

function readIf(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    /* unreadable file — nothing to scan here */
    return null;
  }
}

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    /* missing root — the scan simply has less ground to cover */
    return false;
  }
}

/**
 * Repo-relative, forward slashes — a finding reads the same on every OS.
 * `relative` and not a slice: a filesystem root keeps its trailing separator
 * through resolve() ('/' stays '/', 'D:\' stays 'D:\'), and slicing one char
 * too many there mangles every reported path (and every SARIF uri with it).
 */
function relOf(root, file) {
  return relative(root, file).replaceAll('\\', '/');
}

function excerptOf(line) {
  return String(line).trim().slice(0, EXCERPT_MAX);
}

/**
 * The source roots for the default rules. `opts.roots` overrides ONLY those:
 * a rule that declares its own roots (convex) keeps them, so restricting the
 * scan for a test never silently widens a narrowed rule.
 */
function rootsFor(rule, opts) {
  return opts.roots && rule.roots === SOURCE_ROOTS ? opts.roots : rule.roots;
}

// ── file walking ─────────────────────────────────────────────────────────────

/**
 * Bounded, deterministic walk of `roots` under `root`. Returns ABSOLUTE paths
 * sorted by their forward-slash form. Stops at `maxFiles` (the caller treats a
 * full list as truncated) and at `maxDepth` levels below each root.
 */
export function listSourceFiles(
  root,
  { roots = SOURCE_ROOTS, exts = SOURCE_EXTS, maxFiles = DEFAULT_MAX_FILES, maxDepth = DEFAULT_MAX_DEPTH } = {},
) {
  const out = [];
  const walk = (dir, depth) => {
    if (out.length >= maxFiles || depth > maxDepth) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      /* unreadable directory — skip it, never crash the report */
      return;
    }
    // Sorted by name so the traversal (and therefore the file cap) is stable.
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (out.length >= maxFiles) break;
      if (entry.name.startsWith('.') || SKIP_DIRS.includes(entry.name)) continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p, depth + 1);
      else if (entry.isFile() && exts.some((x) => entry.name.endsWith(x))) out.push(p);
    }
  };
  for (const r of roots) {
    const dir = join(resolve(root), r);
    if (isDir(dir)) walk(dir, 0);
  }
  return out.sort((a, b) => {
    const x = a.replaceAll('\\', '/');
    const y = b.replaceAll('\\', '/');
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

// ── matching ─────────────────────────────────────────────────────────────────

/**
 * Every line of `text` matching `rule.pattern`, as [{ line, excerpt }] with
 * 1-indexed lines. `absentPattern` / `basenamePattern` are NOT applied here —
 * they need the file, and runSecurityScan owns that.
 */
export function scanText(text, rule) {
  const out = [];
  if (!rule || !rule.pattern) return out;
  const lines = String(text ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    // Defensive: a rule declared with `g` would otherwise carry lastIndex
    // across lines and files and drop hits at random.
    if (rule.pattern.global || rule.pattern.sticky) rule.pattern.lastIndex = 0;
    if (!rule.pattern.test(lines[i])) continue;
    out.push({ line: i + 1, excerpt: excerptOf(lines[i]) });
  }
  return out;
}

// ── the scan ─────────────────────────────────────────────────────────────────

/**
 * Run the L1 scan against `root`. Reads disk, writes nothing, never throws.
 *
 * opts: { roots } replaces the default source roots · { ruleIds } restricts
 * the run to a subset · { maxFiles } lowers the file cap.
 */
export function runSecurityScan(root = process.cwd(), opts = {}) {
  root = resolve(root);
  const wanted = Array.isArray(opts.ruleIds) ? new Set(opts.ruleIds) : null;
  const rules = wanted ? RULES.filter((r) => wanted.has(r.id)) : [...RULES];
  const maxFiles = Number.isInteger(opts.maxFiles) && opts.maxFiles > 0 ? opts.maxFiles : DEFAULT_MAX_FILES;

  // One walk per distinct roots+exts pair (today: the source rules and the
  // convex rule), so no file is listed twice.
  const groups = new Map();
  for (const rule of rules) {
    const groupRoots = rootsFor(rule, opts);
    const key = `${[...groupRoots].join(',')}|${[...rule.exts].join(',')}`;
    const group = groups.get(key) || { roots: groupRoots, exts: rule.exts, rules: [] };
    group.rules.push(rule);
    groups.set(key, group);
  }

  const findings = [];
  const scanned = new Set();
  let available = false;
  let truncated = false;

  for (const group of groups.values()) {
    const dirs = [...group.roots].filter((r) => isDir(join(root, r)));
    if (!dirs.length) continue;
    available = true;
    const files = listSourceFiles(root, { roots: dirs, exts: group.exts, maxFiles });
    if (files.length >= maxFiles) truncated = true;
    for (const file of files) {
      const text = readIf(file);
      if (text == null) continue;
      const relPath = relOf(root, file);
      scanned.add(relPath);
      for (const rule of group.rules) {
        if (rule.excludePathPattern && rule.excludePathPattern.test(relPath)) continue;
        if (rule.basenamePattern && !rule.basenamePattern.test(basename(file))) continue;
        if (rule.absentPattern && rule.absentPattern.test(text)) continue;
        for (const hit of scanText(text, rule)) {
          findings.push({
            ruleId: rule.id,
            severity: rule.severity,
            title: rule.title,
            file: relPath,
            line: hit.line,
            excerpt: hit.excerpt,
            fix: rule.fix,
          });
        }
      }
    }
  }

  // Severity, then file, then line, then rule id: fully ordered, so two runs
  // over the same tree render byte-identically.
  findings.sort(
    (a, b) =>
      SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      a.line - b.line ||
      (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0),
  );

  const summary = {
    high: findings.filter((f) => f.severity === 'high').length,
    medium: findings.filter((f) => f.severity === 'medium').length,
    low: findings.filter((f) => f.severity === 'low').length,
    total: findings.length,
    filesScanned: scanned.size,
    truncated,
  };
  return {
    available,
    findings,
    summary,
    rules: rules.map((r) => ({
      id: r.id,
      severity: r.severity,
      hits: findings.filter((f) => f.ruleId === r.id).length,
    })),
  };
}

// ── rendering ────────────────────────────────────────────────────────────────

const SEVERITY_LABEL = Object.freeze({ high: 'HIGH', medium: 'MEDIUM', low: 'LOW' });
const PER_RULE_SHOWN = 5;

/** Human report. Pure string building — no disk, no clock. */
export function renderSecurityScan(report) {
  const lines = ['Security scan (L1) — deterministic patterns only; the security skill does the semantic review', ''];
  if (!report.available) {
    lines.push(
      '○ none of the scan roots exist here (app/, components/, src/, lib/, pages/, convex/) — nothing was scanned',
    );
    return lines.join('\n');
  }
  const s = report.summary;
  if (!report.findings.length) {
    lines.push(`✓ no L1 findings across ${s.filesScanned} file(s)`);
  } else {
    for (const severity of SEVERITIES) {
      const bucket = report.findings.filter((f) => f.severity === severity);
      if (!bucket.length) continue;
      lines.push(`${SEVERITY_LABEL[severity]} — ${bucket.length} finding(s)`);
      // Group by rule so the fix is printed once per rule, not per hit.
      for (const ruleId of [...new Set(bucket.map((f) => f.ruleId))]) {
        const hits = bucket.filter((f) => f.ruleId === ruleId);
        lines.push(`  ${ruleId} — ${hits[0].title}`);
        for (const hit of hits.slice(0, PER_RULE_SHOWN)) lines.push(`    ${hit.file}:${hit.line}  ${hit.excerpt}`);
        if (hits.length > PER_RULE_SHOWN) lines.push(`    (+${hits.length - PER_RULE_SHOWN})`);
        lines.push(`    → ${hits[0].fix}`);
      }
      lines.push('');
    }
  }
  lines.push(
    `Result: ${s.high} high · ${s.medium} medium · ${s.low} low · ${s.total} finding(s) · ${s.filesScanned} file(s) scanned`,
  );
  if (s.truncated) {
    lines.push(
      '! FILE CAP REACHED — this scan is INCOMPLETE: part of the project was never read. Re-run with --dir on each subtree to cover it all.',
    );
  }
  return lines.join('\n');
}

/**
 * SARIF 2.1.0 log for CI code-scanning upload. `driver.rules` lists only the
 * rules that produced results (each result points at its rule by index), so
 * the log stays small and every rule in it is one the run can explain.
 */
export function toSarif(report) {
  const findings = report?.findings || [];
  const firedIds = [...new Set(findings.map((f) => f.ruleId))].sort();
  const byId = new Map(RULES.map((r) => [r.id, r]));
  const rules = firedIds.map((id) => {
    const rule = byId.get(id);
    const severity = rule?.severity || findings.find((f) => f.ruleId === id)?.severity || 'medium';
    return {
      id,
      name: id,
      shortDescription: { text: rule?.title || id },
      fullDescription: { text: rule?.fix || rule?.title || id },
      defaultConfiguration: { level: SARIF_LEVEL[severity] || 'warning' },
      properties: { severity },
    };
  });
  return {
    version: '2.1.0',
    $schema: SARIF_SCHEMA,
    runs: [
      {
        tool: {
          driver: {
            name: 'IMPACTUS CLI security L1',
            informationUri: 'https://github.com/elberrd/impactus-cli',
            rules,
          },
        },
        results: findings.map((f) => ({
          ruleId: f.ruleId,
          ruleIndex: firedIds.indexOf(f.ruleId),
          level: SARIF_LEVEL[f.severity] || 'warning',
          message: { text: `${f.title} — ${f.fix}` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.file },
                region: { startLine: f.line },
              },
            },
          ],
        })),
      },
    ],
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function flagValue(argv, flag) {
  const ix = argv.indexOf(flag);
  return ix !== -1 && argv[ix + 1] !== undefined ? argv[ix + 1] : undefined;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const root = resolve(flagValue(argv, '--dir') ?? process.cwd());

  let failOn = null;
  if (argv.includes('--fail-on')) {
    failOn = flagValue(argv, '--fail-on') ?? '';
    if (!SEVERITIES.includes(failOn)) {
      console.error(`Unknown --fail-on severity "${failOn}" — expected one of: ${SEVERITIES.join(', ')}`);
      process.exit(1);
    }
  }

  const report = runSecurityScan(root);
  // --sarif wins over --json and prints NOTHING else: the output is piped
  // straight into a code-scanning upload.
  if (argv.includes('--sarif')) console.log(JSON.stringify(toSarif(report), null, 2));
  else if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else console.log(renderSecurityScan(report));

  if (failOn) {
    const cap = SEVERITIES.indexOf(failOn);
    if (report.findings.some((f) => SEVERITIES.indexOf(f.severity) <= cap)) process.exit(1);
  }
}
