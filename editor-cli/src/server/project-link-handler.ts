/**
 * `POST /api/editor/project/link` — associate this local checkout
 * with a viewer project.
 *
 * The client (browser, `src/components/editor/connect-viewer-dialog.tsx`
 * + `src/services/editor-project-link.ts`) creates/picks the project
 * against the viewer's own HTTP API (there is no client-direct project
 * registry — `firestoreService` was removed, see `108430e2` / CLAUDE.md);
 * this handler owns only the local-side effects that a browser can't do:
 *   1. merge-preserving write of `.desde/config.json` (the
 *      committed, team-shared association file — canonical root),
 *   2. a best-effort git-remote sanity check (does this folder's
 *      `origin` actually point at the project's GitHub repo?),
 *   3. updating the machine-local recents registry.
 *
 * Inherits the per-session bearer + strict-Origin guard from the
 * `/api/*` block — it's a mutation, never on the read-only allowlist.
 *
 * The response's `remote` field is advisory: a mismatch does NOT block
 * the link (the user may intend it), it's surfaced for confirmation.
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import { readJsonBody, runHandler, sendJson } from "./artifact-http.js"
import { writeProjectConfig } from "./project-config.js"
import { upsertProjectRegistryEntry } from "./projects-registry.js"
import { checkOriginMatches } from "./git-remote.js"

export const PROJECT_LINK_ROUTE = "/api/editor/project/link"

// Mirror project-config's validation so we reject bad input before the
// write rather than persisting a config the loader would later refuse.
const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/
const PROJECT_ID_RE = /^[A-Za-z0-9_-]+$/

interface ProjectLinkBody {
  projectId?: unknown
  slug?: unknown
  platformBaseUrl?: unknown
  /** `owner/repo` of the project's bound GitHub repo, for the remote check. */
  repoFullName?: unknown
}

/** Mutable in-memory project association the bootstrap re-reads per page load. */
export interface MutableProjectAssociation {
  projectId: string | null
  slug: string | null
  platformBaseUrl: string | null
}

export async function handleProjectLinkRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { canonicalRoot: string; project?: MutableProjectAssociation },
): Promise<void> {
  await runHandler(res, async () => {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, reason: "Method not allowed" })
      return
    }
    const body = await readJsonBody<ProjectLinkBody>(req)

    if (typeof body.projectId !== "string" || !PROJECT_ID_RE.test(body.projectId)) {
      sendJson(res, 400, {
        ok: false,
        reason: "projectId must be alphanumeric with hyphens/underscores",
      })
      return
    }
    if (typeof body.slug !== "string" || !SLUG_RE.test(body.slug)) {
      sendJson(res, 400, {
        ok: false,
        reason: "slug must be lowercase alphanumeric with internal hyphens",
      })
      return
    }
    let platformBaseUrl: string | undefined
    if (body.platformBaseUrl !== undefined) {
      if (typeof body.platformBaseUrl !== "string") {
        sendJson(res, 400, { ok: false, reason: "platformBaseUrl must be a string" })
        return
      }
      // Match readProjectConfig's validation, or we'd persist a config
      // that the next CLI boot rejects as malformed (breaking the link).
      let parsed: URL
      try {
        parsed = new URL(body.platformBaseUrl)
      } catch {
        sendJson(res, 400, {
          ok: false,
          reason: "platformBaseUrl must be an absolute URL",
        })
        return
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        sendJson(res, 400, {
          ok: false,
          reason: "platformBaseUrl must use http: or https:",
        })
        return
      }
      platformBaseUrl = body.platformBaseUrl
    }

    // Best-effort remote check (advisory, never blocks the link).
    let remote:
      | Awaited<ReturnType<typeof checkOriginMatches>>
      | { status: "unchecked" } = { status: "unchecked" }
    if (typeof body.repoFullName === "string" && body.repoFullName.length > 0) {
      remote = await checkOriginMatches(ctx.canonicalRoot, body.repoFullName)
    }

    await writeProjectConfig(ctx.canonicalRoot, {
      projectSlug: body.slug,
      projectId: body.projectId,
      ...(platformBaseUrl !== undefined ? { platformBaseUrl } : {}),
    })

    // Reflect the link into the running CLI's in-memory association so a
    // page reload (which re-emits the bootstrap) stays linked WITHOUT a
    // CLI restart — the bootstrap was captured at boot, before this file
    // existed. Same object the bootstrap builder reads (spread by ref).
    if (ctx.project) {
      ctx.project.projectId = body.projectId
      ctx.project.slug = body.slug
      if (platformBaseUrl !== undefined) ctx.project.platformBaseUrl = platformBaseUrl
    }

    // Reflect the fresh association into the recents cache (best-effort).
    try {
      await upsertProjectRegistryEntry({
        path: ctx.canonicalRoot,
        projectId: body.projectId,
        slug: body.slug,
      })
    } catch {
      // A stale recents entry is harmless; don't fail the link on it.
    }

    sendJson(res, 200, { ok: true, projectId: body.projectId, slug: body.slug, remote })
  })
}
