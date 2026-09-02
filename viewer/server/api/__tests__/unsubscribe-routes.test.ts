import express from "express"
import request from "supertest"
import { beforeEach, describe, expect, it } from "vitest"
import { InMemoryStorage } from "../../storage/in-memory-storage"
import { createApp } from "../../__tests__/test-app"
import { loadConfig } from "../../config"
import { signUnsubscribeToken } from "../../notify/mention-email"
import type { AssetStore } from "../../assets/types"
import { createSwappableApp } from "../../__tests__/swappable-app"
import { tmpViewerDataDir } from "../../__tests__/test-config"
import { testGithubRuntime } from "../../__tests__/test-github-runtime"

/**
 * ONE stable app object for this whole file — see `__tests__/swappable-app.ts`.
 * 9 listening servers per run before this. The one test that builds a second
 * app (`unconfiguredApp`) uses only that app, so a single instance is safe.
 */
const stable = createSwappableApp()

const nullAssets: AssetStore = {
  async put() {},
  async get() { return null },
  async deleteDeployment() {},
}

describe("unsubscribe route", () => {
  let storage: InMemoryStorage
  let app: express.Express
  let projectId: string
  let participantId: string

  beforeEach(async () => {
    storage = new InMemoryStorage()
    stable.use(
      createApp({
        storage,
        assets: nullAssets,
        config: loadConfig({
          VIEWER_ADMIN_TOKEN: "secret",
          VIEWER_UNSUBSCRIBE_SECRET: "shh",
          VIEWER_PUBLIC_URL: "https://viewer.example.com",
          VIEWER_DATA_DIR: tmpViewerDataDir(),
        }),
        bridgeScript: "// bridge",
        github: testGithubRuntime(),
      }),
    )
    app = stable.app
    const project = await storage.createProject({ slug: "acme", name: "Acme", repoUrl: null })
    projectId = project.id
    const participant = await storage.upsertParticipant(project.id, {
      email: "bob@example.com",
      displayName: "Bob",
      status: "active",
    })
    participantId = participant.id
  })

  it("opts the participant out of the project scope for a validly signed token", async () => {
    const token = await signUnsubscribeToken("shh", { participantId, projectId })
    const res = await request(app).get(`/api/v1/unsubscribe?token=${encodeURIComponent(token)}`)
    expect(res.status).toBe(200)
    expect(res.type).toBe("text/html")
    expect(res.text).toContain("Unsubscribed")
    expect(await storage.isOptedOut(participantId, projectId)).toBe(true)
  })

  it("records a projectId: null optout when scope=global — but it does NOT reach a different project's own participant row", async () => {
    // Fix 3 (phase-2b-2 review): the pre-fix version of this test asserted
    // `isOptedOut(participantId, otherProject.id)` using the SAME
    // `participantId` across two projects — a state that cannot exist in
    // production. Participants are per-project rows (a distinct
    // `randomUUID()` per `(project_id, email)` pair — see
    // `sqlite-storage.ts`'s `participants_by_project_email` index), so the
    // same human has a DIFFERENT participantId in `otherProject`. The old
    // assertion was checking storage's raw `OR project_id IS NULL` matching
    // rule in isolation, not anything a real "global unsubscribe" flow could
    // produce — it was testing a fiction. This version reflects reality: it
    // seeds `otherProject` with the same human's ACTUAL (distinct)
    // participant row there, and shows the "global" optout — despite the
    // name — has no effect on it. That's exactly why the confirmation copy
    // no longer claims a global/"all Desde emails" scope (see
    // `unsubscribeConfirmationHtml`'s doc comment in `notify/mention-email.ts`).
    const token = await signUnsubscribeToken("shh", { participantId, projectId })
    const res = await request(app).get(`/api/v1/unsubscribe?token=${encodeURIComponent(token)}&scope=global`)
    expect(res.status).toBe(200)

    // The projectId: null row still suppresses THIS project (the one the
    // token was scoped to) — that part keeps working.
    expect(await storage.isOptedOut(participantId, projectId)).toBe(true)

    // But the same human's participant row in a different project is a
    // DIFFERENT id, and the "global" optout doesn't reach it.
    const otherProject = await storage.createProject({ slug: "other", name: "Other", repoUrl: null })
    const otherProjectParticipant = await storage.upsertParticipant(otherProject.id, {
      email: "bob@example.com",
      displayName: "Bob",
      status: "active",
    })
    expect(otherProjectParticipant.id).not.toBe(participantId)
    expect(await storage.isOptedOut(otherProjectParticipant.id, otherProject.id)).toBe(false)
  })

  it("confirmation page shows the project's NAME, not its raw (UUID-shaped) id", async () => {
    // Fix 5 (phase-2b-2 review), sibling of the subject-line bug fixed in
    // 87fbaecb — the confirmation page had the same defect via a different
    // call site (`unsubscribeConfirmationHtml` rendering `projectId`
    // verbatim). `projectId` here is UUID-shaped and the project's `name` is
    // a distinct human string, so this fails against the pre-fix code.
    const namedProject = await storage.createProject({ slug: "named-proj", name: "Named Project", repoUrl: null })
    const namedParticipant = await storage.upsertParticipant(namedProject.id, {
      email: "cara@example.com",
      displayName: "Cara",
      status: "active",
    })
    const token = await signUnsubscribeToken("shh", { participantId: namedParticipant.id, projectId: namedProject.id })
    const res = await request(app).get(`/api/v1/unsubscribe?token=${encodeURIComponent(token)}`)
    expect(res.status).toBe(200)
    expect(res.text).toContain("Named Project")
    expect(res.text).not.toContain(namedProject.id)
  })

  it("never renders 'all Desde emails' or any global-scope claim on the confirmation page, even for scope=global", async () => {
    const token = await signUnsubscribeToken("shh", { participantId, projectId })
    const res = await request(app).get(`/api/v1/unsubscribe?token=${encodeURIComponent(token)}&scope=global`)
    expect(res.status).toBe(200)
    // The real page copy is project-scoped ("won't get mention emails for
    // <project> anymore") — assert it positively so this test would fail if
    // the copy ever regressed toward a global claim.
    expect(res.text).toContain("won't get mention emails for")
    // Word-boundary + case-insensitive: the previous `.not.toContain("all")`
    // was case-sensitive (missed "All Desde emails") AND over-broad
    // (would also fail on unrelated copy containing "small"/"wall"/"call").
    // `\ball\b` matches the standalone word "all" without either problem.
    expect(res.text).not.toMatch(/\ball\b/i)
    expect(res.text.toLowerCase()).not.toContain("desde emails")
    expect(res.text.toLowerCase()).not.toContain("desde emails")
  })

  it("POST with a valid token opts the participant out and returns 200 (RFC 8058 one-click unsubscribe)", async () => {
    // `smtp-email-provider.ts` advertises `List-Unsubscribe-Post:
    // List-Unsubscribe=One-Click`, which tells mail clients this URL accepts
    // a bodyless POST. Pre-fix, only `router.get` was registered, so that
    // POST 404d — a failing one-click endpoint. This exercises the POST path
    // directly, the same way a mail client's automated request would.
    const token = await signUnsubscribeToken("shh", { participantId, projectId })
    const res = await request(app).post(`/api/v1/unsubscribe?token=${encodeURIComponent(token)}`)
    expect(res.status).toBe(200)
    expect(res.type).toBe("text/html")
    expect(await storage.isOptedOut(participantId, projectId)).toBe(true)
  })

  it("rejects a tampered token with 400 and records no optout", async () => {
    const token = await signUnsubscribeToken("shh", { participantId, projectId })
    const tampered = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a")
    const res = await request(app).get(`/api/v1/unsubscribe?token=${encodeURIComponent(tampered)}`)
    expect(res.status).toBe(400)
    expect(await storage.isOptedOut(participantId, projectId)).toBe(false)
  })

  it("400s when token is missing", async () => {
    const res = await request(app).get(`/api/v1/unsubscribe`)
    expect(res.status).toBe(400)
  })

  it("404s when VIEWER_UNSUBSCRIBE_SECRET is unset", async () => {
    stable.use(
      createApp({
        storage,
        assets: nullAssets,
        config: loadConfig({ VIEWER_ADMIN_TOKEN: "secret", VIEWER_DATA_DIR: tmpViewerDataDir() }), // no VIEWER_UNSUBSCRIBE_SECRET
        bridgeScript: "// bridge",
        github: testGithubRuntime(),
      }),
    )
    const unconfiguredApp = stable.app
    const token = await signUnsubscribeToken("shh", { participantId, projectId })
    const res = await request(unconfiguredApp).get(`/api/v1/unsubscribe?token=${encodeURIComponent(token)}`)
    expect(res.status).toBe(404)
  })

  it("does not shadow the terminal JSON 404 for other unknown /api/v1 paths", async () => {
    const res = await request(app).get(`/api/v1/definitely-not-a-route`)
    expect(res.status).toBe(404)
    expect(res.type).toBe("application/json")
  })
})
