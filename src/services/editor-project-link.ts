/**
 * Client helper for `POST /api/editor/project/link` — persists the
 * repo↔project association into `.desde/config.json` on the CLI
 * side (the browser can't write the repo). Routed through
 * `editorFetch`, which is a passthrough — the bearer the CLI's `/api/*`
 * guard requires comes from the `window.fetch` monkeypatch in
 * editor-cli/ui-src/src/main.tsx, not from any header added here.
 */

import { editorFetch } from "@/lib/editor-fetch"

export interface ProjectRemoteCheck {
  status: "match" | "mismatch" | "no-remote" | "unparseable" | "unchecked"
  /** Present on `mismatch` — the repo the local `origin` actually points at. */
  actual?: string
  /** Present on `unparseable` — the raw non-GitHub remote URL. */
  remoteUrl?: string
}

export interface LinkProjectResult {
  ok: boolean
  reason?: string
  remote?: ProjectRemoteCheck
}

export async function linkProjectOnDisk(input: {
  projectId: string
  slug: string
  repoFullName?: string
  platformBaseUrl?: string
}): Promise<LinkProjectResult> {
  const res = await editorFetch("/api/editor/project/link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  })
  const json = (await res.json().catch(() => ({}))) as LinkProjectResult
  if (!res.ok || !json.ok) {
    return { ok: false, reason: json.reason ?? `Link failed (HTTP ${res.status})` }
  }
  return json
}
