import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = join(REPO, 'harness', '.claude', 'skills', 'design-system');
const PRESET = join(SKILL, 'assets', 'canonical-next-shadcn');
const MANIFEST_PATH = join(PRESET, 'manifest.json');
const INSTALLER_PATH = join(SKILL, 'scripts', 'install-canonical-kit.mjs');
const skip = !existsSync(MANIFEST_PATH) && 'private harness checkout not present';

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

test('canonical UI preset is versioned, complete, and self-verifying', { skip }, () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, 'canonical-next-shadcn');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(manifest.surfaces, ['app_shell', 'breadcrumb', 'theme', 'data_table', 'kanban']);
  assert.equal(manifest.dragAndDrop.package, '@dnd-kit/react');
  assert.equal(manifest.dragAndDrop.api, 'current');
  assert.ok(manifest.files.length >= 12, 'preset should contain a real reusable kit');

  const destinations = new Set();
  for (const file of manifest.files) {
    assert.ok(file.surfaces.length > 0, `${file.source}: missing surfaces`);
    assert.ok(file.surfaces.every((surface) => manifest.surfaces.includes(surface)));
    assert.ok(!destinations.has(file.destination), `duplicate destination ${file.destination}`);
    destinations.add(file.destination);
    const source = join(PRESET, file.source);
    assert.ok(existsSync(source), `missing asset ${file.source}`);
    assert.equal(sha256(source), file.sha256, `${file.source}: stale sha256`);
  }
});

