import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  expandChosen,
  filesToRemove,
  prunePackageJson,
  resolveAddonFlags,
  stripMarkedContent,
} from '../src/lib/addons.js';
import { ADDON_GROUPS, ADDON_PRESETS, ALL_ADDON_IDS } from '../src/config.js';

const CATALOG = { groups: ADDON_GROUPS, presets: ADDON_PRESETS, allIds: ALL_ADDON_IDS };

describe('stripMarkedContent', () => {
  it('removes unchosen blocks and always removes marker lines', () => {
    const input = [
      'const a = 1',
      '// live1:addon:sentry:start',
      'const sentry = true',
      '// live1:addon:sentry:end',
      '// live1:addon:posthog:start',
      'const posthog = true',
      '// live1:addon:posthog:end',
      'const z = 2',
    ].join('\n');

    const out = stripMarkedContent(input, new Set(['sentry']));
    assert.match(out, /const sentry = true/);
    assert.doesNotMatch(out, /posthog/);
    assert.doesNotMatch(out, /live1:addon/);
  });

  it('handles JSX comment markers', () => {
    const input = [
      '<div>',
      '  {/* live1:addon:vercel-analytics:start */}',
      '  <VercelAnalytics />',
      '  {/* live1:addon:vercel-analytics:end */}',
      '</div>',
    ].join('\n');
    const kept = stripMarkedContent(input, new Set(['vercel-analytics']));
    assert.match(kept, /<VercelAnalytics \/>/);
    assert.doesNotMatch(kept, /live1:addon/);

    const removed = stripMarkedContent(input, new Set());
    assert.doesNotMatch(removed, /VercelAnalytics/);
  });

  it('inverse blocks (addon!) are kept only when the addon is NOT chosen', () => {
    const input = [
      '// live1:addon!:csp:start',
      'const basicCsp = true',
      '// live1:addon!:csp:end',
      '// live1:addon:csp:start',
      'const fullCsp = true',
      '// live1:addon:csp:end',
    ].join('\n');

    const withCsp = stripMarkedContent(input, new Set(['csp']));
    assert.match(withCsp, /fullCsp/);
    assert.doesNotMatch(withCsp, /basicCsp/);

    const withoutCsp = stripMarkedContent(input, new Set());
    assert.match(withoutCsp, /basicCsp/);
    assert.doesNotMatch(withoutCsp, /fullCsp/);
  });

  it('handles nested blocks and hash-comment markers (.env/yaml)', () => {
    const input = [
      '# live1:addon:sentry:start',
      'SENTRY_DSN=',
      '# live1:addon:posthog:start',
      'NESTED=1',
      '# live1:addon:posthog:end',
      'SENTRY_ORG=',
      '# live1:addon:sentry:end',
    ].join('\n');
    const out = stripMarkedContent(input, new Set(['sentry']));
    assert.match(out, /SENTRY_DSN/);
    assert.match(out, /SENTRY_ORG/);
    assert.doesNotMatch(out, /NESTED/);
  });

  it('collapses the blank-line runs left behind', () => {
    const input = ['a', '', '// live1:addon:x:start', 'gone', '// live1:addon:x:end', '', 'b'].join('\n');
    const out = stripMarkedContent(input, new Set());
    assert.doesNotMatch(out, /\n\n\n/);
    assert.match(out, /a/);
    assert.match(out, /b/);
  });
});

describe('expandChosen', () => {
  const manifest = { virtual: { 'billing-ui': ['stripe', 'clerk-billing'] }, addons: {} };

  it('adds virtual ids when any member is chosen', () => {
    assert.ok(expandChosen(manifest, ['stripe']).has('billing-ui'));
    assert.ok(expandChosen(manifest, ['clerk-billing']).has('billing-ui'));
    assert.ok(!expandChosen(manifest, ['sentry']).has('billing-ui'));
  });
});

