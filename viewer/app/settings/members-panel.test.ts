/**
 * `SIGN_IN_LINK_EXPIRES_COPY` (viewer-membership post-review follow-up) —
 * the admin-issued sign-in link reveal on `members-panel.tsx` spells out
 * "24 hours" as a literal, because app code cannot import server code
 * (`viewer/app` ships to the browser; `viewer/server` pulls in Node-only
 * modules like `better-sqlite3`). That literal is a copy of a duration whose
 * single source of truth is `ADMIN_SIGN_IN_LINK_TTL_HOURS`
 * (`viewer/server/auth/auth-constants.ts`), which `instance-routes.ts`
 * derives its millisecond expiry from directly since it lives in `server/`.
 *
 * This test is what a component can do INSTEAD of that import: it imports
 * the constant itself (tests can reach into `server/` — only `app/` runtime
 * code cannot) and asserts the copy still contains it. Change
 * `ADMIN_SIGN_IN_LINK_TTL_HOURS` without updating this panel's copy and this
 * test fails, rather than the sentence silently going stale — mirrors
 * `viewer/app/signin/page.test.ts`'s pin on `SIGN_IN_LINK_TTL_MINUTES`.
 */

import { describe, expect, it } from "vitest"
import { ADMIN_SIGN_IN_LINK_TTL_HOURS } from "../../server/auth/auth-constants"
import { SIGN_IN_LINK_EXPIRES_COPY } from "./members-panel"

describe("SIGN_IN_LINK_EXPIRES_COPY", () => {
  it("still tracks ADMIN_SIGN_IN_LINK_TTL_HOURS", () => {
    expect(SIGN_IN_LINK_EXPIRES_COPY).toContain(`${ADMIN_SIGN_IN_LINK_TTL_HOURS} hours`)
  })
})
