/**
 * Chat handler integration tests. Validates:
 *   - SSE plumbing forwards orchestrator events
 *   - bridge_request → bridge-reply round-trip resolves the in-flight
 *     BridgeClient promise
 *   - 400 responses on bad input
 *   - bridge requests time out cleanly
 *   - Aborting the request rejects pending bridge requests
 */

import { EventEmitter } from "node:events"
import type { IncomingMessage, ServerResponse } from "node:http"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  __resetActiveTurnsForTest,
  __resetPendingBridgeRequestsForTest,
  handleBridgeReply,
  handleChatRequest,
  handleSteerRequest,
  type ChatHandlerContext,
  type ChatHandlerLoaders,
  type SteerResult,
} from "../chat-handler.js"
import { newSecurityContext } from "../auth.js"
import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { pickFreePort } from "../launcher-server.js"

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


interface MockReqRes {
  req: IncomingMessage
  res: ServerResponse
  writes: string[]
  ended: { value: boolean }
  events: () => Array<Record<string, unknown>>
  emitClose: () => void
  setBody: (json: unknown) => void
  /** The chunk (if any) passed to `res.end(...)` — captures non-SSE JSON error bodies. */
  endBody: () => string | undefined
}

function makeMockReqRes(): MockReqRes {
  const writes: string[] = []
  const ended = { value: false }
  let bodyChunks: string[] = []
  let endChunk: string | undefined

  // Build an async-iterable IncomingMessage that yields the body.
  const reqEmitter = new EventEmitter() as EventEmitter & {
    setEncoding: (encoding: string) => void
    [Symbol.asyncIterator]: () => AsyncIterator<string>
    socket?: EventEmitter
  }
  reqEmitter.setEncoding = () => {}
  reqEmitter[Symbol.asyncIterator] = async function* () {
    for (const c of bodyChunks) yield c
  }
  // No socket — the SSE helper will fall back to req-close detection,
  // which is fine for tests.
  const req = reqEmitter as unknown as IncomingMessage

  const resEmitter = new EventEmitter()
  Object.assign(resEmitter, {
    setHeader: () => resEmitter,
    write: (chunk: string) => {
      writes.push(chunk)
      return true
    },
    end: (chunk?: string) => {
      if (typeof chunk === "string") endChunk = chunk
      ended.value = true
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
    writes,
    ended,
    events: () => {
      // SSE frames look like "data: <json>\n\n". Parse JSON out of each
      // data line; skip comment/heartbeat lines.
      const out: Array<Record<string, unknown>> = []
      for (const w of writes) {
        const lines = w.split("\n")
        for (const line of lines) {
          if (line.startsWith("data:")) {
            const payload = line.slice("data:".length).trim()
            if (payload.length === 0) continue
            try {
              out.push(JSON.parse(payload))
            } catch {
              // Skip non-JSON lines — shouldn't happen in our tests.
            }
          }
        }
      }
      return out
    },
    emitClose: () => {
      ;(req as unknown as EventEmitter).emit("close")
    },
    setBody: (json) => {
      bodyChunks = [JSON.stringify(json)]
    },
    endBody: () => endChunk,
  }
}

function makeLoaders(opts: {
  scriptedEvents: import("../../../../src/editor/agent-chat/chat-stream-events").ChatStreamEvent[]
  /** Map of bridge messageType → result (or a function that returns one). */
  bridgeResponses?: Map<string, unknown>
}): ChatHandlerLoaders {
  return {
    loadRunChatTurnNeutral: async () => ({
      runChatTurnNeutral: async () => {
        throw new Error("makeLoaders: this suite's turns run on the SDK loader, not neutral")
      },
    }),
    loadRunChatTurnSdk: async () => {
      const { makeEmptySession } = await import(
        "../../../../src/editor/agent-chat/types.js"
      )
      return {
        runChatTurnSdk: async (callOpts: {
          emit: (
            ev: import("../../../../src/editor/agent-chat/chat-stream-events").ChatStreamEvent,
          ) => void
          bridge: import("../../../../src/editor/agent-tools/types.js").BridgeClient
          worktreeRoot: string
        }) => {
          // Emit all scripted events, then return a synthesized session
          // + turn so the handler can save.
          for (const ev of opts.scriptedEvents) {
            callOpts.emit(ev)
            // Yield to the event loop between events so the SSE writes
            // are visible to the test before we proceed.
            await new Promise<void>((r) => setImmediate(r))
          }
          // If the scripted events include a bridge_request via the
          // bridge interface, we can't do that from here — that's
          // tested in the dedicated "bridge round-trip" case below
          // where we call callOpts.bridge.send() directly.
          const session = makeEmptySession("test-proj")
          return {
            session,
            turn: {
              id: "test-turn",
              startedAt: "x",
              userMessage: "ignored",
              assistantContent: [],
              toolResults: {},
              editProposals: [],
            },
          }
        },
      } as unknown as Awaited<ReturnType<ChatHandlerLoaders["loadRunChatTurnSdk"]>>
    },
    loadSessionStore: async () => {
      return {
        loadSession: async () => {
          const { makeEmptySession } = await import(
            "../../../../src/editor/agent-chat/types.js"
          )
          return { session: makeEmptySession("test-proj"), fresh: true } as Awaited<
            ReturnType<
              Awaited<
                ReturnType<ChatHandlerLoaders["loadSessionStore"]>
              >["loadSession"]
            >
          >
        },
        saveSession: async (_root: string, session: unknown) => session,
      } as unknown as Awaited<ReturnType<ChatHandlerLoaders["loadSessionStore"]>>
    },
  }
}

describe("handleChatRequest", () => {
  let repoRoot: string
  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "desde-chat-"))
    __resetPendingBridgeRequestsForTest()
    __resetActiveTurnsForTest()
  })
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
    __resetPendingBridgeRequestsForTest()
    __resetActiveTurnsForTest()
  })

  it("400s on invalid JSON body", async () => {
    const mock = makeMockReqRes()
    mock.setBody("not-an-object")
    // Override the body to be raw garbage by replacing the async iter.
    Object.assign(mock.req, {
      [Symbol.asyncIterator]: async function* () {
        yield "{not valid json"
      },
    })
    await handleChatRequest(mock.req, mock.res, { repoRoot } as ChatHandlerContext)
    expect((mock.res as unknown as { statusCode: number }).statusCode).toBe(400)
  })

  it("400s when userMessage is missing", async () => {
    const mock = makeMockReqRes()
    mock.setBody({})
    await handleChatRequest(mock.req, mock.res, { repoRoot } as ChatHandlerContext)
    expect((mock.res as unknown as { statusCode: number }).statusCode).toBe(400)
  })

  it("refuses to dispatch a turn when no model credential is configured", async () => {
    // The server half of the BYO-key cutover. The client already stops
    // presenting chat as configured, but a stale or hand-built client must not
    // be able to start a turn that would run on whatever Claude subscription
    // the bundled `claude` binary happens to be signed in with. Anthropic's
    // Agent SDK terms are why: a distributed third-party product may not offer
    // claude.ai login.
    //
    // The surrounding suite stubs a key in `beforeEach`; this case clears it,
    // which is what makes the assertion meaningful rather than a restatement
    // of the ambient environment.
    vi.stubEnv("ANTHROPIC_API_KEY", "")
    vi.stubEnv("EDITOR_USE_CLAUDE_SUBSCRIPTION", "")
    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "hi" })
    await handleChatRequest(mock.req, mock.res, { repoRoot } as ChatHandlerContext)
    const body = mock.writes.join("")
    expect(body).toMatch(/Anthropic API key/i)
    // Names the route a desktop user can actually take: an `export` never
    // reaches an app launched from Finder.
    expect(body).toMatch(/settings gear/i)
  })

  it("dispatches normally once the subscription is explicitly opted into", async () => {
    // The control. Without it the refusal above would also pass if chat were
    // simply broken, and the opt-in path used for local dogfooding would go
    // untested.
    vi.stubEnv("ANTHROPIC_API_KEY", "")
    vi.stubEnv("EDITOR_USE_CLAUDE_SUBSCRIPTION", "1")
    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "hi" })
    await handleChatRequest(mock.req, mock.res, { repoRoot } as ChatHandlerContext)
    expect(mock.writes.join("")).not.toMatch(/Anthropic API key/i)
  })

  it("gates the turn on the provider the session picked, not on Anthropic", async () => {
    // MEASURED before this change: `assertChatCredentials(process.env)` ran at
    // the turn gate with no provider argument, even though
    // `effectiveModelConfig.provider` had already been resolved well above
    // it. The data was in scope the whole time — the gate just never looked
    // at it, so an OpenAI-configured session was checked against
    // ANTHROPIC_API_KEY instead of OPENAI_API_KEY.
    //
    // Neutral chat has to be turned on for the request validator to accept
    // an `openai` modelConfig at all — otherwise this would 400 before ever
    // reaching the credential gate under test.
    vi.stubEnv("EDITOR_NEUTRAL_CHAT", "1")
    // Anthropic is credentialed; OpenAI is not. The old provider-blind gate
    // would have let this turn proceed.
    const mock = makeMockReqRes()
    mock.setBody({
      userMessage: "hi",
      modelConfig: { provider: "openai", model: "gpt-5.6" },
    })
    await handleChatRequest(mock.req, mock.res, { repoRoot } as ChatHandlerContext)
    const error = mock.events().find((e) => e.kind === "error")
    expect(error?.reason).toMatch(/OpenAI/)
  })

  it("forwards orchestrator events to the SSE stream", async () => {
    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "hi" })
    const loaders = makeLoaders({
      scriptedEvents: [
        { kind: "turn_start", turnId: "t-1" },
        { kind: "text_delta", turnId: "t-1", delta: "Hello" },
        { kind: "turn_complete", turnId: "t-1", stopReason: "end_turn" },
      ],
    })
    await handleChatRequest(mock.req, mock.res, { repoRoot, loaders })
    const events = mock.events()
    // Phase 1 of detached chat sessions: the very first SSE event is a
    // `session` envelope identifying the resolved sessionId so the client
    // can correlate the response with the session record it minted.
    expect(events.map((e) => e.kind)).toEqual([
      "session",
      "turn_start",
      "text_delta",
      "turn_complete",
    ])
    expect(events[0].sessionId).toBeDefined()
    expect(events[0].projectId).toBeDefined()
    const textDelta = events[2]
    expect(textDelta.delta).toBe("Hello")
    expect(mock.ended.value).toBe(true)
  })

  it("loads the project-knowledge digest and passes it to runChatTurnSdk", async () => {
    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "hi" })

    const fakeKnowledge = {
      rules: "----- CLAUDE.md -----\nNo class components.",
      rulesFiles: [{ path: "CLAUDE.md", chars: 40, truncated: false }],
      docIndex: [],
      truncated: false,
    }
    let capturedKnowledge: unknown = "NOT-SET"
    const base = makeLoaders({
      scriptedEvents: [{ kind: "turn_complete", turnId: "t-1", stopReason: "end_turn" }],
    })
    const loaders: ChatHandlerLoaders = {
      ...base,
      loadRunChatTurnSdk: async () => {
        const { makeEmptySession } = await import(
          "../../../../src/editor/agent-chat/types.js"
        )
        return {
          runChatTurnSdk: async (callOpts: {
            emit: (
              ev: import("../../../../src/editor/agent-chat/chat-stream-events").ChatStreamEvent,
            ) => void
            projectKnowledge?: unknown
          }) => {
            capturedKnowledge = callOpts.projectKnowledge
            callOpts.emit({ kind: "turn_complete", turnId: "t-1", stopReason: "end_turn" })
            return {
              session: makeEmptySession("test-proj"),
              turn: {
                id: "test-turn",
                startedAt: "x",
                userMessage: "ignored",
                assistantContent: [],
                toolResults: {},
                editProposals: [],
              },
            }
          },
        } as unknown as Awaited<ReturnType<ChatHandlerLoaders["loadRunChatTurnSdk"]>>
      },
      loadProjectKnowledge: async () =>
        ({
          loadCachedProjectKnowledge: () => fakeKnowledge,
          loadProjectKnowledge: () => fakeKnowledge,
          __clearProjectKnowledgeCache: () => {},
        }) as unknown as Awaited<
          ReturnType<NonNullable<ChatHandlerLoaders["loadProjectKnowledge"]>>
        >,
    }

    await handleChatRequest(mock.req, mock.res, { repoRoot, loaders })
    expect(capturedKnowledge).toEqual(fakeKnowledge)
  })

  it("skips digest loading when conventions are turned off", async () => {
    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "hi" })

    const loadProjectKnowledge = vi.fn()
    let capturedKnowledge: unknown = "NOT-SET"
    const base = makeLoaders({
      scriptedEvents: [{ kind: "turn_complete", turnId: "t-1", stopReason: "end_turn" }],
    })
    const loaders: ChatHandlerLoaders = {
      ...base,
      loadRunChatTurnSdk: async () => {
        const { makeEmptySession } = await import(
          "../../../../src/editor/agent-chat/types.js"
        )
        return {
          runChatTurnSdk: async (callOpts: {
            emit: (
              ev: import("../../../../src/editor/agent-chat/chat-stream-events").ChatStreamEvent,
            ) => void
            projectKnowledge?: unknown
          }) => {
            capturedKnowledge = callOpts.projectKnowledge
            callOpts.emit({ kind: "turn_complete", turnId: "t-1", stopReason: "end_turn" })
            return {
              session: makeEmptySession("test-proj"),
              turn: {
                id: "test-turn",
                startedAt: "x",
                userMessage: "ignored",
                assistantContent: [],
                toolResults: {},
                editProposals: [],
              },
            }
          },
        } as unknown as Awaited<ReturnType<ChatHandlerLoaders["loadRunChatTurnSdk"]>>
      },
      loadProjectKnowledge,
    }

    await handleChatRequest(mock.req, mock.res, {
      repoRoot,
      loaders,
      conventions: { useRepoConventions: false },
    })
    // The loader is never even imported, and the orchestrator gets no digest.
    expect(loadProjectKnowledge).not.toHaveBeenCalled()
    expect(capturedKnowledge).toBeUndefined()
  })
})

