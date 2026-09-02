import express from "express"
import http from "node:http"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { InMemoryStorage } from "../../storage/in-memory-storage"
import { createApp } from "../../__tests__/test-app"
import { loadConfig } from "../../config"
import type { AssetStore } from "../../assets/types"
import { createCommentChangeBus, type CommentChangeBus } from "../../comments/change-bus"
import { signSessionId } from "../../auth/session-cookie"
import { createSwappableApp } from "../../__tests__/swappable-app"
import { tmpViewerDataDir } from "../../__tests__/test-config"
import { testGithubRuntime } from "../../__tests__/test-github-runtime"
import { upsertTestUser } from "../../__tests__/user-fixtures"
import {
  ALLOW_ANONYMOUS_COMMENTS_KEY,
  invalidateInstanceSettingsCache,
} from "../../instance-settings"

/**
 * ONE stable app object for this file's supertest calls — see
 * `__tests__/swappable-app.ts`. This file opened 47 listening servers per run.
 *
 * TWO apps in this file deliberately do NOT go through it: the SSE
 * client-disconnect test and the "valid session on a locked project" stream
 * test each call `.listen(0)` themselves and drive a raw `http.get`, because an
 * SSE response never ends and supertest would wait for a body forever. Routing
 * those through the shared object would put a second `listen()` on the very
 * object `supertest-reuse` has memoized — breaking the memoization and the
 * tests' own cleanup. They close their own servers; leave them as they are.
 */
const stable = createSwappableApp()

const author = { uid: "viewer:mo", displayName: "Mo", email: "mo@example.com", photoURL: "" }
const position = { anchorSelector: "#cta", page: "/", anchorX: 1, anchorY: 2 }

/**
 * The admin bearer, used below wherever a test needs to be an INSIDER —
 * either to read participant/comment emails (security audit S3 scopes them
 * to members/owners/admins) or to invite a participant at all (B5 requires
 * an identified caller). It is the cheapest insider credential available;
 * nothing about these tests is about admin specifically.
 */
const asInsider = { Authorization: "Bearer secret" }

/** A comment/reply author as an OUTSIDER sees it: no `email` key at all. */
function authorView(a: { uid: string; displayName: string; photoURL: string }) {
  return { uid: a.uid, displayName: a.displayName, photoURL: a.photoURL }
}

const nullAssets: AssetStore = {
  async put() {},
  async get() { return null },
  async deleteDeployment() {},
}

