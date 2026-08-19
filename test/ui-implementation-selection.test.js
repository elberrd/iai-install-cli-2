import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HARNESS = join(ROOT, 'harness');
const skip = !existsSync(join(HARNESS, '.claude')) && 'harness/ not present';
const readHarness = (...parts) => readFileSync(join(HARNESS, ...parts), 'utf8');
const readRoot = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8');

test('UI command records explicit implementation precedence and an operational surface update', { skip }, () => {
  const command = readHarness('.claude', 'commands', 'ui-contract.md').replace(/\s+/g, ' ');

  assert.match(command, /per-surface choice.{0,100}wins/is);
  assert.match(command, /implementation\.default.{0,100}canonical only/is);
  assert.match(command, /no detailed.{0,140}fia-universal/is);
  assert.match(command, /implementation --surface/i);
  assert.match(command, /existing-library\|specified-library\|custom/i);
  assert.match(command, /Library modes require both `package` and `path`/i);
  assert.match(command, /entrypoint\/registry SHA-256 evidence/i);
  assert.match(command, /migrate --json/i);
  assert.match(command, /V2 migrates only unambiguous per-surface choices/i);
  assert.match(command, /harness-only.{0,180}decision record/is);
});

test('universal behavior stays authoritative while canonical APIs are conditional', { skip }, () => {
  const core = readHarness('.claude', 'skills', 'design-system', 'references', 'core-kit.md');
  const design = readHarness('.claude', 'skills', 'design-system', 'SKILL.md');
  const frontend = readHarness('.claude', 'skills', 'frontend-profissional', 'SKILL.md');

  for (const [name, text] of [
    ['core kit', core],
    ['design system', design],
    ['professional frontend', frontend],
  ]) {
    assert.match(text, /resolveUiImplementation|resolved implementation/i, `${name} lost implementation resolution`);
    assert.match(text, /isCanonical|fia-universal/i, `${name} lost its canonical boundary`);
    assert.match(text, /existing(?:-library| library|\/specified)/i, `${name} lost existing-library choice`);
    assert.match(text, /specified/i, `${name} lost specified-library choice`);
    assert.match(text, /quality|behavior/i, `${name} lost the universal contract`);
  }

  assert.match(core, /gate must not demand this canonical prop name/i);
  assert.match(frontend, /never install the canonical dependency as a duplicate/i);
});