describe("handleChatRequest — per-session mutex (Phase 5)", () => {
  let repoRoot: string
  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "desde-chat-mutex-"))
    __resetActiveTurnsForTest()
  })
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
    __resetActiveTurnsForTest()
  })

  it("returns 409 on a second concurrent chat request for the same session", async () => {
    // Loader whose runChatTurnSdk never resolves until the test releases it —
    // simulates a long-running turn so we can fire a second request while
    // the first is in flight.
    let releaseFirst: () => void = () => {}
    const firstFinished = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const slowLoaders: ChatHandlerLoaders = {
      loadRunChatTurnNeutral: async () => ({
        runChatTurnNeutral: async () => {
          throw new Error("this suite's turns run on the SDK loader, not neutral")
        },
      }),
      loadRunChatTurnSdk: async () =>
        ({
          runChatTurnSdk: async (
            callOpts: {
              emit: (
                ev: import("../../../../src/editor/agent-chat/chat-stream-events").ChatStreamEvent,
              ) => void
            },
          ) => {
            callOpts.emit({ kind: "turn_start", turnId: "t" })
            await firstFinished
            callOpts.emit({ kind: "turn_complete", turnId: "t", stopReason: "end_turn" })
            const { makeEmptySession } = await import(
              "../../../../src/editor/agent-chat/types.js"
            )
            return {
              session: makeEmptySession("p"),
              turn: {
                id: "t",
                startedAt: "",
                userMessage: "",
                assistantContent: [],
                toolResults: {},
                editProposals: [],
              },
            }
          },
        }) as unknown as Awaited<ReturnType<ChatHandlerLoaders["loadRunChatTurnSdk"]>>,
      loadSessionStore: async () => {
        const real = await import(
          "../../../../src/editor/agent-chat/session-store.js"
        )
        return {
          ...real,
          loadSession: async () => {
            const { makeEmptySession } = await import(
              "../../../../src/editor/agent-chat/types.js"
            )
            return { session: makeEmptySession("p"), fresh: true } as Awaited<
              ReturnType<
                Awaited<
                  ReturnType<ChatHandlerLoaders["loadSessionStore"]>
                >["loadSession"]
              >
            >
          },
          saveSession: async (_root: string, session: unknown) => session,
        } as Awaited<ReturnType<ChatHandlerLoaders["loadSessionStore"]>>
      },
    }

    const first = makeMockReqRes()
    first.setBody({ userMessage: "long-running" })
    const firstPromise = handleChatRequest(first.req, first.res, {
      repoRoot,
      loaders: slowLoaders,
    })

    // Wait for the first request to register itself in activeTurns.
    // Polling on the SSE writes (looking for turn_start) is the
    // simplest deterministic signal.
    for (let i = 0; i < 50 && first.events().length === 0; i++) {
      await new Promise<void>((r) => setImmediate(r))
    }

    const second = makeMockReqRes()
    second.setBody({ userMessage: "racing" })
    await handleChatRequest(second.req, second.res, {
      repoRoot,
      loaders: slowLoaders,
    })
    expect((second.res as unknown as { statusCode: number }).statusCode).toBe(409)

    // Release the first request so the test cleanup doesn't hang.
    releaseFirst()
    await firstPromise

    // After the first completes, a subsequent request goes through
    // (lock was released).
    const third = makeMockReqRes()
    third.setBody({ userMessage: "after release" })
    await handleChatRequest(third.req, third.res, {
      repoRoot,
      loaders: slowLoaders,
    })
    // 200-via-SSE: statusCode set by openSseStream is 200, NOT 409.
    expect((third.res as unknown as { statusCode: number }).statusCode).toBe(200)
  })

  it("400s on malformed sessionId (path-traversal defense)", async () => {
    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "hi", sessionId: "../../../etc/passwd" })
    await handleChatRequest(mock.req, mock.res, { repoRoot } as ChatHandlerContext)
    expect((mock.res as unknown as { statusCode: number }).statusCode).toBe(400)
  })

  it("allows distinct sessionIds on the same project to run in parallel (Phase 1)", async () => {
    let releaseSlow: () => void = () => {}
    const slowFinished = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })
    const slowLoaders: ChatHandlerLoaders = {
      loadRunChatTurnNeutral: async () => ({
        runChatTurnNeutral: async () => {
          throw new Error("this suite's turns run on the SDK loader, not neutral")
        },
      }),
      loadRunChatTurnSdk: async () =>
        ({
          runChatTurnSdk: async (
            callOpts: {
              emit: (
                ev: import("../../../../src/editor/agent-chat/chat-stream-events").ChatStreamEvent,
              ) => void
            },
          ) => {
            callOpts.emit({ kind: "turn_start", turnId: "t" })
            await slowFinished
            callOpts.emit({ kind: "turn_complete", turnId: "t", stopReason: "end_turn" })
            const { makeEmptySession } = await import(
              "../../../../src/editor/agent-chat/types.js"
            )
            return {
              session: makeEmptySession("p"),
              turn: {
                id: "t",
                startedAt: "",
                userMessage: "",
                assistantContent: [],
                toolResults: {},
                editProposals: [],
              },
            }
          },
        }) as unknown as Awaited<ReturnType<ChatHandlerLoaders["loadRunChatTurnSdk"]>>,
      loadSessionStore: async () =>
        ({
          loadSession: async () => {
            const { makeEmptySession } = await import(
              "../../../../src/editor/agent-chat/types.js"
            )
            return { session: makeEmptySession("p"), fresh: true } as Awaited<
              ReturnType<
                Awaited<
                  ReturnType<ChatHandlerLoaders["loadSessionStore"]>
                >["loadSession"]
              >
            >
          },
          saveSession: async (_root: string, session: unknown) => session,
        }) as unknown as Awaited<ReturnType<ChatHandlerLoaders["loadSessionStore"]>>,
    }

    // First session: detached-A. Long-running.
    const first = makeMockReqRes()
    first.setBody({ userMessage: "long-A", sessionId: "detached-A" })
    const firstPromise = handleChatRequest(first.req, first.res, {
      repoRoot,
      loaders: slowLoaders,
    })
    // Wait for the first to register itself in activeTurns.
    for (let i = 0; i < 50 && first.events().length === 0; i++) {
      await new Promise<void>((r) => setImmediate(r))
    }

    // Second session: detached-B. Same project, different sessionId. Should
    // not be blocked by the first's lock — the per-session mutex is keyed
    // by sessionId post-Phase-1.
    const second = makeMockReqRes()
    second.setBody({ userMessage: "long-B", sessionId: "detached-B" })
    const secondPromise = handleChatRequest(second.req, second.res, {
      repoRoot,
      loaders: slowLoaders,
    })
    for (let i = 0; i < 50 && second.events().length === 0; i++) {
      await new Promise<void>((r) => setImmediate(r))
    }
    expect((second.res as unknown as { statusCode: number }).statusCode).toBe(200)
    expect(second.events().some((e) => e.kind === "turn_start")).toBe(true)

    releaseSlow()
    await Promise.all([firstPromise, secondPromise])
  })

  it("emits a `session` envelope with the resolved sessionId on every turn", async () => {
    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "hi", sessionId: "explicit-session-id" })
    const loaders = makeLoaders({
      scriptedEvents: [{ kind: "turn_complete", turnId: "t-1", stopReason: "end_turn" }],
    })
    await handleChatRequest(mock.req, mock.res, { repoRoot, loaders })
    const events = mock.events()
    expect(events[0]).toMatchObject({
      kind: "session",
      sessionId: "explicit-session-id",
    })
    expect(typeof events[0].projectId).toBe("string")
  })
})

