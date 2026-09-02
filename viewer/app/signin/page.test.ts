/**
 * `SIGN_IN_LINK_SENT` (viewer-membership Task 15, review fix) — the "sent"
 * copy on `/signin` spells out "15 minutes" as a literal, because app code
 * cannot import server code (`viewer/app` ships to the browser;
 * `viewer/server` pulls in Node-only modules like `better-sqlite3`). That
 * literal is a THIRD copy of a duration whose single source of truth is
 * `SIGN_IN_LINK_TTL_MINUTES` (`viewer/server/auth/auth-constants.ts`) — the
 * other two are `auth-routes.ts`'s `MAGIC_LINK_EXPIRES_MS` and
 * `notify/auth-email.ts`'s rendered sentence, both of which import the
 * constant directly since they live in `server/`.
 *
 * This test is what a page can do INSTEAD of that import: it imports the
 * constant itself (tests can reach into `server/` — only `app/` runtime code
 * cannot) and asserts the copy still contains it. Change
 * `SIGN_IN_LINK_TTL_MINUTES` without updating this page's copy and this test
 * fails, rather than the sentence silently going stale the way the pre-Task-14
 * duplication did (see `auth-constants.ts`'s own doc comment on that history).
 */

import { describe, expect, it } from "vitest"
import { SIGN_IN_LINK_TTL_MINUTES } from "../../server/auth/auth-constants"
import { SIGN_IN_LINK_SENT } from "./page"

describe("SIGN_IN_LINK_SENT", () => {
  it("still tracks SIGN_IN_LINK_TTL_MINUTES", () => {
    expect(SIGN_IN_LINK_SENT).toContain(`${SIGN_IN_LINK_TTL_MINUTES} minutes`)
  })
})
