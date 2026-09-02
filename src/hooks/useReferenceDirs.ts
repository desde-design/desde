"use client"

/**
 * Client for `/api/editor/read-roots` — the reference directories the agent
 * can read.
 *
 * Deliberately NOT module-level cached the way `useProjectKnowledge` is. That
 * hook caches because its answer cannot change within a session; this one is
 * the backing store for a dialog that edits the same list, so a cache would
 * make the panel show a stale list right after the user changed it. Every open
 * refetches, and every mutation refetches after itself.
 */

import { useCallback, useEffect, useState } from "react"

import type { ReferenceDirectoryEntry, ReferenceDirectoryInspection } from "@/components/editor/reference-dirs/add-reference-directory"
import { editorFetch } from "@/lib/editor-fetch"

/** One root as the settings dialog sees it — resolution included. */
export interface ReferenceDirView {
  name: string
  path: string
  description?: string
  isWorktree: boolean
  isGit: boolean
  /**
   * False when the folder is declared but does not currently resolve (moved,
   * deleted, unmounted drive). Such an entry is skipped by the loader rather
   * than aborting boot, and it is listed here precisely so the user can remove
   * it. Older servers omit the field, so treat a missing value as resolved.
   */
  resolves?: boolean
}

export interface UseReferenceDirs {
  /** null while the first load is in flight. */
  roots: ReferenceDirView[] | null
  /** Loader warnings, e.g. a declared directory that no longer resolves. */
  warnings: string[]
  busy: boolean
  error: string | null
  refresh: () => Promise<void>
  add: (entry: ReferenceDirectoryEntry) => Promise<boolean>
  remove: (name: string) => Promise<boolean>
  inspect: (path: string) => Promise<ReferenceDirectoryInspection | null>
  pick: () => Promise<ReferenceDirectoryInspection | null>
  /**
   * Whether a folder chooser exists at all here. The desktop shell always has
   * one; the server-side picker is osascript, so a browser-served Editor on
   * Linux or Windows has none, and rendering Browse there is a button whose
   * every click does nothing.
   */
  pickerSupported: boolean
}

interface ReadRootsResponse {
  ok?: boolean
  roots?: ReferenceDirView[]
  warnings?: string[]
  reason?: string
  reloadErrors?: string[]
  /** Whether the SERVER has a folder chooser (macOS only today). */
  pickerSupported?: boolean
  /**
   * Config-level problems from the list route. It answers `ok: true` with an
   * empty list in this case, so dropping the field turned "your config is
   * malformed" into "you have no reference folders" — a silent, misleading
   * success.
   */
  errors?: string[]
}

async function call(path: string, init?: RequestInit): Promise<ReadRootsResponse> {
  try {
    const res = await editorFetch(path, init)
    const json = (await res.json()) as ReadRootsResponse
    if (!res.ok) return { ok: false, reason: json.reason ?? `Request failed (${res.status})` }
    return json
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }
}

