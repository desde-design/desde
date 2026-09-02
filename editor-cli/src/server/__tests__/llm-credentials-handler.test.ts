import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { IncomingMessage, ServerResponse } from "node:http"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  handleLlmCredentialsRoute,
  validateAnthropicKey,
} from "../llm-credentials-handler.js"
import { readLlmCredentials, writeLlmApiKey } from "../llm-credential-store.js"

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "llm-cred-h-"))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

/** Minimal ServerResponse double capturing what the handler wrote. */
function fakeRes() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    setHeader(k: string, v: string) {
      this.headers[k] = v
    },
    end(chunk?: string) {
      this.body = chunk ?? ""
    },
  }
}

const req = (method: string) => ({ method }) as IncomingMessage
const asRes = (r: ReturnType<typeof fakeRes>) => r as unknown as ServerResponse
const okFetch = () => vi.fn(async () => new Response("{}", { status: 200 }))
const url = (path = "/api/editor/llm-credentials") => new URL(`http://x${path}`)

/**
 * Fills the status fields a case does not care about, so assertions stay
 * EXACT (`toEqual`) rather than loosening to `toMatchObject` and letting a
 * future shape change slip through unnoticed.
 */
function statusOf(overrides: Record<string, unknown>) {
  return { hasStoredKey: false, promptDismissed: false, ...overrides }
}

describe("GET /api/editor/llm-credentials", () => {
  it("reports the stored source with a masked hint and never the key", async () => {
    await writeLlmApiKey("sk-ant-supersecret9999", home)
    const res = fakeRes()
    await handleLlmCredentialsRoute(req("GET"), asRes(res), url(), {
      home,
      env: {},
      claudeRuntimeResolvable: false,
      fetchImpl: okFetch(),
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual(
      statusOf({
        source: "stored",
        maskedHint: "sk-ant-…9999",
        storedHint: "sk-ant-…9999",
        devMode: false,
        hasStoredKey: true,
      }),
    )
    expect(res.body).not.toContain("supersecret")
  })

  it("reports source none when nothing is configured", async () => {
    const res = fakeRes()
    await handleLlmCredentialsRoute(req("GET"), asRes(res), url(), {
      home,
      env: {},
      claudeRuntimeResolvable: false,
      fetchImpl: okFetch(),
    })
    expect(JSON.parse(res.body)).toEqual(
      statusOf({ source: "none", devMode: false }),
    )
  })

  it("reports the env source without exposing the env key", async () => {
    const res = fakeRes()
    await handleLlmCredentialsRoute(req("GET"), asRes(res), url(), {
      home,
      env: { ANTHROPIC_API_KEY: "sk-ant-fromtheshell1111" },
      // `inherited` is what makes this the SHELL's key. A value in `env`
      // alone no longer implies that: boot injects stored keys there too, and
      // conflating the two is what reported every stored key as `env`.
      inherited: { apiKey: "sk-ant-fromtheshell1111" },
      claudeRuntimeResolvable: false,
      fetchImpl: okFetch(),
    })
    expect(JSON.parse(res.body)).toEqual(
      statusOf({ source: "env", maskedHint: "sk-ant-…1111", devMode: false }),
    )
    expect(res.body).not.toContain("fromtheshell")
  })
})

describe("validateAnthropicKey", () => {
  it("accepts a key the API answers 200 for", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }))
    expect(await validateAnthropicKey("sk-ant-good", f)).toEqual({ ok: true })
    const [target, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(target)).toContain("api.anthropic.com")
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant-good")
  })

  it("rejects a key the API answers 401 for", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 401 }))
    expect((await validateAnthropicKey("sk-ant-bad", f)).ok).toBe(false)
  })

  it("rejects rather than accepts when the network fails", async () => {
    const f = vi.fn(async () => {
      throw new Error("ENOTFOUND")
    })
    // Fail closed: an unreachable API must not let an unverified key persist.
    expect((await validateAnthropicKey("sk-ant-any", f)).ok).toBe(false)
  })
})

describe("PUT /api/editor/llm-credentials", () => {
  it("refuses to persist a key the API rejects", async () => {
    const res = fakeRes()
    await handleLlmCredentialsRoute(req("PUT"), asRes(res), url(), {
      home,
      env: {},
      claudeRuntimeResolvable: false,
      fetchImpl: vi.fn(async () => new Response("{}", { status: 401 })),
      readBody: async () => ({ apiKey: "sk-ant-bad" }),
    })
    expect(res.statusCode).toBe(400)
    expect(await readLlmCredentials(home)).toEqual({ devMode: false })
  })

  it("rejects an empty key without calling the API", async () => {
    const f = okFetch()
    const res = fakeRes()
    await handleLlmCredentialsRoute(req("PUT"), asRes(res), url(), {
      home,
      env: {},
      claudeRuntimeResolvable: false,
      fetchImpl: f,
      readBody: async () => ({ apiKey: "   " }),
    })
    expect(res.statusCode).toBe(400)
    expect(f).not.toHaveBeenCalled()
  })

  it("persists and injects a valid key", async () => {
    const env: NodeJS.ProcessEnv = {}
    const res = fakeRes()
    await handleLlmCredentialsRoute(req("PUT"), asRes(res), url(), {
      home,
      env,
      claudeRuntimeResolvable: false,
      fetchImpl: okFetch(),
      readBody: async () => ({ apiKey: "sk-ant-good1234" }),
    })
    expect(res.statusCode).toBe(200)
    expect((await readLlmCredentials(home)).apiKey).toBe("sk-ant-good1234")
    // Injected live so the next turn works without restarting the CLI.
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-good1234")
  })
})

