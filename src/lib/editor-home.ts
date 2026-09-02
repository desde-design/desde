/**
 * Editor "home" navigation — the breadcrumb's leading home icon.
 *
 * "Home" is the launcher's project picker (recent checkouts / open a
 * local folder / clone). A editor process is one-repo-per-process, so
 * there's no in-app project list; the launcher is the shared picker.
 *
 * The CLI lazily starts a launcher on the first `GET /api/editor/home`
 * and returns its URL (see editor-cli http-server). We then hard-
 * navigate the top-level window to it in the same tab — mirroring the
 * launcher → editor hop, which also replaces the tab. The launcher
 * process outlives this navigation, so "home" is a real destination.
 */

import { editorFetch } from "@/lib/editor-fetch"

/**
 * Resolve the launcher URL from the CLI and navigate the browser to it.
 * Throws with a human-readable reason on failure so the caller can toast.
 */
export async function goToEditorHome(): Promise<void> {
  const res = await editorFetch("/api/editor/home")
  const json = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    url?: string
    reason?: string
  }
  if (!res.ok || !json.ok || !json.url) {
    throw new Error(
      json.reason ?? `Couldn't open the projects home (${res.status}).`,
    )
  }
  window.location.href = json.url
}
