"use client"

/**
 * Client for `/api/editor/capabilities`.
 *
 * Enabling posts a catalog **id** and nothing else — the server looks the spec
 * up in source. There is deliberately no way to express a command or a host
 * from here.
 */

import { useCallback, useEffect, useState } from "react"
import { editorFetch } from "@/lib/editor-fetch"

export interface CapabilityRow {
  id: string
  label: string
  summary: string
  target: "mcp-extension" | "web-fetch-host" | "web-search"
  activation: "next-message" | "cli-restart"
  /**
   * Env var the capability needs, or null.
   *
   * The value never travels in THIS direction — the server sends the name so
   * the panel knows which key to ask for, and `envReady` for whether one is
   * already there. A saved key is never read back.
   */
  requiresEnv: string | null
  /** A key for this is saved on this machine. */
  secretStored: boolean
  /** A key is set in the environment by someone else; ours would not win. */
  secretFromEnvironment: boolean
  enabled: boolean
  /** False ⇒ turn it on by editing config; there is no button for it. */
  enableable: boolean
  /** False ⇒ declared but inert until a key is supplied. */
  envReady: boolean
}

export interface CapabilitiesState {
  capabilities: CapabilityRow[] | null
  /** Servers the user hand-wrote that we have no catalog entry for. */
  unknownExtensions: string[]
  /** `.mcp.json` is malformed — the panel must SAY so, not render empty. */
  configError: string | null
  warnings: string[]
  busyId: string | null
  error: string | null
  refresh: () => Promise<void>
  enable: (id: string) => Promise<{ ok: boolean; envMissing?: string | null }>
  /**
   * Save (or clear, with `null`) the key an extension needs.
   *
   * One-way by construction. There is no getter for a saved value and no
   * route that would return one, so the panel can say "a key is saved" and
   * can never show it.
   */
  saveSecret: (name: string, value: string | null) => Promise<{ ok: boolean; reason?: string }>
}

interface ApiShape {
  ok?: boolean
  reason?: string
  capabilities?: CapabilityRow[]
  unknownExtensions?: string[]
  configError?: string | null
  warnings?: string[]
  envMissing?: string | null
}

export function useEditorCapabilities(enabled: boolean): CapabilitiesState {
  const [capabilities, setCapabilities] = useState<CapabilityRow[] | null>(null)
  const [unknownExtensions, setUnknown] = useState<string[]>([])
  const [configError, setConfigError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const res = await editorFetch("/api/editor/capabilities")
      const json = (await res.json().catch(() => ({}))) as ApiShape
      // A 200 says the request succeeded, not that the body has the shape we
      // read — a catch-all route or a proxy produces the same status. Validate
      // before dereferencing, and route a malformed body to the same quiet
      // path as a failed one.
      if (!res.ok || !Array.isArray(json.capabilities)) {
        setError(json.reason ?? "Couldn't load capabilities.")
        setCapabilities([])
        return
      }
      setCapabilities(json.capabilities)
      setUnknown(Array.isArray(json.unknownExtensions) ? json.unknownExtensions : [])
      setConfigError(typeof json.configError === "string" ? json.configError : null)
      setWarnings(Array.isArray(json.warnings) ? json.warnings : [])
    } catch (err) {
      setError((err as Error).message)
      setCapabilities([])
    }
  }, [])

  const enable = useCallback(
    async (id: string): Promise<{ ok: boolean; envMissing?: string | null }> => {
      setBusyId(id)
      setError(null)
      try {
        const res = await editorFetch("/api/editor/capabilities/enable", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ capabilityId: id }),
        })
        const json = (await res.json().catch(() => ({}))) as ApiShape
        if (!res.ok || json.ok !== true) {
          setError(json.reason ?? "Couldn't enable that capability.")
          return { ok: false }
        }
        await refresh()
        return { ok: true, envMissing: json.envMissing ?? null }
      } catch (err) {
        setError((err as Error).message)
        return { ok: false }
      } finally {
        setBusyId(null)
      }
    },
    [refresh],
  )

  const saveSecret = useCallback(
    async (name: string, value: string | null): Promise<{ ok: boolean; reason?: string }> => {
      try {
        const res = await editorFetch("/api/editor/capabilities/secret", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, value }),
        })
        const json = (await res.json().catch(() => ({}))) as ApiShape
        if (!res.ok || json.ok !== true) {
          return { ok: false, reason: json.reason ?? "Couldn't save that key." }
        }
        // The server injects the key into its own env on the way through, so
        // a refresh here is what turns the card from "Needs setup" to
        // "Active" without a restart.
        await refresh()
        return { ok: true }
      } catch (err) {
        return { ok: false, reason: (err as Error).message }
      }
    },
    [refresh],
  )

  useEffect(() => {
    if (enabled) void refresh()
  }, [enabled, refresh])

  return {
    capabilities,
    unknownExtensions,
    configError,
    warnings,
    busyId,
    error,
    refresh,
    enable,
    saveSecret,
  }
}
