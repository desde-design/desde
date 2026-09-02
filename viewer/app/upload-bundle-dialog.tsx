"use client"

import { useRef, useState } from "react"
import { Callout } from "@/components/blocks"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { ApiError, failureMessage } from "./api-client"

/**
 * Upload a built prototype without connecting a repository.
 *
 * The server route this posts to has existed since Phase 2 and was
 * reachable only by `curl` with an admin bearer, which meant the ONLY way
 * to get a prototype into the viewer through its own UI was to register a
 * GitHub App first. That put GitHub on the critical path for people who did
 * not want builds at all.
 *
 * Split into a PANEL and a dialog shell (2026-08-29): the Add-project
 * wizard's Upload tab embeds the panel directly, while the Deployments tab
 * keeps the standalone dialog. One implementation, two mounts.
 *
 * Deliberately a raw `fetch` rather than the shared `postJson` helper: the
 * body is a gzip stream, not JSON, and the helper sets a JSON content type.
 * The error handling still routes through `failureMessage` so the copy
 * matches every other surface.
 */
export interface UploadBundlePanelProps {
  projectId: string
  /** Called once the upload returns 2xx, so the caller can close and refresh. */
  onUploaded: () => void
  /** The footer's Cancel. Hosts close their dialog here. */
  onCancel: () => void
  /**
   * Fires when an upload starts and when it settles. The dialog shell uses
   * it to refuse Escape/backdrop closes mid-upload — the panel cannot
   * enforce that from inside the content Radix is about to unmount.
   */
  onBusyChange?: (busy: boolean) => void
}

export function UploadBundlePanel({ projectId, onUploaded, onCancel, onBusyChange }: UploadBundlePanelProps) {
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const setBusy = (busy: boolean) => {
    setUploading(busy)
    onBusyChange?.(busy)
  }

  const upload = async () => {
    if (!file) return
    setBusy(true)
    setError(null)
    // Named once and reused on both `ApiError`s below, rather than the
    // literal string "deployments" — matches `fetchJson`'s convention
    // (`api-client.ts`) of keeping the real request URL on the error for
    // the console, even though `failureMessage` never renders it.
    const url = `/api/v1/projects/${encodeURIComponent(projectId)}/deployments`
    try {
      let res: Response
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/gzip" },
          body: file,
        })
      } catch (cause) {
        // No response at all (offline, DNS, the server not running) — same
        // shape `fetchJson` throws, so `failureMessage` gives it the same
        // "Couldn't reach the server" copy instead of the generic fallback.
        console.error(`[viewer] request failed: ${url}`, cause)
        throw new ApiError(0, null, url)
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new ApiError(res.status, body?.error ?? null, url)
      }
      onUploaded()
    } catch (err) {
      setError(failureMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-base text-muted-foreground">
        A gzipped tar of the build output, with index.html at its root.
      </p>

      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          const dropped = e.dataTransfer.files[0]
          if (dropped) setFile(dropped)
        }}
        className={cn(
          "flex flex-col items-center gap-2 rounded-md border border-dashed px-6 py-8 text-center",
          dragging ? "border-primary bg-primary/5" : "border-border",
        )}
      >
        <p className="text-base">{file ? file.name : "Drop a .tar.gz here"}</p>
        <p className="text-xs text-muted-foreground">
          {file ? `${Math.round(file.size / 1024)} KB` : "or"}
        </p>
        {!file && (
          <Button variant="outline" size="xs" onClick={() => inputRef.current?.click()}>
            Choose a file
          </Button>
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".gz,.tgz,application/gzip"
          className="hidden"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </div>

      {error && (
        <Callout tone="destructive" data-testid="upload-bundle-error">
          {error}
        </Callout>
      )}

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={uploading}>
          Cancel
        </Button>
        <Button
          onClick={() => void upload()}
          disabled={!file || uploading}
          data-testid="upload-bundle-submit"
          data-uploading={uploading ? "true" : "false"}
        >
          {uploading ? "Uploading" : "Upload"}
        </Button>
      </DialogFooter>
    </div>
  )
}

export interface UploadBundleDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  /** Called once the upload returns 2xx, so the caller can refresh deployments. */
  onUploaded: () => void
}

export function UploadBundleDialog({ open, onOpenChange, projectId, onUploaded }: UploadBundleDialogProps) {
  const [busy, setBusyState] = useState(false)

  // The one path that closes the dialog, whether the trigger is the Cancel
  // button, Escape, a backdrop click, or the header X. Refusing while an
  // upload is in flight keeps the panel's eventual state updates from
  // landing on an already-closed dialog; the panel reports the moment the
  // request settles, so the guard lifts the instant it's safe to close.
  // No explicit reset on close: the panel lives inside `DialogContent`,
  // which Radix unmounts, so its state (including the native file input)
  // starts fresh on every open.
  const requestClose = (next: boolean) => {
    if (!next && busy) return
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      {/* `lg`, the same width the Add-project dialog gives this exact
          panel — at `sm` this was the one narrower modal in the flow (Mo,
          2026-08-30). */}
      <DialogContent size="lg" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Upload a build</DialogTitle>
        </DialogHeader>
        <UploadBundlePanel
          projectId={projectId}
          onBusyChange={setBusyState}
          onCancel={() => requestClose(false)}
          onUploaded={() => {
            onOpenChange(false)
            onUploaded()
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
