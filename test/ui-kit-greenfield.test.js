import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  CANONICAL_UI_KIT_HARNESS_PATHS,
  canonicalUiKitAvailability,
  mergeHarnessTree,
  requireCanonicalUiKit,
} from '../src/steps/harness.js';
import { FIA } from '../src/config.js';
import { defaultContract as defaultUiContract } from '../fia-templates/scripts/ui-contract.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HARNESS = join(ROOT, 'harness');
const RUNNER = join(HARNESS, '.agents', 'scripts', 'ui-kit.mjs');
const CONTRACT_RUNNER = join(HARNESS, '.agents', 'scripts', 'ui-contract.mjs');
const INSTALLER = join(HARNESS, '.claude', 'skills', 'design-system', 'scripts', 'install-canonical-kit.mjs');
const MANIFEST = join(
  HARNESS,
  '.claude',
  'skills',
  'design-system',
  'assets',
  'canonical-next-shadcn',
  'manifest.json',
);
const skip = !existsSync(join(HARNESS, '.claude')) && 'harness/ nested repo is absent';

function canonicalSelection(reason = 'canonical_fallback') {
  return { mode: 'canonical', preset: 'fia-universal', reason };
}

function activeContract(overrides = {}) {
  const value = defaultUiContract('enterprise-admin');
  value.capabilities.kanban = true;
  value.capabilities.dragAndDrop = true;
  value.rules['components.kanban'] = { status: 'required', reason: 'workflow_stage_based' };
  return { ...value, ...overrides };
}

