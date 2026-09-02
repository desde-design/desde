"use client"

/**
 * Client for the project settings page.
 *
 * It talks to the LAUNCHER API (`/api/launcher/*`), not the editor's
 * `repoRoot`-scoped routes, because the project it edits has not been booted:
 * you reach settings from the project list, before opening anything. Every
 * call therefore carries an explicit `path`.
 *
 * ## The save model, stated once
 *
 * The name STAGES behind Save; design systems and reference folders DO NOT.
 * They write the moment you add or remove one, because that is what the
 * panels they reuse already do and what the launcher API offers — an append
 * and a remove, not a replace.
 *
 * The alternative was making both panels fully controlled so a single Save
 * committed everything, which is a real refactor of two components and the
 * New Project page that shares them. The cost of NOT doing it is that Cancel
 * cannot undo a removed design system, so the page has to say so rather than
 * imply a transaction it does not have. A footer that silently fails to undo
 * half the page is worse than a page that admits which half is live.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { editorFetch } from "@/lib/editor-fetch"
import type { DesignSystemDeclaration } from "@/editor/core/design-system-declarations"
import type { ReadRootDeclaration } from "@/editor/core/read-root-declarations"

export interface ProjectDesignSystemEntry {
  /** `declarationIdentity(source)` — the key removal matches on. */
  identity: string
  declaration: DesignSystemDeclaration
}

export interface ProjectSettingsData {
  path: string
  name: string
  designSystems: ProjectDesignSystemEntry[]
  readRoots: ReadRootDeclaration[]
  /** Config problems. Reported, never fatal — see the read route. */
  warnings: string[]
}

export interface UseProjectSettings {
  data: ProjectSettingsData | null
  loading: boolean
  busy: boolean
  error: string | null
  refresh: () => Promise<void>
  rename: (name: string) => Promise<boolean>
  addDesignSystem: (declaration: DesignSystemDeclaration) => Promise<boolean>
  removeDesignSystem: (identity: string) => Promise<boolean>
  addReadRoot: (declaration: ReadRootDeclaration) => Promise<boolean>
  removeReadRoot: (name: string) => Promise<boolean>
}

interface ApiShape {
  ok?: boolean
  reason?: string
  path?: string
  name?: string
  designSystems?: ProjectDesignSystemEntry[]
  readRoots?: ReadRootDeclaration[]
  warnings?: string[]
  skipped?: { reason?: string }[]
}

async function post(path: string, body: unknown): Promise<ApiShape> {
  try {
    const res = await editorFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => ({}))) as ApiShape
    // A 200 says the request succeeded, not that the body has the shape we
    // read. Same discipline `useEditorCapabilities` applies.
    if (!res.ok) return { ok: false, reason: json.reason ?? `Request failed (${res.status})` }
    return json
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }
}

