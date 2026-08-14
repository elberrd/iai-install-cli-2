import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITIES, pushRuledOut, stepEnabled, wantsWebUi, unknownCapabilities } from '../src/lib/pipeline.js';
import { DEFAULT_TEMPLATE_ID, TEMPLATES } from '../src/config.js';
import { resolveTemplateId } from '../src/steps/template.js';

test('stepEnabled: core always runs; a capability only when declared', () => {
  const template = { requires: ['convex', 'clerk'] };
  assert.equal(stepEnabled('core', template), true);
  assert.equal(stepEnabled(undefined, template), true);
  assert.equal(stepEnabled('convex', template), true);
  assert.equal(stepEnabled('storage', template), false);
  // No resolved template (defensive): only core runs.
  assert.equal(stepEnabled('convex', undefined), false);
  assert.equal(stepEnabled('core', undefined), true);
});

test('TEMPLATES: catalog is sound (known requires, default exists, unique tenancy)', () => {
  assert.ok(TEMPLATES[DEFAULT_TEMPLATE_ID], 'default must exist in the catalog');
  const tenancies = new Set();
  for (const [id, t] of Object.entries(TEMPLATES)) {
    assert.equal(t.id, id, `TEMPLATES.${id}.id must mirror the key`);
    assert.match(t.repo, /^[\w.-]+\/[\w.-]+$/, `${id}'s repo must be owner/repo`);
    assert.deepEqual(
      unknownCapabilities(t.requires),
      [],
      `${id}'s requires only uses known capabilities (${CAPABILITIES.join(', ')})`,
    );
    assert.ok(!tenancies.has(t.tenancy), `duplicate tenancy "${t.tenancy}" — the --tenancy shortcut becomes ambiguous`);
    tenancies.add(t.tenancy);
  }
});

test('resolveTemplateId: precedence --template-id > --tenancy > nothing', () => {
  assert.deepEqual(resolveTemplateId({ templateId: 'live2', tenancy: 'single' }), {
    id: 'live2',
    source: 'template-id',
  });
  assert.deepEqual(resolveTemplateId({ tenancy: 'multi' }), { id: 'live2', source: 'tenancy' });
  assert.deepEqual(resolveTemplateId({ tenancy: 'single' }), { id: 'live1', source: 'tenancy' });
  assert.deepEqual(resolveTemplateId({}), { id: null, source: 'none' });
});

test('pushRuledOut: mirrors the precedence of steps/github.js', () => {
  assert.equal(pushRuledOut({ skipGithub: true }), true);
  assert.equal(pushRuledOut({ push: false }), true);
  assert.equal(pushRuledOut({ yes: true }), true, '--yes does not create a remote repo (irreversible)');
  assert.equal(pushRuledOut({ skipGithub: true, push: true }), true, '--skip-github wins');

  assert.equal(pushRuledOut({}), false, 'interactive: the question still comes');
  assert.equal(pushRuledOut({ push: true }), false);
  assert.equal(pushRuledOut({ yes: true, push: true }), false);
});

test('wantsWebUi: the terminal wizard is the default entry point', () => {
  // Bare command → terminal. This is the main case: `npx impactus`.
  assert.equal(wantsWebUi({}), false);
  assert.equal(wantsWebUi({ port: '5000' }), false);
  assert.equal(wantsWebUi({ name: 'meu-app' }), false);
  assert.equal(wantsWebUi({ preset: 'saas' }), false);
  assert.equal(wantsWebUi({ yes: true }), false);
});

test('wantsWebUi: the web UI is explicit opt-in (--ui/--web)', () => {
  assert.equal(wantsWebUi({ ui: true }), true);
  assert.equal(wantsWebUi({ ui: true, yes: true, name: 'x' }), true, 'explicit --ui beats everything');
  // Compatibility flags still turn it off.
  assert.equal(wantsWebUi({ ui: false }), false, '--no-ui');
  assert.equal(wantsWebUi({ terminal: true }), false);
});

