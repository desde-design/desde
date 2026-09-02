/**
 * Phase 2 of tasks/editor-detached-sessions.md: the edit-handler write
 * paths are wrapped with `getSharedFileLockManager().withWriteLock`. These
 * tests instrument the shared lock manager (via the
 * `__setSharedFileLockManagerForTests` test-only injection point) and
 * assert the wiring is actually engaged on real writes — i.e. concurrent
 * applyEdit calls observably acquire + release the lock per file, in
 * sorted order, with no leaked state afterwards.
 *
 * The lock primitive's own concurrency properties are exhaustively
 * covered by `src/editor/edit-service/file-lock-manager.test.ts`. Here
 * we only assert the integration.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { applyEdit, type ApplicatorLoaders, type EditRequestBody } from "../edit-handler.js"
import {
  createFileLockManager,
  __resetSharedFileLockManagerForTests,
  __setSharedFileLockManagerForTests,
  type LockEvent,
} from "../../../../src/editor/edit-service/file-lock-manager"

const REAL_APPLICATORS: ApplicatorLoaders = {
  loadApplyPropEdit: () => import("../../../../src/editor/edit-service/apply-prop-edit"),
  loadApplyMoveEdit: () => import("../../../../src/editor/edit-service/apply-move-edit"),
  loadApplyDetachEdit: () => import("../../../../src/editor/edit-service/apply-detach-edit"),
  loadApplySlotTextEdit: () =>
    import("../../../../src/editor/edit-service/apply-slot-text-edit"),
  loadInferAttrFromTextEdit: () =>
    import("../../../../src/editor/edit-service/infer-attr-from-text-edit"),
  loadApplyLLMPatch: async () =>
    ({
      applyLLMPatch: (async () => ({
        ok: true,
        patchedFiles: new Map(),
        perMutationOutcomes: [],
      })) as unknown as typeof import("../../../../src/editor/edit-service/apply-llm-patch").applyLLMPatch,
      parseSourceLocFile: () => null,
      isCrossFileInstanceEdit: () => false,
      patchFileFor: () => ({ ok: false, reason: "stub" }),
    }) as typeof import("../../../../src/editor/edit-service/apply-llm-patch"),
  loadStyleGrounding: async () => ({
    loadStyleGrounding: () => ({ tokens: [], classTaxonomy: [], preprocessor: "css" as const }),
  }),
}

function propEditBody(file: string, propName: string, value: string): EditRequestBody {
  return {
    edit: {
      kind: "prop",
      file,
      // The fixture below sets the target tag on line 2, column 3.
      line: 2,
      column: 3,
      propName,
      value,
    },
  }
}

const SFC_FIXTURE = (initialTitle: string) =>
  [
    "<template>",
    `  <KEmptyState title="${initialTitle}" />`,
    "</template>",
    "",
  ].join("\n")

describe("edit-handler Phase 2 lock integration", () => {
  let dir: string
  let events: LockEvent[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "edit-handler-lock-"))
    events = []
    __setSharedFileLockManagerForTests(
      createFileLockManager({ onEvent: (e) => events.push(e) }),
    )
  })

  afterEach(() => {
    __resetSharedFileLockManagerForTests()
    rmSync(dir, { recursive: true, force: true })
  })

  it("emits acquire/release events for a single-file prop edit", async () => {
    writeFileSync(join(dir, "App.vue"), SFC_FIXTURE("Hello"))
    const result = await applyEdit(
      propEditBody("App.vue", "title", "Updated"),
      dir,
      REAL_APPLICATORS,
    )
    expect(result.ok).toBe(true)
    expect(readFileSync(join(dir, "App.vue"), "utf8")).toContain('title="Updated"')

    const acquired = events.filter((e) => e.type === "acquired")
    const released = events.filter((e) => e.type === "released")
    expect(acquired).toHaveLength(1)
    expect(released).toHaveLength(1)
    // Snapshot/restore is the withWriteLock contract — confirm it ran.
    expect(events.some((e) => e.type === "snapshot-captured")).toBe(true)
    expect(events.some((e) => e.type === "snapshot-discarded")).toBe(true)
  })

  it("serializes two concurrent edits to the same file (one acquires, one queues)", async () => {
    writeFileSync(join(dir, "App.vue"), SFC_FIXTURE("Hello"))

    const [r1, r2] = await Promise.all([
      applyEdit(propEditBody("App.vue", "title", "FromA"), dir, REAL_APPLICATORS),
      applyEdit(propEditBody("App.vue", "title", "FromB"), dir, REAL_APPLICATORS),
    ])
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)

    const final = readFileSync(join(dir, "App.vue"), "utf8")
    // Last writer wins. The lock guarantees both writes complete in
    // serial order, so the file is in one of the two valid post-write
    // states (not a corrupted interleave). This is the intended
    // detached-sessions UX: auto-apply with stale-base overwrite —
    // session A's edit lives in the chat history, session B's is what
    // landed on disk. The save dialog surfaces the overlap at commit
    // time so the user can decide what to keep. Optimistic conflict
    // detection (409 on stale base) is intentionally out of Phase 2
    // scope — see tasks/_archive/detached-sessions-phases/composer-detached-sessions-phases-1-2-verdict.md.
    expect(final.includes('title="FromA"') || final.includes('title="FromB"')).toBe(true)

    // Telemetry: both sessions reached `acquired`. At least one had to
    // queue behind the other (queueLength >= 1).
    const acquired = events.filter((e) => e.type === "acquired")
    expect(acquired.length).toBe(2)
    const queued = events.filter(
      (e) => e.type === "acquire-attempt" && e.queueLength >= 1,
    )
    expect(queued.length).toBeGreaterThanOrEqual(1)
  })

  it("two concurrent allowCreate calls for the same new file: one succeeds with 200, one rejected with 409", async () => {
    // Codex Phase 2 finding: `resolveSafeCreatePath` checks non-existence
    // before the lock — without the `flag: 'wx'` fix, two concurrent
    // creates for the same path could both pass and the second clobbers
    // the first. Verify the fix surfaces a 409 on the loser.
    const newFile = "Created.vue"
    const overwriteBody = (newSource: string): EditRequestBody => ({
      edit: {
        kind: "overwrite",
        file: newFile,
        newSource,
        allowCreate: true,
      },
    })

    const [r1, r2] = await Promise.all([
      applyEdit(overwriteBody("<template>FROM-A</template>\n"), dir, REAL_APPLICATORS),
      applyEdit(overwriteBody("<template>FROM-B</template>\n"), dir, REAL_APPLICATORS),
    ])
    // Exactly one ok; the other a 409 from the EEXIST mapping.
    const statuses = [r1.status, r2.status].sort((a, b) => a - b)
    expect(statuses).toEqual([200, 409])
    const winner = r1.ok ? r1 : r2
    expect(winner.status).toBe(200)
    // The 409 mentions allowCreate so the failure is attributable.
    const loser = r1.ok ? r2 : r1
    expect(loser.reason).toMatch(/already exists/i)
    // File on disk reflects whichever winning call ran first.
    const final = readFileSync(join(dir, newFile), "utf8")
    expect(final.includes("FROM-A") || final.includes("FROM-B")).toBe(true)
  })

  it("releases the lock after every write (no leaked state across calls)", async () => {
    writeFileSync(join(dir, "App.vue"), SFC_FIXTURE("Hello"))

    for (let i = 0; i < 3; i++) {
      const result = await applyEdit(
        propEditBody("App.vue", "title", `Round-${i}`),
        dir,
        REAL_APPLICATORS,
      )
      expect(result.ok).toBe(true)
    }
    // After all writes, the lock map should be empty — sequential
    // acquires + releases must not accumulate state.
    expect(events.filter((e) => e.type === "acquired").length).toBe(3)
    expect(events.filter((e) => e.type === "released").length).toBe(3)
  })
})
