/**
 * Deterministic verification of the executable canonical UI-kit receipt.
 * Registry prose is not evidence: this module resolves the active contract
 * selections and hashes every canonical file against the shipped manifest.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  inspectUiImplementationMaterialization,
  resolveUiImplementation,
} from '../scripts/ui-contract.mjs';

export const UI_KIT_RECEIPT_SCHEMA_VERSION = 2;

export const UI_KIT_RECEIPT_RELATIVE_PATH = join('ai-docs', 'ui', 'kit-receipt.json');
export const UI_KIT_MANIFEST_RELATIVE_PATH = join('assets', 'canonical-next-shadcn', 'manifest.json');

const SURFACES = Object.freeze({
  app_shell: ['shell.app_shell', 'appShell'],
  breadcrumb: ['navigation.breadcrumb', 'hierarchicalNavigation'],
  theme: ['theme.user_switcher', 'userThemePreference'],
  data_table: ['components.data_table', 'dataTables'],
  kanban: ['components.kanban', 'kanban'],
});

function json(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function active(contract, ruleId, capability) {
  const rule = contract.rules?.[ruleId];
  return rule?.status === 'required' || (rule?.status === 'optional' && contract.capabilities?.[capability] === true);
}

export function expectedUiKitResolution(contract) {
  const canonical = [];
  const alternate = [];
  for (const [surface, [ruleId, capability]] of Object.entries(SURFACES)) {
    if (!active(contract, ruleId, capability)) continue;
    const selected = resolveUiImplementation(contract, surface);
    if (selected.isCanonical) canonical.push(surface);
    else {
      const { isCanonical: _ignored, ...evidence } = selected;
      alternate.push({ surface, ...evidence });
    }
  }
  return { canonical, alternate, required: canonical.length + alternate.length > 0 };
}

function manifestCandidates(root) {
  return [
    join(root, '.agents', 'skills', 'design-system', UI_KIT_MANIFEST_RELATIVE_PATH),
    join(root, '.claude', 'skills', 'design-system', UI_KIT_MANIFEST_RELATIVE_PATH),
    join(root, '.cursor', 'skills', 'design-system', UI_KIT_MANIFEST_RELATIVE_PATH),
  ];
}

function sameMembers(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function safeDestination(root, sourceRoot, destination) {
  if (typeof sourceRoot !== 'string' || typeof destination !== 'string') return null;
  if (isAbsolute(sourceRoot) || isAbsolute(destination)) return null;
  const base = resolve(root, sourceRoot || '.');
  const path = resolve(base, destination);
  return path === base || path.startsWith(`${base}${sep}`) ? path : null;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function firstVersion(range) {
  const match = String(range).match(/(?:^|[^0-9])(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return match ? { major: Number(match[1]), minor: Number(match[2] ?? 0) } : null;
}

function dependencyRangesCompatible(current, required) {
  if (current === required || current === '*' || required === '*') return true;
  const have = firstVersion(current);
  if (!have) return false;
  return String(required)
    .split('||')
    .map((part) => part.trim())
    .some((part) => {
      const need = firstVersion(part);
      if (!need) return false;
      const upper = /<\s*(\d+)(?:\.(\d+))?/.exec(part);
      if (/^>=\s*/.test(part)) {
        const atLeast = have.major > need.major || (have.major === need.major && have.minor >= need.minor);
        const belowUpper =
          !upper ||
          have.major < Number(upper[1]) ||
          (have.major === Number(upper[1]) && have.minor < Number(upper[2] ?? 0));
        return atLeast && belowUpper;
      }
      if (need.major === 0 || have.major === 0) {
        return have.major === need.major && have.minor === need.minor;
      }
      return have.major === need.major;
    });
}

/**
 * Read-only, fail-closed receipt check used by close-out and launch gates.
 * Returns structured errors; it never mutates or throws on malformed files.
 */
