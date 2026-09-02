import express from "express"
import request from "supertest"
import { describe, expect, it } from "vitest"

import { createSwappableApp } from "./swappable-app"

/**
 * This file eats its own cooking.
 *
 * An earlier version gave every test its own `createSwappableApp()`, which made
 * the helper's own test file the largest remaining source of listening servers
 * in the suite — 10 of the 31 left after the migration. That is the exact
 * pattern the helper exists to remove, and a 300-run sweep put its single
 * transport failure in this file.
 *
 * So the tests that merely need "install an inner app, then request it" share
 * ONE instance and swap the inner app, which is precisely the usage being
 * documented. Only three tests keep their own instance, and each has a reason
 * it cannot share:
 *
 *   - object identity across swaps (asserts on the object, issues no request,
 *     so it opens no server at all)
 *   - the no-inner-installed case, which needs an instance nothing has ever
 *     been installed into
 *   - independence, which needs two live instances by definition
 *
 * 10 servers to 4.
 */
const stable = createSwappableApp()

describe("createSwappableApp", () => {
  it("returns the SAME app object across swaps", () => {
    // Its own instance, and deliberately no request: this asserts on the
    // object, so it never needs a server.
    const own = createSwappableApp()
    const first = own.app
    own.use(express().use((_req, res) => res.json({ n: 1 })))
    const second = own.app
    // Identity is the whole point: supertest-reuse memoizes its server on
    // this object, so a new object per test means a new server per test.
    expect(second).toBe(first)
  })

  it("routes to whichever inner app is currently installed", async () => {
    stable.use(express().use((_req, res) => res.json({ which: "a" })))
    const a = await request(stable.app).get("/x").expect(200)
    expect(a.body).toEqual({ which: "a" })

    stable.use(express().use((_req, res) => res.json({ which: "b" })))
    const b = await request(stable.app).get("/x").expect(200)
    expect(b.body).toEqual({ which: "b" })
  })

  it("preserves the inner app's status codes and headers", async () => {
    stable.use(
      express().use((_req, res) => {
        res.setHeader("X-Custom", "yes")
        res.status(403).json({ error: "nope" })
      }),
    )
    const res = await request(stable.app).get("/x").expect(403)
    expect(res.headers["x-custom"]).toBe("yes")
    expect(res.body).toEqual({ error: "nope" })
  })

  it("fails loudly rather than hanging when no inner app is installed", async () => {
    // Must be a virgin instance — the shared one has an inner app by now.
    const untouched = createSwappableApp()
    const res = await request(untouched.app).get("/x")
    expect(res.status).toBe(500)
  })

  // ---------------------------------------------------------------------
  // The properties the migrations in this plan actually depend on. Each of
  // these is something a real test file asserts THROUGH the wrapper, so if
  // delegation dropped it the migration would change behaviour silently.
  // ---------------------------------------------------------------------

  it("passes method, path, query and route params through to the inner app", async () => {
    const inner = express()
    inner.get("/p/:slug/thing", (req, res) => {
      res.json({ slug: req.params.slug, q: req.query.v, method: req.method })
    })
    stable.use(inner)

    const res = await request(stable.app).get("/p/acme/thing?v=7").expect(200)
    expect(res.body).toEqual({ slug: "acme", q: "7", method: "GET" })
  })

  it("passes request headers and JSON bodies through", async () => {
    const inner = express()
    inner.use(express.json())
    inner.post("/echo", (req, res) => {
      res.json({ body: req.body, cookie: req.headers.cookie ?? null })
    })
    stable.use(inner)

    const res = await request(stable.app)
      .post("/echo")
      .set("Cookie", "viewer_session=abc")
      .send({ hello: "world" })
      .expect(200)
    expect(res.body).toEqual({ body: { hello: "world" }, cookie: "viewer_session=abc" })
  })

  // `root-asset-fallback.test.ts` asserts 404 as "the middleware called
  // next()". That 404 comes from Express's default final handler — which,
  // once nested, belongs to the OUTER app. If delegation swallowed the
  // fall-through, those tests would go from 404 to a hang or a 500.
  it("still 404s when the inner app declines to handle the request", async () => {
    const inner = express()
    inner.use((_req, _res, next) => next())
    stable.use(inner)

    const res = await request(stable.app).get("/nothing-here")
    expect(res.status).toBe(404)
  })

  it("surfaces an error thrown inside the inner app as a 500, not a hang", async () => {
    const inner = express()
    inner.use(() => {
      throw new Error("boom")
    })
    stable.use(inner)

    const res = await request(stable.app).get("/x")
    expect(res.status).toBe(500)
  })

  it("lets the inner app's OWN error handler win, as it would unmounted", async () => {
    const inner = express()
    inner.use(() => {
      throw new Error("boom")
    })
    inner.use(((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(418).json({ handled: err.message })
    }) as express.ErrorRequestHandler)
    stable.use(inner)

    const res = await request(stable.app).get("/x").expect(418)
    expect(res.body).toEqual({ handled: "boom" })
  })

  it("keeps two instances independent, so a file can hold two live apps", async () => {
    // Two by definition — this is the auth-routes `stable` / `stableAlt` shape.
    const one = createSwappableApp()
    const two = createSwappableApp()
    one.use(express().use((_req, res) => res.json({ which: "one" })))
    two.use(express().use((_req, res) => res.json({ which: "two" })))

    expect(one.app).not.toBe(two.app)
    expect((await request(one.app).get("/x").expect(200)).body).toEqual({ which: "one" })
    expect((await request(two.app).get("/x").expect(200)).body).toEqual({ which: "two" })
  })
})
