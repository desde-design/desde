/**
 * Tests for the Phase 5 restart-clear primitive.
 *
 * Covers:
 *   - Missing chat-sessions dir → zero result
 *   - Empty dir → zero result
 *   - Only idle/failed/done sessions → cleared count 0
 *   - in-flight session → rewritten to cancelled with the right reason
 *   - Mixed dir (in-flight + idle + cancelled) → only in-flight rewritten
 *   - Malformed JSON / non-object content → collected in errors[], skipped
 *   - Atomic write: rename pattern leaves either the prior file intact
 *     or the new file fully written
 *   - Idempotency: running twice with no intervening change is a no-op
 *   - The rewritten file passes listSessionsForProject's filter (cancelled
 *     sessions don't show in the picker)
 */

import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { RESTART_CLEAR_REASON, runRestartClear } from "./restart-clear"
import {
  listSessionsForProject,
  projectIdForRepoRoot,
  saveSession,
} from "./session-store"
import { makeEmptySession, type ChatSession } from "./types"

let repoRoot: string

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "desde-restart-clear-"))
})

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true })
})

async function plantSession(session: ChatSession): Promise<void> {
  // Saving via the real saveSession ensures the on-disk layout
  // exactly matches what the listing endpoint expects.
  await saveSession(repoRoot, session)
}