describe("handleChatRequest — Phase 5 concurrency cap", () => {
  let repoRoot: string
  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "desde-chat-cap-"))
    __resetActiveTurnsForTest()
    const { __resetSharedConcurrencyCapForTests } = await import(
      "../../../../src/editor/agent-chat/concurrency-cap.js"
    )
    __resetSharedConcurrencyCapForTests()
  })
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
    __resetActiveTurnsForTest()
    const { __resetSharedConcurrencyCapForTests } = await import(
      "../../../../src/editor/agent-chat/concurrency-cap.js"
    )
    __resetSharedConcurrencyCapForTests()
  })

  it("emits a queued SSE event when the project is at cap and drains when a slot opens", async () => {
    const { createConcurrencyCap, __setSharedConcurrencyCapForTests } =
      await import("../../../../src/editor/agent-chat/concurrency-cap.js")
    const { projectIdForRepoRoot } = await import(
      "../../../../src/editor/agent-chat/session-store.js"
    )
    const cap = createConcurrencyCap()
    __setSharedConcurrencyCapForTests(cap)
    const projectId = projectIdForRepoRoot(repoRoot)
    // Pre-fill the project's quota with three holdouts so the next
    // submission has to queue. cap defaults to 3.
    const blocker = new AbortController()
    const slots = await Promise.all([
      cap.acquireSlot({ projectId, sessionId: "blk-1", signal: blocker.signal }),
      cap.acquireSlot({ projectId, sessionId: "blk-2", signal: blocker.signal }),
      cap.acquireSlot({ projectId, sessionId: "blk-3", signal: blocker.signal }),
    ])
    expect(cap.inspect(projectId).inFlight).toHaveLength(3)

    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "queued-please", sessionId: "queued-one" })
    // Scripted runChatTurnSdk that emits turn_complete once the slot frees.
    const loaders = makeLoaders({
      scriptedEvents: [{ kind: "turn_complete", turnId: "t-q", stopReason: "end_turn" }],
    })
    const handlerPromise = handleChatRequest(mock.req, mock.res, { repoRoot, loaders })
    // Give the handler a tick to call acquireSlot + enqueue.
    await new Promise((r) => setTimeout(r, 25))
    expect(cap.inspect(projectId).queueDepth).toBe(1)

    // Release one held slot — the queued submission should drain and the
    // handler should run through to completion.
    slots[0].release()
    await handlerPromise

    const events = mock.events()
    // First event is `session` (Phase 1 contract). Phase 5's `queued`
    // event comes after, BEFORE `turn_complete`.
    expect(events[0]).toMatchObject({ kind: "session", sessionId: "queued-one" })
    const queuedIdx = events.findIndex((e) => e.kind === "queued")
    const completeIdx = events.findIndex((e) => e.kind === "turn_complete")
    expect(queuedIdx).toBeGreaterThan(0)
    expect(completeIdx).toBeGreaterThan(queuedIdx)
    expect(events[queuedIdx]).toMatchObject({
      kind: "queued",
      sessionId: "queued-one",
      queuePosition: 1,
    })

    // Cleanup.
    slots[1].release()
    slots[2].release()
  })

  it("does NOT emit a queued event when the project is under cap", async () => {
    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "immediate", sessionId: "immediate-one" })
    const loaders = makeLoaders({
      scriptedEvents: [{ kind: "turn_complete", turnId: "t-i", stopReason: "end_turn" }],
    })
    await handleChatRequest(mock.req, mock.res, { repoRoot, loaders })
    const events = mock.events()
    expect(events.find((e) => e.kind === "queued")).toBeUndefined()
    expect(events.find((e) => e.kind === "turn_complete")).toBeDefined()
  })
})

describe("handleChatRequest — Phase 5 rate-limit classification", () => {
  let repoRoot: string
  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "desde-chat-rl-"))
    __resetActiveTurnsForTest()
    const { __resetSharedConcurrencyCapForTests } = await import(
      "../../../../src/editor/agent-chat/concurrency-cap.js"
    )
    __resetSharedConcurrencyCapForTests()
  })
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
    __resetActiveTurnsForTest()
    const { __resetSharedConcurrencyCapForTests } = await import(
      "../../../../src/editor/agent-chat/concurrency-cap.js"
    )
    __resetSharedConcurrencyCapForTests()
  })

  it("persists statusFailureKind='rate-limited' + retryAfterSeconds when the orchestrator returns a 429-shaped turn.error", async () => {
    // Capture the final saveSession call so we can assert on it
    // without round-tripping through disk. The handler's contract
    // for failed turns is to write the terminal status with the
    // classifier's metadata; this verifies the route wires the
    // classifier into withSessionStatus correctly.
    const saved: Array<import("../../../../src/editor/agent-chat/types").ChatSession> = []
    const sessionId = "rl-session"
    const loaders: ChatHandlerLoaders = {
      loadRunChatTurnNeutral: async () => ({
        runChatTurnNeutral: async () => {
          throw new Error("this suite's turns run on the SDK loader, not neutral")
        },
      }),
      loadRunChatTurnSdk: async () => {
        const { makeEmptySession } = await import(
          "../../../../src/editor/agent-chat/types.js"
        )
        return {
          runChatTurnSdk: async (callOpts: {
            emit: (
              ev: import("../../../../src/editor/agent-chat/chat-stream-events").ChatStreamEvent,
            ) => void
          }) => {
            callOpts.emit({ kind: "turn_start", turnId: "t-rl" })
            callOpts.emit({
              kind: "turn_complete",
              turnId: "t-rl",
              stopReason: "end_turn",
            })
            const session = makeEmptySession("p", sessionId)
            return {
              session,
              turn: {
                id: "t-rl",
                startedAt: "x",
                userMessage: "hello",
                assistantContent: [],
                toolResults: {},
                editProposals: [],
                // The classifier looks at turn.error to pick the
                // failureKind. This shape matches what the SDK surfaces
                // for 429s.
                error: "Chat handler failed: AnthropicError: 429 rate_limit retry after 45 seconds",
              },
            }
          },
        } as unknown as Awaited<ReturnType<ChatHandlerLoaders["loadRunChatTurnSdk"]>>
      },
      loadSessionStore: async () => {
        const { makeEmptySession } = await import(
          "../../../../src/editor/agent-chat/types.js"
        )
        return {
          loadSession: async () =>
            ({ session: makeEmptySession("p", sessionId), fresh: true }) as Awaited<
              ReturnType<
                Awaited<
                  ReturnType<ChatHandlerLoaders["loadSessionStore"]>
                >["loadSession"]
              >
            >,
          saveSession: async (_root: string, session: import("../../../../src/editor/agent-chat/types").ChatSession) => {
            saved.push(JSON.parse(JSON.stringify(session)))
            return session
          },
        } as unknown as Awaited<ReturnType<ChatHandlerLoaders["loadSessionStore"]>>
      },
    }

    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "hi", sessionId })
    await handleChatRequest(mock.req, mock.res, { repoRoot, loaders })

    // First save is the pre-orchestrator in-flight write; the last
    // save is the terminal persistTurn. Assert on the terminal.
    expect(saved.length).toBeGreaterThanOrEqual(2)
    const terminal = saved[saved.length - 1]
    expect(terminal.status).toBe("failed")
    expect(terminal.statusFailureKind).toBe("rate-limited")
    expect(terminal.statusRetryAfterSeconds).toBe(45)
    // The persisted reason should be the SANITISED message (the
    // classifier strips the "Chat handler failed:" prefix).
    expect(terminal.statusReason).toMatch(/AnthropicError/)
    expect(terminal.statusReason).not.toMatch(/^Chat handler failed:/)
  })

  it("persists statusFailureKind='other' for non-rate-limit failures", async () => {
    const saved: Array<import("../../../../src/editor/agent-chat/types").ChatSession> = []
    const sessionId = "generic-fail"
    const loaders: ChatHandlerLoaders = {
      loadRunChatTurnNeutral: async () => ({
        runChatTurnNeutral: async () => {
          throw new Error("this suite's turns run on the SDK loader, not neutral")
        },
      }),
      loadRunChatTurnSdk: async () => {
        const { makeEmptySession } = await import(
          "../../../../src/editor/agent-chat/types.js"
        )
        return {
          runChatTurnSdk: async (callOpts: {
            emit: (
              ev: import("../../../../src/editor/agent-chat/chat-stream-events").ChatStreamEvent,
            ) => void
          }) => {
            callOpts.emit({ kind: "turn_start", turnId: "t-x" })
            callOpts.emit({
              kind: "turn_complete",
              turnId: "t-x",
              stopReason: "end_turn",
            })
            return {
              session: makeEmptySession("p", sessionId),
              turn: {
                id: "t-x",
                startedAt: "x",
                userMessage: "hello",
                assistantContent: [],
                toolResults: {},
                editProposals: [],
                error: "Bridge request timed out",
              },
            }
          },
        } as unknown as Awaited<ReturnType<ChatHandlerLoaders["loadRunChatTurnSdk"]>>
      },
      loadSessionStore: async () => {
        const { makeEmptySession } = await import(
          "../../../../src/editor/agent-chat/types.js"
        )
        return {
          loadSession: async () =>
            ({ session: makeEmptySession("p", sessionId), fresh: true }) as Awaited<
              ReturnType<
                Awaited<
                  ReturnType<ChatHandlerLoaders["loadSessionStore"]>
                >["loadSession"]
              >
            >,
          saveSession: async (_root: string, session: import("../../../../src/editor/agent-chat/types").ChatSession) => {
            saved.push(JSON.parse(JSON.stringify(session)))
            return session
          },
        } as unknown as Awaited<ReturnType<ChatHandlerLoaders["loadSessionStore"]>>
      },
    }

    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "hi", sessionId })
    await handleChatRequest(mock.req, mock.res, { repoRoot, loaders })

    expect(saved.length).toBeGreaterThanOrEqual(2)
    const terminal = saved[saved.length - 1]
    expect(terminal.status).toBe("failed")
    expect(terminal.statusFailureKind).toBe("other")
    expect(terminal.statusRetryAfterSeconds).toBeUndefined()
    expect(terminal.statusReason).toMatch(/Bridge request timed out/)
  })
})

