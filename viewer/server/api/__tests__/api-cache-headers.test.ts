/**
 * Every `/api/v1` response says it must not be cached, and says it varies by
 * cookie. Added 2026-09-10, after a reader watching a GitHub setup could not
 * get the viewer to show them the new state until they did a HARD refresh.
 *
 * The two headers answer two different problems.
 *
 * `Cache-Control: private, no-store` is about correctness. Express stamps an
 * `ETag` on every `res.json`, and a response that carries a validator with no
 * freshness directive is one a browser is entitled to reuse from its own
 * cache. A hard refresh is the one kind of reload that bypasses that cache,
 * which is exactly the shape of "I had to hard-refresh for it to work".
 *
 * `Vary: Cookie` is about who sees what. These responses are per-caller by
 * construction and their URLs carry no user: `/github/installations` returns
 * the accounts THIS reader may see, which is authorization input for the
 * connect-repo surface. A cache keyed on the URL alone would hand one
 * reader's account list to the next.
 *
 * Four routes set this pair by hand before the default existed. The point of
 * testing it at the ROUTER is that a route added tomorrow inherits it without
 * anyone remembering to.
 */

import express from "express"
import request from "supertest"
import { describe, expect, it } from "vitest"
import { InMemoryStorage } from "../../storage/in-memory-storage"
import { createApp } from "../../__tests__/test-app"
import { loadConfig } from "../../config"
import { tmpViewerDataDir } from "../../__tests__/test-config"
import { testGithubRuntime } from "../../__tests__/test-github-runtime"
import type { AssetStore } from "../../assets/types"

const nullAssets: AssetStore = {
  async put() {},
  async get() {
    return null
  },
  async deleteDeployment() {},
}

function setup() {
  // desde-allow-own-server: one app for the file, holding no per-test state —
  // every case below is a bare GET against a constant router.
  const app = express()
  app.use(
    createApp({
      storage: new InMemoryStorage(),
      assets: nullAssets,
      config: loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir() }),
      bridgeScript: "// bridge",
      github: testGithubRuntime(),
    }),
  )
  return app
}

describe("API cache headers", () => {
  it("marks a signed-out API response no-store and cookie-varying", async () => {
    // Signed out on purpose: the headers are a property of the PREFIX, not of
    // a route that happened to authenticate. A 401 is as uncacheable as a 200
    // — cache a refusal and the reader stays refused after signing in.
    const res = await request(setup()).get("/api/v1/github/installations")
    expect(res.headers["cache-control"]).toBe("private, no-store")
    expect(res.headers["vary"]).toContain("Cookie")
  })

  it("marks even the unauthenticated health route no-store", async () => {
    // `/health` needs no protection of its own. It is here because it is the
    // route most likely to be seen as an exception, and an exception is where
    // the next route gets added.
    const res = await request(setup()).get("/api/v1/health")
    expect(res.status).toBe(200)
    expect(res.headers["cache-control"]).toBe("private, no-store")
    expect(res.headers["vary"]).toContain("Cookie")
  })

  it("composes with a route that varies on something else too", async () => {
    // `/me` sets `Vary: Authorization` itself, because a bearer caller and a
    // cookie caller get different answers from the same URL. `res.vary`
    // appends, so both survive; a `setHeader` would have dropped one.
    const res = await request(setup()).get("/api/v1/me")
    expect(res.headers["vary"]).toContain("Cookie")
    expect(res.headers["vary"]).toContain("Authorization")
  })

  it("lets a genuinely public asset opt out of BOTH halves", async () => {
    /*
     * The three auth-page assets are the same bytes for everyone for the life
     * of a release, and they override the default. The cats drawing is the
     * one exercised here because it ships beside its own module; the wordmark
     * font is not tracked, so that route 404s in a checkout and would test
     * the miss path rather than the hit.
     *
     * Both halves, not just the first: a shared cache that varies on `Cookie`
     * keeps one copy per cookie value, so a year-long `immutable` on a font
     * would be re-fetched by every reader and the caching this route asks for
     * would exist on paper only.
     */
    const res = await request(setup()).get("/api/v1/auth/page-asset/cats.svg")
    expect(res.status).toBe(200)
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable")
    expect(res.headers["vary"]).toBeUndefined()
  })
})