describe("DELETE and dev-mode", () => {
  it("clears the key and removes it from the environment", async () => {
    await writeLlmApiKey("sk-ant-good1234", home)
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-ant-good1234" }
    const res = fakeRes()
    await handleLlmCredentialsRoute(req("DELETE"), asRes(res), url(), {
      home,
      env,
      claudeRuntimeResolvable: false,
      fetchImpl: okFetch(),
    })
    expect(res.statusCode).toBe(200)
    expect((await readLlmCredentials(home)).apiKey).toBeUndefined()
    expect("ANTHROPIC_API_KEY" in env).toBe(false)
  })

  it("enabling dev mode deletes the env key and sets the flag", async () => {
    await writeLlmApiKey("sk-ant-good1234", home)
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-ant-good1234" }
    const res = fakeRes()
    await handleLlmCredentialsRoute(
      req("PUT"),
      asRes(res),
      url("/api/editor/llm-credentials/dev-mode"),
      {
        home,
        env,
        claudeRuntimeResolvable: false,
        fetchImpl: okFetch(),
        readBody: async () => ({ devMode: true }),
      },
    )
    expect(res.statusCode).toBe(200)
    expect((await readLlmCredentials(home)).devMode).toBe(true)
    expect("ANTHROPIC_API_KEY" in env).toBe(false)
    expect(env.EDITOR_USE_CLAUDE_SUBSCRIPTION).toBe("1")
  })

  it("disabling dev mode restores the stored key to the environment", async () => {
    await writeLlmApiKey("sk-ant-good1234", home)
    const env: NodeJS.ProcessEnv = { EDITOR_USE_CLAUDE_SUBSCRIPTION: "1" }
    const res = fakeRes()
    await handleLlmCredentialsRoute(
      req("PUT"),
      asRes(res),
      url("/api/editor/llm-credentials/dev-mode"),
      {
        home,
        env,
        claudeRuntimeResolvable: false,
        fetchImpl: okFetch(),
        readBody: async () => ({ devMode: false }),
      },
    )
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-good1234")
    expect(env.EDITOR_USE_CLAUDE_SUBSCRIPTION).toBeUndefined()
  })

  it("rejects a non-boolean devMode", async () => {
    const res = fakeRes()
    await handleLlmCredentialsRoute(
      req("PUT"),
      asRes(res),
      url("/api/editor/llm-credentials/dev-mode"),
      {
        home,
        env: {},
        claudeRuntimeResolvable: false,
        fetchImpl: okFetch(),
        readBody: async () => ({ devMode: "yes" }),
      },
    )
    expect(res.statusCode).toBe(400)
  })

  it("answers 405 for an unsupported method", async () => {
    const res = fakeRes()
    await handleLlmCredentialsRoute(req("POST"), asRes(res), url(), {
      home,
      env: {},
      claudeRuntimeResolvable: false,
      fetchImpl: okFetch(),
    })
    expect(res.statusCode).toBe(405)
  })
})

/**
 * Codex review, P1 "Preserve stored-key ownership in status".
 *
 * The original tests could not catch this: they passed an isolated `env: {}`
 * that boot injection had never touched. In production `applyLlmCredentials-
 * AtBoot` copies the stored key into the SAME `process.env` the probe read,
 * so the env rung fired first and every stored key reported as `env` — which
 * makes the dialog hide Replace and Remove, leaving the user unable to manage
 * the key they had just saved.
 */