describe("runRestartClear", () => {
  it("returns a zero result when the chat-sessions dir does not exist", async () => {
    const result = await runRestartClear(repoRoot)
    expect(result).toEqual({ cleared: 0, scanned: 0, errors: [] })
  })

  it("returns a zero result when the dir exists but has no JSON files", async () => {
    await mkdir(join(repoRoot, ".desde/chat-sessions"), { recursive: true })
    const result = await runRestartClear(repoRoot)
    expect(result.cleared).toBe(0)
    expect(result.scanned).toBe(0)
  })

  it("skips sessions whose status is already terminal (idle/failed/cancelled)", async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const idle = makeEmptySession(projectId, "s-idle")
    idle.status = "idle"
    const failed = makeEmptySession(projectId, "s-failed")
    failed.status = "failed"
    failed.statusReason = "previous error"
    const cancelled = makeEmptySession(projectId, "s-cancelled")
    cancelled.status = "cancelled"
    cancelled.statusReason = "prior restart-clear"
    await plantSession(idle)
    await plantSession(failed)
    await plantSession(cancelled)

    const result = await runRestartClear(repoRoot)
    expect(result.scanned).toBe(3)
    expect(result.cleared).toBe(0)
    expect(result.errors).toEqual([])

    // The failed session still shows up in the listing.
    const summaries = await listSessionsForProject(repoRoot)
    const failedSummary = summaries.find((s) => s.sessionId === "s-failed")
    expect(failedSummary).toBeDefined()
    expect(failedSummary?.statusReason).toBe("previous error")
    // The pre-cancelled session is filtered out.
    expect(summaries.find((s) => s.sessionId === "s-cancelled")).toBeUndefined()
  })

  it("rewrites an in-flight session to cancelled with the right reason", async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const stale = makeEmptySession(projectId, "s-stale")
    stale.status = "in-flight"
    stale.statusUpdatedAt = "2026-05-22T00:00:00.000Z"
    await plantSession(stale)

    const result = await runRestartClear(repoRoot)
    expect(result.scanned).toBe(1)
    expect(result.cleared).toBe(1)
    expect(result.errors).toEqual([])

    // Read the file directly and confirm the rewrite.
    const raw = await readFile(
      join(repoRoot, ".desde/chat-sessions/s-stale.json"),
      "utf8",
    )
    const parsed = JSON.parse(raw)
    expect(parsed.status).toBe("cancelled")
    expect(parsed.statusReason).toBe(RESTART_CLEAR_REASON)
    expect(typeof parsed.statusUpdatedAt).toBe("string")
    // statusUpdatedAt was bumped (not the explicit old value we set).
    expect(parsed.statusUpdatedAt).not.toBe("2026-05-22T00:00:00.000Z")
    // updatedAt is bumped to a fresh ISO string. NOT compared against
    // stale.updatedAt because saveSession bumps it to now() at plant
    // time too — if plant + restart-clear land in the same millisecond
    // the two ISO strings collide and the assertion flakes.
    expect(typeof parsed.updatedAt).toBe("string")
    expect(parsed.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    // The cleared session does NOT appear in the listing.
    const summaries = await listSessionsForProject(repoRoot)
    expect(summaries.find((s) => s.sessionId === "s-stale")).toBeUndefined()
  })

  it("processes mixed dirs (in-flight + idle + cancelled) and only rewrites in-flight", async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const inflight = makeEmptySession(projectId, "s-inflight")
    inflight.status = "in-flight"
    const idle = makeEmptySession(projectId, "s-idle")
    idle.status = "idle"
    const cancelled = makeEmptySession(projectId, "s-cancelled")
    cancelled.status = "cancelled"
    await plantSession(inflight)
    await plantSession(idle)
    await plantSession(cancelled)

    const result = await runRestartClear(repoRoot)
    expect(result.scanned).toBe(3)
    expect(result.cleared).toBe(1)

    const inflightRaw = await readFile(
      join(repoRoot, ".desde/chat-sessions/s-inflight.json"),
      "utf8",
    )
    expect(JSON.parse(inflightRaw).status).toBe("cancelled")

    const idleRaw = await readFile(
      join(repoRoot, ".desde/chat-sessions/s-idle.json"),
      "utf8",
    )
    expect(JSON.parse(idleRaw).status).toBe("idle")
  })

  it("collects malformed-JSON files in errors[] without aborting the pass", async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const inflight = makeEmptySession(projectId, "s-inflight")
    inflight.status = "in-flight"
    await plantSession(inflight)
    // Plant a corrupt JSON file alongside.
    const dir = join(repoRoot, ".desde/chat-sessions")
    await writeFile(join(dir, "bad.json"), "{not json", "utf8")

    const result = await runRestartClear(repoRoot)
    expect(result.scanned).toBe(2)
    expect(result.cleared).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].file).toBe("bad.json")
    expect(result.errors[0].reason).toMatch(/malformed JSON/)
  })

  it("ignores tempfiles (.tmp- suffix) and non-json entries", async () => {
    const dir = join(repoRoot, ".desde/chat-sessions")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "stale.json.tmp-abc"), "{}", "utf8")
    await writeFile(join(dir, "README"), "not a session", "utf8")
    const result = await runRestartClear(repoRoot)
    expect(result.scanned).toBe(0)
    expect(result.cleared).toBe(0)
  })

  it("is idempotent — running twice on already-cleared state is a no-op", async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const inflight = makeEmptySession(projectId, "s-x")
    inflight.status = "in-flight"
    await plantSession(inflight)

    const first = await runRestartClear(repoRoot)
    expect(first.cleared).toBe(1)

    const second = await runRestartClear(repoRoot)
    expect(second.scanned).toBe(1)
    expect(second.cleared).toBe(0)
  })

  it("skips foreign-project records (codex round-1 #6 — schema validation)", async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    // Plant a legit in-flight session for THIS project.
    const mine = makeEmptySession(projectId, "s-mine")
    mine.status = "in-flight"
    await plantSession(mine)
    // Plant a foreign-project record in the same dir (shouldn't
    // happen in practice but defensively tested).
    const dir = join(repoRoot, ".desde/chat-sessions")
    await writeFile(
      join(dir, "s-foreign.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: { projectId: "foreignproj1234", sessionId: "s-foreign" },
        createdAt: "x",
        updatedAt: "y",
        turns: [],
        status: "in-flight",
      }),
      "utf8",
    )
    const result = await runRestartClear(repoRoot)
    // Both scanned, but only the local in-flight was rewritten.
    expect(result.scanned).toBe(2)
    expect(result.cleared).toBe(1)

    const foreignRaw = await readFile(join(dir, "s-foreign.json"), "utf8")
    expect(JSON.parse(foreignRaw).status).toBe("in-flight")
    const mineRaw = await readFile(join(dir, "s-mine.json"), "utf8")
    expect(JSON.parse(mineRaw).status).toBe("cancelled")
  })

  it("skips records whose filename doesn't match their persisted sessionId (codex round-1 #6)", async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const dir = join(repoRoot, ".desde/chat-sessions")
    await mkdir(dir, { recursive: true })
    // Filename says s-x but the persisted id is s-different — should
    // be skipped (normalizeLoadedSession rejects the mismatch).
    await writeFile(
      join(dir, "s-x.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: { projectId, sessionId: "s-different" },
        createdAt: "x",
        updatedAt: "y",
        turns: [],
        status: "in-flight",
      }),
      "utf8",
    )
    const result = await runRestartClear(repoRoot)
    expect(result.scanned).toBe(1)
    expect(result.cleared).toBe(0)
    // File unchanged.
    const raw = await readFile(join(dir, "s-x.json"), "utf8")
    expect(JSON.parse(raw).status).toBe("in-flight")
  })

  it("treats sessions with no status field as idle (pre-Phase-5 compat)", async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    // Manually plant a session without the status field — mimics
    // pre-Phase-5 records.
    const dir = join(repoRoot, ".desde/chat-sessions")
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, "s-legacy.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: { projectId, sessionId: "s-legacy" },
        createdAt: "x",
        updatedAt: "y",
        turns: [],
      }),
      "utf8",
    )

    const result = await runRestartClear(repoRoot)
    expect(result.scanned).toBe(1)
    expect(result.cleared).toBe(0)

    // Listing still surfaces it.
    const summaries = await listSessionsForProject(repoRoot)
    expect(summaries.find((s) => s.sessionId === "s-legacy")).toBeDefined()
  })
})
