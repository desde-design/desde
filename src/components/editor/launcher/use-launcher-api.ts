"use client"

import { useCallback, useEffect, useState } from "react"

/** One row of the `gh repo list` result, as the clone step renders it. */
export interface GitHubRepoOption {
  nameWithOwner: string
  name: string
  isPrivate: boolean
  updatedAt: string
}

export type GitHubReposState =
  | { available: true; repos: GitHubRepoOption[] }
  | {
      available: false
      /** Told apart so the UI can give the right instruction, or none. */
      reason: "not-installed" | "not-authenticated" | "failed"
      detail?: string
    }
// Type-only — `design-system-declarations.ts` imports `node:fs/promises` at
// module scope, which the browser UI bundle can't resolve, so only its
// *type* may cross into client code. See `pendingIdentity` in
// `new-project-page.tsx` for the runtime-side consequence (the identity
// rule is duplicated there rather than imported).
import type { DesignSystemDeclaration } from "@/editor/core/design-system-declarations"
import type { LauncherDemoState, LauncherOpenBlock } from "@/types/launcher"

/**
 * What a pre-open path check produced. Two independent outcomes, and collapsing
 * them is what let a failed check advance the wizard:
 *
 *  - `block`: the path resolved and the project CANNOT be opened (unsupported
 *    framework, not a git repo). Structured, rendered by `OpenBlockNotice`.
 *  - `error`: the check itself did not complete (bad path, server error).
 *    Prose, rendered as a banner on the step that asked.
 *
 * Both null means "checked, and it opens".
 */
export interface InspectPathResult {
  block: LauncherOpenBlock | null
  error: string | null
}
import type { ReferenceDirectoryInspection } from "@/components/editor/reference-dirs/add-reference-directory"
import { editorFetch } from "@/lib/editor-fetch"
import { navigateTopLevel } from "@/lib/top-level-navigate"

/**
 * Client for the launcher server's `/api/launcher/*` endpoints. Auth is
 * handled by main.tsx's fetch interceptor (per-session bearer token), so
 * plain same-origin fetches suffice here.
 */

export interface LauncherProject {
  /** Canonical repo root (absolute path) — the registry key. */
  path: string
  slug?: string
  lastOpenedAt: string
}

/** Shape `suggestDesignSystems` (editor/onboarding/suggest.ts) returns, trimmed to what `<AddDesignSystem>` needs. */
export interface DesignSystemSuggestion {
  package: string
  componentCount: number
  framework: string
}

export interface DeclareSkip {
  declaration: DesignSystemDeclaration
  reason: string
}

interface ApiResult {
  ok: boolean
  reason?: string
  url?: string
  path?: string
  dest?: string
  canceled?: boolean
  supported?: boolean
  projects?: LauncherProject[]
  suggestions?: DesignSystemSuggestion[]
  appended?: DesignSystemDeclaration[]
  /** `gh` repo listing (see listGitHubRepos). */
  available?: boolean
  repos?: GitHubRepoOption[]
  detail?: string
  skipped?: DeclareSkip[]
  /** read-roots/inspect: the slug derived from the picked folder's basename. */
  suggestedName?: string
  /** read-roots/inspect: whether the picked folder is a git repository. */
  isGit?: boolean
  /**
   * Set when the server refused to open a project and can say why: the
   * structured failure the CLI's host layer already produces. Carried through
   * the failure branch below rather than collapsed into `reason`, which is
   * what used to leave the UI holding an exit code.
   */
  blocked?: LauncherOpenBlock | null
  /** GET /api/launcher/demo — see LauncherDemoState. */
  present?: boolean
  dirtyFiles?: number
  extraCommits?: number
  triedAt?: string | null
  /** POST /api/launcher/demo — false when the demo was already on disk. */
  created?: boolean
  /** DELETE /api/launcher/demo — false when there was nothing to remove. */
  removed?: boolean
}

/**
 * How long to wait for a top-level navigation to actually take this document
 * away before concluding it never will. See `openPath`.
 *
 * Generous on purpose: the target is a localhost server that has already
 * reported itself ready, so a real navigation commits in well under a second.
 * The only cost of being wrong is showing an error for a moment before the
 * page unloads anyway.
 */
const NAVIGATION_DEADLINE_MS = 15_000

async function callApi(
  path: string,
  init?: RequestInit,
): Promise<ApiResult> {
  try {
    const res = await editorFetch(path, init)
    const json = (await res.json().catch(() => ({}))) as ApiResult
    if (!res.ok || !json.ok) {
      return {
        ok: false,
        reason: json.reason ?? `Request failed (${res.status})`,
        ...(json.blocked ? { blocked: json.blocked } : {}),
      }
    }
    return json
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }
}

