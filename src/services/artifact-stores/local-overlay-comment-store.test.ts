import { describe, expect, it } from "vitest"
import { createInMemoryCommentStore } from "@/editor/core/stores/in-memory-comment-store"
import { createLocalOverlayCommentStore } from "./local-overlay-comment-store"

const author = { uid: "viewer:mo", displayName: "Mo", email: "", photoURL: "" }
const position = { anchorSelector: "#cta", page: "/", anchorX: 1, anchorY: 2 }

function make(allowRemoteWrites: boolean) {
  const base = createInMemoryCommentStore()
  const store = createLocalOverlayCommentStore({ base, allowRemoteWrites })
  return { base, store }
}

async function seed(base: ReturnType<typeof createInMemoryCommentStore>, body: string) {
  return base.create({ position, body, author })
}

describe("createLocalOverlayCommentStore — writes allowed", () => {
  it("passes every write through to the base store", async () => {
    const { base, store } = make(true)
    await store.create({ position, body: "hello", author })
    expect(await base.list()).toHaveLength(1)
  })
})

describe("createLocalOverlayCommentStore — writes refused", () => {
  it("keeps a created comment out of the base store", async () => {
    const { base, store } = make(false)
    await store.create({ position, body: "mine", author })
    expect(await base.list()).toHaveLength(0)
    expect(await store.list()).toHaveLength(1)
  })

  it("still reports the seeded conversation", async () => {
    const { base, store } = make(false)
    await seed(base, "from the server")
    await store.create({ position, body: "mine", author })
    const all = await store.list()
    expect(all.map((c) => c.body).sort()).toEqual(["from the server", "mine"])
  })

  it("edits a SEEDED comment locally, leaving the server's copy alone", async () => {
    const { base, store } = make(false)
    const seeded = await seed(base, "original")
    await store.list()
    await store.update(seeded.id, { body: "edited by the visitor" })
    expect((await base.get(seeded.id))?.body).toBe("original")
    expect((await store.get(seeded.id))?.body).toBe("edited by the visitor")
  })

  it("a local edit survives the base store re-reporting the original", async () => {
    // The HTTP store polls. Without the override outranking the base snapshot,
    // the visitor's edit would silently revert on the next tick.
    const { base, store } = make(false)
    const seeded = await seed(base, "original")
    let latest: { id: string; body: string }[] = []
    store.subscribe((comments) => {
      latest = comments.map((c) => ({ id: c.id, body: c.body }))
    })
    await store.list()
    await store.update(seeded.id, { body: "edited" })
    // Force a base emission, as a poll would.
    await base.update(seeded.id, { resolved: false })
    expect(latest.find((c) => c.id === seeded.id)?.body).toBe("edited")
  })

  it("hides a locally deleted seeded comment, and does not resurrect it", async () => {
    const { base, store } = make(false)
    const seeded = await seed(base, "goes away")
    await store.list()
    await store.delete(seeded.id)
    expect(await store.list()).toHaveLength(0)
    expect(await base.list()).toHaveLength(1)
  })

  it("replies to a seeded comment locally", async () => {
    const { base, store } = make(false)
    const seeded = await seed(base, "thread")
    await store.list()
    const replied = await store.addReply(seeded.id, { body: "my reply", author })
    expect(replied.replies?.map((r) => r.body)).toEqual(["my reply"])
    expect((await base.get(seeded.id))?.replies ?? []).toHaveLength(0)
  })

  it("notifies subscribers when a local write lands", async () => {
    const { store } = make(false)
    const seen: number[] = []
    store.subscribe((comments) => seen.push(comments.length))
    await store.create({ position, body: "mine", author })
    expect(seen[seen.length - 1]).toBe(1)
  })

  it("throws rather than silently no-op when editing an unknown id", async () => {
    const { store } = make(false)
    await expect(store.update("nope", { body: "x" })).rejects.toThrow(/not found/i)
  })
})

