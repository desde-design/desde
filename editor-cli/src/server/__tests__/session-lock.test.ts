/**
 * Tests for the CLI session lock + the per-repo reader-writer gate.
 *
 * The load-bearing properties:
 *  - `withCliSessionLock`: two ops against the same key run strictly serially.
 *    Codex flagged the absence of this serialization as a blocker (Save racing
 *    Discard around the worktree's git index).
 *  - `withFileEditLocks` / `withTreeLock` (Task 11): file-scoped ops on
 *    DIFFERENT files run concurrently (so one slow LLM-lane edit stops
 *    blocking every other edit), same-file ops serialize, tree-scoped ops
 *    (commit/publish/branch switch) exclude all file ops, and a pending tree
 *    op can't be starved by a stream of edits.
 *
 * Style note: concurrency is asserted with an ordered event log + explicit
 * deferred promises rather than timers — a timer-based test can pass on a
 * lucky schedule; a deferred one can only pass if the lock actually let the
 * second op enter.
 */

import { afterEach, describe, expect, it } from "vitest"
import {
  _inspectCliLocksForTests,
  _resetCliSessionLockForTests,
  fileEditLockKey,
  normalizeLockPath,
  withCliSessionLock,
  withFileEditLocks,
  withGitIndexLock,
  withTreeLock,
} from "../session-lock"

afterEach(() => {
  _resetCliSessionLockForTests()
})

const ROOT = "/tmp/repo"