function get(path: string): Promise<ApiResult> {
  return callApi(path, { method: "GET" })
}

function del(path: string): Promise<ApiResult> {
  // No body, deliberately. The demo's path is resolved server-side and is the
  // only one that route can remove; sending one would invite the idea that it
  // could be told where to point. See `editor-cli/src/server/demo/remove.ts`.
  return callApi(path, { method: "DELETE" })
}

function post(path: string, body?: unknown): Promise<ApiResult> {
  return callApi(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  })
}

export interface UseLauncherApi {
  /** null while the first load is in flight. */
  projects: LauncherProject[] | null
  /** Label describing the in-flight action (disables the page). */
  busy: string | null
  /** Last action error, cleared on the next action. */
  error: string | null
  /**
   * Last structured "we cannot open this project" refusal, cleared on the next
   * action. Mutually exclusive with {@link error}: a refusal that arrives with
   * a summary, a cause and remediation steps lands here and NOT in the plain
   * banner, so the page renders it once, in full, rather than twice.
   */
  openBlock: LauncherOpenBlock | null
  /**
   * The bundled demo: whether it is on disk, what deleting it would cost, and
   * whether it has ever been tried. null while the first load is in flight.
   *
   * `triedAt` never suppresses the demo. It only demotes it out of the
   * launcher's empty state, so someone who deleted it deliberately is not
   * offered it again in the same prominent slot, and someone who deleted it by
   * accident still finds it in the New prototype sources.
   */
  demo: LauncherDemoState | null
  /** Re-read the demo's change summary, so a confirmation cannot go stale. */
  refreshDemo: () => Promise<void>
  /** Delete the demo for real: the directory and its recents entry. */
  deleteDemo: () => Promise<{ ok: boolean }>
  clearError: () => void
  /** Boot a editor on `path` and redirect the browser to it. */
  openPath: (path: string) => Promise<void>
  /**
   * The developer's GitHub repos, via their own `gh` login. Resolves to an
   * unavailable state rather than throwing when `gh` is absent or logged out;
   * both are ordinary, and the clone step falls back to a URL field.
   */
  listGitHubRepos: () => Promise<GitHubReposState>
  /**
   * Ask whether `path` could be opened, WITHOUT opening it. Read-only on the
   * server (package.json plus a few `fs.access` calls), so the New Project
   * dialog can refuse a folder the moment it is picked instead of after it has
   * written a name and design-system declarations into the repo.
   *
   * Resolves the refusal, or null when the project is fine. Also mirrors it
   * into {@link openBlock} so the page and the dialog show one surface.
   */
  inspectPath: (path: string) => Promise<InspectPathResult>
  /**
   * Resolves a picked folder WITHOUT opening it — the New Project dialog's
   * design-system step needs the path first so it can offer "add a design
   * system" before a editor ever spawns. Caller follows up with
   * `openPath(path)` once the user is done (Skip / Add & open).
   * `supported: false` → no native picker on this platform (caller falls
   * back to manual path entry).
   */
  pickForNewProject: () => Promise<{ supported: boolean; path?: string }>
  /**
   * Clones `repoUrl` and resolves the destination path WITHOUT spawning a
   * editor on it — declarations written by the design-system step must
   * land in the config BEFORE the editor's boot reconciliation runs, so
   * opening has to wait until the dialog's Skip / Add & open action.
   */
  cloneForNewProject: (repoUrl: string) => Promise<{ path?: string }>
  /** Read-only, pre-open scan for design systems `path` already depends on + imports (safe before any editor boots on it). */
  suggestDesignSystems: (path: string) => Promise<DesignSystemSuggestion[]>
  /**
   * Persist `declarations` to `path`'s `desde.config.json`
   * (no cloning/installing here — that's the boot reconciliation's job).
   * Validates every entry before writing any of them.
   */
  declareDesignSystems: (
    path: string,
    declarations: DesignSystemDeclaration[],
  ) => Promise<{ ok: true } | { ok: false; reason: string }>
  /** Resolve a typed or picked folder as a reference directory (read-only). */
  inspectReadRoot: (
    path: string,
    taken?: string[],
    projectPath?: string,
  ) => Promise<ReferenceDirectoryInspection | null>
  /** Pop the native chooser for a reference folder, then inspect the result. */
  pickReadRoot: (
    taken?: string[],
    projectPath?: string,
  ) => Promise<ReferenceDirectoryInspection | null>
  /**
   * Persist the project's name into `<path>/.desde/config.json`, minting
   * its embedded identity. Runs before the editor spawns so it boots with an
   * identity already on disk.
   */
  setProjectName: (
    path: string,
    name: string,
  ) => Promise<{ ok: boolean; reason?: string }>
  /**
   * Drop a project from the recents list.
   *
   * Forgets it, deletes nothing. The folder and every file in it stay where
   * they are, and opening it again puts the row back. See
   * `editor-cli/src/server/projects-registry.ts`.
   */
  removeProject: (path: string) => Promise<{ ok: boolean; reason?: string }>
}

