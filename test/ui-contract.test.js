import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CANONICAL_UI_PRESET,
  UI_PROFILES,
  UI_RULES,
  defaultContract,
  evaluateUiRule,
  invariants,
  loadUiContract,
  migrateUiContract,
  resolveUiRuleApplicability,
  resolveUiImplementation,
  saveUiContract,
  selectUiImplementations,
  updateUiCapability,
  validateUiContract,
} from '../fia-templates/scripts/ui-contract.mjs';

const SCRIPT = join(import.meta.dirname, '..', 'fia-templates', 'scripts', 'ui-contract.mjs');
const HARNESS_SCRIPT = join(import.meta.dirname, '..', 'harness', '.agents', 'scripts', 'ui-contract.mjs');

function temporaryProject() {
  return mkdtempSync(join(tmpdir(), 'ui-contract-'));
}

function replaceRule(contract, ruleId, value) {
  return {
    ...contract,
    rules: {
      ...contract.rules,
      [ruleId]: value,
    },
  };
}

test('profile defaults are deterministic and keep quality invariants required', () => {
  assert.deepEqual(UI_PROFILES, [
    'enterprise-admin',
    'operational-saas',
    'content',
    'marketing',
    'immersive-game',
    'custom',
  ]);

  const first = defaultContract('enterprise-admin');
  const second = defaultContract('enterprise-admin');
  assert.deepEqual(first, second);
  assert.equal(first.rules['theme.user_switcher'].status, 'required');
  assert.equal(first.rules['shell.app_shell'].status, 'required');
  assert.equal(first.rules['components.data_table'].status, 'required');
  assert.equal(first.capabilities.advancedDataTableControls, true);

  for (const profile of UI_PROFILES) {
    assert.equal(validateUiContract(defaultContract(profile)).outcome, 'PASS', `${profile} default invalid`);
  }

  const saas = defaultContract('operational-saas');
  assert.equal(saas.capabilities.dataTables, false);
  assert.equal(saas.capabilities.advancedDataTableControls, false);
  const content = defaultContract('content');
  assert.equal(content.capabilities.appShell, false);
  assert.equal(content.capabilities.userThemePreference, false);

  for (const ruleId of invariants) {
    assert.equal(UI_RULES[ruleId].waivable, false);
    assert.notEqual(first.rules[ruleId].status, 'waived');
  }

  const game = defaultContract('immersive-game');
  assert.deepEqual(game.rules['navigation.breadcrumb'], {
    status: 'not_applicable',
    reason: 'immersive_single_surface',
  });
  assert.equal(game.rules['theme.user_switcher'].status, 'not_applicable');
  assert.equal(game.rules['shell.app_shell'].status, 'not_applicable');
  assert.equal(validateUiContract(game).outcome, 'PASS');
});

test('no detailed implementation choice resolves every surface to the universal canonical fallback', () => {
  const contract = defaultContract('operational-saas');

  assert.deepEqual(contract.implementation, {
    default: {
      mode: 'canonical',
      preset: CANONICAL_UI_PRESET,
      reason: 'canonical_fallback',
    },
    surfaces: {},
  });
  assert.deepEqual(resolveUiImplementation(contract, 'data_table'), {
    surface: 'data_table',
    mode: 'canonical',
    preset: CANONICAL_UI_PRESET,
    reason: 'canonical_fallback',
    isCanonical: true,
  });
  assert.deepEqual(selectUiImplementations(), contract.implementation);
});

test('an explicit existing or specified library is concrete per surface and keeps quality rules', () => {
  for (const choice of [
    { mode: 'existing-library', package: '@acme/ui', path: 'components/acme/app-shell.tsx' },
    { mode: 'specified-library', package: '@mui/material', path: 'components/mui/app-shell.tsx' },
  ]) {
    const contract = defaultContract('enterprise-admin', {
      implementation: { surfaces: { app_shell: choice } },
    });
    const resolved = resolveUiImplementation(contract, 'app_shell');

    assert.deepEqual(resolved, {
      surface: 'app_shell',
      ...choice,
      reason: choice.mode === 'existing-library' ? 'user_explicit_existing_library' : 'user_explicit_specified_library',
      isCanonical: false,
    });
    assert.equal(contract.rules['quality.keyboard_access'].status, 'required');
    assert.equal(contract.rules['quality.overflow_containment'].status, 'required');
    assert.equal(validateUiContract(contract).outcome, 'PASS');
  }
});

