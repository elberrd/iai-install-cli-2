# Manual Clerk migration for existing Impactus projects

Impactus does not run a codemod on projects that are already installed. Apply
this guide on a branch, one protected resource at a time, and keep the existing
Convex authorization tests green throughout.

## 1. Update the Clerk packages

Use these minimum template versions:

```json
{
  "dependencies": {
    "@clerk/backend": "^3.16.4",
    "@clerk/localizations": "^4.15.1",
    "@clerk/nextjs": "^7.6.5"
  },
  "devDependencies": {
    "@clerk/eslint-plugin": "0.2.0",
    "@clerk/testing": "^2.2.17"
  }
}
```

Remove the direct `svix` dependency after the webhook uses Clerk's official
verifier. Keep the ESLint plugin at the exact version because it is
experimental.

## 2. Move protection into each resource

Remove `createRouteMatcher()` and leave `proxy.ts` responsible only for Clerk
initialization and the technical Next.js/Clerk matcher:

```ts
import { clerkMiddleware } from "@clerk/nextjs/server"

export default clerkMiddleware()
```

Every protected `page.tsx`, `layout.tsx`, Route Handler, Server Action, or
server function must verify authentication itself. For a page/layout:

```tsx
import { auth } from "@clerk/nextjs/server"

export default async function ProtectedPage() {
  await auth.protect()
  return <ProtectedClient />
}
```

When the old resource was client-only, move its existing UI into a separate
`"use client"` component and make the route file the server wrapper above.
Protect both the layout and every page so moving or reusing a resource cannot
silently remove its boundary.

Enable `@clerk/next/require-auth-protection` for `app/dashboard/**` and
`app/admin/**`; include `app/onboarding/**` in multi-tenant projects. Keep
`AdminGuard` only for user experience. Admin authorization, permissions, and
organization isolation must still be enforced by Convex guards.

## 3. Keep the Convex JWT contract explicit

Type `convex/auth.config.ts` with `satisfies AuthConfig`, use
`applicationID: "convex"`, and read the issuer from
`CLERK_JWT_ISSUER_DOMAIN`. In Clerk, verify the `convex` JWT configuration has
the claim `{ "aud": "convex" }` and a 3600-second lifetime.

## 4. Replace the webhook verifier and secret name

Import `verifyWebhook` from `@clerk/backend/webhooks`. Pass the original
`Request` to it before reading or parsing the body:

```ts
const secret =
  process.env.CLERK_WEBHOOK_SIGNING_SECRET ??
  process.env.CLERK_WEBHOOK_SECRET

const event = await verifyWebhook(request, { signingSecret: secret })
```

Set new deployments with:

```bash
npx convex env set CLERK_WEBHOOK_SIGNING_SECRET whsec_...
```

Keep `CLERK_WEBHOOK_SECRET` only as a temporary compatibility fallback. Send
internal mutations normalized fields such as `clerkUserId`, `name`, `email`,
and `imageUrl`; validate every field, declare `returns: v.null()`, and make
create/update/delete replays idempotent.

## 5. Make first access independent of the webhook

Mount a small client `UserBootstrap` under the authenticated Clerk + Convex
providers. It calls an authenticated `users.ensure` mutation on first load.
That mutation inserts or updates the local user mirror from the verified
Convex identity. The webhook then becomes optional for signup/first access,
while remaining necessary for out-of-band profile changes and deletions.

Preserve `SUPERADMIN_EMAILS`, existing admin guards, and organization guards.
An upsert from Clerk must never reset a user's admin, blocked, membership, or
active-organization state.

## 6. Separate Preview and Production

Development `pk_test_`/`sk_test_` and Convex dev values may be used locally and
in Vercel Preview only. Do not add them to Vercel Production.

Production is an explicit `/launch` flow and requires all of the following:

- final own domain;
- matching Clerk `pk_live_` and `sk_live_` keys;
- Convex Production deployment/deploy key;
- production Clerk webhook and `CLERK_WEBHOOK_SIGNING_SECRET`;
- production Clerk issuer configured on Convex.

## 7. Verify the migration

Run lint, type-check, unit tests, format-check, and a production build. Add a
static test or lint gate that fails if `createRouteMatcher` returns or if any
protected page/layout omits `auth.protect()`.

For authenticated Playwright tests, use `@clerk/testing`, `clerkSetup()`, and
testing-token sign-in helpers. Keep CI secret-gated and skip explicitly when
the development publishable key, secret key, or test-user email is missing.

Finally run:

```bash
npx -y clerk@3.1.0 --mode agent doctor --json --spotlight
```

Do not run `--fix` automatically. Development-key and telemetry notices are
expected locally/Preview. Clear localhost cookies only for a 431 error, a
login loop, or after switching the project to a different Clerk instance.
