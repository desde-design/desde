import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { newSecurityContext } from "../auth.js"
import { modelCatalogResolver, setModelCatalogLiveSourcesForTests } from "../model-catalog-source.js"

/**
 * The sidecar dispatch, asserted against the real world.
 *
 * Task 26 folded the old opt-OUT neutral-chat gate into the product's only
 * chat runtime: every provider now dispatches to the neutral loop unless
 * Anthropic is BOTH opted into the Claude-subscription sidecar
 * (`EDITOR_USE_CLAUDE_SUBSCRIPTION=1`) AND keyless — see
 * `resolveChatRuntimeKind` in `chat-runtime-dispatch.ts`. There is no
 * "neutral chat off" case left to prove here; the two cases worth an
 * end-to-end HTTP test are the ones a mocked loader can't stand in for,
 * because they depend on real modules this suite deliberately does NOT
 * mock:
 *
 *  - No key and no subscription opt-in: `assertChatCredentials` refuses
 *    before dispatch, with the same message the settings dialog shows
 *    (`chatCredentialsMessage`).
 *  - Subscription opt-in with no key, but no `claude` binary on `PATH`:
 *    dispatch resolves to the sidecar, the REAL sidecar module loads (this
 *    suite does not stub `loadRunChatTurnSidecar`), and its own
 *    `resolveClaudeOnPath()` call — reading the live `process.env.PATH` —
 *    finds nothing and fails with `SIDECAR_NO_BINARY_MESSAGE`.
 *
 * Neither of these travels as a literal HTTP 4xx: `POST /api/editor/chat`
 * opens the SSE stream (200, `text/event-stream`) before either check runs,
 * so the refusal rides an `error` event in the body instead of the status
 * line — same as every other chat-turn refusal in this handler.
 */

let handle: HttpServerHandle
let bundleDir: string
let repoDir: string
let token: string
let shellOrigin: string

// This suite boots the real HTTP server. Without a stub, an `anthropic`
// `modelConfig` sends `modelCatalogResolver.get()` down the `api` or `cli`
// branch, which would try to reach the real Anthropic Models API (or spawn
// a real `claude` binary) and only give up after the resolver's own
// timeout. A unit suite must never touch the network: it is slow, flaky
// offline, and logs a fallback error on every run.
beforeAll(() => {
  setModelCatalogLiveSourcesForTests({
    listViaApi: { anthropic: async () => [], openai: async () => [] },
    listViaCli: async () => [],
  })
})
afterAll(() => setModelCatalogLiveSourcesForTests(null))

beforeEach(async () => {
  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")
  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-repo-"))

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

  delete process.env.ANTHROPIC_API_KEY
  delete process.env.EDITOR_USE_CLAUDE_SUBSCRIPTION
})

afterEach(async () => {
  await handle.close()
  await rm(bundleDir, { recursive: true, force: true })
  await rm(repoDir, { recursive: true, force: true })
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.EDITOR_USE_CLAUDE_SUBSCRIPTION
  modelCatalogResolver.invalidate()
})

async function pickFreePort(): Promise<number> {
  const net = await import("node:net")
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      server.close(() => resolve(port))
    })
  })
}

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${token}` }
}

/** Reads an SSE response body to completion and returns it as text. */
async function readSse(res: Response): Promise<string> {
  return await res.text()
}

async function postAnthropicChat(): Promise<Response> {
  return fetch(`${handle.url}/api/editor/chat`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
      Origin: shellOrigin,
    },
    body: JSON.stringify({
      userMessage: "hello",
      modelConfig: { provider: "anthropic", model: "claude-opus-4-8" },
    }),
  })
}

describe("POST /api/editor/chat — the sidecar gate", () => {
  it("refuses with the credentials message when no key and no subscription opt-in are configured", async () => {
    // Neither ANTHROPIC_API_KEY nor EDITOR_USE_CLAUDE_SUBSCRIPTION is set
    // (cleared in beforeEach), so Anthropic is uncredentialed and
    // `assertChatCredentials` refuses before dispatch ever resolves a lane.
    const res = await postAnthropicChat()
    const body = await readSse(res)
    // The same copy `chatCredentialsMessage` gives the settings dialog.
    expect(body).toContain("Chat needs an Anthropic API key for this model")
    expect(body).toContain("settings gear")
    // Names the escape hatch too, since the descriptor has a subscription
    // runtime.
    expect(body).toContain("EDITOR_USE_CLAUDE_SUBSCRIPTION")
    // Refused before any turn ran: no assistant text, no turn id.
    expect(body).not.toContain('"kind":"assistant_delta"')
  })

  it("refuses with SIDECAR_NO_BINARY_MESSAGE when opted in but no claude binary is on PATH", async () => {
    // Opted into the subscription with no key: `assertChatCredentials`
    // passes (the subscription runtime counts as credentialed) and
    // `resolveChatRuntimeKind` sends this turn to the sidecar. The REAL
    // sidecar module loads (this suite does not stub `loadRunChatTurnSidecar`)
    // and its own `resolveClaudeOnPath()` reads `process.env.PATH` — emptied
    // here so it can find nothing, exactly as a machine with no Claude Code
    // install would.
    process.env.EDITOR_USE_CLAUDE_SUBSCRIPTION = "1"
    const previousPath = process.env.PATH
    process.env.PATH = ""
    try {
      const res = await postAnthropicChat()
      const body = await readSse(res)
      expect(body).toContain(
        "The Claude subscription path needs the claude command line tool on your PATH",
      )
      expect(body).not.toContain('"kind":"assistant_delta"')
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
  })
})
