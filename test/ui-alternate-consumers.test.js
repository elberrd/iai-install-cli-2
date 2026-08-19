import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HARNESS = join(ROOT, 'harness');
const skip = !existsSync(join(HARNESS, '.claude')) && 'harness/ not present';
const readAgent = (name) => readFileSync(join(HARNESS, '.claude', 'agents', `${name}.md`), 'utf8');

test('UI planning consumers resolve the implementation independently for every active surface', { skip }, () => {
  for (const name of [
    'component-architect',
    'ui-component-page',
    'task-master-generator',
    'task-sequencer',
  ]) {
    const text = readAgent(name).replace(/\s+/g, ' ');
    assert.match(text, /(?:each|every|per-) active surface.{0,220}isCanonical/is, `${name} lost per-surface resolution`);
    assert.match(
      text,
      /(?:existing-library|specified-library|custom).{0,260}registry.{0,180}entrypoint/is,
      `${name} no longer carries alternate implementations through the registry entrypoint`,
    );
    assert.match(text, /non-canonical.{0,220}native (?:API|configuration)/is, `${name} leaks canonical APIs`);
  }
});

test('TanStack and advancedControls instructions are canonical-only in downstream consumers', { skip }, () => {
  for (const name of ['component-architect', 'ui-component-page', 'task-master-generator', 'task-sequencer']) {
    const text = readAgent(name).replace(/\s+/g, ' ');
    assert.match(
      text,
      /only (?:when|if) `?isCanonical(?:: true)?`?.{0,420}(?:TanStack|advancedControls)|(?:TanStack|advancedControls).{0,420}only (?:when|if) `?isCanonical(?:: true)?`?/is,
      `${name} must scope TanStack/advancedControls to isCanonical`,
    );
    assert.match(
      text,
      /non-canonical.{0,320}(?:must not|never).{0,180}(?:advancedControls|TanStack)/is,
      `${name} must forbid canonical table APIs on alternate tables`,
    );
  }
});

test('kit task instructions make canonical CSS and Tailwind conditional on the executable plan', { skip }, () => {
  for (const name of ['task-master-generator', 'task-sequencer']) {
    const text = readAgent(name).replace(/\s+/g, ' ');
    assert.match(text, /plan\.surfaces.{0,180}(?:non-empty|length\s*>\s*0)/is, `${name} ignores canonical plan surfaces`);
    assert.match(
      text,
      /all-alternate.{0,260}(?:must not|does not).{0,180}styles\/canonical-ui\.css/is,
      `${name} imports canonical CSS for an all-alternate plan`,
    );
    assert.match(
      text,
      /all-alternate.{0,320}(?:must not|does not).{0,180}Tailwind/is,
      `${name} requires Tailwind for an all-alternate plan`,
    );
    assert.match(
      text,
      /(?:Tailwind|styles\/canonical-ui\.css).{0,260}(?:first|before).{0,220}(?:approved|closed).*theme tokens/is,
      `${name} lets canonical defaults override approved theme tokens`,
    );
  }
});

test('the component catalog uses the project router and component syntax on non-Next stacks', { skip }, () => {
  const page = readAgent('ui-component-page').replace(/\s+/g, ' ');
  const planner = readAgent('task-master-generator').replace(/\s+/g, ' ');
  assert.match(page, /stack-native (?:router|route)/i);
  assert.match(page, /Vue\/Nuxt|Vue or Nuxt/i);
  assert.match(page, /non-(?:React|Next).{0,240}(?:must not|never).{0,160}(?:TSX|React\/Next)/is);
  assert.match(planner, /Vue\/Nuxt.{0,220}(?:must not|never).{0,160}React\/Next/is);
});

test('registry accepts a contract-selected custom entrypoint without fake install metadata', { skip }, () => {
  const registry = readFileSync(join(HARNESS, 'ai-docs', 'components', 'registry.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(registry, /custom path.{0,240}entrypoint/is);
  assert.match(registry, /custom.{0,220}(?:does not require|without).{0,100}(?:URL|install)/is);
});