test('a non-canonical global default is rejected so untouched surfaces keep the canonical fallback', () => {
  assert.throws(
    () =>
      selectUiImplementations({
        default: {
          mode: 'specified-library',
          package: '@mui/material',
          path: 'components/mui/ui.tsx',
        },
      }),
    /per-surface/i,
  );

  const invalid = defaultContract('enterprise-admin');
  invalid.implementation.default = {
    mode: 'specified-library',
    package: '@mui/material',
    path: 'components/mui/ui.tsx',
    reason: 'user_explicit_specified_library',
  };
  assert.ok(validateUiContract(invalid).errors.some((error) => error.code === 'implementation_default_invalid'));
});

test('an explicit per-surface custom component wins while untouched surfaces retain the canonical default', () => {
  const contract = defaultContract('enterprise-admin', {
    implementation: {
      surfaces: {
        data_table: { mode: 'custom', path: 'components/acme/records-grid.tsx' },
      },
    },
  });

  assert.deepEqual(resolveUiImplementation(contract, 'data_table'), {
    surface: 'data_table',
    mode: 'custom',
    path: 'components/acme/records-grid.tsx',
    reason: 'user_explicit_custom',
    isCanonical: false,
  });
  assert.deepEqual(resolveUiImplementation(contract, 'theme'), {
    surface: 'theme',
    mode: 'canonical',
    preset: CANONICAL_UI_PRESET,
    reason: 'canonical_fallback',
    isCanonical: true,
  });
});

test('schema v1 migrates explicitly to the canonical fallback and malformed legacy contracts remain rejected', () => {
  const legacy = defaultContract('content');
  legacy.schemaVersion = 1;
  delete legacy.implementation;

  const migrated = migrateUiContract(legacy);
  assert.equal(migrated.schemaVersion, 3);
  assert.deepEqual(migrated.implementation, selectUiImplementations());
  assert.deepEqual(migrated.rules, legacy.rules);
  assert.deepEqual(migrated.capabilities, legacy.capabilities);
  assert.equal(validateUiContract(migrated).outcome, 'PASS');

  assert.throws(() => migrateUiContract({ ...legacy, invented: true }), /invalid/i);
});

test('implementation records fail closed on spoofed reasons, missing entrypoints, and unknown surfaces', () => {
  const spoofed = defaultContract('custom');
  spoofed.implementation.surfaces.data_table = {
    mode: 'specified-library',
    package: '@mui/material',
    path: 'components/mui/data-table.tsx',
    reason: 'canonical_fallback',
  };
  assert.ok(validateUiContract(spoofed).errors.some((error) => error.code === 'implementation_surface_invalid'));

  const missingTarget = defaultContract('custom');
  missingTarget.implementation.surfaces.data_table = {
    mode: 'specified-library',
    package: '@mui/material',
    reason: 'user_explicit_specified_library',
  };
  assert.ok(validateUiContract(missingTarget).errors.some((error) => error.code === 'implementation_surface_invalid'));

  const unknownSurface = defaultContract('custom');
  unknownSurface.implementation.surfaces.dashboard = {
    mode: 'canonical',
    preset: CANONICAL_UI_PRESET,
    reason: 'user_explicit_canonical',
  };
  assert.ok(validateUiContract(unknownSurface).errors.some((error) => error.code === 'implementation_surface_unknown'));
});

test('DataTable applicability describes universal behavior without forcing the canonical implementation API', () => {
  const base = UI_RULES['components.data_table'].description;
  const advanced = UI_RULES['data_table.advanced_controls'].description;

  assert.match(base, /global search/i);
  assert.match(base, /one Filter control/i);
  assert.match(base, /header menu/i);
  assert.match(base, /chips/i);
  assert.doesNotMatch(base, /group|pin|reorder|persist|Restore|sticky|virtual/i);
  assert.doesNotMatch(base, /canonical|TanStack/i);

  assert.match(advanced, /grouping/i);
  assert.match(advanced, /pinning/i);
  assert.match(advanced, /reorder/i);
  assert.match(advanced, /sizing/i);
  assert.match(advanced, /density/i);
  assert.match(advanced, /persistence/i);
  assert.match(advanced, /Restore/i);
  assert.match(advanced, /sticky/i);
  assert.match(advanced, /server-side/i);
  assert.match(advanced, /virtualization/i);
  assert.doesNotMatch(advanced, /advancedControls|canonical|TanStack/i);
  assert.doesNotMatch(advanced, /one Filter control|filter chips/i);
});

