"use client"

import { useEffect, useRef } from "react"
import type { RefObject } from "react"
import { toast } from "sonner"
import type { ConnectionStatus } from "@/hooks/useEditorEditing"

const BRIDGE_STATUS_TOAST = "editor-bridge-status"

interface LivePrototypePaneProps {
  prototypeUrl: string
  iframeRef: RefObject<HTMLIFrameElement | null>
  status: ConnectionStatus
}

/**
 * Renders the prototype iframe. Adapter attachment, manifest lookup,
 * and selection wiring live in `useEditorEditing` — this component
 * owns only the iframe element and its connection-status overlays so
 * that the iframe can be created in one place (this component) or
 * outside (project route's compose mode for iframe sharing) without
 * duplicating bridge wiring.
 */
export function LivePrototypePane({
  prototypeUrl,
  iframeRef,
  status,
}: LivePrototypePaneProps) {
  // Once the bridge has handshaked at least once, a later return to
  // "connecting" is a transient RECONNECT — the iframe did a full-document
  // reload (HMR, an `npm run build:bridge` the bridge-plugin watches and
  // pushes a `full-reload` for, or an SPA navigation that hit a fresh
  // document) and `runHandshake` re-fires. Those settle in well under a
  // second, so flashing "Connecting…" on every one reads as a toast that's
  // "always showing" during active bridge iteration. Suppress the loading
  // toast on reconnects; only the FIRST connect shows it. Genuine failures
  // still surface via the error toast (the 5s handshake timeout).
  const hasConnectedRef = useRef(false)

  // Surface bridge-connection status as a bottom-right toast instead of a
  // full-width strip across the top of the pane. One stable id so the
  // connecting→error→connected transitions update/clear the same toast.
  useEffect(() => {
    if (status.kind === "connecting") {
      // Reconnect after a prior successful handshake → stay quiet.
      if (hasConnectedRef.current) {
        toast.dismiss(BRIDGE_STATUS_TOAST)
      } else {
        // No "bridge" (Mo, 2026-08-18: "users don't know about the bridge,
        // they don't need to"). It is the name of our transport; what they
        // are waiting on is their own prototype appearing.
        toast.loading("Loading prototype", {
          id: BRIDGE_STATUS_TOAST,
        })
      }
    } else if (status.kind === "error") {
      /*
       * The reader's problem, not ours. This used to read "Bridge connection
       * failed: the prototype never sent BRIDGE_READY" — two internal names
       * in one line, describing a handshake nobody outside this repo knows
       * exists.
       *
       * `status.message` is diagnostic text meant for us, so it moves to the
       * description where a bug report can still quote it, and the title says
       * what the reader can see: the prototype is there but not responding to
       * the editor.
       */
      toast.error("Can't connect to your prototype", {
        id: BRIDGE_STATUS_TOAST,
        description:
          "Reload the page. If that doesn't help, check that your dev server is still running.",
        duration: Infinity,
      })
    } else {
      hasConnectedRef.current = true
      toast.dismiss(BRIDGE_STATUS_TOAST)
    }
    return () => { toast.dismiss(BRIDGE_STATUS_TOAST) }
  }, [status])

  return (
    <div className="relative flex h-full w-full flex-col">
      <iframe
        ref={iframeRef}
        src={prototypeUrl}
        className="h-full w-full border-0 bg-white"
        title="Prototype"
      />
    </div>
  )
}
