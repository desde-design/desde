import type { IncomingMessage, ServerResponse } from "node:http"
import { homedir } from "node:os"
import {
  maskKey,
  probeCredential,
  type CredentialSource,
} from "../../../src/editor/llm-providers/credential-probe.js"
import { isClaudeSubscriptionOptIn } from "../../../src/editor/llm-providers/claude-subscription.js"
import {
  PROVIDER_DESCRIPTORS,
} from "../../../src/editor/llm-providers/provider-registry.js"
import type { ProviderDescriptor } from "../../../src/editor/llm-providers/provider-descriptor.js"
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
  writeLlmBaseUrl,
} from "./llm-credential-store.js"

/**
 * `/api/editor/llm-credentials` — the provider credential surface.
 *
 * Served by the CLI rather than through Electron IPC on purpose: the desktop
 * app loads the CLI's own URL, so one implementation covers both the packaged
 * app and a terminal user in a browser tab. An IPC-only surface would leave
 * terminal users with nothing, which is half the gap this work closes.
 *
 * **The full key never appears in a response.** GET returns, per provider,
 * the source, a masked hint, and the dev-mode flag. There is deliberately no
 * read-back route: a stored key is write-only from the client's point of
 * view.
 */

export const LLM_CREDENTIALS_ROUTE = "/api/editor/llm-credentials"
export const LLM_CREDENTIALS_DEV_MODE_ROUTE = `${LLM_CREDENTIALS_ROUTE}/dev-mode`
export const LLM_CREDENTIALS_DISMISS_ROUTE = `${LLM_CREDENTIALS_ROUTE}/dismiss-prompt`
export const LLM_CREDENTIALS_PROVIDER_ROUTE = `${LLM_CREDENTIALS_ROUTE}/:providerId`

/** Names that are sub-resources of the base route, not provider ids. */
const RESERVED_SEGMENTS = new Set(["dev-mode", "dismiss-prompt"])

/**
 * The provider id in `/api/editor/llm-credentials/<id>`, or null.
 *
 * Exported so `http-server.ts`'s route matcher and this handler decide
 * membership with the SAME function. Two copies of a path predicate is how a
 * route ends up registered for paths its handler refuses, or the reverse.
 */
export function providerIdFromPath(pathname: string): string | null {
  const prefix = `${LLM_CREDENTIALS_ROUTE}/`
  if (!pathname.startsWith(prefix)) return null
  const rest = pathname.slice(prefix.length)
  if (rest.length === 0 || rest.includes("/")) return null
  if (RESERVED_SEGMENTS.has(rest)) return null
  try {
    return decodeURIComponent(rest)
  } catch {
    return null
  }
}

export interface ProviderCredentialStatus {
  id: string
  label: string
  /** Which credential is ACTIVE for this provider right now. */
  source: CredentialSource
  maskedHint?: string
  /**
   * Whether a key sits in the app's own store, independent of `source`. Dev
   * mode makes Anthropic's source `subscription` even while a stored key waits
   * behind it, and gating Remove on the source stranded that key.
   */
  hasStoredKey: boolean
  storedHint?: string
  baseUrl?: string
  apiKeyEnvVar: string
  baseUrlEnvVar?: string
  consoleUrl: string
  maskPrefix: string
  /** Whether the dev-mode row belongs in this provider's tab. Anthropic only. */
  hasSubscriptionRuntime: boolean
}

export interface LlmCredentialsStatus {
  /**
   * One entry per descriptor, built in registration order. Insertion order
   * survives `JSON.stringify` and `JSON.parse` for non-numeric keys, so the
   * client can render tabs in this order without a second field.
   */
  providers: Record<string, ProviderCredentialStatus>
  /** Global; Anthropic-only in meaning. */
  devMode: boolean
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
  descriptors?: readonly ProviderDescriptor[]
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(body))
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