function writeFoundation(root, name = 'greenfield', { stack = 'next' } = {}) {
  mkdirSync(join(root, 'ai-docs', 'ui'), { recursive: true });
  const dependencies =
    stack === 'next'
      ? { next: '^16.0.0', react: '^19.2.0', 'react-dom': '^19.2.0' }
      : stack === 'vue'
        ? { vue: '^3.5.0', vite: '^7.0.0' }
        : {};
  const devDependencies =
    stack === 'next'
      ? {
          '@types/node': '^22.0.0',
          '@types/react': '^19.0.0',
          '@types/react-dom': '^19.0.0',
          typescript: '^5.9.0',
        }
      : {};
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name, private: true, version: '0.0.0', type: 'module', dependencies, devDependencies }, null, 2)}\n`,
  );
  return root;
}

function project(name = 'greenfield', options = {}) {
  const root = mkdtempSync(join(tmpdir(), `impactus-${name}-`));
  writeFoundation(root, name, options);
  return root;
}

function harnessDistributionFixture(name) {
  const root = mkdtempSync(join(tmpdir(), `impactus-harness-distribution-${name}-`));
  mkdirSync(join(root, '.agents', 'scripts'), { recursive: true });
  mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
  cpSync(RUNNER, join(root, '.agents', 'scripts', 'ui-kit.mjs'));
  cpSync(CONTRACT_RUNNER, join(root, '.agents', 'scripts', 'ui-contract.mjs'));
  cpSync(join(HARNESS, '.claude', 'skills', 'design-system'), join(root, '.claude', 'skills', 'design-system'), {
    recursive: true,
  });
  return root;
}

function writeContract(root, value) {
  writeFileSync(join(root, 'ai-docs', 'ui', 'contract.json'), `${JSON.stringify(value, null, 2)}\n`);
}

function writeRegistry(root, entries) {
  const path = join(root, 'ai-docs', 'components', 'registry.md');
  mkdirSync(dirname(path), { recursive: true });
  const rows = entries.map(
    ({ name, path: entrypoint, origin = 'project' }) =>
      `| ${name} | data | ${origin} | ${entrypoint} | — | — | installed | default | selected surface |`,
  );
  writeFileSync(
    path,
    [
      '# Component registry',
      '',
      '| Component | Category | Origin | File | Install | Docs (URL) | Status | Role | When to use |',
      '|---|---|---|---|---|---|---|---|---|',
      '<!-- registry:start -->',
      ...rows,
      '<!-- registry:end -->',
      '',
    ].join('\n'),
  );
}

function runKit(root, command, extra = []) {
  const localRunner = join(root, '.agents', 'scripts', 'ui-kit.mjs');
  const localInstaller = join(root, '.agents', 'skills', 'design-system', 'scripts', 'install-canonical-kit.mjs');
  const result = spawnSync(
    process.execPath,
    [
      existsSync(localRunner) ? localRunner : RUNNER,
      command,
      '--target',
      root,
      '--installer',
      existsSync(localInstaller) ? localInstaller : INSTALLER,
      '--json',
      ...extra,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  let json = null;
  try {
    json = JSON.parse(result.stdout || result.stderr);
  } catch {
    // The assertion that consumes the result prints both streams on failure.
  }
  return { ...result, json };
}

function installedTypeScriptFiles(root, receipt, manifest) {
  return manifest.files
    .filter((file) => file.surfaces.some((surface) => receipt.surfaces.includes(surface)))
    .map((file) => join(root, receipt.sourceRoot, file.destination))
    .filter((file) => /\.tsx?$/.test(file));
}

function filesUnder(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function compileInstalledKit(root, receipt, manifest) {
  const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  const next = join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
  assert.ok(existsSync(tsc), 'TypeScript compiler dev dependency is required');
  assert.ok(existsSync(next), 'Next compiler dev dependency is required');
  symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
  mkdirSync(join(root, 'app', 'kit-smoke'), { recursive: true });
  writeFileSync(
    join(root, 'app', 'layout.tsx'),
    [
      "import type { ReactNode } from 'react';",
      "import { ThemeProvider } from '@/components/theme-provider';",
      "import './globals.css';",
      '',
      'export default function RootLayout({ children }: { children: ReactNode }) {',
      '  return (',
      '    <html lang="en" suppressHydrationWarning>',
      '      <body><ThemeProvider>{children}</ThemeProvider></body>',
      '    </html>',
      '  );',
      '}',
      '',
    ].join('\n'),
  );
  const canonicalCss =
    receipt.sourceRoot === '.' ? '../styles/canonical-ui.css' : `../${receipt.sourceRoot}/styles/canonical-ui.css`;
  writeFileSync(
    join(root, 'app', 'globals.css'),
    [
      '@import "tailwindcss";',
      `@import "${canonicalCss}";`,
      '',
      'html { color-scheme: light dark; }',
      'body { margin: 0; }',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'app', 'page.tsx'),
    [
      "import Link from 'next/link';",
      '',
      'export default function Home() {',
      '  return <main><Link href="/kit-smoke">Canonical kit smoke</Link></main>;',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'app', 'kit-smoke', 'page.tsx'),
    [
      "'use client';",
      '',
      "import type { ColumnDef } from '@tanstack/react-table';",
      "import { AppShell } from '@/components/layout/app-shell';",
      "import { PageHeader } from '@/components/layout/page-header';",
      "import { Breadcrumb } from '@/components/ui/breadcrumb';",
      "import { ThemeToggle } from '@/components/theme-toggle';",
      "import { DataTable } from '@/components/data-table/data-table';",
      "import { Kanban } from '@/components/kanban/kanban';",
      '',
      'type Row = { id: string; title: string };',
      'const rows: Row[] = [{ id: "task-1", title: "Verify canonical kit" }];',
      'const columns: ColumnDef<Row>[] = [{ accessorKey: "title", header: () => <span data-custom-header>Title</span> }];',
      'type RemoteRow =',
      '  | { kind: "group"; id: string; label: string; leafCount: number; children: RemoteRow[] }',
      '  | { kind: "leaf"; id: string; title: string };',
      'const remoteColumns: ColumnDef<RemoteRow>[] = [{ id: "title", accessorFn: (row) => row.kind === "leaf" ? row.title : row.label, header: "Remote title" }];',
      '',
      'export default function KitSmokePage() {',
      '  return (',
      '    <AppShell sidebar={<nav aria-label="Smoke navigation">Navigation</nav>}>',
      '      <PageHeader',
      '        title="Canonical kit"',
      '        description="A real Next build exercises the public adapters."',
      '        breadcrumb={<Breadcrumb items={[{ label: "Home", href: "/" }, { label: "Kit" }]} />}',
      '        actions={<ThemeToggle />}',
      '      />',
      '      <DataTable tableId="kit-smoke" persistence={{ userId: "smoke-user", tenantId: "smoke-tenant" }} columns={columns} data={rows} getRowId={(row) => row.id} />',
      '      <DataTable',
      '        tableId="kit-server-smoke"',
      '        columns={remoteColumns}',
      '        data={[] as RemoteRow[]}',
      '        getRowId={(row) => row.id}',
      '        server={{',
      '          totalRows: 0, filteredRows: 0, pageCount: 0, onQueryChange: () => {},',
      '          groupingAdapter: {',
      '            getSubRows: (row) => row.kind === "group" ? row.children : undefined,',
      '            isGroupRow: (row) => row.kind === "group",',
      '            getGroupLabel: (row) => row.kind === "group" ? row.label : "",',
      '            getLeafCount: (row) => row.kind === "group" ? row.leafCount : 1,',
      '          },',
      '        }}',
      '      />',
      '      <Kanban',
      '        columns={[',
      '          { id: "todo", title: "To do" },',
      '          { id: "done", title: "Done" },',
      '        ]}',
      '        items={[{ id: "task-1", columnId: "todo", title: "Verify canonical kit" }]}',
      '      />',
      '    </AppShell>',
      '  );',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'next-env.d.ts'),
    '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n',
  );
  writeFileSync(
    join(root, 'next.config.mjs'),
    [
      'const nextConfig = {',
      '  // `npm run typecheck` is the separate strict compiler gate below.',
      '  // Keep Next focused on bundling, RSC/client boundaries and routes.',
      '  typescript: { ignoreBuildErrors: true },',
      '};',
      '',
      'export default nextConfig;',
      '',
    ].join('\n'),
  );
  writeFileSync(join(root, 'postcss.config.mjs'), 'export default { plugins: { "@tailwindcss/postcss": {} } };\n');
  writeFileSync(
    join(root, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          module: 'ESNext',
          moduleResolution: 'Bundler',
          jsx: 'react-jsx',
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          skipLibCheck: true,
          baseUrl: receipt.sourceRoot,
          paths: { '@/*': ['./*'] },
          rootDir: receipt.sourceRoot,
          noEmit: true,
          plugins: [{ name: 'next' }],
        },
        include: [
          `${receipt.sourceRoot === '.' ? '' : `${receipt.sourceRoot}/`}**/*.ts`,
          `${receipt.sourceRoot === '.' ? '' : `${receipt.sourceRoot}/`}**/*.tsx`,
        ],
        exclude: ['node_modules', '.next'],
      },
      null,
      2,
    )}\n`,
  );
  const pkgPath = join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.scripts = {
    ...(pkg.scripts ?? {}),
    typecheck: `${JSON.stringify(process.execPath)} ${JSON.stringify(tsc)} --noEmit -p tsconfig.json`,
    // Webpack is intentional for this hermetic fixture: Turbopack rejects the
    // out-of-tree node_modules symlink even though Node/Next resolve it safely.
    // This remains a real optimized `next build`, independent from typecheck.
    build: `${JSON.stringify(process.execPath)} ${JSON.stringify(next)} build --webpack`,
  };
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  const typecheck = spawnSync('npm', ['run', 'typecheck'], { cwd: root, encoding: 'utf8' });
  assert.equal(typecheck.status, 0, `${typecheck.stdout}\n${typecheck.stderr}`);
  const build = spawnSync('npm', ['run', 'build'], { cwd: root, encoding: 'utf8' });
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);

  const bundledCss = filesUnder(join(root, '.next', 'static', 'css'))
    .filter((path) => path.endsWith('.css'))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
  assert.match(bundledCss, /--search-highlight/, 'canonical tokens were not emitted into the Next build');
  assert.match(bundledCss, /\.text-muted-foreground/, 'Tailwind did not compile a semantic canonical utility');

  const smokeHtml = readFileSync(join(root, '.next', 'server', 'app', 'kit-smoke.html'), 'utf8');
  assert.match(smokeHtml, />To do<\//, 'Kanban source column did not render in the production artifact');
  assert.match(smokeHtml, />Done<\//, 'Kanban empty target column did not render in the production artifact');
  assert.match(smokeHtml, /aria-label="0 items"/, 'Kanban target column was not verifiably empty');
  assert.match(smokeHtml, />Verify canonical kit<\//, 'Kanban card did not render in the production artifact');
  assert.match(smokeHtml, /data-custom-header/, 'custom DataTable header content did not render');

  const sources = installedTypeScriptFiles(root, receipt, manifest);
  assert.ok(sources.length >= 5, 'the compiler must cover every installed TS/TSX asset');
  assert.ok(existsSync(join(root, '.next', 'BUILD_ID')), 'Next did not produce a production build receipt');

  // Negative control: prove this is a semantic typecheck, not a regex/parser
  // smoke. The same npm script must reject an invalid installed-source type.
  const negative = join(root, receipt.sourceRoot, 'canonical-kit-negative-control.ts');
  writeFileSync(negative, 'export const mustBeText: string = 42;\n');
  const rejected = spawnSync('npm', ['run', 'typecheck'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(rejected.status, 0, 'the compiler harness failed open on a real type error');
  assert.match(`${rejected.stdout}\n${rejected.stderr}`, /Type 'number' is not assignable to type 'string'|TS2322/);
  rmSync(negative);

  const compilerReceipt = {
    schemaVersion: 1,
    compiler: 'typescript',
    typecheck: 'PASS',
    build: 'PASS',
    negativeControl: 'PASS',
    sources: sources.map((file) => file.slice(root.length + 1)),
    route: '/kit-smoke',
    css: 'PASS',
    nextBuildId: readFileSync(join(root, '.next', 'BUILD_ID'), 'utf8').trim(),
  };
  writeFileSync(
    join(root, 'ai-docs', 'ui', 'kit-compiler-receipt.json'),
    `${JSON.stringify(compilerReceipt, null, 2)}\n`,
  );
  return compilerReceipt;
}

test('universal UI-kit runner resolves canonical defaults and explicit per-surface choices', { skip }, async () => {
  const { resolveCanonicalKitSelection } = await import(`${RUNNER}?selection-test=${Date.now()}`);
  const all = resolveCanonicalKitSelection(activeContract());
  assert.deepEqual(all.surfaces, ['app_shell', 'breadcrumb', 'theme', 'data_table', 'kanban']);

  const contract = activeContract();
  contract.implementation.surfaces = {
    data_table: {
      mode: 'specified-library',
      package: 'ag-grid-enterprise',
      path: 'src/features/records/ag-grid.tsx',
      reason: 'user_explicit_specified_library',
    },
    kanban: {
      mode: 'custom',
      path: 'src/features/board/custom-board.tsx',
      reason: 'user_explicit_custom',
    },
  };
  const selected = resolveCanonicalKitSelection(contract);
  assert.deepEqual(selected.surfaces, ['app_shell', 'breadcrumb', 'theme']);
  assert.deepEqual(
    selected.skipped.map(({ surface, mode }) => [surface, mode]),
    [
      ['data_table', 'specified-library'],
      ['kanban', 'custom'],
    ],
  );
  assert.equal(selected.skipped[0].package, 'ag-grid-enterprise');
  assert.equal(selected.skipped[0].path, 'src/features/records/ag-grid.tsx');
  assert.equal(selected.skipped[1].path, 'src/features/board/custom-board.tsx');
});

test(
  'kit resolution rejects legacy/unvalidated contracts and malformed or spoofed implementation choices',
  { skip },
  async () => {
    const { dependencyRangesCompatible, resolveCanonicalKitSelection } = await import(
      `${RUNNER}?invalid-test=${Date.now()}`
    );
    assert.equal(dependencyRangesCompatible('^0.5.0', '^0.5.0'), true);
    assert.equal(dependencyRangesCompatible('^0.1.0', '^0.5.0'), false, '0.x caret ranges are minor-scoped');
    assert.equal(dependencyRangesCompatible('^19.2.0', '^18.3 || ^19'), true);
    assert.equal(dependencyRangesCompatible('^16.0.0', '>=15 <17'), true);
    const v1 = activeContract();
    v1.schemaVersion = 1;
    delete v1.implementation;
    assert.throws(() => resolveCanonicalKitSelection(v1), /migrate/i);

    for (const mutate of [
      (value) => {
        value.implementation.surfaces.data_table = {
          mode: 'specified-library',
          reason: 'user_explicit_specified_library',
        };
      },
      (value) => {
        value.implementation.default = {
          mode: 'canonical',
          preset: '../../evil',
          reason: 'canonical_fallback',
        };
      },
      (value) => {
        value.implementation.surfaces.unknown_surface = canonicalSelection();
      },
    ]) {
      const value = activeContract();
      mutate(value);
      assert.throws(() => resolveCanonicalKitSelection(value), /invalid/i);
    }
  },
);

test('the harness distribution seam verifies every executable asset before a greenfield merge', { skip }, async () => {
  assert.deepEqual(canonicalUiKitAvailability(HARNESS), { ok: true, missing: [], issues: [] });

  const absent = harnessDistributionFixture('absent');
  rmSync(join(absent, '.agents', 'scripts', 'ui-contract.mjs'));
  let result = canonicalUiKitAvailability(absent);
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues[0], {
    code: 'distribution_file_missing',
    path: '.agents/scripts/ui-contract.mjs',
  });

  const missingAsset = harnessDistributionFixture('missing-asset');
  const missingManifest = JSON.parse(readFileSync(join(missingAsset, CANONICAL_UI_KIT_HARNESS_PATHS.at(-1)), 'utf8'));
  const missingSource = join(
    missingAsset,
    '.claude',
    'skills',
    'design-system',
    'assets',
    'canonical-next-shadcn',
    missingManifest.files[0].source,
  );
  rmSync(missingSource);
  result = canonicalUiKitAvailability(missingAsset);
  assert.ok(
    result.issues.some(
      ({ code, path }) => code === 'canonical_asset_missing' && path.endsWith(missingManifest.files[0].source),
    ),
  );

  const staleAsset = harnessDistributionFixture('stale-asset');
  const staleManifest = JSON.parse(readFileSync(join(staleAsset, CANONICAL_UI_KIT_HARNESS_PATHS.at(-1)), 'utf8'));
  const staleSource = join(
    staleAsset,
    '.claude',
    'skills',
    'design-system',
    'assets',
    'canonical-next-shadcn',
    staleManifest.files[0].source,
  );
  writeFileSync(staleSource, '// drifted after release\n');
  result = canonicalUiKitAvailability(staleAsset);
  assert.ok(
    result.issues.some(
      ({ code, path }) => code === 'canonical_asset_checksum_stale' && path.endsWith(staleManifest.files[0].source),
    ),
  );

  const untouchedTarget = mkdtempSync(join(tmpdir(), 'impactus-unmerged-greenfield-'));
  assert.throws(() => requireCanonicalUiKit(staleAsset), /canonical_asset_checksum_stale.*Nothing was merged/i);
  await assert.rejects(
    () => mergeHarnessTree(staleAsset, untouchedTarget, { requireCanonical: true }),
    /canonical_asset_checksum_stale.*Nothing was merged/i,
  );
  assert.deepEqual(
    readdirSync(untouchedTarget),
    [],
    'greenfield destination changed before distribution preflight passed',
  );
});

test(
  'an empty greenfield receives the local harness, then materializes, builds and verifies without live templates',
  { skip },
  async () => {
    assert.ok(existsSync(RUNNER), 'harness must distribute the FIA-independent universal runner');
    assert.ok(existsSync(INSTALLER), 'design-system skill must distribute the canonical installer');
    assert.ok(existsSync(MANIFEST), 'design-system skill must distribute the versioned manifest');

    const root = mkdtempSync(join(tmpdir(), 'impactus-greenfield-empty-'));
    assert.deepEqual(readdirSync(root), [], 'fixture must begin as a genuinely empty web folder');
    await mergeHarnessTree(HARNESS, root);
    assert.deepEqual(canonicalUiKitAvailability(root), { ok: true, missing: [], issues: [] });
    for (const path of CANONICAL_UI_KIT_HARNESS_PATHS) {
      assert.ok(existsSync(join(root, path)), `local harness merge lost ${path}`);
    }
    const runtimeInstaller = realpathSync(
      join(root, '.agents', 'skills', 'design-system', 'scripts', 'install-canonical-kit.mjs'),
    ).replaceAll('\\', '/');
    assert.match(
      runtimeInstaller,
      /\/\.cursor\/skills\/design-system\/scripts\/install-canonical-kit\.mjs$/,
      'the E2E did not exercise the .agents → Cursor runtime skill tree',
    );
    assert.equal(existsSync(join(root, 'live1')), false);
    assert.equal(existsSync(join(root, 'live2')), false);

    // Foundation is intentionally a separate phase: the kit never invents a
    // framework in an empty folder, but becomes deterministic as soon as the
    // selected Next + React stack is observable.
    writeFoundation(root, 'greenfield-canonical');
    writeContract(root, activeContract());

    const first = runKit(root, 'install');
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.equal(first.json?.status, 'installed');
    assert.deepEqual(first.json?.surfaces, ['app_shell', 'breadcrumb', 'theme', 'data_table', 'kanban']);

    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    const selectedFiles = manifest.files.filter((file) =>
      file.surfaces.some((surface) => first.json.surfaces.includes(surface)),
    );
    assert.ok(selectedFiles.length >= 5, 'the executable kit must contain composed components, not only prose');
    for (const file of selectedFiles) {
      assert.ok(existsSync(join(root, first.json.sourceRoot, file.destination)), file.destination);
    }

    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    for (const [name, range] of Object.entries(first.json.dependencies ?? {})) {
      const current = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
      const preserved = first.json.packageJson?.preserved?.some(
        (entry) => entry.name === name && entry.current === current && entry.required === range,
      );
      assert.ok(current === range || preserved, `package.json lost or incompatibly changed ${name}`);
    }
    assert.ok(existsSync(join(root, 'ai-docs', 'ui', 'kit-receipt.json')));

    const second = runKit(root, 'install');
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.equal(second.json?.status, 'installed');
    assert.equal(second.json?.files?.copy?.length, 0, 'second install must not rewrite source files');
    assert.equal(second.json?.files?.conflict?.length, 0);

    const verified = runKit(root, 'verify');
    assert.equal(verified.status, 0, verified.stderr || verified.stdout);
    assert.equal(verified.json?.status, 'verified');

    const compiler = compileInstalledKit(root, verified.json, manifest);
    assert.equal(compiler.sources.length, selectedFiles.filter((file) => /\.tsx?$/.test(file.destination)).length);
    assert.ok(existsSync(join(root, 'ai-docs', 'ui', 'kit-compiler-receipt.json')));
  },
);

test('library/custom selections do not materialize or add dependencies for those surfaces', { skip }, () => {
  const root = project('greenfield-alternate');
  const contract = activeContract();
  contract.implementation.surfaces.data_table = {
    mode: 'existing-library',
    package: '@acme/project-grid',
    path: 'src/custom/data-table.tsx',
    reason: 'user_explicit_existing_library',
  };
  contract.implementation.surfaces.kanban = {
    mode: 'custom',
    path: 'src/custom/kanban.tsx',
    reason: 'user_explicit_custom',
  };
  writeContract(root, contract);

  const result = runKit(root, 'install');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(result.json?.surfaces, ['app_shell', 'breadcrumb', 'theme']);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies?.['@tanstack/react-table'], undefined);
  assert.equal(pkg.dependencies?.['@dnd-kit/react'], undefined);

  const receipt = JSON.parse(readFileSync(join(root, 'ai-docs', 'ui', 'kit-receipt.json'), 'utf8'));
  assert.deepEqual(
    receipt.skipped.map(({ surface, mode }) => [surface, mode]),
    [
      ['data_table', 'existing-library'],
      ['kanban', 'custom'],
    ],
  );
  assert.ok(receipt.alternateVerification.every(({ status }) => status === 'pending'));

  const beforeMaterialization = runKit(root, 'verify');
  assert.notEqual(beforeMaterialization.status, 0);
  assert.match(beforeMaterialization.stderr, /not materialized|alternate_(?:entrypoint|package|registry)/i);

  pkg.dependencies['@acme/project-grid'] = '^1.0.0';
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  mkdirSync(join(root, 'src', 'custom'), { recursive: true });
  writeFileSync(join(root, 'src', 'custom', 'data-table.tsx'), 'export function ProjectGrid() { return null; }\n');
  writeFileSync(join(root, 'src', 'custom', 'kanban.tsx'), 'export function CustomKanban() { return null; }\n');
  const withoutRegistry = runKit(root, 'verify');
  assert.notEqual(withoutRegistry.status, 0, 'source files and package alone must not satisfy the alternate proof');
  assert.match(withoutRegistry.stderr, /alternate_registry/i);

  writeRegistry(root, [
    { name: 'ProjectGrid', path: 'src/custom/data-table.tsx', origin: '@acme/project-grid' },
    { name: 'CustomKanban', path: 'src/custom/kanban.tsx' },
  ]);
  const afterMaterialization = runKit(root, 'verify');
  assert.equal(afterMaterialization.status, 0, afterMaterialization.stderr || afterMaterialization.stdout);
  assert.equal(
    afterMaterialization.json.verificationStatus,
    'verified',
    JSON.stringify(afterMaterialization.json, null, 2),
  );
  assert.ok(afterMaterialization.json.alternateVerification.every(({ status }) => status === 'verified'));
  assert.ok(
    afterMaterialization.json.alternateVerification.every(
      ({ entrypoint, registry }) => /^[a-f0-9]{64}$/.test(entrypoint.sha256) && /^[a-f0-9]{64}$/.test(registry.rowSha256),
    ),
  );
  const libraryProof = afterMaterialization.json.alternateVerification.find(
    ({ surface }) => surface === 'data_table',
  );
  assert.deepEqual(libraryProof.dependency, { name: '@acme/project-grid', range: '^1.0.0' });
  const verifiedReceipt = JSON.parse(readFileSync(join(root, 'ai-docs', 'ui', 'kit-receipt.json'), 'utf8'));
  assert.equal(verifiedReceipt.schemaVersion, 2);
  assert.equal(verifiedReceipt.verificationStatus, 'verified');
});

test('a Vue project works when every applicable surface has an explicit local alternate', { skip }, () => {
  const root = project('greenfield-vue-alternate', { stack: 'vue' });
  mkdirSync(join(root, 'ai-docs'), { recursive: true });
  writeFileSync(join(root, 'ai-docs', 'stack.md'), '# Stack\n\n| Frontend | Vue 3 + Vite |\n');
  const contract = activeContract();
  const entries = [];
  for (const surface of ['app_shell', 'breadcrumb', 'theme', 'data_table', 'kanban']) {
    const path = `src/ui/${surface}.ts`;
    contract.implementation.surfaces[surface] = { mode: 'custom', path, reason: 'user_explicit_custom' };
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), `export const ${surface.replaceAll('_', '')} = true;\n`);
    entries.push({ name: surface, path });
  }
  writeRegistry(root, entries);
  writeContract(root, contract);

  const installed = runKit(root, 'install');
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.deepEqual(installed.json.surfaces, []);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies.next, undefined);
  assert.equal(pkg.dependencies.react, undefined);
  assert.equal(pkg.dependencies['@tanstack/react-table'], undefined);

  const verified = runKit(root, 'verify');
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  assert.equal(verified.json.verificationStatus, 'verified');
  assert.equal(verified.json.alternateVerification.length, 5);
});