describe("handleChatRequest — Phase 5 route-level lifecycle", () => {
  // Phase 5 verdict carry-forward: "Route-level lifecycle integration
  // tests (success→idle / throw→failed / queued-abort / orphan-resume
  // restart-clear) are tested at the helper + primitive level.
  // Comprehensive route-level coverage is a separate test-doubling
  // pass." These tests fill the route-level gap.

  let repoRoot: string
  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "desde-chat-lifecycle-"))
    __resetActiveTurnsForTest()
    __resetPendingBridgeRequestsForTest()
    const { __resetSharedConcurrencyCapForTests } = await import(
      "../../../../src/editor/agent-chat/concurrency-cap.js"
    )
    __resetSharedConcurrencyCapForTests()
  })
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
    __resetActiveTurnsForTest()
    __resetPendingBridgeRequestsForTest()
    const { __resetSharedConcurrencyCapForTests } = await import(
      "../../../../src/editor/agent-chat/concurrency-cap.js"
    )
    __resetSharedConcurrencyCapForTests()
  })

  /**
   * Shared loader factory for these lifecycle tests. Captures every
   * `saveSession` call in `saved` so each test can assert on the
   * terminal state (and the pre-orchestrator in-flight write).
   *
   * `runChatTurnSdkImpl` lets each test customize whether the
   * orchestrator returns a successful turn, returns a turn with
   * `error`, or throws outright.
   */
  function makeLifecycleLoaders(
    saved: Array<import("../../../../src/editor/agent-chat/types").ChatSession>,
    sessionId: string,
    runChatTurnSdkImpl: (callOpts: {
      emit: (
        ev: import("../../../../src/editor/agent-chat/chat-stream-events").ChatStreamEvent,
      ) => void
    }) => Promise<{
      session: import("../../../../src/editor/agent-chat/types").ChatSession
      turn: import("../../../../src/editor/agent-chat/types").ChatTurn
    }>,
    seedSession?: import("../../../../src/editor/agent-chat/types").ChatSession,
  ): ChatHandlerLoaders {
    return {
      loadRunChatTurnNeutral: async () => ({
        runChatTurnNeutral: async () => {
          throw new Error("this suite's turns run on the SDK loader, not neutral")
        },
      }),
      loadRunChatTurnSdk: async () =>
        ({ runChatTurnSdk: runChatTurnSdkImpl }) as unknown as Awaited<
          ReturnType<ChatHandlerLoaders["loadRunChatTurnSdk"]>
        >,
      loadSessionStore: async () => {
        const { makeEmptySession } = await import(
          "../../../../src/editor/agent-chat/types.js"
        )
        return {
          loadSession: async () =>
            seedSession
              ? ({ session: seedSession, fresh: false } as Awaited<
                  ReturnType<
                    Awaited<
                      ReturnType<ChatHandlerLoaders["loadSessionStore"]>
                    >["loadSession"]
                  >
                >)
              : ({
                  session: makeEmptySession("p", sessionId),
                  fresh: true,
                } as Awaited<
                  ReturnType<
                    Awaited<
                      ReturnType<ChatHandlerLoaders["loadSessionStore"]>
                    >["loadSession"]
                  >
                >),
          saveSession: async (
            _root: string,
            session: import("../../../../src/editor/agent-chat/types").ChatSession,
          ) => {
            saved.push(JSON.parse(JSON.stringify(session)))
            return session
          },
        } as unknown as Awaited<ReturnType<ChatHandlerLoaders["loadSessionStore"]>>
      },
    }
  }

  it("success → idle: persists status='idle' with no failure metadata when the turn completes cleanly", async () => {
    const saved: Array<import("../../../../src/editor/agent-chat/types").ChatSession> = []
    const sessionId = "lifecycle-success"
    const loaders = makeLifecycleLoaders(saved, sessionId, async (callOpts) => {
      const { makeEmptySession } = await import(
        "../../../../src/editor/agent-chat/types.js"
      )
      callOpts.emit({ kind: "turn_start", turnId: "t-ok" })
      callOpts.emit({ kind: "turn_complete", turnId: "t-ok", stopReason: "end_turn" })
      return {
        session: makeEmptySession("p", sessionId),
        turn: {
          id: "t-ok",
          startedAt: "x",
          userMessage: "hi",
          assistantContent: [],
          toolResults: {},
          editProposals: [],
        },
      }
    })

    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "hi", sessionId })
    await handleChatRequest(mock.req, mock.res, { repoRoot, loaders })

    // First save = pre-orchestrator in-flight marker.
    // Last save = terminal success write.
    expect(saved.length).toBeGreaterThanOrEqual(2)
    expect(saved[0].status).toBe("in-flight")
    const terminal = saved[saved.length - 1]
    expect(terminal.status).toBe("idle")
    // Clean success must NOT leave failure metadata sitting on the
    // record — otherwise the picker would render a stale "Failed"
    // badge after a successful retry. withSessionStatus enforces
    // this; the route test pins the contract end-to-end.
    expect(terminal.statusFailureKind).toBeUndefined()
    expect(terminal.statusRetryAfterSeconds).toBeUndefined()
    expect(terminal.statusReason).toBeUndefined()
  })

  it("outer-catch throw → failed: persists status='failed' via the recovery write when the orchestrator throws", async () => {
    // Different from the turn.error path covered at line 686:
    // here the orchestrator THROWS rather than returning a turn
    // with an error field. The chat-handler's outer try/catch arm
    // is what writes the terminal `failed` status in this branch.
    const saved: Array<import("../../../../src/editor/agent-chat/types").ChatSession> = []
    const sessionId = "lifecycle-throw"
    const loaders = makeLifecycleLoaders(saved, sessionId, async () => {
      throw new Error("orchestrator boom")
    })

    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "hi", sessionId })
    await handleChatRequest(mock.req, mock.res, { repoRoot, loaders })

    // First save = pre-orchestrator in-flight marker; the
    // recovery write in the catch arm should re-load + then
    // re-save with status=failed.
    expect(saved.length).toBeGreaterThanOrEqual(2)
    expect(saved[0].status).toBe("in-flight")
    const terminal = saved[saved.length - 1]
    expect(terminal.status).toBe("failed")
    expect(terminal.statusReason).toMatch(/orchestrator boom/i)
    // Throw-shaped failures get a generic kind unless the message
    // matches the rate-limit pattern (it doesn't here).
    expect(terminal.statusFailureKind).toBe("other")
    // SSE stream surfaces the error too so the client renders the
    // banner, not just the badge.
    const events = mock.events()
    expect(events.find((e) => e.kind === "error")).toBeDefined()
  })

  it("cancelled session refusal: refuses an in-bound submit against a session already marked cancelled (codex round-1 #2)", async () => {
    // Phase 5 cancelled-session check: a submission against a
    // session already marked cancelled must produce a clear SSE
    // error rather than slip through.
    const { makeEmptySession } = await import(
      "../../../../src/editor/agent-chat/types.js"
    )
    const sessionId = "lifecycle-cancelled"
    const cancelled = makeEmptySession("p", sessionId)
    cancelled.status = "cancelled"
    cancelled.statusReason = "restart-clear"

    const saved: Array<import("../../../../src/editor/agent-chat/types").ChatSession> = []
    let orchestratorCalled = false
    const loaders = makeLifecycleLoaders(
      saved,
      sessionId,
      async () => {
        orchestratorCalled = true
        // Should never be reached — the cancelled refusal short-circuits.
        throw new Error("orchestrator should NOT be called for a cancelled session")
      },
      cancelled,
    )

    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "hi", sessionId })
    await handleChatRequest(mock.req, mock.res, { repoRoot, loaders })

    expect(orchestratorCalled).toBe(false)
    // No saves at all — the refusal happens before the in-flight
    // marker write so the cancelled status is preserved on disk.
    expect(saved).toEqual([])
    const events = mock.events()
    const refusal = events.find((e) => e.kind === "error")
    expect(refusal).toBeDefined()
    expect((refusal as { reason: string }).reason).toMatch(/cancelled/i)
    expect((refusal as { reason: string }).reason).toMatch(/Start a new chat/i)
  })
})