test('field workflow is backend-neutral and marks Convex paths as canonical mappings', { skip }, () => {
  const design = readHarness('.claude', 'skills', 'design-system', 'SKILL.md');
  const workedExample = readHarness('.claude', 'skills', 'design-system', 'references', 'adding-a-field.md');

  assert.match(design, /selected backend's schema/i);
  assert.match(design, /selected backend's server boundary/i);
  assert.match(design, /Canonical Convex mapping/i);
  assert.doesNotMatch(design, /\*\*Schema\*\* — add the field to `convex\/schema\.ts`/i);
  assert.match(workedExample, /canonical Convex worked example/i);
  assert.match(workedExample, /universal pipeline/i);
});

test('examples remain an optional shelf and never become implementation authority', { skip }, () => {
  const examples = readHarness('.claude', 'skills', 'examples', 'SKILL.md');
  const agents = readHarness('AGENTS.md');

  assert.match(examples, /optional and non-authoritative/i);
  assert.match(examples, /never overrides any authority/i);
  assert.match(examples, /may inform shape, but never overrides/i);
  assert.match(agents, /Examples are a shelf, not a mandate or authority/i);
});

test('registry and Cursor React rules no longer select REUI from ordinary grouping or bulk actions', { skip }, () => {
  const registry = readHarness('ai-docs', 'components', 'registry.md');
  const reactRule = readHarness('.cursor', 'rules', 'react-ui.mdc');
  const normalizedRegistry = registry.replace(/\s+/g, ' ');
  const normalizedReactRule = reactRule.replace(/\s+/g, ' ');

  assert.match(registry, /ordinary grouping or bulk actions stay in the default/i);
  assert.match(normalizedRegistry, /Explicit existing\/\s*specified library or custom path wins/i);
  assert.doesNotMatch(reactRule, /Data tables with bulk actions\s*→\s*REUI Data Grid/i);
  assert.match(normalizedReactRule, /Never switch to REUI Data Grid implicitly/i);
  assert.match(reactRule, /Only `canonical` \/ `fia-universal` uses/i);
});

test('/ui-contract is discoverable through the generic .agents command alias', { skip }, () => {
  assert.equal(existsSync(join(HARNESS, '.agents', 'commands', 'ui-contract.md')), true);
});

test(
  'capability changes are documented as atomic, dependency-safe decisions in every public UI-contract surface',
  { skip },
  () => {
    const command = readHarness('.claude', 'commands', 'ui-contract.md');
    const piPrompt = readRoot('pi-templates', '.pi', 'prompts', 'ui-contract.md');
    const piCookbook = readRoot('pi-templates', '.pi', 'skills', 'fia', 'cookbooks', 'ui-contract.md');
    const readme = readRoot('README.md');
    const docs = readRoot('DOCS.md');

    for (const [name, text] of [
      ['Claude command', command],
      ['Pi prompt', piPrompt],
      ['Pi cookbook', piCookbook],
      ['README', readme],
      ['DOCS', docs],
    ]) {
      assert.match(
        text,
        /capability\s+--name\s+<capability>\s+--enabled\s+true\\?\|false/i,
        `${name} lacks the atomic capability command`,
      );
    }
    assert.match(command, /kanban.{0,160}dragAndDrop/is);
    assert.match(command, /advancedDataTableControls.{0,160}dataTables/is);
    assert.match(command, /refus|reject|block/i);
  },
);

test(
  '/component admits registered project-origin custom entrypoints and preserves contract authority',
  { skip },
  () => {
    const component = readHarness('.claude', 'commands', 'component.md').replace(/\s+/g, ' ');

    assert.match(component, /project-origin|project origin/i);
    assert.match(component, /custom.{0,180}(?:without|no).{0,80}(?:URL|install)/i);
    assert.match(component, /entrypoint file.{0,180}helper modules|helper modules.{0,180}entrypoint file/i);
    assert.match(component, /closed surface.{0,260}contract.{0,120}(?:precedes|wins|authoritative)/i);
    assert.match(component, /ui-contract\.mjs implementation/i);
    assert.match(component, /ui-contract\.mjs implementation.{0,300}(?:before|first).{0,120}registry/is);
    assert.match(component, /never.{0,100}(?:registry alone|only the registry)/i);
  },
);

test('design-system authority is contract then registry then canonical asset then examples', { skip }, () => {
  const design = readHarness('.claude', 'skills', 'design-system', 'SKILL.md');
  const normalized = design.replace(/\s+/g, ' ');

  assert.match(normalized, /contract\s*>\s*registry\s*>\s*canonical asset\s*>\s*examples/i);
  assert.match(normalized, /existing registered local implementation/i);
  assert.doesNotMatch(normalized, /copy an existing, compliant example/i);
});

test('canonical table API and wiring are scoped without leaking into alternate implementations', { skip }, () => {
  const tables = readHarness('.claude', 'skills', 'design-system', 'references', 'tables.md');

  assert.match(tables, /Canonical `fia-universal`[^\n]*three files per entity|Canonical three files per entity/i);
  assert.match(
    tables,
    /Canonical[^\n]*(?:TanStack|ColumnDef)[^\n]*(?:API|pattern)|Canonical[^\n]*(?:API|pattern)[^\n]*(?:TanStack|ColumnDef)/i,
  );
  assert.match(tables, /non-canonical.{0,220}native.{0,100}(?:organization|types|API)/is);
});

test('theme, custom path, and harness-only boundaries are explicit', { skip }, () => {
  const core = readHarness('.claude', 'skills', 'design-system', 'references', 'core-kit.md').replace(/\s+/g, ' ');
  const command = readHarness('.claude', 'commands', 'ui-contract.md').replace(/\s+/g, ' ');

  assert.match(core, /visual theme.{0,180}`\/theme`/i);
  assert.match(core, /theme\.user_switcher.{0,220}(?:toggle|switcher)/i);
  assert.match(command, /custom.{0,160}entrypoint file.{0,180}helper modules/i);
  assert.match(core, /harness-only.{0,260}(?:without FIA|FIA is absent)/i);
  assert.match(core, /do not imply.{0,80}stack-specific canonical preset/i);
});

test('theme workflow preserves the selected implementation and uses stack-native files', { skip }, () => {
  const claude = readHarness('.claude', 'commands', 'theme.md').replace(/\s+/g, ' ');
  const piPrompt = readRoot('pi-templates', '.pi', 'prompts', 'theme.md').replace(/\s+/g, ' ');
  const piCookbook = readRoot('pi-templates', '.pi', 'skills', 'fia', 'cookbooks', 'theme.md').replace(/\s+/g, ' ');

  for (const [name, text] of [
    ['Claude command', claude],
    ['Pi prompt', piPrompt],
    ['Pi cookbook', piCookbook],
  ]) {
    assert.match(text, /ai-docs\/ui\/contract\.json/i, `${name} lost the UI implementation decision`);
    assert.match(
      text,
      /theme.{0,240}(?:existing-library|specified-library|custom|non-canonical)/i,
      `${name} no longer preserves an alternate theme implementation`,
    );
    assert.match(
      text,
      /(?:project|stack)[- ]native|project's equivalent|project's token source/i,
      `${name} hard-codes canonical theme files`,
    );
  }

  assert.match(piCookbook, /only when.{0,160}(?:canonical|fia-universal)/i);
  assert.match(claude, /only when.{0,160}(?:canonical|fia-universal)/i);
});

test('greenfield command recipe creates Foundation before the visual theme checkpoint', () => {
  const readme = readRoot('README.md');
  const recipeStart = readme.indexOf('Example 1 — from zero, WITHOUT the template');
  const recipeEnd = readme.indexOf('Example 2 — from zero, WITH the ready-made template', recipeStart);
  const recipe = readme.slice(recipeStart, recipeEnd);
  const task = recipe.indexOf('/task');
  const theme = recipe.indexOf('/theme');
  const goal = recipe.indexOf('/goal');

  assert.ok(task >= 0 && task < theme && theme < goal, 'README must show /task → /theme → /goal');
  assert.match(recipe, /goal.{0,180}Foundation.{0,180}pauses?.{0,180}theme/is);

  const map = readRoot('pi-templates', '.pi', 'prompts', 'map.md').replace(/\s+/g, ' ');
  const themePrompt = readRoot('pi-templates', '.pi', 'prompts', 'theme.md').replace(/\s+/g, ' ');
  const goalPrompt = readRoot('pi-templates', '.pi', 'prompts', 'goal.md').replace(/\s+/g, ' ');
  assert.match(map, /`\/task`.{0,180}`\/theme`.{0,180}`\/goal`/i);
  assert.match(themePrompt, /no app scaffold.{0,180}(?:foundation|\/task).{0,80}stop/i);
  assert.match(goalPrompt, /theme gate.{0,220}foundation.{0,220}PAUSE/i);
});

test('idea preserves an explicitly requested UI library for map contract resolution', () => {
  const idea = readRoot('pi-templates', '.pi', 'prompts', 'idea.md').replace(/\s+/g, ' ');
  const grill = readRoot('pi-templates', '.pi', 'prompts', 'grill.md').replace(/\s+/g, ' ');
  const map = readRoot('pi-templates', '.pi', 'prompts', 'map.md').replace(/\s+/g, ' ');
  const stack = readRoot('pi-templates', '.pi', 'skills', 'fia', 'cookbooks', 'stack.md').replace(/\s+/g, ' ');
  const readme = readRoot('README.md').replace(/\s+/g, ' ');

  assert.match(idea, /UI implementation constraints/i);
  assert.match(idea, /surface.{0,100}package or project-relative entrypoint/i);
  assert.match(idea, /do not ask this as a mandatory extra question/i);
  assert.match(idea, /absence.{0,140}canonical fallback/i);
  assert.match(grill, /global technology\/layer.{0,180}`\/stack <delta>`.{0,100}before `\/map`/i);
  assert.match(grill, /UI implementation constraints/i);
  assert.match(map, /UI implementation constraints.{0,180}per-surface library\/custom choices/i);
  assert.match(stack, /preference is not a mandate/i);
  assert.match(stack, /Vue\/Nuxt\/Svelte.{0,180}explicit user request|explicit user request.{0,180}Vue\/Nuxt\/Svelte/i);
  assert.match(stack, /never normalize it to Next|never.{0,100}Next\/React `fia-universal`/i);
  if (!skip) {
    const claudeStack = readHarness('.claude', 'commands', 'stack.md').replace(/\s+/g, ' ');
    assert.match(claudeStack, /preference is not a mandate/i);
    assert.match(claudeStack, /never normalize it to Next|never.{0,100}Next\/React `fia-universal`/i);
  }
  assert.match(readme, /Next\.js remains the recommended\/default frontend/i);
  assert.match(readme, /Vue, Nuxt, Svelte.{0,120}never inferred/i);
});

test('generated kit task instructions install dependencies and CSS before verification', { skip }, () => {
  const taskMaster = readHarness('.claude', 'agents', 'task-master-generator.md').replace(/\s+/g, ' ');
  const sequencer = readHarness('.claude', 'agents', 'task-sequencer.md').replace(/\s+/g, ' ');

  for (const [name, text] of [
    ['task master', taskMaster],
    ['task sequencer', sequencer],
  ]) {
    const plan = text.indexOf('ui-kit.mjs plan');
    const install = text.indexOf('ui-kit.mjs install', plan);
    const packageManager = text.indexOf('package manager', install);
    const css = text.indexOf('styles/canonical-ui.css', packageManager);
    const verify = text.indexOf('ui-kit.mjs verify', css);
    const typecheck = text.indexOf('typecheck', verify);
    const build = text.indexOf('build', typecheck);
    assert.ok(plan >= 0, `${name} lacks plan`);
    assert.ok(plan < install, `${name} must install after planning`);
    assert.ok(install < packageManager, `${name} must run the package manager after wrapper install`);
    assert.ok(packageManager < css, `${name} must import global CSS after dependency installation`);
    assert.ok(css < verify, `${name} must import CSS before wrapper verification`);
    assert.ok(verify < typecheck, `${name} must typecheck after wrapper verification`);
    assert.ok(typecheck < build, `${name} must build after typecheck`);
  }
});
