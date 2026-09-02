import { Router } from "express"
import type { AppDeps } from "../create-app"
import { requireProjectRead, requireProjectWrite, resolveReadContext } from "../auth/authorize"
import type { Participant, StorageAdapter } from "../storage/types"
import { isProjectInsider } from "./field-visibility"
import { MAX_NAME_CHARS, normalizeEmailInput } from "./validate-email"

/**
 * Validates the invite body and returns the normalized email (trimmed,
 * whitespace/control-characters rejected, lowercased) alongside the raw
 * `displayName`, or an error message on failure. Routed through the shared
 * `normalizeEmailInput` (viewer-membership post-review follow-up) rather
 * than a raw `isValidEmail` check, so this write path can no longer store an
 * address carrying interior whitespace or a control character the way
 * `POST /instance/invites` and `POST /projects/:id/members` used to before
 * X5 — see that constant's doc comment in `validate-email.ts`.
 */
function validateInvite(body: unknown): { email: string; displayName?: string } | string {
  if (typeof body !== "object" || body === null) return "email is required"
  const { email: rawEmail, displayName } = body as Record<string, unknown>
  const email = normalizeEmailInput(rawEmail)
  if (email === null) return "email is invalid"
  if (displayName !== undefined && (typeof displayName !== "string" || displayName.length > MAX_NAME_CHARS))
    return "displayName is invalid"
  return { email, displayName: typeof displayName === "string" ? displayName : undefined }
}

/**
 * The wire shape of a participant. `email` is OPTIONAL and OMITTED entirely
 * (never sent as `""`) for a caller who is not a member/owner/admin of the
 * project — the same treatment, and the same reasoning, as
 * `MemberView.email` in `members-routes.ts`.
 *
 * Why this route needed it too (security audit S3): the justifying comment
 * below used to say a participant's email is "self-declared identity" and
 * therefore not worth protecting. That stopped being true when
 * `resolveWriteAuthor` shipped — every comment by a SIGNED-IN user now
 * stamps their server-derived, GitHub-verified address onto the comment, and
 * `upsertAuthorParticipant` copies it straight into this directory. So this
 * route was handing anonymous callers exactly the verified addresses
 * `GET /projects/:id/members` deliberately withholds, plus every
 * invited-but-never-confirmed address. It was a missed route, not a
 * considered exemption.
 *
 * The @-mention picker only ever needs `{id, displayName, status}` — it
 * mentions by opaque id (`mention-encoding.ts`) and renders the email purely
 * as a disambiguator.
 */
export interface ParticipantView {
  id: string
  displayName: string
  status: Participant["status"]
  email?: string
}

function toParticipantView(participant: Participant, includeEmail: boolean): ParticipantView {
  return {
    id: participant.id,
    displayName: participant.displayName,
    status: participant.status,
    ...(includeEmail ? { email: participant.email } : {}),
  }
}

/**
 * Auto-upserts a comment/reply author as an active participant, called
 * after a successful comment write (see comments-routes.ts). A no-op when
 * `author.email` is empty (anonymous/unidentified authors don't populate
 * the directory) OR malformed (comment-create only checks length, not
 * shape — self-declared identity stays permissive there so a typo'd email
 * never blocks a comment; the directory boundary is where shape is
 * enforced, same `normalizeEmailInput` the invite route uses, so the two
 * write paths into the participant table can't disagree on what's valid).
 * Swallows and logs its own errors — a directory-write failure must never
 * fail the comment write it's attached to.
 *
 * `verified` says whether the author identity was derived SERVER-SIDE from a
 * session/PAT (`resolveWriteAuthor`'s identified branch) or merely asserted
 * by the request body. When it was asserted, an existing row's `displayName`
 * is PRESERVED rather than overwritten (security audit K07): an anonymous
 * caller may post a comment claiming `author.email` of a GitHub-verified
 * member, and without this that claim silently renames that member's row in
 * every mention picker on the project. Promotion to `status: "active"` is
 * still allowed for an unverified author — that only ever records "this
 * address has now been seen authoring here", which the comment itself
 * already proves, and the mention-delivery decision does not key off it.
 */
