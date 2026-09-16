import express from "express"
import request from "supertest"
import { describe, expect, it } from "vitest"
import { createSwappableApp } from "../__tests__/swappable-app"
import { clearTossedSessionCookie } from "./session-cookie"
import { createSessionCookieHygiene } from "./session-cookie-hygiene"

describe("createSessionCookieHygiene", () => {
  // One stable app object for the whole file (see `swappable-app.ts`) — each
  // test below builds its own tiny inner app (different `publicUrl`s) and
  // swaps it in, rather than handing `request()` a fresh `express()` each
  // time.
  const stable = createSwappableApp()

  it("clears both spellings when the session name appears twice on http, and leaves a single cookie alone", async () => {
    const inner = express()
    inner.use(createSessionCookieHygiene({ publicUrl: "http://desde.localhost:3100" }))
    inner.get("/", (_req, res) => res.status(200).end())
    stable.use(inner)

    const twice = await request(stable.app)
      .get("/")
      .set("Cookie", "viewer_session=a; viewer_session=b")
    expect(twice.headers["set-cookie"]).toEqual([clearTossedSessionCookie("desde.localhost")])

    const once = await request(stable.app).get("/").set("Cookie", "viewer_session=a")
    expect(once.headers["set-cookie"]).toBeUndefined()
  })

  it("does nothing on https", async () => {
    const inner = express()
    inner.use(createSessionCookieHygiene({ publicUrl: "https://viewer.example.com" }))
    inner.get("/", (_req, res) => res.status(200).end())
    stable.use(inner)

    // Even a doubled plain name must not trigger a clear on https — the
    // middleware no-ops entirely before it ever looks at the cookie header,
    // because the live cookie there is `__Host-viewer_session`, which
    // cannot carry a `Domain` attribute in the first place.
    const res = await request(stable.app)
      .get("/")
      .set("Cookie", "viewer_session=a; viewer_session=b")
    expect(res.headers["set-cookie"]).toBeUndefined()
  })

  it("does nothing on a host that cannot carry a Domain cookie", async () => {
    // `localhost` is the documented Safari fallback. A `Domain=localhost`
    // clear there is not a clear of a PLANTED copy — the browser keeps no
    // separate copy to clear — it deletes the reviewer's own session.
    for (const publicUrl of ["http://localhost:3100", "http://127.0.0.1:3100"]) {
      const inner = express()
      inner.use(createSessionCookieHygiene({ publicUrl }))
      inner.get("/", (_req, res) => res.status(200).end())
      stable.use(inner)

      const res = await request(stable.app)
        .get("/")
        .set("Cookie", "viewer_session=a; viewer_session=b")
      expect(res.headers["set-cookie"]).toBeUndefined()
    }
  })
})