describe("stored keys stay owned by the app after injection", () => {
  it("reports `stored`, not `env`, when the env value is our own injection", async () => {
    await writeLlmApiKey("sk-ant-stored9999", home)
    // Exactly the production shape: boot already injected the stored key.
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-ant-stored9999" }
    const res = fakeRes()
    await handleLlmCredentialsRoute(req("GET"), asRes(res), url(), {
      home,
      env,
      inherited: {}, // the shell exported nothing
      claudeRuntimeResolvable: true,
      fetchImpl: okFetch(),
    })
    expect(JSON.parse(res.body)).toEqual(
      statusOf({
        source: "stored",
        maskedHint: "sk-ant-…9999",
        storedHint: "sk-ant-…9999",
        devMode: false,
        hasStoredKey: true,
      }),
    )
  })

  it("still reports `env` when the shell really did export a key", async () => {
    await writeLlmApiKey("sk-ant-stored9999", home)
    const res = fakeRes()
    await handleLlmCredentialsRoute(req("GET"), asRes(res), url(), {
      home,
      env: { ANTHROPIC_API_KEY: "sk-ant-exported1111" },
      inherited: { apiKey: "sk-ant-exported1111" },
      claudeRuntimeResolvable: true,
      fetchImpl: okFetch(),
    })
    // A stored key exists too, and stays reported and manageable even though
    // the exported one is what is in use.
    expect(JSON.parse(res.body)).toEqual(
      statusOf({
        source: "env",
        maskedHint: "sk-ant-…1111",
        storedHint: "sk-ant-…9999",
        devMode: false,
        hasStoredKey: true,
      }),
    )
  })

  it("keeps reporting `stored` right after a save", async () => {
    const env: NodeJS.ProcessEnv = {}
    const res = fakeRes()
    await handleLlmCredentialsRoute(req("PUT"), asRes(res), url(), {
      home,
      env,
      inherited: {},
      claudeRuntimeResolvable: true,
      fetchImpl: okFetch(),
      readBody: async () => ({ apiKey: "sk-ant-fresh4321" }),
    })
    // The save injected into `env`; the response must not now call it `env`.
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-fresh4321")
    expect(JSON.parse(res.body)).toEqual(
      statusOf({
        source: "stored",
        maskedHint: "sk-ant-…4321",
        storedHint: "sk-ant-…4321",
        devMode: false,
        hasStoredKey: true,
      }),
    )
  })

  it("restores an exported key to the environment when dev mode is turned off", async () => {
    const inherited = { apiKey: "sk-ant-exported1111" }
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-ant-exported1111" }
    const devUrl = url("/api/editor/llm-credentials/dev-mode")

    await handleLlmCredentialsRoute(req("PUT"), asRes(fakeRes()), devUrl, {
      home,
      env,
      inherited,
      claudeRuntimeResolvable: true,
      fetchImpl: okFetch(),
      readBody: async () => ({ devMode: true }),
    })
    expect("ANTHROPIC_API_KEY" in env).toBe(false)

    await handleLlmCredentialsRoute(req("PUT"), asRes(fakeRes()), devUrl, {
      home,
      env,
      inherited,
      claudeRuntimeResolvable: true,
      fetchImpl: okFetch(),
      readBody: async () => ({ devMode: false }),
    })
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-exported1111")
  })
})

/** Codex review P2: dismissal is machine-level, not browser-scoped. */
describe("PUT /api/editor/llm-credentials/dismiss-prompt", () => {
  it("persists the dismissal and reports it back", async () => {
    const res = fakeRes()
    await handleLlmCredentialsRoute(
      req("PUT"),
      asRes(res),
      url("/api/editor/llm-credentials/dismiss-prompt"),
      {
        home,
        env: {},
        inherited: {},
        claudeRuntimeResolvable: false,
        fetchImpl: okFetch(),
        readBody: async () => ({ dismissed: true }),
      },
    )
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).promptDismissed).toBe(true)
  })

  it("survives a later key write", async () => {
    await handleLlmCredentialsRoute(
      req("PUT"),
      asRes(fakeRes()),
      url("/api/editor/llm-credentials/dismiss-prompt"),
      {
        home,
        env: {},
        inherited: {},
        claudeRuntimeResolvable: false,
        fetchImpl: okFetch(),
        readBody: async () => ({ dismissed: true }),
      },
    )
    const res = fakeRes()
    await handleLlmCredentialsRoute(req("PUT"), asRes(res), url(), {
      home,
      env: {},
      inherited: {},
      claudeRuntimeResolvable: false,
      fetchImpl: okFetch(),
      readBody: async () => ({ apiKey: "sk-ant-good1234" }),
    })
    expect(JSON.parse(res.body).promptDismissed).toBe(true)
  })

  it("rejects a non-boolean value", async () => {
    const res = fakeRes()
    await handleLlmCredentialsRoute(
      req("PUT"),
      asRes(res),
      url("/api/editor/llm-credentials/dismiss-prompt"),
      {
        home,
        env: {},
        inherited: {},
        claudeRuntimeResolvable: false,
        fetchImpl: okFetch(),
        readBody: async () => ({ dismissed: "yes" }),
      },
    )
    expect(res.statusCode).toBe(400)
  })
})

/**
 * Codex review P1: the credential file is machine-wide but each editor
 * process injects at its own boot, so a change made in one open project left
 * another's `process.env` stale. The GET converges it.
 */
describe("GET re-applies the store to this process's environment", () => {
  it("picks up a key another process stored", async () => {
    await writeLlmApiKey("sk-ant-fromelsewhere", home)
    const env: NodeJS.ProcessEnv = {} // this process booted before that write
    await handleLlmCredentialsRoute(req("GET"), asRes(fakeRes()), url(), {
      home,
      env,
      inherited: {},
      claudeRuntimeResolvable: false,
      fetchImpl: okFetch(),
    })
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-fromelsewhere")
  })

  it("drops a key another process removed", async () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-ant-stale" }
    await handleLlmCredentialsRoute(req("GET"), asRes(fakeRes()), url(), {
      home,
      env,
      inherited: {},
      claudeRuntimeResolvable: false,
      fetchImpl: okFetch(),
    })
    expect("ANTHROPIC_API_KEY" in env).toBe(false)
  })
})
