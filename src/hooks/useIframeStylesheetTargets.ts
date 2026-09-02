"use client"

/**
 * Shell-side read of the stylesheets the prototype's document has LOADED —
 * `GET_STYLESHEET_TARGETS` → `STYLESHEET_TARGETS_CAPTURED`, over the shared
 * `useIframeBridgeRequest` round trip.
 *
 * This exists for one question with one right answer: on a substrate with no
 * `<style scoped>` block, which file can a `scoped-css-override` be written
 * into such that it will actually render? A filesystem walk finds `.css` files
 * that EXIST; only the document knows which of them the app IMPORTS, and a
 * rule spliced into an unimported file is inert while every layer reports
 * success. See `tasks/dev-server-hosts.md` § 9g.1 and
 * `src/components/editor/resolve-override-stylesheet.ts`, which turns this
 * list into a destination.
 *
 * Resolves `[]` on no-iframe / timeout / failure. An empty list is not an
 * error — it is the honest state of a CSS-Modules-only or
 * styled-components-only app, and the caller refuses with a bootstrap
 * suggestion rather than guessing a file.
 */
import { useCallback } from "react"
import type { StyleStylesheetRef } from "@/types/bridge"
import { useIframeBridgeRequest } from "./useIframeBridgeRequest"

/** Enumerating `document.styleSheets` is O(sheets); keep the ceiling short. */
const STYLESHEET_TARGETS_TIMEOUT_MS = 3000

export type FetchStylesheetTargetsFn = (
  signal?: AbortSignal,
) => Promise<StyleStylesheetRef[]>

export function useIframeStylesheetTargets(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
): FetchStylesheetTargetsFn {
  const request = useIframeBridgeRequest<StyleStylesheetRef[]>(iframeRef, {
    replyTypes: ["STYLESHEET_TARGETS_CAPTURED"],
    timeoutMs: STYLESHEET_TARGETS_TIMEOUT_MS,
    extractPayload: (data) => {
      const sheets = (data.payload as { sheets?: unknown } | null)?.sheets
      return Array.isArray(sheets) ? (sheets as StyleStylesheetRef[]) : []
    },
    onNoIframe: () => [],
    onTimeout: () => [],
    onAbort: () => [],
  })

  return useCallback(
    (signal?: AbortSignal) => {
      if (signal?.aborted) return Promise.resolve([])
      return request("GET_STYLESHEET_TARGETS", undefined, signal)
    },
    [request],
  )
}
