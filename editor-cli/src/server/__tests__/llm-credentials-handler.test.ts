import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { IncomingMessage, ServerResponse } from "node:http"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { handleLlmCredentialsRoute, providerIdFromPath } from "../llm-credentials-handler.js"
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

describe("GET /api/editor/llm-credentials", () => {
  it("answers one entry per descriptor, in registration order", async () => {
    await writeLlmApiKey("anthropic", "sk-ant-supersecret9999", home)
    await writeLlmApiKey("openai", "sk-proj-othersecret1234", home)
    const res = fakeRes()
    await handleLlmCredentialsRoute(req("GET"), asRes(res), url(), {
      home,
      env: {},
      claudeRuntimeResolvable: false,
      fetchImpl: okFetch(),
    })
    const body = JSON.parse(res.body) as { providers: Record<string, Record<string, unknown>>; devMode: boolean }
    expect(Object.keys(body.providers)).toEqual(["anthropic", "openai"])
    expect(body.providers.anthropic).toEqual({
      id: "anthropic",
      label: "Anthropic",
      source: "stored",
      maskedHint: "sk-ant-…9999",
      hasStoredKey: true,
      storedHint: "sk-ant-…9999",
      apiKeyEnvVar: "ANTHROPIC_API_KEY",
      consoleUrl: "https://console.anthropic.com/settings/keys",
      maskPrefix: "sk-ant-",
      hasSubscriptionRuntime: true,
    })
    expect(body.providers.openai).toMatchObject({
      source: "stored",
      storedHint: "sk-…1234",
      apiKeyEnvVar: "OPENAI_API_KEY",
      baseUrlEnvVar: "OPENAI_BASE_URL",
      hasSubscriptionRuntime: false,
    })
    expect(body.devMode).toBe(false)
    expect(res.body).not.toContain("supersecret")
    expect(res.body).not.toContain("othersecret")
  })

  it("reports each provider independently when only one is configured", async () => {
    await writeLlmApiKey("openai", "sk-only1234", home)
    const res = fakeRes()
    await handleLlmCredentialsRoute(req("GET"), asRes(res), url(), {
      home,
      env: {},
      claudeRuntimeResolvable: false,
      fetchImpl: okFetch(),
    })
    const body = JSON.parse(res.body) as { providers: Record<string, Record<string, unknown>>; devMode: boolean }
    expect(body.providers.anthropic.source).toBe("none")
    expect(body.providers.openai.source).toBe("stored")
  })

  it("reports the env source without exposing the env key", async () => {
    const res = fakeRes()
    await handleLlmCredentialsRoute(req("GET"), asRes(res), url(), {
      home,
      env: { ANTHROPIC_API_KEY: "sk-ant-fromtheshell1111" },
      // `inherited` is what makes this the SHELL's key. A value in `env`
      // alone no longer implies that: boot injects stored keys there too, and
      // conflating the two is what reported every stored key as `env`.
      inherited: { vars: { ANTHROPIC_API_KEY: "sk-ant-fromtheshell1111" } },
      claudeRuntimeResolvable: false,
      fetchImpl: okFetch(),
    })
    const body = JSON.parse(res.body) as { providers: Record<string, Record<string, unknown>>; devMode: boolean }
    expect(body.providers.anthropic).toMatchObject({
      source: "env",
      maskedHint: "sk-ant-…1111",
    })
    expect(res.body).not.toContain("fromtheshell")
  })
})