describe("comments API", () => {
  let storage: InMemoryStorage
  let app: express.Express
  let projectId: string
  let changeBus: CommentChangeBus

  beforeEach(async () => {
    storage = new InMemoryStorage()
    changeBus = createCommentChangeBus()
    stable.use(
      createApp({
        storage,
        assets: nullAssets,
        config: loadConfig({ VIEWER_ADMIN_TOKEN: "secret", VIEWER_DATA_DIR: tmpViewerDataDir() }),
        bridgeScript: "// bridge",
        changeBus,
        github: testGithubRuntime(),
      }),
    )
    app = stable.app
    projectId = (await storage.createProject({ slug: "acme", name: "Acme", repoUrl: null, access: "public-link" })).id
  })

  it("creates and lists comments WITHOUT any admin token", async () => {
    const created = await request(app)
      .post(`/api/v1/projects/${projectId}/comments`)
      .send({ position, body: "Needs more contrast", author })
    expect(created.status).toBe(201)
    expect(created.body.number).toBe(1)
    const listed = await request(app).get(`/api/v1/projects/${projectId}/comments`)
    expect(listed.status).toBe(200)
    expect(listed.body.comments).toHaveLength(1)
  })

  it("404s for an unknown project on both read and write", async () => {
    expect((await request(app).get(`/api/v1/projects/nope/comments`)).status).toBe(404)
    expect((await request(app).post(`/api/v1/projects/nope/comments`).send({ position, body: "x", author })).status).toBe(404)
  })

  it("validates the create payload", async () => {
    const noBody = await request(app).post(`/api/v1/projects/${projectId}/comments`).send({ position, author })
    expect(noBody.status).toBe(400)
    const longBody = await request(app)
      .post(`/api/v1/projects/${projectId}/comments`)
      .send({ position, body: "x".repeat(10_001), author })
    expect(longBody.status).toBe(400)
    const noAuthorName = await request(app)
      .post(`/api/v1/projects/${projectId}/comments`)
      .send({ position, body: "x", author: { ...author, displayName: "" } })
    expect(noAuthorName.status).toBe(400)
    const badSelector = await request(app)
      .post(`/api/v1/projects/${projectId}/comments`)
      .send({ position: { ...position, anchorSelector: "x".repeat(2_001) }, body: "x", author })
    expect(badSelector.status).toBe(400)
    const badTabPanelIds = await request(app)
      .post(`/api/v1/projects/${projectId}/comments`)
      .send({ position: { ...position, tabPanelIds: [1, 2, 3] }, body: "x", author })
    expect(badTabPanelIds.status).toBe(400)
    const tooManyTabPanelIds = await request(app)
      .post(`/api/v1/projects/${projectId}/comments`)
      .send({ position: { ...position, tabPanelIds: Array.from({ length: 21 }, (_, i) => `tab-${i}`) }, body: "x", author })
    expect(tooManyTabPanelIds.status).toBe(400)
  })

  it("strips unknown keys from position and author before storing (no mass assignment)", async () => {
    const created = await request(app)
      .post(`/api/v1/projects/${projectId}/comments`)
      .send({
        position: { ...position, tabPanelIds: ["tab-1"], evil: "smuggled" },
        body: "root",
        author: { ...author, isAdmin: true, evil: "smuggled" },
      })
    expect(created.status).toBe(201)
    expect(created.body.position).toEqual({ ...position, tabPanelIds: ["tab-1"] })
    expect(created.body.position.evil).toBeUndefined()
    // Redacted for this ANONYMOUS caller (S3) — assert the exact view, and
    // separately that the full author (email included) did reach storage.
    expect(created.body.author).toEqual(authorView(author))
    expect((await storage.getComment(created.body.id))!.author).toEqual(author)
    expect(created.body.author.isAdmin).toBeUndefined()
    expect(created.body.author.evil).toBeUndefined()

    // Same treatment on the reply path.
    const replied = await request(app)
      .post(`/api/v1/projects/${projectId}/comments/${created.body.id}/replies`)
      .send({ body: "agreed", author: { ...author, uid: "viewer:sam", isAdmin: true } })
    expect(replied.status).toBe(200)
    expect(replied.body.replies[0].author.isAdmin).toBeUndefined()

    const listed = await request(app).get(`/api/v1/projects/${projectId}/comments`)
    expect(listed.body.comments[0].position.evil).toBeUndefined()
    expect(listed.body.comments[0].author.evil).toBeUndefined()
  })

  it("updates, replies, deletes; comment must belong to the project in the URL", async () => {
    const c = (await request(app).post(`/api/v1/projects/${projectId}/comments`).send({ position, body: "root", author })).body
    const other = (await storage.createProject({ slug: "other", name: "Other", repoUrl: null, access: "public-link" })).id

    const patched = await request(app).patch(`/api/v1/projects/${projectId}/comments/${c.id}`).send({ resolved: true })
    expect(patched.status).toBe(200)
    expect(patched.body.resolved).toBe(true)

    const replied = await request(app)
      .post(`/api/v1/projects/${projectId}/comments/${c.id}/replies`)
      .send({ body: "agreed", author: { uid: "viewer:sam", displayName: "Sam", email: "sam@x.com", photoURL: "" } })
    expect(replied.status).toBe(200)
    expect(replied.body.replies).toHaveLength(1)

    // Cross-project access must 404, not touch the comment
    expect((await request(app).patch(`/api/v1/projects/${other}/comments/${c.id}`).send({ resolved: false })).status).toBe(404)
    expect((await request(app).delete(`/api/v1/projects/${other}/comments/${c.id}`)).status).toBe(404)

    expect((await request(app).delete(`/api/v1/projects/${projectId}/comments/${c.id}`)).status).toBe(204)
    expect((await request(app).get(`/api/v1/projects/${projectId}/comments`)).body.comments).toHaveLength(0)
  })

  it("caps replies per comment at 500", async () => {
    const c = (await request(app).post(`/api/v1/projects/${projectId}/comments`).send({ position, body: "root", author })).body
    // Pre-seed 500 replies via the storage adapter directly rather than
    // looping 500 real POSTs — same end state, without the per-request
    // overhead making this test slow.
    for (let i = 0; i < 500; i++) {
      await storage.addCommentReply(c.id, { body: `reply ${i}`, author })
    }
    const overCap = await request(app)
      .post(`/api/v1/projects/${projectId}/comments/${c.id}/replies`)
      .send({ body: "one too many", author })
    expect(overCap.status).toBe(400)
    const listed = await request(app).get(`/api/v1/projects/${projectId}/comments`)
    expect(listed.body.comments[0].replies).toHaveLength(500)
  })

  it("streams a change event to an SSE subscriber after a write", async () => {
    const received: string[] = []
    await new Promise<void>((resolve, reject) => {
      const _req = request(app)
        .get(`/api/v1/projects/${projectId}/comments/stream`)
        .buffer(false)
        .parse((res, cb) => {
          res.on("data", (chunk: Buffer) => {
            received.push(chunk.toString("utf-8"))
            if (received.join("").includes('{"type":"changed"}')) {
              // superagent's `Response` type (extends the base `Stream`, not
              // `Readable`) doesn't declare `destroy()`, but the object
              // handed to `.parse()` is the real Node `http.IncomingMessage`
              // at runtime, which does have it.
              ;(res as unknown as { destroy(): void }).destroy()
              resolve()
            }
          })
          res.on("error", () => cb(null, Buffer.from("")))
        })
        .end(() => {})
      setTimeout(async () => {
        const w = await request(app).post(`/api/v1/projects/${projectId}/comments`).send({ position, body: "trigger", author })
        if (w.status !== 201) reject(new Error(`write failed: ${w.status}`))
      }, 50)
      setTimeout(() => reject(new Error(`no change event; got: ${received.join("")}`)), 3000)
    })
    expect(received.join("")).toContain('{"type":"connected"}')
    expect(received.join("")).toContain('{"type":"changed"}')
  })

  it("releases the change-bus subscription (and heartbeat) when the client disconnects after the stream is established", async () => {
    // Spy on the real timer globals so the heartbeat's lifecycle — not just
    // the change-bus subscription — is actually observed. Without this, a
    // handler that dropped the `setInterval(...)` heartbeat entirely would
    // still pass every assertion below, despite the title promising
    // heartbeat coverage.
    const setIntervalSpy = vi.spyOn(global, "setInterval")
    const clearIntervalSpy = vi.spyOn(global, "clearInterval")
    expect(changeBus.listenerCount(projectId)).toBe(0)
    await new Promise<void>((resolve, reject) => {
      request(app)
        .get(`/api/v1/projects/${projectId}/comments/stream`)
        .buffer(false)
        .parse((res, cb) => {
          // Destroy the connection as soon as the first byte arrives —
          // the earliest point a real client can react — to exercise the
          // teardown path this regression test is for.
          res.on("data", () => {
            // Prove the subscription (and heartbeat) actually STARTED
            // before we assert they were torn down. Without this positive
            // check, a handler that never subscribes/starts a heartbeat at
            // all would still pass the post-disconnect `toBe(0)` checks
            // below — the leak this test exists to catch would go
            // undetected. The server writes the "connected" payload before
            // subscribing/starting the heartbeat (synchronously, no `await`
            // between them), so by the time this `data` event fires both
            // are guaranteed to have already happened.
            expect(changeBus.listenerCount(projectId)).toBe(1)
            expect(setIntervalSpy).toHaveBeenCalledTimes(1)
            ;(res as unknown as { destroy(): void }).destroy()
            resolve()
          })
          res.on("error", () => cb(null, Buffer.from("")))
        })
        .end((err) => {
          // supertest surfaces the destroyed socket as a request error;
          // that's the expected shape of an intentionally-aborted client,
          // not a test failure.
          if (err && !err.message.match(/aborted|socket hang up|ECONNRESET/i)) reject(err)
        })
    })
    // Captured before `vi.waitFor` below, which itself polls via
    // `setInterval`/`clearInterval` internally — asserting raw call COUNTS
    // past this point would conflate vitest's own polling timer with the
    // route handler's heartbeat. Pinning the specific handle sidesteps that.
    const heartbeatHandle = setIntervalSpy.mock.results[0]!.value
    await vi.waitFor(() => {
      expect(changeBus.listenerCount(projectId)).toBe(0)
    })
    // The heartbeat interval created above must have been cleared on
    // disconnect — a leaked `setInterval` keeps firing (and keeps the
    // dead response object referenced) forever otherwise.
    expect(clearIntervalSpy).toHaveBeenCalledWith(heartbeatHandle)
    setIntervalSpy.mockRestore()
    clearIntervalSpy.mockRestore()
  })

  it("releases bus subscription and heartbeat when the client disconnects during the project lookup", async () => {
    // Independent proof (alongside `listenerCount`, below) that the
    // heartbeat this test's title names is actually covered: since the
    // client is gone before the handler even reaches the subscribe/heartbeat
    // statements, `setInterval` must never be called at all for this
    // request. A regression that started the heartbeat before re-checking
    // `closed` would flip this — `listenerCount` alone can't distinguish
    // "heartbeat never started" from "heartbeat started and immediately
    // cleared", so this closes that gap.
    const setIntervalSpy = vi.spyOn(global, "setInterval")
    // Gates `storage.getProject` so the test controls exactly when the
    // handler's first `await` resolves — the vulnerable window this
    // regression test targets. Without gating it, `InMemoryStorage.getProject`
    // resolves so fast that a real client abort can never land inside that
    // window in a deterministic test (see fix-round-1 note: the previous
    // version of this test destroyed the socket only after the "connected"
    // byte arrived, i.e. strictly after the window had already closed — it
    // passed even against the pre-fix, leak-prone handler ordering).
    let releaseLookup!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseLookup = resolve
    })
    // Synchronizes the test with the SERVER actually having entered the
    // gated await — not just "the client's TCP handshake completed" (a
    // socket `connect` event only proves the connection is open, not that
    // the HTTP request line reached Express and dispatched to this route's
    // `getProject` call; without this, destroying the client soon enough
    // after `connect` is a race that sometimes wins and sometimes loses,
    // making the test flaky and, on the losing side, silently
    // non-diagnostic — it would "pass" because the request never reached
    // the handler at all, not because cleanup ran).
    let markEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const delayedStorage = new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop === "getProject") {
          return async (id: string) => {
            markEntered()
            await gate
            return target.getProject(id)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    }) as InMemoryStorage
    const bus = createCommentChangeBus()
    // desde-allow-own-server: this test calls `delayedApp.listen(0)` and
    // drives a raw `http.get` it then destroys mid-flight, to prove the SSE
    // handler cleans up when the client vanishes. supertest cannot express
    // that. It closes the server in its own `finally`.
    const delayedApp = createApp({
      storage: delayedStorage,
      assets: nullAssets,
      config: loadConfig({ VIEWER_ADMIN_TOKEN: "secret", VIEWER_DATA_DIR: tmpViewerDataDir() }),
      bridgeScript: "// bridge",
      changeBus: bus,
      github: testGithubRuntime(),
    })
    const server = delayedApp.listen(0)
    try {
      const port = (server.address() as { port: number }).port
      const req = http.get(`http://127.0.0.1:${port}/api/v1/projects/${projectId}/comments/stream`)
      req.on("error", () => {}) // destroying below is expected to surface as a client-side error
      await entered // the handler is now blocked inside `await getProject(...)`
      req.destroy() // client gone while `getProject` is still gated
      await new Promise((resolve) => setTimeout(resolve, 20))
      releaseLookup() // NOW the handler resumes — on a connection that's already dead
      // Give the handler's post-gate continuation (which runs synchronously
      // once `getProject` resolves: headers, the "connected" write, subscribe,
      // the heartbeat interval — all reachable in the broken pre-fix
      // ordering, since its `close` check happens too late to skip them) a
      // macrotask turn to actually execute BEFORE asserting. Without this,
      // `vi.waitFor`'s first synchronous check can observe `listenerCount ===
      // 0` simply because the continuation hasn't run yet — not because
      // anything was cleaned up — and resolve immediately without ever
      // exercising the assertion this test exists to make.
      await new Promise((resolve) => setTimeout(resolve, 20))
      // Checked BEFORE `vi.waitFor` below, which itself polls via
      // `setInterval` internally — asserting this after would conflate
      // vitest's own polling timer with the route handler's heartbeat. The
      // macrotask delay above already guarantees the handler's post-gate
      // continuation (where the heartbeat would start, if the `closed`
      // check didn't prevent it) has had the chance to run.
      expect(setIntervalSpy).not.toHaveBeenCalled()
      await vi.waitFor(() => {
        expect(bus.listenerCount(projectId)).toBe(0)
      })
    } finally {
      server.close()
      setIntervalSpy.mockRestore()
    }
  })

  it("auto-upserts the comment author as an active participant", async () => {
    await request(app).post(`/api/v1/projects/${projectId}/comments`).send({ position, body: "hi", author })
    const listed = (await request(app).get(`/api/v1/projects/${projectId}/participants`).set(asInsider))
      .body.participants
    expect(listed).toHaveLength(1)
    expect(listed[0].email).toBe(author.email)
    expect(listed[0].status).toBe("active")
  })

  it("creates no participant when the author's email is empty", async () => {
    await request(app)
      .post(`/api/v1/projects/${projectId}/comments`)
      .send({ position, body: "hi", author: { ...author, email: "" } })
    const listed = (await request(app).get(`/api/v1/projects/${projectId}/participants`)).body.participants
    expect(listed).toHaveLength(0)
  })

  it("succeeds with a malformed non-empty author email but does not pollute the participant directory", async () => {
    const created = await request(app)
      .post(`/api/v1/projects/${projectId}/comments`)
      .send({ position, body: "hi", author: { ...author, email: "not-an-email" } })
    expect(created.status).toBe(201)
    const listed = (await request(app).get(`/api/v1/projects/${projectId}/participants`)).body.participants
    expect(listed).toHaveLength(0)
  })

  it("resolves mentions against the real participant directory on create, dropping emails and unknown ids", async () => {
    const invited = await request(app)
      .post(`/api/v1/projects/${projectId}/participants`)
      .set(asInsider)
      .send({ email: "real@x.com", displayName: "Real Participant" })
    const realId = invited.body.id

    const created = await request(app)
      .post(`/api/v1/projects/${projectId}/comments`)
      .send({ position, body: "hi", author, mentions: [realId, "bob@example.com", "unknown-id"] })
    expect(created.status).toBe(201)
    expect(created.body.mentions).toEqual([realId])

    const listed = await request(app).get(`/api/v1/projects/${projectId}/comments`)
    expect(listed.body.comments[0].mentions).toEqual([realId])
  })

  it("resolves mentions against the real participant directory on reply, dropping emails and unknown ids", async () => {
    const invited = await request(app)
      .post(`/api/v1/projects/${projectId}/participants`)
      .set(asInsider)
      .send({ email: "real2@x.com", displayName: "Real Two" })
    const realId = invited.body.id

    const c = (await request(app).post(`/api/v1/projects/${projectId}/comments`).send({ position, body: "root", author })).body

    const replied = await request(app)
      .post(`/api/v1/projects/${projectId}/comments/${c.id}/replies`)
      .send({ body: "agreed", author, mentions: [realId, "eve@example.com", "unknown-id"] })
    expect(replied.status).toBe(200)
    expect(replied.body.replies[0].mentions).toEqual([realId])

    const listed = await request(app).get(`/api/v1/projects/${projectId}/comments`)
    expect(listed.body.comments[0].replies[0].mentions).toEqual([realId])
  })

  it("resolves mentions against the real participant directory on PATCH, dropping emails and unknown ids", async () => {
    const invited = await request(app)
      .post(`/api/v1/projects/${projectId}/participants`)
      .set(asInsider)
      .send({ email: "real3@x.com", displayName: "Real Three" })
    const realId = invited.body.id

    const c = (await request(app).post(`/api/v1/projects/${projectId}/comments`).send({ position, body: "root", author })).body

    const patched = await request(app)
      .patch(`/api/v1/projects/${projectId}/comments/${c.id}`)
      .send({ mentions: [realId, "x@y.com", "unknown-id"] })
    expect(patched.status).toBe(200)
    expect(patched.body.mentions).toEqual([realId])

    const listed = await request(app).get(`/api/v1/projects/${projectId}/comments`)
    expect(listed.body.comments[0].mentions).toEqual([realId])
  })

  it("stores an empty mentions array when every submitted mention id is invalid", async () => {
    const created = await request(app)
      .post(`/api/v1/projects/${projectId}/comments`)
      .send({ position, body: "hi", author, mentions: ["not-an-email-either", "totally-unknown"] })
    expect(created.status).toBe(201)
    expect(created.body.mentions).toEqual([])
  })

  it("enqueues a notification for each mentioned participant except the author", async () => {
    // seed two participants by having them author comments
    await request(app).post(`/api/v1/projects/${projectId}/comments`).send({
      position, body: "hi", author: { uid: "viewer:mo", displayName: "Mo", email: "mo@x.com", photoURL: "" },
    })
    await request(app).post(`/api/v1/projects/${projectId}/comments`).send({
      position, body: "hi", author: { uid: "viewer:sam", displayName: "Sam", email: "sam@x.com", photoURL: "" },
    })
    const parts = (await request(app).get(`/api/v1/projects/${projectId}/participants`).set(asInsider))
      .body.participants
    const mo = parts.find((p: { email: string }) => p.email === "mo@x.com")
    const sam = parts.find((p: { email: string }) => p.email === "sam@x.com")
    // Mo authors a comment mentioning BOTH Mo (self) and Sam
    await request(app).post(`/api/v1/projects/${projectId}/comments`).send({
      position, body: `@[Mo](${mo.id}) @[Sam](${sam.id})`,
      author: { uid: "viewer:mo", displayName: "Mo", email: "mo@x.com", photoURL: "" },
      mentions: [mo.id, sam.id],
    })
    const pending = await storage.listPendingNotifications(10)
    const recipients = pending.flatMap((n) => n.recipientIds)
    expect(recipients).toContain(sam.id)
    expect(recipients).not.toContain(mo.id) // author excluded (self-mention)
  })

  it("enqueues nothing when there are no mentions", async () => {
    const before = (await storage.listPendingNotifications(50)).length
    await request(app).post(`/api/v1/projects/${projectId}/comments`).send({ position, body: "no mentions", author })
    expect((await storage.listPendingNotifications(50)).length).toBe(before)
  })

  describe("comment authorship — server-authoritative when signed in", () => {
    it("signed out + a `viewer:` uid stores the author exactly as sent (regression guard: pre-3a behavior unchanged)", async () => {
      const created = await request(app)
        .post(`/api/v1/projects/${projectId}/comments`)
        .send({
          position,
          body: "hi",
          author: { uid: "viewer:abc", displayName: "Abc", email: "abc@example.com", photoURL: "" },
        })
      expect(created.status).toBe(201)
      // STORED exactly as sent (the property this guards); the wire view
      // omits `email` for this anonymous caller (S3).
      expect((await storage.getComment(created.body.id))!.author).toEqual({
        uid: "viewer:abc", displayName: "Abc", email: "abc@example.com", photoURL: "",
      })
      expect(created.body.author).toEqual(authorView({ uid: "viewer:abc", displayName: "Abc", photoURL: "" }))
    })

    it("signed out + a `user:`-prefixed uid is refused, and no participant is created for its email", async () => {
      const forged = await request(app)
        .post(`/api/v1/projects/${projectId}/comments`)
        .send({
          position,
          body: "hi",
          author: { uid: "user:whoever", displayName: "Victim", email: "victim@example.com", photoURL: "" },
        })
      expect(forged.status).toBe(400)
      const participants = (await request(app).get(`/api/v1/projects/${projectId}/participants`)).body.participants
      expect(participants.find((p: { email: string }) => p.email === "victim@example.com")).toBeUndefined()
    })

    it("reply path: signed out + a forged `user:` uid is refused, and no participant is created for its email", async () => {
      const c = (await request(app).post(`/api/v1/projects/${projectId}/comments`).send({ position, body: "root", author })).body
      const forged = await request(app)
        .post(`/api/v1/projects/${projectId}/comments/${c.id}/replies`)
        .send({ body: "reply", author: { uid: "user:whoever", displayName: "Victim", email: "victim2@example.com", photoURL: "" } })
      expect(forged.status).toBe(400)
      const participants = (await request(app).get(`/api/v1/projects/${projectId}/participants`)).body.participants
      expect(participants.find((p: { email: string }) => p.email === "victim2@example.com")).toBeUndefined()
    })

    it("signed out + uppercase `User:x` uid is refused (case-insensitive check)", async () => {
      const forged = await request(app)
        .post(`/api/v1/projects/${projectId}/comments`)
        .send({
          position,
          body: "hi",
          author: { uid: "User:whoever", displayName: "Impostor", email: "impostor-upper@example.com", photoURL: "" },
        })
      expect(forged.status).toBe(400)
      const participants = (await request(app).get(`/api/v1/projects/${projectId}/participants`)).body.participants
      expect(participants.find((p: { email: string }) => p.email === "impostor-upper@example.com")).toBeUndefined()
    })

    it("signed out + mixed-case `uSeR:x` uid is refused (case-insensitive check)", async () => {
      const forged = await request(app)
        .post(`/api/v1/projects/${projectId}/comments`)
        .send({
          position,
          body: "hi",
          author: { uid: "uSeR:whoever", displayName: "Impostor", email: "impostor-mixed@example.com", photoURL: "" },
        })
      expect(forged.status).toBe(400)
      const participants = (await request(app).get(`/api/v1/projects/${projectId}/participants`)).body.participants
      expect(participants.find((p: { email: string }) => p.email === "impostor-mixed@example.com")).toBeUndefined()
    })

    it("signed out + whitespace + `user:x` uid is refused (trim check)", async () => {
      const forged = await request(app)
        .post(`/api/v1/projects/${projectId}/comments`)
        .send({
          position,
          body: "hi",
          author: { uid: " user:whoever", displayName: "Impostor", email: "impostor-space@example.com", photoURL: "" },
        })
      expect(forged.status).toBe(400)
      const participants = (await request(app).get(`/api/v1/projects/${projectId}/participants`)).body.participants
      expect(participants.find((p: { email: string }) => p.email === "impostor-space@example.com")).toBeUndefined()
    })

    it("reply path: uppercase `User:x` uid is refused (case-insensitive check)", async () => {
      const c = (await request(app).post(`/api/v1/projects/${projectId}/comments`).send({ position, body: "root", author })).body
      const forged = await request(app)
        .post(`/api/v1/projects/${projectId}/comments/${c.id}/replies`)
        .send({ body: "reply", author: { uid: "User:whoever", displayName: "Impostor", email: "impostor-upper-reply@example.com", photoURL: "" } })
      expect(forged.status).toBe(400)
      const participants = (await request(app).get(`/api/v1/projects/${projectId}/participants`)).body.participants
      expect(participants.find((p: { email: string }) => p.email === "impostor-upper-reply@example.com")).toBeUndefined()
    })

    it("reply path: whitespace + `user:x` uid is refused (trim check)", async () => {
      const c = (await request(app).post(`/api/v1/projects/${projectId}/comments`).send({ position, body: "root", author })).body
      const forged = await request(app)
        .post(`/api/v1/projects/${projectId}/comments/${c.id}/replies`)
        .send({ body: "reply", author: { uid: " user:whoever", displayName: "Impostor", email: "impostor-space-reply@example.com", photoURL: "" } })
      expect(forged.status).toBe(400)
      const participants = (await request(app).get(`/api/v1/projects/${projectId}/participants`)).body.participants
      expect(participants.find((p: { email: string }) => p.email === "impostor-space-reply@example.com")).toBeUndefined()
    })

    it("signed in: a body claiming a different identity is ignored — the stored author is the session's user (comment + reply)", async () => {
      const authedStorage = new InMemoryStorage()
      const authedChangeBus = createCommentChangeBus()
      const authConfig = loadConfig({
        VIEWER_GITHUB_CLIENT_ID: "client-id",
        VIEWER_GITHUB_CLIENT_SECRET: "client-secret",
        VIEWER_SESSION_SECRET: "sesh-secret",
        VIEWER_PUBLIC_URL: "http://localhost:3100",
        VIEWER_DATA_DIR: tmpViewerDataDir(),
      })
      stable.use(
        createApp({
          storage: authedStorage,
          assets: nullAssets,
          config: authConfig,
          bridgeScript: "// bridge",
          changeBus: authedChangeBus,
          github: testGithubRuntime(),
        }),
      )
      const authedApp = stable.app
      const authedProjectId = (await authedStorage.createProject({ slug: "authed", name: "Authed", repoUrl: null })).id
      const user = await upsertTestUser(authedStorage, {
        provider: "github",
        providerUserId: "999",
        email: "real@example.com",
        displayName: "Real User",
        avatarUrl: "https://avatars.example.com/real.png",
      })
      const session = await authedStorage.createSession({
        userId: user.id,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      const cookie = `viewer_session=${signSessionId(authConfig.sessionSecret, session.id)}`
      const expectedAuthor = {
        uid: `user:${user.id}`,
        displayName: "Real User",
        email: "real@example.com",
        photoURL: "https://avatars.example.com/real.png",
      }

      const created = await request(authedApp)
        .post(`/api/v1/projects/${authedProjectId}/comments`)
        .set("Cookie", cookie)
        .send({
          position,
          body: "hi",
          author: { uid: "user:someone-else", displayName: "Impostor", email: "impostor@example.com", photoURL: "" },
        })
      expect(created.status).toBe(201)
      // The point of this test is WHOSE identity is recorded, so it asserts
      // against storage. The wire view drops `email` because this signed-in
      // caller is not a member of that project (S3) — even for their own
      // comment, since the projection scopes the FIELD, not the row.
      expect((await authedStorage.getComment(created.body.id))!.author).toEqual(expectedAuthor)
      expect(created.body.author).toEqual(authorView(expectedAuthor))

      const replied = await request(authedApp)
        .post(`/api/v1/projects/${authedProjectId}/comments/${created.body.id}/replies`)
        .set("Cookie", cookie)
        .send({
          body: "reply",
          author: { uid: "user:someone-else", displayName: "Impostor", email: "impostor@example.com", photoURL: "" },
        })
      expect(replied.status).toBe(200)
      expect((await authedStorage.getComment(created.body.id))!.replies[0].author).toEqual(expectedAuthor)
      expect(replied.body.replies[0].author).toEqual(authorView(expectedAuthor))
    })
  })

  /**
   * Security audit B5. `MAX_MENTIONS` caps ONE request at 20 recipients and
   * nothing capped the number of requests — the audit measured 5 repeats of
   * a 20-recipient comment producing 100 emails with no dedup and no
   * throttle, all from the operator's own SMTP identity.
   */
  it("caps mention notifications per project per hour, without failing the comment write", async () => {
    const ids: string[] = []
    for (let i = 0; i < 20; i++) {
      const invited = await request(app)
        .post(`/api/v1/projects/${projectId}/participants`)
        .set(asInsider)
        .send({ email: `p${i}@x.com`, displayName: `P${i}` })
      expect(invited.status).toBe(201)
      ids.push(invited.body.id)
    }

    const post = () =>
      request(app)
        .post(`/api/v1/projects/${projectId}/comments`)
        .send({ position, body: "ping", author: { ...author, email: "flooder@x.com" }, mentions: ids })

    // 10 x 20 = 200, the default hourly ceiling.
    for (let i = 0; i < 10; i++) expect((await post()).status).toBe(201)
    expect((await storage.listPendingNotifications(1000)).flatMap((n) => n.recipientIds)).toHaveLength(200)

    // The 11th comment is still ACCEPTED — the review record is what the
    // user asked for; only the outbound mail is dropped.
    const over = await post()
    expect(over.status).toBe(201)
    expect((await storage.listPendingNotifications(1000)).flatMap((n) => n.recipientIds)).toHaveLength(200)
  })

  describe("read-path field scoping — emails are member-only (security audit S3)", () => {
    it("an anonymous GET returns the EXACT comment key set, with no email anywhere", async () => {
      const created = await request(app)
        .post(`/api/v1/projects/${projectId}/comments`)
        .send({ position, body: "root", author: { ...author, email: "verified@corp-internal.example" } })
      await request(app)
        .post(`/api/v1/projects/${projectId}/comments/${created.body.id}/replies`)
        .send({ body: "me too", author: { uid: "viewer:sam", displayName: "Sam", email: "sam@vendor.example", photoURL: "" } })

      const listed = await request(app).get(`/api/v1/projects/${projectId}/comments`)
      expect(listed.status).toBe(200)
      const [comment] = listed.body.comments
      // EXACT key sets at all three levels — comment, author, reply author.
      // `participantEmails` is absent as a KEY, not present-but-empty: a
      // spread-then-delete redaction would have left the nested reply
      // authors behind, which is exactly the shape this pins against.
      expect(Object.keys(comment).sort()).toEqual([
        "author", "body", "createdAt", "id", "mentions", "number", "position", "projectId", "replies", "resolved",
      ])
      expect(Object.keys(comment.author).sort()).toEqual(["displayName", "photoURL", "uid"])
      expect(Object.keys(comment.replies[0].author).sort()).toEqual(["displayName", "photoURL", "uid"])
      const wire = JSON.stringify(listed.body)
      expect(wire).not.toContain("corp-internal.example")
      expect(wire).not.toContain("vendor.example")
    })

    it("an insider GET keeps author.email and participantEmails", async () => {
      const created = await request(app)
        .post(`/api/v1/projects/${projectId}/comments`)
        .send({ position, body: "root", author: { ...author, email: "verified@corp-internal.example" } })
      expect(created.status).toBe(201)

      const listed = await request(app).get(`/api/v1/projects/${projectId}/comments`).set(asInsider)
      const [comment] = listed.body.comments
      expect(comment.author.email).toBe("verified@corp-internal.example")
      expect(comment.participantEmails).toEqual(["verified@corp-internal.example"])
    })
  })

  /**
   * Security audit S20. `requireProjectWrite` gates readability + PAT scope
   * only — an anonymous caller has `scopes: null`, so it passes — and the
   * handlers then checked ONLY that the comment belonged to this project.
   * `updateComment` preserves the author row verbatim, so an anonymous
   * request could attach arbitrary words to an already-VERIFIED GitHub
   * identity, or delete that person's comment, invisibly.
   */
  describe("comment content ownership (security audit S20)", () => {
    async function commentByVerifiedUser() {
      const authConfig = loadConfig({
        VIEWER_ADMIN_TOKEN: "secret",
        VIEWER_GITHUB_CLIENT_ID: "client-id",
        VIEWER_GITHUB_CLIENT_SECRET: "client-secret",
        VIEWER_SESSION_SECRET: "sesh-secret",
        VIEWER_PUBLIC_URL: "http://localhost:3100",
        VIEWER_DATA_DIR: tmpViewerDataDir(),
      })
      const store = new InMemoryStorage()
      // `public-link` so an anonymous caller genuinely reaches the routes —
      // the refusal has to come from the ownership rule, not from
      // readability, or the test proves nothing.
      const project = await store.createProject({ slug: "pl", name: "PL", access: "public-link" })
      const owner = await upsertTestUser(store, {
        provider: "github", providerUserId: "alice", email: "alice@corp.example",
        displayName: "Alice Owner", avatarUrl: "",
      })
      await store.addProjectMember({ projectId: project.id, userId: owner.id })
      const session = await store.createSession({
        userId: owner.id,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      const cookie = `viewer_session=${signSessionId(authConfig.sessionSecret, session.id)}`
      // Called once per test in this describe (6 of them) — one server, not six.
      stable.use(createApp({ storage: store, assets: nullAssets, config: authConfig, bridgeScript: "// bridge", github: testGithubRuntime() }))
      const app2 = stable.app
      const created = await request(app2)
        .post(`/api/v1/projects/${project.id}/comments`)
        .set("Cookie", cookie)
        .send({ position, body: "the original words" })
      expect(created.status).toBe(201)
      return { store, app: app2, project, owner, cookie, commentId: created.body.id as string }
    }

    it("refuses an anonymous body rewrite of a verified author's comment — 404, no write", async () => {
      const { store, app: app2, project, commentId } = await commentByVerifiedUser()
      const res = await request(app2)
        .patch(`/api/v1/projects/${project.id}/comments/${commentId}`)
        .send({ body: "words the verified user never wrote" })
      // 404, not 403 — this file's existing no-existence-oracle posture.
      expect(res.status).toBe(404)
      expect((await store.getComment(commentId))!.body).toBe("the original words")
    })

    it("refuses an anonymous DELETE of a verified author's comment", async () => {
      const { store, app: app2, project, commentId } = await commentByVerifiedUser()
      expect((await request(app2).delete(`/api/v1/projects/${project.id}/comments/${commentId}`)).status).toBe(404)
      expect(await store.getComment(commentId)).not.toBeNull()
    })

    it("refuses a signed-in NON-member too — authorship, not merely identity", async () => {
      const { store, app: app2, project, commentId } = await commentByVerifiedUser()
      const config = loadConfig({
        VIEWER_ADMIN_TOKEN: "secret",
        VIEWER_GITHUB_CLIENT_ID: "client-id",
        VIEWER_GITHUB_CLIENT_SECRET: "client-secret",
        VIEWER_SESSION_SECRET: "sesh-secret",
        VIEWER_PUBLIC_URL: "http://localhost:3100",
        VIEWER_DATA_DIR: tmpViewerDataDir(),
      })
      const other = await upsertTestUser(store, {
        provider: "github", providerUserId: "mallory", email: "mallory@x.com",
        displayName: "Mallory", avatarUrl: "",
      })
      const session = await store.createSession({
        userId: other.id,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      const res = await request(app2)
        .patch(`/api/v1/projects/${project.id}/comments/${commentId}`)
        .set("Cookie", `viewer_session=${signSessionId(config.sessionSecret, session.id)}`)
        .send({ body: "not mine to edit" })
      expect(res.status).toBe(404)
      expect((await store.getComment(commentId))!.body).toBe("the original words")
    })

    it("allows the AUTHOR to edit and delete their own comment", async () => {
      const { store, app: app2, project, cookie, commentId } = await commentByVerifiedUser()
      const patched = await request(app2)
        .patch(`/api/v1/projects/${project.id}/comments/${commentId}`)
        .set("Cookie", cookie)
        .send({ body: "second thoughts" })
      expect(patched.status).toBe(200)
      expect((await store.getComment(commentId))!.body).toBe("second thoughts")
      expect(
        (await request(app2).delete(`/api/v1/projects/${project.id}/comments/${commentId}`).set("Cookie", cookie)).status,
      ).toBe(204)
    })

    it("keeps the anonymous RESOLVE toggle open — triage is not authorship", async () => {
      // Deliberate scope line: resolving someone else's comment attributes
      // no words to anyone and is trivially reversible, so it stays part of
      // the anonymous-review product.
      const { store, app: app2, project, commentId } = await commentByVerifiedUser()
      const res = await request(app2)
        .patch(`/api/v1/projects/${project.id}/comments/${commentId}`)
        .send({ resolved: true })
      expect(res.status).toBe(200)
      expect((await store.getComment(commentId))!.resolved).toBe(true)
    })

    it("leaves anonymous-authored comments editable by anyone, unchanged", async () => {
      // `viewer:`-prefixed authors are self-declared and unverifiable
      // server-side; pretending otherwise would just break anonymous review.
      const created = await request(app)
        .post(`/api/v1/projects/${projectId}/comments`)
        .send({ position, body: "anon original", author })
      const patched = await request(app)
        .patch(`/api/v1/projects/${projectId}/comments/${created.body.id}`)
        .send({ body: "anon edited" })
      expect(patched.status).toBe(200)
      expect(
        (await request(app).delete(`/api/v1/projects/${projectId}/comments/${created.body.id}`)).status,
      ).toBe(204)
    })
  })

  describe("visibility enforcement", () => {
    /** A 'members' project with a real owner — locked to non-members. */
    async function createLockedProject(storage: InMemoryStorage) {
      const project = await storage.createProject({ slug: "locked", name: "Locked", access: "invited" })
      const owner = await upsertTestUser(storage, {
        provider: "github",
        providerUserId: "owner",
        email: "owner@x.com",
        displayName: "Owner",
        avatarUrl: "",
      })
      await storage.addProjectMember({ projectId: project.id, userId: owner.id })
      return { project, owner }
    }

    function authedConfig() {
      return loadConfig({
        VIEWER_ADMIN_TOKEN: "secret",
        VIEWER_GITHUB_CLIENT_ID: "client-id",
        VIEWER_GITHUB_CLIENT_SECRET: "client-secret",
        VIEWER_SESSION_SECRET: "sesh-secret",
        VIEWER_PUBLIC_URL: "http://localhost:3100",
        VIEWER_DATA_DIR: tmpViewerDataDir(),
      })
    }

    async function signInAs(storage: InMemoryStorage, config: ReturnType<typeof authedConfig>, email: string) {
      const user = await upsertTestUser(storage, {
        provider: "github",
        providerUserId: email,
        email,
        displayName: email,
        avatarUrl: "",
      })
      const session = await storage.createSession({
        userId: user.id,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      return { user, cookie: `viewer_session=${signSessionId(config.sessionSecret, session.id)}` }
    }

    it("GET /comments: 404s a non-member on a locked project, byte-identical to an unknown project", async () => {
      const storage = new InMemoryStorage()
      const { project } = await createLockedProject(storage)
      stable.use(createApp({ storage, assets: nullAssets, config: authedConfig(), bridgeScript: "// bridge", github: testGithubRuntime() }))
      const lockedApp = stable.app

      const denied = await request(lockedApp).get(`/api/v1/projects/${project.id}/comments`)
      const missing = await request(lockedApp).get(`/api/v1/projects/nope/comments`)
      expect(denied.status).toBe(404)
      expect(denied.status).toBe(missing.status)
      expect(denied.body).toEqual(missing.body)
    })

    it("GET /comments: a signed-in member CAN read a locked project", async () => {
      const storage = new InMemoryStorage()
      const config = authedConfig()
      const { project } = await createLockedProject(storage)
      const { user, cookie } = await signInAs(storage, config, "member@x.com")
      await storage.addProjectMember({ projectId: project.id, userId: user.id })
      stable.use(createApp({ storage, assets: nullAssets, config, bridgeScript: "// bridge", github: testGithubRuntime() }))
      const lockedApp = stable.app

      const res = await request(lockedApp).get(`/api/v1/projects/${project.id}/comments`).set("Cookie", cookie)
      expect(res.status).toBe(200)
    })

    it("POST /comments (create): 404s a non-member write on a locked project; the admin bearer still writes", async () => {
      const storage = new InMemoryStorage()
      const { project } = await createLockedProject(storage)
      stable.use(createApp({ storage, assets: nullAssets, config: authedConfig(), bridgeScript: "// bridge", github: testGithubRuntime() }))
      const lockedApp = stable.app

      const denied = await request(lockedApp)
        .post(`/api/v1/projects/${project.id}/comments`)
        .send({ position, body: "hi", author })
      expect(denied.status).toBe(404)
      expect(denied.body).toEqual({ error: "Project not found" })

      const asAdmin = await request(lockedApp)
        .post(`/api/v1/projects/${project.id}/comments`)
        .set({ Authorization: "Bearer secret" })
        .send({ position, body: "hi", author })
      expect(asAdmin.status).toBe(201)
    })

    it("PATCH / reply / delete: all 404 a non-member write on a locked project", async () => {
      const storage = new InMemoryStorage()
      const config = authedConfig()
      const { project } = await createLockedProject(storage)
      // This test used to build TWO apps — one to seed with, one to attack
      // with — from the SAME storage and config, so they only ever differed by
      // the headers each request sent. One app, installed once.
      stable.use(createApp({ storage, assets: nullAssets, config, bridgeScript: "// bridge", github: testGithubRuntime() }))
      const lockedApp = stable.app

      // Seed a comment as the admin (bypasses the visibility gate) so the
      // write-gate on the OTHER routes can be exercised in isolation.
      const seeded = await request(lockedApp)
        .post(`/api/v1/projects/${project.id}/comments`)
        .set({ Authorization: "Bearer secret" })
        .send({ position, body: "root", author })
      const commentId = seeded.body.id

      expect(
        (await request(lockedApp).patch(`/api/v1/projects/${project.id}/comments/${commentId}`).send({ resolved: true }))
          .status,
      ).toBe(404)
      expect(
        (
          await request(lockedApp)
            .post(`/api/v1/projects/${project.id}/comments/${commentId}/replies`)
            .send({ body: "reply", author })
        ).status,
      ).toBe(404)
      expect((await request(lockedApp).delete(`/api/v1/projects/${project.id}/comments/${commentId}`)).status).toBe(404)
    })

    it("GET /comments/stream: 404s the connection for a non-member on a locked project", async () => {
      const storage = new InMemoryStorage()
      const { project } = await createLockedProject(storage)
      stable.use(createApp({ storage, assets: nullAssets, config: authedConfig(), bridgeScript: "// bridge", github: testGithubRuntime() }))
      const lockedApp = stable.app

      const res = await request(lockedApp).get(`/api/v1/projects/${project.id}/comments/stream`)
      expect(res.status).toBe(404)
      expect(res.body).toEqual({ error: "Project not found" })
    })

    /**
     * Fix wave I2. The SSE handler resolved the read context AFTER its
     * `if (!project) → 404` branch, so `Authorization: Bearer garbage`
     * answered "does this project id exist": 404 for an unknown id, 401 for
     * a real one. That's a working existence oracle over exactly the
     * `members` projects Phase 3b-1 made indistinguishable from
     * nonexistent. A statement about the CREDENTIAL must never be
     * sequenced after a statement about the RESOURCE.
     */
    it("GET /comments/stream: an invalid bearer 401s IDENTICALLY for a real project id and a bogus one (no existence oracle)", async () => {
      const storage = new InMemoryStorage()
      const { project } = await createLockedProject(storage)
      stable.use(createApp({ storage, assets: nullAssets, config: authedConfig(), bridgeScript: "// bridge", github: testGithubRuntime() }))
      const lockedApp = stable.app

      const real = await request(lockedApp)
        .get(`/api/v1/projects/${project.id}/comments/stream`)
        .set("Authorization", "Bearer not-a-real-token")
      const bogus = await request(lockedApp)
        .get(`/api/v1/projects/no-such-project-id/comments/stream`)
        .set("Authorization", "Bearer not-a-real-token")

      expect(real.status).toBe(401)
      expect(real.status).toBe(bogus.status)
      expect(real.body).toEqual(bogus.body)
      expect(real.body).toEqual({ error: "Invalid credentials" })
    })

    it("GET /comments/stream: the 401 is the ONLY write — no double-send, no hanging stream", async () => {
      const storage = new InMemoryStorage()
      const { project } = await createLockedProject(storage)
      stable.use(createApp({ storage, assets: nullAssets, config: authedConfig(), bridgeScript: "// bridge", github: testGithubRuntime() }))
      const lockedApp = stable.app

      const res = await request(lockedApp)
        .get(`/api/v1/projects/${project.id}/comments/stream`)
        .set("Authorization", "Bearer not-a-real-token")

      // A 401 that then went on to flush SSE headers would show up here as
      // an event-stream content type and/or a `data:` frame in the body.
      expect(res.status).toBe(401)
      expect(res.headers["content-type"]).toMatch(/application\/json/)
      expect(res.text).not.toContain("data:")
    })

    it("GET /comments/stream: a valid session on a locked project still gets past both gates in the new order", async () => {
      const storage = new InMemoryStorage()
      const { project, owner } = await createLockedProject(storage)
      const config = authedConfig()
      // desde-allow-own-server: this test calls `lockedApp.listen(0)` and
      // drives a raw `http.get`, because an SSE response never ends and
      // supertest would wait for a body forever. It closes the server itself.
      const lockedApp = createApp({ storage, assets: nullAssets, config, bridgeScript: "// bridge", github: testGithubRuntime() })
      const session = await storage.createSession({
        userId: owner.id,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      const cookie = `viewer_session=${signSessionId(config.sessionSecret, session.id)}`

      // The stream never ends, so drive it with a raw request and assert on
      // the status line rather than waiting for a body (same technique the
      // disconnect test above uses).
      const server = lockedApp.listen(0)
      const port = (server.address() as { port: number }).port
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.get(
          {
            port,
            path: `/api/v1/projects/${project.id}/comments/stream`,
            headers: { Cookie: cookie },
          },
          (res) => {
            resolve(res.statusCode ?? 0)
            req.destroy()
          },
        )
        req.on("error", reject)
      })
      server.close()
      expect(status).toBe(200)
    })

    /**
     * Authorization v2 SPLIT this test in two.
     *
     * The `public-link` half is the product invariant and is unchanged: an
     * anonymous holder of the link reads AND writes comments. The
     * `all-members` half used to hold for the same reason (the zero-members
     * migration rule made it world-readable) and no longer does — it is
     * sign-in gated now, so an anonymous caller gets the byte-identical 404,
     * and a signed-in one with no membership row gets the full public-write
     * behaviour.
     */
    it("public-link stays anonymously readable AND writable; all-members needs sign-in but is then equally open", async () => {
      const storage = new InMemoryStorage()
      const openProject = await storage.createProject({ slug: "open", name: "Open" }) // all-members
      const publicProject = await storage.createProject({ slug: "pub", name: "Pub", access: "public-link" })
      const config = authedConfig()
      stable.use(createApp({ storage, assets: nullAssets, config, bridgeScript: "// bridge", github: testGithubRuntime() }))
      const openApp = stable.app

      const created = await request(openApp)
        .post(`/api/v1/projects/${publicProject.id}/comments`)
        .send({ position, body: "hi", author })
      expect(created.status).toBe(201)
      expect((await request(openApp).get(`/api/v1/projects/${publicProject.id}/comments`)).status).toBe(200)

      const anonRead = await request(openApp).get(`/api/v1/projects/${openProject.id}/comments`)
      const anonWrite = await request(openApp)
        .post(`/api/v1/projects/${openProject.id}/comments`)
        .send({ position, body: "hi", author })
      const missing = await request(openApp).get(`/api/v1/projects/no-such-project/comments`)
      expect(anonRead.status).toBe(404)
      expect(anonRead.body).toEqual(missing.body)
      expect(anonWrite.status).toBe(404)

      const someone = await upsertTestUser(storage, {
        provider: "github",
        providerUserId: "someone",
        email: "someone@x.com",
        displayName: "Someone",
        avatarUrl: "",
      })
      const session = await storage.createSession({
        userId: someone.id,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      const cookie = `viewer_session=${signSessionId(config.sessionSecret, session.id)}`
      const signedInWrite = await request(openApp)
        .post(`/api/v1/projects/${openProject.id}/comments`)
        .set("Cookie", cookie)
        .send({ position, body: "hi" })
      expect(signedInWrite.status).toBe(201)
    })
  })
})


/**
 * Found while wiring the Editor to write comments through a machine token.
 * The Editor had to invent a displayName, an email and a photoURL it does
 * not have — discovering each from a SEPARATE 400 that reads like a bug in
 * the Editor rather than a contract detail — for an author object the server
 * then discards, because authorship is server-derived for an authenticated
 * caller (Phase 3b-2).
 */
describe("author is optional for an AUTHENTICATED caller", () => {
  const config = loadConfig({
    VIEWER_ADMIN_TOKEN: "secret",
    VIEWER_GITHUB_CLIENT_ID: "client-id",
    VIEWER_GITHUB_CLIENT_SECRET: "client-secret",
    VIEWER_SESSION_SECRET: "sesh-secret",
    VIEWER_PUBLIC_URL: "http://localhost:3100",
    VIEWER_DATA_DIR: tmpViewerDataDir(),
  })
  let storage: InMemoryStorage
  let app: express.Express
  let projectId: string

  beforeEach(async () => {
    storage = new InMemoryStorage()
    // Reuses the file-level stable app: this is a second top-level `describe`,
    // and describes in one file run sequentially, so there is never a moment
    // where both it and the block above need a live app.
    stable.use(createApp({ storage, assets: nullAssets, config, bridgeScript: "// bridge", github: testGithubRuntime() }))
    app = stable.app
    projectId = (await storage.createProject({ slug: "author-opt", name: "A", access: "public-link" })).id
  })

  async function signedIn(email: string) {
    const user = await upsertTestUser(storage, {
      provider: "github",
      providerUserId: email,
      email,
      displayName: email,
      avatarUrl: "",
    })
    const session = await storage.createSession({
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    return { user, cookie: `viewer_session=${signSessionId(config.sessionSecret, session.id)}` }
  }

  it("accepts a comment with no author at all and derives it from the credential", async () => {
    const { user, cookie } = await signedIn("author-opt@x.com")
    const res = await request(app)
      .post(`/api/v1/projects/${projectId}/comments`)
      .set("Cookie", cookie)
      .send({ position, body: "no author sent" })
    expect(res.status).toBe(201)
    expect(res.body.author.uid).toBe(`user:${user.id}`)
    // Derived server-side and stored; not echoed, because this caller isn't
    // a member of the project (S3 field scoping).
    expect((await storage.getComment(res.body.id))!.author.email).toBe("author-opt@x.com")
    expect(res.body.author.email).toBeUndefined()
  })

  it("still ignores a client-supplied author when one IS sent", async () => {
    const { user, cookie } = await signedIn("author-opt2@x.com")
    const res = await request(app)
      .post(`/api/v1/projects/${projectId}/comments`)
      .set("Cookie", cookie)
      .send({
        position,
        body: "x",
        author: { uid: "viewer:someone-else", displayName: "Impostor", email: "e@x.com", photoURL: "" },
      })
    expect(res.status).toBe(201)
    expect(res.body.author.uid).toBe(`user:${user.id}`)
  })

  /**
   * Anonymous callers are unchanged: for them the author IS the record, so
   * it must still be well-formed or the comment has no attributable origin.
   */
  it("still requires a well-formed author from an ANONYMOUS caller", async () => {
    const res = await request(app).post(`/api/v1/projects/${projectId}/comments`).send({ position, body: "x" })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/author/)
  })
})

/**
 * The anonymous-write kill switch.
 *
 * Default ON, because anonymous review links are the product. An operator turns
 * it off for a deployment whose projects are reachable by strangers, where
 * "anyone can read" would otherwise also mean "anyone can post, edit and
 * delete". These assert that the switch gates exactly writes-by-nobody, and
 * nothing else.
 */
describe("allowAnonymousComments", () => {
  let storage: InMemoryStorage
  let app: express.Express
  let projectId: string

  beforeEach(async () => {
    storage = new InMemoryStorage()
    stable.use(
      createApp({
        storage,
        assets: nullAssets,
        config: loadConfig({ VIEWER_ADMIN_TOKEN: "secret", VIEWER_DATA_DIR: tmpViewerDataDir() }),
        bridgeScript: "// bridge",
        changeBus: createCommentChangeBus(),
        github: testGithubRuntime(),
      }),
    )
    app = stable.app
    projectId = (
      await storage.createProject({ slug: "demo", name: "Demo", repoUrl: null, access: "public-link" })
    ).id
  })

  async function turnOff() {
    await storage.setInstanceSetting(ALLOW_ANONYMOUS_COMMENTS_KEY, String(false))
    invalidateInstanceSettingsCache(storage)
  }

  const body = { position, body: "hello", author }

  it("allows an anonymous comment by default", async () => {
    await request(app).post(`/api/v1/projects/${projectId}/comments`).send(body).expect(201)
  })

  it("refuses an anonymous comment when the switch is off", async () => {
    await turnOff()
    const res = await request(app).post(`/api/v1/projects/${projectId}/comments`).send(body).expect(403)
    expect(res.body.error).toMatch(/sign in/i)
  })

  it("still lets an anonymous visitor READ the conversation", async () => {
    // The switch gates writes only. A visitor who cannot join the conversation
    // must still be able to see it, or the demo it exists for shows nothing.
    await request(app).post(`/api/v1/projects/${projectId}/comments`).send(body).expect(201)
    await turnOff()
    const res = await request(app).get(`/api/v1/projects/${projectId}/comments`).expect(200)
    expect(res.body.comments).toHaveLength(1)
  })

  it("still lets a credentialled caller write when the switch is off", async () => {
    // The admin bearer stands in for any identified caller. The switch is about
    // callers with NO credential, not about authority.
    await turnOff()
    await request(app)
      .post(`/api/v1/projects/${projectId}/comments`)
      .set(asInsider)
      .send(body)
      .expect(201)
  })

  it("refuses anonymous edits and deletes too, not just creates", async () => {
    const created = await request(app)
      .post(`/api/v1/projects/${projectId}/comments`)
      .send(body)
      .expect(201)
    await turnOff()
    await request(app)
      .patch(`/api/v1/projects/${projectId}/comments/${created.body.id}`)
      .send({ body: "edited" })
      .expect(403)
    await request(app)
      .delete(`/api/v1/projects/${projectId}/comments/${created.body.id}`)
      .expect(403)
  })
})