test('a known, waivable rule accepts an explicit deterministic override', () => {
  const base = defaultContract('operational-saas');
  base.capabilities.kanban = true;
  base.capabilities.dragAndDrop = true;
  const contract = replaceRule(base, 'components.kanban', {
    status: 'required',
    reason: 'workflow_stage_based',
  });

  assert.deepEqual(validateUiContract(contract), { ok: true, outcome: 'PASS', errors: [] });
  assert.deepEqual(evaluateUiRule(contract, 'components.kanban', { compliant: true }), {
    ruleId: 'components.kanban',
    status: 'required',
    reason: 'workflow_stage_based',
    outcome: 'PASS',
  });
});

test('a dispensable product rule may be waived with reason, scope, and owner', () => {
  const base = defaultContract('enterprise-admin');
  base.capabilities.userThemePreference = false;
  const contract = replaceRule(base, 'theme.user_switcher', {
    status: 'waived',
    reason: 'art_directed_fixed_theme',
    waiver: {
      approvedBy: 'product-owner',
      scope: 'gameplay-surface',
    },
  });

  assert.equal(validateUiContract(contract).outcome, 'PASS');
  assert.deepEqual(evaluateUiRule(contract, 'theme.user_switcher'), {
    ruleId: 'theme.user_switcher',
    status: 'waived',
    reason: 'art_directed_fixed_theme',
    outcome: 'SKIP',
  });
});

test('quality invariants refuse waivers instead of silently degrading', () => {
  const contract = replaceRule(defaultContract('immersive-game'), 'quality.overflow_containment', {
    status: 'waived',
    reason: 'product_owner_exception',
    waiver: { approvedBy: 'product-owner', scope: 'whole-product' },
  });

  const validation = validateUiContract(contract);
  assert.equal(validation.ok, false);
  assert.equal(validation.outcome, 'FAIL');
  assert.ok(validation.errors.some((error) => error.code === 'invariant_waiver_forbidden'));
  assert.throws(() => evaluateUiRule(contract, 'quality.overflow_containment'), /UI contract is invalid/);
});

test('every decision requires a recognized reason code', () => {
  const missing = replaceRule(defaultContract('marketing'), 'components.data_table', {
    status: 'optional',
    reason: '',
  });
  const unknown = replaceRule(defaultContract('marketing'), 'components.data_table', {
    status: 'optional',
    reason: 'because-i-said-so',
  });

  assert.ok(validateUiContract(missing).errors.some((error) => error.code === 'reason_required'));
  assert.ok(validateUiContract(unknown).errors.some((error) => error.code === 'unknown_reason'));
});

test('reason codes are valid for the specific rule and status, not only globally', () => {
  const nonsense = replaceRule(defaultContract('immersive-game'), 'components.kanban', {
    status: 'not_applicable',
    reason: 'nested_route_hierarchy',
  });

  assert.ok(validateUiContract(nonsense).errors.some((error) => error.code === 'reason_not_allowed'));
});

test('capability activation is cross-validated and active Kanban requires drag quality', () => {
  const missingKanbanCapability = replaceRule(defaultContract('operational-saas'), 'components.kanban', {
    status: 'required',
    reason: 'workflow_stage_based',
  });
  assert.ok(
    validateUiContract(missingKanbanCapability).errors.some((error) => error.code === 'capability_activation_required'),
  );

  const missingDrag = defaultContract('operational-saas');
  missingDrag.capabilities.kanban = true;
  missingDrag.rules['components.kanban'] = {
    status: 'required',
    reason: 'workflow_stage_based',
  };
  assert.ok(validateUiContract(missingDrag).errors.some((error) => error.code === 'kanban_drag_required'));
});

