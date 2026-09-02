/**
 * Regression coverage for audit Task 15 codex round 2 (Batch 5 gate,
 * P2): when a chat session's persisted `turns` array is ALREADY over
 * the retention cap at load time (a legacy/migrated session, or a
 * freshly-lowered `retention.chatSessionTurns.maxTurns`), the pre-turn
 * "mark in-flight" `saveSession` call archives + trims it — but before
 * the fix, `chat-handler.ts` kept using its OWN stale, untrimmed
 * in-memory `session` reference afterward (passed into
 * `runChatTurnSdk`, then into the request's FINAL `saveSession` call).
 * That final save re-derived the archive split against the untrimmed
 * array, re-appending the SAME already-archived turns to
 * `<sessionId>.archive.jsonl` — duplicate lines in an append-only
 * sidecar that's supposed to be each turn's permanent, one-time home.
 *
 * The fix: `saveSession` now returns the session it ACTUALLY persisted
 * (trimmed `turns`, updated `archivedTurnCount`/`archivedCostUsd`), and
 * `chat-handler.ts` reassigns its local `session`/`finalized` variables
 * to that return value instead of continuing to use the pre-save
 * snapshot. This test exercises the REAL `session-store.ts` (not
 * mocked) through `handleChatRequest`, with only `runChatTurnSdk`
 * stubbed to mirror the real orchestrator's session-update shape
 * (`{...opts.session, turns: [...opts.session.turns, newTurn]}` — see
 * `run-chat-turn-sdk.ts`'s `updatedSession` construction) — the stub
 * captures the `session` it was actually handed so the test can assert
 * ON THE WIRING, not just the end state.
 */

import { EventEmitter } from "node:events"
import type { IncomingMessage, ServerResponse } from "node:http"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  __resetActiveTurnsForTest,
  __resetPendingBridgeRequestsForTest,
  handleChatRequest,
  type ChatHandlerContext,
  type ChatHandlerLoaders,
} from "../chat-handler.js"
import {
  projectIdForRepoRoot,
  sessionFilePath,
} from "../../../../src/editor/agent-chat/session-store.js"
import type { ChatSession, ChatTurn } from "../../../../src/editor/agent-chat/types.js"

// The BYO-key cutover: chat dispatch now refuses without a model credential,
// because the SDK would otherwise spawn the bundled `claude` binary and run on
// whatever Claude subscription it is signed in with, which a distributed
// product may not offer. These tests exercise dispatch mechanics rather than
// auth, so they supply a key. The refusal itself is covered by
// `src/editor/llm-providers/assert-chat-credentials.test.ts` and by the
// dedicated case in `chat-handler.test.ts`.
beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-key-for-dispatch")
})
afterEach(() => {
  vi.unstubAllEnvs()
})


function makeMockReqRes(body: unknown) {
  const writes: string[] = []
  let ended = false

  const reqEmitter = new EventEmitter() as EventEmitter & {
    setEncoding: (encoding: string) => void
    [Symbol.asyncIterator]: () => AsyncIterator<string>
  }
  reqEmitter.setEncoding = () => {}
  reqEmitter[Symbol.asyncIterator] = async function* () {
    yield JSON.stringify(body)
  }
  const req = reqEmitter as unknown as IncomingMessage

  const resEmitter = new EventEmitter()
  Object.assign(resEmitter, {
    setHeader: () => resEmitter,
    write: (chunk: string) => {
      writes.push(chunk)
      return true
    },
    end: (chunk?: string) => {
      if (typeof chunk === "string") writes.push(chunk)
      ended = true
      ;(resEmitter as EventEmitter).emit("close")
      return resEmitter
    },
    off: (event: string, listener: (...args: unknown[]) => void) => {
      ;(resEmitter as EventEmitter).removeListener(event, listener)
      return resEmitter
    },
    flushHeaders: () => {},
    statusCode: 0,
  })
  const res = resEmitter as unknown as ServerResponse

  return {
    req,
    res,
    isEnded: () => ended,
  }
}

function turn(id: string, costUsd: number): ChatTurn {
  return {
    id,
    startedAt: "2026-08-01T00:00:00.000Z",
    userMessage: `msg ${id}`,
    assistantContent: [],
    toolResults: {},
    editProposals: [],
    costUsd,
  }
}

/** Read an archive.jsonl sidecar (if any) as parsed ChatTurn objects. */
async function readArchiveLines(repoRoot: string, sessionId: string): Promise<ChatTurn[]> {
  const path = join(repoRoot, ".desde", "chat-sessions", `${sessionId}.archive.jsonl`)
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return []
    throw err
  }
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as ChatTurn)
}

async function readHeadSession(repoRoot: string, sessionId: string): Promise<ChatSession> {
  const raw = await readFile(sessionFilePath(repoRoot, sessionId), "utf8")
  return JSON.parse(raw) as ChatSession
}

