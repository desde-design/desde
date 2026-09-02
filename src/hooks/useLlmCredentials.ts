"use client"

/**
 * Client state for the Anthropic credential surface.
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

export interface LlmCredentialsStatus {
  /** Which credential is ACTIVE right now. */
  source: CredentialSource
  /** Masked form of the active credential, when it is a key. */
  maskedHint?: string
  devMode: boolean
  /**
   * Whether a key sits in the app's store, independent of `source`. Dev mode
   * makes `source` `subscription` even with a key stored behind it, so the
   * Remove control keys off this rather than the active source.
   */
  hasStoredKey: boolean
  /** Masked form of the STORED key, whether or not it is active. */
  storedHint?: string
  /** First-run dismissal, held machine-level rather than in localStorage. */
  promptDismissed: boolean
}

const ROUTE = "/api/editor/llm-credentials"

export interface UseLlmCredentials {
  status: LlmCredentialsStatus | null
  loading: boolean
  error: string | null
  saveKey: (apiKey: string) => Promise<boolean>
  removeKey: () => Promise<boolean>
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
      setStatus((await res.json()) as LlmCredentialsStatus)
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
        const json = (await res.json()) as Record<string, unknown>
        if (!res.ok) {
          setError((json.error as string) ?? `Request failed (${res.status}).`)
          return false
        }
        setStatus(json as unknown as LlmCredentialsStatus)
        return true
      } catch (err) {
        setError((err as Error).message)
        return false
      }
    },
    [],
  )

  const saveKey = useCallback(
    (apiKey: string) => mutate(ROUTE, "PUT", { apiKey }),
    [mutate],
  )
  const removeKey = useCallback(() => mutate(ROUTE, "DELETE"), [mutate])
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
