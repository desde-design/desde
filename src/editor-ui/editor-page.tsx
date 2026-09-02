"use client"

import { useEffect, useMemo, useState } from "react"
import type { ComponentManifest, Selection } from "@/editor/core"
import { RemoteManifestSource } from "@/editor/adapters/remote"
import { ComponentPicker } from "@/components/editor/component-picker"
import { EditorSurface } from "@/components/editor/editor-surface"
import { InspectorPanel } from "@/components/editor/inspector-panel"
import { useEditorStore } from "@/stores/editor-only"
import { Toaster } from "@/components/ui/sonner"
import { Eyebrow } from "@/components/blocks"
import { useUrlSearchParam } from "./use-url-search-param"

/**
 * Editor route. Branches on the `?url=` query param:
 *
 * - **Live (V1.2)** — when `?url=` is supplied, mounts the prototype
 *   in an iframe via `<EditorSurface>` and connects
 *   `BridgeFrameworkAdapter` to its bridge. The CLI (the only surface
 *   today) always supplies this: `resolveCliIframeUrl`
 *   (`src/lib/editor-deeplink.ts`) returns a `string`, never `null`.
 * - **Dev picker (V1.1)** — the `frozenUrl == null` branch below,
 *   `<DevEditorView>`. Unreachable from the CLI for the reason above;
 *   kept for offline manifest inspection in non-CLI contexts (tests,
 *   local dev of this component in isolation).
 *
 * The editing chrome lives in
 * [components/editor/editor-surface.tsx](../../components/editor/editor-surface.tsx)
 * so the project route can mount the same surface inline (Phase 3).
 */
export default function EditorPage() {
  const urlParam = useUrlSearchParam("url")
  // Freeze the first prototype URL we see. After mount, EditorSurface
  // mirrors the iframe's live route back into `?url=` (via replaceState) so the
  // address bar deeplinks to the current page and a hard refresh restores it
  // instead of bouncing to root. That mirror MUST NOT feed back into the iframe
  // `src`: `useUrlSearchParam` re-reads on replaceState, so re-deriving the src
  // from the live param would reload the iframe on every in-prototype
  // navigation (and flash back to the seed page). Freezing the prop breaks the
  // loop — the iframe is seeded once and then drives its own SPA navigation.
  // setState during render is React's sanctioned pattern for adjusting state
  // from a changing prop (no extra commit, no effect); lazy init covers the CLI
  // case (main.tsx sets `?url=` before mount), the in-render capture the web
  // case where the first render may read null before the client param resolves.
  const [frozenUrl, setFrozenUrl] = useState<string | null>(urlParam)
  if (frozenUrl == null && urlParam != null) {
    setFrozenUrl(urlParam)
  }
  return (
    <>
      {frozenUrl ? (
        <EditorSurface prototypeUrl={frozenUrl} />
      ) : (
        <DevEditorView />
      )}
      {/* Single app-level toast outlet for the editor surface. Status,
          session, and bridge-connection notices render here (bottom-left)
          instead of as full-width banners under the top bar. */}
      <Toaster position="bottom-left" richColors closeButton />
    </>
  )
}

function DevEditorView() {
  // The dev picker also goes through the V1.4 remote pipeline. When the
  // server endpoint is unconfigured (no `EDITOR_PROTOTYPE_ROOT`), it
  // returns 503; the picker surfaces that as "no components found" via
  // the empty-list path.
  const source = useMemo(
    () => new RemoteManifestSource({ endpoint: "/api/editor/manifest" }),
    [],
  )

  const editorSelection = useEditorStore((s) => s.editorSelection)
  const editorManifest = useEditorStore((s) => s.editorManifest)
  const setEditorSelection = useEditorStore((s) => s.setEditorSelection)
  const setEditorManifest = useEditorStore((s) => s.setEditorManifest)
  const resetEditor = useEditorStore((s) => s.resetEditor)

  useEffect(() => {
    return () => {
      resetEditor()
    }
  }, [resetEditor])

  const handleSelect = (manifest: ComponentManifest | null) => {
    setEditorManifest(manifest)
    setEditorSelection(manifest ? selectionFromManifest(manifest) : null)
  }

  return (
    <div className="flex h-screen flex-col bg-muted/30">
      <header className="flex items-center justify-between border-b bg-background px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold">Editor (dev preview)</h1>
          <p className="text-sm text-muted-foreground">
            No prototype connected. Pick a component to render its inspector
            against bundled manifest data, or reload with{" "}
            <span className="font-mono">?url=&lt;prototype-url&gt;</span> to
            connect a live iframe.
          </p>
        </div>
        <ComponentPicker
          source={source}
          selected={editorManifest}
          onSelect={handleSelect}
        />
      </header>
      <main className="flex flex-1 overflow-hidden">
        <section className="flex flex-1 items-center justify-center p-8 text-base text-muted-foreground">
          {editorManifest ? (
            <PreviewPlaceholder manifest={editorManifest} />
          ) : (
            <span>Select a component above.</span>
          )}
        </section>
        <InspectorPanel
          selection={editorSelection}
          manifest={editorManifest}
        />
      </main>
    </div>
  )
}

function PreviewPlaceholder({ manifest }: { manifest: ComponentManifest }) {
  return (
    <div className="max-w-md rounded-lg border bg-background p-6 text-center">
      <Eyebrow>Preview placeholder</Eyebrow>
      <p className="mt-2 text-lg font-normal">{manifest.name}</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Pass <span className="font-mono">?url=…</span> to connect a real
        prototype iframe. The right-rail inspector is driven by the
        ComponentManifest produced by{" "}
        <span className="font-mono">
          {manifest.source?.extractor ?? "the manifest source"}
        </span>
        .
      </p>
    </div>
  )
}

function selectionFromManifest(manifest: ComponentManifest): Selection {
  return {
    targetId: manifest.id,
    selector: manifest.id,
    componentName: manifest.name,
    componentFile: manifest.source?.declarations?.[0]?.file,
    ancestry: [],
  }
}
