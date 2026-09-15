/**
 * The mark in the email footer is an `<img>` pointing back at this viewer, so
 * two things have to line up that no type checker and no single-module test
 * can see together: the path `auth-email.ts` builds, and the route
 * `auth-page-assets.ts` mounts.
 *
 * This is the failure `auth-urls.ts` already has on the record — a URL that
 * was built by hand, 404ed in a real browser, and passed every test because
 * each test rebuilt the request path itself instead of asking the app to
 * resolve the one the code had just produced. So the case below takes the
 * `src` OUT of a rendered email and GETs exactly that, and the only thing it
 * knows on its own is the origin it fed in.
 *
 * A broken link here is quiet: the email still sends, still reads, still
 * works — it just has a hole where the logo goes, in someone else's inbox.
 */

import express from "express"
import request from "supertest"
import { describe, expect, it } from "vitest"
import { InMemoryStorage } from "../../storage/in-memory-storage"
import { createApp } from "../../__tests__/test-app"
import { loadConfig } from "../../config"
import { tmpViewerDataDir } from "../../__tests__/test-config"
import { testGithubRuntime } from "../../__tests__/test-github-runtime"
import { inviteEmail } from "../../notify/auth-email"
import type { AssetStore } from "../../assets/types"

const nullAssets: AssetStore = {
  async put() {},
  async get() {
    return null
  },
  async deleteDeployment() {},
}

function setup() {
  // desde-allow-own-server: one app for the file, holding no per-test state.
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

const ORIGIN = "https://viewer.example.com"

/** The `src` of the footer image, as the template actually wrote it. */
function footerMarkSrc(): string {
  const { html } = inviteEmail({ inviteUrl: `${ORIGIN}/api/v1/auth/invite/dsi_x`, role: "viewer" })
  const src = html.match(/<img src="([^"]+)"/)?.[1]
  if (!src) throw new Error("the invite email rendered no footer image")
  return src
}

describe("the email footer wordmark", () => {
  it("resolves on this app, as a PNG", async () => {
    const src = footerMarkSrc()
    expect(src.startsWith(ORIGIN)).toBe(true)
    const res = await request(setup()).get(src.slice(ORIGIN.length))
    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toContain("image/png")
    expect(res.body.length).toBeGreaterThan(0)
  })

  it("is served to a signed-out reader", async () => {
    // The recipient of an invite has no account yet by definition, and an
    // email client fetches images with no cookie jar at all. A logo behind
    // the session gate would be a hole in every invite ever sent.
    const res = await request(setup()).get(footerMarkSrc().slice(ORIGIN.length))
    expect(res.status).toBe(200)
  })
})