describe("handleChatRequest — turns-retention wiring (audit Task 15 codex round 2, P2)", () => {
  let repoRoot: string
  let sessionId: string

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "desde-chat-turns-retention-"))
    sessionId = projectIdForRepoRoot(repoRoot)
    __resetPendingBridgeRequestsForTest()
    __resetActiveTurnsForTest()
  })

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
    __resetPendingBridgeRequestsForTest()
    __resetActiveTurnsForTest()
  })

  it("archives each overflow turn exactly once, keeps archivedTurnCount/archivedCostUsd correct, and bounds the head — for an ALREADY-oversized session", async () => {
    // Seed the session file DIRECTLY (bypassing saveSession) with 8
    // turns and a $1 cost each — simulating a pre-existing session
    // that's already over a maxTurns=5 cap (e.g. a freshly-lowered
    // config value, or a legacy/migrated file).
    const seedTurns = Array.from({ length: 8 }, (_, i) => turn(`t${i + 1}`, 1))
    const projectId = sessionId
    const seeded: ChatSession = {
      schemaVersion: 1,
      id: { projectId, sessionId },
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      turns: seedTurns,
      status: "idle",
    }
    const path = sessionFilePath(repoRoot, sessionId)
    await mkdir(join(repoRoot, ".desde", "chat-sessions"), { recursive: true })
    await writeFile(path, JSON.stringify(seeded, null, 2), "utf8")

    // Capture exactly what `session` chat-handler hands to
    // runChatTurnSdk — this is the direct proof of the wiring fix
    // (reassigned to the pre-turn save's TRIMMED return value, not the
    // stale pre-save snapshot).
    let capturedSessionAtCallTime: ChatSession | undefined
    const loaders: ChatHandlerLoaders = {
      // REAL session-store.ts — no mocking. The whole point is to
      // exercise saveSession's actual archive/trim logic.
      loadSessionStore: () =>
        import("../../../../src/editor/agent-chat/session-store.js"),
      loadRunChatTurnSdk: async () => {
        return {
          runChatTurnSdk: async (callOpts: {
            session: ChatSession
            emit: (ev: { kind: string; [k: string]: unknown }) => void
          }) => {
            capturedSessionAtCallTime = callOpts.session
            const newTurn = turn("t9", 1)
            callOpts.emit({ kind: "turn_complete", turnId: newTurn.id, stopReason: "end_turn" })
            const updatedSession: ChatSession = {
              // Mirrors run-chat-turn-sdk.ts's real `updatedSession`
              // construction: spread the INPUT session, append ONE
              // new turn. Nothing here touches archivedTurnCount/
              // archivedCostUsd — they ride through unchanged, exactly
              // like the real orchestrator.
              ...callOpts.session,
              turns: [...callOpts.session.turns, newTurn],
            }
            return { session: updatedSession, turn: newTurn }
          },
        } as unknown as Awaited<ReturnType<ChatHandlerLoaders["loadRunChatTurnSdk"]>>
      },
    }

    const mock = makeMockReqRes({ userMessage: "hi" })
    const ctx: ChatHandlerContext = {
      repoRoot,
      loaders,
      retention: { chatSessionTurns: { maxTurns: 5 } },
    }
    await handleChatRequest(mock.req, mock.res, ctx)
    expect(mock.isEnded()).toBe(true)

    // --- The wiring fix, proven directly ---
    // The pre-turn save trimmed 8 -> 5 turns (archived t1-t3) BEFORE
    // runChatTurnSdk ran. Without the fix this would be 8 (stale).
    expect(capturedSessionAtCallTime?.turns.map((t) => t.id)).toEqual([
      "t4",
      "t5",
      "t6",
      "t7",
      "t8",
    ])
    expect(capturedSessionAtCallTime?.archivedTurnCount).toBe(3)
    expect(capturedSessionAtCallTime?.archivedCostUsd).toBe(3)

    // --- End-to-end on-disk state, proven via the real files ---
    // Exactly ONE line per archived turn — t1..t4 (t4 rolls off in the
    // FINAL save once t9 pushes the window past maxTurns=5 again).
    // Without the fix: t1-t3 would appear TWICE (once from the
    // pre-turn save, once from the final save re-deriving against the
    // stale untrimmed array) plus t4 once — 7 lines instead of 4.
    const archived = await readArchiveLines(repoRoot, sessionId)
    expect(archived.map((t) => t.id)).toEqual(["t1", "t2", "t3", "t4"])
    expect(new Set(archived.map((t) => t.id)).size).toBe(archived.length) // no dupes

    const head = await readHeadSession(repoRoot, sessionId)
    expect(head.turns.map((t) => t.id)).toEqual(["t5", "t6", "t7", "t8", "t9"])
    expect(head.turns.length).toBeLessThanOrEqual(5) // bounded
    expect(head.archivedTurnCount).toBe(4) // 3 (pre-turn) + 1 (final) — NOT 7
    expect(head.archivedCostUsd).toBe(4) // $1 x 4 archived turns — NOT $7
  })
})