describe("setAllowRemoteWrites", () => {
  it("switches a store from local to remote without rebuilding it", async () => {
    // The whole reason the cell lives in the store: the answer arrives from the
    // server after construction, and rebuilding would drop the surface's
    // existing subscription.
    const { base, store } = make(false)
    await store.create({ position, body: "local", author })
    expect(await base.list()).toHaveLength(0)
    store.setAllowRemoteWrites(true)
    await store.create({ position, body: "remote", author })
    expect((await base.list()).map((c) => c.body)).toEqual(["remote"])
  })

  it("defaults to allowing remote writes when unspecified", async () => {
    const base = createInMemoryCommentStore()
    const store = createLocalOverlayCommentStore({ base })
    await store.create({ position, body: "hello", author })
    expect(await base.list()).toHaveLength(1)
  })
})

/**
 * `subscribe` must not emit before the base store has said anything.
 *
 * It used to, with a comment claiming it matched "the contract every other
 * implementation follows". It did not: neither `http-comment-store` nor
 * `viewer-http-comment-store` emits on subscribe, and both fetch first.
 *
 * The cost of that emission was real. `baseSnapshot` starts empty, so the
 * consumer received `[]` before the backend had answered, and the review
 * shell treats ANY emission as loaded (`setHasLoadedOnce(true)` plus
 * `setLoadError(null)`). A later load FAILURE could then no longer reach its
 * own branch, which is gated on `!hasLoadedOnce`, so a list that failed to
 * load rendered as "No comments". Found by a codex review.
 */
describe("subscribe does not claim a snapshot it does not have", () => {
  /** A base store that never answers, standing in for a request in flight. */
  function pendingBase() {
    return {
      list: async () => [],
      create: async () => {
        throw new Error("not used")
      },
      update: async () => {
        throw new Error("not used")
      },
      remove: async () => {
        throw new Error("not used")
      },
      subscribe: () => () => {},
    }
  }

  it("stays silent while the base store is still loading", () => {
    const store = createLocalOverlayCommentStore({
      base: pendingBase() as never,
      allowRemoteWrites: false,
    })
    const emissions: number[] = []
    store.subscribe((comments) => emissions.push(comments.length))

    // Against the old code this was [0]: an empty list presented as an
    // answer, which is what let a load failure read as "No comments".
    expect(emissions).toEqual([])
  })

  it("still emits a locally created comment with no backend answer at all", () => {
    // The reason dropping the immediate emit is safe. Every local mutation
    // calls emit() itself, so the overlay's whole point survives.
    const store = createLocalOverlayCommentStore({
      base: pendingBase() as never,
      allowRemoteWrites: false,
    })
    const emissions: number[] = []
    store.subscribe((comments) => emissions.push(comments.length))
    return store.create({ position, body: "mine", author }).then(() => {
      expect(emissions).toEqual([1])
    })
  })
})

/**
 * The other ordering: a local comment created BEFORE anyone subscribes.
 *
 * Removing the unconditional first emission fixed the "empty list read as
 * loaded" bug and introduced this one: the mutation's own `emit()` fired
 * when there were no listeners, so if the base store never answers, a later
 * subscriber saw nothing, forever. It also broke `subscribe`'s contract,
 * which is to hand over a full snapshot. Found by a third codex round, on
 * the fix rather than on the original code.
 *
 * The rule that satisfies both: emit what is KNOWN, stay silent when nothing
 * is known. An empty first emission is the only one that misleads.
 */
describe("subscribe hands over local state that already exists", () => {
  function pendingBase() {
    return {
      list: async () => [],
      create: async () => {
        throw new Error("not used")
      },
      update: async () => {
        throw new Error("not used")
      },
      remove: async () => {
        throw new Error("not used")
      },
      subscribe: () => () => {},
    }
  }

  it("emits to a listener that subscribes AFTER a local comment was created", async () => {
    const store = createLocalOverlayCommentStore({
      base: pendingBase() as never,
      allowRemoteWrites: false,
    })
    await store.create({ position, body: "written before anyone was listening", author })

    const emissions: number[] = []
    store.subscribe((comments) => emissions.push(comments.length))

    // Against the over-corrected version this was []: the comment existed and
    // the new subscriber was never told.
    expect(emissions).toEqual([1])
  })

  it("still says nothing when there is genuinely nothing to say", () => {
    // The original bug must stay fixed. An empty first emission is the one
    // that reads as "loaded, and empty".
    const store = createLocalOverlayCommentStore({
      base: pendingBase() as never,
      allowRemoteWrites: false,
    })
    const emissions: number[] = []
    store.subscribe((comments) => emissions.push(comments.length))
    expect(emissions).toEqual([])
  })
})
