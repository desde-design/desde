"use client"

/**
 * The @-mention directory for the Editor's comment composer and reply box.
 *
 * The Editor holds no directory of its own: comments written on an unlinked
 * repo go to `.desde/comments.json` on this machine, where there is nobody
 * to mention. When the repo IS linked to a Viewer prototype, the people worth
 * mentioning are that prototype's participants, so this reads the same
 * `GET /projects/:id/participants` route the Viewer's own picker reads.
 *
 * The request goes through the CLI's proxy (`editor-cli/src/server/
 * viewer-proxy.ts`) rather than straight at the viewer, for the reason every
 * viewer call from this page does: the access token is a bearer secret with
 * reach across every prototype its owner can see, and this page also renders
 * a live prototype. The CLI attaches it server-side; it never enters the
 * browser. The proxy forwards any `/api/v1/projects/<configured>/**` path,
 * so this needs no new endpoint.
 *
 * Failure is not surfaced. A directory that will not load costs the user a
 * picker, and blocking or erroring the comment box over it would cost them
 * the comment.
 */

import { useEffect, useState } from "react"
import type { MentionParticipant } from "@/components/annotations/mention-encoding"

/** The wire shape of `ParticipantView` (`viewer/server/api/participants-routes.ts`). */
function isParticipant(v: unknown): v is MentionParticipant {
  if (typeof v !== "object" || v === null) return false
  const p = v as Record<string, unknown>
  return (
    typeof p.id === "string" &&
    typeof p.displayName === "string" &&
    // Present-and-a-string, or absent. The route OMITS `email` for callers
    // who are not prototype insiders (security audit S3), so requiring it
    // would filter out every row and silently empty the picker.
    (p.email === undefined || typeof p.email === "string")
  )
}

/**
 * @param viewerProjectId The linked viewer prototype's id, from
 * `useEditorCommentStore().viewerProjectId`. Null on a local-only repo, and
 * the hook then reports an empty directory without making a request.
 */
export function useEditorParticipants(viewerProjectId: string | null): MentionParticipant[] {
  const [participants, setParticipants] = useState<MentionParticipant[]>([])

  useEffect(() => {
    if (!viewerProjectId) {
      setParticipants([])
      return
    }
    let cancelled = false
    async function load(projectId: string) {
      try {
        const res = await fetch(
          `/api/editor/viewer/api/v1/projects/${encodeURIComponent(projectId)}/participants`,
        )
        if (!res.ok) throw new Error(`GET participants ${res.status}`)
        const data = (await res.json()) as { participants?: unknown }
        const list = Array.isArray(data.participants) ? data.participants.filter(isParticipant) : []
        if (!cancelled) setParticipants(list)
      } catch (err) {
        console.warn(`[editor] could not load the mention directory for ${projectId}:`, err)
        if (!cancelled) setParticipants([])
      }
    }
    void load(viewerProjectId)
    return () => {
      cancelled = true
    }
  }, [viewerProjectId])

  return participants
}