test('optional is dormant until its dedicated capability boolean is explicitly activated', () => {
  const dormant = defaultContract('operational-saas');
  assert.deepEqual(resolveUiRuleApplicability(dormant, 'components.data_table'), {
    ruleId: 'components.data_table',
    status: 'optional',
    reason: 'profile_default_optional',
    applicable: false,
    label: 'SKIP',
  });

  dormant.capabilities.dataTables = true;
  assert.deepEqual(resolveUiRuleApplicability(dormant, 'components.data_table'), {
    ruleId: 'components.data_table',
    status: 'optional',
    reason: 'profile_default_optional',
    applicable: true,
    label: 'APPLY',
  });
  assert.equal(resolveUiRuleApplicability(dormant, 'data_table.advanced_controls').applicable, false);
});

test('advanced table controls have a dedicated activation and depend on the base DataTable', () => {
  const invalid = defaultContract('operational-saas');
  invalid.capabilities.advancedDataTableControls = true;
  assert.ok(validateUiContract(invalid).errors.some((error) => error.code === 'advanced_table_requires_base'));

  invalid.capabilities.dataTables = true;
  assert.equal(validateUiContract(invalid).outcome, 'PASS');
  assert.equal(resolveUiRuleApplicability(invalid, 'data_table.advanced_controls').applicable, true);
});

test('enabling a DataTable selects professional controls by default and compact mode is an explicit opt-out', () => {
  const initial = defaultContract('operational-saas');
  const professional = updateUiCapability(initial, 'dataTables', true);

  assert.deepEqual(professional.changes, [
    { name: 'dataTables', from: false, to: true, reason: 'requested' },
    {
      name: 'advancedDataTableControls',
      from: false,
      to: true,
      reason: 'professional_default_for_dataTables',
    },
  ]);
  assert.equal(resolveUiRuleApplicability(professional.contract, 'components.data_table').applicable, true);
  assert.equal(resolveUiRuleApplicability(professional.contract, 'data_table.advanced_controls').applicable, true);

  const compact = updateUiCapability(professional.contract, 'advancedDataTableControls', false);
  assert.deepEqual(compact.changes, [
    { name: 'advancedDataTableControls', from: true, to: false, reason: 'requested' },
  ]);
  assert.equal(resolveUiRuleApplicability(compact.contract, 'components.data_table').applicable, true);
  assert.equal(resolveUiRuleApplicability(compact.contract, 'data_table.advanced_controls').applicable, false);

  const repeatedBaseEnable = updateUiCapability(compact.contract, 'dataTables', true);
  assert.deepEqual(repeatedBaseEnable.changes, []);
  assert.equal(repeatedBaseEnable.contract.capabilities.dataTables, true);
  assert.equal(repeatedBaseEnable.contract.capabilities.advancedDataTableControls, false);
});

test('the professional-default cascade respects an explicit waiver/not_applicable on advanced controls', () => {
  // A recorded base-only decision (the exact override the cookbook sanctions)
  // must not make enabling the base table impossible: the cascade stands down
  // and the update stays valid, leaving advanced controls off.
  for (const rule of [
    { status: 'waived', reason: 'product_owner_exception', waiver: { approvedBy: 'owner', scope: 'all tables' } },
    { status: 'not_applicable', reason: 'custom_product_decision' },
  ]) {
    const contract = defaultContract('custom');
    contract.rules['components.data_table'] = { status: 'optional', reason: 'custom_product_decision' };
    contract.rules['data_table.advanced_controls'] = rule;
    contract.capabilities.dataTables = false;
    contract.capabilities.advancedDataTableControls = false;
    const enabled = updateUiCapability(contract, 'dataTables', true);
    assert.deepEqual(enabled.changes, [{ name: 'dataTables', from: false, to: true, reason: 'requested' }]);
    assert.equal(enabled.contract.capabilities.advancedDataTableControls, false);
    assert.equal(validateUiContract(enabled.contract).outcome, 'PASS');
  }
});

test('validation fails closed for omitted and invented rules', () => {
  const missing = defaultContract('custom');
  delete missing.rules['quality.keyboard_access'];

  const invented = defaultContract('custom');
  invented.rules['quality.looks_professional'] = {
    status: 'required',
    reason: 'quality_floor',
  };

  assert.ok(validateUiContract(missing).errors.some((error) => error.code === 'rule_required'));
  assert.ok(validateUiContract(invented).errors.some((error) => error.code === 'unknown_rule'));
});