describe("PUT /api/editor/llm-credentials/:providerId", () => {
  it("validates against the named provider and persists into its slot", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }))
    const res = fakeRes()
    await handleLlmCredentialsRoute(
      req("PUT"),
      asRes(res),
      url("/api/editor/llm-credentials/openai"),
      {
        home,
        env: {},
        claudeRuntimeResolvable: false,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        readBody: async () => ({ apiKey: "sk-new1234", baseUrl: "https://gateway.internal" }),
      },
    )
    expect(res.statusCode).toBe(200)
    expect((fetchImpl.mock.calls[0] as unknown[] | undefined)?.[0]).toBe("https://gateway.internal/v1/models")
    expect((await readLlmCredentials(home)).providers.openai).toEqual({
      apiKey: "sk-new1234",
      baseUrl: "https://gateway.internal",
    })
  })

  it("refuses to persist a key the provider rejects", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 401 }))
    const res = fakeRes()
    await handleLlmCredentialsRoute(
      req("PUT"),
      asRes(res),
      url("/api/editor/llm-credentials/openai"),
      {
        home,
        env: {},
        claudeRuntimeResolvable: false,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        readBody: async () => ({ apiKey: "sk-bad" }),
      },
    )
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe("OpenAI rejected that key.")
    expect((await readLlmCredentials(home)).providers.openai).toBeUndefined()
  })

  it("rejects an empty key without calling the provider", async () => {
    const f = okFetch()
    const res = fakeRes()
    await handleLlmCredentialsRoute(
      req("PUT"),
      asRes(res),
      url("/api/editor/llm-credentials/anthropic"),
      {
        home,
        env: {},
        claudeRuntimeResolvable: false,
        fetchImpl: f,
        readBody: async () => ({ apiKey: "   " }),
      },
    )
    expect(res.statusCode).toBe(400)
    expect(f).not.toHaveBeenCalled()
  })

  it("persists and injects a valid key", async () => {
    const env: NodeJS.ProcessEnv = {}
    const res = fakeRes()
    await handleLlmCredentialsRoute(
      req("PUT"),
      asRes(res),
      url("/api/editor/llm-credentials/anthropic"),
      {
        home,
        env,
        claudeRuntimeResolvable: false,
        fetchImpl: okFetch(),
        readBody: async () => ({ apiKey: "sk-ant-good1234" }),
      },
    )
    expect(res.statusCode).toBe(200)
    expect((await readLlmCredentials(home)).providers.anthropic?.apiKey).toBe("sk-ant-good1234")
    // Injected live so the next turn works without restarting the CLI.
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-good1234")
  })

  it("404s an unregistered provider id", async () => {
    const res = fakeRes()
    await handleLlmCredentialsRoute(
      req("PUT"),
      asRes(res),
      url("/api/editor/llm-credentials/moonshot"),
      { home, env: {}, claudeRuntimeResolvable: false, readBody: async () => ({ apiKey: "x" }) },
    )
    expect(res.statusCode).toBe(404)
  })

  it("refuses a base URL for a provider that has no base-URL variable", async () => {
    const res = fakeRes()
    await handleLlmCredentialsRoute(
      req("PUT"),
      asRes(res),
      url("/api/editor/llm-credentials/anthropic"),
      {
        home,
        env: {},
        claudeRuntimeResolvable: false,
        fetchImpl: okFetch(),
        readBody: async () => ({ apiKey: "sk-ant-x", baseUrl: "https://nope.internal" }),
      },
    )
    expect(res.statusCode).toBe(400)
  })

  it("DELETE clears only the named provider's key", async () => {
    await writeLlmApiKey("anthropic", "sk-ant-keep", home)
    await writeLlmApiKey("openai", "sk-drop", home)
    const res = fakeRes()
    await handleLlmCredentialsRoute(
      req("DELETE"),
      asRes(res),
      url("/api/editor/llm-credentials/openai"),
      { home, env: {}, claudeRuntimeResolvable: false },
    )
    expect(res.statusCode).toBe(200)
    const stored = await readLlmCredentials(home)
    expect(stored.providers.anthropic).toEqual({ apiKey: "sk-ant-keep" })
    expect(stored.providers.openai).toEqual({})
  })

  it("clears the key and removes it from the environment", async () => {
    await writeLlmApiKey("anthropic", "sk-ant-good1234", home)
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-ant-good1234" }
    const res = fakeRes()
    await handleLlmCredentialsRoute(
      req("DELETE"),
      asRes(res),
      url("/api/editor/llm-credentials/anthropic"),
      {
        home,
        env,
        claudeRuntimeResolvable: false,
        fetchImpl: okFetch(),
      },
    )
    expect(res.statusCode).toBe(200)
    expect((await readLlmCredentials(home)).providers.anthropic?.apiKey).toBeUndefined()
    expect("ANTHROPIC_API_KEY" in env).toBe(false)
  })
})

describe("providerIdFromPath", () => {
  it("reads a single trailing segment and refuses the reserved names", () => {
    expect(providerIdFromPath("/api/editor/llm-credentials/openai")).toBe("openai")
    expect(providerIdFromPath("/api/editor/llm-credentials/dev-mode")).toBeNull()
    expect(providerIdFromPath("/api/editor/llm-credentials/dismiss-prompt")).toBeNull()
    expect(providerIdFromPath("/api/editor/llm-credentials")).toBeNull()
    expect(providerIdFromPath("/api/editor/llm-credentials/a/b")).toBeNull()
  })
})

