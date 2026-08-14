import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { startViewer } from '../fia-templates/scripts/fia-viewer.mjs';
import { parseMdTables, normStatus, parseBlockers, isSafeDocPath, statusFromText, readComponentRegistry } from '../fia-templates/scripts/plan-docs.mjs';

/**
 * Fabricate a deliberately imperfect ai-docs/ tree: pt-BR + English metadata,
 * a pipe-less table, unfilled {{placeholders}} and an index/issue status
 * mismatch — the parsers must degrade, never throw.
 */
function seedAiDocs(root) {
  const dir = join(root, 'ai-docs');
  mkdirSync(join(dir, 'todos', 'issues'), { recursive: true });
  mkdirSync(join(dir, 'components'), { recursive: true });

  writeFileSync(join(dir, 'PRD.md'), '# PRD\n\nApp de tarefas.\n');
  writeFileSync(
    join(dir, 'map.yaml'),
    [
      'workflow_progress:',
      '  workflow_status: "in_progress"',
      '  steps:',
      '    step_1_verify_prd:',
      '      name: "Verify PRD exists"',
      '      status: "completed"',
      '      completed_at: "2026-08-01T10:00:00Z"',
      '      result: { prd_found: true, prd_path: "ai-docs/PRD.md" }',
      '    step_2_screens_routes:',
      '      name: "Generate screens-routes.md"',
      '      status: "completed"',
      '      completed_at: "2026-08-01T10:05:00Z"',
      '      result: { file_path: "ai-docs/screens-routes.md" }',
      '    step_3_task_master:',
      '      name: "Generate task breakdown"',
      '      status: "completed"',
      '      result: { tasks_count: 3 }',
      '    step_4_start_mapper:',
      '      name: "Run start-mapper"',
      '      status: "in_progress"',
      '      result: {}',
      '    step_5_component_architect:',
      '      name: "Run component-architect"',
      '      status: "not_started"',
      '      result: {}',
      '    step_6_ui_component_page:',
      '      name: "Run ui-component-page"',
      '      status: "{{STEP_6_STATUS | not_started}}"',
      '      result: { route_path: "{{STEP_6_ROUTE_PATH?}}" }',
      'project:',
      '  name: "Meu App"',
      '  description: "App de tarefas"',
      'stack:',
      '  frontend:',
      '    framework: { name: "Next.js", version: "15" }',
      '    ui_library: { name: "shadcn/ui" }',
      '  components:',
      '    forms:',
      '      library: "react-hook-form"',
      '      status: "installed"',
      '      description: "Formulários"',
      '    "{{COMPONENT_KEY}}":',
      '      library: "{{NPM_PACKAGE_NAME}}"',
      'reusable_components:',
      '  design_system:',
      '    primary_library: "shadcn-ui"',
      '    theme_config: "tailwind.config.ts"',
      '    global_styles: "app/globals.css"',
      '  buttons:',
      '    - name: "Button"',
      '      path: "components/ui/button.tsx"',
      '      library: "shadcn-ui"',
      '      status: "installed"',
      '      variants: [default, outline]',
      '    - name: "{{BUTTON_NAME | Button}}"',
      '      path: "{{BUTTON_PATH | components/ui/button.tsx}}"',
      '  forms:',
      '    inputs:',
      '      - name: "Input"',
      '        path: "components/ui/input.tsx"',
      '        status: "installed"',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(dir, 'screens-routes.md'),
    [
      '# Screens and Routes',
      '',
      '## Implementation Status Summary',
      '| Category | Implemented | To Be Implemented | Partial |',
      '|----------|-------------|-------------------|---------|',
      '| Auth Routes | 1 | 1 | 0 |',
      '',
      '### Implemented Routes ✅',
      '| Route | Screen Component | File Location | Auth Required | Status |',
      '|-------|-----------------|---------------|---------------|--------|',
      '| `/` | HomePage | `app/page.tsx` | No | ✅ Implemented |',
      '| `/login` | LoginPage | `app/login/page.tsx` | No | 🔄 PARTIAL - falta MFA |',
      '',
      '### Routes To Be Implemented ⏳',
      // Deliberately irregular: no outer pipes, one row with a missing cell.
      'Route | Screen Component | Suggested Location | Auth Required | Notes',
      '-------|-----------------|-------------------|---------------|-------',
      '`/dashboard` | DashboardPage | `app/dashboard/page.tsx` | Yes',
      '`/settings` | SettingsPage | `app/settings/page.tsx` | Yes | Usa auth existente',
      '',
      '### /dashboard',
      'Detalhe da tela do dashboard.',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(dir, 'todos', 'task-master.md'),
    [
      '# Task Master — Meu App',
      '',
      '## Implementation Inventory (already exists — no tasks created)',
      '- Clerk auth funcionando',
      '',
      '## Tasks',
      '| # | Task | Status | Blocked by | Priority | Complexity | Milestone |',
      '|---|------|--------|------------|----------|------------|-----------|',
      '| 01 | [Setup schema](issues/01-setup-schema.md) | done | — | high | 3 | Foundation |',
      '| 02 | [Create task flow](issues/02-create-task-flow.md) | pending | 01 | high | 5 | MVP |',
      '| 03 | [Listar tarefas](issues/03-listar-tarefas.md) | done | 01 | med | 3 | MVP |',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'todos', 'issues', '01-setup-schema.md'),
    '# Task 01 — Setup schema\n**Status:** done\n**Blocked by:** None\n**Priority:** high\n**Complexity:** 3\n**Milestone:** Foundation\n## What it delivers\nSchema inicial.\n',
  );
  writeFileSync(
    join(dir, 'todos', 'issues', '02-create-task-flow.md'),
    '# Task 02 — Create task flow\n**Status:** pending\n**Blocked by:** 01\n**Priority:** high\n**Complexity:** 5\n## Acceptance criteria\n- [x] Cria tarefa\n- [ ] Valida input\n',
  );
  // pt-BR metadata + index says "done" while the issue file says "pendente".
  writeFileSync(
    join(dir, 'todos', 'issues', '03-listar-tarefas.md'),
    '# Tarefa 03 — Listar tarefas\n**Status:** pendente\n**Bloqueado por:** Nenhum\n**Prioridade:** média\n## O que entrega\nLista as tarefas.\n',
  );

  // Live design-system page on disk (only the path matters).
  mkdirSync(join(root, 'app', 'ui-components'), { recursive: true });
  writeFileSync(join(root, 'app', 'ui-components', 'page.tsx'), 'export default function Page() {}\n');
  return dir;
}

test('plan viewer: page has the Plano view and its script compiles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-plan-'));
  const server = await startViewer({ dbPath: join(root, 'missing.db'), aiDocsDir: seedAiDocs(root), projectRoot: root, port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await (await fetch(base + '/')).text();
    assert.match(page, /Plan/);
    assert.match(page, /mdToHtml/);
    // The whole page lives in one template literal — a missed escape breaks the
    // browser silently. Compiling the served script catches it here.
    const src = page.slice(page.indexOf('<script>') + 8, page.lastIndexOf('</script>'));
    assert.doesNotThrow(() => new vm.Script(src));
    assert.ok(!src.includes('${'), 'inner script must not contain template interpolation');
  } finally {
    server.close();
  }
});

