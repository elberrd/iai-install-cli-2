import { runInherit } from '../lib/proc.js';
import * as ui from '../lib/ui.js';

/**
 * Optional step: refresh the template's dependencies right after the download.
 *
 * The template pins versions that are known to work together. This step lets
 * the user opt into newer versions:
 *   - keep → do nothing (default; guaranteed-compatible versions)
 *   - safe → `npm update --save`: newest versions *within* the semver ranges
 *            declared by the template (patch/minor). Low risk.
 *
 * A "latest" mode (npm-check-updates -u) existed until v0.4.x and was removed
 * on purpose: bumping majors (Next.js, Convex, Clerk…) on a template that was
 * tested with pinned versions broke projects before the first `npm run dev`.
 * Whoever wants that can run `npx npm-check-updates -i` later, package by
 * package, with the app already running.
 *
 * Controlled by `--update-deps none|safe`; `--yes` keeps the template
 * versions.
 */
export async function maybeUpdateDeps(ctx) {
  const { dir, flags } = ctx;

  // The decision comes from the decisions phase (ctx.decisions); the
  // interactive fallback below only exists for calls outside the standard
  // pipeline.
  let mode = ctx.decisions?.updateDeps ?? flags.updateDeps;
  if (!mode && flags.yes) mode = 'none';

  if (!mode) {
    ui.note(
      [
        'The template pins versions tested to be compatible with each other.',
        'If you want, I can update the dependencies now:',
        '',
        'safe  → only patch/minor within the template ranges (low risk)',
      ].join('\n'),
      'Dependencies — update? (optional)',
    );
    mode = await ui.select({
      message: 'How should dependency versions be handled?',
      initialValue: 'none',
      options: [
        { value: 'none', label: 'Keep the template versions', hint: 'recommended — tested' },
        { value: 'safe', label: 'Safe update (npm update)', hint: 'patch/minor only' },
      ],
    });
  }

  if (mode !== 'safe') {
    ui.info('Keeping the template versions.');
    return;
  }

  ui.step('Updating dependencies within the template ranges (npm update --save)…');
  const r = await runInherit('npm', ['update', '--save'], { cwd: dir });
  if (r.ok) ui.success('Dependencies updated (patch/minor).');
  else ui.warn('`npm update` failed — continuing with the versions the template shipped.');
  ctx.depsUpdate = 'safe';
}