test('the Next canonical adapter refuses an incompatible web stack before writing anything', { skip }, () => {
  const root = project('greenfield-vue', { stack: 'vue' });
  writeContract(root, activeContract());
  const packageBefore = readFileSync(join(root, 'package.json'), 'utf8');
  const result = runKit(root, 'install');
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Next\.js \+ React adapter|compatible library\/custom|incompatible with established stack/i,
  );
  assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), packageBefore);
  assert.equal(existsSync(join(root, 'ai-docs', 'ui', 'kit-receipt.json')), false);
});

test('a source or dependency conflict fails closed before any canonical file or package edit', { skip }, () => {
  const root = project('greenfield-conflict');
  writeContract(root, activeContract());
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const conflict = manifest.files.find((file) => file.surfaces.includes('data_table')) ?? manifest.files[0];
  const destination = join(root, 'src', conflict.destination);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, '// belongs to the project\n');
  const packageBefore = readFileSync(join(root, 'package.json'), 'utf8');

  const result = runKit(root, 'install', ['--source-root', 'src']);
  assert.notEqual(result.status, 0, 'conflicts must never be treated as a successful partial install');
  assert.match(result.stderr, /conflict/i);
  assert.equal(readFileSync(destination, 'utf8'), '// belongs to the project\n');
  assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), packageBefore);

  for (const file of manifest.files) {
    const path = join(root, 'src', file.destination);
    if (path !== destination) assert.equal(existsSync(path), false, `partial write: ${file.destination}`);
  }
});

