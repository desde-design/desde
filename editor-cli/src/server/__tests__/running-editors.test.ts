/**
 * The launcher's one-editor-per-repo memory.
 *
 * The case that matters is the first one: the same repo opened twice, from
 * Home, must answer with the editor that is already running rather than
 * spawning a second one. On Next that second spawn is not a waste but a refusal
 * (the per-project lock), and the message named the launcher's own child as
 * the intruder. Everything else here is the bookkeeping that keeps the first
 * case from turning into a stale-URL trap: a dead child, a failed spawn, and a
 * race between two opens.
 */
import { describe, expect, it, vi } from "vitest"
import { withRunningEditorReuse, type SpawnedEditor } from "../running-editors.js"

/** A controllable exit signal, so the test decides when the child dies. */
function spawned(url: string): SpawnedEditor & { exit: () => void } {
  let exit!: () => void
  const exited = new Promise<void>((done) => {
    exit = done
  })
  return { url, exited, exit }
}

const identity = { canonicalize: async (p: string) => p }

describe("withRunningEditorReuse", () => {
  it("answers a second open of the same repo with the running editor, spawning once", async () => {
    const spawn = vi.fn(async (repoPath: string) => spawned(`http://127.0.0.1:1/${repoPath}`))
    const open = withRunningEditorReuse(spawn, identity)

    const first = await open("/repo/a")
    const second = await open("/repo/a")

    expect(second.url).toBe(first.url)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it("keeps different repos apart", async () => {
    const spawn = vi.fn(async (repoPath: string) => spawned(`http://127.0.0.1:1/${repoPath}`))
    const open = withRunningEditorReuse(spawn, identity)

    await open("/repo/a")
    await open("/repo/b")

    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it("shares ONE spawn between two opens that race", async () => {
    let release!: (value: SpawnedEditor) => void
    const spawn = vi.fn(
      () =>
        new Promise<SpawnedEditor>((done) => {
          release = done
        }),
    )
    const open = withRunningEditorReuse(spawn, identity)

    const a = open("/repo/a")
    const b = open("/repo/a")
    // Both opens canonicalise (async) before reaching the spawn; let them.
    await new Promise((r) => setImmediate(r))
    release(spawned("http://127.0.0.1:1/a"))

    expect((await a).url).toBe("http://127.0.0.1:1/a")
    expect((await b).url).toBe("http://127.0.0.1:1/a")
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it("spawns again once the running editor has exited", async () => {
    const first = spawned("http://127.0.0.1:1/first")
    const second = spawned("http://127.0.0.1:1/second")
    const spawn = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const open = withRunningEditorReuse(spawn, identity)

    expect((await open("/repo/a")).url).toBe(first.url)
    first.exit()
    // The exit listener runs on a microtask after `exited` settles.
    await first.exited
    await new Promise((r) => setImmediate(r))

    expect((await open("/repo/a")).url).toBe(second.url)
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it("forgets a spawn that failed, so the next open retries instead of replaying the failure", async () => {
    const spawn = vi
      .fn()
      .mockRejectedValueOnce(new Error("boot failed"))
      .mockResolvedValueOnce(spawned("http://127.0.0.1:1/ok"))
    const open = withRunningEditorReuse(spawn, identity)

    await expect(open("/repo/a")).rejects.toThrow("boot failed")
    expect((await open("/repo/a")).url).toBe("http://127.0.0.1:1/ok")
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it("does not drop a newer editor when an older one's exit lands late", async () => {
    const first = spawned("http://127.0.0.1:1/first")
    const second = spawned("http://127.0.0.1:1/second")
    const spawn = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const open = withRunningEditorReuse(spawn, identity)

    await open("/repo/a")
    first.exit()
    await first.exited
    await new Promise((r) => setImmediate(r))
    await open("/repo/a")
    // A second, late exit signal from the FIRST child must not evict the second.
    first.exit()
    await new Promise((r) => setImmediate(r))

    expect((await open("/repo/a")).url).toBe(second.url)
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it("keys on the canonical path, so two spellings of one folder share an editor", async () => {
    const spawn = vi.fn(async (repoPath: string) => spawned(`http://127.0.0.1:1/${repoPath}`))
    const open = withRunningEditorReuse(spawn, {
      canonicalize: async (p) => p.replace(/\/\.\//g, "/"),
    })

    await open("/repo/a")
    await open("/repo/./a")

    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it("answers an open for a seeded repo with the seeded editor, spawning nothing", async () => {
    // The editor that started this launcher from its own Home breadcrumb.
    const spawn = vi.fn(async (repoPath: string) => spawned(`http://127.0.0.1:1/${repoPath}`))
    const open = withRunningEditorReuse(spawn, {
      ...identity,
      seed: [{ repoPath: "/repo/parent", url: "http://127.0.0.1:4321" }],
    })

    expect((await open("/repo/parent")).url).toBe("http://127.0.0.1:4321")
    expect(spawn).not.toHaveBeenCalled()
    await open("/repo/other")
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it("two opens racing on the very first call both see the seed", async () => {
    const spawn = vi.fn(async (repoPath: string) => spawned(`http://127.0.0.1:1/${repoPath}`))
    const open = withRunningEditorReuse(spawn, {
      // Slow canonicalisation widens the window the race needs.
      canonicalize: (p) => new Promise((r) => setTimeout(() => r(p), 10)),
      seed: [{ repoPath: "/repo/parent", url: "http://127.0.0.1:4321" }],
    })

    const [a, b] = await Promise.all([open("/repo/parent"), open("/repo/parent")])

    expect(a.url).toBe("http://127.0.0.1:4321")
    expect(b.url).toBe("http://127.0.0.1:4321")
    expect(spawn).not.toHaveBeenCalled()
  })

  it("an entry with no exit signal stays until the launcher goes", async () => {
    const spawn = vi.fn(async (): Promise<SpawnedEditor> => ({ url: "http://127.0.0.1:1/stub" }))
    const open = withRunningEditorReuse(spawn, identity)

    await open("/repo/a")
    await open("/repo/a")

    expect(spawn).toHaveBeenCalledTimes(1)
  })
})