export function useLauncherApi(): UseLauncherApi {
  const [projects, setProjects] = useState<LauncherProject[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openBlock, setOpenBlock] = useState<LauncherOpenBlock | null>(null)
  const [demo, setDemo] = useState<LauncherDemoState | null>(null)

  useEffect(() => {
    let cancelled = false
    void get("/api/launcher/demo").then((res) => {
      if (cancelled) return
      // A failed demo probe is not worth surfacing: it only decides how
      // prominently an optional tile is offered, and an error banner about it
      // would be louder than the thing it describes.
      setDemo(
        res.ok
          ? {
              present: Boolean(res.present),
              dirtyFiles: Number(res.dirtyFiles ?? 0),
              extraCommits: Number(res.extraCommits ?? 0),
              path: res.path ?? "",
              triedAt: res.triedAt ?? null,
            }
          : { present: false, dirtyFiles: 0, extraCommits: 0, path: "", triedAt: null },
      )
    })
    void callApi("/api/launcher/projects").then((res) => {
      if (cancelled) return
      setProjects(res.ok ? (res.projects ?? []) : [])
      if (!res.ok) setError(res.reason ?? "Couldn't load recent projects.")
    })
    return () => {
      cancelled = true
    }
  }, [])

  const openPath = useCallback(async (path: string) => {
    setError(null)
    setOpenBlock(null)
    setBusy("Starting Editor…")
    const res = await post("/api/launcher/open", { path })
    if (!res.ok || !res.url) {
      // A structured refusal replaces the banner rather than joining it. The
      // fallback line is still here, and still says "exited before it was
      // ready (code N)" when that is genuinely all the server knows.
      if (res.blocked) setOpenBlock(res.blocked)
      else setError(res.reason ?? "Failed to open the project.")
      setBusy(null)
      return
    }
    // Desktop shell only: vouch for this origin BEFORE navigating there, so
    // the shell's navigation guard (which otherwise only knows the
    // launcher's own origin) allows it. No-op in a browser tab. AWAITED —
    // fire-and-forget here was a real race: the navigation below could
    // reach the guard before the main process had processed the trust IPC,
    // intermittently blocking a just-opened editor's own origin. A failure
    // is swallowed rather than surfaced as an error banner: worst case the
    // guard still blocks the navigation and opens it externally instead,
    // which is a degraded outcome, not a broken one.
    //
    // "Degraded, not broken" was too generous, and this is where it was paid
    // for. `navigateTopLevel` resolves as soon as it has ASSIGNED
    // `location.href`; it carries no information about whether the navigation
    // committed. When the desktop guard blocks it, the renderer is told
    // nothing — no exception, no event — so falling off the end here left
    // `busy` set forever. The overlay it drives is full-viewport with no
    // cancel and no Esc, so the window was locked until the user found Cmd+R.
    // Until 2026-09-04 that overlay also held 99.3% of a CPU while it sat
    // there, which is how this was found.
    try {
      await navigateTopLevel(res.url)
    } catch (err) {
      // The `location.href` setter throws a SyntaxError for a value it cannot
      // parse as a URL, and `res.url` is only ever validated as `\S+` when the
      // CLI's ready line is scraped.
      setError(err instanceof Error ? err.message : "Couldn't open the project.")
      setBusy(null)
      return
    }
    // Nothing above proves this document is leaving, so give it a deadline. On
    // a real navigation the document unloads and this timer goes with it; if
    // it ever fires, the navigation was blocked or dropped, and releasing the
    // overlay is strictly better than locking the window.
    window.setTimeout(() => {
      setBusy(null)
      setError("The project started, but this window could not open it. Try again.")
    }, NAVIGATION_DEADLINE_MS)
  }, [])

  const inspectPath = useCallback(async (path: string): Promise<InspectPathResult> => {
    setError(null)
    setOpenBlock(null)
    const res = await post("/api/launcher/inspect", { path })
    if (!res.ok) {
      // `error`, NOT `block`, and the distinction is load-bearing: this
      // returned a bare `null` until 2026-08-17, which the caller read as "no
      // refusal" and advanced on. A bad path ("Not a directory: …") sailed
      // through to the name step and showed its error there, attached to a
      // step that had nothing to do with it.
      const reason = res.reason ?? "Couldn't check the project."
      setError(reason)
      return { block: null, error: reason }
    }
    const blocked = res.blocked ?? null
    setOpenBlock(blocked)
    return { block: blocked, error: null }
  }, [])

  const pickForNewProject = useCallback(async (): Promise<{ supported: boolean; path?: string }> => {
    setError(null)
    // The desktop shell's native picker, when present, replaces the HTTP
    // round-trip entirely — `window.desdeDesktop.pickFolder()` opens
    // `dialog.showOpenDialog` directly in the main process. It is always
    // "supported" wherever it exists (Electron's dialog covers every
    // platform), which is also what un-macs the picker for Windows/Linux
    // desktop users — the server-side capability flag this falls back to is
    // osascript-only.
    const desktop = window.desdeDesktop
    if (desktop) {
      setBusy("Waiting for the folder chooser…")
      try {
        const path = await desktop.pickFolder()
        return path ? { supported: true, path } : { supported: true }
      } catch (err) {
        setError((err as Error).message ?? "The folder chooser failed.")
        return { supported: true }
      } finally {
        setBusy(null)
      }
    }
    setBusy("Waiting for the folder chooser…")
    const res = await post("/api/launcher/pick-folder")
    setBusy(null)
    if (!res.ok) {
      setError(res.reason ?? "The folder chooser failed.")
      return { supported: true }
    }
    if (res.supported === false) return { supported: false }
    if (res.canceled || !res.path) return { supported: true }
    return { supported: true, path: res.path }
  }, [])

  const cloneForNewProject = useCallback(async (repoUrl: string): Promise<{ path?: string }> => {
    setError(null)
    setBusy("Cloning repository…")
    const res = await post("/api/launcher/clone", { repoUrl, open: false })
    setBusy(null)
    if (!res.ok || !res.dest) {
      setError(res.reason ?? "Clone failed.")
      return {}
    }
    return { path: res.dest }
  }, [])

  /**
   * List the developer's GitHub repos through their own `gh` login.
   *
   * Never sets `error`: not having `gh`, or not being logged into it, is an
   * ordinary state for this dialog rather than a failure of anything the user
   * just did. The clone step reads the reason and offers the URL field instead.
   */
  const listGitHubRepos = useCallback(async (): Promise<GitHubReposState> => {
    const res = await get("/api/launcher/github/repos")
    if (!res.ok) {
      return { available: false, reason: "failed", detail: res.reason }
    }
    if (res.available === true && Array.isArray(res.repos)) {
      return { available: true, repos: res.repos as GitHubRepoOption[] }
    }
    const reason =
      res.reason === "not-installed" || res.reason === "not-authenticated"
        ? res.reason
        : "failed"
    return { available: false, reason, detail: res.detail }
  }, [])

  const suggestDesignSystems = useCallback(async (path: string): Promise<DesignSystemSuggestion[]> => {
    const res = await post("/api/launcher/design-systems/suggest", { path })
    if (!res.ok) {
      setError(res.reason ?? "Couldn't scan the project for design systems.")
      return []
    }
    return res.suggestions ?? []
  }, [])

  const declareDesignSystems = useCallback(
    async (
      path: string,
      declarations: DesignSystemDeclaration[],
    ): Promise<{ ok: true } | { ok: false; reason: string }> => {
      setError(null)
      const res = await post("/api/launcher/design-systems/declare", { path, declarations })
      if (!res.ok) {
        const reason = res.reason ?? "Couldn't save the design-system declarations."
        setError(reason)
        return { ok: false, reason }
      }
      return { ok: true }
    },
    [],
  )

  const inspectReadRoot = useCallback(
    async (
      path: string,
      taken: string[] = [],
      projectPath?: string,
    ): Promise<ReferenceDirectoryInspection | null> => {
      setError(null)
      // `projectPath` is what activates the server's self-reference check.
      // Without it the wizard accepted the project's own folder as a chip and
      // only failed at the final declare, after design systems may already
      // have been written.
      const res = await post("/api/launcher/read-roots/inspect", { path, taken, projectPath })
      if (!res.ok || typeof res.path !== "string") {
        setError(res.reason ?? "That folder can't be used as a reference directory.")
        return null
      }
      return {
        path: res.path,
        suggestedName: typeof res.suggestedName === "string" ? res.suggestedName : "",
        isGit: res.isGit === true,
      }
    },
    [],
  )

  /**
   * Pop the chooser for a reference folder, then resolve what came back.
   *
   * Two round trips rather than one because the desktop shell's picker returns
   * only a path — the inspect that follows is the same server call a typed
   * path makes, so both entry points agree on the answer instead of the
   * desktop path quietly skipping validation.
   */
  const pickReadRoot = useCallback(
    async (
      taken: string[] = [],
      projectPath?: string,
    ): Promise<ReferenceDirectoryInspection | null> => {
      setError(null)
      const desktop = window.desdeDesktop
      let picked: string | undefined
      if (desktop) {
        setBusy("Waiting for the folder chooser…")
        try {
          picked = (await desktop.pickFolder()) ?? undefined
        } catch (err) {
          setError((err as Error).message ?? "The folder chooser failed.")
          return null
        } finally {
          setBusy(null)
        }
      } else {
        setBusy("Waiting for the folder chooser…")
        const res = await post("/api/launcher/pick-folder", { purpose: "reference" })
        setBusy(null)
        if (!res.ok) {
          setError(res.reason ?? "The folder chooser failed.")
          return null
        }
        if (res.supported === false || res.canceled || !res.path) return null
        picked = res.path
      }
      if (!picked) return null
      return inspectReadRoot(picked, taken, projectPath)
    },
    [inspectReadRoot],
  )

  const setProjectName = useCallback(
    async (path: string, name: string): Promise<{ ok: boolean; reason?: string }> => {
      setError(null)
      const res = await post("/api/launcher/project-name", { path, name })
      if (!res.ok) {
        const reason = res.reason ?? "Couldn't save the project name."
        setError(reason)
        return { ok: false, reason }
      }
      return { ok: true }
    },
    [],
  )

  const removeProject = useCallback(
    async (path: string): Promise<{ ok: boolean; reason?: string }> => {
      setError(null)
      const res = await post("/api/launcher/projects/remove", { path })
      if (!res.ok) {
        const reason = res.reason ?? "Couldn't remove that project."
        setError(reason)
        return { ok: false, reason }
      }
      // The server hands back the refreshed list, so the row disappears
      // without a follow-up GET whose result would have to be reconciled
      // against a local optimistic edit.
      setProjects(res.projects ?? [])
      return { ok: true }
    },
    [],
  )

  /**
   * Re-read the demo's change summary. Called when its delete confirmation is
   * about to open: the mount-time value can be minutes old, and a stale
   * "nothing will be lost" on a demo the user has since edited is a lie told at
   * exactly the moment it costs the most.
   */
  const refreshDemo = useCallback(async () => {
    const res = await get("/api/launcher/demo")
    if (!res.ok) return
    setDemo({
      present: Boolean(res.present),
      dirtyFiles: Number(res.dirtyFiles ?? 0),
      extraCommits: Number(res.extraCommits ?? 0),
      path: res.path ?? "",
      triedAt: res.triedAt ?? null,
    })
  }, [])

  const deleteDemo = useCallback(async (): Promise<{ ok: boolean }> => {
    setError(null)
    setBusy("Deleting the demo")
    const res = await del("/api/launcher/demo")
    setBusy(null)
    if (!res.ok) {
      setError(res.reason ?? "The demo could not be deleted.")
      return { ok: false }
    }
    // triedAt survives on the server; mirror that here rather than clearing it,
    // so the empty state does not re-offer the demo the user just removed.
    setDemo((prior) =>
      prior === null ? null : { ...prior, present: false, dirtyFiles: 0, extraCommits: 0 },
    )
    const refreshed = await get("/api/launcher/projects")
    if (refreshed.ok) setProjects(refreshed.projects ?? [])
    return { ok: true }
  }, [])

  return {
    projects,
    busy,
    error,
    openBlock,
    demo,
    refreshDemo,
    deleteDemo,
    clearError: useCallback(() => {
      setError(null)
      setOpenBlock(null)
    }, []),
    openPath,
    inspectPath,
    pickForNewProject,
    cloneForNewProject,
    listGitHubRepos,
    suggestDesignSystems,
    declareDesignSystems,
    inspectReadRoot,
    pickReadRoot,
    setProjectName,
    removeProject,
  }
}