export function verifyUiKitReceipt(root, contract) {
  const projectRoot = resolve(root);
  let expected;
  try {
    expected = expectedUiKitResolution(contract);
  } catch (error) {
    return {
      ok: false,
      outcome: 'fail',
      required: true,
      canonical: [],
      alternate: [],
      errors: [{ code: 'contract_implementation_invalid', message: error.message }],
    };
  }
  if (!expected.required) {
    return { ok: true, outcome: 'skip', ...expected, errors: [] };
  }

  const receiptPath = join(projectRoot, UI_KIT_RECEIPT_RELATIVE_PATH);
  const receipt = json(receiptPath);
  const pkg = json(join(projectRoot, 'package.json')) ?? {};
  const errors = [];
  if (!receipt) {
    return {
      ok: false,
      outcome: 'fail',
      ...expected,
      receiptPath,
      errors: [{ code: 'receipt_missing', path: UI_KIT_RECEIPT_RELATIVE_PATH }],
    };
  }

  if (receipt.schemaVersion !== UI_KIT_RECEIPT_SCHEMA_VERSION) {
    errors.push({
      code: 'receipt_schema_invalid',
      path: UI_KIT_RECEIPT_RELATIVE_PATH,
      expected: UI_KIT_RECEIPT_SCHEMA_VERSION,
      actual: receipt.schemaVersion ?? null,
      recovery: 'Run `node .agents/scripts/ui-kit.mjs verify --target . --json` to regenerate the receipt.',
    });
  }
  if (receipt.target !== '.') {
    errors.push({
      code: 'receipt_target_stale',
      path: UI_KIT_RECEIPT_RELATIVE_PATH,
      expected: '.',
      actual: receipt.target ?? null,
    });
  }

  if (!sameMembers(receipt.surfaces ?? [], expected.canonical)) {
    errors.push({
      code: 'receipt_surfaces_stale',
      path: UI_KIT_RECEIPT_RELATIVE_PATH,
      expected: expected.canonical,
      actual: receipt.surfaces ?? null,
    });
  }
  const skipped = Array.isArray(receipt.skipped) ? receipt.skipped : [];
  const alternateVerification = Array.isArray(receipt.alternateVerification) ? receipt.alternateVerification : [];
  for (const selected of expected.alternate) {
    const recorded = skipped.find((item) => item?.surface === selected.surface);
    if (!recorded || recorded.mode !== selected.mode) {
      errors.push({
        code: 'alternate_skip_missing',
        path: UI_KIT_RECEIPT_RELATIVE_PATH,
        surface: selected.surface,
        expected: selected,
        actual: recorded ?? null,
      });
      continue;
    }
    for (const field of ['package', 'path', 'preset']) {
      if (selected[field] !== undefined && recorded[field] !== selected[field]) {
        errors.push({
          code: 'alternate_skip_stale',
          path: UI_KIT_RECEIPT_RELATIVE_PATH,
          surface: selected.surface,
          field,
          expected: selected[field],
          actual: recorded[field],
        });
      }
    }
    const verification = alternateVerification.find((item) => item?.surface === selected.surface);
    if (!verification || verification.status !== 'verified') {
      errors.push({
        code: 'alternate_not_verified',
        path: UI_KIT_RECEIPT_RELATIVE_PATH,
        surface: selected.surface,
        actual: verification ?? null,
      });
      continue;
    }

    for (const field of ['mode', 'package', 'path']) {
      if ((verification[field] ?? null) !== (selected[field] ?? null)) {
        errors.push({
          code: 'alternate_verification_stale',
          surface: selected.surface,
          field,
          expected: selected[field] ?? null,
          actual: verification[field] ?? null,
        });
      }
    }
    const current = inspectUiImplementationMaterialization(projectRoot, selected);
    if (current.status !== 'verified') {
      for (const detail of current.errors) {
        errors.push({ code: 'alternate_current_invalid', surface: selected.surface, ...detail });
      }
      continue;
    }
    for (const field of ['entrypoint', 'registry', 'dependency']) {
      if (JSON.stringify(verification[field] ?? null) !== JSON.stringify(current[field] ?? null)) {
        errors.push({
          code: 'alternate_evidence_stale',
          surface: selected.surface,
          field,
          expected: current[field] ?? null,
          actual: verification[field] ?? null,
        });
      }
    }
  }

  if (receipt.verificationStatus !== 'verified') {
    errors.push({
      code: 'receipt_not_verified',
      path: UI_KIT_RECEIPT_RELATIVE_PATH,
      actual: receipt.verificationStatus ?? null,
    });
  }

  let manifestPath = manifestCandidates(projectRoot).find(existsSync) ?? null;
  const manifest = manifestPath ? json(manifestPath) : null;
  if (expected.canonical.length && !manifest) {
    errors.push({
      code: 'canonical_manifest_missing',
      path: manifestCandidates(projectRoot).map((path) => relative(projectRoot, path).replaceAll('\\', '/')),
    });
  }

  if (manifest) {
    const manifestPreset = manifest.preset ?? manifest.id;
    const manifestVersion = manifest.presetVersion ?? manifest.version;
    if (manifestPreset && receipt.preset !== manifestPreset) {
      errors.push({ code: 'receipt_preset_stale', expected: manifestPreset, actual: receipt.preset });
    }
    if (manifestVersion && receipt.presetVersion !== manifestVersion) {
      errors.push({ code: 'receipt_version_stale', expected: manifestVersion, actual: receipt.presetVersion });
    }
    const manifestSha256 = sha256(manifestPath);
    const recordedManifestSha256 = receipt.manifestSha256 ?? receipt.manifest?.sha256;
    if (recordedManifestSha256 && recordedManifestSha256 !== manifestSha256) {
      errors.push({
        code: 'receipt_manifest_stale',
        field: 'sha256',
        expected: manifestSha256,
        actual: recordedManifestSha256,
      });
    }
    const manifestId = manifest.id ?? manifest.preset;
    const recordedManifestId = receipt.manifestId ?? receipt.manifest?.id;
    if (recordedManifestId && recordedManifestId !== manifestId) {
      errors.push({
        code: 'receipt_manifest_stale',
        field: 'id',
        expected: manifestId,
        actual: recordedManifestId,
      });
    }
    const sourceRoot = receipt.sourceRoot ?? '.';
    const manifestFiles = Array.isArray(manifest.files) ? manifest.files : [];
    for (const surface of expected.canonical) {
      if (!manifestFiles.some((file) => Array.isArray(file?.surfaces) && file.surfaces.includes(surface))) {
        errors.push({ code: 'manifest_surface_missing', surface });
      }
    }
    for (const file of manifestFiles) {
      if (!Array.isArray(file?.surfaces) || !file.surfaces.some((surface) => expected.canonical.includes(surface))) {
        continue;
      }
      const destination = safeDestination(projectRoot, sourceRoot, file.destination);
      if (!destination) {
        errors.push({ code: 'destination_unsafe', path: file.destination ?? null });
      } else if (!existsSync(destination)) {
        errors.push({ code: 'canonical_file_missing', path: relative(projectRoot, destination).replaceAll('\\', '/') });
      } else {
        try {
          if (typeof file.sha256 !== 'string' || sha256(destination) !== file.sha256) {
            errors.push({
              code: 'canonical_file_stale',
              path: relative(projectRoot, destination).replaceAll('\\', '/'),
            });
          }
        } catch {
          errors.push({
            code: 'canonical_file_unreadable',
            path: relative(projectRoot, destination).replaceAll('\\', '/'),
          });
        }
      }
    }

    const resources = [
      ...(Array.isArray(manifest.dependencies) ? manifest.dependencies : []),
      ...(Array.isArray(manifest.peerDependencies) ? manifest.peerDependencies : []),
    ];
    const requiredPackages = new Map();
    for (const resource of resources) {
      if (
        Array.isArray(resource?.surfaces) &&
        resource.surfaces.some((surface) => expected.canonical.includes(surface)) &&
        typeof resource.name === 'string' &&
        typeof resource.range === 'string'
      ) {
        requiredPackages.set(resource.name, resource.range);
      }
    }
    for (const [name, range] of requiredPackages) {
      const declared = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? pkg.peerDependencies?.[name];
      if (!declared) {
        errors.push({ code: 'canonical_dependency_missing', package: name, expected: range });
      } else if (!dependencyRangesCompatible(declared, range)) {
        errors.push({
          code: 'canonical_dependency_incompatible',
          package: name,
          expected: range,
          actual: declared,
        });
      }
    }
  }

  manifestPath = manifestPath ? relative(projectRoot, manifestPath).replaceAll('\\', '/') : null;
  return {
    ok: errors.length === 0,
    outcome: errors.length === 0 ? 'pass' : 'fail',
    ...expected,
    receiptPath: UI_KIT_RECEIPT_RELATIVE_PATH,
    manifestPath,
    errors,
  };
}