export function useReferenceDirs(enabled: boolean): UseReferenceDirs {
  const [roots, setRoots] = useState<ReferenceDirView[] | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [serverPicker, setServerPicker] = useState(false)

  const refresh = useCallback(async () => {
    const json = await call("/api/editor/read-roots")
    if (json.ok === false) {
      setError(json.reason ?? "Couldn't load the reference directories.")
      return
    }
    setRoots(json.roots ?? [])
    setWarnings(json.warnings ?? [])
    setServerPicker(json.pickerSupported === true)
    setError(
      json.errors?.length
        ? `desde.config.json could not be read. ${json.errors.join(" ")}`
        : null,
    )
  }, [])

  useEffect(() => {
    if (!enabled) return
    void refresh()
  }, [enabled, refresh])

  const add = useCallback(
    async (entry: ReferenceDirectoryEntry): Promise<boolean> => {
      setBusy(true)
      setError(null)
      try {
        const json = await call("/api/editor/read-roots", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(entry),
        })
        if (json.ok === false) {
          setError(json.reason ?? "Couldn't add that folder.")
          return false
        }
        // The write landed but the session did not pick it up. Say so rather
        // than reporting plain success: the agent will not see this directory
        // until the editor restarts, and only the user can do that.
        //
        // Set AFTER the refresh, not before. `refresh()` clears the error on
        // success, so setting it first meant this warning was reliably wiped
        // by the very next line and the user never saw it.
        await refresh()
        if (json.reloadErrors?.length) {
          setError(
            `Added, but this session could not load it. Restart Editor to use it. ${json.reloadErrors.join(" ")}`,
          )
        }
        return true
      } finally {
        setBusy(false)
      }
    },
    [refresh],
  )

  const remove = useCallback(
    async (name: string): Promise<boolean> => {
      setBusy(true)
      setError(null)
      try {
        const json = await call(`/api/editor/read-roots/${encodeURIComponent(name)}`, {
          method: "DELETE",
        })
        if (json.ok === false) {
          setError(json.reason ?? "Couldn't remove that folder.")
          return false
        }
        // Same contract as `add`: a failed reload leaves the OLD registry in
        // place, so the agent can still read a folder the user just removed.
        // Set after the refresh, which clears the error on success.
        await refresh()
        if (json.reloadErrors?.length) {
          setError(
            `Removed from the config, but this session still has it loaded. Restart Editor to apply. ${json.reloadErrors.join(" ")}`,
          )
        }
        return true
      } finally {
        setBusy(false)
      }
    },
    [refresh],
  )

  /** Shared decoder for the two routes that answer with an inspection. */
  const readInspection = useCallback(
    async (
      res: Response | null,
      failureMessage: string,
    ): Promise<ReferenceDirectoryInspection | null> => {
      if (!res) {
        setError(failureMessage)
        return null
      }
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        supported?: boolean
        canceled?: boolean
        path?: string
        suggestedName?: string
        isGit?: boolean
        reason?: string
      }
      if (!res.ok || json.ok === false) {
        setError(json.reason ?? failureMessage)
        return null
      }
      // No path with ok:true means the platform has no picker or the user
      // dismissed the chooser. Neither is a failure, so no error is set.
      if (json.supported === false || json.canceled || !json.path) return null
      return {
        path: json.path,
        suggestedName: json.suggestedName ?? "",
        isGit: json.isGit === true,
      }
    },
    [],
  )

  const inspect = useCallback(
    async (path: string): Promise<ReferenceDirectoryInspection | null> => {
      setError(null)
      const res = await editorFetch("/api/editor/read-roots/inspect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path }),
      }).catch(() => null)
      return readInspection(res, "That folder can't be used as a reference directory.")
    },
    [readInspection],
  )

  const pick = useCallback(async (): Promise<ReferenceDirectoryInspection | null> => {
    setError(null)
    // Desktop shell first, exactly as `pickForNewProject` does in the launcher
    // hook. Electron's dialog works on every platform, while the server-side
    // picker this falls back to is osascript and therefore macOS-only — so
    // going straight to the server made Browse a dead button for Windows and
    // Linux desktop users, who are precisely the ones Electron was meant to
    // serve.
    const desktop = window.desdeDesktop
    if (desktop) {
      let picked: string | undefined
      try {
        picked = (await desktop.pickFolder()) ?? undefined
      } catch (err) {
        setError((err as Error).message ?? "The folder chooser failed.")
        return null
      }
      if (!picked) return null
      return inspect(picked)
    }
    const res = await editorFetch("/api/editor/read-roots/pick", { method: "POST" }).catch(
      () => null,
    )
    return readInspection(res, "The folder chooser failed.")
  }, [inspect, readInspection])

  // The desktop bridge wins where it exists (Electron's chooser is
  // cross-platform); otherwise the server's own answer decides, since it is
  // the thing that would have to pop the dialog.
  const pickerSupported =
    (typeof window !== "undefined" && Boolean(window.desdeDesktop)) || serverPicker

  return { roots, warnings, busy, error, refresh, add, remove, inspect, pick, pickerSupported }
}
