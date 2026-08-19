#!/usr/bin/env node
/**
 * Deterministic UI contract.
 *
 * Product profiles decide which UI capabilities apply. Quality invariants do
 * not become optional just because a product uses a different visual model.
 * The contract is deliberately JSON-only and dependency-free so prompts,
 * gates, and generated projects can all consume the same decision record.
 *
 * Usage:
 *   node .agents/scripts/ui-contract.mjs print --profile enterprise-admin
 *   node .agents/scripts/ui-contract.mjs init --profile enterprise-admin [--dir .]
 *   node .agents/scripts/ui-contract.mjs capability --name kanban --enabled true [--dir .]
 *   node .agents/scripts/ui-contract.mjs implementation --surface data_table --mode custom --path components/data-grid.tsx
 *   node .agents/scripts/ui-contract.mjs migrate [--dir .]
 *   node .agents/scripts/ui-contract.mjs check [--dir .]
 *   node .agents/scripts/ui-contract.mjs evaluate [--dir .] [--context context.json]
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const UI_CONTRACT_SCHEMA_VERSION = 3;
export const UI_CONTRACT_RELATIVE_PATH = join('ai-docs', 'ui', 'contract.json');
export const UI_COMPONENT_REGISTRY_RELATIVE_PATH = join('ai-docs', 'components', 'registry.md');
export const CANONICAL_UI_PRESET = 'fia-universal';

export const UI_IMPLEMENTATION_SURFACES = Object.freeze(['app_shell', 'breadcrumb', 'theme', 'data_table', 'kanban']);

export const UI_IMPLEMENTATION_MODES = Object.freeze(['canonical', 'existing-library', 'specified-library', 'custom']);

export const UI_PROFILES = Object.freeze([
  'enterprise-admin',
  'operational-saas',
  'content',
  'marketing',
  'immersive-game',
  'custom',
]);

export const UI_RULE_STATUSES = Object.freeze(['required', 'optional', 'not_applicable', 'waived']);

export const UI_OUTCOMES = Object.freeze(['PASS', 'SKIP', 'FAIL']);

/** Closed vocabulary: a decision without a recognized reason fails closed. */
export const UI_REASON_CODES = Object.freeze({
  quality_floor: 'Non-negotiable UI quality floor.',
  conditional_capability: 'Applies only when the related capability is enabled.',
  capability_not_enabled: 'The related capability is not enabled in this product.',
  drag_enabled_quality_floor: 'Drag-and-drop is enabled, so drag quality is required.',
  conditional_route_hierarchy: 'Applicability depends on the current route depth.',
  nested_route_hierarchy: 'The route has parent levels that need orientation.',
  flat_route: 'The route has no parent hierarchy to expose.',
  route_depth_unknown_fail_closed: 'Route depth was unavailable, so hierarchy support is required.',
  system_theme_standard: 'Users can follow the operating-system theme and override it.',
  art_directed_fixed_theme: 'A deliberately art-directed surface uses one fixed theme.',
  immersive_single_surface: 'An immersive single-surface experience has no page hierarchy.',
  profile_default_required: 'The selected product profile requires this capability.',
  profile_default_optional: 'The selected product profile permits this capability.',
  profile_not_applicable: 'The selected product profile does not use this capability.',
  data_dense_workflow: 'The product has a data-dense operational workflow.',
  workflow_stage_based: 'The workflow is organized into explicit stages.',
  feature_not_requested: 'The product has not requested this feature.',
  product_owner_exception: 'The product owner approved a scoped exception.',
  custom_product_decision: 'The custom product contract records an explicit decision.',
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

/**
 * The canonical rule catalog. `waivable: false` means no profile, prompt, or
 * user override may turn the rule into a waiver. Contextual invariants can be
 * not-applicable only through their declared deterministic condition.
 */
export const UI_RULES = deepFreeze({
  'quality.responsive_layout': {
    category: 'quality',
    invariant: true,
    contextual: false,
    waivable: false,
    description: 'Layouts remain usable at supported viewport sizes and zoom levels.',
  },
  'quality.overflow_containment': {
    category: 'quality',
    invariant: true,
    contextual: false,
    waivable: false,
    description: 'Content and controls remain inside their owning component or explicit scroller.',
  },
  'quality.keyboard_access': {
    category: 'quality',
    invariant: true,
    contextual: false,
    waivable: false,
    description: 'Interactive behavior is operable with a keyboard.',
  },
  'quality.focus_visibility': {
    category: 'quality',
    invariant: true,
    contextual: false,
    waivable: false,
    description: 'Keyboard focus is always perceptible.',
  },
  'quality.error_recovery': {
    category: 'quality',
    invariant: true,
    contextual: false,
    waivable: false,
    description: 'Errors expose a recovery path and do not silently lose user work.',
  },
  'quality.drag_geometry': {
    category: 'quality',
    invariant: true,
    contextual: true,
    conditionKind: 'capability_enabled',
    capability: 'dragAndDrop',
    waivable: false,
    description: 'Dragged overlays preserve pointer alignment and source geometry.',
  },
  'quality.drag_alternative': {
    category: 'quality',
    invariant: true,
    contextual: true,
    conditionKind: 'capability_enabled',
    capability: 'dragAndDrop',
    waivable: false,
    description: 'Dragging has a non-dragging single-pointer and keyboard alternative.',
  },
  'navigation.breadcrumb': {
    category: 'navigation',
    invariant: false,
    contextual: true,
    conditionKind: 'route_depth_greater_than',
    waivable: true,
    description: 'Nested routes expose their parent hierarchy.',
  },
  'shell.app_shell': {
    category: 'shell',
    invariant: false,
    contextual: false,
    waivable: true,
    description: 'Application products use the canonical responsive shell and page header.',
  },
  'theme.user_switcher': {
    category: 'theme',
    invariant: false,
    contextual: false,
    waivable: true,
    description: 'Users can select system, light, or dark presentation.',
  },
  'components.data_table': {
    category: 'component',
    invariant: false,
    contextual: false,
    waivable: true,
    description:
      'Data-heavy workflows use one shared semantic table with global search, one Filter control, an accessible header menu, compact removable chips, compatible sort/hide/reset actions, visibility, pagination/count, and complete states.',
  },
  'data_table.advanced_controls': {
    category: 'component',
    invariant: false,
    contextual: false,
    waivable: true,
    description:
      'Opt-in advanced tables add multi-level grouping, pinning, sizing, density, reorder, versioned per-user persistence with Restore, sticky headers, server-side scale, and virtualization only when this rule applies; a base table does not activate them implicitly.',
  },
  'components.kanban': {
    category: 'component',
    invariant: false,
    contextual: false,
    waivable: true,
    description: 'Stage-based workflows use one shared Kanban implementation.',
  },
});

/** Stable list used by gates that must always enforce the quality floor. */
export const invariants = Object.freeze(
  Object.entries(UI_RULES)
    .filter(([, rule]) => rule.invariant)
    .map(([ruleId]) => ruleId),
);

/**
 * Optional status is only permission to activate later. These booleans record
 * whether that capability is actually active in this product contract.
 */
export const UI_RULE_CAPABILITIES = deepFreeze({
  'shell.app_shell': 'appShell',
  'navigation.breadcrumb': 'hierarchicalNavigation',
  'theme.user_switcher': 'userThemePreference',
  'components.data_table': 'dataTables',
  'data_table.advanced_controls': 'advancedDataTableControls',
  'components.kanban': 'kanban',
  'quality.drag_geometry': 'dragAndDrop',
  'quality.drag_alternative': 'dragAndDrop',
});

const PRIMARY_RULE_CAPABILITIES = deepFreeze({
  'shell.app_shell': 'appShell',
  'navigation.breadcrumb': 'hierarchicalNavigation',
  'theme.user_switcher': 'userThemePreference',
  'components.data_table': 'dataTables',
  'data_table.advanced_controls': 'advancedDataTableControls',
  'components.kanban': 'kanban',
});

const PRODUCT_REQUIRED_REASONS = Object.freeze(['profile_default_required', 'custom_product_decision']);
const PRODUCT_OPTIONAL_REASONS = Object.freeze([
  'profile_default_optional',
  'feature_not_requested',
  'custom_product_decision',
]);
const PRODUCT_SKIP_REASONS = Object.freeze([
  'profile_not_applicable',
  'feature_not_requested',
  'capability_not_enabled',
  'custom_product_decision',
]);
const PRODUCT_WAIVER_REASONS = Object.freeze(['product_owner_exception', 'custom_product_decision']);

/** Closed reason vocabulary per rule and configured status. */
const UI_RULE_REASON_CODES = deepFreeze({
  'quality.responsive_layout': { required: ['quality_floor'] },
  'quality.overflow_containment': { required: ['quality_floor'] },
  'quality.keyboard_access': { required: ['quality_floor'] },
  'quality.focus_visibility': { required: ['quality_floor'] },
  'quality.error_recovery': { required: ['quality_floor'] },
  'quality.drag_geometry': { optional: ['conditional_capability'] },
  'quality.drag_alternative': { optional: ['conditional_capability'] },
  'navigation.breadcrumb': {
    required: [...PRODUCT_REQUIRED_REASONS, 'nested_route_hierarchy'],
    optional: [...PRODUCT_OPTIONAL_REASONS, 'conditional_route_hierarchy'],
    not_applicable: [...PRODUCT_SKIP_REASONS, 'immersive_single_surface', 'flat_route'],
    waived: PRODUCT_WAIVER_REASONS,
  },
  'shell.app_shell': {
    required: PRODUCT_REQUIRED_REASONS,
    optional: PRODUCT_OPTIONAL_REASONS,
    not_applicable: [...PRODUCT_SKIP_REASONS, 'immersive_single_surface'],
    waived: PRODUCT_WAIVER_REASONS,
  },
  'theme.user_switcher': {
    required: [...PRODUCT_REQUIRED_REASONS, 'system_theme_standard'],
    optional: [...PRODUCT_OPTIONAL_REASONS, 'art_directed_fixed_theme'],
    not_applicable: [...PRODUCT_SKIP_REASONS, 'art_directed_fixed_theme'],
    waived: [...PRODUCT_WAIVER_REASONS, 'art_directed_fixed_theme'],
  },
  'components.data_table': {
    required: [...PRODUCT_REQUIRED_REASONS, 'data_dense_workflow'],
    optional: PRODUCT_OPTIONAL_REASONS,
    not_applicable: PRODUCT_SKIP_REASONS,
    waived: PRODUCT_WAIVER_REASONS,
  },
  'data_table.advanced_controls': {
    required: [...PRODUCT_REQUIRED_REASONS, 'data_dense_workflow'],
    optional: PRODUCT_OPTIONAL_REASONS,
    not_applicable: PRODUCT_SKIP_REASONS,
    waived: PRODUCT_WAIVER_REASONS,
  },
  'components.kanban': {
    required: [...PRODUCT_REQUIRED_REASONS, 'workflow_stage_based'],
    optional: PRODUCT_OPTIONAL_REASONS,
    not_applicable: PRODUCT_SKIP_REASONS,
    waived: PRODUCT_WAIVER_REASONS,
  },
});

export const UI_CAPABILITY_KEYS = Object.freeze([
  'appShell',
  'hierarchicalNavigation',
  'userThemePreference',
  'dataTables',
  'advancedDataTableControls',
  'kanban',
  'dragAndDrop',
]);

const UNIVERSAL_INVARIANTS = Object.freeze(invariants.filter((ruleId) => !UI_RULES[ruleId].contextual));

const DRAG_CONDITION = deepFreeze({
  kind: 'capability_enabled',
  capability: 'dragAndDrop',
  whenMet: { status: 'required', reason: 'drag_enabled_quality_floor' },
  whenNotMet: { status: 'not_applicable', reason: 'capability_not_enabled' },
});

const BREADCRUMB_CONDITION = deepFreeze({
  kind: 'route_depth_greater_than',
  value: 1,
  whenMet: { status: 'required', reason: 'nested_route_hierarchy' },
  whenNotMet: { status: 'not_applicable', reason: 'flat_route' },
  whenUnknown: { status: 'required', reason: 'route_depth_unknown_fail_closed' },
});

function entry(status, reason) {
  return { status, reason };
}

function conditionalEntry(reason, condition) {
  return { status: 'optional', reason, condition };
}

const PROFILE_DEFAULTS = deepFreeze({
  'enterprise-admin': {
    capabilities: {
      appShell: true,
      hierarchicalNavigation: true,
      userThemePreference: true,
      dataTables: true,
      advancedDataTableControls: true,
      kanban: false,
      dragAndDrop: false,
    },
    rules: {
      'shell.app_shell': entry('required', 'profile_default_required'),
      'navigation.breadcrumb': conditionalEntry('conditional_route_hierarchy', BREADCRUMB_CONDITION),
      'theme.user_switcher': entry('required', 'system_theme_standard'),
      'components.data_table': entry('required', 'data_dense_workflow'),
      'data_table.advanced_controls': entry('required', 'data_dense_workflow'),
      'components.kanban': entry('optional', 'feature_not_requested'),
    },
  },
  'operational-saas': {
    capabilities: {
      appShell: true,
      hierarchicalNavigation: true,
      userThemePreference: true,
      dataTables: false,
      advancedDataTableControls: false,
      kanban: false,
      dragAndDrop: false,
    },
    rules: {
      'shell.app_shell': entry('required', 'profile_default_required'),
      'navigation.breadcrumb': conditionalEntry('conditional_route_hierarchy', BREADCRUMB_CONDITION),
      'theme.user_switcher': entry('required', 'system_theme_standard'),
      'components.data_table': entry('optional', 'profile_default_optional'),
      'data_table.advanced_controls': entry('optional', 'profile_default_optional'),
      'components.kanban': entry('optional', 'profile_default_optional'),
    },
  },
  content: {
    capabilities: {
      appShell: false,
      hierarchicalNavigation: true,
      userThemePreference: false,
      dataTables: false,
      advancedDataTableControls: false,
      kanban: false,
      dragAndDrop: false,
    },
    rules: {
      'shell.app_shell': entry('optional', 'profile_default_optional'),
      'navigation.breadcrumb': conditionalEntry('conditional_route_hierarchy', BREADCRUMB_CONDITION),
      'theme.user_switcher': entry('optional', 'profile_default_optional'),
      'components.data_table': entry('not_applicable', 'profile_not_applicable'),
      'data_table.advanced_controls': entry('not_applicable', 'profile_not_applicable'),
      'components.kanban': entry('not_applicable', 'profile_not_applicable'),
    },
  },
  marketing: {
    capabilities: {
      appShell: false,
      hierarchicalNavigation: false,
      userThemePreference: false,
      dataTables: false,
      advancedDataTableControls: false,
      kanban: false,
      dragAndDrop: false,
    },
    rules: {
      'shell.app_shell': entry('not_applicable', 'profile_not_applicable'),
      'navigation.breadcrumb': entry('not_applicable', 'profile_not_applicable'),
      'theme.user_switcher': entry('optional', 'art_directed_fixed_theme'),
      'components.data_table': entry('not_applicable', 'profile_not_applicable'),
      'data_table.advanced_controls': entry('not_applicable', 'profile_not_applicable'),
      'components.kanban': entry('not_applicable', 'profile_not_applicable'),
    },
  },
  'immersive-game': {
    capabilities: {
      appShell: false,
      hierarchicalNavigation: false,
      userThemePreference: false,
      dataTables: false,
      advancedDataTableControls: false,
      kanban: false,
      dragAndDrop: false,
    },
    rules: {
      'shell.app_shell': entry('not_applicable', 'immersive_single_surface'),
      'navigation.breadcrumb': entry('not_applicable', 'immersive_single_surface'),
      'theme.user_switcher': entry('not_applicable', 'art_directed_fixed_theme'),
      'components.data_table': entry('not_applicable', 'profile_not_applicable'),
      'data_table.advanced_controls': entry('not_applicable', 'profile_not_applicable'),
      'components.kanban': entry('not_applicable', 'profile_not_applicable'),
    },
  },
  custom: {
    capabilities: {
      appShell: false,
      hierarchicalNavigation: false,
      userThemePreference: false,
      dataTables: false,
      advancedDataTableControls: false,
      kanban: false,
      dragAndDrop: false,
    },
    rules: {
      'shell.app_shell': entry('optional', 'custom_product_decision'),
      'navigation.breadcrumb': conditionalEntry('conditional_route_hierarchy', BREADCRUMB_CONDITION),
      'theme.user_switcher': entry('optional', 'custom_product_decision'),
      'components.data_table': entry('optional', 'custom_product_decision'),
      'data_table.advanced_controls': entry('optional', 'custom_product_decision'),
      'components.kanban': entry('optional', 'custom_product_decision'),
    },
  },
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalImplementation(reason = 'canonical_fallback') {
  return {
    mode: 'canonical',
    preset: CANONICAL_UI_PRESET,
    reason,
  };
}

const UI_IMPLEMENTATION_REASON_BY_MODE = Object.freeze({
  canonical: 'user_explicit_canonical',
  'existing-library': 'user_explicit_existing_library',
  'specified-library': 'user_explicit_specified_library',
  custom: 'user_explicit_custom',
});

function normalizeImplementationSelection(choice) {
  if (!isPlainObject(choice)) throw new TypeError('A UI implementation choice must be an object.');
  const allowedFields = new Set(['mode', 'preset', 'package', 'path', 'reason']);
  for (const field of Object.keys(choice)) {
    if (!allowedFields.has(field)) throw new TypeError(`Unknown UI implementation choice field: ${field}`);
  }
  if (!UI_IMPLEMENTATION_MODES.includes(choice.mode)) {
    throw new TypeError(`Unknown UI implementation mode: ${String(choice.mode)}`);
  }

  if (choice.mode === 'canonical') {
    if (choice.package !== undefined || choice.path !== undefined) {
      throw new TypeError('A canonical UI implementation cannot name a package or custom path.');
    }
    return canonicalImplementation('user_explicit_canonical');
  }

  if (['existing-library', 'specified-library'].includes(choice.mode)) {
    if (typeof choice.package !== 'string' || choice.package.trim() === '') {
      throw new TypeError(`${choice.mode} requires a non-empty package.`);
    }
    if (choice.preset !== undefined) {
      throw new TypeError(`${choice.mode} accepts package and path, not preset.`);
    }
    if (!validProjectRelativeEntrypoint(choice.path)) {
      throw new TypeError(`${choice.mode} requires a safe project-relative entrypoint path.`);
    }
    return {
      mode: choice.mode,
      package: choice.package.trim(),
      path: choice.path.trim(),
      reason: UI_IMPLEMENTATION_REASON_BY_MODE[choice.mode],
    };
  }

  if (!validProjectRelativeEntrypoint(choice.path)) {
    throw new TypeError('custom requires a safe project-relative entrypoint path.');
  }
  if (choice.preset !== undefined || choice.package !== undefined) {
    throw new TypeError('custom accepts path, not preset or package.');
  }
  return {
    mode: 'custom',
    path: choice.path.trim(),
    reason: UI_IMPLEMENTATION_REASON_BY_MODE.custom,
  };
}

function validProjectRelativeEntrypoint(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const path = value.trim();
  if (path.includes('\0') || path.includes('\\') || isAbsolute(path) || /^[A-Za-z]:\//.test(path)) return false;
  const segments = path.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * Normalize the implementation decision independently from applicability.
 * With no detailed choice, every applicable surface uses the universal preset.
 */
export function selectUiImplementations(choice) {
  if (choice === undefined || choice === null) {
    return {
      default: canonicalImplementation(),
      surfaces: {},
    };
  }
  if (!isPlainObject(choice)) throw new TypeError('UI implementation choices must be an object.');
  for (const field of Object.keys(choice)) {
    if (!['default', 'surfaces'].includes(field)) {
      throw new TypeError(`Unknown UI implementation field: ${field}`);
    }
  }
  const surfaces = choice.surfaces ?? {};
  if (!isPlainObject(surfaces)) throw new TypeError('UI implementation surfaces must be an object.');
  const normalizedSurfaces = {};
  for (const [surface, selection] of Object.entries(surfaces)) {
    if (!UI_IMPLEMENTATION_SURFACES.includes(surface)) {
      throw new TypeError(`Unknown UI implementation surface: ${surface}`);
    }
    normalizedSurfaces[surface] = normalizeImplementationSelection(selection);
  }
  const defaultSelection = choice.default ? normalizeImplementationSelection(choice.default) : canonicalImplementation();
  if (defaultSelection.mode !== 'canonical') {
    throw new TypeError(
      'A non-canonical UI implementation must be selected per-surface; a package/custom global default is ambiguous.',
    );
  }
  return { default: defaultSelection, surfaces: normalizedSurfaces };
}

function invariantDefaults() {
  const rules = {};
  for (const ruleId of UNIVERSAL_INVARIANTS) {
    rules[ruleId] = entry('required', 'quality_floor');
  }
  rules['quality.drag_geometry'] = conditionalEntry('conditional_capability', DRAG_CONDITION);
  rules['quality.drag_alternative'] = conditionalEntry('conditional_capability', DRAG_CONDITION);
  return rules;
}

/** Return a fresh, deterministic contract for a known product profile. */
export function defaultContract(profile, { implementation } = {}) {
  if (!UI_PROFILES.includes(profile)) {
    throw new TypeError(`Unknown UI profile: ${profile}`);
  }
  const preset = PROFILE_DEFAULTS[profile];
  return clone({
    schemaVersion: UI_CONTRACT_SCHEMA_VERSION,
    profile,
    implementation: selectUiImplementations(implementation),
    capabilities: preset.capabilities,
    rules: {
      ...invariantDefaults(),
      ...preset.rules,
    },
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameJson(left, right) {
  return isDeepStrictEqual(left, right);
}

function conditionTemplate(ruleId) {
  const rule = UI_RULES[ruleId];
  if (rule?.conditionKind === 'route_depth_greater_than') return BREADCRUMB_CONDITION;
  if (rule?.conditionKind === 'capability_enabled') return DRAG_CONDITION;
  return null;
}

function validationError(code, path, message) {
  return { code, path, message };
}

function configuredRuleIsActive(contract, ruleId) {
  const value = contract.rules?.[ruleId];
  if (!isPlainObject(value)) return false;
  if (value.status === 'required') return true;
  if (value.status !== 'optional') return false;
  const capability = UI_RULE_CAPABILITIES[ruleId];
  return capability ? contract.capabilities?.[capability] === true : false;
}

function storedImplementationSelectionIsValid(selection, { allowFallback = false } = {}) {
  if (allowFallback && sameJson(selection, canonicalImplementation())) return true;
  try {
    return sameJson(selection, normalizeImplementationSelection(selection));
  } catch {
    return false;
  }
}

/**
 * Strict structural validation. Missing and unknown rules are errors so a new
 * contract version cannot be silently interpreted by an older gate.
 */
export function validateUiContract(contract) {
  const errors = [];
  const add = (code, path, message) => errors.push(validationError(code, path, message));

  if (!isPlainObject(contract)) {
    add('contract_invalid', '$', 'UI contract must be an object.');
    return { ok: false, outcome: 'FAIL', errors };
  }

  const allowedTopLevel = new Set(['schemaVersion', 'profile', 'implementation', 'capabilities', 'rules']);
  for (const key of Object.keys(contract)) {
    if (!allowedTopLevel.has(key)) add('unknown_field', key, `Unknown contract field: ${key}`);
  }

  if (contract.schemaVersion !== UI_CONTRACT_SCHEMA_VERSION) {
    const migrationHint = [1, 2].includes(contract.schemaVersion)
      ? ' Run `ui-contract.mjs migrate` explicitly.'
      : '';
    add(
      'schema_version_unsupported',
      'schemaVersion',
      `Expected UI contract schema ${UI_CONTRACT_SCHEMA_VERSION}.${migrationHint}`,
    );
  }
  if (!UI_PROFILES.includes(contract.profile)) {
    add('unknown_profile', 'profile', `Unknown UI profile: ${String(contract.profile)}`);
  }

  if (!isPlainObject(contract.implementation)) {
    add('implementation_invalid', 'implementation', 'Implementation selection must be an object.');
  } else {
    for (const field of Object.keys(contract.implementation)) {
      if (!['default', 'surfaces'].includes(field)) {
        add('unknown_field', `implementation.${field}`, `Unknown implementation field: ${field}`);
      }
    }
    if (
      !storedImplementationSelectionIsValid(contract.implementation.default, { allowFallback: true }) ||
      contract.implementation.default?.mode !== 'canonical'
    ) {
      add(
        'implementation_default_invalid',
        'implementation.default',
        'The default implementation must be canonical; non-canonical choices must name one concrete surface.',
      );
    }
    if (!isPlainObject(contract.implementation.surfaces)) {
      add('implementation_surfaces_invalid', 'implementation.surfaces', 'Implementation surfaces must be an object.');
    } else {
      for (const [surface, selection] of Object.entries(contract.implementation.surfaces)) {
        if (!UI_IMPLEMENTATION_SURFACES.includes(surface)) {
          add(
            'implementation_surface_unknown',
            `implementation.surfaces.${surface}`,
            `Unknown UI implementation surface: ${surface}`,
          );
        } else if (!storedImplementationSelectionIsValid(selection)) {
          add(
            'implementation_surface_invalid',
            `implementation.surfaces.${surface}`,
            `Invalid explicit UI implementation for ${surface}.`,
          );
        }
      }
    }
  }

  if (!isPlainObject(contract.capabilities)) {
    add('capabilities_invalid', 'capabilities', 'Capabilities must be an object.');
  } else {
    for (const capability of UI_CAPABILITY_KEYS) {
      if (typeof contract.capabilities[capability] !== 'boolean') {
        add('capability_required', `capabilities.${capability}`, `Capability ${capability} must be boolean.`);
      }
    }
    for (const capability of Object.keys(contract.capabilities)) {
      if (!UI_CAPABILITY_KEYS.includes(capability)) {
        add('unknown_capability', `capabilities.${capability}`, `Unknown capability: ${capability}`);
      }
    }
  }

  if (!isPlainObject(contract.rules)) {
    add('rules_invalid', 'rules', 'Rules must be an object.');
  } else {
    for (const ruleId of Object.keys(UI_RULES)) {
      if (!(ruleId in contract.rules)) {
        add('rule_required', `rules.${ruleId}`, `Required rule is missing: ${ruleId}`);
      }
    }
    for (const ruleId of Object.keys(contract.rules)) {
      if (!(ruleId in UI_RULES)) {
        add('unknown_rule', `rules.${ruleId}`, `Unknown UI rule: ${ruleId}`);
        continue;
      }
      const value = contract.rules[ruleId];
      const rule = UI_RULES[ruleId];
      const path = `rules.${ruleId}`;
      if (!isPlainObject(value)) {
        add('rule_invalid', path, `Rule ${ruleId} must be an object.`);
        continue;
      }

      const allowedRuleFields = new Set(['status', 'reason', 'condition', 'waiver', 'notes']);
      for (const field of Object.keys(value)) {
        if (!allowedRuleFields.has(field)) {
          add('unknown_field', `${path}.${field}`, `Unknown field on ${ruleId}: ${field}`);
        }
      }

      if (!UI_RULE_STATUSES.includes(value.status)) {
        add('status_invalid', `${path}.status`, `Invalid status for ${ruleId}: ${String(value.status)}`);
      }
      if (typeof value.reason !== 'string' || value.reason.trim() === '') {
        add('reason_required', `${path}.reason`, `Rule ${ruleId} requires a reason code.`);
      } else if (!(value.reason in UI_REASON_CODES)) {
        add('unknown_reason', `${path}.reason`, `Unknown UI reason code: ${value.reason}`);
      } else if (
        UI_RULE_STATUSES.includes(value.status) &&
        !UI_RULE_REASON_CODES[ruleId]?.[value.status]?.includes(value.reason)
      ) {
        add(
          'reason_not_allowed',
          `${path}.reason`,
          `Reason ${value.reason} is not valid for ${ruleId} with status ${value.status}.`,
        );
      }

      if (value.notes !== undefined && (typeof value.notes !== 'string' || value.notes.trim() === '')) {
        add('notes_invalid', `${path}.notes`, 'Notes must be a non-empty string when present.');
      }

      if (value.status === 'waived') {
        if (!rule.waivable) {
          add('invariant_waiver_forbidden', `${path}.status`, `Quality invariant ${ruleId} cannot be waived.`);
        }
        if (!isPlainObject(value.waiver)) {
          add('waiver_record_required', `${path}.waiver`, 'A waiver requires owner and scope.');
        } else {
          if (typeof value.waiver.approvedBy !== 'string' || value.waiver.approvedBy.trim() === '') {
            add('waiver_owner_required', `${path}.waiver.approvedBy`, 'A waiver requires an owner.');
          }
          if (typeof value.waiver.scope !== 'string' || value.waiver.scope.trim() === '') {
            add('waiver_scope_required', `${path}.waiver.scope`, 'A waiver requires a scope.');
          }
          for (const field of Object.keys(value.waiver)) {
            if (!['approvedBy', 'scope'].includes(field)) {
              add('unknown_field', `${path}.waiver.${field}`, `Unknown waiver field: ${field}`);
            }
          }
        }
      } else if (value.waiver !== undefined) {
        add('unexpected_waiver', `${path}.waiver`, 'Only waived rules may include waiver metadata.');
      }

      if (rule.invariant && !rule.contextual && value.status !== 'required') {
        add('invariant_bypass_forbidden', `${path}.status`, `Quality invariant ${ruleId} must remain required.`);
      }
      if (rule.invariant && rule.contextual) {
        if (value.status !== 'optional' || !value.condition) {
          add(
            'contextual_invariant_bypass_forbidden',
            `${path}.status`,
            `Contextual invariant ${ruleId} must use its declared condition.`,
          );
        }
      }

      if (value.condition !== undefined) {
        if (value.status !== 'optional') {
          add('condition_status_invalid', `${path}.condition`, 'Conditional rules must use optional status.');
        }
        const template = conditionTemplate(ruleId);
        if (!template || !sameJson(value.condition, template)) {
          add(
            'condition_invalid',
            `${path}.condition`,
            `Rule ${ruleId} does not use its canonical deterministic condition.`,
          );
        }
      }
    }

    if (isPlainObject(contract.capabilities)) {
      for (const [ruleId, capability] of Object.entries(PRIMARY_RULE_CAPABILITIES)) {
        const value = contract.rules[ruleId];
        if (!isPlainObject(value) || !UI_RULE_STATUSES.includes(value.status)) continue;
        const enabled = contract.capabilities[capability] === true;
        if (value.status === 'required' && !enabled) {
          add(
            'capability_activation_required',
            `capabilities.${capability}`,
            `${ruleId} is required, so capability ${capability} must be true.`,
          );
        }
        if (['not_applicable', 'waived'].includes(value.status) && enabled) {
          add(
            'capability_status_conflict',
            `capabilities.${capability}`,
            `${ruleId} is ${value.status}, so capability ${capability} must be false.`,
          );
        }
      }

      if (
        configuredRuleIsActive(contract, 'data_table.advanced_controls') &&
        !configuredRuleIsActive(contract, 'components.data_table')
      ) {
        add(
          'advanced_table_requires_base',
          'rules.data_table.advanced_controls',
          'Advanced table controls require an active DataTable.',
        );
      }

      if (configuredRuleIsActive(contract, 'components.kanban') && contract.capabilities.dragAndDrop !== true) {
        add(
          'kanban_drag_required',
          'capabilities.dragAndDrop',
          'An active Kanban requires dragAndDrop so geometry and alternatives stay enforced.',
        );
      }
    }
  }

  return errors.length === 0 ? { ok: true, outcome: 'PASS', errors: [] } : { ok: false, outcome: 'FAIL', errors };
}

export class UiContractError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'UiContractError';
    this.details = details;
  }
}

function assertValidContract(contract) {
  const validation = validateUiContract(contract);
  if (!validation.ok) {
    throw new UiContractError('UI contract is invalid.', validation.errors);
  }
  return contract;
}

/**
 * Return a validated copy with one explicit capability decision applied.
 * Enabling dependent capabilities cascades upward; disabling a dependency
 * while its consumer remains enabled fails before persistence.
 */
export function updateUiCapability(contract, name, enabled) {
  assertValidContract(contract);
  if (!UI_CAPABILITY_KEYS.includes(name)) {
    throw new UiContractError(`Unknown UI capability: ${String(name)}`);
  }
  if (typeof enabled !== 'boolean') {
    throw new UiContractError('Capability enabled state must be boolean.');
  }
  if (enabled === false && name === 'dragAndDrop' && contract.capabilities.kanban === true) {
    throw new UiContractError('Cannot disable dragAndDrop while kanban is enabled. Disable kanban first.');
  }
  if (
    enabled === false &&
    name === 'dataTables' &&
    contract.capabilities.advancedDataTableControls === true
  ) {
    throw new UiContractError(
      'Cannot disable dataTables while advancedDataTableControls is enabled. Disable advancedDataTableControls first.',
    );
  }

  const updated = clone(contract);
  const changes = [];
  const setCapability = (capability, value, reason) => {
    const from = updated.capabilities[capability];
    if (from === value) return;
    updated.capabilities[capability] = value;
    changes.push({ name: capability, from, to: value, reason });
  };

  setCapability(name, enabled, 'requested');
  if (enabled === true && name === 'kanban') {
    setCapability('dragAndDrop', true, 'required_by_kanban');
  }
  if (enabled === true && name === 'advancedDataTableControls') {
    setCapability('dataTables', true, 'required_by_advancedDataTableControls');
  }

  assertValidContract(updated);
  return { contract: updated, changes };
}

function normalizeMigrationOptions(options = {}) {
  if (!isPlainObject(options)) throw new UiContractError('UI contract migration options are invalid.');
  for (const field of Object.keys(options)) {
    if (field !== 'entrypoints') throw new UiContractError(`Unknown UI contract migration option: ${field}.`);
  }
  const entrypoints = options.entrypoints ?? {};
  if (!isPlainObject(entrypoints)) throw new UiContractError('Migration entrypoints must be an object.');
  const normalized = {};
  for (const [surface, path] of Object.entries(entrypoints)) {
    if (!UI_IMPLEMENTATION_SURFACES.includes(surface)) {
      throw new UiContractError(`Unknown UI implementation surface: ${surface}`);
    }
    if (!validProjectRelativeEntrypoint(path)) {
      throw new UiContractError(`Migration entrypoint for ${surface} must be a safe project-relative path.`);
    }
    normalized[surface] = path.trim();
  }
  return { entrypoints: normalized };
}

function migrateV2Implementation(implementation, { entrypoints }) {
  if (!isPlainObject(implementation)) throw new UiContractError('Schema v2 implementation is invalid.');
  for (const field of Object.keys(implementation)) {
    if (!['default', 'surfaces'].includes(field)) {
      throw new UiContractError(`Unknown schema v2 implementation field: ${field}.`);
    }
  }
  const legacyDefault = implementation.default;
  if (!isPlainObject(legacyDefault) || legacyDefault.mode !== 'canonical') {
    throw new UiContractError(
      'Schema v2 used a non-canonical global default. Select a per-surface implementation for each intended surface before migrating.',
      [{ code: 'migration_surface_choice_required', path: 'implementation.default' }],
    );
  }
  const normalizedDefault = sameJson(legacyDefault, canonicalImplementation())
    ? canonicalImplementation()
    : normalizeImplementationSelection(legacyDefault);
  if (!sameJson(legacyDefault, normalizedDefault)) {
    throw new UiContractError('Schema v2 default implementation is invalid.');
  }

  if (!isPlainObject(implementation.surfaces)) {
    throw new UiContractError('Schema v2 implementation surfaces are invalid.');
  }
  const surfaces = {};
  const usedEntrypoints = new Set();
  for (const [surface, legacySelection] of Object.entries(implementation.surfaces)) {
    if (!UI_IMPLEMENTATION_SURFACES.includes(surface)) {
      throw new UiContractError(`Unknown UI implementation surface: ${surface}`);
    }
    let selection = legacySelection;
    if (
      isPlainObject(legacySelection) &&
      ['existing-library', 'specified-library'].includes(legacySelection.mode) &&
      !validProjectRelativeEntrypoint(legacySelection.path)
    ) {
      const suppliedEntrypoint = entrypoints[surface];
      if (!suppliedEntrypoint) {
        throw new UiContractError(
          `Schema v2 library selection for ${surface} has no concrete entrypoint. Re-record it with --path before migrating.`,
          [{ code: 'migration_entrypoint_required', path: `implementation.surfaces.${surface}.path` }],
        );
      }
      selection = { ...legacySelection, path: suppliedEntrypoint };
      usedEntrypoints.add(surface);
    }
    const normalized = normalizeImplementationSelection(selection);
    if (!sameJson(selection, normalized)) {
      throw new UiContractError(`Schema v2 implementation for ${surface} is invalid.`);
    }
    surfaces[surface] = normalized;
  }
  for (const surface of Object.keys(entrypoints)) {
    if (!usedEntrypoints.has(surface)) {
      throw new UiContractError(
        `Migration entrypoint for ${surface} is not needed by a schema v2 library selection without a path.`,
      );
    }
  }
  return { default: normalizedDefault, surfaces };
}

/**
 * Explicit schema migration. Version 1 gains the canonical fallback. Version
 * 2 migrates only unambiguous per-surface choices; a global alternate or a
 * library without a local entrypoint is never guessed into schema 3.
 */
export function migrateUiContract(contract, options = {}) {
  if (!isPlainObject(contract)) throw new UiContractError('Legacy UI contract is invalid.');
  const migrationOptions = normalizeMigrationOptions(options);
  if (contract.schemaVersion === UI_CONTRACT_SCHEMA_VERSION) {
    if (Object.keys(migrationOptions.entrypoints).length > 0) {
      throw new UiContractError('Migration entrypoints can only repair schema v2 contracts.');
    }
    return clone(assertValidContract(contract));
  }
  if (![1, 2].includes(contract.schemaVersion)) {
    throw new UiContractError(`Cannot migrate UI contract schema ${String(contract.schemaVersion)}.`);
  }

  if (contract.schemaVersion === 1 && 'implementation' in contract) {
    throw new UiContractError('Schema v1 must not contain an implementation decision.');
  }
  if (contract.schemaVersion !== 2 && Object.keys(migrationOptions.entrypoints).length > 0) {
    throw new UiContractError('Migration entrypoints can only repair schema v2 contracts.');
  }

  const migrated = {
    ...clone(contract),
    schemaVersion: UI_CONTRACT_SCHEMA_VERSION,
    implementation:
      contract.schemaVersion === 1
        ? selectUiImplementations()
        : migrateV2Implementation(contract.implementation, migrationOptions),
  };
  const validation = validateUiContract(migrated);
  if (!validation.ok) {
    throw new UiContractError('Legacy UI contract is invalid.', validation.errors);
  }
  return migrated;
}

function resolveCondition(contract, condition, context) {
  if (condition.kind === 'capability_enabled') {
    return contract.capabilities[condition.capability] ? condition.whenMet : condition.whenNotMet;
  }
  if (condition.kind === 'route_depth_greater_than') {
    if (!Number.isInteger(context.routeDepth) || context.routeDepth < 0) {
      return condition.whenUnknown;
    }
    return context.routeDepth > condition.value ? condition.whenMet : condition.whenNotMet;
  }
  // Validation prevents this branch. Keeping it required is the fail-closed
  // fallback if this function is ever called independently in the future.
  return { status: 'required', reason: 'quality_floor' };
}

function resolveRuleApplicabilityUnchecked(contract, ruleId, context) {
  const configured = contract.rules[ruleId];
  const capability = UI_RULE_CAPABILITIES[ruleId];
  const dormant = configured.status === 'optional' && capability && contract.capabilities[capability] !== true;
  const resolved =
    configured.condition && !dormant ? resolveCondition(contract, configured.condition, context) : configured;
  const applicable =
    resolved.status === 'required' ||
    (resolved.status === 'optional' && capability && contract.capabilities[capability] === true);
  return {
    ruleId,
    status: resolved.status,
    reason: resolved.reason,
    applicable,
    label: applicable ? 'APPLY' : 'SKIP',
  };
}

/**
 * Resolve applicability without pretending compliance has already been
 * proved. Gates use APPLY/SKIP from this API; PASS remains an evidence verdict.
 */
export function resolveUiRuleApplicability(contract, ruleId, context = {}) {
  assertValidContract(contract);
  if (!(ruleId in UI_RULES)) throw new UiContractError(`Unknown UI rule: ${ruleId}`);
  return resolveRuleApplicabilityUnchecked(contract, ruleId, context);
}

/** Resolve the selected implementation for a named UI surface. */
export function resolveUiImplementation(contract, surface) {
  assertValidContract(contract);
  if (!UI_IMPLEMENTATION_SURFACES.includes(surface)) {
    throw new UiContractError(`Unknown UI implementation surface: ${surface}`);
  }
  const selection = contract.implementation.surfaces[surface] ?? contract.implementation.default;
  return clone({ surface, ...selection, isCanonical: selection.mode === 'canonical' });
}

function selectedPackageName(value) {
  const text = String(value ?? '');
  if (text.startsWith('@')) {
    const versionAt = text.indexOf('@', 1);
    return versionAt === -1 ? text : text.slice(0, versionAt);
  }
  const versionAt = text.lastIndexOf('@');
  return versionAt > 0 ? text.slice(0, versionAt) : text;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function registryCell(value) {
  const text = String(value ?? '').trim();
  return text.startsWith('`') && text.endsWith('`') ? text.slice(1, -1).trim() : text;
}

function registryRows(markdown) {
  const lines = String(markdown).split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === '<!-- registry:start -->');
  const end = lines.findIndex((line, index) => index > start && line.trim() === '<!-- registry:end -->');
  if (start === -1 || end === -1) return null;
  return lines.slice(start + 1, end).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return [];
    const cells = trimmed
      .slice(1, -1)
      .split('|')
      .map(registryCell);
    return cells.length === 9 ? [{ line: trimmed, cells }] : [];
  });
}

function withinRoot(root, path) {
  return path === root || path.startsWith(`${root}${sep}`);
}

/**
 * Inspect the current local proof for one non-canonical implementation.
 * A package declaration alone is deliberately insufficient: every selected
 * surface resolves through one non-empty project entrypoint and one installed
 * registry row, both hashed into the kit receipt.
 */
export function inspectUiImplementationMaterialization(repoRoot, selected) {
  const root = resolve(repoRoot);
  const result = {
    surface: selected?.surface ?? null,
    mode: selected?.mode ?? null,
    ...(selected?.package ? { package: selected.package } : {}),
    path: selected?.path ?? null,
    status: 'pending',
    errors: [],
  };
  const add = (code, fields = {}) => result.errors.push({ code, ...fields });

  if (!selected || !['existing-library', 'specified-library', 'custom'].includes(selected.mode)) {
    add('alternate_selection_invalid');
    return result;
  }
  if (!validProjectRelativeEntrypoint(selected.path)) {
    add('alternate_entrypoint_unsafe', { path: selected.path ?? null });
    return result;
  }

  const entrypoint = resolve(root, selected.path);
  try {
    if (!withinRoot(root, entrypoint) || !existsSync(entrypoint) || !statSync(entrypoint).isFile()) {
      add('alternate_entrypoint_missing', { path: selected.path });
    } else {
      const realRoot = realpathSync(root);
      const realEntrypoint = realpathSync(entrypoint);
      if (!withinRoot(realRoot, realEntrypoint)) {
        add('alternate_entrypoint_unsafe', { path: selected.path });
      } else {
        const source = readFileSync(entrypoint);
        if (source.toString('utf8').trim() === '') {
          add('alternate_entrypoint_empty', { path: selected.path });
        } else {
          result.entrypoint = { path: selected.path, sha256: sha256(source) };
        }
      }
    }
  } catch {
    add('alternate_entrypoint_unreadable', { path: selected.path });
  }

  if (selected.mode !== 'custom') {
    const name = selectedPackageName(selected.package);
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      const range = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
      if (typeof range !== 'string' || range.trim() === '') {
        add('alternate_package_missing', { package: name });
      } else {
        result.dependency = { name, range };
      }
    } catch {
      add('alternate_package_manifest_invalid', { path: 'package.json', package: name });
    }
  }

  const registryPath = join(root, UI_COMPONENT_REGISTRY_RELATIVE_PATH);
  try {
    const markdown = readFileSync(registryPath, 'utf8');
    const rows = registryRows(markdown);
    if (!rows) {
      add('alternate_registry_markers_missing', { path: UI_COMPONENT_REGISTRY_RELATIVE_PATH });
    } else {
      const matches = rows.filter(({ cells }) => cells[3] === selected.path);
      if (matches.length !== 1) {
        add(matches.length ? 'alternate_registry_row_ambiguous' : 'alternate_registry_row_missing', {
          path: UI_COMPONENT_REGISTRY_RELATIVE_PATH,
          entrypoint: selected.path,
        });
      } else {
        const [{ line, cells }] = matches;
        if (cells[6] !== 'installed') {
          add('alternate_registry_not_installed', { entrypoint: selected.path, actual: cells[6] });
        }
        if (!['default', '—'].includes(cells[7])) {
          add('alternate_registry_role_invalid', { entrypoint: selected.path, actual: cells[7] });
        }
        result.registry = {
          path: UI_COMPONENT_REGISTRY_RELATIVE_PATH.replaceAll('\\', '/'),
          rowSha256: sha256(line),
        };
      }
    }
  } catch {
    add('alternate_registry_missing', { path: UI_COMPONENT_REGISTRY_RELATIVE_PATH });
  }

  if (result.errors.length === 0) result.status = 'verified';
  return result;
}

/**
 * Resolve one rule to required|optional|not_applicable|waived and attach a
 * deterministic PASS|SKIP|FAIL outcome. Required rules fail unless the caller
 * provides explicit `{ compliant: true }` evidence.
 */
export function evaluateUiRule(contract, ruleId, context = {}) {
  assertValidContract(contract);
  if (!(ruleId in UI_RULES)) throw new UiContractError(`Unknown UI rule: ${ruleId}`);
  const decision = resolveRuleApplicabilityUnchecked(contract, ruleId, context);
  return {
    ruleId,
    status: decision.status,
    reason: decision.reason,
    outcome: decision.applicable ? (context.compliant === true ? 'PASS' : 'FAIL') : 'SKIP',
  };
}

/** Evaluate every rule. Context is keyed by rule id. */
export function evaluateUiContract(contract, context = {}) {
  assertValidContract(contract);
  const results = Object.keys(UI_RULES).map((ruleId) => evaluateUiRule(contract, ruleId, context[ruleId] ?? {}));
  const outcome = results.some((result) => result.outcome === 'FAIL')
    ? 'FAIL'
    : results.some((result) => result.outcome === 'PASS')
      ? 'PASS'
      : 'SKIP';
  return { outcome, results };
}

function contractPath(repoRoot) {
  return join(resolve(repoRoot), UI_CONTRACT_RELATIVE_PATH);
}

/** Read and validate ai-docs/ui/contract.json. Existing invalid files throw. */
export function loadUiContract(repoRoot, { required = false } = {}) {
  const path = contractPath(repoRoot);
  if (!existsSync(path)) {
    if (required) throw new UiContractError(`UI contract not found: ${path}`);
    return null;
  }

  let contract;
  try {
    contract = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new UiContractError(`UI contract is not valid JSON: ${path}`, [
      validationError('json_invalid', UI_CONTRACT_RELATIVE_PATH, error.message),
    ]);
  }
  return assertValidContract(contract);
}

/** Explicit persistence API. It never overwrites unless `overwrite` is true. */
export function saveUiContract(repoRoot, contract, { overwrite = false } = {}) {
  assertValidContract(contract);
  const path = contractPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  const serialized = `${JSON.stringify(contract, null, 2)}\n`;
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    if (overwrite) {
      writeFileSync(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx' });
      renameSync(temporaryPath, path);
    } else {
      writeFileSync(path, serialized, { encoding: 'utf8', flag: 'wx' });
    }
  } catch (error) {
    if (overwrite && existsSync(temporaryPath)) unlinkSync(temporaryPath);
    if (error?.code === 'EEXIST') {
      throw new UiContractError(
        overwrite
          ? `Temporary UI contract write already exists: ${temporaryPath}`
          : `UI contract already exists: ${path}`,
      );
    }
    throw error;
  }
  return path;
}

function option(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index !== -1 && argv[index + 1] ? argv[index + 1] : fallback;
}

function migrationEntrypointsFromOptions(argv) {
  const entrypoints = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--entrypoint') continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new UiContractError('--entrypoint requires <surface=project-relative-path>.');
    }
    const separator = value.indexOf('=');
    const surface = separator === -1 ? '' : value.slice(0, separator);
    const path = separator === -1 ? '' : value.slice(separator + 1);
    if (!UI_IMPLEMENTATION_SURFACES.includes(surface) || !validProjectRelativeEntrypoint(path)) {
      throw new UiContractError(`Invalid migration entrypoint: ${value}. Expected <surface=project-relative-path>.`);
    }
    if (Object.hasOwn(entrypoints, surface)) {
      throw new UiContractError(`Duplicate migration entrypoint for ${surface}.`);
    }
    entrypoints[surface] = path.trim();
    index += 1;
  }
  return entrypoints;
}

function implementationChoiceFromOptions(argv) {
  const mode = option(argv, '--implementation-mode');
  if (!mode) return undefined;
  const selection = { mode };
  const packageName = option(argv, '--implementation-package');
  const path = option(argv, '--implementation-path');
  if (packageName) selection.package = packageName;
  if (path) selection.path = path;
  return { default: selection };
}

function usage() {
  return [
    'Deterministic UI contract',
    '',
    'Commands:',
    '  print    --profile <profile> [implementation options] [--json]',
    '  init     --profile <profile> [implementation options] [--dir <path>] [--force] [--json]',
    '  migrate  [--entrypoint <surface=project-relative-path> ...] [--dir <path>] [--json]',
    '  capability --name <capability> --enabled <true|false> [--dir <path>] [--json]',
    '  implementation --surface <surface|default> --mode <mode> [--package <name>] [--path <entrypoint>] [--dir <path>] [--json]',
    '  check    [--dir <path>] [--json]',
    '  evaluate [--dir <path>] [--context <json-file>] [--json]',
    '',
    `Profiles: ${UI_PROFILES.join(', ')}`,
    `Capabilities: ${UI_CAPABILITY_KEYS.join(', ')}`,
    `Implementation modes: ${UI_IMPLEMENTATION_MODES.join(', ')}`,
    'Init/print default option: --implementation-mode canonical (non-canonical choices are per-surface only)',
  ].join('\n');
}

function printResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if ('results' in value) {
    for (const result of value.results) {
      console.log(`${result.outcome} ${result.ruleId} ${result.status} (${result.reason})`);
    }
    console.log(`${value.outcome} ui-contract`);
    return;
  }
  console.log(`${value.outcome} ui-contract`);
}

function cli(argv) {
  const [command] = argv;
  const asJson = argv.includes('--json');
  const root = resolve(option(argv, '--dir', process.cwd()));

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(usage());
    return 0;
  }

  if (command === 'print') {
    const profile = option(argv, '--profile');
    if (!profile) throw new UiContractError('print requires --profile.');
    console.log(
      JSON.stringify(defaultContract(profile, { implementation: implementationChoiceFromOptions(argv) }), null, 2),
    );
    return 0;
  }

  if (command === 'init') {
    const profile = option(argv, '--profile');
    if (!profile) throw new UiContractError('init requires --profile.');
    const contract = defaultContract(profile, { implementation: implementationChoiceFromOptions(argv) });
    const path = saveUiContract(root, contract, { overwrite: argv.includes('--force') });
    const result = { outcome: 'PASS', profile, path };
    printResult(result, asJson);
    return 0;
  }

  if (command === 'migrate') {
    const path = contractPath(root);
    if (!existsSync(path)) throw new UiContractError(`UI contract not found: ${path}`);
    let legacy;
    try {
      legacy = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new UiContractError(`UI contract is not valid JSON: ${path}`, [
        validationError('json_invalid', UI_CONTRACT_RELATIVE_PATH, error.message),
      ]);
    }
    const fromSchemaVersion = legacy.schemaVersion;
    const migrated = migrateUiContract(legacy, { entrypoints: migrationEntrypointsFromOptions(argv) });
    saveUiContract(root, migrated, { overwrite: true });
    printResult(
      {
        outcome: 'PASS',
        fromSchemaVersion,
        schemaVersion: migrated.schemaVersion,
        path,
      },
      asJson,
    );
    return 0;
  }

  if (command === 'capability') {
    const name = option(argv, '--name');
    const enabledValue = option(argv, '--enabled');
    if (!name) throw new UiContractError('capability requires --name.');
    if (!['true', 'false'].includes(enabledValue)) {
      throw new UiContractError('capability requires --enabled true|false.');
    }

    const current = loadUiContract(root, { required: true });
    const { contract, changes } = updateUiCapability(current, name, enabledValue === 'true');
    const path = saveUiContract(root, contract, { overwrite: true });
    printResult(
      {
        outcome: 'PASS',
        path,
        capability: { name, enabled: enabledValue === 'true' },
        changes,
      },
      asJson,
    );
    return 0;
  }

  if (command === 'implementation') {
    const surface = option(argv, '--surface');
    const mode = option(argv, '--mode');
    if (!surface) throw new UiContractError('implementation requires --surface.');
    if (!mode) throw new UiContractError('implementation requires --mode.');
    if (surface !== 'default' && !UI_IMPLEMENTATION_SURFACES.includes(surface)) {
      throw new UiContractError(`Unknown UI implementation surface: ${surface}`);
    }

    const choice = { mode };
    const packageName = option(argv, '--package');
    const pathValue = option(argv, '--path');
    if (packageName) choice.package = packageName;
    if (pathValue) choice.path = pathValue;
    const selection = normalizeImplementationSelection(choice);
    if (surface === 'default' && selection.mode !== 'canonical') {
      throw new UiContractError('A non-canonical UI implementation must be selected per-surface.');
    }
    const contract = clone(loadUiContract(root, { required: true }));
    if (surface === 'default') contract.implementation.default = selection;
    else contract.implementation.surfaces[surface] = selection;
    assertValidContract(contract);
    const path = saveUiContract(root, contract, { overwrite: true });
    const implementation =
      surface === 'default'
        ? { surface: 'default', ...contract.implementation.default, isCanonical: selection.mode === 'canonical' }
        : resolveUiImplementation(contract, surface);
    printResult({ outcome: 'PASS', path, implementation }, asJson);
    return 0;
  }

  if (command === 'check') {
    const contract = loadUiContract(root, { required: true });
    const validation = validateUiContract(contract);
    const result = {
      outcome: validation.outcome,
      valid: validation.ok,
      errors: validation.errors,
    };
    printResult(result, asJson);
    return validation.ok ? 0 : 1;
  }

  if (command === 'evaluate') {
    const contract = loadUiContract(root, { required: true });
    const contextPath = option(argv, '--context');
    const context = contextPath ? JSON.parse(readFileSync(resolve(contextPath), 'utf8')) : {};
    const result = evaluateUiContract(contract, context);
    printResult(result, asJson);
    return result.outcome === 'FAIL' ? 1 : 0;
  }

  throw new UiContractError(`Unknown command: ${command}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    process.exitCode = cli(process.argv.slice(2));
  } catch (error) {
    const payload = {
      outcome: 'FAIL',
      error: error.message,
      details: error.details ?? [],
    };
    if (process.argv.includes('--json')) console.error(JSON.stringify(payload, null, 2));
    else console.error(`FAIL ui-contract: ${error.message}`);
    process.exitCode = 1;
  }
}