describe("handleChatRequest — modelConfig (Task 4)", () => {
  // Precedence rule under test: request modelConfig > session-persisted
  // modelConfig > absent (runtime default). A request that carries
  // modelConfig also overwrites the session's persisted value.

  let repoRoot: string
  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "desde-chat-modelconfig-"))
    __resetActiveTurnsForTest()
    __resetPendingBridgeRequestsForTest()
  })
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
    __resetActiveTurnsForTest()
    __resetPendingBridgeRequestsForTest()
  })

  /**
   * Loader factory for modelConfig tests — mirrors `makeLifecycleLoaders`
   * above. Captures the opts passed to `runChatTurnSdk` (so tests can
   * assert `model`/`effort`) and every `saveSession` call (so tests can
   * assert the persisted modelConfig). `seedSession` lets a test start
   * from a session that already has a persisted modelConfig.
   */
  function makeModelConfigLoaders(opts: {
    saved: Array<import("../../../../src/editor/agent-chat/types").ChatSession>
    capturedRunOpts: { value?: Record<string, unknown> }
    seedSession?: import("../../../../src/editor/agent-chat/types").ChatSession
  }): ChatHandlerLoaders {
    return {
      loadRunChatTurnNeutral: async () => ({
        runChatTurnNeutral: async () => {
          throw new Error("this suite's turns run on the SDK loader, not neutral")
        },
      }),
      loadRunChatTurnSdk: async () => {
        return {
          runChatTurnSdk: async (
            callOpts: Record<string, unknown> & {
              emit: (
                ev: import("../../../../src/editor/agent-chat/chat-stream-events").ChatStreamEvent,
              ) => void
              session: import("../../../../src/editor/agent-chat/types").ChatSession
            },
          ) => {
            opts.capturedRunOpts.value = callOpts
            callOpts.emit({ kind: "turn_complete", turnId: "t-1", stopReason: "end_turn" })
            // Mirror the real SDK runtime: it returns the (possibly
            // mutated) session it was handed, not a fresh one — so the
            // caller's modelConfig merge survives into the terminal save.
            return {
              session: callOpts.session,
              turn: {
                id: "t-1",
                startedAt: "x",
                userMessage: "ignored",
                assistantContent: [],
                toolResults: {},
                editProposals: [],
              },
            }
          },
        } as unknown as Awaited<ReturnType<ChatHandlerLoaders["loadRunChatTurnSdk"]>>
      },
      loadSessionStore: async () => {
        const { makeEmptySession } = await import(
          "../../../../src/editor/agent-chat/types.js"
        )
        return {
          loadSession: async () =>
            opts.seedSession
              ? ({ session: opts.seedSession, fresh: false } as Awaited<
                  ReturnType<
                    Awaited<
                      ReturnType<ChatHandlerLoaders["loadSessionStore"]>
                    >["loadSession"]
                  >
                >)
              : ({
                  session: makeEmptySession("test-proj"),
                  fresh: true,
                } as Awaited<
                  ReturnType<
                    Awaited<
                      ReturnType<ChatHandlerLoaders["loadSessionStore"]>
                    >["loadSession"]
                  >
                >),
          saveSession: async (
            _root: string,
            session: import("../../../../src/editor/agent-chat/types").ChatSession,
          ) => {
            opts.saved.push(JSON.parse(JSON.stringify(session)))
            return session
          },
        } as unknown as Awaited<ReturnType<ChatHandlerLoaders["loadSessionStore"]>>
      },
    }
  }

  it("rejects an unknown model with 400", async () => {
    const mock = makeMockReqRes()
    mock.setBody({
      userMessage: "hi",
      modelConfig: { provider: "anthropic", model: "claude-bogus" },
    })
    const loaders = makeModelConfigLoaders({ saved: [], capturedRunOpts: {} })
    await handleChatRequest(mock.req, mock.res, { repoRoot, loaders })
    expect((mock.res as unknown as { statusCode: number }).statusCode).toBe(400)
    const body = JSON.parse(mock.endBody() ?? "{}")
    expect(body.error).toMatch(/unknown model/i)
  })

  it("forwards model + effort to runChatTurnSdk and persists on the session", async () => {
    const saved: Array<import("../../../../src/editor/agent-chat/types").ChatSession> = []
    const capturedRunOpts: { value?: Record<string, unknown> } = {}
    const mock = makeMockReqRes()
    mock.setBody({
      userMessage: "hi",
      modelConfig: { provider: "anthropic", model: "claude-sonnet-4-6", effort: "low" },
    })
    const loaders = makeModelConfigLoaders({ saved, capturedRunOpts })
    await handleChatRequest(mock.req, mock.res, { repoRoot, loaders })

    expect(capturedRunOpts.value?.model).toBe("claude-sonnet-4-6")
    expect(capturedRunOpts.value?.effort).toBe("low")
    const persisted = saved.at(-1)
    expect(persisted?.modelConfig).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      effort: "low",
    })
  })

  it("falls back to the session-persisted modelConfig when the request has none", async () => {
    const { makeEmptySession } = await import(
      "../../../../src/editor/agent-chat/types.js"
    )
    const seedSession = makeEmptySession("test-proj") as import(
      "../../../../src/editor/agent-chat/types"
    ).ChatSession
    seedSession.modelConfig = { provider: "anthropic", model: "claude-haiku-4-5" }
    const capturedRunOpts: { value?: Record<string, unknown> } = {}
    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "hi" })
    const loaders = makeModelConfigLoaders({ saved: [], capturedRunOpts, seedSession })
    await handleChatRequest(mock.req, mock.res, { repoRoot, loaders })

    expect(capturedRunOpts.value?.model).toBe("claude-haiku-4-5")
    expect(capturedRunOpts.value?.effort).toBeUndefined()
  })

  it("passes no model when neither request nor session has a config", async () => {
    const capturedRunOpts: { value?: Record<string, unknown> } = {}
    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "hi" })
    const loaders = makeModelConfigLoaders({ saved: [], capturedRunOpts })
    await handleChatRequest(mock.req, mock.res, { repoRoot, loaders })

    expect(capturedRunOpts.value?.model).toBeUndefined()
    expect(capturedRunOpts.value?.effort).toBeUndefined()
  })

  it("ignores a persisted model that is no longer in the catalog", async () => {
    const { makeEmptySession } = await import(
      "../../../../src/editor/agent-chat/types.js"
    )
    const seedSession = makeEmptySession("test-proj") as import(
      "../../../../src/editor/agent-chat/types"
    ).ChatSession
    seedSession.modelConfig = { provider: "anthropic", model: "claude-retired-1" }
    const capturedRunOpts: { value?: Record<string, unknown> } = {}
    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "hi" })
    const loaders = makeModelConfigLoaders({ saved: [], capturedRunOpts, seedSession })
    await handleChatRequest(mock.req, mock.res, { repoRoot, loaders })

    expect(capturedRunOpts.value?.model).toBeUndefined() // falls back to runtime default
  })

  // M3 — the spec requires the silent fallback above to announce itself
  // once, so the user isn't left wondering why their saved model stopped
  // being used.
  it("notes on the stream when a persisted model has left the catalog", async () => {
    const { makeEmptySession } = await import(
      "../../../../src/editor/agent-chat/types.js"
    )
    const seedSession = makeEmptySession("test-proj") as import(
      "../../../../src/editor/agent-chat/types"
    ).ChatSession
    seedSession.modelConfig = { provider: "anthropic", model: "claude-retired-1" }
    const capturedRunOpts: { value?: Record<string, unknown> } = {}
    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "hi" })
    const loaders = makeModelConfigLoaders({ saved: [], capturedRunOpts, seedSession })
    await handleChatRequest(mock.req, mock.res, { repoRoot, loaders })

    expect((mock.res as unknown as { statusCode: number }).statusCode).toBe(200)
    const note = mock
      .events()
      .find(
        (e) =>
          e.kind === "error" &&
          typeof e.reason === "string" &&
          /no longer available/i.test(e.reason as string),
      )
    expect(note).toBeDefined()
    expect(note?.reason).toMatch(/default model for this turn/i)
    // Still non-blocking: the turn ran on the runtime default.
    expect(capturedRunOpts.value?.model).toBeUndefined()
  })

  // M3 — the spec calls for a ONE-TIME notice. The notes ride the
  // `error` event kind, so leaving the dead choice on the session would
  // raise a fresh error banner every turn forever. Clearing it makes the
  // notice fire exactly once.
  it("clears the dead persisted choice so the notice does not repeat", async () => {
    const { makeEmptySession } = await import(
      "../../../../src/editor/agent-chat/types.js"
    )
    const seedSession = makeEmptySession("test-proj") as import(
      "../../../../src/editor/agent-chat/types"
    ).ChatSession
    seedSession.modelConfig = { provider: "anthropic", model: "claude-retired-1" }
    const saved: Array<
      import("../../../../src/editor/agent-chat/types").ChatSession
    > = []
    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "hi" })
    const loaders = makeModelConfigLoaders({
      saved,
      capturedRunOpts: {},
      seedSession,
    })
    await handleChatRequest(mock.req, mock.res, { repoRoot, loaders })

    // Every persisted write of this session drops the stale model, so
    // the next turn loads a session with no choice and stays silent.
    expect(saved.length).toBeGreaterThan(0)
    for (const s of saved) {
      expect(s.modelConfig).toBeUndefined()
    }
  })

  it("emits no stale-model note when the persisted model is still valid", async () => {
    const { makeEmptySession } = await import(
      "../../../../src/editor/agent-chat/types.js"
    )
    const seedSession = makeEmptySession("test-proj") as import(
      "../../../../src/editor/agent-chat/types"
    ).ChatSession
    seedSession.modelConfig = { provider: "anthropic", model: "claude-opus-5" }
    const capturedRunOpts: { value?: Record<string, unknown> } = {}
    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "hi" })
    const loaders = makeModelConfigLoaders({ saved: [], capturedRunOpts, seedSession })
    await handleChatRequest(mock.req, mock.res, { repoRoot, loaders })

    expect(capturedRunOpts.value?.model).toBe("claude-opus-5")
    expect(
      mock
        .events()
        .filter(
          (e) =>
            e.kind === "error" &&
            typeof e.reason === "string" &&
            /no longer available/i.test(e.reason as string),
        ),
    ).toHaveLength(0)
  })

  // M1 — the persisted path used to forward the RAW session object,
  // discarding the validator's sanitized `config`. A hand-edited session
  // pairing a no-effort model with an effort value would forward that
  // effort into the SDK query.
  it("sanitizes a persisted config instead of forwarding it raw", async () => {
    const { makeEmptySession } = await import(
      "../../../../src/editor/agent-chat/types.js"
    )
    const seedSession = makeEmptySession("test-proj") as import(
      "../../../../src/editor/agent-chat/types"
    ).ChatSession
    // Haiku 4.5 has `effortLevels: null` — the validator strips effort
    // with a warning rather than erroring.
    seedSession.modelConfig = {
      provider: "anthropic",
      model: "claude-haiku-4-5",
      effort: "low",
    }
    const capturedRunOpts: { value?: Record<string, unknown> } = {}
    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "hi" })
    const loaders = makeModelConfigLoaders({ saved: [], capturedRunOpts, seedSession })
    await handleChatRequest(mock.req, mock.res, { repoRoot, loaders })

    expect(capturedRunOpts.value?.model).toBe("claude-haiku-4-5")
    expect(capturedRunOpts.value?.effort).toBeUndefined()
    // And the strip is announced, same as on the request path.
    expect(
      mock
        .events()
        .find(
          (e) =>
            e.kind === "error" &&
            typeof e.reason === "string" &&
            /does not support effort/i.test(e.reason as string),
        ),
    ).toBeDefined()
  })

  it("surfaces validator warnings as non-fatal SSE error events without blocking the turn", async () => {
    const capturedRunOpts: { value?: Record<string, unknown> } = {}
    const mock = makeMockReqRes()
    mock.setBody({
      userMessage: "hi",
      // Haiku has no effort levels — effort is stripped with a warning,
      // not a hard error (validateSessionModelConfig).
      modelConfig: { provider: "anthropic", model: "claude-haiku-4-5", effort: "low" },
    })
    const loaders = makeModelConfigLoaders({ saved: [], capturedRunOpts })
    await handleChatRequest(mock.req, mock.res, { repoRoot, loaders })

    expect((mock.res as unknown as { statusCode: number }).statusCode).toBe(200)
    const events = mock.events()
    const warning = events.find(
      (e) =>
        e.kind === "error" &&
        typeof e.reason === "string" &&
        /does not support effort/i.test(e.reason as string),
    )
    expect(warning).toBeDefined()
    // Non-fatal: the turn still ran with the (effort-stripped) model.
    expect(capturedRunOpts.value?.model).toBe("claude-haiku-4-5")
  })
})

describe("handleChatRequest — image input (vision)", () => {
  // A minimal valid 1×1 PNG data URL — passes imageFromDataUrl (supported
  // type, valid base64, well under the 4.5MB cap).
  const TINY_PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

  let repoRoot: string
  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "desde-chat-img-"))
    __resetActiveTurnsForTest()
    __resetPendingBridgeRequestsForTest()
    const { __resetSharedConcurrencyCapForTests } = await import(
      "../../../../src/editor/agent-chat/concurrency-cap.js"
    )
    __resetSharedConcurrencyCapForTests()
  })
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
    __resetActiveTurnsForTest()
    __resetPendingBridgeRequestsForTest()
  })

  /**
   * Loaders that capture the opts handed to runChatTurnSdk so a test can
   * assert what `images` were forwarded.
   */
  function makeSdkCapturingLoaders(capture: { opts?: Record<string, unknown> }): ChatHandlerLoaders {
    const base = makeLoaders({ scriptedEvents: [] })
    return {
      ...base,
      loadRunChatTurnSdk: async () => {
        const { makeEmptySession } = await import(
          "../../../../src/editor/agent-chat/types.js"
        )
        return {
          runChatTurnSdk: async (opts: {
            emit: (
              ev: import("../../../../src/editor/agent-chat/chat-stream-events").ChatStreamEvent,
            ) => void
          } & Record<string, unknown>) => {
            capture.opts = opts
            opts.emit({ kind: "turn_complete", turnId: "t-img", stopReason: "end_turn" })
            return {
              session: makeEmptySession("test-proj"),
              turn: {
                id: "t-img",
                startedAt: "x",
                userMessage: "ignored",
                assistantContent: [],
                toolResults: {},
                editProposals: [],
              },
            }
          },
        } as unknown as Awaited<ReturnType<NonNullable<ChatHandlerLoaders["loadRunChatTurnSdk"]>>>
      },
    }
  }

  it("400s when `images` is not an array", async () => {
    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "hi", images: "not-an-array" })
    await handleChatRequest(mock.req, mock.res, { repoRoot } as ChatHandlerContext)
    expect((mock.res as unknown as { statusCode: number }).statusCode).toBe(400)
  })

  it("400s when every provided image is invalid", async () => {
    const mock = makeMockReqRes()
    mock.setBody({
      userMessage: "match this",
      images: ["not-a-data-url", "data:text/plain;base64,SGVsbG8="],
    })
    await handleChatRequest(mock.req, mock.res, { repoRoot } as ChatHandlerContext)
    expect((mock.res as unknown as { statusCode: number }).statusCode).toBe(400)
  })

  it("400s on an empty turn — no text and no valid image", async () => {
    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "   ", images: [] })
    await handleChatRequest(mock.req, mock.res, { repoRoot } as ChatHandlerContext)
    expect((mock.res as unknown as { statusCode: number }).statusCode).toBe(400)
  })

  it("forwards a validated image to runChatTurnSdk as a decoded ModelImageContent block", async () => {
    const capture: { opts?: Record<string, unknown> } = {}
    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "match this", images: [TINY_PNG] })
    await handleChatRequest(mock.req, mock.res, {
      repoRoot,
      loaders: makeSdkCapturingLoaders(capture),
    })
    const images = capture.opts?.images as
      | Array<{ type: string; data: string; mimeType: string }>
      | undefined
    expect(images).toBeDefined()
    expect(images).toHaveLength(1)
    expect(images![0].type).toBe("image")
    expect(images![0].mimeType).toBe("image/png")
    // The base64 payload has been stripped of the `data:` prefix.
    expect(images![0].data).not.toMatch(/^data:/)
    expect(images![0].data.length).toBeGreaterThan(0)
  })

  it("drops invalid images but forwards the valid ones (partial batch)", async () => {
    const capture: { opts?: Record<string, unknown> } = {}
    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "match this", images: ["garbage", TINY_PNG] })
    await handleChatRequest(mock.req, mock.res, {
      repoRoot,
      loaders: makeSdkCapturingLoaders(capture),
    })
    // Not a 400 — at least one image survived.
    const images = capture.opts?.images as unknown[] | undefined
    expect(images).toHaveLength(1)
  })

  it("allows an image-only turn (empty text + valid image)", async () => {
    const capture: { opts?: Record<string, unknown> } = {}
    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "", images: [TINY_PNG] })
    await handleChatRequest(mock.req, mock.res, {
      repoRoot,
      loaders: makeSdkCapturingLoaders(capture),
    })
    // Reached the orchestrator (no 400) with the image forwarded.
    expect((capture.opts?.images as unknown[] | undefined)?.length).toBe(1)
  })

  it("does not set images on the SDK opts for a text-only turn", async () => {
    const capture: { opts?: Record<string, unknown> } = {}
    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "text only" })
    await handleChatRequest(mock.req, mock.res, {
      repoRoot,
      loaders: makeSdkCapturingLoaders(capture),
    })
    expect(capture.opts?.images).toBeUndefined()
  })
})

