import { createRoot } from "react-dom/client"
// CLI-specific Tailwind entry. Imports the parent's globals.css and
// adds explicit @source directives so Tailwind v4 scans the parent
// monorepo's component tree (not just editor-cli/ui-src/) for utility
// classes used by the editor panels and shadcn primitives.
import "./editor-cli.css"
import EditorPage from "@/editor-ui/editor-page"
import { LauncherPage } from "@/editor-ui/launcher-page"
import { resolveCliIframeUrl } from "@/lib/editor-deeplink"
import {
  cliBootstrapUserToAuthor,
  setActiveCliUser,
} from "@/lib/cli-user-identity"
import type { DesktopBridge } from "@/types/desktop-bridge"

declare global {
  interface Window {
    /**
     * Present when this bundle is served by the pre-project LAUNCHER
     * (`desde` with no repo path) instead of a editor.
     * Same bundle, two bootstrap modes — the launcher server injects
     * this global, the editor injects `__DESDE_CLI__`, and this
     * entry branches on which one exists.
     */
    __DESDE_LAUNCHER__?: {
      token: string
      shellOrigin: string
      folderPicker: { supported: boolean }
    }
    /**
     * Present only inside the desktop shell (`desktop/preload.ts`'s
     * `contextBridge.exposeInMainWorld`) — absent in a plain browser tab, in
     * both launcher AND editor mode (the preload script re-injects on every
     * top-level navigation within the same window, so it survives the
     * launcher → editor origin change). Every desktop-only affordance checks
     * this first and falls back to the browser-tab behavior when undefined.
     */
    desdeDesktop?: DesktopBridge
    __DESDE_CLI__?: {
      token: string
      shellOrigin: string
      viteUrl: string
      // Detected framework of the supervised prototype (vue3 | react) —
      // the shell's get_page_info reports it to the agent.
      framework?: "vue3" | "react"
      // Detected styling system — the shell builds the matching React
      // inline-style edit (tailwind → className splice; else → inline style).
      stylingSystem?: "tailwind" | "css-modules" | "inline"
      // Phase B — present when the supervisor booted in worktree mode
      // (the default per CLAUDE.md). Drives both the
      // `X-Editor-Session` header propagation and the
      // EDITOR_WORKTREE_MODE feature flag.
      sessionId?: string | null
      worktreePath?: string | null
      // Phase 2 — OS-level author identity for CLI-authored
      // annotations. Comes from `os.userInfo()` + `os.hostname()`
      // server-side; consumed by `useLocalComments` via
      // `getActiveCliUser()`.
      user?: { username?: string; hostname?: string }
    }
  }
}

const launcher = window.__DESDE_LAUNCHER__
const cli = window.__DESDE_CLI__
if (!cli && !launcher) {
  throw new Error(
    "[editor-cli] Bootstrap data missing. The served HTML must inject window.__DESDE_CLI__ or window.__DESDE_LAUNCHER__.",
  )
}

// Install a fetch interceptor that adds the per-session bearer token to
// every same-origin `/api/*` request. The vue3 adapter calls
// `fetch('/api/editor/edit', ...)` without auth headers — this lets it
// keep that web-mode-friendly call site while satisfying the CLI's
// security boundary. (Same mechanism serves the launcher page's
// `/api/launcher/*` calls.)
const token = (cli ?? launcher)!.token
const originalFetch = window.fetch.bind(window)
window.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
  if (url.startsWith("/api/")) {
    const headers = new Headers(init?.headers)
    if (!headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`)
    }
    return originalFetch(input, { ...init, headers })
  }
  return originalFetch(input, init)
}

// Launcher mode: mount the pre-project home page and stop — none of the
// editor bootstrap below (user identity, iframe deeplink) applies.
if (launcher) {
  const launcherRoot = document.getElementById("root")
  if (!launcherRoot) throw new Error("[editor-cli] #root not found in served HTML")
  // The desktop shell's native picker (`dialog.showOpenDialog`) works on
  // every platform Electron runs on — it closes the gap the server-side
  // capability flag has today (osascript, so `supported` is macOS-only).
  const folderPickerSupported =
    launcher.folderPicker.supported || window.desdeDesktop !== undefined
  createRoot(launcherRoot).render(
    <LauncherPage folderPickerSupported={folderPickerSupported} />,
  )
} else {
  mountEditor()
}

function mountEditor() {
  if (!cli) throw new Error("[editor-cli] unreachable: no CLI bootstrap")

  // Phase 2 — register the OS-level author identity so useLocalComments
  // stamps comments with `cli:user@host` instead of the placeholder
  // "Local user" fallback.
  if (cli.user) {
    setActiveCliUser(cliBootstrapUserToAuthor(cli.user))
  }

  // Set the iframe URL for the editor page via the URL bar — the page
  // reads `?url=<vite-url>` to switch into LiveEditorView.
  //
  // On a hard refresh the `?url=` param is already present and carries the
  // prototype page the user had navigated to (EditorSurface mirrors the live
  // route into it via replaceState). Preserving it is what makes a deeplink
  // survive reload instead of bouncing back to the seed page; we only re-base a
  // stale ORIGIN onto the current `viteUrl` (the dev server's port can change
  // across a CLI restart). See resolveCliIframeUrl (NEXT.md §9).
  const params = new URLSearchParams(window.location.search)
  const existingUrl = params.get("url")
  const resolvedUrl = resolveCliIframeUrl(existingUrl, cli.viteUrl)
  if (resolvedUrl !== existingUrl) {
    params.set("url", resolvedUrl)
    window.history.replaceState({}, "", window.location.pathname + `?${params.toString()}`)
  }

  const root = document.getElementById("root")
  if (!root) throw new Error("[editor-cli] #root not found in served HTML")
  createRoot(root).render(<EditorPage />)
}
