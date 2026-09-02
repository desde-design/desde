import { describe, expect, it, vi } from "vitest"
import { attachBearer, createViewerHttpCommentStore, type EventSourceLike } from "./viewer-http-comment-store"
import type { Comment } from "../../types/bridge"

const author = { uid: "viewer:mo", displayName: "Mo", email: "mo@example.com", photoURL: "" }
const position = { anchorSelector: "#cta", page: "/" }

function makeFakeBackend() {
  let comments: Comment[] = []
  let seq = 0
  const sources: FakeEventSource[] = []
  class FakeEventSource implements EventSourceLike {
    onmessage: ((ev: { data: string }) => void) | null = null
    onerror: ((ev: unknown) => void) | null = null
    closed = false
    constructor(public url: string) { sources.push(this) }
    close() { this.closed = true }
    fire() { this.onmessage?.({ data: '{"type":"changed"}' }) }
  }
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? "GET"
    const respond = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
    if (method === "GET" && u.endsWith("/comments")) return respond(200, { comments })
    if (method === "POST" && u.endsWith("/comments")) {
      const input = JSON.parse(String(init?.body))
      const created: Comment = {
        id: `c${++seq}`, number: seq, position: input.position, body: input.body, author: input.author,
        createdAt: new Date(2030, 0, seq).toISOString(), resolved: false, replies: [],
        mentions: input.mentions ?? [], participantEmails: [input.author.email], projectId: "p1",
      }
      comments = [...comments, created]
      for (const s of sources) s.fire()
      return respond(201, created)
    }
    if (method === "PATCH") {
      const id = u.split("/").at(-1)!
      comments = comments.map((c) => (c.id === id ? { ...c, ...JSON.parse(String(init?.body)) } : c))
      for (const s of sources) s.fire()
      return respond(200, comments.find((c) => c.id === id))
    }
    if (method === "DELETE") {
      const id = u.split("/").at(-1)!
      comments = comments.filter((c) => c.id !== id)
      for (const s of sources) s.fire()
      return new Response(null, { status: 204 })
    }
    if (method === "POST" && u.endsWith("/replies")) return respond(200, comments[0])
    return respond(404, { error: "not found" })
  })
  return { fetchImpl, sources, FakeEventSource, getComments: () => comments }
}

function makeStore(
  backend: ReturnType<typeof makeFakeBackend>,
  overrides: { pollIntervalMs?: number } = {},
) {
  return createViewerHttpCommentStore({
    baseUrl: "http://viewer.test",
    projectId: "p1",
    fetchImpl: backend.fetchImpl as unknown as typeof fetch,
    eventSourceFactory: (url) => new backend.FakeEventSource(url),
    ...overrides,
  })
}

