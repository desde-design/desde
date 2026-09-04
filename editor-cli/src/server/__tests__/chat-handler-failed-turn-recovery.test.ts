/**
 * When the chat handler itself throws, the user's prompt must still land
 * in the transcript.
 *
 * Every other failure — including the cost-ceiling refusal — comes back
 * through `runChatTurnSdk`, which appends the turn before returning. The
 * handler's outer catch was the one path that reached `failed` without a
 * turn: it re-reads the session from disk, which at that moment is the
 * pre-turn `in-flight` save. The submission simply disappeared, and every
 * surface that names "the last turn" named the PREVIOUS one — which is
 * how a cost-ceiling toast came to quote a prompt from earlier in the
 * session.
 */

import { EventEmitter } from "node:events"
import type { IncomingMessage, ServerResponse } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  __resetActiveTurnsForTest,
  __resetPendingBridgeRequestsForTest,
  handleChatRequest,
  type ChatHandlerLoaders,
} from "../chat-handler.js"
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
  const req = Object.assign(new EventEmitter(), {
    setEncoding: () => {},
    [Symbol.asyncIterator]: async function* () {
      yield JSON.stringify(body)
    },
  }) as unknown as IncomingMessage

  const resEmitter = new EventEmitter()
  Object.assign(resEmitter, {
    setHeader: () => resEmitter,
    write: () => true,
    end: () => {
      resEmitter.emit("close")
      return resEmitter
    },
    off: (event: string, listener: (...a: unknown[]) => void) => {
      resEmitter.removeListener(event, listener)
      return resEmitter
    },
    flushHeaders: () => {},
    statusCode: 0,
  })
  return { req, res: resEmitter as unknown as ServerResponse }
}

const PRIOR_TURN: ChatTurn = {
  id: "turn-1",
  startedAt: "2026-08-12T00:00:00.000Z",
  completedAt: "2026-08-12T00:00:05.000Z",
  userMessage: "Move the chevron to the right",
  assistantContent: [],
  toolResults: {},
  editProposals: [],
}

function priorSession(): ChatSession {
  return {
    schemaVersion: 1,
    id: { projectId: "test-proj", sessionId: "test-proj" },
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:05.000Z",
    turns: [PRIOR_TURN],
    status: "in-flight",
    statusUpdatedAt: "2026-08-12T00:00:05.000Z",
  }
}

/**
 * `saved` collects every session the handler persists. The last entry is
 * the terminal write — the one the listing endpoint would summarise.
 */
function makeLoaders(opts: {
  run: () => Promise<never> | Promise<unknown>
  saved: ChatSession[]
  /** What `loadSession` returns — defaults to the pre-turn session. */
  onDisk?: () => ChatSession
}): ChatHandlerLoaders {
  return {
    loadRunChatTurnSdk: async () =>
      ({ runChatTurnSdk: opts.run }) as unknown as Awaited<
        ReturnType<ChatHandlerLoaders["loadRunChatTurnSdk"]>
      >,
    loadRunChatTurnNeutral: async () => ({
      runChatTurnNeutral: async () => {
        throw new Error("makeLoaders: this suite's turns run on the SDK loader, not neutral")
      },
    }),
    loadSessionStore: async () =>
      ({
        loadSession: async () => ({
          session: (opts.onDisk ?? priorSession)(),
          fresh: false,
        }),
        saveSession: async (_root: string, session: ChatSession) => {
          opts.saved.push(session)
          return session
        },
      }) as unknown as Awaited<ReturnType<ChatHandlerLoaders["loadSessionStore"]>>,
  }
}

describe("chat handler — a turn that dies in the handler", () => {
  let repoRoot: string
  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "desde-chat-recover-"))
    __resetPendingBridgeRequestsForTest()
    __resetActiveTurnsForTest()
  })
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
    __resetPendingBridgeRequestsForTest()
    __resetActiveTurnsForTest()
  })

  it("records the submission instead of losing it", async () => {
    const saved: ChatSession[] = []
    const { req, res } = makeMockReqRes({ userMessage: "hello" })
    await handleChatRequest(req, res, {
      repoRoot,
      loaders: makeLoaders({
        run: async () => {
          throw new Error("grounding digest exploded")
        },
        saved,
      }),
    })

    const terminal = saved[saved.length - 1]
    expect(terminal.status).toBe("failed")
    // The whole point: the last turn is the one that just failed, not the
    // one before it.
    const last = terminal.turns[terminal.turns.length - 1]
    expect(last.userMessage).toBe("hello")
    expect(last.error).toContain("grounding digest exploded")
    expect(terminal.turns).toHaveLength(2)
    // The prior turn is untouched.
    expect(terminal.turns[0]).toEqual(PRIOR_TURN)
  })

  it("does not double-record a turn the runner already appended", async () => {
    // The runner returned normally (turn appended), then the terminal
    // save threw — which the handler deliberately rethrows so this
    // recovery arm runs. If that save had partially landed, appending
    // again would duplicate the turn.
    const saved: ChatSession[] = []
    const runnerTurn: ChatTurn = {
      id: "turn-2",
      startedAt: "2026-08-12T00:01:00.000Z",
      userMessage: "hello",
      assistantContent: [],
      toolResults: {},
      editProposals: [],
      error: "Session cost ceiling reached ($1.02 of $1).",
    }
    const withRunnerTurn = (): ChatSession => ({
      ...priorSession(),
      turns: [PRIOR_TURN, runnerTurn],
    })
    let firstSave = true
    const loaders = {
      loadRunChatTurnSdk: async () =>
        ({
          runChatTurnSdk: async () => ({
            session: withRunnerTurn(),
            turn: runnerTurn,
          }),
        }) as unknown as Awaited<ReturnType<ChatHandlerLoaders["loadRunChatTurnSdk"]>>,
      loadSessionStore: async () =>
        ({
          // Disk already has the runner's turn — the save landed before
          // whatever threw.
          loadSession: async () => ({ session: withRunnerTurn(), fresh: false }),
          saveSession: async (_root: string, session: ChatSession) => {
            // Let the pre-turn in-flight marker through, then blow up on
            // the terminal write.
            if (!firstSave && session.status !== "in-flight") {
              firstSave = true
              throw new Error("disk full")
            }
            firstSave = false
            saved.push(session)
            return session
          },
        }) as unknown as Awaited<ReturnType<ChatHandlerLoaders["loadSessionStore"]>>,
    } as ChatHandlerLoaders

    const { req, res } = makeMockReqRes({ userMessage: "hello" })
    await handleChatRequest(req, res, { repoRoot, loaders })

    const terminal = saved[saved.length - 1]
    expect(terminal.turns.filter((t) => t.id === "turn-2")).toHaveLength(1)
    expect(terminal.turns).toHaveLength(2)
  })
})