describe("dev-mode", () => {
  it("enabling dev mode deletes the env key and sets the flag", async () => {
    await writeLlmApiKey("anthropic", "sk-ant-good1234", home)
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
    await writeLlmApiKey("anthropic", "sk-ant-good1234", home)
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

  it("answers 405 for an unsupported method on the base route", async () => {
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
    await writeLlmApiKey("anthropic", "sk-ant-stored9999", home)
    // Exactly the production shape: boot already injected the stored key.
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-ant-stored9999" }
    const res = fakeRes()
    await handleLlmCredentialsRoute(req("GET"), asRes(res), url(), {
      home,
      env,
      inherited: { vars: {} }, // the shell exported nothing
      claudeRuntimeResolvable: true,
      fetchImpl: okFetch(),
    })
    const body = JSON.parse(res.body) as { providers: Record<string, Record<string, unknown>>; devMode: boolean }
    expect(body.providers.anthropic).toMatchObject({
      source: "stored",
      maskedHint: "sk-ant-…9999",
      storedHint: "sk-ant-…9999",
      hasStoredKey: true,
    })
  })

  it("still reports `env` when the shell really did export a key", async () => {
    await writeLlmApiKey("anthropic", "sk-ant-stored9999", home)
    const res = fakeRes()
    await handleLlmCredentialsRoute(req("GET"), asRes(res), url(), {
      home,
      env: { ANTHROPIC_API_KEY: "sk-ant-exported1111" },
      inherited: { vars: { ANTHROPIC_API_KEY: "sk-ant-exported1111" } },
      claudeRuntimeResolvable: true,
      fetchImpl: okFetch(),
    })
    // A stored key exists too, and stays reported and manageable even though
    // the exported one is what is in use.
    const body = JSON.parse(res.body) as { providers: Record<string, Record<string, unknown>>; devMode: boolean }
    expect(body.providers.anthropic).toMatchObject({
      source: "env",
      maskedHint: "sk-ant-…1111",
      storedHint: "sk-ant-…9999",
      hasStoredKey: true,
    })
  })

  it("keeps reporting `stored` right after a save", async () => {
    const env: NodeJS.ProcessEnv = {}
    const res = fakeRes()
    await handleLlmCredentialsRoute(
      req("PUT"),
      asRes(res),
      url("/api/editor/llm-credentials/anthropic"),
      {
        home,
        env,
        inherited: { vars: {} },
        claudeRuntimeResolvable: true,
        fetchImpl: okFetch(),
        readBody: async () => ({ apiKey: "sk-ant-fresh4321" }),
      },
    )
    // The save injected into `env`; the response must not now call it `env`.
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-fresh4321")
    const body = JSON.parse(res.body) as { providers: Record<string, Record<string, unknown>>; devMode: boolean }
    expect(body.providers.anthropic).toMatchObject({
      source: "stored",
      maskedHint: "sk-ant-…4321",
      storedHint: "sk-ant-…4321",
      hasStoredKey: true,
    })
  })

  it("restores an exported key to the environment when dev mode is turned off", async () => {
    const inherited = { vars: { ANTHROPIC_API_KEY: "sk-ant-exported1111" } }
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
        inherited: { vars: {} },
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
        inherited: { vars: {} },
        claudeRuntimeResolvable: false,
        fetchImpl: okFetch(),
        readBody: async () => ({ dismissed: true }),
      },
    )
    const res = fakeRes()
    await handleLlmCredentialsRoute(
      req("PUT"),
      asRes(res),
      url("/api/editor/llm-credentials/anthropic"),
      {
        home,
        env: {},
        inherited: { vars: {} },
        claudeRuntimeResolvable: false,
        fetchImpl: okFetch(),
        readBody: async () => ({ apiKey: "sk-ant-good1234" }),
      },
    )
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
        inherited: { vars: {} },
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
    await writeLlmApiKey("anthropic", "sk-ant-fromelsewhere", home)
    const env: NodeJS.ProcessEnv = {} // this process booted before that write
    await handleLlmCredentialsRoute(req("GET"), asRes(fakeRes()), url(), {
      home,
      env,
      inherited: { vars: {} },
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
      inherited: { vars: {} },
      claudeRuntimeResolvable: false,
      fetchImpl: okFetch(),
    })
    expect("ANTHROPIC_API_KEY" in env).toBe(false)
  })
})