describe("handleBridgeReply", () => {
  beforeEach(() => __resetPendingBridgeRequestsForTest())
  afterEach(() => __resetPendingBridgeRequestsForTest())

  it("404s for an unknown bridgeReqId", async () => {
    const mock = makeMockReqRes()
    mock.setBody({ bridgeReqId: "no-such-id", ok: true })
    await handleBridgeReply(mock.req, mock.res)
    expect((mock.res as unknown as { statusCode: number }).statusCode).toBe(404)
  })

  it("400s on invalid JSON", async () => {
    const mock = makeMockReqRes()
    Object.assign(mock.req, {
      [Symbol.asyncIterator]: async function* () {
        yield "{nope"
      },
    })
    await handleBridgeReply(mock.req, mock.res)
    expect((mock.res as unknown as { statusCode: number }).statusCode).toBe(400)
  })

  it("400s when bridgeReqId is missing", async () => {
    const mock = makeMockReqRes()
    mock.setBody({ ok: true })
    await handleBridgeReply(mock.req, mock.res)
    expect((mock.res as unknown as { statusCode: number }).statusCode).toBe(400)
  })
})

describe("bridge request/reply round trip", () => {
  let repoRoot: string
  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "desde-chat-"))
    __resetPendingBridgeRequestsForTest()
    __resetActiveTurnsForTest()
  })
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
    __resetPendingBridgeRequestsForTest()
    __resetActiveTurnsForTest()
  })

  it("resolves a pending bridge_request when the shell replies", async () => {
    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "what is selected?" })

    // The fake runChatTurnSdk calls bridge.send() and emits the result.
    const loaders: ChatHandlerLoaders = {
      loadRunChatTurnNeutral: async () => ({
        runChatTurnNeutral: async () => {
          throw new Error("this suite's turns run on the SDK loader, not neutral")
        },
      }),
      loadRunChatTurnSdk: async () =>
        ({
          runChatTurnSdk: async (callOpts: {
            bridge: import("../../../../src/editor/agent-tools/types.js").BridgeClient
            emit: (
              ev: import("../../../../src/editor/agent-chat/chat-stream-events").ChatStreamEvent,
            ) => void
          }) => {
            // Kick off a bridge request — the test will reply to it
            // shortly via handleBridgeReply.
            const resultPromise = callOpts.bridge.send("chat:get_selection", undefined)
            const result = await resultPromise
            callOpts.emit({
              kind: "tool_result",
              turnId: "t",
              toolUseId: "tu-x",
              ok: true,
              output: result,
            })
            callOpts.emit({ kind: "turn_complete", turnId: "t", stopReason: "end_turn" })
            const { makeEmptySession } = await import(
              "../../../../src/editor/agent-chat/types.js"
            )
            return {
              session: makeEmptySession("p"),
              turn: {
                id: "t",
                startedAt: "x",
                userMessage: "",
                assistantContent: [],
                toolResults: {},
                editProposals: [],
              },
            }
          },
        }) as unknown as Awaited<ReturnType<ChatHandlerLoaders["loadRunChatTurnSdk"]>>,
      loadSessionStore: async () => ({
        loadSession: async () => {
          const { makeEmptySession } = await import(
            "../../../../src/editor/agent-chat/types.js"
          )
          return { session: makeEmptySession("p"), fresh: true } as Awaited<
            ReturnType<
              Awaited<
                ReturnType<ChatHandlerLoaders["loadSessionStore"]>
              >["loadSession"]
            >
          >
        },
        saveSession: async (_root: string, session: unknown) => session,
      }) as unknown as Awaited<ReturnType<ChatHandlerLoaders["loadSessionStore"]>>,
    }

    // Run the handler — it will block awaiting our reply. Kick off the
    // reply in parallel after a microtask delay so the SSE stream has
    // emitted the bridge_request event we can extract the id from.
    const chatPromise = handleChatRequest(mock.req, mock.res, { repoRoot, loaders })

    // Wait until the bridge_request event has been written.
    let bridgeReqId: string | null = null
    for (let i = 0; i < 50 && bridgeReqId === null; i++) {
      await new Promise<void>((r) => setImmediate(r))
      const evs = mock.events()
      const br = evs.find((e) => e.kind === "bridge_request")
      if (br && typeof br.bridgeReqId === "string") {
        bridgeReqId = br.bridgeReqId
      }
    }
    expect(bridgeReqId).not.toBeNull()
    if (!bridgeReqId) throw new Error("no bridge request seen")

    // Reply.
    const reply = makeMockReqRes()
    reply.setBody({
      bridgeReqId,
      ok: true,
      output: { componentName: "KButton" },
    })
    await handleBridgeReply(reply.req, reply.res)
    expect((reply.res as unknown as { statusCode: number }).statusCode).toBe(200)

    await chatPromise
    const events = mock.events()
    const toolResult = events.find((e) => e.kind === "tool_result")
    expect(toolResult).toBeDefined()
    expect((toolResult as { output: { componentName: string } }).output.componentName).toBe(
      "KButton",
    )
  })

  it("times out a pending bridge_request when the shell never replies", async () => {
    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "x" })
    let captured: Error | null = null
    const loaders: ChatHandlerLoaders = {
      loadRunChatTurnNeutral: async () => ({
        runChatTurnNeutral: async () => {
          throw new Error("this suite's turns run on the SDK loader, not neutral")
        },
      }),
      loadRunChatTurnSdk: async () =>
        ({
          runChatTurnSdk: async (callOpts: {
            bridge: import("../../../../src/editor/agent-tools/types.js").BridgeClient
            emit: (
              ev: import("../../../../src/editor/agent-chat/chat-stream-events").ChatStreamEvent,
            ) => void
          }) => {
            try {
              await callOpts.bridge.send("chat:get_selection", undefined)
            } catch (err) {
              captured = err as Error
            }
            callOpts.emit({ kind: "turn_complete", turnId: "t", stopReason: "end_turn" })
            const { makeEmptySession } = await import(
              "../../../../src/editor/agent-chat/types.js"
            )
            return {
              session: makeEmptySession("p"),
              turn: {
                id: "t",
                startedAt: "x",
                userMessage: "",
                assistantContent: [],
                toolResults: {},
                editProposals: [],
              },
            }
          },
        }) as unknown as Awaited<ReturnType<ChatHandlerLoaders["loadRunChatTurnSdk"]>>,
      loadSessionStore: async () => ({
        loadSession: async () => {
          const { makeEmptySession } = await import(
            "../../../../src/editor/agent-chat/types.js"
          )
          return { session: makeEmptySession("p"), fresh: true } as Awaited<
            ReturnType<
              Awaited<
                ReturnType<ChatHandlerLoaders["loadSessionStore"]>
              >["loadSession"]
            >
          >
        },
        saveSession: async (_root: string, session: unknown) => session,
      }) as unknown as Awaited<ReturnType<ChatHandlerLoaders["loadSessionStore"]>>,
    }
    await handleChatRequest(mock.req, mock.res, {
      repoRoot,
      loaders,
      bridgeRequestTimeoutMs: 50,
    })
    expect(captured).not.toBeNull()
    expect(captured!.message).toMatch(/timed out/)
  })
})

