import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { PAGE } from '../fia-templates/scripts/fia-viewer-page.mjs';
import {
  parseExamples,
  readPlanExamples,
  licenseRisk,
  normExampleStatus,
  readPlanOverview,
  listPlanDocs,
} from '../fia-templates/scripts/plan-docs.mjs';

/**
 * Fabricate an ai-docs/examples/ tree the way the shelf really looks in the
 * field: fenced sample rows, a commented-out row, the shipped 0000 reference
 * entry, a duplicated slug, a `{{placeholder}}` row and an entry whose NOTES.md
 * has not landed yet — the parser must degrade, never throw.
 */
function seedExamples(root) {
  const dir = join(root, 'ai-docs');
  mkdirSync(join(dir, 'examples', 'cal-com'), { recursive: true });
  mkdirSync(join(dir, 'examples', '0000-example-entry'), { recursive: true });

  writeFileSync(
    join(dir, 'examples', 'registry.md'),
    [
      '# Example library',
      '',
      'Example rows (the real entries ALWAYS go between the markers below):',
      '',
      '```',
      '| Fenced | repo | auth | https://example.com/fenced | never counts | MIT | referenced |',
      '```',
      '',
      '| Example | Kind | Tags | Source | What to take | License | Status |',
      '|---|---|---|---|---|---|---|',
      '<!-- registry:start -->',
      '<!-- Row the engineer commented out:',
      '| Ghost | repo | auth | https://example.com/ghost | nothing | MIT | referenced |',
      '-->',
      '|:---|:---:|---|---|---|---|---|',
      '| [Cal.com](cal-com/NOTES.md) | repo | scheduling, Availability · multi-tenant | https://github.com/calcom/cal.com | ' +
        '`lib/slots.ts` splits availability from bookings | AGPL-3.0 | referenced |',
      '| Shadcn dashboard | design | dashboard, data-table | https://ui.shadcn.com/examples/dashboard | ' +
        'density and spacing of the KPI row | n/a | Excerpted |',
      '| Stripe billing | docs | billing, subscriptions | [the docs](https://stripe.com/docs/billing) | ' +
        'the proration model end to end | MIT | archived |',
      '| Upload service | code | file-upload | https://example.dev/upload.ts | chunked upload with resume | | referenced |',
      '| [Cal.com again](cal-com/NOTES.md) | repo | scheduling | https://github.com/calcom/cal.com | duplicated row | MIT | referenced |',
      '| [Reference entry](0000-example-entry/NOTES.md) | repo | auth | https://example.com | shows the format | MIT | referenced |',
      '| {{NAME}} | {{KIND}} | {{TAGS}} | {{SOURCE}} | {{WHAT_TO_TAKE}} | {{LICENSE}} | referenced |',
      '| Name only |  |  |  |  |  |  |',
      '<!-- registry:end -->',
      '| Outside | repo | auth | https://example.com/outside | does not count | MIT | referenced |',
      '',
    ].join('\n'),
  );
  writeFileSync(join(dir, 'examples', 'cal-com', 'NOTES.md'), '# Cal.com\n\n## What NOT to take\n- the AGPL code itself.\n');
  writeFileSync(join(dir, 'examples', 'cal-com', 'slot-math.md'), '# Slot math\n');
  writeFileSync(join(dir, 'examples', '0000-example-entry', 'NOTES.md'), '# Reference entry (REFERENCE)\n');
  return dir;
}

test('parseExamples: E1 rows only — fences, comments, ghosts and 0000 dropped', () => {
  const root = mkdtempSync(join(tmpdir(), 'plan-ex-'));
  const dir = seedExamples(root);
  const rows = parseExamples(readFileSync(join(dir, 'examples', 'registry.md'), 'utf8'));
  assert.equal(rows.length, 4, 'fenced, commented, outside, duplicated, 0000 and placeholder rows never count');
  assert.deepEqual(rows.map((e) => e.slug), ['cal-com', 'shadcn-dashboard', 'stripe-billing', 'upload-service']);

  const cal = rows[0];
  assert.equal(cal.name, 'Cal.com', 'the link label is the name, the link target the slug');
  assert.equal(cal.kind, 'repo');
  assert.deepEqual(cal.tags, ['scheduling', 'availability', 'multi-tenant'], 'lowercased, comma or · separated');
  assert.equal(cal.source, 'https://github.com/calcom/cal.com');
  assert.equal(cal.take, 'lib/slots.ts splits availability from bookings', 'backticks stripped');
  assert.equal(cal.license, 'AGPL-3.0');
  assert.equal(cal.licenseRisk, 'restricted');
  assert.equal(cal.status, 'referenced');

  assert.equal(rows[1].status, 'excerpted', 'status vocabulary is case-insensitive');
  assert.equal(rows[1].licenseRisk, 'none', 'n/a — a design reference has no code to copy');
  assert.equal(rows[2].source, 'https://stripe.com/docs/billing', 'a markdown link in Source is unwrapped');
  assert.equal(rows[2].status, 'archived');
  assert.equal(rows[3].license, null);
  assert.equal(rows[3].licenseRisk, 'restricted', 'an unstated license is never copyable');

  // A missing/empty document is an empty shelf, not a throw.
  assert.deepEqual(parseExamples(''), []);
  assert.deepEqual(parseExamples(null), []);
  assert.deepEqual(parseExamples('# Example library\n\nNo table here at all.\n'), []);
});