test('plan viewer: overview merges map.yaml, screens, tasks and files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-plan-'));
  const server = await startViewer({ dbPath: join(root, 'missing.db'), aiDocsDir: seedAiDocs(root), projectRoot: root, port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const o = await (await fetch(base + '/api/plan')).json();
    assert.equal(o.available, true);
    assert.equal(o.mapError, null);
    assert.equal(o.project.name, 'Meu App');
    assert.equal(o.stack.framework, 'Next.js');
    assert.equal(o.workflow.status, 'in_progress');
    assert.equal(o.workflow.steps.length, 6);
    assert.equal(o.workflow.steps[3].status, 'in_progress');
    // Unfilled {{placeholder}} must normalize to not_started, not leak through.
    assert.equal(o.workflow.steps[5].status, 'not_started');
    assert.equal(o.counts.tasks.total, 3);
    assert.equal(o.counts.screens.total, 4);
    assert.equal(o.next.num, '02');
    assert.ok(o.files.some((f) => f.path === 'map.yaml'));
    assert.ok(o.files.some((f) => f.path === 'screens-routes.md'));
    assert.ok(o.files.some((f) => f.path === 'todos/issues/03-listar-tarefas.md'));
  } finally {
    server.close();
  }
});

test('plan viewer: screens parse with status, irregular table survives', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-plan-'));
  const server = await startViewer({ dbPath: join(root, 'missing.db'), aiDocsDir: seedAiDocs(root), projectRoot: root, port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const s = await (await fetch(base + '/api/plan-screens')).json();
    assert.equal(s.available, true);
    assert.equal(s.counts.implemented, 1);
    assert.equal(s.counts.partial, 1);
    assert.equal(s.counts.todo, 2);
    assert.equal(s.screens.find((x) => x.route === '/login').status, 'partial');
    // The pipe-less table still yields rows.
    assert.ok(s.screens.some((x) => x.route === '/dashboard'));
    assert.ok(s.screens.find((x) => x.route === '/dashboard').sectionId, 'detail section is linked');
    assert.equal(s.fallbackMarkdown, null);
  } finally {
    server.close();
  }
});