/** A promise plus its resolver — lets a test hold an op open deterministically. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Yield enough microtask/macrotask turns for any unblocked op to enter. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

describe("withCliSessionLock", () => {
  it("serializes ops with the same session id", async () => {
    const order: string[] = []
    const slow = withCliSessionLock("abc", async () => {
      order.push("slow-start")
      await new Promise((r) => setTimeout(r, 20))
      order.push("slow-end")
    })
    // Kick the second op AFTER the first is started but before it
    // finishes. Without the lock, both would interleave.
    await new Promise((r) => setTimeout(r, 5))
    const fast = withCliSessionLock("abc", async () => {
      order.push("fast-start")
      order.push("fast-end")
    })
    await Promise.all([slow, fast])
    expect(order).toEqual(["slow-start", "slow-end", "fast-start", "fast-end"])
  })

  it("does NOT serialize ops with different session ids", async () => {
    const order: string[] = []
    const a = withCliSessionLock("session-a", async () => {
      order.push("a-start")
      await new Promise((r) => setTimeout(r, 20))
      order.push("a-end")
    })
    await new Promise((r) => setTimeout(r, 5))
    const b = withCliSessionLock("session-b", async () => {
      order.push("b-start")
      order.push("b-end")
    })
    await Promise.all([a, b])
    // b finishes before a — they ran concurrently.
    expect(order).toEqual(["a-start", "b-start", "b-end", "a-end"])
  })

  it("propagates op return values", async () => {
    const result = await withCliSessionLock("x", async () => 42)
    expect(result).toBe(42)
  })

  it("a rejection in one op does not stuck subsequent ops on the same id", async () => {
    await expect(
      withCliSessionLock("y", async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    // The next op runs cleanly — the queue tail tolerated the rejection.
    const result = await withCliSessionLock("y", async () => "recovered")
    expect(result).toBe("recovered")
  })
})

describe("lock key derivation", () => {
  it("normalizes the spellings that would otherwise split one file into two keys", () => {
    const expected = "src/App.vue"
    expect(normalizeLockPath(ROOT, "src/App.vue")).toBe(expected)
    expect(normalizeLockPath(ROOT, "./src/App.vue")).toBe(expected)
    expect(normalizeLockPath(ROOT, "src/./App.vue")).toBe(expected)
    expect(normalizeLockPath(ROOT, "src/components/../App.vue")).toBe(expected)
    expect(normalizeLockPath(ROOT, "src\\App.vue")).toBe(expected)
    // An absolute path INSIDE the root collapses onto the relative spelling
    // the shell sends.
    expect(normalizeLockPath(ROOT, `${ROOT}/src/App.vue`)).toBe(expected)
  })

  it("collapses a `..`-re-entering spelling onto the plain one (codex P2, batch 4)", () => {
    // `applyEdit` resolves `file` against the repo root, so a crafted
    // `../<rootBasename>/src/App.vue` opens the SAME bytes as `src/App.vue`.
    // Before the fix this kept its literal form and took a different lock
    // key — two concurrent edits to one file both read stale contents and
    // only serialized at the final FileLockManager write (lost update).
    // Built from ROOT's own basename so it stays portable.
    const base = ROOT.slice(ROOT.lastIndexOf("/") + 1)
    expect(normalizeLockPath(ROOT, `../${base}/src/App.vue`)).toBe("src/App.vue")
    expect(normalizeLockPath(ROOT, `./../${base}/src/App.vue`)).toBe("src/App.vue")
    expect(normalizeLockPath(ROOT, `src/../../${base}/src/App.vue`)).toBe("src/App.vue")
    expect(fileEditLockKey(ROOT, `../${base}/src/App.vue`)).toBe(
      fileEditLockKey(ROOT, "src/App.vue"),
    )
  })

  describe("win32 drive-letter roots (codex round 3 P2)", () => {
    // These run on any host: the normalization is pure string logic for an
    // absolute root, so a `C:/…` root is exercised from macOS/Linux. Inputs
    // are written literally — no `path.resolve`, which would be host-
    // dependent.
    const WIN_ROOT = "C:/repo"

    it("collapses drive-letter absolutes onto the relative spelling", () => {
      // `path.posix.isAbsolute('C:/repo/src/App.vue')` is FALSE, so before the
      // fix this got joined UNDER the root ("C:/repo/C:/repo/src/App.vue") and
      // keyed differently from `src/App.vue` — absolute and relative spellings
      // of one file didn't serialize on Windows.
      expect(normalizeLockPath(WIN_ROOT, "src/App.vue")).toBe("src/App.vue")
      expect(normalizeLockPath(WIN_ROOT, "C:/repo/src/App.vue")).toBe("src/App.vue")
      expect(normalizeLockPath(WIN_ROOT, "C:\\repo\\src\\App.vue")).toBe("src/App.vue")
      expect(normalizeLockPath(WIN_ROOT, ".\\src\\App.vue")).toBe("src/App.vue")
      expect(normalizeLockPath(WIN_ROOT, "..\\repo\\src\\App.vue")).toBe("src/App.vue")
      for (const spelling of [
        "C:/repo/src/App.vue",
        "C:\\repo\\src\\App.vue",
        ".\\src\\App.vue",
        "..\\repo\\src\\App.vue",
      ]) {
        expect(fileEditLockKey(WIN_ROOT, spelling)).toBe(
          fileEditLockKey(WIN_ROOT, "src/App.vue"),
        )
      }
    })

    it("folds drive-letter CASE on both the root and the candidate", () => {
      // Documented policy: the drive letter is case-folded (Windows drive
      // letters are case-insensitive); the rest of the path is left alone.
      expect(normalizeLockPath(WIN_ROOT, "c:/repo/src/App.vue")).toBe("src/App.vue")
      expect(fileEditLockKey("c:\\repo", "C:/repo/src/App.vue")).toBe(
        fileEditLockKey(WIN_ROOT, "src/App.vue"),
      )
    })

    it("keeps an off-drive / out-of-root win32 path absolute and distinct", () => {
      expect(normalizeLockPath(WIN_ROOT, "D:\\other\\App.vue")).toBe("D:/other/App.vue")
      expect(normalizeLockPath(WIN_ROOT, "C:\\elsewhere\\App.vue")).toBe(
        "C:/elsewhere/App.vue",
      )
      expect(fileEditLockKey(WIN_ROOT, "D:\\other\\App.vue")).not.toBe(
        fileEditLockKey(WIN_ROOT, "src/App.vue"),
      )
    })

    it("treats a UNC path as absolute (documented: leading // folds on both sides)", () => {
      const UNC_ROOT = "\\\\server\\share\\repo"
      expect(normalizeLockPath(UNC_ROOT, "src/App.vue")).toBe("src/App.vue")
      expect(normalizeLockPath(UNC_ROOT, "\\\\server\\share\\repo\\src\\App.vue")).toBe(
        "src/App.vue",
      )
      expect(fileEditLockKey(UNC_ROOT, "\\\\server\\share\\repo\\src\\App.vue")).toBe(
        fileEditLockKey(UNC_ROOT, "src/App.vue"),
      )
    })
  })

  it("leaves an escaping path absolute (applyEdit refuses it downstream)", () => {
    expect(normalizeLockPath(ROOT, "/etc/passwd")).toBe("/etc/passwd")
    // A relative escape resolves against the root and stays absolute —
    // coarseness outside the root is moot, applyEdit refuses it.
    expect(normalizeLockPath("/tmp/repo", "../outside/App.vue")).toBe(
      "/tmp/outside/App.vue",
    )
    expect(fileEditLockKey(ROOT, "../outside/App.vue")).not.toBe(
      fileEditLockKey(ROOT, "src/App.vue"),
    )
  })

  it("keeps a `..`-PREFIXED FILENAME as a normal repo-relative key, not an escape (Task 14 review round-2 P2 audit)", () => {
    // A file literally named `..fixture.vue` (or nested under a
    // `..cache`-named directory) is a legal child of the root — the
    // relative path `..fixture.vue` doesn't start with the `../`
    // SEPARATOR-qualified prefix an actual escape would. Pinned here so a
    // future "simplify the check" pass can't reintroduce the blunt
    // `rel.startsWith('..')` bug this audit found (and fixed) in the
    // sibling helper `toRel` (src/editor/agent-chat-sdk/edit-ack.ts).
    expect(normalizeLockPath(ROOT, "..fixture.vue")).toBe("..fixture.vue")
    expect(normalizeLockPath(ROOT, "src/..cache/App.vue")).toBe("src/..cache/App.vue")
    expect(fileEditLockKey(ROOT, "..fixture.vue")).not.toBe(
      fileEditLockKey(ROOT, "/etc/passwd"),
    )
  })

  it("treats the bare `..` (root's own parent, no trailing segment) as escaping (Task 14 review round-2 P2 fix)", () => {
    // Before the fix: `rel === ".."` has no trailing `/`, so the old
    // `!rel.startsWith("../")` check alone let it through as if it were a
    // legitimate repo-relative key — the one boundary case the original
    // check missed (distinct from the `..fixture.vue` filename case above,
    // which was never broken).
    // ROOT is "/tmp/repo" — its parent is "/tmp".
    expect(normalizeLockPath(ROOT, "..")).toBe("/tmp")
    expect(normalizeLockPath(ROOT, "..")).not.toBe("..")
  })

  it("keys the same file identically for the edit lane and the discard lane", () => {
    // The P2 discard-vs-edit race fix depends on both routes deriving one key.
    expect(fileEditLockKey(ROOT, "./src/App.vue")).toBe(
      fileEditLockKey(ROOT, "src/App.vue"),
    )
    expect(fileEditLockKey(ROOT, "src/App.vue")).not.toBe(
      fileEditLockKey(ROOT, "src/Other.vue"),
    )
  })
})

describe("withFileEditLocks", () => {
  it("lets edits to DIFFERENT files proceed without waiting on each other", async () => {
    const log: string[] = []
    const slow = deferred()

    // A long op on file A (the LLM-lane shape: a 90s mini-turn).
    const a = withFileEditLocks(ROOT, ["src/A.vue"], async () => {
      log.push("a-start")
      await slow.promise
      log.push("a-end")
    })
    await settle()

    // B must be able to run to completion while A is still parked.
    const b = withFileEditLocks(ROOT, ["src/B.vue"], async () => {
      log.push("b-start")
      log.push("b-end")
    })
    await b
    expect(log).toEqual(["a-start", "b-start", "b-end"])

    slow.resolve()
    await a
    expect(log).toEqual(["a-start", "b-start", "b-end", "a-end"])
  })

  it("serializes edits to the SAME file", async () => {
    const log: string[] = []
    const first = deferred()

    const a = withFileEditLocks(ROOT, ["src/A.vue"], async () => {
      log.push("a-start")
      await first.promise
      log.push("a-end")
    })
    await settle()
    const b = withFileEditLocks(ROOT, ["src/A.vue"], async () => {
      log.push("b-start")
      log.push("b-end")
    })
    await settle()
    // B has NOT started — it's queued behind A's per-file mutex.
    expect(log).toEqual(["a-start"])

    first.resolve()
    await Promise.all([a, b])
    expect(log).toEqual(["a-start", "a-end", "b-start", "b-end"])
  })

  it("serializes two edits to the same file via a `..`-re-entering spelling", async () => {
    // The concurrency half of the codex P2 fix: the crafted spelling must not
    // just normalize equal, it must actually queue behind the plain one.
    const base = ROOT.slice(ROOT.lastIndexOf("/") + 1)
    const log: string[] = []
    const first = deferred()

    const a = withFileEditLocks(ROOT, ["src/App.vue"], async () => {
      log.push("a-start")
      await first.promise
      log.push("a-end")
    })
    await settle()
    const b = withFileEditLocks(ROOT, [`../${base}/src/App.vue`], async () => {
      log.push("b-start")
      log.push("b-end")
    })
    await settle()
    expect(log).toEqual(["a-start"])

    first.resolve()
    await Promise.all([a, b])
    expect(log).toEqual(["a-start", "a-end", "b-start", "b-end"])
  })

  it("serializes a discard against an edit on the same file (differently spelled)", async () => {
    // The discard route passes the Activity row's path verbatim; the edit
    // route passes `edit.file`. Both go through the same normalization.
    const log: string[] = []
    const editHeld = deferred()

    const edit = withFileEditLocks(ROOT, ["src/App.vue"], async () => {
      log.push("edit-start")
      await editHeld.promise
      log.push("edit-end")
    })
    await settle()
    const discard = withFileEditLocks(ROOT, ["./src/App.vue"], async () => {
      log.push("discard-start")
      log.push("discard-end")
    })
    await settle()
    expect(log).toEqual(["edit-start"])

    editHeld.resolve()
    await Promise.all([edit, discard])
    expect(log).toEqual([
      "edit-start",
      "edit-end",
      "discard-start",
      "discard-end",
    ])
  })

  it("releases every lock when the op throws", async () => {
    await expect(
      withFileEditLocks(ROOT, ["src/A.vue", "src/B.vue"], async () => {
        throw new Error("applicator exploded")
      }),
    ).rejects.toThrow("applicator exploded")

    // A follow-up op on the same files runs immediately, and no lock state
    // leaked behind it.
    await withFileEditLocks(ROOT, ["src/A.vue", "src/B.vue"], async () => {})
    await withTreeLock(ROOT, async () => {})
    const { queueKeys, gateKeys } = _inspectCliLocksForTests()
    expect(queueKeys).toEqual([])
    expect(gateKeys).toEqual([])
  })

  it("cannot deadlock when two batches acquire overlapping file sets in opposite order", async () => {
    // The llm-patch shape: batch 1 wants {A,B}, batch 2 wants {B,A}. Sorted
    // acquisition inside the helper makes the naive hold-and-wait cycle
    // impossible. Both must complete.
    const log: string[] = []
    const gate1 = deferred()
    const gate2 = deferred()

    const batch1 = withFileEditLocks(ROOT, ["src/A.vue", "src/B.vue"], async () => {
      log.push("batch1-start")
      await gate1.promise
      log.push("batch1-end")
    })
    const batch2 = withFileEditLocks(ROOT, ["src/B.vue", "src/A.vue"], async () => {
      log.push("batch2-start")
      await gate2.promise
      log.push("batch2-end")
    })
    await settle()
    // Exactly one is inside; the other is queued (they overlap on both files).
    expect(log.length).toBe(1)

    gate1.resolve()
    gate2.resolve()
    await Promise.all([batch1, batch2])
    expect(log.length).toBe(4)
    expect(new Set(log)).toEqual(
      new Set(["batch1-start", "batch1-end", "batch2-start", "batch2-end"]),
    )
    // Whichever ran first, it finished before the other started.
    expect(log[1]).toBe(`${log[0].split("-")[0]}-end`)
  })

  it("de-dupes a repeated path instead of self-deadlocking", async () => {
    // Load-bearing: `move` sends `destFile === file` on EVERY
    // request, so the derived target list legitimately contains the same path
    // twice. Without the Set dedupe the second acquisition of the same
    // promise-chain key would wait on the first — which is this same op —
    // i.e. a hang with no timeout.
    const log: string[] = []
    await withFileEditLocks(ROOT, ["src/A.vue", "src/A.vue"], async () => {
      log.push("ran")
    })
    expect(log).toEqual(["ran"])
    // And the lock is genuinely released afterwards.
    await withFileEditLocks(ROOT, ["src/A.vue"], async () => {
      log.push("ran-again")
    })
    expect(log).toEqual(["ran", "ran-again"])
  })

  it("de-dupes DIFFERENT SPELLINGS of the same path (normalization feeds the dedupe)", async () => {
    const log: string[] = []
    await withFileEditLocks(
      ROOT,
      [
        "src/A.vue",
        "./src/A.vue",
        `${ROOT}/src/A.vue`,
        "src/x/../A.vue",
        `../${ROOT.slice(ROOT.lastIndexOf("/") + 1)}/src/A.vue`,
      ],
      async () => {
        log.push("ran")
      },
    )
    expect(log).toEqual(["ran"])
    expect(_inspectCliLocksForTests().queueKeys).toEqual([])
  })

  it("scopes keys per repo — same relative path in two repos is independent", async () => {
    const log: string[] = []
    const held = deferred()
    const a = withFileEditLocks("/tmp/repo-a", ["src/App.vue"], async () => {
      log.push("a-start")
      await held.promise
      log.push("a-end")
    })
    await settle()
    await withFileEditLocks("/tmp/repo-b", ["src/App.vue"], async () => {
      log.push("b-ran")
    })
    expect(log).toEqual(["a-start", "b-ran"])
    held.resolve()
    await a
  })
})

describe("withTreeLock", () => {
  it("waits for in-flight file edits and blocks new ones until it finishes", async () => {
    const log: string[] = []
    const editHeld = deferred()
    const commitHeld = deferred()

    const edit = withFileEditLocks(ROOT, ["src/A.vue"], async () => {
      log.push("edit-start")
      await editHeld.promise
      log.push("edit-end")
    })
    await settle()

    const commit = withTreeLock(ROOT, async () => {
      log.push("commit-start")
      await commitHeld.promise
      log.push("commit-end")
    })
    await settle()
    // The commit is parked behind the in-flight edit.
    expect(log).toEqual(["edit-start"])

    // A NEW edit on an unrelated file must also park — otherwise it could
    // land between `git add -A` and `git commit`.
    const laterEdit = withFileEditLocks(ROOT, ["src/B.vue"], async () => {
      log.push("later-edit")
    })
    await settle()
    expect(log).toEqual(["edit-start"])

    editHeld.resolve()
    await settle()
    // Commit got the gate the moment the last edit released it; the later
    // edit is still waiting.
    expect(log).toEqual(["edit-start", "edit-end", "commit-start"])

    commitHeld.resolve()
    await Promise.all([edit, commit, laterEdit])
    expect(log).toEqual([
      "edit-start",
      "edit-end",
      "commit-start",
      "commit-end",
      "later-edit",
    ])
  })

  it("a pending tree op is not starved by a stream of new edits", async () => {
    const log: string[] = []
    const firstEdit = deferred()

    const edit1 = withFileEditLocks(ROOT, ["src/A.vue"], async () => {
      log.push("edit1-start")
      await firstEdit.promise
      log.push("edit1-end")
    })
    await settle()

    const commit = withTreeLock(ROOT, async () => {
      log.push("commit")
    })
    await settle()

    // Five more edits arrive while the commit waits. Every one of them must
    // queue BEHIND the pending exclusive, or the commit never runs.
    const stream = [1, 2, 3, 4, 5].map((n) =>
      withFileEditLocks(ROOT, [`src/File${n}.vue`], async () => {
        log.push(`edit-stream-${n}`)
      }),
    )
    await settle()
    expect(log).toEqual(["edit1-start"])

    firstEdit.resolve()
    await Promise.all([edit1, commit, ...stream])
    expect(log[0]).toBe("edit1-start")
    expect(log[1]).toBe("edit1-end")
    expect(log[2]).toBe("commit")
    expect(log.slice(3).sort()).toEqual([
      "edit-stream-1",
      "edit-stream-2",
      "edit-stream-3",
      "edit-stream-4",
      "edit-stream-5",
    ])
  })

  it("serializes tree ops against each other", async () => {
    const log: string[] = []
    const held = deferred()
    const publish = withTreeLock(ROOT, async () => {
      log.push("publish-start")
      await held.promise
      log.push("publish-end")
    })
    await settle()
    const commit = withTreeLock(ROOT, async () => {
      log.push("commit-start")
      log.push("commit-end")
    })
    await settle()
    expect(log).toEqual(["publish-start"])
    held.resolve()
    await Promise.all([publish, commit])
    expect(log).toEqual([
      "publish-start",
      "publish-end",
      "commit-start",
      "commit-end",
    ])
  })

  it("releases the gate when the tree op throws", async () => {
    await expect(
      withTreeLock(ROOT, async () => {
        throw new Error("git exploded")
      }),
    ).rejects.toThrow("git exploded")
    // A file edit right after runs immediately.
    const log: string[] = []
    await withFileEditLocks(ROOT, ["src/A.vue"], async () => {
      log.push("ran")
    })
    expect(log).toEqual(["ran"])
    expect(_inspectCliLocksForTests().gateKeys).toEqual([])
  })

  it("scopes the gate per repo", async () => {
    const log: string[] = []
    const held = deferred()
    const commitA = withTreeLock("/tmp/repo-a", async () => {
      log.push("commit-a-start")
      await held.promise
      log.push("commit-a-end")
    })
    await settle()
    await withFileEditLocks("/tmp/repo-b", ["src/App.vue"], async () => {
      log.push("edit-b")
    })
    expect(log).toEqual(["commit-a-start", "edit-b"])
    held.resolve()
    await commitA
  })
})

describe("withGitIndexLock", () => {
  it("serializes index-mutating ops on different files (.git/index.lock is repo-global)", async () => {
    const log: string[] = []
    const held = deferred()

    const discardA = withFileEditLocks(ROOT, ["src/A.vue"], () =>
      withGitIndexLock(ROOT, async () => {
        log.push("discard-a-start")
        await held.promise
        log.push("discard-a-end")
      }),
    )
    await settle()
    const discardB = withFileEditLocks(ROOT, ["src/B.vue"], () =>
      withGitIndexLock(ROOT, async () => {
        log.push("discard-b-start")
        log.push("discard-b-end")
      }),
    )
    await settle()
    // B's file key is free, but the index lock isn't.
    expect(log).toEqual(["discard-a-start"])

    held.resolve()
    await Promise.all([discardA, discardB])
    expect(log).toEqual([
      "discard-a-start",
      "discard-a-end",
      "discard-b-start",
      "discard-b-end",
    ])
  })

  it("does not block a plain file edit on an unrelated file", async () => {
    const log: string[] = []
    const held = deferred()
    const discard = withFileEditLocks(ROOT, ["src/A.vue"], () =>
      withGitIndexLock(ROOT, async () => {
        log.push("discard-start")
        await held.promise
        log.push("discard-end")
      }),
    )
    await settle()
    await withFileEditLocks(ROOT, ["src/B.vue"], async () => {
      log.push("edit-b")
    })
    expect(log).toEqual(["discard-start", "edit-b"])
    held.resolve()
    await discard
  })
})
