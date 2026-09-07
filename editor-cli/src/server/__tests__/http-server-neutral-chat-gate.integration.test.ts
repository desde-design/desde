import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { newSecurityContext } from "../auth.js"
import { modelCatalogResolver, setModelCatalogLiveSourcesForTests } from "../model-catalog-source.js"

/**
 * The both-ends gate, asserted against the real world.
 *
 * Task 40 flipped the neutral chat gate from opt-IN to opt-OUT: with no
 * configuration at all, `isNeutralChatEnabled` now answers true, so an
 * `openai` request is servable by default and reaches the dispatch. Every
 * case below that means to prove a REFUSAL therefore sets
 * `EDITOR_NEUTRAL_CHAT=0` explicitly — the gate still exists, it is just no
 * longer the default.
 *
 * How a request gets far enough to prove the SERVER half is the interesting
 * part. `modelCatalogResolver.get()` recomputes which descriptors are
 * servable from the LIVE flag value on every call, before it even looks at
 * the cache key, so an openai `modelConfig` is refused by catalog validation
 * the instant the flag is off, every time. That was checked directly against
 * the resolver (see this task's report) before this file was written this
 * way. So a `provider: "openai"` request, with the flag off, can only ever
 * exercise the CLIENT half; it never reaches `resolveChatRuntime`.
 *
 * The dispatch's OWN independent gate is only reachable through a path the
 * catalog check does not know about: `EDITOR_CHAT_RUNTIME_OVERRIDE=neutral`,
 * the dev-only knob that reroutes an Anthropic session onto the neutral
 * runtime so the neutral loop can be proven against Anthropic's API before
 * a second vendor ships. An Anthropic `modelConfig` passes catalog
 * validation regardless of the flag (Anthropic is always servable), so the
 * request reaches `resolveChatRuntime`. There, the override picks the
 * `neutral` runtime kind, and with `EDITOR_NEUTRAL_CHAT=0`, the dispatch
 * refuses on its own, with nothing upstream having refused first. That is
 * the real "gate at both ends" case: a request the client-side check let
 * through must still be refused server-side.
 */

let handle: HttpServerHandle
let bundleDir: string
let repoDir: string
let token: string
let shellOrigin: string

// This suite boots the real HTTP server and sets a fake Anthropic key so
// requests clear `assertChatCredentials`. Without a stub, that fake key
// sends `modelCatalogResolver.get()` down the `api` branch, which calls
// Anthropic's real Models API and only gives up after the resolver's 8s
// abort. A unit suite must never touch the network: it is slow, flaky
// offline, and logs a fallback error on every run.
beforeAll(() => {
  setModelCatalogLiveSourcesForTests({
    // Keyed per provider (not the legacy bare-function/Anthropic-only
    // shape) so a fake OpenAI key in this suite can never fall through to
    // the real `listOpenAiLiveModels` and reach the network.
    listViaApi: { anthropic: async () => [], openai: async () => [] }, // the static catalog is what this suite needs
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
  delete process.env.OPENAI_API_KEY
  delete process.env.EDITOR_NEUTRAL_CHAT
  delete process.env.EDITOR_CHAT_RUNTIME_OVERRIDE
})

afterEach(async () => {
  await handle.close()
  await rm(bundleDir, { recursive: true, force: true })
  await rm(repoDir, { recursive: true, force: true })
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.EDITOR_NEUTRAL_CHAT
  delete process.env.EDITOR_CHAT_RUNTIME_OVERRIDE
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

/** POSTs a chat turn naming the given provider, with a fake Anthropic key set. */
async function postChatNamingProvider(providerId: string): Promise<Response> {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-only"
  return fetch(`${handle.url}/api/editor/chat`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
      Origin: shellOrigin,
    },
    body: JSON.stringify({
      userMessage: "hello",
      modelConfig: { provider: providerId, model: "gpt-5.2" },
    }),
  })
}

describe("POST /api/editor/chat with a neutral provider", () => {
  it("never reaches the network for the model list", async () => {
    const realFetch = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (/anthropic\.com|openai\.com/.test(url)) calls.push(url)
      return realFetch(input, init)
    }) as typeof fetch
    try {
      await postChatNamingProvider("openai")
    } finally {
      globalThis.fetch = realFetch
    }
    expect(calls).toEqual([])
  })

  it("is refused server-side by the dispatch itself, naming the flag, even though the request named a servable provider", async () => {
    // Credentialed so the request clears `assertChatCredentials` and reaches
    // dispatch; a live Models API call with this fake key fails fast and
    // falls back to the static catalog (same pattern the OPENAI_API_KEY
    // fixture below relies on).
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-only"
    // The gate is opt-OUT by default now (Task 40), so proving the dispatch
    // still refuses requires turning it off explicitly.
    process.env.EDITOR_NEUTRAL_CHAT = "0"
    // Forces the neutral runtime kind for this Anthropic session.
    process.env.EDITOR_CHAT_RUNTIME_OVERRIDE = "neutral"

    const res = await fetch(`${handle.url}/api/editor/chat`, {
      method: "POST",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
        Origin: shellOrigin,
      },
      body: JSON.stringify({
        userMessage: "hello",
        modelConfig: { provider: "anthropic", model: "claude-haiku-4-5" },
      }),
    })
    const body = await readSse(res)
    expect(body).toContain("EDITOR_NEUTRAL_CHAT=0")
    // No config key to name: this gate is env-only, on purpose. See
    // `isNeutralChatEnabled`'s doc comment in `dormant-surfaces.ts`.
    // Refused before any turn ran: no assistant text, no turn id.
    expect(body).not.toContain('"kind":"assistant_delta"')
  })

  it("refuses with the catalog's own message when the gate is explicitly off and a request names an unservable provider", async () => {
    // The client half, for contrast: with the flag off, the OpenAI group is
    // never served, so `provider: "openai"` dies at catalog validation and
    // never reaches the dispatch at all.
    process.env.EDITOR_NEUTRAL_CHAT = "0"
    const res = await fetch(`${handle.url}/api/editor/chat`, {
      method: "POST",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
        Origin: shellOrigin,
      },
      body: JSON.stringify({
        userMessage: "hello",
        modelConfig: { provider: "openai", model: "gpt-5.2" },
      }),
    })
    expect(await readSse(res)).toContain("Unknown provider 'openai'")
  })

  it("accepts a request naming the OpenAI provider once it is credentialed", async () => {
    // The default this task shipped: absence means the neutral gate is ON,
    // so an OpenAI request is servable — but only once OpenAI is actually
    // credentialed (codex fix: an uncredentialed provider is not served at
    // all, so `provider: "openai"` with NO configuration 400s with "Unknown
    // provider", not "Unknown model" — see the case above this one). With a
    // key set, `gpt-5.2` itself is still not a real model id, so catalog
    // validation refuses it for THAT reason instead.
    process.env.OPENAI_API_KEY = "sk-openai-test-only"
    const res = await fetch(`${handle.url}/api/editor/chat`, {
      method: "POST",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
        Origin: shellOrigin,
      },
      body: JSON.stringify({
        userMessage: "hello",
        modelConfig: { provider: "openai", model: "gpt-5.2" },
      }),
    })
    const body = await readSse(res)
    expect(body).not.toContain("Unknown provider 'openai'")
    expect(body).toContain("Unknown model 'gpt-5.2'")
  })
})
