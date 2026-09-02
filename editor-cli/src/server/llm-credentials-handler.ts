import type { IncomingMessage, ServerResponse } from "node:http"
import { homedir } from "node:os"
import {
  maskKey,
  probeCredential,
  type CredentialSource,
} from "../../../src/editor/llm-providers/credential-probe.js"
import { isClaudeSubscriptionOptIn } from "../../../src/editor/llm-providers/registry.js"
import { applyLlmCredentialsToEnv } from "./apply-llm-credentials.js"
import { inheritedLlmEnv, type InheritedLlmEnv } from "./inherited-llm-env.js"
import { readJsonBody } from "./http-body.js"
import {
  clearLlmApiKey,
  readLlmCredentials,
  readPromptDismissed,
  setLlmDevMode,
  setPromptDismissed,
  writeLlmApiKey,
} from "./llm-credential-store.js"

/**
 * `/api/editor/llm-credentials` — the Anthropic API key surface.
 *
 * Served by the CLI rather than through Electron IPC on purpose: the desktop
 * app loads the CLI's own URL, so one implementation covers both the packaged
 * app and a terminal user in a browser tab. An IPC-only surface would leave
 * terminal users with nothing, which is half the gap this work closes.
 *
 * **The full key never appears in a response.** GET returns the source, a
 * masked hint, and the dev-mode flag. There is deliberately no read-back
 * route: a stored key is write-only from the client's point of view.
 */

export const LLM_CREDENTIALS_ROUTE = "/api/editor/llm-credentials"
export const LLM_CREDENTIALS_DEV_MODE_ROUTE = `${LLM_CREDENTIALS_ROUTE}/dev-mode`
export const LLM_CREDENTIALS_DISMISS_ROUTE = `${LLM_CREDENTIALS_ROUTE}/dismiss-prompt`

const ANTHROPIC_VALIDATE_URL = "https://api.anthropic.com/v1/models?limit=1"
const ANTHROPIC_VERSION = "2023-06-01"
const VALIDATE_TIMEOUT_MS = 10_000

export interface LlmCredentialsStatus {
  /** Which credential is ACTIVE right now. */
  source: CredentialSource
  /** Masked form of the active credential, when it is a key. */
  maskedHint?: string
  devMode: boolean
  /**
   * Whether a key sits in the app's own store, independent of `source`.
   *
   * Needed because `source` answers "what is in use", and dev mode makes that
   * `subscription` even while a stored key waits behind it. Gating the Remove
   * control on `source === "stored"` therefore stranded that key: it could be
   * neither seen nor removed until dev mode was switched off, contradicting
   * the spec's §5, which requires key management to stay available in dev
   * mode.
   */
  hasStoredKey: boolean
  /** Masked form of the STORED key, whether or not it is the active one. */
  storedHint?: string
  /** First-run prompt dismissal, held machine-level. See the store. */
  promptDismissed: boolean
}

export interface LlmCredentialsDeps {
  home?: string
  /** Mutated on write so a new key takes effect without a CLI restart. */
  env?: NodeJS.ProcessEnv
  claudeRuntimeResolvable?: boolean
  /** Launch-time baseline. Defaults to the module-level capture. */
  inherited?: InheritedLlmEnv
  fetchImpl?: typeof fetch
  readBody?: (req: IncomingMessage) => Promise<Record<string, unknown>>
}

/**
 * Validate against the cheapest authenticated endpoint Anthropic exposes.
 * `/v1/models` is a GET, consumes no tokens, and answers 401 for a bad key.
 *
 * **Fails closed.** A network error rejects rather than accepts. Persisting an
 * unverified key would recreate exactly the failure this validation exists to
 * prevent: a user who believes they are configured and is not.
 */
export async function validateAnthropicKey(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const res = await fetchImpl(ANTHROPIC_VALIDATE_URL, {
      method: "GET",
      headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
      signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
    })
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: "Anthropic rejected that key." }
    }
    if (!res.ok) {
      return { ok: false, reason: `Anthropic answered ${res.status}. Try again.` }
    }
    return { ok: true }
  } catch {
    return {
      ok: false,
      reason: "Could not reach Anthropic to check the key. Check your connection.",
    }
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(body))
}