describe('filesToRemove', () => {
  const manifest = {
    addons: {
      stripe: { files: ['convex/stripe.ts', 'app/dashboard/billing'] },
      'clerk-billing': { files: ['components/billing/clerk-pricing.tsx', 'app/dashboard/billing'] },
      sentry: { files: ['sentry.server.config.ts'] },
    },
  };

  it('removes files whose every owner was left out', () => {
    const removed = filesToRemove(manifest, ['stripe']);
    assert.ok(removed.includes('components/billing/clerk-pricing.tsx'));
    assert.ok(removed.includes('sentry.server.config.ts'));
    assert.ok(!removed.includes('convex/stripe.ts'));
    // Shared file survives because ONE owner (stripe) was kept.
    assert.ok(!removed.includes('app/dashboard/billing'));
  });

  it('removes shared files only when no owner is chosen', () => {
    const removed = filesToRemove(manifest, []);
    assert.ok(removed.includes('app/dashboard/billing'));
  });
});

describe('prunePackageJson', () => {
  const manifest = {
    addons: {
      sentry: { dependencies: ['@sentry/nextjs'], devDependencies: ['@spotlightjs/spotlight'], scripts: ['dev:spotlight'] },
      storybook: { devDependencies: ['storybook', 'vite'], scripts: ['storybook'] },
      knip: { devDependencies: ['knip'], scripts: ['check:deps'] },
    },
  };
  const pkg = {
    scripts: { dev: 'next dev', 'dev:spotlight': 'x', storybook: 'y', 'check:deps': 'knip' },
    dependencies: { next: '1', '@sentry/nextjs': '1' },
    devDependencies: { '@spotlightjs/spotlight': '1', storybook: '1', vite: '1', knip: '1' },
  };

  it('drops deps and scripts of unchosen addons only', () => {
    const out = prunePackageJson(pkg, manifest, ['sentry']);
    assert.equal(out.dependencies['@sentry/nextjs'], '1');
    assert.equal(out.devDependencies['@spotlightjs/spotlight'], '1');
    assert.equal(out.scripts['dev:spotlight'], 'x');
    assert.equal(out.devDependencies.storybook, undefined);
    assert.equal(out.devDependencies.vite, undefined);
    assert.equal(out.scripts.storybook, undefined);
    assert.equal(out.devDependencies.knip, undefined);
    assert.equal(out.scripts['check:deps'], undefined);
    // untouched basics
    assert.equal(out.dependencies.next, '1');
    assert.equal(out.scripts.dev, 'next dev');
    // input not mutated
    assert.equal(pkg.devDependencies.storybook, '1');
  });
});

describe('resolveAddonFlags', () => {
  it('defaults to the "padrao" preset', () => {
    const { chosen, errors } = resolveAddonFlags({}, CATALOG);
    assert.equal(errors.length, 0);
    assert.deepEqual([...chosen].sort(), [...ADDON_PRESETS.padrao].sort());
  });

  it('--preset minimo clears everything', () => {
    const { chosen } = resolveAddonFlags({ preset: 'minimo' }, CATALOG);
    assert.equal(chosen.length, 0);
  });

  it('group flags override the preset for that group only', () => {
    const { chosen } = resolveAddonFlags({ preset: 'minimo', observability: 'sentry,logging' }, CATALOG);
    assert.deepEqual([...chosen].sort(), ['logging', 'sentry']);
  });

  it('"none" empties a group that the preset had enabled', () => {
    const { chosen } = resolveAddonFlags({ preset: 'padrao', security: 'none' }, CATALOG);
    assert.ok(!chosen.includes('csp'));
    assert.ok(!chosen.includes('rate-limit'));
    assert.ok(chosen.includes('commitlint'));
  });

  it('"all" selects every option of the group', () => {
    const { chosen } = resolveAddonFlags({ preset: 'minimo', addons: 'all' }, CATALOG);
    assert.ok(chosen.includes('commitlint'));
    assert.ok(chosen.includes('knip'));
    assert.ok(chosen.includes('analyzer'));
  });

  it('rejects unknown values with a helpful error', () => {
    const { errors } = resolveAddonFlags({ addons: 'commitlint,typo' }, CATALOG);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /typo/);
  });

  it('single groups reject multiple values', () => {
    const { errors } = resolveAddonFlags({ payments: 'stripe,clerk-billing' }, CATALOG);
    assert.ok(errors.some((e) => /only ONE/.test(e)));
  });
});