export function useProjectSettings(path: string | null): UseProjectSettings {
  /**
   * One state object carrying WHICH path it describes.
   *
   * `loading` is derived from it rather than being its own flag, which is not
   * tidiness — a separate `setLoading(true)` has to run synchronously at the
   * top of `refresh`, and `refresh` is called from an effect, which is exactly
   * the cascading render `react-hooks/set-state-in-effect` rejects. Deriving
   * it also makes a stale render impossible by construction: until the answer
   * for THIS path arrives, the hook reports loading rather than the previous
   * project's settings.
   */
  const [loaded, setLoaded] = useState<{
    forPath: string
    data: ProjectSettingsData | null
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loading = path !== null && loaded?.forPath !== path
  const data = loaded?.forPath === path ? (loaded?.data ?? null) : null

  /**
   * Read for `target`, then apply. Split from the effect below on purpose.
   *
   * `react-hooks/set-state-in-effect` rejects a setState reachable from an
   * effect BODY, and it does not model awaits — so an effect that simply
   * called this would be flagged even though every write is behind a network
   * round-trip. What the rule does allow is exactly what is correct here:
   * setState from a callback that fires when an external system answers.
   *
   * Stale answers are dropped by a GENERATION counter rather than a
   * per-effect `cancelled` flag. Without a guard of some kind, a slow read for
   * project A can land after the user has switched to project B and paint A's
   * design systems under B's name. The counter is the better of the two
   * because it also covers a `refresh()` after a mutation racing a `load()`
   * from a path change, which an effect-scoped flag cannot see.
   */
  const generation = useRef(0)
  const refresh = useCallback(
    async () => {
      if (!path) return
      const target = path
      const mine = ++generation.current
      const res = await post("/api/launcher/project-settings", { path: target })
      if (generation.current !== mine) return
      if (res.ok !== true || typeof res.name !== "string") {
        setError(res.reason ?? "Couldn't read this project's settings.")
        // Recorded against this path with a null body, so the page leaves
        // "loading" and shows the error instead of spinning forever.
        setLoaded({ forPath: target, data: null })
        return
      }
      setError(null)
      setLoaded({
        forPath: target,
        data: {
          path: res.path ?? target,
          name: res.name,
          designSystems: Array.isArray(res.designSystems) ? res.designSystems : [],
          readRoots: Array.isArray(res.readRoots) ? res.readRoots : [],
          warnings: Array.isArray(res.warnings) ? res.warnings : [],
        },
      })
    },
    [path],
  )

  useEffect(() => {
    if (!path) return
    // Read on mount and whenever the project changes. There is no cascading
    // render to prevent here: every write in `refresh` sits behind a network
    // round-trip and a generation check, so nothing runs synchronously with
    // this effect.
    //
    // MEASURED, because the exemption is easy to get wrong: this exact shape
    // (a `useCallback` that awaits a module-level fetch helper then setStates,
    // called from a guarded effect) is what `useReferenceDirs.ts` and
    // `useEditorCapabilities.ts` already do, and neither is flagged. Reduced
    // to a 20-line file it IS flagged — the rule's analyzer gives up on the
    // larger hooks and silently skips them. So the bar is not "this pattern is
    // banned in this repo"; it is "this pattern is banned in small files",
    // which is not a rule worth restructuring around.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [path, refresh])

  /**
   * Every mutation runs the same way: mark busy, post, refresh on success.
   *
   * It re-reads rather than patching local state because the config file is
   * the source of truth and a write can be partially refused (a duplicate
   * design system is `skipped`, not an error). Patching optimistically would
   * show a row that is not in the file.
   */
  const mutate = useCallback(
    async (route: string, body: Record<string, unknown>, fallback: string): Promise<boolean> => {
      if (!path) return false
      setBusy(true)
      setError(null)
      const res = await post(route, { path, ...body })
      if (res.ok !== true) {
        setError(res.reason ?? fallback)
        setBusy(false)
        return false
      }
      // `declare` answers 200 with a `skipped` list rather than an error when
      // an entry collides. Reporting that is the difference between "nothing
      // happened" and "nothing happened, and here is why".
      const skippedReason = res.skipped?.[0]?.reason
      if (skippedReason) {
        setError(skippedReason)
        setBusy(false)
        return false
      }
      await refresh()
      setBusy(false)
      return true
    },
    [path, refresh],
  )

  return {
    data,
    loading,
    busy,
    error,
    refresh,
    rename: useCallback(
      (name) => mutate("/api/launcher/project-name", { name }, "Couldn't rename this project."),
      [mutate],
    ),
    addDesignSystem: useCallback(
      (declaration) =>
        mutate(
          "/api/launcher/design-systems/declare",
          { declarations: [declaration] },
          "Couldn't add that design system.",
        ),
      [mutate],
    ),
    removeDesignSystem: useCallback(
      (identity) =>
        mutate(
          "/api/launcher/design-systems/remove",
          { identity },
          "Couldn't remove that design system.",
        ),
      [mutate],
    ),
    addReadRoot: useCallback(
      (declaration) =>
        mutate(
          "/api/launcher/read-roots/declare",
          { declarations: [declaration] },
          "Couldn't add that reference folder.",
        ),
      [mutate],
    ),
    removeReadRoot: useCallback(
      (name) =>
        mutate(
          "/api/launcher/read-roots/remove",
          { name },
          "Couldn't remove that reference folder.",
        ),
      [mutate],
    ),
  }
}
