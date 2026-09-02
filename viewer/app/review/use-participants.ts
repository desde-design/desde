"use client"

import { useCallback, useEffect, useState } from "react"

/**
 * Minimal local shape of Task 2's `Participant` (`viewer/server/storage/types.ts`)
 * — declared here rather than imported, since that type lives under
 * `viewer/server/` which isn't reachable from app code via the `@/*` alias
 * (that alias points at the repo-root `src/`), and pulling server-only code
 * into a `"use client"` hook would blur the client/server boundary for no
 * benefit — this hook only ever needs the wire shape.
 */
export interface ReviewParticipant {
  id: string
  /**
   * Absent for callers who are not project insiders.
   *
   * `GET /projects/:id/participants` omits the field entirely (rather than
   * blanking it) for non-members, so an anonymous reviewer on a public-link
   * project cannot harvest the GitHub-verified email addresses of everyone
   * involved (audit S3).
   *
   * Optional here for that reason. It must NOT be required: the guard below
   * runs on every row, so requiring it would filter out every participant and
   * silently empty the @-mention picker for exactly those callers.
   */
  email?: string
  displayName: string
  status: "active" | "pending"
}

function isReviewParticipant(v: unknown): v is ReviewParticipant {
  if (typeof v !== "object" || v === null) return false
  const p = v as Record<string, unknown>
  return (
    typeof p.id === "string" &&
    // Present-and-a-string, or absent. Same tolerance `app/project-access.tsx`
    // already applies — an omitted email is a redaction, not a malformed row.
    (p.email === undefined || typeof p.email === "string") &&
    typeof p.displayName === "string" &&
    (p.status === "active" || p.status === "pending")
  )
}

export interface UseParticipantsResult {
  participants: ReviewParticipant[]
  reload: () => void
}

/**
 * Fetches the project's participant directory (`GET
 * /api/v1/projects/:id/participants`, Task 2) for the @-mention picker.
 * Tolerates fetch failure — falls back to an empty list and a
 * `console.warn`, never throws — since a directory-load hiccup must never
 * block the comment composer. `reload()` re-fetches (used after an inline
 * "invite by email" so a freshly-invited participant is immediately
 * mentionable).
 */
export function useParticipants(projectId: string): UseParticipantsResult {
  const [participants, setParticipants] = useState<ReviewParticipant[]>([])
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/participants`)
        if (!res.ok) throw new Error(`GET participants ${res.status}`)
        const data = (await res.json()) as { participants?: unknown }
        const list = Array.isArray(data.participants) ? data.participants.filter(isReviewParticipant) : []
        if (!cancelled) setParticipants(list)
      } catch (err) {
        console.warn(`[viewer] failed to load participant directory for project ${projectId}:`, err)
        if (!cancelled) setParticipants([])
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [projectId, reloadToken])

  const reload = useCallback(() => setReloadToken((t) => t + 1), [])

  return { participants, reload }
}
