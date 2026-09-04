"use client"

/**
 * Client state for the multi-provider LLM credential surface.
 *
 * The hook NEVER holds a full key in state. `saveKey` passes the value
 * straight to the server and keeps only the masked status that comes back, so
 * a React DevTools inspection or an error boundary's state dump cannot leak
 * it.
 *
 * The status shape is re-declared here rather than imported from
 * `editor-cli/src/server/llm-credentials-handler.ts`: this module ships in the
 * browser bundle, and the handler imports `node:fs` transitively. The two
 * shapes must stay identical, which the handler's GET tests and this hook's
 * tests both pin.
 */

import { useCallback, useEffect, useState } from "react"

export type CredentialSource = "subscription" | "env" | "stored" | "none"

export interface ProviderCredentialStatus {
  id: string
  label: string
  /** Which credential is ACTIVE for this provider right now. */
  source: CredentialSource
  /** Masked form of the active credential, when it is a key. */
  maskedHint?: string
  /**
   * Whether a key sits in the app's store, independent of `source`. Dev mode
   * makes `source` `subscription` even with a key stored behind it, so the
   * Remove control keys off this rather than the active source.
   */
  hasStoredKey: boolean
  /** Masked form of the STORED key, whether or not it is active. */
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
  /** One entry per provider the server serves, in its registration order. */
  providers: Record<string, ProviderCredentialStatus>
  /** Global; Anthropic-only in meaning. */
  devMode: boolean
  /** First-run dismissal, held machine-level rather than in localStorage. */
  promptDismissed: boolean
}

/**
 * The server's status shape, checked at the boundary. A CLI older than this
 * UI (or the self-host harness, whose mock backend answers unlisted routes
 * with `{ ok: true }`) returns something else, and the old hook simply read
 * `undefined` off it. The map-shaped status would throw instead, in render,
 * on every page. Checking here turns that into `error` and a null status.
 */
const CREDENTIAL_SOURCES: readonly CredentialSource[] = ["subscription", "env", "stored", "none"]

/** Every row must carry a real source and the required strings, or the whole status is rejected. */
function isProviderCredentialStatus(value: unknown): value is ProviderCredentialStatus {
  if (typeof value !== "object" || value === null) return false
  const p = value as Record<string, unknown>
  if (
    typeof p.id !== "string" ||
    typeof p.label !== "string" ||
    typeof p.apiKeyEnvVar !== "string" ||
    typeof p.consoleUrl !== "string" ||
    typeof p.maskPrefix !== "string"
  ) {
    return false
  }
  if (!CREDENTIAL_SOURCES.includes(p.source as CredentialSource)) return false
  if (typeof p.hasStoredKey !== "boolean" || typeof p.hasSubscriptionRuntime !== "boolean") {
    return false
  }
  for (const key of ["maskedHint", "storedHint", "baseUrl", "baseUrlEnvVar"] as const) {
    if (p[key] !== undefined && typeof p[key] !== "string") return false
  }
  return true
}

export function isLlmCredentialsStatus(value: unknown): value is LlmCredentialsStatus {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  if (
    typeof v.providers !== "object" ||
    v.providers === null ||
    Array.isArray(v.providers) ||
    typeof v.devMode !== "boolean" ||
    typeof v.promptDismissed !== "boolean"
  ) {
    return false
  }
  return Object.values(v.providers as Record<string, unknown>).every(isProviderCredentialStatus)
}

/**
 * The single boolean the settings dot and the first-run prompt both need.
 *
 * Defined once because two definitions is how "Anthropic is unconfigured" and
 * "nothing is configured" drift apart, and the first of those would ask a
 * working OpenAI user for a key they do not need. `null` (not yet loaded) and
 * a status this shape check does not recognise both report false, so nothing
 * flashes on load or throws on a stale server's answer.
 */
export function everyProviderUncredentialed(
  status: LlmCredentialsStatus | null,
): boolean {
  if (status === null || !isLlmCredentialsStatus(status)) return false
  return Object.values(status.providers).every((p) => p.source === "none")
}

const ROUTE = "/api/editor/llm-credentials"

export interface UseLlmCredentials {
  status: LlmCredentialsStatus | null
  loading: boolean
  error: string | null
  saveKey: (providerId: string, apiKey: string, baseUrl?: string) => Promise<boolean>
  removeKey: (providerId: string) => Promise<boolean>
  setDevMode: (value: boolean) => Promise<boolean>
  dismissPrompt: () => Promise<boolean>
  refresh: () => Promise<void>
}

export function useLlmCredentials(): UseLlmCredentials {
  const [status, setStatus] = useState<LlmCredentialsStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(ROUTE)
      if (!res.ok) throw new Error(`Status request failed (${res.status}).`)
      const json: unknown = await res.json()
      if (!isLlmCredentialsStatus(json)) {
        throw new Error(
          "The credentials status had an unexpected shape. Restart the editor after updating.",
        )
      }
      setStatus(json)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /**
   * Shared mutation path. Returns a boolean rather than throwing so callers
   * can keep a dialog open on failure without a try/catch at every call site.
   */
  const mutate = useCallback(
    async (path: string, method: string, body?: unknown): Promise<boolean> => {
      setError(null)
      try {
        const res = await fetch(path, {
          method,
          headers: body ? { "Content-Type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        })
        const json: unknown = await res.json()
        const record = (typeof json === "object" && json !== null ? json : {}) as Record<
          string,
          unknown
        >
        if (!res.ok) {
          setError((record.error as string) ?? `Request failed (${res.status}).`)
          return false
        }
        if (!isLlmCredentialsStatus(json)) {
          setError(
            "The credentials status had an unexpected shape. Restart the editor after updating.",
          )
          return false
        }
        setStatus(json)
        return true
      } catch (err) {
        setError((err as Error).message)
        return false
      }
    },
    [],
  )

  const saveKey = useCallback(
    (providerId: string, apiKey: string, baseUrl?: string) =>
      mutate(`${ROUTE}/${encodeURIComponent(providerId)}`, "PUT", {
        apiKey,
        // Forward `baseUrl` whenever the caller passed a string, INCLUDING
        // "": that is how a cleared field reaches the server as "clear the
        // stored value" rather than "leave it as it was". Only an actually
        // `undefined` argument (the field was never touched) omits it.
        ...(baseUrl !== undefined ? { baseUrl } : {}),
      }),
    [mutate],
  )
  const removeKey = useCallback(
    (providerId: string) =>
      mutate(`${ROUTE}/${encodeURIComponent(providerId)}`, "DELETE"),
    [mutate],
  )
  const setDevMode = useCallback(
    (value: boolean) => mutate(`${ROUTE}/dev-mode`, "PUT", { devMode: value }),
    [mutate],
  )
  const dismissPrompt = useCallback(
    () => mutate(`${ROUTE}/dismiss-prompt`, "PUT", { dismissed: true }),
    [mutate],
  )

  return {
    status,
    loading,
    error,
    saveKey,
    removeKey,
    setDevMode,
    dismissPrompt,
    refresh,
  }
}