test('breadcrumb is required only for real hierarchy and fails closed without route context', () => {
  const contract = defaultContract('enterprise-admin');

  assert.deepEqual(evaluateUiRule(contract, 'navigation.breadcrumb', { routeDepth: 3 }), {
    ruleId: 'navigation.breadcrumb',
    status: 'required',
    reason: 'nested_route_hierarchy',
    outcome: 'FAIL',
  });
  assert.deepEqual(evaluateUiRule(contract, 'navigation.breadcrumb', { routeDepth: 1 }), {
    ruleId: 'navigation.breadcrumb',
    status: 'not_applicable',
    reason: 'flat_route',
    outcome: 'SKIP',
  });
  assert.deepEqual(evaluateUiRule(contract, 'navigation.breadcrumb'), {
    ruleId: 'navigation.breadcrumb',
    status: 'required',
    reason: 'route_depth_unknown_fail_closed',
    outcome: 'FAIL',
  });
});

test('persistence is explicit, uses ai-docs/ui/contract.json, and missing reads fail closed', () => {
  const root = temporaryProject();
  assert.equal(loadUiContract(root), null);
  assert.throws(() => loadUiContract(root, { required: true }), /UI contract not found/);

  const contract = defaultContract('content');
  const path = saveUiContract(root, contract);
  assert.equal(path, join(root, 'ai-docs', 'ui', 'contract.json'));
  assert.equal(existsSync(path), true);
  assert.deepEqual(loadUiContract(root, { required: true }), contract);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), contract);
});

test('CLI writes only on explicit init and reports structural PASS on check', () => {
  const root = temporaryProject();
  execFileSync(process.execPath, [SCRIPT, 'print', '--profile', 'marketing'], { encoding: 'utf8' });
  assert.equal(existsSync(join(root, 'ai-docs', 'ui', 'contract.json')), false);

  const init = JSON.parse(
    execFileSync(process.execPath, [SCRIPT, 'init', '--profile', 'immersive-game', '--dir', root, '--json'], {
      encoding: 'utf8',
    }),
  );
  assert.equal(init.outcome, 'PASS');

  const check = JSON.parse(
    execFileSync(process.execPath, [SCRIPT, 'check', '--dir', root, '--json'], { encoding: 'utf8' }),
  );
  assert.deepEqual(check, { outcome: 'PASS', valid: true, errors: [] });
});

test('CLI init rejects a global non-canonical library choice and leaves no partial contract', () => {
  const root = temporaryProject();
  const result = spawnSync(
    process.execPath,
    [
      SCRIPT,
      'init',
      '--profile',
      'enterprise-admin',
      '--implementation-mode',
      'specified-library',
      '--implementation-package',
      '@mui/material',
      '--implementation-path',
      'components/mui/ui.tsx',
      '--dir',
      root,
      '--json',
    ],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /per-surface/i);
  assert.equal(existsSync(join(root, 'ai-docs', 'ui', 'contract.json')), false);
});

test('CLI implementation atomically updates only the requested surface', () => {
  const root = temporaryProject();
  execFileSync(process.execPath, [SCRIPT, 'init', '--profile', 'enterprise-admin', '--dir', root, '--json'], {
    encoding: 'utf8',
  });

  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        SCRIPT,
        'implementation',
        '--surface',
        'data_table',
        '--mode',
        'custom',
        '--path',
        'components/acme/records-grid.tsx',
        '--dir',
        root,
        '--json',
      ],
      { encoding: 'utf8' },
    ),
  );

  assert.deepEqual(result.implementation, {
    surface: 'data_table',
    mode: 'custom',
    path: 'components/acme/records-grid.tsx',
    reason: 'user_explicit_custom',
    isCanonical: false,
  });
  const stored = loadUiContract(root, { required: true });
  assert.equal(resolveUiImplementation(stored, 'data_table').mode, 'custom');
  assert.equal(resolveUiImplementation(stored, 'theme').reason, 'canonical_fallback');
  assert.equal(
    readdirSync(join(root, 'ai-docs', 'ui')).some((name) => name.endsWith('.tmp')),
    false,
  );

});

