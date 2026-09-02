/**
 * Constants shared between an auth route and the email template that
 * describes what that route just did.
 *
 * It exists because those two live in different layers on purpose —
 * `notify/auth-email.ts` is a pure module with no I/O and no knowledge of
 * Express, so it cannot import from `api/` — and the one number they both need
 * was therefore written down twice: once as `MAGIC_LINK_EXPIRES_MS` in
 * `api/auth-routes.ts`, and once as the words "15 minutes" in the sentence a
 * recipient actually reads.
 *
 * Two copies of a duration is a small thing right up until somebody changes
 * the policy. Then the link quietly dies at 5 minutes while the email keeps
 * promising 15, and nothing anywhere fails — the drift only ever shows up as a
 * person insisting their link expired early. Neither a type checker nor a test
 * of either module alone can see it.
 *
 * Kept under `auth/` rather than in `api/auth-urls.ts` so the pure template
 * module can import it without reaching into the route layer.
 *
 * **A THIRD copy exists** (viewer-membership Task 15 review): the "sent"
 * state on `viewer/app/signin/page.tsx`'s `SIGN_IN_LINK_SENT` also spells
 * out "15 minutes", literally rather than by import — `viewer/app` ships to
 * the browser and `viewer/server` pulls in Node-only modules, so app code
 * cannot import this constant the way `auth-email.ts` does. That page's own
 * `page.test.ts` imports `SIGN_IN_LINK_TTL_MINUTES` from HERE and asserts the
 * sentence still contains it, which is what stands in for the import this
 * layering rule forbids.
 *
 * **A separate prose copy, same shape, different number** (viewer-membership
 * post-review follow-up): `viewer/app/settings/members-panel.tsx`'s
 * `SIGN_IN_LINK_EXPIRES_COPY` spells out "24 hours" for an ADMIN-ISSUED sign-in
 * link — a different link kind with a different TTL,
 * `ADMIN_SIGN_IN_LINK_TTL_HOURS` below. Same app/server layering rule, same
 * fix: `members-panel.test.ts` imports `ADMIN_SIGN_IN_LINK_TTL_HOURS` from
 * HERE and asserts the copy still contains it.
 */

/**
 * How long a self-requested magic link is valid, in minutes.
 *
 * The route derives its expiry from this, and `signInEmail` renders it into
 * the copy. Admin-issued links deliberately use a DIFFERENT, much longer TTL
 * (`ADMIN_SIGN_IN_LINK_TTL_HOURS` below) and are not emailed by the viewer at
 * all, so they do not read this.
 */
export const SIGN_IN_LINK_TTL_MINUTES = 15

/**
 * An ADMIN-ISSUED sign-in link's lifetime, in hours — against the 15 minutes
 * a self-requested magic link gets above. The reasoning lives on the route
 * that mints it (`api/instance-routes.ts`'s
 * `POST /instance/members/:userId/signin-link`); the short version is that
 * the recipient is a third party who may be offline, so a 15-minute link
 * would mostly arrive dead.
 *
 * `instance-routes.ts` derives its millisecond expiry from this, and
 * `members-panel.tsx`'s link-reveal copy renders the number directly (see
 * `SIGN_IN_LINK_EXPIRES_COPY` there).
 */
export const ADMIN_SIGN_IN_LINK_TTL_HOURS = 24
