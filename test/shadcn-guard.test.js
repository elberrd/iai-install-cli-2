import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBlockChanges, isAppCode, isImported, parseStatus } from '../src/lib/shadcn-guard.js';

test('parseStatus: codes, renames and quoted paths', () => {
  const map = parseStatus(
    [
      ' M components/app-sidebar.tsx',
      '?? components/nav-main.tsx',
      'R  old.tsx -> new.tsx',
      '"?? " ', // junk line — ignored by the trim
      '?? "components/with space.tsx"',
    ].join('\n'),
  );
  assert.equal(map.get('components/app-sidebar.tsx'), ' M');
  assert.equal(map.get('components/nav-main.tsx'), '??');
  assert.equal(map.get('new.tsx'), 'R ');
  assert.equal(map.get('components/with space.tsx'), '??');
});

test('isAppCode: app/** and components/** count; components/ui/** and non-code do not', () => {
  assert.ok(isAppCode('components/app-sidebar.tsx'));
  assert.ok(isAppCode('app/dashboard/page.tsx'));
  assert.ok(!isAppCode('components/ui/sidebar.tsx'), 'ui/ is the block\'s legitimate value');
  assert.ok(!isAppCode('hooks/use-mobile.ts'), 'hooks have their own handling');
  assert.ok(!isAppCode('app/globals.css'), 'only .ts/.tsx');
  assert.ok(!isAppCode('lib/utils.ts'));
});

test('classifyBlockChanges: only what the add changed counts; pre-existing stays', () => {
  const before = parseStatus([' M package.json', ' M app/already-touched.tsx'].join('\n'));
  const after = parseStatus(
    [
      ' M package.json', // deps step had already touched it — untouched
      ' M app/already-touched.tsx', // same status as before — untouched
      ' M components/app-sidebar.tsx', // overwritten by the add → restore
      ' M components/nav-user.tsx',
      ' M components/ui/sidebar.tsx', // block value → stays
      ' M app/dashboard/page.tsx', // demo over a real page → restore
      '?? components/nav-main.tsx', // new demo → removal candidate
      '?? components/ui/breadcrumb.tsx', // new ui → stays
    ].join('\n'),
  );
  const { restore, created } = classifyBlockChanges(before, after);
  assert.deepEqual(restore, [
    'app/dashboard/page.tsx',
    'components/app-sidebar.tsx',
    'components/nav-user.tsx',
  ]);
  assert.deepEqual(created, ['components/nav-main.tsx']);
});

test('isImported: alias and relative count; no reference does not', () => {
  const sources = [
    'import { NavUser } from "@/components/nav-user"\nexport {}',
    "import { X } from './team-switcher'\n",
  ];
  assert.ok(isImported('components/nav-user.tsx', sources));
  assert.ok(isImported('components/team-switcher.tsx', sources));
  assert.ok(!isImported('components/nav-main.tsx', sources));
});
