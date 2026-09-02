import express, { type Express } from "express"

/**
 * One stable Express app object per test file, delegating to a swappable inner
 * app.
 *
 * ## Why this exists
 *
 * `supertest-reuse.ts` memoizes ONE listening server per app OBJECT (a
 * `WeakMap` keyed on the app). That memoization does nothing for a test file
 * that builds a fresh app in `beforeEach` or inside a loop: every new object is
 * a new ephemeral-port server. Across a parallel run that churn is the
 * documented cause of this suite's transport-level flakiness — see the "Why"
 * section of `supertest-reuse.ts`.
 *
 * An Express app IS a request handler, so an outer app can simply call the
 * inner one. Keeping the OUTER object stable while replacing the INNER one
 * gives each test a genuinely fresh app (fresh storage, fresh config, fresh
 * fakes) while the file as a whole opens exactly one server.
 *
 * ## Usage
 *
 *   const stable = createSwappableApp()
 *   beforeEach(() => {
 *     storage = new InMemoryStorage()
 *     stable.use(createApp({ storage, ... }))
 *   })
 *   // then: request(stable.app).get("/api/v1/...")
 *
 * Pass `stable.app` to `request()` — never a freshly built app.
 *
 * ## The one thing this cannot do
 *
 * The last `use()` wins, for everybody. A single test that installs app A,
 * installs app B, and THEN issues requests it believes go to A is silently
 * wrong — and still passes, which is the worst failure mode there is.
 * Installing A, fully awaiting its requests, then installing B is fine; that
 * is the common "seed through one app, assert through another" shape. When a
 * test genuinely needs two apps live at once, give it its own
 * `createSwappableApp()` instance. Two servers for a file is still an order of
 * magnitude better than one per test, and it keeps the test honest.
 */
export interface SwappableApp {
  /** Stable across the whole file. This is what `request()` must receive. */
  app: Express
  /** Replace the app handling subsequent requests. */
  use(inner: Express): void
}

export function createSwappableApp(): SwappableApp {
  let inner: Express | null = null
  const outer = express()

  outer.use((req, res, next) => {
    if (!inner) {
      // A test that requests before installing an inner app is a test bug.
      // Answer 500 rather than hanging: a hang shows up as an opaque suite
      // timeout minutes later, in a different file.
      next(new Error("createSwappableApp: no inner app installed — call use(app) first"))
      return
    }
    inner(req, res, next)
  })

  return {
    app: outer,
    use(next: Express) {
      inner = next
    },
  }
}