test('canonical assets are independent from live templates and do not mix dnd-kit generations', { skip }, () => {
  const sourceFiles = walk(join(PRESET, 'files'));
  assert.ok(sourceFiles.length > 0);
  const all = sourceFiles.map((path) => readFileSync(path, 'utf8')).join('\n');
  assert.doesNotMatch(all, /(?:^|[/'"])(?:live1|live2)(?:[/'"]|$)/m);
  assert.doesNotMatch(all, /@dnd-kit\/(?:core|sortable|utilities)/);
  assert.match(all, /from ["']@dnd-kit\/react["']/);
  assert.match(all, /DragDropProvider/);
  assert.match(all, /useSortable/);
  assert.match(all, /handleRef/);
  const strictSource = sourceFiles
    .filter((path) => /\.[cm]?[jt]sx?$/.test(path))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
  assert.doesNotMatch(
    strictSource,
    /#[0-9a-f]{3,8}\b/i,
    'component source must use semantic theme tokens, not hex values',
  );
  assert.doesNotMatch(strictSource, /\bany\b/, 'canonical strict source must not introduce explicit any');
});

test('canonical DataTable and Kanban preserve the professional interaction floor', { skip }, () => {
  const table = readFileSync(join(PRESET, 'files', 'components', 'data-table', 'data-table.tsx'), 'utf8');
  const header = readFileSync(
    join(PRESET, 'files', 'components', 'data-table', 'data-table-column-header.tsx'),
    'utf8',
  );
  const kanban = readFileSync(join(PRESET, 'files', 'components', 'kanban', 'kanban.tsx'), 'utf8');
  const messages = readFileSync(join(PRESET, 'files', 'components', 'canonical-ui-messages.ts'), 'utf8');
  const filters = readFileSync(join(PRESET, 'files', 'components', 'data-table', 'filter-functions.ts'), 'utf8');
  const shell = readFileSync(join(PRESET, 'files', 'components', 'layout', 'app-shell.tsx'), 'utf8');
  const themeToggle = readFileSync(join(PRESET, 'files', 'components', 'theme-toggle.tsx'), 'utf8');
  const menu = readFileSync(join(PRESET, 'files', 'components', 'ui', 'menu.tsx'), 'utf8');

  assert.match(table, /advancedControls\s*=\s*false/);
  assert.match(table, /globalFilter/);
  assert.match(table, /columnFilters/);
  assert.match(table, /GroupingState/);
  assert.match(table, /messages\.clearFilters/);
  assert.match(table, /leafRecordCount/);
  assert.match(table, /pinnedColumnStyle/);
  assert.match(table, /manualPagination/);
  assert.match(table, /autoResetPageIndex:\s*false/);
  assert.match(table, /current\.pageIndex === 0\s*\?\s*current/);
  assert.match(table, /\[columnFilters, globalFilter, grouping, sorting\]/);
  assert.match(table, /filteredRows: number/);
  assert.match(table, /server\s*\? server\.filteredRows/);
  assert.match(table, /meta\?\.searchable !== false/);
  assert.match(table, /__canonicalAutoHighlight: definition\.cell === undefined/);
  assert.match(table, /meta\?\.__canonicalAutoHighlight/);
  assert.match(table, /isHighlightablePrimitive\(cellValue\)/);
  assert.doesNotMatch(
    table,
    /cell\.column\.columnDef\.cell\s*\?\s*flexRender\(cell\.column\.columnDef\.cell/,
    'TanStack normalizes a default cell renderer, so its truthiness cannot decide whether search highlighting runs',
  );
  assert.match(table, /maxTableHeight/);
  assert.match(table, /loading \|\| !hydratedView/);
  assert.match(table, /renderBulkActions/);
  assert.match(header, /onContextMenu/);
  assert.match(header, /event\.shiftKey && event\.key === "F10"/);
  assert.match(header, /onRequestFilter/);
  assert.match(header, /clearSorting/);
  assert.match(filters, /facetIncludesSome/);
  assert.match(filters, /Array\.isArray\(cell\)/);
  assert.match(messages, /"pt-BR"/);
  assert.match(messages, /clearFilters: "Clear filters"/);
  assert.match(messages, /moveTo: "Move to…"/);
  assert.match(kanban, /labels\.moveTo/);
  assert.match(kanban, /persistRevision/);
  assert.match(kanban, /getBoundingClientRect/);
  assert.match(kanban, /min-w-\[18rem\]/);
  assert.match(kanban, /overflow-x-auto/);
  assert.match(kanban, /min-h-\[120px\]/);
  assert.match(shell, /shellContent\.inert = true/);
  assert.match(shell, /event\.key === "Tab"/);
  assert.match(shell, /const closeMobileNavigation = React\.useCallback/);
  assert.match(shell, /requestAnimationFrame/);
  assert.match(shell, /cancelAnimationFrame/);
  assert.match(shell, /event\.key === "Escape"[\s\S]{0,180}closeMobileNavigation\(\)/);
  assert.equal((shell.match(/onClick=\{closeMobileNavigation\}/g) ?? []).length, 2);
  assert.doesNotMatch(shell, /setMobileOpen\(false\);\s*triggerRef\.current\?\.focus\(\)/);
  assert.match(themeToggle, /const displayedTheme = mounted \? theme : "system"/);
  assert.match(themeToggle, /choice\.value === displayedTheme/);
  assert.doesNotMatch(themeToggle, /choice\.value === theme/);
  assert.match(menu, /createPortal/);
  assert.match(menu, /ArrowDown/);
  assert.match(menu, /role="separator"/);
  const tokens = readFileSync(join(PRESET, 'files', 'styles', 'canonical-ui.css'), 'utf8');
  assert.match(tokens, /@theme inline/);
  assert.match(tokens, /--color-background: hsl\(var\(--background\)\)/);
});

test('installer plans, applies idempotently, selects surfaces, and fails closed on conflicts', { skip }, async () => {
  const installer = await import(pathToFileURL(INSTALLER_PATH));
  const temp = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'canonical-kit-'));
  try {
    mkdirSync(join(temp, 'src'), { recursive: true });
    writeFileSync(join(temp, 'package.json'), '{"name":"greenfield","private":true}\n');

    const plan = installer.createInstallPlan({ project: temp, adapter: 'canonical-next-shadcn', surfaces: ['theme'] });
    assert.equal(plan.status, 'ready');
    assert.deepEqual(plan.surfaces, ['theme']);
    assert.ok(plan.files.copy.length > 0);
    assert.ok(plan.files.copy.every((item) => item.surfaces.includes('theme')));
    assert.equal(walk(temp).length, 1, 'planning must not write files');

    const installed = installer.installCanonicalKit({
      project: temp,
      adapter: 'canonical-next-shadcn',
      surfaces: ['theme'],
    });
    assert.equal(installed.status, 'installed');
    assert.ok(installed.files.copied.length > 0);

    const again = installer.installCanonicalKit({
      project: temp,
      adapter: 'canonical-next-shadcn',
      surfaces: ['theme'],
    });
    assert.equal(again.status, 'installed');
    assert.equal(again.files.copied.length, 0);
    assert.ok(again.files.identical.length > 0);

    const shellPlan = installer.createInstallPlan({
      project: temp,
      adapter: 'canonical-next-shadcn',
      surfaces: ['app_shell'],
    });
    const conflict = shellPlan.files.copy[0];
    mkdirSync(dirname(conflict.path), { recursive: true });
    writeFileSync(conflict.path, '// project-owned implementation\n');
    const otherMissing = shellPlan.files.copy.find((item) => item.path !== conflict.path);
    assert.ok(otherMissing, 'shell surface should have more than one file');

    assert.throws(
      () => installer.installCanonicalKit({ project: temp, adapter: 'canonical-next-shadcn', surfaces: ['app_shell'] }),
      /conflict/i,
    );
    assert.equal(readFileSync(conflict.path, 'utf8'), '// project-owned implementation\n');
    assert.ok(!existsSync(otherMissing.path), 'preflight conflict must prevent every copy');

    const noOp = installer.createInstallPlan({ project: temp, adapter: 'canonical-next-shadcn', surfaces: [] });
    assert.equal(noOp.status, 'ready');
    assert.deepEqual(noOp.files.copy, []);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test(
  'low-level materializer requires explicit surfaces and refuses to bypass the contract-aware wrapper',
  { skip },
  async () => {
    const { createInstallPlan } = await import(pathToFileURL(INSTALLER_PATH));
    const temp = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'canonical-contract-'));
    try {
      mkdirSync(join(temp, 'src'), { recursive: true });
      const contractPath = join(temp, 'contract.json');
      writeFileSync(
        contractPath,
        JSON.stringify({
          rules: {
            'shell.app_shell': { state: 'required' },
            'navigation.breadcrumb': { state: 'required' },
            'theme.user_switcher': { state: 'not_applicable' },
            'components.data_table': { state: 'required' },
            'components.kanban': { state: 'required' },
          },
          implementation: {
            surfaces: {
              app_shell: { mode: 'canonical' },
              breadcrumb: { mode: 'custom' },
              theme: { mode: 'canonical' },
              data_table: { mode: 'library', package: 'ag-grid-react' },
              kanban: { mode: 'canonical' },
            },
          },
        }),
      );

      assert.throws(
        () => createInstallPlan({ project: temp, adapter: 'canonical-next-shadcn', contract: contractPath }),
        /low-level installer does not resolve UI contracts.*ui-kit\.mjs/,
      );
      const plan = createInstallPlan({
        project: temp,
        adapter: 'canonical-next-shadcn',
        surfaces: ['app_shell', 'kanban'],
      });
      assert.deepEqual(plan.surfaces, ['app_shell', 'kanban']);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
);

test(
  'adapter compatibility is explicit for minimal projects and fail-closed for established foreign stacks',
  { skip },
  async () => {
    const { createInstallPlan } = await import(pathToFileURL(INSTALLER_PATH));
    const minimal = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'canonical-minimal-'));
    const vue = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'canonical-vue-'));
    try {
      writeFileSync(join(minimal, 'package.json'), '{"name":"minimal","private":true}\n');
      assert.throws(
        () => createInstallPlan({ project: minimal, surfaces: ['app_shell'] }),
        /explicit --adapter canonical-next-shadcn/,
      );
      assert.deepEqual(readdirSync(minimal).sort(), ['package.json']);

      writeFileSync(
        join(vue, 'package.json'),
        '{"name":"vue-app","private":true,"dependencies":{"vue":"^3.5.0","vite":"^7.0.0"}}\n',
      );
      assert.throws(
        () => createInstallPlan({ project: vue, adapter: 'canonical-next-shadcn', surfaces: ['app_shell'] }),
        /incompatible with established stack markers: vue/,
      );

      const explicitNoOp = createInstallPlan({ project: vue, surfaces: [] });
      assert.equal(explicitNoOp.status, 'ready');
      assert.deepEqual(explicitNoOp.surfaces, []);
      assert.deepEqual(explicitNoOp.files.copy, []);

      assert.deepEqual(readdirSync(vue).sort(), ['package.json']);
    } finally {
      rmSync(minimal, { recursive: true, force: true });
      rmSync(vue, { recursive: true, force: true });
    }
  },
);

test('localized shared components keep visible fallback copy in the typed catalogs', { skip }, () => {
  const files = walk(join(PRESET, 'files', 'components')).filter((path) => !path.endsWith('canonical-ui-messages.ts'));
  const implementation = files.map((path) => readFileSync(path, 'utf8')).join('\n');
  for (const copy of [
    'Clear filters',
    'Move to…',
    'Open navigation',
    'Choose theme',
    'No records yet.',
    'Restore defaults',
  ]) {
    assert.ok(
      !implementation.includes(`>${copy}<`) && !implementation.includes(`"${copy}"`),
      `${copy} escaped the message catalog`,
    );
  }
  const catalog = readFileSync(join(PRESET, 'files', 'components', 'canonical-ui-messages.ts'), 'utf8');
  assert.match(catalog, /satisfies Record<"en" \| "pt-BR", CanonicalUiMessages>/);
});
