# Holdout probes

Acceptance checks the builder never optimizes against.

Every other check in the FIA gate — tests, lint, the checklist, the UI gate —
sits **inside** the builder's loop: the agent can read it, run it, and iterate
until it is green. A holdout probe sits **outside** that loop. Probes live in
this directory, which agents cannot write (the permission gate rolls back any
agent edit here), and a probe failure ends the run with **no repair round**:
the violation is reported to you, never fed back to the builder.

## The contract

- Every `*.mjs` file here (except this README and `_`-prefixed helpers) is one
  probe. Files are run as **bare `node <file>`** from the project root.
- **Exit 0** = the invariant holds. Any other exit = violation. Print what you
  checked — the output is shown when the probe fails.
- Probes run in the `holdout` phase of `/task`-style runs after the suite goes
  green, and on demand with `npm run holdout` (add `-- --require` to make an
  empty directory a failure).

**Bare `node` means no bundler**: no TypeScript path aliases (`@/lib/x`), no
`.tsx`, and no `.ts` at all unless your Node build strips types. Import a
plain `.js`/`.mjs` seam, or assert across a process/HTTP boundary. A probe
that cannot even load exits non-zero, which counts as a **violation** — so
run each new probe once by hand: it must fail on its assertion, never on
module resolution.

## Writing a good probe

- **Write it with the brief, before the code exists.** A scenario written
  after seeing the implementation is a description of the implementation.
- **Compose.** The dominant real failure is not cheating — it is feature
  isolation: components individually correct that never work together. Assert
  something no single unit test is positioned to see.
- **Assert the property, not one algebraic consequence of it.** A derived
  constant here is a second silent copy of a decision, and it goes stale.
- **Duplicate, do not import.** Nothing here should import the app's test
  helpers or fixtures — importing the suite's setup puts the probe inside the
  same loop it exists to sit outside of.

## Example

Probes run with the **project root as cwd**, but a relative `import` resolves
against the probe FILE (three levels down: `imp/data/holdout/`). Anchoring on
`process.cwd()` is therefore the form that cannot be miscounted:

```js
// 001-signup-rate-limit-composes.mjs — the limiter and the normalizer
// actually compose: two spellings of the same user share one budget.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { canSend } = await import(pathToFileURL(join(process.cwd(), 'app/lib/rate-limit.js')).href);

for (let i = 0; i < 25; i++) assert.ok(canSend('User@Example.com'));
assert.equal(canSend('user@example.com'), false, 'case variant must share the same daily budget');
console.log('rate limit composes with normalization: ok');
```

The relative form works too, as long as you count the three levels out of
`imp/data/holdout/`: `await import('../../../app/lib/rate-limit.js')`.