test('verification fails closed when an installed canonical file disappears', { skip }, () => {
  const root = project('greenfield-verify-missing');
  writeContract(root, activeContract());
  const installed = runKit(root, 'install');
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  const before = JSON.parse(readFileSync(join(root, 'ai-docs', 'ui', 'kit-receipt.json'), 'utf8'));
  assert.equal(before.verificationStatus, 'pending');

  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const selected = manifest.files.find((file) => file.surfaces.includes('app_shell'));
  const missing = join(root, installed.json.sourceRoot, selected.destination);
  rmSync(missing);
  const verified = runKit(root, 'verify');
  assert.notEqual(verified.status, 0);
  assert.match(verified.stderr, /verification failed|missing|stale/i);

  const after = JSON.parse(readFileSync(join(root, 'ai-docs', 'ui', 'kit-receipt.json'), 'utf8'));
  assert.equal(after.verificationStatus, 'pending', 'failed verification must not mint a verified receipt');
});

test(
  'FIA wrapper delegates to the harness runner, while commands can use the runner when FIA is absent',
  { skip },
  () => {
    assert.equal(FIA.npmScripts['ui:kit'], 'node .agents/scripts/ui-kit.mjs');
    const root = project('greenfield-no-fia');
    mkdirSync(join(root, '.agents', 'scripts'), { recursive: true });
    mkdirSync(join(root, '.agents', 'skills'), { recursive: true });
    cpSync(RUNNER, join(root, '.agents', 'scripts', 'ui-kit.mjs'));
    cpSync(CONTRACT_RUNNER, join(root, '.agents', 'scripts', 'ui-contract.mjs'));
    cpSync(join(HARNESS, '.claude', 'skills', 'design-system'), join(root, '.agents', 'skills', 'design-system'), {
      recursive: true,
    });
    writeContract(root, activeContract());

    const withoutFia = spawnSync(
      process.execPath,
      [join(root, '.agents', 'scripts', 'ui-kit.mjs'), 'plan', '--target', root, '--json'],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(withoutFia.status, 0, withoutFia.stderr || withoutFia.stdout);
    assert.equal(JSON.parse(withoutFia.stdout).status, 'ready');

    mkdirSync(join(root, 'imp', 'scripts'), { recursive: true });
    cpSync(join(ROOT, 'fia-templates', 'scripts', 'ui-kit.mjs'), join(root, 'imp', 'scripts', 'ui-kit.mjs'));
    const viaFia = spawnSync(
      process.execPath,
      [join(root, 'imp', 'scripts', 'ui-kit.mjs'), 'plan', '--target', root, '--json'],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(viaFia.status, 0, viaFia.stderr || viaFia.stdout);
    assert.equal(JSON.parse(viaFia.stdout).status, 'ready');
  },
);

test('UI contract init, check and explicit v1 migration execute without an imp/FIA directory', { skip }, async () => {
  assert.ok(existsSync(CONTRACT_RUNNER), 'UI contract validator must belong to the universal harness');
  assert.equal(
    readFileSync(CONTRACT_RUNNER, 'utf8'),
    readFileSync(join(ROOT, 'fia-templates', 'scripts', 'ui-contract.mjs'), 'utf8'),
    'the optional FIA runtime mirror must not drift from the universal validator',
  );
  const root = project('contract-no-fia');
  const invoke = (...args) =>
    spawnSync(process.execPath, [CONTRACT_RUNNER, ...args, '--dir', root, '--json'], {
      cwd: root,
      encoding: 'utf8',
    });

  let result = invoke('init', '--profile', 'enterprise-admin');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  result = invoke('check');
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const { defaultContract } = await import(`${CONTRACT_RUNNER}?migration-fixture=${Date.now()}`);
  const legacy = defaultContract('enterprise-admin');
  legacy.schemaVersion = 1;
  delete legacy.implementation;
  writeContract(root, legacy);
  result = invoke('check');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /migrate/i);
  result = invoke('migrate');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  result = invoke('check');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(existsSync(join(root, 'imp')), false, 'no optional FIA path was needed');
});

test(
  'greenfield planning invokes the executable kit and never treats the optional examples shelf as authority',
  { skip },
  () => {
    const paths = [
      join(HARNESS, '.claude', 'commands', 'start.md'),
      join(HARNESS, '.claude', 'agents', 'task-master-generator.md'),
      join(HARNESS, '.claude', 'agents', 'task-sequencer.md'),
      join(HARNESS, '.cursor', 'skills', 'workflow-start', 'SKILL.md'),
    ];
    for (const path of paths) {
      const text = readFileSync(path, 'utf8');
      assert.match(text, /\.agents\/scripts\/ui-kit\.mjs/);
      assert.match(text, /kit-receipt\.json/);
      assert.match(text, /examples[\s\S]{0,160}(?:optional|shelf|never|not)/i);
    }
  },
);

test('UI kit plan honors a Next.js stack declared only in ai-docs/stack.md (pre-foundation greenfield)', { skip }, () => {
  // Bare package.json: no next/react yet — the foundation scaffold has not
  // run. The wrapper's stack gate reads ai-docs/stack.md and endorses the
  // canonical adapter itself; the kit then supplies next/react via added deps.
  const root = mkdtempSync(join(tmpdir(), 'impactus-stackmd-'));
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'stackmd', private: true, version: '0.0.0', type: 'module' }, null, 2)}\n`,
  );
  mkdirSync(join(root, 'ai-docs', 'ui'), { recursive: true });
  writeFileSync(join(root, 'ai-docs', 'stack.md'), '# Stack\n\n| Frontend | Next.js 16 (App Router) |\n');
  writeContract(root, activeContract());
  const plan = runKit(root, 'plan');
  assert.equal(plan.status, 0, plan.stderr || plan.stdout);
  assert.equal(plan.json.status, 'ready');
  const added = plan.json.packageJson.added.map((dependency) => dependency.name);
  assert.ok(added.includes('next'), 'the kit plan brings next into package.json');
});

test('UI kit receipt is portable — no machine-absolute path survives in the committed artifact', { skip }, () => {
  const root = project('portable-receipt');
  writeContract(root, activeContract());
  const install = runKit(root, 'install');
  assert.equal(install.status, 0, install.stderr || install.stdout);
  const receipt = JSON.parse(readFileSync(join(root, 'ai-docs', 'ui', 'kit-receipt.json'), 'utf8'));
  assert.equal(receipt.project, undefined, 'the absolute project path is dropped');
  const serialized = JSON.stringify(receipt);
  assert.ok(!serialized.includes(root), 'no field embeds the machine-absolute project path');
  assert.ok(!serialized.includes(realpathSync(root)), 'no field embeds the resolved project path either');
  for (const list of Object.values(receipt.files ?? {})) {
    for (const file of list) {
      assert.equal(file.sourcePath, undefined, 'installer source paths are stripped');
    }
  }
});
