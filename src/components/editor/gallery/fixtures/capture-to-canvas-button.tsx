"use client"

import { useEffect } from "react"
import { CaptureToCanvasButton } from "@/components/editor/capture-to-canvas-button"
import type { CaptureScreenshotResult } from "@/hooks/useIframeScreenshotCapture"
import { useAppStore } from "@/stores"
import type { SurfaceEntry, SurfaceRenderContext } from "../types"
import { clickLikeUser, findButtonByText, runDrivenInteraction, waitForElement } from "./dom-interaction"

/**
 * `CaptureToCanvasButton`'s "add screenshot to canvas" dialog only opens
 * after `capture()` resolves — an injected prop we fully control, so no
 * fetch stubbing is needed. `canvases` comes from the shared `useAppStore`
 * (Zustand) slice; seeded directly via `useAppStore.setState(...)` before
 * driving the click, the same way `editor-cli/self-host/src/main.tsx`
 * itself seeds `useEditorStore` before first paint. `useLocalCanvases`
 * (inside the real component) also calls `GET /api/editor/canvases` on
 * mount, expecting `{ canvases: Canvas[] }`; the self-host mock backend's
 * generic `/api/editor/*` catch-all answers `{ ok: true }` instead, which
 * fails that shape check and the hook's own try/catch degrades it to a
 * silent no-op (`canvases` stays whatever this fixture seeded) — verified
 * against `src/services/artifact-stores/http-canvas-store.ts` and
 * `useLocalCanvases.ts`'s `refresh()`, not assumed.
 */

const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

function makeCapture(ctx: SurfaceRenderContext): () => Promise<CaptureScreenshotResult> {
  return async () => {
    ctx.log("capture")
    return { ok: true, shot: { dataUrl: TINY_PNG_DATA_URL, width: 1280, height: 800 } }
  }
}

/** Seeds the canvas list, then clicks "Screenshot → canvas" to open the dialog. */
function CaptureFixture({
  ctx,
  seedCanvases,
}: {
  ctx: SurfaceRenderContext
  seedCanvases: boolean
}) {
  useEffect(() => {
    useAppStore.setState({
      canvases: seedCanvases
        ? [
            {
              id: "canvas-1",
              projectId: "ai-gateway",
              name: "Onboarding flow",
              createdAt: "2026-08-01T00:00:00.000Z",
              updatedAt: "2026-08-08T00:00:00.000Z",
            },
            {
              id: "canvas-2",
              projectId: "ai-gateway",
              name: "Pricing revamp",
              createdAt: "2026-07-20T00:00:00.000Z",
              updatedAt: "2026-08-05T00:00:00.000Z",
            },
          ]
        : [],
    })

    let cancelled = false
    runDrivenInteraction(async () => {
      const button = await waitForElement(() => findButtonByText(/screenshot → canvas/i))
      if (cancelled || !button) return
      clickLikeUser(button)
    })
    return () => {
      cancelled = true
    }
  }, [seedCanvases])

  return (
    <CaptureToCanvasButton
      capture={makeCapture(ctx)}
      currentRoute="/models"
      baseUrl="http://localhost:5173"
    />
  )
}

export const CAPTURE_TO_CANVAS_BUTTON_SURFACE: SurfaceEntry = {
  id: "capture-to-canvas-button",
  title: "Screenshot → canvas",
  kind: "modal",
  sourceFile: "src/components/editor/capture-to-canvas-button.tsx",
  states: [
    {
      id: "capture-to-canvas-button/with-canvases",
      label: "Captured: existing canvases offered",
      readyWhen: '[role="dialog"], [role="menu"]',
      render: (ctx) => <CaptureFixture ctx={ctx} seedCanvases />,
    },
    {
      id: "capture-to-canvas-button/no-canvases",
      label: "Captured: no canvases yet",
      readyWhen: '[role="dialog"], [role="menu"]',
      render: (ctx) => <CaptureFixture ctx={ctx} seedCanvases={false} />,
    },
  ],
}