test('CLI implementation supports explicit canonical and library surface choices', () => {
  const root = temporaryProject();
  execFileSync(process.execPath, [SCRIPT, 'init', '--profile', 'operational-saas', '--dir', root, '--json'], {
    encoding: 'utf8',
  });

  execFileSync(
    process.execPath,
    [
      SCRIPT,
      'implementation',
      '--surface',
      'theme',
      '--mode',
      'existing-library',
      '--package',
      '@acme/ui',
      '--path',
      'components/acme/theme-provider.tsx',
      '--dir',
      root,
      '--json',
    ],
    { encoding: 'utf8' },
  );
  execFileSync(
    process.execPath,
    [SCRIPT, 'implementation', '--surface', 'kanban', '--mode', 'canonical', '--dir', root, '--json'],
    { encoding: 'utf8' },
  );

  const contract = loadUiContract(root, { required: true });
  assert.deepEqual(resolveUiImplementation(contract, 'theme'), {
    surface: 'theme',
    mode: 'existing-library',
    package: '@acme/ui',
    path: 'components/acme/theme-provider.tsx',
    reason: 'user_explicit_existing_library',
    isCanonical: false,
  });
  assert.deepEqual(resolveUiImplementation(contract, 'kanban'), {
    surface: 'kanban',
    mode: 'canonical',
    preset: CANONICAL_UI_PRESET,
    reason: 'user_explicit_canonical',
    isCanonical: true,
  });
});

test('CLI capability atomically enables optional capabilities with their safe dependency cascades', () => {
  const root = temporaryProject();
  execFileSync(process.execPath, [SCRIPT, 'init', '--profile', 'operational-saas', '--dir', root, '--json'], {
    encoding: 'utf8',
  });

  const kanban = JSON.parse(
    execFileSync(
      process.execPath,
      [SCRIPT, 'capability', '--name', 'kanban', '--enabled', 'true', '--dir', root, '--json'],
      { encoding: 'utf8' },
    ),
  );
  assert.deepEqual(kanban.capability, { name: 'kanban', enabled: true });
  assert.deepEqual(kanban.changes, [
    { name: 'kanban', from: false, to: true, reason: 'requested' },
    { name: 'dragAndDrop', from: false, to: true, reason: 'required_by_kanban' },
  ]);

  const advanced = JSON.parse(
    execFileSync(
      process.execPath,
      [SCRIPT, 'capability', '--name', 'advancedDataTableControls', '--enabled', 'true', '--dir', root, '--json'],
      { encoding: 'utf8' },
    ),
  );
  assert.deepEqual(advanced.capability, { name: 'advancedDataTableControls', enabled: true });
  assert.deepEqual(advanced.changes, [
    { name: 'advancedDataTableControls', from: false, to: true, reason: 'requested' },
    { name: 'dataTables', from: false, to: true, reason: 'required_by_advancedDataTableControls' },
  ]);

  const stored = loadUiContract(root, { required: true });
  assert.equal(stored.capabilities.kanban, true);
  assert.equal(stored.capabilities.dragAndDrop, true);
  assert.equal(stored.capabilities.advancedDataTableControls, true);
  assert.equal(stored.capabilities.dataTables, true);
  assert.equal(
    readdirSync(join(root, 'ai-docs', 'ui')).some((name) => name.endsWith('.tmp')),
    false,
  );

  const tableRoot = temporaryProject();
  execFileSync(process.execPath, [SCRIPT, 'init', '--profile', 'operational-saas', '--dir', tableRoot, '--json'], {
    encoding: 'utf8',
  });
  const professionalTable = JSON.parse(
    execFileSync(
      process.execPath,
      [SCRIPT, 'capability', '--name', 'dataTables', '--enabled', 'true', '--dir', tableRoot, '--json'],
      { encoding: 'utf8' },
    ),
  );
  assert.deepEqual(professionalTable.changes, [
    { name: 'dataTables', from: false, to: true, reason: 'requested' },
    {
      name: 'advancedDataTableControls',
      from: false,
      to: true,
      reason: 'professional_default_for_dataTables',
    },
  ]);
  const compactTable = JSON.parse(
    execFileSync(
      process.execPath,
      [SCRIPT, 'capability', '--name', 'advancedDataTableControls', '--enabled', 'false', '--dir', tableRoot, '--json'],
      { encoding: 'utf8' },
    ),
  );
  assert.deepEqual(compactTable.changes, [
    { name: 'advancedDataTableControls', from: true, to: false, reason: 'requested' },
  ]);
  assert.equal(loadUiContract(tableRoot, { required: true }).capabilities.dataTables, true);

  const repeatedBaseEnable = JSON.parse(
    execFileSync(
      process.execPath,
      [SCRIPT, 'capability', '--name', 'dataTables', '--enabled', 'true', '--dir', tableRoot, '--json'],
      { encoding: 'utf8' },
    ),
  );
  assert.deepEqual(repeatedBaseEnable.changes, []);
  const repeatedContract = loadUiContract(tableRoot, { required: true });
  assert.equal(repeatedContract.capabilities.dataTables, true);
  assert.equal(repeatedContract.capabilities.advancedDataTableControls, false);
});

