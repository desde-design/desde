"use client"

import { useEffect, useState } from "react"
import type { IconManifest, IconSetSource } from "@/editor/core"
import { editorFetch } from "@/lib/editor-fetch"

/**
 * Client-side shape of `GET /api/editor/icon-sets` — uniform across
 * the Next.js route and the editor-cli endpoint. Mirrors the
 * `SerializedIconSet` shape on the server.
 */
export interface IconSetData {
  id: string
  displayName: string
  framework: string
  usagePattern: IconSetSource["usagePattern"]
  icons: IconManifest[]
}

const EMPTY: { sets: readonly IconSetData[]; loading: boolean; error: string | null } = {
  sets: [],
  loading: false,
  error: null,
}

let cached: { sets: readonly IconSetData[]; error: string | null } | null = null
let inflight: Promise<{ sets: readonly IconSetData[]; error: string | null }> | null = null

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object"
}

function isValidUsagePattern(v: unknown): v is IconSetSource["usagePattern"] {
  if (!isRecord(v)) return false
  return typeof v.kind === "string"
}

function isValidIcon(v: unknown): v is IconManifest {
  if (!isRecord(v)) return false
  if (typeof v.id !== "string" || typeof v.displayName !== "string") return false
  if (!Array.isArray(v.tags)) return false
  if (!isRecord(v.ref) || typeof v.ref.kind !== "string") return false
  if (!isRecord(v.preview) || typeof v.preview.kind !== "string") return false
  return true
}

/**
 * Coerce a raw `/api/editor/icon-sets` body into the client shape.
 * Exported for testing — any malformed entry is filtered, never throws.
 */
export function normalizeIconSetsResponse(body: unknown): {
  sets: readonly IconSetData[]
  error: string | null
} {
  if (!isRecord(body)) return { sets: [], error: "malformed response" }
  if (body.ok === false) {
    return { sets: [], error: typeof body.reason === "string" ? body.reason : "request failed" }
  }
  if (!Array.isArray(body.sets)) return { sets: [], error: "sets missing" }

  const sets: IconSetData[] = []
  for (const raw of body.sets) {
    if (!isRecord(raw)) continue
    if (
      typeof raw.id !== "string" ||
      typeof raw.displayName !== "string" ||
      typeof raw.framework !== "string"
    )
      continue
    if (!isValidUsagePattern(raw.usagePattern)) continue
    const icons = Array.isArray(raw.icons) ? raw.icons.filter(isValidIcon) : []
    sets.push({
      id: raw.id,
      displayName: raw.displayName,
      framework: raw.framework,
      usagePattern: raw.usagePattern,
      icons,
    })
  }
  return { sets, error: null }
}

/**
 * Fetch the registered icon sets once per session and share across
 * callers. Mirrors `useProjectKnowledge`: module-level cache, relative
 * `/api/editor/*` fetch, graceful degrade (empty set) on failure.
 *
 * `loading: true` is returned only on the first call before the
 * inflight fetch resolves. Subsequent calls return cached data
 * synchronously.
 */
export function useIconSets() {
  const [state, setState] = useState<{
    sets: readonly IconSetData[]
    loading: boolean
    error: string | null
  }>(() => (cached ? { ...cached, loading: false } : { ...EMPTY, loading: true }))

  useEffect(() => {
    if (cached) {
      // Sync from the module-level cache (an external store shared across hook
      // instances) on mount — the external-system synchronization the rule blesses.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState({ ...cached, loading: false })
      return
    }
    if (!inflight) {
      // editorFetch is a documented passthrough — it adds no headers of
      // its own. Auth (bearer token + Origin check, matching the rest of
      // the CLI's /api/* routes) comes from the window.fetch monkeypatch
      // the CLI's shell UI installs at boot (editor-cli/ui-src/src/main.tsx).
      inflight = editorFetch("/api/editor/icon-sets", { cache: "no-store" })
        .then((r) => r.json() as Promise<unknown>)
        .then((body) => normalizeIconSetsResponse(body))
        .catch((err) => ({
          sets: [] as readonly IconSetData[],
          error: err instanceof Error ? err.message : "fetch failed",
        }))
        .then((resp) => {
          cached = resp
          inflight = null
          return resp
        })
    }
    inflight.then((resp) => setState({ ...resp, loading: false }))
  }, [])

  return state
}
