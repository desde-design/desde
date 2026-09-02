"use client"

import { useEffect, useState } from "react"
import type { DesignToken } from "@/editor/edit-service/design-tokens-source"
import { editorFetch } from "@/lib/editor-fetch"

let cached: DesignToken[] | null = null
let inflight: Promise<DesignToken[]> | null = null

/**
 * Fetch the prototype's design tokens once per session and share
 * the result across all callers. The token list is bounded
 * (a few hundred entries even for kitchen-sink design systems)
 * and stable within a session, so a module-level cache is a
 * reasonable choice over React Context.
 *
 * Returns an empty array on fetch failure (treated as "no tokens
 * available," same as a substrate without a recognized package).
 *
 * Used by the inspector's color/spacing/typography sections to
 * render token swatches and emit token-referencing edits.
 */
export function useDesignTokens(): DesignToken[] {
  const [tokens, setTokens] = useState<DesignToken[]>(cached ?? [])
  useEffect(() => {
    if (cached) return
    if (!inflight) {
      inflight = editorFetch("/api/editor/design-tokens", { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<DesignToken[]>) : []))
        .catch(() => [])
        .then((data) => {
          cached = data
          inflight = null
          return data
        })
    }
    inflight.then((data) => setTokens(data))
  }, [])
  return tokens
}