describe("handleSteerRequest — mid-turn steering", () => {
  let repoRoot: string
  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "desde-chat-steer-"))
    __resetActiveTurnsForTest()
    __resetPendingBridgeRequestsForTest()
    const { __resetSharedConcurrencyCapForTests } = await import(
      "../../../../src/editor/agent-chat/concurrency-cap.js"
    )
    __resetSharedConcurrencyCapForTests()
  })
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
    __resetActiveTurnsForTest()
    __resetPendingBridgeRequestsForTest()
  })

  /** One message as the model would have received it, flattened for asserting. */
  interface DeliveredMessage {
    text: string
    imageBlocks: number
  }

  /**
   * A turn that behaves like the real one on the axis these tests care about:
   * it runs on the REAL `TurnInputChannel` the handler registered, seeds it
   * through `begin()` exactly as the runtime does, and drains it the way the
   * SDK drains its prompt. So what a test asserts is what the model would
   * actually have been handed — a mock channel would let a delivery bug pass by
   * agreeing with the handler.
   *
   * The turn parks on `finish` so the test can steer while it is running.
   * `beforeStart` parks it BEFORE it is reached at all, which is how the
   * registration-window tests steer a turn that holds the lock but has not
   * begun.
   */
  function makeSteerableLoaders(opts: {
    received: DeliveredMessage[]
    finish: Promise<void>
    /** Called once the turn runtime has been entered. */
    onRegistered: () => void
    /** Awaited before the runtime is even loaded — stands in for setup awaits. */
    beforeStart?: Promise<void>
  }): ChatHandlerLoaders {
    const base = makeLoaders({ scriptedEvents: [] })
    return {
      ...base,
      loadRunChatTurnSdk: async () => {
        // Awaited HERE, where the real handler awaits session load, project
        // knowledge, web policy and the concurrency-cap queue: after the lock
        // is taken and before the turn runtime runs.
        if (opts.beforeStart) await opts.beforeStart
        const { createTurnInputChannel } = await import(
          "../../../../src/editor/agent-chat-sdk/turn-input-channel.js"
        )
        const { makeEmptySession } = await import(
          "../../../../src/editor/agent-chat/types.js"
        )
        return {
          runChatTurnSdk: async (callOpts: {
            emit: (
              ev: import("../../../../src/editor/agent-chat/chat-stream-events").ChatStreamEvent,
            ) => void
            userMessage: string
            inputChannel?: import("../../../../src/editor/agent-chat-sdk/turn-input-channel").TurnInputChannel
          }) => {
            const channel = callOpts.inputChannel ?? createTurnInputChannel()
            channel.begin({ text: callOpts.userMessage })
            opts.onRegistered()
            const drained = (async () => {
              for await (const m of channel.stream()) {
                const content = m.message.content
                const blocks = Array.isArray(content) ? content : []
                opts.received.push({
                  text: blocks.map((b) => (b.type === "text" ? b.text : "")).join(""),
                  imageBlocks: blocks.filter((b) => b.type === "image").length,
                })
              }
            })()
            callOpts.emit({ kind: "turn_start", turnId: "t-steer" })
            await opts.finish
            channel.close()
            await drained
            callOpts.emit({
              kind: "turn_complete",
              turnId: "t-steer",
              stopReason: "end_turn",
            })
            return {
              session: makeEmptySession("test-proj"),
              turn: {
                id: "t-steer",
                startedAt: "x",
                userMessage: callOpts.userMessage,
                assistantContent: [],
                toolResults: {},
                editProposals: [],
              },
            }
          },
        } as unknown as Awaited<ReturnType<ChatHandlerLoaders["loadRunChatTurnSdk"]>>
      },
    }
  }

  /** Start a turn and resolve once its runtime is running. */
  async function startLiveTurn(
    sessionId: string,
    received: DeliveredMessage[],
    opts: { beforeStart?: Promise<void> } = {},
  ): Promise<{
    turn: MockReqRes
    done: Promise<void>
    release: () => void
    started: Promise<void>
  }> {
    let release: () => void = () => {}
    const finish = new Promise<void>((resolve) => {
      release = resolve
    })
    let signalStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve
    })
    const turn = makeMockReqRes()
    turn.setBody({ userMessage: "start the work", sessionId })
    const done = handleChatRequest(turn.req, turn.res, {
      repoRoot,
      loaders: makeSteerableLoaders({
        received,
        finish,
        onRegistered: () => signalStarted(),
        ...(opts.beforeStart ? { beforeStart: opts.beforeStart } : {}),
      }),
    })
    if (opts.beforeStart) {
      // The caller is deliberately holding the turn in its setup awaits, so
      // waiting for the runtime would deadlock — the point of that test is
      // that the turn is steerable BEFORE the runtime is reached. Wait instead
      // on the `session` SSE event, which the handler sends in the same
      // synchronous block that registers the channel: once it is visible, the
      // registration has happened.
      for (let i = 0; i < 100; i++) {
        if (turn.events().some((e) => e.kind === "session")) break
        await new Promise<void>((r) => setImmediate(r))
      }
      expect(turn.events().some((e) => e.kind === "session")).toBe(true)
      return { turn, done, release, started }
    }
    // Wait on the runtime entry itself, not on elapsed ticks. Polling was tried
    // first and was flaky by construction: the fake runtime dynamically imports
    // the channel module, and on the first test to do so that load outran a
    // 100-tick budget. Racing `done` keeps a turn that dies before starting
    // from hanging the test — the assertion below then fails loudly instead.
    await Promise.race([started, done])
    expect(turn.events().some((e) => e.kind === "turn_start")).toBe(true)
    return { turn, done, release, started }
  }

  async function steer(body: unknown): Promise<{ status: number; result: SteerResult }> {
    const mock = makeMockReqRes()
    mock.setBody(body)
    await handleSteerRequest(mock.req, mock.res, { repoRoot })
    return {
      status: (mock.res as unknown as { statusCode: number }).statusCode,
      result: JSON.parse(mock.endBody() ?? "{}") as SteerResult,
    }
  }

  it("400s on an invalid JSON body", async () => {
    const mock = makeMockReqRes()
    Object.assign(mock.req, {
      [Symbol.asyncIterator]: async function* () {
        yield "{not valid json"
      },
    })
    await handleSteerRequest(mock.req, mock.res, { repoRoot })
    expect((mock.res as unknown as { statusCode: number }).statusCode).toBe(400)
  })

  it("400s on a JSON body that is not an object", async () => {
    // `JSON.parse("null")` succeeds; reading a field off it would throw and the
    // listener would answer 500, which a client cannot tell from a real fault.
    const mock = makeMockReqRes()
    Object.assign(mock.req, {
      [Symbol.asyncIterator]: async function* () {
        yield "null"
      },
    })
    await handleSteerRequest(mock.req, mock.res, { repoRoot })
    expect((mock.res as unknown as { statusCode: number }).statusCode).toBe(400)
  })

  it("400s when userMessage is missing", async () => {
    const { status } = await steer({ sessionId: "s-1" })
    expect(status).toBe(400)
  })

  it("400s on an empty steer — no text and no images", async () => {
    const { status, result } = await steer({ sessionId: "s-1", userMessage: "   " })
    expect(status).toBe(400)
    expect(result.accepted).toBe(false)
  })

  it("400s on a malformed sessionId (same path-traversal defense as the chat route)", async () => {
    const { status } = await steer({
      sessionId: "../../../etc/passwd",
      userMessage: "hi",
    })
    expect(status).toBe(400)
  })

  it("400s when every provided image is invalid", async () => {
    const { status } = await steer({
      sessionId: "s-1",
      userMessage: "look",
      images: ["not-a-data-url"],
    })
    expect(status).toBe(400)
  })

  it("409s with reason 'no-live-turn' when no turn is running", async () => {
    const { status, result } = await steer({ sessionId: "s-idle", userMessage: "hi" })
    expect(status).toBe(409)
    expect(result).toEqual({ accepted: false, reason: "no-live-turn" })
  })

  it("delivers into a live turn and announces it on the OWNING stream", async () => {
    const received: DeliveredMessage[] = []
    const { turn, done, release } = await startLiveTurn("s-live", received)

    const { status, result } = await steer({
      sessionId: "s-live",
      userMessage: "actually, use the other component",
    })
    expect(status).toBe(200)
    expect(result).toEqual({ accepted: true })

    release()
    await done

    // The model received the initial message, then the steer, in that order.
    expect(received.map((m) => m.text)).toEqual([
      "start the work",
      "actually, use the other component",
    ])
    // The steering POST answered a different client than the one reading the
    // stream, so the announcement has to ride the turn's own stream.
    const steered = turn.events().find((e) => e.kind === "steered")
    expect(steered).toMatchObject({
      kind: "steered",
      sessionId: "s-live",
      userMessage: "actually, use the other component",
      imageCount: 0,
    })
  })

  it("delivers TWO steers into one live turn", async () => {
    // Finding 4 of tasks/chat-input-steering.md, in product form: a second
    // `streamInput()` call is silently discarded by the SDK, so the only
    // implementation that survives two quick corrections is one long-lived
    // channel. This is the regression most likely to slip past a unit test
    // that only ever pushes once.
    const received: DeliveredMessage[] = []
    const { turn, done, release } = await startLiveTurn("s-two", received)

    const first = await steer({ sessionId: "s-two", userMessage: "ALPHA" })
    const second = await steer({ sessionId: "s-two", userMessage: "BRAVO" })
    expect(first).toEqual({ status: 200, result: { accepted: true } })
    expect(second).toEqual({ status: 200, result: { accepted: true } })

    release()
    await done

    expect(received.map((m) => m.text)).toEqual(["start the work", "ALPHA", "BRAVO"])
    expect(turn.events().filter((e) => e.kind === "steered")).toHaveLength(2)
  })

  it("delivers a steer carrying an image", async () => {
    const TINY_PNG =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    const received: DeliveredMessage[] = []
    const { turn, done, release } = await startLiveTurn("s-img", received)

    const { status } = await steer({
      sessionId: "s-img",
      userMessage: "match this",
      images: [TINY_PNG],
    })
    expect(status).toBe(200)

    release()
    await done

    expect(received[1]).toEqual({ text: "match this", imageBlocks: 1 })
    expect(turn.events().find((e) => e.kind === "steered")).toMatchObject({
      imageCount: 1,
    })
  })

  it("409s once the turn has ended — the registry is released with the lock", async () => {
    const received: DeliveredMessage[] = []
    const { done, release } = await startLiveTurn("s-over", received)
    release()
    await done

    const { status, result } = await steer({ sessionId: "s-over", userMessage: "too late" })
    expect(status).toBe(409)
    expect(result).toEqual({ accepted: false, reason: "no-live-turn" })
    // Nothing was appended after the turn's own message.
    expect(received.map((m) => m.text)).toEqual(["start the work"])
  })

  it("does not deliver into a DIFFERENT session's live turn", async () => {
    const received: DeliveredMessage[] = []
    const { done, release } = await startLiveTurn("s-a", received)

    const { status } = await steer({ sessionId: "s-b", userMessage: "wrong thread" })
    expect(status).toBe(409)

    release()
    await done
    expect(received.map((m) => m.text)).toEqual(["start the work"])
  })

  it("accepts a steer in the turn's OPENING moments, before the runtime is reached", async () => {
    // The registration window. The channel used to be published from inside the
    // turn runtime, which the handler only reaches after session load, project
    // knowledge, web policy, Figma config and the concurrency-cap queue. For all
    // of that time the turn lock said "a turn is running" and the steer registry
    // said "nothing to steer", so this steer answered 409 — and the client's
    // fallback, submitting it as a new turn, would then 409 on the turn lock.
    //
    // `holdSetup` parks the fake loader exactly where those awaits sit.
    const received: DeliveredMessage[] = []
    let releaseSetup: () => void = () => {}
    const holdSetup = new Promise<void>((resolve) => {
      releaseSetup = resolve
    })
    const { done, release, started } = await startLiveTurn("s-window", received, {
      beforeStart: holdSetup,
    })

    const { status, result } = await steer({
      sessionId: "s-window",
      userMessage: "wait, use the other component",
    })
    expect(status).toBe(200)
    expect(result).toEqual({ accepted: true })

    releaseSetup()
    await started
    release()
    await done

    // Delivered AFTER the opening prompt, not instead of it: the agent must be
    // given the work before the correction to it.
    expect(received.map((m) => m.text)).toEqual([
      "start the work",
      "wait, use the other component",
    ])
  })

  it("reports a steer for resubmission when the turn dies before it ever starts", async () => {
    // The other half of owning the channel from lock time: the paths that never
    // reach the turn runtime can now be holding a message the user typed. Here
    // the setup throws; the handler's finally is the only thing that can hand
    // the message back, and `resubmit_required` is how it does.
    const received: DeliveredMessage[] = []
    let releaseSetup: () => void = () => {}
    const holdSetup = new Promise<void>((resolve) => {
      releaseSetup = resolve
    })
    const failingSetup = holdSetup.then(() => {
      throw new Error("setup blew up")
    })
    const { turn, done, release } = await startLiveTurn("s-died", received, {
      beforeStart: failingSetup,
    })

    const { status } = await steer({
      sessionId: "s-died",
      userMessage: "typed while it was starting",
    })
    expect(status).toBe(200)

    releaseSetup()
    release()
    await done

    // Nothing ever pulled it out of the channel, so it is definitively
    // undelivered — and the user must get it back rather than lose it.
    expect(turn.events().filter((e) => e.kind === "resubmit_required")).toEqual([
      {
        kind: "resubmit_required",
        sessionId: "s-died",
        userMessage: "typed while it was starting",
      },
    ])
    expect(received).toEqual([])
  })

  /**
   * Loaders whose turn runtime parks and then THROWS, so the handler's outer
   * catch builds its recovery turn. That arm is the one path that reaches
   * `failed` without the runtime having appended a turn, so it constructs a
   * `ChatTurn` from the REQUEST body — which is why anything typed after the
   * request has to be carried in explicitly.
   */
  function makeThrowingLoaders(opts: {
    sessionId: string
    saved: Array<import("../../../../src/editor/agent-chat/types").ChatSession>
    finish: Promise<void>
    onStarted: () => void
  }): ChatHandlerLoaders {
    return {
      loadRunChatTurnNeutral: async () => ({
        runChatTurnNeutral: async () => {
          throw new Error("this suite's turns run on the SDK loader, not neutral")
        },
      }),
      loadSessionStore: async () => {
        const { makeEmptySession } = await import(
          "../../../../src/editor/agent-chat/types.js"
        )
        return {
          loadSession: async () => ({
            session: makeEmptySession("p", opts.sessionId),
            fresh: true,
          }),
          saveSession: async (
            _root: string,
            session: import("../../../../src/editor/agent-chat/types").ChatSession,
          ) => {
            opts.saved.push(JSON.parse(JSON.stringify(session)))
            return session
          },
        } as unknown as Awaited<ReturnType<ChatHandlerLoaders["loadSessionStore"]>>
      },
      loadRunChatTurnSdk: async () =>
        ({
          runChatTurnSdk: async (callOpts: {
            emit: (
              ev: import("../../../../src/editor/agent-chat/chat-stream-events").ChatStreamEvent,
            ) => void
          }) => {
            callOpts.emit({ kind: "turn_start", turnId: "t-recover" })
            opts.onStarted()
            await opts.finish
            throw new Error("orchestrator boom")
          },
        }) as unknown as Awaited<ReturnType<ChatHandlerLoaders["loadRunChatTurnSdk"]>>,
    }
  }

  it("keeps an accepted steer on the recovery turn when the runtime throws", async () => {
    // The recovery turn used to be built from `body.userMessage` alone. A steer
    // the route had already answered `accepted: true` therefore vanished from
    // the transcript on exactly the failures where the user most needs to see
    // what they sent — the same non-negotiable as delivery loss, one layer down
    // in persistence.
    const saved: Array<import("../../../../src/editor/agent-chat/types").ChatSession> = []
    let release: () => void = () => {}
    const finish = new Promise<void>((resolve) => {
      release = resolve
    })
    let signalStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve
    })

    const turn = makeMockReqRes()
    turn.setBody({ userMessage: "start the work", sessionId: "s-recover" })
    const done = handleChatRequest(turn.req, turn.res, {
      repoRoot,
      loaders: makeThrowingLoaders({
        sessionId: "s-recover",
        saved,
        finish,
        onStarted: () => signalStarted(),
      }),
    })
    await Promise.race([started, done])

    const { status } = await steer({
      sessionId: "s-recover",
      userMessage: "ALSO check the lockfile",
    })
    expect(status).toBe(200)

    release()
    await done

    const recovered = saved[saved.length - 1]
    expect(recovered.status).toBe("failed")
    const recoveredTurn = recovered.turns[recovered.turns.length - 1]
    expect(recoveredTurn.userMessage).toBe("start the work")
    expect(recoveredTurn.steers).toEqual([
      // Position 0 is the only honest answer: a recovery turn has no assistant
      // blocks to sit between.
      { text: "ALSO check the lockfile", afterAssistantBlocks: 0 },
    ])
  })

  it("omits `steers` from a recovery turn that took none", async () => {
    // Absent, not empty. A turn that was never steered has to serialize exactly
    // as it did before the field existed.
    const saved: Array<import("../../../../src/editor/agent-chat/types").ChatSession> = []
    let release: () => void = () => {}
    const finish = new Promise<void>((resolve) => {
      release = resolve
    })
    let signalStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve
    })

    const turn = makeMockReqRes()
    turn.setBody({ userMessage: "start the work", sessionId: "s-recover-clean" })
    const done = handleChatRequest(turn.req, turn.res, {
      repoRoot,
      loaders: makeThrowingLoaders({
        sessionId: "s-recover-clean",
        saved,
        finish,
        onStarted: () => signalStarted(),
      }),
    })
    await Promise.race([started, done])
    release()
    await done

    const recovered = saved[saved.length - 1]
    const recoveredTurn = recovered.turns[recovered.turns.length - 1]
    expect(recoveredTurn.steers).toBeUndefined()
    expect("steers" in recoveredTurn).toBe(false)
  })
})