test('plan viewer: tasks merge issues with index, mismatch and frontier', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-plan-'));
  const server = await startViewer({ dbPath: join(root, 'missing.db'), aiDocsDir: seedAiDocs(root), projectRoot: root, port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const t = await (await fetch(base + '/api/plan-tasks')).json();
    assert.equal(t.available, true);
    assert.equal(t.counts.total, 3);
    assert.equal(t.counts.done, 1);
    assert.equal(t.tasks[0].status, 'done');
    assert.deepEqual(t.tasks[1].blockedBy, ['01']);
    assert.deepEqual(t.tasks[1].criteria, [
      { text: 'Cria tarefa', done: true },
      { text: 'Valida input', done: false },
    ]);
    // Issue file wins over the index; the divergence is surfaced.
    const t3 = t.tasks.find((x) => x.num === '03');
    assert.equal(t3.status, 'pending');
    assert.equal(t3.statusMismatch, true);
    assert.deepEqual(t.frontier, ['02', '03']);
    assert.equal(t.next, '02');
    assert.ok(t.graph.some((e) => e.from === '01' && e.to === '02'));
    assert.match(t.inventory, /Clerk/);
    assert.equal(t.tasks[0].blocks.includes('02'), true);
  } finally {
    server.close();
  }
});

test('plan viewer: design system drops placeholders, finds the live page', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-plan-'));
  const server = await startViewer({ dbPath: join(root, 'missing.db'), aiDocsDir: seedAiDocs(root), projectRoot: root, port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const d = await (await fetch(base + '/api/plan-design')).json();
    assert.equal(d.designSystem.library, 'shadcn-ui');
    // 1 real button (placeholder dropped) + 1 input from the nested subcategory.
    assert.equal(d.counts.total, 2);
    assert.ok(d.categories.some((c) => c.key === 'buttons' && c.items.length === 1));
    assert.ok(d.categories.some((c) => c.key === 'forms.inputs'));
    assert.deepEqual(d.libraries.map((l) => l.key), ['forms']);
    assert.equal(d.uiPage.exists, true);
    assert.equal(d.uiPage.route, '/ui-components');
  } finally {
    server.close();
  }
});

test('readComponentRegistry: parses the table between markers; no file → exists:false', () => {
  const root = mkdtempSync(join(tmpdir(), 'registry-'));
  const aiDocs = join(root, 'ai-docs');
  mkdirSync(join(aiDocs, 'components'), { recursive: true });

  // No file → exists:false, never throws.
  assert.deepEqual(readComponentRegistry(aiDocs), { exists: false, entries: [] });

  writeFileSync(
    join(aiDocs, 'components', 'registry.md'),
    [
      '# Registry',
      '```',
      '| FencedExample | actions | shadcn/ui | x.tsx | cmd | url | installed | example outside the markers |',
      '```',
      '| Component | Category | Origin | File | Install | Docs (URL) | Status | When to use |',
      '|---|---|---|---|---|---|---|---|',
      '<!-- registry:start -->',
      '<!-- Terminated comment (not an entry):',
      '| Ghost2 | actions | shadcn/ui | x.tsx | cmd | url | installed | nothing |',
      '-->',
      '|:---|:---:|---|---|---|---|---|---|---|',
      '| Button | actions | shadcn/ui | `components/ui/button.tsx` | npx shadcn@latest add button | https://ui.shadcn.com/docs/components/button | installed | — | every action |',
      '| DataTable | data | project | — | — | — | installed | default | tables |',
      '| DataTable REUI | data | REUI | — | — | — | planned | alternative | only when sorting is requested |',
      '| Legacy8Columns | data | project | — | — | — | installed | legacy row without role |',
      '<!-- registry:end -->',
      '| Ghost | outside | the | markers | does | not | count | here | at all |',
    ].join('\n'),
  );
  const r = readComponentRegistry(aiDocs);
  assert.equal(r.exists, true);
  assert.equal(r.entries.length, 4, 'only real rows between the markers (no comment, fence or :--- separator)');
  assert.equal(r.entries[0].name, 'Button');
  assert.equal(r.entries[0].file, 'components/ui/button.tsx', 'backticks stripped');
  assert.equal(r.entries[0].status, 'installed');
  assert.equal(r.entries[0].papel, '', 'em dash in Role becomes empty (only one for the need)');
  assert.equal(r.entries[0].when, 'every action');
  assert.equal(r.entries[1].papel, 'default');
  assert.equal(r.entries[2].papel, 'alternative');
  assert.equal(r.entries[2].status, 'planned');
  // Compat: a legacy-format row (8 columns, without Role) is still valid.
  assert.equal(r.entries[3].papel, '');
  assert.equal(r.entries[3].when, 'legacy row without role');

  // A STRAY `<!--` (never closed) must not swallow the real entries.
  writeFileSync(
    join(aiDocs, 'components', 'registry.md'),
    [
      '<!-- registry:start -->',
      '<!-- comment the agent forgot to close',
      '| Button | actions | shadcn/ui | components/ui/button.tsx | — | — | installed | actions |',
      '<!-- registry:end -->',
    ].join('\n'),
  );
  const r2 = readComponentRegistry(aiDocs);
  assert.equal(r2.entries.length, 1, 'entry survives the unterminated comment');
  assert.equal(r2.entries[0].name, 'Button');
});