test('CLI capability rejects conflicting disables without changing the contract', () => {
  const root = temporaryProject();
  execFileSync(process.execPath, [SCRIPT, 'init', '--profile', 'operational-saas', '--dir', root, '--json'], {
    encoding: 'utf8',
  });
  execFileSync(
    process.execPath,
    [SCRIPT, 'capability', '--name', 'kanban', '--enabled', 'true', '--dir', root, '--json'],
    { encoding: 'utf8' },
  );
  execFileSync(
    process.execPath,
    [SCRIPT, 'capability', '--name', 'advancedDataTableControls', '--enabled', 'true', '--dir', root, '--json'],
    { encoding: 'utf8' },
  );
  const path = join(root, 'ai-docs', 'ui', 'contract.json');
  const before = readFileSync(path, 'utf8');

  const drag = spawnSync(
    process.execPath,
    [SCRIPT, 'capability', '--name', 'dragAndDrop', '--enabled', 'false', '--dir', root, '--json'],
    { encoding: 'utf8' },
  );
  assert.equal(drag.status, 1);
  assert.match(drag.stderr, /Cannot disable dragAndDrop while kanban is enabled/);
  assert.equal(readFileSync(path, 'utf8'), before);

  const table = spawnSync(
    process.execPath,
    [SCRIPT, 'capability', '--name', 'dataTables', '--enabled', 'false', '--dir', root, '--json'],
    { encoding: 'utf8' },
  );
  assert.equal(table.status, 1);
  assert.match(table.stderr, /Cannot disable dataTables while advancedDataTableControls is enabled/);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('CLI capability permits ordered disables without an implicit downward cascade', () => {
  const root = temporaryProject();
  execFileSync(process.execPath, [SCRIPT, 'init', '--profile', 'operational-saas', '--dir', root, '--json'], {
    encoding: 'utf8',
  });
  for (const name of ['kanban', 'advancedDataTableControls']) {
    execFileSync(
      process.execPath,
      [SCRIPT, 'capability', '--name', name, '--enabled', 'true', '--dir', root, '--json'],
      {
        encoding: 'utf8',
      },
    );
  }

  const kanban = JSON.parse(
    execFileSync(
      process.execPath,
      [SCRIPT, 'capability', '--name', 'kanban', '--enabled', 'false', '--dir', root, '--json'],
      { encoding: 'utf8' },
    ),
  );
  assert.deepEqual(kanban.changes, [{ name: 'kanban', from: true, to: false, reason: 'requested' }]);
  assert.equal(loadUiContract(root, { required: true }).capabilities.dragAndDrop, true);

  for (const name of ['dragAndDrop', 'advancedDataTableControls', 'dataTables']) {
    execFileSync(
      process.execPath,
      [SCRIPT, 'capability', '--name', name, '--enabled', 'false', '--dir', root, '--json'],
      { encoding: 'utf8' },
    );
  }
  assert.deepEqual(loadUiContract(root, { required: true }).capabilities, {
    appShell: true,
    hierarchicalNavigation: true,
    userThemePreference: true,
    dataTables: false,
    advancedDataTableControls: false,
    kanban: false,
    dragAndDrop: false,
  });
});

test('CLI capability fails closed on malformed requests and invalid rule transitions', () => {
  const root = temporaryProject();
  execFileSync(process.execPath, [SCRIPT, 'init', '--profile', 'enterprise-admin', '--dir', root, '--json'], {
    encoding: 'utf8',
  });
  const path = join(root, 'ai-docs', 'ui', 'contract.json');
  const before = readFileSync(path, 'utf8');

  for (const [args, message] of [
    [['--name', 'invented', '--enabled', 'true'], /Unknown UI capability: invented/],
    [['--name', 'kanban', '--enabled', 'yes'], /capability requires --enabled true\|false/],
    [['--enabled', 'true'], /capability requires --name/],
    [['--name', 'kanban'], /capability requires --enabled true\|false/],
    [['--name', 'appShell', '--enabled', 'false'], /UI contract is invalid/],
  ]) {
    const result = spawnSync(process.execPath, [SCRIPT, 'capability', ...args, '--dir', root, '--json'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
    assert.equal(readFileSync(path, 'utf8'), before);
  }
});

test(
  'Harness and FIA ship the same ui-contract executable',
  { skip: !existsSync(HARNESS_SCRIPT) && 'private harness checkout not present' },
  () => {
    assert.equal(readFileSync(HARNESS_SCRIPT, 'utf8'), readFileSync(SCRIPT, 'utf8'));
  },
);

test('CLI migrate upgrades a valid schema v1 contract only through an explicit command', () => {
  const root = temporaryProject();
  const path = join(root, 'ai-docs', 'ui', 'contract.json');
  const legacy = defaultContract('marketing');
  legacy.schemaVersion = 1;
  delete legacy.implementation;
  mkdirSync(join(root, 'ai-docs', 'ui'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(legacy, null, 2)}\n`);

  const rejected = spawnSync(process.execPath, [SCRIPT, 'check', '--dir', root, '--json'], { encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Expected UI contract schema 3/);
  const result = JSON.parse(
    execFileSync(process.execPath, [SCRIPT, 'migrate', '--dir', root, '--json'], { encoding: 'utf8' }),
  );

  assert.equal(result.outcome, 'PASS');
  assert.equal(result.fromSchemaVersion, 1);
  assert.equal(loadUiContract(root, { required: true }).schemaVersion, 3);
});

test('schema v2 migration preserves safe explicit surfaces but refuses ambiguous legacy library/global choices', () => {
  const safe = defaultContract('enterprise-admin');
  safe.schemaVersion = 2;
  safe.implementation.surfaces.kanban = {
    mode: 'custom',
    path: 'src/boards/project-board.tsx',
    reason: 'user_explicit_custom',
  };
  const migrated = migrateUiContract(safe);
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.implementation.surfaces.kanban.path, 'src/boards/project-board.tsx');

  const global = defaultContract('enterprise-admin');
  global.schemaVersion = 2;
  global.implementation.default = {
    mode: 'specified-library',
    package: '@mui/material',
    reason: 'user_explicit_specified_library',
  };
  assert.throws(() => migrateUiContract(global), /per-surface/i);

  const missingEntrypoint = defaultContract('enterprise-admin');
  missingEntrypoint.schemaVersion = 2;
  missingEntrypoint.implementation.surfaces.data_table = {
    mode: 'specified-library',
    package: '@mui/x-data-grid-premium',
    reason: 'user_explicit_specified_library',
  };
  assert.throws(() => migrateUiContract(missingEntrypoint), /entrypoint|--path/i);
  const repaired = migrateUiContract(missingEntrypoint, {
    entrypoints: { data_table: 'src/components/data-table/mui-grid.tsx' },
  });
  assert.deepEqual(repaired.implementation.surfaces.data_table, {
    mode: 'specified-library',
    package: '@mui/x-data-grid-premium',
    path: 'src/components/data-table/mui-grid.tsx',
    reason: 'user_explicit_specified_library',
  });

  const root = temporaryProject();
  mkdirSync(join(root, 'ai-docs', 'ui'), { recursive: true });
  writeFileSync(join(root, 'ai-docs', 'ui', 'contract.json'), `${JSON.stringify(missingEntrypoint, null, 2)}\n`);
  execFileSync(
    process.execPath,
    [SCRIPT, 'migrate', '--entrypoint', 'data_table=src/components/data-table/mui-grid.tsx', '--dir', root, '--json'],
    { encoding: 'utf8' },
  );
  assert.equal(
    loadUiContract(root, { required: true }).implementation.surfaces.data_table.path,
    'src/components/data-table/mui-grid.tsx',
  );
});