describe("createViewerHttpCommentStore", () => {
  it("creates via POST and lists via GET against the project-scoped routes", async () => {
    const backend = makeFakeBackend()
    const store = makeStore(backend)
    const created = await store.create({ position, body: "hello", author })
    expect(created.id).toBe("c1")
    expect(await store.list()).toHaveLength(1)
    const postCall = backend.fetchImpl.mock.calls.find(([, init]) => (init as RequestInit)?.method === "POST")!
    expect(String(postCall[0])).toBe("http://viewer.test/api/v1/projects/p1/comments")
  })

  it("subscribe emits the current snapshot immediately, re-emits on SSE change, and stops after unsubscribe", async () => {
    const backend = makeFakeBackend()
    const store = makeStore(backend)
    await store.create({ position, body: "first", author })
    const emissions: Comment[][] = []
    const unsubscribe = store.subscribe((list) => emissions.push(list))
    await vi.waitFor(() => expect(emissions).toHaveLength(1))
    expect(emissions[0]).toHaveLength(1)
    await store.create({ position, body: "second", author })
    await vi.waitFor(() => expect(emissions.length).toBeGreaterThanOrEqual(2))
    expect(emissions.at(-1)).toHaveLength(2)
    unsubscribe()
    expect(backend.sources.every((s) => s.closed)).toBe(true)
    const before = emissions.length
    await store.create({ position, body: "third", author })
    await new Promise((r) => setTimeout(r, 50))
    expect(emissions.length).toBe(before)
  })

  it("update and delete hit the comment-scoped routes and 404s reject", async () => {
    const backend = makeFakeBackend()
    const store = makeStore(backend)
    const c = await store.create({ position, body: "x", author })
    const updated = await store.update(c.id, { resolved: true })
    expect(updated.resolved).toBe(true)
    await store.delete(c.id)
    expect(await store.list()).toHaveLength(0)
    await expect(store.update("missing", { resolved: true })).rejects.toThrow()
  })

  it("ignores a stale list refetch that resolves after a newer one (dispatch race)", async () => {
    // `subscribe`'s immediate initial refetch races the server's
    // `connected` SSE frame (any SSE message triggers a refetch), and
    // two independent HTTP round-trips can resolve out of dispatch
    // order. This drives that race directly: hold the FIRST GET open,
    // dispatch a SECOND via a fake SSE message, resolve the second
    // (fresh, 2 comments) before the first (stale, 1 comment), and
    // assert the stale result never overwrites the fresh one.
    const makeComment = (id: string, n: number): Comment => ({
      id,
      number: n,
      position,
      body: `body-${id}`,
      author,
      createdAt: new Date(2030, 0, n).toISOString(),
      resolved: false,
      replies: [],
      mentions: [],
      participantEmails: [author.email],
      projectId: "p1",
    })
    const staleList = [makeComment("c1", 1)]
    const freshList = [makeComment("c1", 1), makeComment("c2", 2)]

    type PendingGet = { resolve: (comments: Comment[]) => void }
    const pendingGets: PendingGet[] = []
    const sources: FakeEventSource[] = []
    class FakeEventSource implements EventSourceLike {
      onmessage: ((ev: { data: string }) => void) | null = null
      onerror: ((ev: unknown) => void) | null = null
      closed = false
      constructor(public url: string) { sources.push(this) }
      close() { this.closed = true }
      fire() { this.onmessage?.({ data: '{"type":"changed"}' }) }
    }
    const fetchImpl = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url)
      const method = init?.method ?? "GET"
      if (method === "GET" && u.endsWith("/comments")) {
        return new Promise<Response>((resolve) => {
          pendingGets.push({
            resolve: (comments) =>
              resolve(
                new Response(JSON.stringify({ comments }), {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                }),
              ),
          })
        })
      }
      throw new Error(`unexpected fetch in race test: ${method} ${u}`)
    })

    const store = createViewerHttpCommentStore({
      baseUrl: "http://viewer.test",
      projectId: "p1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      eventSourceFactory: (url) => new FakeEventSource(url),
    })

    const emissions: Comment[][] = []
    store.subscribe((list) => emissions.push(list))
    // The initial `emitIfChanged()` dispatches its GET synchronously
    // (up to the first `await` inside an async function body runs
    // synchronously on invocation).
    expect(pendingGets).toHaveLength(1)

    // Simulate the server's SSE frame arriving before the initial GET
    // resolves — this dispatches a second, independent GET.
    sources[0].fire()
    expect(pendingGets).toHaveLength(2)

    // Resolve the SECOND (newer) dispatch first, with the fresh list.
    pendingGets[1].resolve(freshList)
    await vi.waitFor(() => expect(emissions).toHaveLength(1))
    expect(emissions[0]).toHaveLength(2)

    // Now resolve the FIRST (older) dispatch, with a stale list. It
    // must be ignored — no new emission, and the last emission must
    // still be the fresh 2-comment list.
    pendingGets[0].resolve(staleList)
    await new Promise((r) => setTimeout(r, 20))
    expect(emissions).toHaveLength(1)
    expect(emissions.at(-1)).toHaveLength(2)
  })

  it("does NOT re-invoke the success listener when the poll fallback recovers with an UNCHANGED list — consumers must not rely on the listener to detect recovery", async () => {
    // Documents the dedup contract `emitIfChanged` implements
    // (`serialized !== lastSerialized` gates the `listener` call): after
    // `onError` fires (SSE blip) and the poll fallback kicks in, a
    // successful-but-unchanged refetch does NOT call `listener` again.
    // A consumer that clears its own error state only inside the success
    // listener (e.g. `review-shell.tsx`'s old approach) would stay stuck
    // showing the error forever in this exact scenario — which is why the
    // shell instead tracks "has loaded at least once" independently of
    // whether the listener fires again.
    const backend = makeFakeBackend()
    const store = makeStore(backend, { pollIntervalMs: 10 })
    await store.create({ position, body: "first", author })

    const emissions: Comment[][] = []
    const errors: unknown[] = []
    store.subscribe(
      (list) => emissions.push(list),
      (err) => errors.push(err),
    )
    await vi.waitFor(() => expect(emissions).toHaveLength(1))
    expect(emissions[0]).toHaveLength(1)

    // Simulate an SSE blip — the store's `onerror` handler notifies
    // `onError` and starts the poll fallback.
    expect(backend.sources).toHaveLength(1)
    backend.sources[0].onerror?.(new Event("error"))
    await vi.waitFor(() => expect(errors).toHaveLength(1))

    // The poll fallback's next tick (pollIntervalMs: 10 here) refetches
    // successfully, but the list on the server hasn't changed — so
    // `emitIfChanged`'s dedup suppresses the listener call. No new
    // emission arrives, proving a consumer cannot detect "recovered"
    // purely from the listener firing again.
    await new Promise((r) => setTimeout(r, 80))
    expect(emissions).toHaveLength(1)
    expect(errors).toHaveLength(1)
  })

  describe("authToken", () => {
    function headersOf(init: RequestInit | undefined): Record<string, string> {
      return { ...(init?.headers as Record<string, string> | undefined) }
    }

    it("sends no Authorization header at all when authToken is unset (the shipped review page's path)", async () => {
      const backend = makeFakeBackend()
      const store = makeStore(backend)
      await store.create({ position, body: "hello", author })
      await store.list()
      await store.update((await store.list())[0]!.id, { resolved: true })

      for (const call of backend.fetchImpl.mock.calls) {
        const headers = headersOf(call[1] as RequestInit | undefined)
        expect("Authorization" in headers).toBe(false)
      }
    })

    it("sends Authorization: Bearer <token> on every request when authToken is set — create, list, update, delete, addReply", async () => {
      const backend = makeFakeBackend()
      const store = createViewerHttpCommentStore({
        baseUrl: "http://viewer.test",
        projectId: "p1",
        fetchImpl: backend.fetchImpl as unknown as typeof fetch,
        eventSourceFactory: (url) => new backend.FakeEventSource(url),
        authToken: "tok-123",
      })

      const created = await store.create({ position, body: "hello", author })
      await store.list()
      await store.update(created.id, { resolved: true })
      await store.addReply(created.id, { body: "reply", author })
      await store.delete(created.id)

      expect(backend.fetchImpl.mock.calls.length).toBeGreaterThan(0)
      for (const call of backend.fetchImpl.mock.calls) {
        const headers = headersOf(call[1] as RequestInit | undefined)
        expect(headers.Authorization).toBe("Bearer tok-123")
      }
    })

    it("preserves existing headers (e.g. Content-Type) alongside Authorization", async () => {
      const backend = makeFakeBackend()
      const store = createViewerHttpCommentStore({
        baseUrl: "http://viewer.test",
        projectId: "p1",
        fetchImpl: backend.fetchImpl as unknown as typeof fetch,
        eventSourceFactory: (url) => new backend.FakeEventSource(url),
        authToken: "tok-123",
      })
      await store.create({ position, body: "hello", author })
      const postCall = backend.fetchImpl.mock.calls.find(
        ([, init]) => (init as RequestInit)?.method === "POST",
      )!
      const headers = headersOf(postCall[1] as RequestInit | undefined)
      expect(headers["Content-Type"]).toBe("application/json")
      expect(headers.Authorization).toBe("Bearer tok-123")
    })

    /**
     * Fix wave M7. `withAuth` used to spread `init.headers as
     * Record<string, string>` — a cast that's only correct for ONE of the
     * three legal `HeadersInit` shapes. Spreading a `Headers` yields an
     * EMPTY object (its entries live behind an iterator, not own
     * properties) and spreading an entry array yields numeric keys, so in
     * both cases the caller's headers were silently dropped while the cast
     * suppressed the type error. Every call site in the store passes an
     * object literal today, so the bug was latent — which is exactly why
     * `attachBearer` is exported and tested directly: the non-object
     * branches are unreachable through the public `CommentStore` surface.
     */
    describe("attachBearer — shape-safe across every HeadersInit form (fix wave M7)", () => {
      function headersFrom(init: RequestInit | undefined): Record<string, string> {
        return (init?.headers ?? {}) as Record<string, string>
      }

      it("returns the SAME init reference untouched when there is no token", () => {
        const init: RequestInit = { method: "POST", headers: { "Content-Type": "application/json" } }
        expect(attachBearer(init, undefined)).toBe(init)
        expect(attachBearer(undefined, undefined)).toBeUndefined()
      })

      it("merges into a plain-object HeadersInit", () => {
        const merged = headersFrom(
          attachBearer({ headers: { "Content-Type": "application/json" } }, "tok-123"),
        )
        expect(merged["Content-Type"]).toBe("application/json")
        expect(merged.Authorization).toBe("Bearer tok-123")
      })

      it("preserves a Headers instance's entries instead of dropping them", () => {
        const headers = new Headers()
        headers.set("Content-Type", "application/json")
        headers.set("X-Trace", "abc")
        const merged = headersFrom(attachBearer({ headers }, "tok-123"))
        // Headers lowercases its names on iteration — what matters is that
        // the values SURVIVED, which the old cast-and-spread lost entirely.
        expect(merged["content-type"]).toBe("application/json")
        expect(merged["x-trace"]).toBe("abc")
        expect(merged.Authorization).toBe("Bearer tok-123")
      })

      it("preserves an entry-array HeadersInit instead of turning it into numeric keys", () => {
        const merged = headersFrom(
          attachBearer(
            { headers: [["Content-Type", "application/json"], ["X-Trace", "abc"]] },
            "tok-123",
          ),
        )
        expect(merged["Content-Type"]).toBe("application/json")
        expect(merged["X-Trace"]).toBe("abc")
        expect(merged.Authorization).toBe("Bearer tok-123")
        expect(merged["0"]).toBeUndefined()
      })

      it("handles an init with no headers at all", () => {
        const merged = headersFrom(attachBearer({ method: "DELETE" }, "tok-123"))
        expect(merged).toEqual({ Authorization: "Bearer tok-123" })
        expect(attachBearer(undefined, "tok-123")?.headers).toEqual({ Authorization: "Bearer tok-123" })
      })

      it("overrides a caller-supplied Authorization under any casing rather than sending two", () => {
        const merged = headersFrom(attachBearer({ headers: { authorization: "Bearer stale" } }, "tok-123"))
        expect(Object.keys(merged)).toEqual(["Authorization"])
        expect(merged.Authorization).toBe("Bearer tok-123")
      })

      it("leaves the rest of init (method, body) intact", () => {
        const result = attachBearer({ method: "POST", body: "{}" }, "tok-123")
        expect(result?.method).toBe("POST")
        expect(result?.body).toBe("{}")
      })
    })

    it("never opens an EventSource when authToken is set — it polls from the start instead", async () => {
      const backend = makeFakeBackend()
      const store = createViewerHttpCommentStore({
        baseUrl: "http://viewer.test",
        projectId: "p1",
        fetchImpl: backend.fetchImpl as unknown as typeof fetch,
        eventSourceFactory: (url) => new backend.FakeEventSource(url),
        authToken: "tok-123",
        pollIntervalMs: 10,
      })
      await store.create({ position, body: "first", author })

      const emissions: Comment[][] = []
      const unsubscribe = store.subscribe((list) => emissions.push(list))
      await vi.waitFor(() => expect(emissions).toHaveLength(1))
      expect(backend.sources).toHaveLength(0)

      // The poll fallback (not SSE) picks up a subsequent write.
      await store.create({ position, body: "second", author })
      // The fake backend's mutating handlers also fire any registered SSE
      // sources, so drop the source-count assertion after this write — the
      // meaningful assertion is that the emission arrived via polling with
      // zero sources ever having been opened.
      await vi.waitFor(() => expect(emissions.length).toBeGreaterThanOrEqual(2))
      expect(backend.sources).toHaveLength(0)

      unsubscribe()
    })

    it("still opens EventSource (unchanged) when authToken is unset", async () => {
      const backend = makeFakeBackend()
      const store = makeStore(backend)
      const unsubscribe = store.subscribe(() => {})
      await vi.waitFor(() => expect(backend.sources).toHaveLength(1))
      unsubscribe()
    })

    it("does not leak the token into thrown error messages", async () => {
      const backend = makeFakeBackend()
      const store = createViewerHttpCommentStore({
        baseUrl: "http://viewer.test",
        projectId: "p1",
        fetchImpl: backend.fetchImpl as unknown as typeof fetch,
        eventSourceFactory: (url) => new backend.FakeEventSource(url),
        authToken: "super-secret-token",
      })
      await expect(store.update("missing", { resolved: true })).rejects.toThrow()
      try {
        await store.update("missing", { resolved: true })
      } catch (err) {
        expect(String(err)).not.toContain("super-secret-token")
      }
    })
  })
})