export async function upsertAuthorParticipant(
  storage: StorageAdapter,
  projectId: string,
  author: { email: string; displayName: string },
  options: { verified: boolean },
): Promise<void> {
  const email = normalizeEmailInput(author.email)
  if (email === null) return
  try {
    let displayName = author.displayName || email.split("@")[0]
    if (!options.verified) {
      const existing = (await storage.listParticipants(projectId)).find((p) => p.email === email)
      if (existing) displayName = existing.displayName
    }
    await storage.upsertParticipant(projectId, {
      email,
      displayName,
      status: "active",
    })
  } catch (err) {
    console.error(`[viewer] failed to upsert author participant for project ${projectId}:`, err)
  }
}

// Both routes ARE gated on project visibility (Phase 3b-1 Task 3): a
// non-member can't invite into, or list the participants of, a `members`
// project that already has members. The GET uses `requireProjectRead`; the
// POST — a mutation — uses `requireProjectWrite`, so a `read`-scoped machine
// token is refused 403 rather than being allowed to write the participant
// directory.
//
// The POST ADDITIONALLY requires an IDENTIFIED caller (security audit B5).
// Until that landed, an anonymous visitor on any `public-link` (or
// zero-member) project could seed an arbitrary recipient address here and
// then @-mention it from an equally anonymous comment, causing the
// operator's SMTP identity to deliver attacker-authored content to a
// recipient who never consented — 20 per request, with nothing capping
// repeats. Inviting a HUMAN BY EMAIL is not part of the anonymous-review
// product the way commenting is, and `upsertAuthorParticipant` above already
// covers the legitimate anonymous case: a reviewer entering the directory
// under their OWN address by authoring something. Breaking the chain at the
// invite is therefore the cheapest cut that costs the product nothing.
export function createParticipantsRoutes(deps: AppDeps): Router {
  const router = Router()

  router.get("/projects/:id/participants", async (req, res) => {
    const project = await requireProjectRead(deps, req, res, String(req.params.id))
    if (!project) return
    // Re-resolved for the FIELD decision only — `requireProjectRead` is a
    // guard and deliberately returns just the project. See
    // `field-visibility.ts` for why a guard can't answer this question.
    const ctx = await resolveReadContext(deps, req)
    if ("error" in ctx) {
      res.status(401).json({ error: ctx.error })
      return
    }
    const includeEmail = await isProjectInsider(deps.storage, ctx, project.id)
    const participants = await deps.storage.listParticipants(project.id)
    res.json({ participants: participants.map((p) => toParticipantView(p, includeEmail)) })
  })

  router.post("/projects/:id/participants", async (req, res) => {
    const access = await requireProjectWrite(deps, req, res, String(req.params.id))
    if (!access) return
    const { project, ctx } = access
    // 401, not 403: this is a statement about the CREDENTIAL (there isn't
    // one), identical for every project id the caller could name, so it
    // reveals nothing the readability gate above hadn't already settled.
    // `ctx.user` covers a session cookie AND a machine token (which always
    // resolves to its owning user); `isAdmin` covers an admin bearer sent
    // with no cookie.
    if (!ctx.user && !ctx.isAdmin) {
      res.status(401).json({ error: "Sign in to invite a participant by email" })
      return
    }
    const validated = validateInvite(req.body)
    if (typeof validated === "string") {
      res.status(400).json({ error: validated })
      return
    }
    const { email, displayName } = validated
    const resolvedName = (typeof displayName === "string" ? displayName.trim() : "") || email.split("@")[0]
    const participant = await deps.storage.upsertParticipant(project.id, {
      email,
      displayName: resolvedName.slice(0, MAX_NAME_CHARS),
      status: "pending",
    })
    // Echoed WITH the email: it is the address this caller just sent, so
    // returning it discloses nothing they didn't already know, and the
    // client needs it to render the row it just created.
    res.status(201).json(toParticipantView(participant, true))
  })

  return router
}
