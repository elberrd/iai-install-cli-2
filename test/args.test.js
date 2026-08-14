import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, helpText } from '../src/lib/args.js';

test('parseArgs: positional becomes the name', () => {
  const { flags, errors } = parseArgs(['meu-app']);
  assert.equal(flags.name, 'meu-app');
  assert.equal(errors.length, 0);
});

test('parseArgs: value flags with a space and with =', () => {
  const { flags } = parseArgs(['--name', 'app', '--dir=./x', '--shadcn-block', 'dashboard-01,login-01']);
  assert.equal(flags.name, 'app');
  assert.equal(flags.dir, './x');
  assert.equal(flags.shadcnBlock, 'dashboard-01,login-01');
});

test('parseArgs: access flags (--login/--logout/--whoami/--api)', () => {
  const a = parseArgs(['--whoami']);
  assert.equal(a.flags.whoami, true);
  assert.equal(a.errors.length, 0);

  const b = parseArgs(['--logout']);
  assert.equal(b.flags.logout, true);

  const c = parseArgs(['--login', '--api', 'https://dev.convex.site']);
  assert.equal(c.flags.login, true);
  assert.equal(c.flags.api, 'https://dev.convex.site');
  assert.equal(c.errors.length, 0);
});

test('parseArgs: --keys and --tenancy', () => {
  const ok = parseArgs(['--keys', '/tmp/k.env', '--tenancy', 'single']);
  assert.equal(ok.flags.keys, '/tmp/k.env');
  assert.equal(ok.flags.tenancy, 'single');
  assert.equal(ok.errors.length, 0);

  const multi = parseArgs(['--tenancy', 'multi']);
  assert.equal(multi.flags.tenancy, 'multi');
  assert.equal(multi.errors.length, 0); // the availability gate lives in main

  const bad = parseArgs(['--tenancy', 'huge']);
  assert.equal(bad.errors.length, 1);
});

test('parseArgs: --template-ref (branch on the gated path); --template no longer exists', () => {
  const ref = parseArgs(['--template-ref', 'feat/nova-feature']);
  assert.equal(ref.flags.templateRef, 'feat/nova-feature');
  assert.equal(ref.errors.length, 0);

  // --template (fork clone outside the gate) was removed: every download goes
  // through the community API. The flag is now unknown.
  const tpl = parseArgs(['--template', 'fulano/fork#minha-branch']);
  assert.equal(tpl.flags.template, undefined);
  assert.ok(tpl.errors.length > 0, '--template must be rejected as an unknown flag');
});

test('parseArgs: booleans and negation', () => {
  const { flags } = parseArgs(['-y', '--private', '--no-deploy', '--push']);
  assert.equal(flags.yes, true);
  assert.equal(flags.private, true);
  assert.equal(flags.deploy, false);
  assert.equal(flags.push, true);
});

test('parseArgs: harness — opt-in, negation and skip', () => {
  assert.equal(parseArgs(['--harness']).flags.harness, true);
  assert.equal(parseArgs(['--no-harness']).flags.harness, false);
  assert.equal(parseArgs(['--skip-harness']).flags.skipHarness, true);
});

test('parseArgs: --no-update-deps is equivalent to --update-deps none', () => {
  const { flags } = parseArgs(['--no-update-deps']);
  assert.equal(flags.updateDeps, 'none');
});

test('parseArgs: --mode harness | full and invalid value', () => {
  assert.equal(parseArgs(['--mode', 'harness']).flags.mode, 'harness');
  assert.equal(parseArgs(['--mode=full']).flags.mode, 'full');
  assert.ok(parseArgs(['--mode', 'nope']).errors.length > 0);
});

test('parseArgs: --harness-only is sugar for --mode harness', () => {
  const { flags, errors } = parseArgs(['--harness-only']);
  assert.equal(flags.mode, 'harness');
  assert.equal(flags.harnessOnly, undefined);
  assert.equal(errors.length, 0);
  // A conflict with --mode full must produce an error.
  assert.ok(parseArgs(['--harness-only', '--mode', 'full']).errors.length > 0);
});

test('parseArgs: inline value that looks like a flag errors instead of hanging', () => {
  // Regression: `--name=--test` used to reprocess the same token forever
  // (unconditional rewind) until the process ran out of memory.
  const a = parseArgs(['--name=--test']);
  assert.ok(a.errors.length > 0);
  assert.equal(a.flags.name, undefined);
  // The message tells the truth: a value WAS given, it just looks like a flag.
  assert.match(a.errors[0], /"--test" starts with "-"/);
  assert.match(a.errors[0], /looks like a flag, not a value/);

  // Empty inline value is a missing value, not an empty string.
  const empty = parseArgs(['--name=']);
  assert.ok(empty.errors.length > 0);
  assert.equal(empty.flags.name, undefined);
});

test('parseArgs: a short flag is never swallowed as a value', () => {
  const { flags, errors } = parseArgs(['--name', '-y']);
  assert.ok(errors.length > 0, '--name without a value must error');
  assert.equal(flags.name, undefined);
  assert.equal(flags.yes, true, '-y must still be parsed as its own flag');
});

test('parseArgs: --preset completo is a deprecated alias of saas (with a warning)', () => {
  const alias = parseArgs(['--preset', 'completo']);
  assert.equal(alias.errors.length, 0);
  assert.equal(alias.flags.preset, 'saas');
  assert.equal(alias.warnings.length, 1);
  assert.match(alias.warnings[0], /deprecated/);

  const saas = parseArgs(['--preset', 'saas']);
  assert.equal(saas.errors.length, 0);
  assert.equal(saas.warnings.length, 0);

  assert.ok(parseArgs(['--preset', 'tudo']).errors.length > 0);
});

test('parseArgs: helpful errors', () => {
  assert.ok(parseArgs(['--desconhecida']).errors.length > 0);
  assert.ok(parseArgs(['--public', '--private']).errors.length > 0);
  assert.ok(parseArgs(['--update-deps', 'turbo']).errors.length > 0);
  assert.ok(parseArgs(['--name']).errors.length > 0);
});

test('parseArgs: --stack is a value flag (semantics live in lib/stack.js)', () => {
  const a = parseArgs(['--stack', 'recomendada']);
  assert.equal(a.flags.stack, 'recomendada');
  assert.equal(a.errors.length, 0);

  const b = parseArgs(['--stack=backend=hono,db=neon']);
  assert.equal(b.flags.stack, 'backend=hono,db=neon');
});

test('helpText: mentions the main flags', () => {
  const h = helpText();
  for (const flag of ['--yes', '--shadcn-block', '--update-deps', '--push', '--deploy', '--template-id', '--harness', '--stack']) {
    assert.ok(h.includes(flag), `help should mention ${flag}`);
  }
});