/**
 * The steer route must be gated exactly as `POST /api/editor/chat` is —
 * bearer token AND strict Origin. Asserted against a real booted server rather
 * than by inspecting the route table, because the posture is only worth
 * anything if the listener actually enforces it.
 */
describe("POST /api/editor/chat/steer — auth + Origin", () => {
  let handle: HttpServerHandle
  let bundleDir: string
  let repoDir: string
  let token: string
  let shellOrigin: string

  beforeEach(async () => {
    bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-steer-bundle-"))
    await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>t</title>")
    repoDir = await mkdtemp(join(tmpdir(), "editor-cli-steer-repo-"))
    const port = await pickFreePort()
    shellOrigin = `http://127.0.0.1:${port}`
    const security = newSecurityContext(shellOrigin)
    token = security.token
    handle = await startHttpServer({
      host: "127.0.0.1",
      port,
      repoRoot: repoDir,
      uiBundleRoot: bundleDir,
      viteUrl: "http://localhost:5173",
      security,
    })
  })

  afterEach(async () => {
    await handle.close()
    await rm(bundleDir, { recursive: true, force: true })
    await rm(repoDir, { recursive: true, force: true })
  })

  function post(headers: Record<string, string>): Promise<Response> {
    return fetch(`${handle.url}/api/editor/chat/steer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ sessionId: "s-auth", userMessage: "hi" }),
    })
  }

  it("401s without a bearer token", async () => {
    const res = await post({ Origin: shellOrigin })
    expect(res.status).toBe(401)
  })

  it("403s on a foreign Origin even with a valid token", async () => {
    const res = await post({
      Origin: "http://evil.test",
      Authorization: `Bearer ${token}`,
    })
    expect(res.status).toBe(403)
  })

  it("403s when the Origin header is absent (browsers send it on POSTs)", async () => {
    const res = await post({ Authorization: `Bearer ${token}` })
    expect(res.status).toBe(403)
  })

  it("reaches the handler with a valid token AND the shell Origin", async () => {
    const res = await post({
      Origin: shellOrigin,
      Authorization: `Bearer ${token}`,
    })
    // 409 is the guard PASSING: no turn is running in this fresh server, which
    // is the handler's own answer rather than the gate's.
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ accepted: false, reason: "no-live-turn" })
  })
})

describe("the both-ends gate, from the route", () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "desde-chat-neutral-gate-"))
    __resetPendingBridgeRequestsForTest()
    __resetActiveTurnsForTest()
  })
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
    __resetPendingBridgeRequestsForTest()
    __resetActiveTurnsForTest()
  })

  /**
   * A loader set with its own spies, so a case can assert which loader ran
   * and what the turn function itself was called with (in particular
   * `providerId`).
   */
  function makeGateLoaders() {
    const runTurnSpy = vi.fn(async (_opts: { providerId?: string }) => {
      const { makeEmptySession } = await import(
        "../../../../src/editor/agent-chat/types.js"
      )
      return {
        session: makeEmptySession("test-proj"),
        turn: {
          id: "test-turn",
          startedAt: "x",
          userMessage: "ignored",
          assistantContent: [],
          toolResults: {},
          editProposals: [],
        },
      }
    })
    const loadRunChatTurnSdk = vi.fn(async () => ({ runChatTurnSdk: runTurnSpy }))
    const loadRunChatTurnNeutral = vi.fn(async () => ({ runChatTurnNeutral: runTurnSpy }))
    const loaders: ChatHandlerLoaders = {
      loadRunChatTurnSdk: loadRunChatTurnSdk as unknown as ChatHandlerLoaders["loadRunChatTurnSdk"],
      loadRunChatTurnNeutral: loadRunChatTurnNeutral as unknown as ChatHandlerLoaders["loadRunChatTurnNeutral"],
      loadSessionStore: async () => {
        const { makeEmptySession } = await import(
          "../../../../src/editor/agent-chat/types.js"
        )
        return {
          loadSession: async () => ({ session: makeEmptySession("test-proj"), fresh: true }),
          saveSession: async (_root: string, session: unknown) => session,
        } as unknown as Awaited<ReturnType<ChatHandlerLoaders["loadSessionStore"]>>
      },
    }
    return { loaders, loadRunChatTurnSdk, loadRunChatTurnNeutral, runTurnSpy }
  }

  // An `openai` `modelConfig` is refused before it ever reaches
  // `resolveChatRuntime`: the catalog resolver does not serve the OpenAI
  // group while `EDITOR_NEUTRAL_CHAT` is off (`chatRuntimeServable` in
  // `model-catalog-source.ts`), so the request 400s at model-config
  // validation with the catalog's own "Unknown provider" message. That is
  // the CLIENT half of the gate, proven in
  // `http-server-neutral-chat-gate.integration.test.ts`. The only path that
  // reaches the dispatch's OWN refusal — the SERVER half, which must not
  // depend on catalog validation having run first — is the dev override,
  // which reroutes an Anthropic session (always servable) onto the neutral
  // runtime kind. That is what these cases use to reach it directly.
  it("refuses an anthropic session forced onto the neutral runtime while the surface is dormant", async () => {
    const { loaders, loadRunChatTurnNeutral, loadRunChatTurnSdk } = makeGateLoaders()
    vi.stubEnv("EDITOR_CHAT_RUNTIME_OVERRIDE", "neutral")
    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "hi", modelConfig: { provider: "anthropic", model: "claude-opus-4-8" } })
    await handleChatRequest(mock.req, mock.res, { repoRoot, loaders })
    const error = mock.events().find((e) => e.kind === "error")
    expect(error?.reason).toMatch(/neutral chat runtime is dormant/i)
    expect(loadRunChatTurnNeutral).not.toHaveBeenCalled()
    expect(loadRunChatTurnSdk).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })

  it("names the config key and the env var so a stale client learns what to flip", async () => {
    const { loaders } = makeGateLoaders()
    vi.stubEnv("EDITOR_CHAT_RUNTIME_OVERRIDE", "neutral")
    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "hi", modelConfig: { provider: "anthropic", model: "claude-opus-4-8" } })
    await handleChatRequest(mock.req, mock.res, { repoRoot, loaders })
    const reason = mock.events().find((e) => e.kind === "error")?.reason as string
    expect(reason).toContain('"neutralChat": true')
    expect(reason).toContain("EDITOR_NEUTRAL_CHAT=1")
    vi.unstubAllEnvs()
  })

  it("dispatches to the neutral runtime once the surface is on", async () => {
    const { loaders, loadRunChatTurnNeutral } = makeGateLoaders()
    vi.stubEnv("EDITOR_NEUTRAL_CHAT", "1")
    vi.stubEnv("OPENAI_API_KEY", "sk-openai-test-key")
    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "hi", modelConfig: { provider: "openai", model: "gpt-5.6" } })
    await handleChatRequest(mock.req, mock.res, { repoRoot, loaders })
    expect(loadRunChatTurnNeutral).toHaveBeenCalled()
    vi.unstubAllEnvs()
  })

  it("passes the session's own provider id into the turn", async () => {
    const { loaders, runTurnSpy } = makeGateLoaders()
    vi.stubEnv("EDITOR_NEUTRAL_CHAT", "1")
    vi.stubEnv("OPENAI_API_KEY", "sk-openai-test-key")
    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "hi", modelConfig: { provider: "openai", model: "gpt-5.6" } })
    await handleChatRequest(mock.req, mock.res, { repoRoot, loaders })
    expect(runTurnSpy.mock.calls[0][0]).toMatchObject({ providerId: "openai" })
    vi.unstubAllEnvs()
  })

  it("still dispatches an anthropic session to the SDK runtime with the surface on", async () => {
    const { loaders, loadRunChatTurnSdk } = makeGateLoaders()
    vi.stubEnv("EDITOR_NEUTRAL_CHAT", "1")
    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "hi", modelConfig: { provider: "anthropic", model: "claude-opus-4-8" } })
    await handleChatRequest(mock.req, mock.res, { repoRoot, loaders })
    expect(loadRunChatTurnSdk).toHaveBeenCalled()
    vi.unstubAllEnvs()
  })

  it("checks the credentials of the provider the session actually names", async () => {
    const { loaders } = makeGateLoaders()
    vi.stubEnv("EDITOR_NEUTRAL_CHAT", "1")
    vi.stubEnv("OPENAI_API_KEY", "")
    const mock = makeMockReqRes()
    mock.setBody({ userMessage: "hi", modelConfig: { provider: "openai", model: "gpt-5.6" } })
    await handleChatRequest(mock.req, mock.res, { repoRoot, loaders })
    const error = mock.events().find((e) => e.kind === "error")
    expect(error?.reason).toMatch(/OpenAI/)
    vi.unstubAllEnvs()
  })
})
