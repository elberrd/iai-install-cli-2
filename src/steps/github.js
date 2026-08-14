import { run } from '../lib/proc.js';
import { slugify } from '../lib/util.js';
import * as ui from '../lib/ui.js';

/**
 * Final git step: commit everything the installer configured and, optionally,
 * create a GitHub repository (private by default) and push.
 *
 * The local repo + initial template commit already exist (installTemplate).
 * Here we add a second commit with the user's customizations, then offer
 * `gh repo create` — the gh CLI is guaranteed installed/authenticated by the
 * preflight step. Flags: --skip-github, --push/--no-push, --repo <name>,
 * --private/--public, --yes (commit only, no push).
 */
export async function setupGithub(ctx) {
  const { dir, flags } = ctx;

  if (flags.skipGithub) {
    ui.info('Skipped (--skip-github): no commit and no push.');
    return;
  }

  // ── 1. Commit the configured project ──────────────────────────────────────
  ui.step('Saving the configured project in git…');
  await run('git', ['add', '-A'], { cwd: dir });
  const commit = await run(
    'git',
    ['commit', '-q', '-m', 'feat: project configured by create-iai (Convex + Clerk + shadcn/ui)'],
    { cwd: dir },
  );
  const commitOut = commit.stdout + commit.stderr;
  if (commit.ok) {
    ui.success('Commit created.');
  } else if (/nothing to commit/i.test(commitOut)) {
    ui.info('Nothing new to commit.');
  } else if (/lefthook|eslint|husky/i.test(commitOut)) {
    // The template's pre-commit hook (lefthook → eslint) rejected some file.
    // Blaming "git identity" here sent the student to the wrong fix — show
    // the actual lint output and the documented escape hatch.
    ui.warn(
      [
        'The commit was blocked by the template lint (lefthook/eslint):',
        commitOut.trim().split('\n').slice(-12).join('\n'),
        '',
        'Fix the files above and run:  git add -A && git commit -m "initial setup"',
        'To commit anyway (one time):  LEFTHOOK=0 git commit -m "initial setup"',
      ].join('\n'),
    );
    return; // without a commit there is nothing to push
  } else {
    ui.warn(
      [
        "Couldn't commit (missing git identity?). Configure it and run:",
        '  git config --global user.name "Your Name"',
        '  git config --global user.email "you@example.com"',
        '  git add -A && git commit -m "initial setup"',
      ].join('\n'),
    );
    return; // without a commit there is nothing to push
  }

  // ── 2. Optional: create the GitHub repo + push ─────────────────────────────
  // The decision came from the decisions phase; the prompts below are only a
  // fallback for calls outside the standard pipeline.
  let wantsPush = ctx.decisions?.push ?? flags.push;
  if (wantsPush == null) {
    if (flags.yes) {
      wantsPush = false; // creating a remote repo is irreversible — don't do it by default in -y mode
    } else {
      wantsPush = await ui.confirm({
        message: 'Create a GitHub repository and push now?',
        initialValue: true,
      });
    }
  }
  if (!wantsPush) {
    ui.note(
      ['Whenever you want to publish:', `  gh repo create ${ctx.slug} --private --source=. --remote=origin --push`].join('\n'),
      'How to publish to GitHub later',
    );
    return;
  }

  // Repository name (default: same slug as the app).
  let repoName = ctx.decisions?.repoName || flags.repo;
  if (!repoName) {
    repoName = flags.yes
      ? ctx.slug
      : slugify(
          String(
            await ui.text({
              message: 'GitHub repository name:',
              placeholder: ctx.slug,
              defaultValue: ctx.slug,
              validate: (v) => (v && v.trim() ? undefined : 'Enter a name.'),
            }),
          ),
        );
  }

  // Visibility (default: private).
  let visibility =
    ctx.decisions?.visibility ??
    (flags.public ? 'public' : flags.private || flags.yes ? 'private' : null);
  if (!visibility) {
    visibility = await ui.select({
      message: 'Repository visibility:',
      initialValue: 'private',
      options: [
        { value: 'private', label: 'Private', hint: 'recommended — only you (and whoever you invite)' },
        { value: 'public', label: 'Public', hint: 'anyone can see the code' },
      ],
    });
  }

  ui.step(`Creating the repository ${repoName} (${visibility}) and pushing…`);
  const create = await run(
    'gh',
    ['repo', 'create', repoName, `--${visibility}`, '--source=.', '--remote=origin', '--push'],
    { cwd: dir },
  );
  if (create.ok) {
    const view = await run('gh', ['repo', 'view', '--json', 'url', '-q', '.url'], { cwd: dir });
    ctx.repoUrl = view.ok ? view.stdout.trim() : null;
    ui.success(`Repository published${ctx.repoUrl ? `: ${ctx.repoUrl}` : '.'}`);
  } else {
    ui.warn(
      [
        "Couldn't create/push the repository. Detail:",
        `  ${(create.stderr || create.stdout).trim().split('\n')[0]}`,
        '',
        'You can try manually in the project folder:',
        `  gh repo create ${repoName} --${visibility} --source=. --remote=origin --push`,
      ].join('\n'),
    );
  }
}
