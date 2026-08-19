import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  defaultContract,
  inspectUiImplementationMaterialization,
} from '../fia-templates/scripts/ui-contract.mjs';
import { expectedUiKitResolution, verifyUiKitReceipt } from '../fia-templates/modules/ui-kit-receipt.mjs';

function write(root, rel, body) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function registry(root, entries) {
  write(
    root,
    'ai-docs/components/registry.md',
    [
      '# Registry',
      '<!-- registry:start -->',
      ...entries.map(
        ({ name, path }) => `| ${name} | data | project | ${path} | — | — | installed | default | selected |`,
      ),
      '<!-- registry:end -->',
      '',
    ].join('\n'),
  );
}

function fixture(contract) {
  const root = mkdtempSync(join(tmpdir(), 'ui-kit-receipt-'));
  const source = 'export function DataTable() { return null; }\n';
  const selected = expectedUiKitResolution(contract).canonical;
  write(root, 'src/components/canonical/data-table.tsx', source);
  write(root, 'package.json', `${JSON.stringify({ dependencies: { 'lucide-react': '^0.544.0' } }, null, 2)}\n`);
  write(
    root,
    '.claude/skills/design-system/assets/canonical-next-shadcn/manifest.json',
    `${JSON.stringify(
      {
        schemaVersion: 1,
        preset: 'fia-universal',
        presetVersion: '1.0.0',
        dependencies: [{ name: 'lucide-react', range: '^0.544.0', surfaces: selected }],
        files: [
          {
            source: 'src/data-table.tsx',
            destination: 'components/canonical/data-table.tsx',
            surfaces: selected,
            sha256: sha(source),
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

test('expected receipt resolution records explicit alternate/custom choices as skips', () => {
  const contract = defaultContract('enterprise-admin', {
    implementation: {
      surfaces: {
        data_table: {
          mode: 'specified-library',
          package: '@acme/grid',
          path: 'src/data/acme-grid.tsx',
          reason: 'user_explicit_specified_library',
        },
      },
    },
  });
  const value = expectedUiKitResolution(contract);
  assert.equal(value.canonical.includes('data_table'), false);
  assert.deepEqual(value.alternate, [
    {
      surface: 'data_table',
      mode: 'specified-library',
      package: '@acme/grid',
      path: 'src/data/acme-grid.tsx',
      reason: 'user_explicit_specified_library',
    },
  ]);
});

test('receipt verification hashes canonical source; registry text cannot make missing/stale source pass', () => {
  const contract = defaultContract('enterprise-admin');
  const root = fixture(contract);
  let value = verifyUiKitReceipt(root, contract);
  assert.equal(value.ok, false);
  assert.equal(value.errors[0].code, 'receipt_missing');

  // Even a registry claiming "installed" is irrelevant to the receipt gate.
  write(
    root,
    'ai-docs/components/registry.md',
    '| DataTable | data | canonical | src/components/canonical/data-table.tsx | — | — | installed | — | all tables |\n',
  );
  value = verifyUiKitReceipt(root, contract);
  assert.equal(value.ok, false);

  const expected = expectedUiKitResolution(contract);
  write(
    root,
    'ai-docs/ui/kit-receipt.json',
    `${JSON.stringify({ schemaVersion: 2, target: '.', surfaces: 'not-an-array', skipped: 'bad' })}\n`,
  );
  assert.doesNotThrow(() => verifyUiKitReceipt(root, contract));
  assert.equal(verifyUiKitReceipt(root, contract).ok, false, 'malformed receipt evidence must fail closed');

  write(
    root,
    'ai-docs/ui/kit-receipt.json',
    `${JSON.stringify(
      {
        schemaVersion: 2,
        target: '.',
        preset: 'fia-universal',
        presetVersion: '1.0.0',
        sourceRoot: 'src',
        surfaces: expected.canonical,
        skipped: [],
        alternateVerification: [],
        verificationStatus: 'verified',
      },
      null,
      2,
    )}\n`,
  );
  const receiptPath = join(root, 'ai-docs', 'ui', 'kit-receipt.json');
  assert.equal(verifyUiKitReceipt(root, contract).ok, true);

  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  receipt.schemaVersion = 1;
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  value = verifyUiKitReceipt(root, contract);
  assert.ok(value.errors.some((error) => error.code === 'receipt_schema_invalid'));
  receipt.schemaVersion = 2;
  receipt.manifestSha256 = '0'.repeat(64);
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  value = verifyUiKitReceipt(root, contract);
  assert.ok(value.errors.some((error) => error.code === 'receipt_manifest_stale'));
  delete receipt.manifestSha256;
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ dependencies: {} }, null, 2)}\n`);
  value = verifyUiKitReceipt(root, contract);
  assert.ok(
    value.errors.some((error) => error.code === 'canonical_dependency_missing' && error.package === 'lucide-react'),
    'a dependency removed after receipt must invalidate completion',
  );
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ dependencies: { 'lucide-react': '^0.544.0' } }, null, 2)}\n`,
  );

  write(root, 'src/components/canonical/data-table.tsx', '// locally drifted\n');
  value = verifyUiKitReceipt(root, contract);
  assert.equal(value.ok, false);
  assert.ok(value.errors.some((error) => error.code === 'canonical_file_stale'));
});

test('receipt verification accepts an explicit alternate only when the exact package/path evidence is recorded', () => {
  const contract = defaultContract('enterprise-admin', {
    implementation: {
      surfaces: {
        data_table: {
          mode: 'specified-library',
          package: '@acme/grid',
          path: 'src/data/acme-grid.tsx',
          reason: 'user_explicit_specified_library',
        },
        theme: {
          mode: 'custom',
          path: 'src/theme/custom-provider.tsx',
          reason: 'user_explicit_custom',
        },
      },
    },
  });
  const root = fixture(contract);
  const expected = expectedUiKitResolution(contract);
  write(
    root,
    'package.json',
    `${JSON.stringify({ dependencies: { '@acme/grid': '^1.0.0', 'lucide-react': '^0.544.0' } }, null, 2)}\n`,
  );
  write(root, 'src/data/acme-grid.tsx', 'export function AcmeGrid() { return null; }\n');
  write(root, 'src/theme/custom-provider.tsx', 'export function CustomTheme() { return null; }\n');
  registry(root, [
    { name: 'AcmeGrid', path: 'src/data/acme-grid.tsx' },
    { name: 'CustomTheme', path: 'src/theme/custom-provider.tsx' },
  ]);
  write(
    root,
    'ai-docs/ui/kit-receipt.json',
    `${JSON.stringify(
      {
        schemaVersion: 2,
        target: '.',
        preset: 'fia-universal',
        presetVersion: '1.0.0',
        sourceRoot: 'src',
        surfaces: expected.canonical,
        skipped: [{ surface: 'data_table', mode: 'specified-library', package: '@wrong/grid' }],
        alternateVerification: expected.alternate.map((item) =>
          inspectUiImplementationMaterialization(root, item),
        ),
        verificationStatus: 'verified',
      },
      null,
      2,
    )}\n`,
  );
  let value = verifyUiKitReceipt(root, contract);
  assert.equal(value.ok, false);
  assert.ok(value.errors.some((error) => error.code === 'alternate_skip_stale'));

  const receiptPath = join(root, 'ai-docs', 'ui', 'kit-receipt.json');
  writeFileSync(
    receiptPath,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        target: '.',
        preset: 'fia-universal',
        presetVersion: '1.0.0',
        sourceRoot: 'src',
        surfaces: expected.canonical,
        skipped: expected.alternate,
        alternateVerification: expected.alternate.map((item) =>
          inspectUiImplementationMaterialization(root, item),
        ),
        verificationStatus: 'verified',
      },
      null,
      2,
    )}\n`,
  );
  value = verifyUiKitReceipt(root, contract);
  assert.equal(value.ok, true, JSON.stringify(value.errors));

  writeFileSync(join(root, 'src', 'data', 'acme-grid.tsx'), 'export const changed = true;\n');
  value = verifyUiKitReceipt(root, contract);
  assert.ok(value.errors.some((error) => error.code === 'alternate_evidence_stale' && error.field === 'entrypoint'));
  writeFileSync(join(root, 'src', 'data', 'acme-grid.tsx'), 'export function AcmeGrid() { return null; }\n');

  // A previously valid receipt is not durable evidence after the selected
  // implementation itself is removed.
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ dependencies: { 'lucide-react': '^0.544.0' } }, null, 2)}\n`,
  );
  value = verifyUiKitReceipt(root, contract);
  assert.ok(value.errors.some((error) => error.code === 'alternate_package_missing' && error.package === '@acme/grid'));

  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ dependencies: { '@acme/grid': '^1.0.0', 'lucide-react': '^0.544.0' } }, null, 2)}\n`,
  );
  writeFileSync(join(root, 'src', 'theme', 'custom-provider.tsx'), '   \n');
  value = verifyUiKitReceipt(root, contract);
  assert.ok(
    value.errors.some(
      (error) => error.code === 'alternate_entrypoint_empty' && error.path === 'src/theme/custom-provider.tsx',
    ),
  );
});