test('licenseRisk / normExampleStatus: the copy guardrail vocabulary', () => {
  assert.equal(licenseRisk('MIT'), 'permissive');
  assert.equal(licenseRisk('Apache-2.0'), 'permissive');
  assert.equal(licenseRisk('AGPL-3.0'), 'restricted');
  assert.equal(licenseRisk('GPL-2.0-only'), 'restricted');
  assert.equal(licenseRisk('unknown'), 'restricted');
  // Unfilled and empty cells are treated as unknown — the safe side.
  assert.equal(licenseRisk('{{LICENSE}}'), 'restricted');
  assert.equal(licenseRisk('—'), 'restricted');
  assert.equal(licenseRisk(''), 'restricted');
  assert.equal(licenseRisk('n/a'), 'none');

  assert.equal(normExampleStatus('excerpted'), 'excerpted');
  assert.equal(normExampleStatus('Archived'), 'archived');
  assert.equal(normExampleStatus('referenced'), 'referenced');
  assert.equal(normExampleStatus(''), 'referenced', 'link-only is the least-committing state');
});

test('readPlanExamples: NOTES.md link only when it exists; no file → available:false', () => {
  const root = mkdtempSync(join(tmpdir(), 'plan-ex-'));
  const dir = seedExamples(root);
  const r = readPlanExamples(dir);
  assert.equal(r.available, true);
  assert.equal(r.file, 'examples/registry.md');
  assert.equal(r.examples.length, 4);
  assert.equal(r.examples[0].file, 'examples/cal-com/NOTES.md');
  assert.equal(r.examples[1].file, null, 'registered before its detail page exists');
  assert.deepEqual(r.counts, { total: 4, referenced: 2, excerpted: 1, archived: 1, restricted: 2 });

  assert.equal(readPlanExamples(join(root, 'nope')).available, false);
  assert.deepEqual(readPlanExamples(join(root, 'nope')).examples, []);
});

test('readPlanOverview: carries the shelf and indexes examples/**', () => {
  const root = mkdtempSync(join(tmpdir(), 'plan-ex-'));
  const dir = seedExamples(root);
  const o = readPlanOverview(dir, root);
  assert.equal(o.examples.available, true);
  assert.equal(o.examples.examples.length, 4);
  assert.equal(o.counts.examples, 4);

  const docs = listPlanDocs(dir);
  const paths = docs.map((f) => f.path);
  assert.ok(paths.includes('examples/registry.md'));
  assert.ok(paths.includes('examples/cal-com/NOTES.md'));
  // Any other markdown an entry carries is readable too, under its own label.
  assert.equal(docs.find((f) => f.path === 'examples/cal-com/slot-math.md').label, 'Example — cal com · slot-math');
  // The reference entry is readable (it documents the format), exactly like
  // specs/0000-example.md — it just never counts as a real example.
  assert.ok(paths.includes('examples/0000-example-entry/NOTES.md'));

  // No examples/ folder at all → the overview still answers, empty.
  const bare = mkdtempSync(join(tmpdir(), 'plan-ex-'));
  mkdirSync(join(bare, 'ai-docs'), { recursive: true });
  const o2 = readPlanOverview(join(bare, 'ai-docs'), bare);
  assert.equal(o2.examples.available, false);
  assert.equal(o2.counts.examples, 0);
});

test('viewer: the Example library card is in the page and the script still compiles', () => {
  assert.match(PAGE, /Example library/);
  assert.match(PAGE, /examples\/registry\.md/);
  // The whole page lives in one template literal — a missed escape breaks the
  // browser silently. Compiling the served script catches it here.
  const src = PAGE.slice(PAGE.indexOf('<script>') + 8, PAGE.lastIndexOf('</script>'));
  assert.doesNotThrow(() => new vm.Script(src));
  assert.ok(!src.includes('${'), 'inner script must not contain template interpolation');
});