async function buildStatus(
  home: string,
  inherited: InheritedLlmEnv,
  claudeRuntimeResolvable: boolean,
  descriptors: readonly ProviderDescriptor[],
): Promise<LlmCredentialsStatus> {
  const stored = await readLlmCredentials(home)
  const subscriptionOptIn = stored.devMode || isClaudeSubscriptionOptIn(process.env)
  const providers: Record<string, ProviderCredentialStatus> = {}
  for (const d of descriptors) {
    // `inherited.vars[...]`, NOT `process.env[...]`: boot copies a stored key
    // into that variable, so probing it live reported every stored key as
    // externally managed and disabled the controls that manage it.
    const probe = probeCredential({
      descriptor: d,
      inheritedApiKey: inherited.vars[d.credentials.apiKeyEnvVar],
      stored,
      claudeRuntimeResolvable,
      subscriptionOptIn,
    })
    const slot = stored.providers[d.id]
    const storedKey = slot?.apiKey?.trim()
    providers[d.id] = {
      id: d.id,
      label: d.label,
      source: probe.credentialed ? probe.source : "none",
      ...("maskedHint" in probe ? { maskedHint: probe.maskedHint } : {}),
      hasStoredKey: Boolean(storedKey),
      ...(storedKey ? { storedHint: maskKey(storedKey, d.credentials.maskPrefix) } : {}),
      ...(slot?.baseUrl ? { baseUrl: slot.baseUrl } : {}),
      apiKeyEnvVar: d.credentials.apiKeyEnvVar,
      ...(d.credentials.baseUrlEnvVar ? { baseUrlEnvVar: d.credentials.baseUrlEnvVar } : {}),
      consoleUrl: d.credentials.consoleUrl,
      maskPrefix: d.credentials.maskPrefix,
      hasSubscriptionRuntime: d.credentials.hasSubscriptionRuntime === true,
    }
  }
  return {
    providers,
    devMode: stored.devMode,
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
  const descriptors = deps.descriptors ?? PROVIDER_DESCRIPTORS
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
      sendJson(res, 200, await buildStatus(home, inherited, runtimeResolvable, descriptors))
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
      sendJson(res, 200, await buildStatus(home, inherited, runtimeResolvable, descriptors))
      return
    }

    const providerId = providerIdFromPath(url.pathname)
    if (providerId !== null) {
      const descriptor = descriptors.find((d) => d.id === providerId)
      if (!descriptor) {
        sendJson(res, 404, { error: `Unknown provider '${providerId}'.` })
        return
      }
      if (req.method === "PUT") {
        const body = await readBody(req)
        const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : ""
        if (!apiKey) {
          sendJson(res, 400, { error: "`apiKey` must be a non-empty string." })
          return
        }
        let baseUrl: string | undefined
        if (body.baseUrl !== undefined && body.baseUrl !== "") {
          if (!descriptor.credentials.baseUrlEnvVar) {
            sendJson(res, 400, {
              error: `${descriptor.label} does not take a base URL.`,
            })
            return
          }
          if (typeof body.baseUrl !== "string" || !isHttpUrl(body.baseUrl)) {
            sendJson(res, 400, { error: "`baseUrl` must be an absolute http or https URL." })
            return
          }
          baseUrl = body.baseUrl.trim()
        }
        const validation = await descriptor.validateKey({
          apiKey,
          ...(baseUrl ? { baseUrl } : {}),
          fetchImpl: deps.fetchImpl ?? fetch,
        })
        if (!validation.ok) {
          sendJson(res, 400, { error: validation.message ?? "That key was not accepted." })
          return
        }
        await writeLlmApiKey(descriptor.id, apiKey, home)
        // Only touch the stored base URL when this request actually supplied
        // one (a real value to set, or "" to clear it). A key-only PUT
        // (`body.baseUrl === undefined`) must leave any previously stored
        // base URL alone, not wipe it via a local `baseUrl` that is
        // unconditionally undefined for this request.
        if (descriptor.credentials.baseUrlEnvVar && body.baseUrl !== undefined) {
          await writeLlmBaseUrl(descriptor.id, baseUrl, home)
        }
        await reapplyEnv(home, env, inherited)
        sendJson(res, 200, await buildStatus(home, inherited, runtimeResolvable, descriptors))
        return
      }
      if (req.method === "DELETE") {
        // The key only. A base URL is a routing choice, not a secret, and
        // dropping it on "Remove key" would silently re-point the next key at
        // the public endpoint.
        await clearLlmApiKey(descriptor.id, home)
        await reapplyEnv(home, env, inherited)
        sendJson(res, 200, await buildStatus(home, inherited, runtimeResolvable, descriptors))
        return
      }
      sendJson(res, 405, { error: "Method not allowed." })
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
      sendJson(res, 200, await buildStatus(home, inherited, runtimeResolvable, descriptors))
      return
    }

    sendJson(res, 405, { error: "Method not allowed." })
  } catch (err) {
    // Never leak a key through an error path — the store and validator both
    // keep the value out of their messages, so only the message is echoed.
    sendJson(res, 500, { error: (err as Error).message })
  }
}