async function buildStatus(
  home: string,
  inherited: InheritedLlmEnv,
  claudeRuntimeResolvable: boolean,
): Promise<LlmCredentialsStatus> {
  const stored = await readLlmCredentials(home)
  // `inherited.apiKey`, NOT `process.env.ANTHROPIC_API_KEY`: boot copies a
  // stored key into that variable, so probing it live reported every stored
  // key as externally managed and disabled the controls that manage it.
  const probe = probeCredential({
    inheritedApiKey: inherited.apiKey,
    stored,
    claudeRuntimeResolvable,
    // Either opt-in is sufficient, and they come from different places: dev
    // mode is a stored setting behind the dialog's hidden toggle, the env var
    // is what a terminal user exports. Without one of them a resolvable
    // `claude` runtime no longer counts as a credential, so the first-run
    // dialog asks for an API key instead of the product quietly running on
    // whatever subscription the binary happens to hold.
    subscriptionOptIn: stored.devMode || isClaudeSubscriptionOptIn(process.env),
  })
  const storedKey = stored.apiKey?.trim()
  return {
    source: probe.credentialed ? probe.source : "none",
    ...("maskedHint" in probe ? { maskedHint: probe.maskedHint } : {}),
    devMode: stored.devMode,
    hasStoredKey: Boolean(storedKey),
    ...(storedKey ? { storedHint: maskKey(storedKey) } : {}),
    promptDismissed: await readPromptDismissed(home),
  }
}

/**
 * Re-apply the store to the live environment after a mutation, so a new key
 * works on the next turn without restarting the CLI.
 *
 * `applyLlmCredentialsToEnv` resets to the inherited baseline itself, so this
 * needs no clearing of its own — and must not do any, or it would delete an
 * exported key permanently.
 */
async function reapplyEnv(
  home: string,
  env: NodeJS.ProcessEnv,
  inherited: InheritedLlmEnv,
): Promise<void> {
  applyLlmCredentialsToEnv(await readLlmCredentials(home), env, inherited)
}

export async function handleLlmCredentialsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: LlmCredentialsDeps = {},
): Promise<void> {
  const home = deps.home ?? homedir()
  const env = deps.env ?? process.env
  const runtimeResolvable = deps.claudeRuntimeResolvable ?? false
  const inherited = deps.inherited ?? inheritedLlmEnv()
  const readBody =
    deps.readBody ??
    ((r: IncomingMessage) => readJsonBody<Record<string, unknown>>(r))

  try {
    if (url.pathname === LLM_CREDENTIALS_DEV_MODE_ROUTE) {
      if (req.method !== "PUT") {
        sendJson(res, 405, { error: "Method not allowed." })
        return
      }
      const body = await readBody(req)
      if (typeof body.devMode !== "boolean") {
        sendJson(res, 400, { error: "`devMode` must be a boolean." })
        return
      }
      await setLlmDevMode(body.devMode, home)
      await reapplyEnv(home, env, inherited)
      sendJson(res, 200, await buildStatus(home, inherited, runtimeResolvable))
      return
    }

    if (url.pathname === LLM_CREDENTIALS_DISMISS_ROUTE) {
      if (req.method !== "PUT") {
        sendJson(res, 405, { error: "Method not allowed." })
        return
      }
      const body = await readBody(req)
      if (typeof body.dismissed !== "boolean") {
        sendJson(res, 400, { error: "`dismissed` must be a boolean." })
        return
      }
      await setPromptDismissed(body.dismissed, home)
      sendJson(res, 200, await buildStatus(home, inherited, runtimeResolvable))
      return
    }

    if (url.pathname !== LLM_CREDENTIALS_ROUTE) {
      sendJson(res, 404, { error: "Not found." })
      return
    }

    if (req.method === "GET") {
      // Re-apply on read, not only on write. The credential file is
      // machine-wide but each editor process injects at its own boot, so a
      // change made in one open project leaves another's `process.env` stale.
      // Every UI mount issues this GET, so converging here makes a second
      // editor pick the change up on its next load rather than at restart.
      // Residual, accepted: a process whose UI is never reloaded stays stale.
      await reapplyEnv(home, env, inherited)
      sendJson(res, 200, await buildStatus(home, inherited, runtimeResolvable))
      return
    }

    if (req.method === "PUT") {
      const body = await readBody(req)
      const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : ""
      if (!apiKey) {
        sendJson(res, 400, { error: "`apiKey` must be a non-empty string." })
        return
      }
      const validation = await validateAnthropicKey(apiKey, deps.fetchImpl ?? fetch)
      if (!validation.ok) {
        sendJson(res, 400, { error: validation.reason })
        return
      }
      await writeLlmApiKey(apiKey, home)
      await reapplyEnv(home, env, inherited)
      sendJson(res, 200, await buildStatus(home, inherited, runtimeResolvable))
      return
    }

    if (req.method === "DELETE") {
      await clearLlmApiKey(home)
      await reapplyEnv(home, env, inherited)
      sendJson(res, 200, await buildStatus(home, inherited, runtimeResolvable))
      return
    }

    sendJson(res, 405, { error: "Method not allowed." })
  } catch (err) {
    // Never leak a key through an error path — the store and validator both
    // keep the value out of their messages, so only the message is echoed.
    sendJson(res, 500, { error: (err as Error).message })
  }
}