test('plan viewer: doc reader serves files, blocks traversal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-plan-'));
  const server = await startViewer({ dbPath: join(root, 'missing.db'), aiDocsDir: seedAiDocs(root), projectRoot: root, port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await (await fetch(base + '/api/plan-doc?path=todos%2Fissues%2F01-setup-schema.md')).json();
    assert.equal(ok.exists, true);
    assert.match(ok.text, /Setup schema/);
    assert.equal(ok.kind, 'md');

    const traversal = await fetch(base + '/api/plan-doc?path=..%2F..%2Fetc%2Fpasswd');
    assert.equal(traversal.status, 400);
    const absolute = await fetch(base + '/api/plan-doc?path=%2Fetc%2Fpasswd');
    assert.equal(absolute.status, 400);
    const missing = await (await fetch(base + '/api/plan-doc?path=todos%2Fnada.md')).json();
    assert.equal(missing.exists, false);
  } finally {
    server.close();
  }
});

test('plan viewer: missing ai-docs → available:false everywhere, page still serves', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-plan-'));
  const server = await startViewer({ dbPath: join(root, 'missing.db'), aiDocsDir: join(root, 'nope'), projectRoot: root, port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const o = await (await fetch(base + '/api/plan')).json();
    assert.equal(o.available, false);
    assert.deepEqual(o.files, []);
    const t = await (await fetch(base + '/api/plan-tasks')).json();
    assert.deepEqual(t.tasks, []);
    const s = await (await fetch(base + '/api/plan-screens')).json();
    assert.deepEqual(s.screens, []);
    const page = await (await fetch(base + '/')).text();
    assert.match(page, /Fábrica IAI de Agentes|IAI Agent Factory/);
  } finally {
    server.close();
  }
});

test('plan helpers: table parser, status/blockers normalization, safe paths', () => {
  // Table inside a fence is ignored; irregular cells don't throw.
  const tables = parseMdTables(
    ['```', '| A | B |', '|---|---|', '| 1 | 2 |', '```', '', 'A | B', '---|---', 'só-uma-célula |', 'x | y | extra'].join('\n'),
  );
  assert.equal(tables.length, 1);
  assert.equal(tables[0].rows.length, 2);

  assert.equal(normStatus('done'), 'done');
  assert.equal(normStatus('`pendente`'), 'pending');
  assert.equal(normStatus('Em andamento'), 'in-progress');
  assert.equal(normStatus('bloqueada'), 'blocked');
  assert.deepEqual(parseBlockers('None'), []);
  assert.deepEqual(parseBlockers('—'), []);
  assert.deepEqual(parseBlockers('Nenhum'), []);
  assert.deepEqual(parseBlockers('01, 03'), ['01', '03']);
  assert.deepEqual(parseBlockers('[Task 2](issues/02-x.md)'), ['02']);

  assert.equal(statusFromText('Routes To Be Implemented ⏳'), 'todo');
  assert.equal(statusFromText('Implemented Routes ✅'), 'implemented');
  assert.equal(statusFromText('🔄 PARTIAL - falta MFA'), 'partial');

  assert.equal(isSafeDocPath('todos/issues/01-a.md'), true);
  assert.equal(isSafeDocPath('map.yaml'), true);
  assert.equal(isSafeDocPath('../x.md'), false);
  assert.equal(isSafeDocPath('/abs.md'), false);
  assert.equal(isSafeDocPath('x.exe'), false);
});
