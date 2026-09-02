import { Router } from "express"
import type { AppDeps } from "../create-app"
import {
  hasProjectManageAuthority,
  requireProjectManage,
  requireReadableProject,
  resolveReadContext,
} from "../auth/authorize"
import type { ProjectMember, StorageAdapter } from "../storage/types"
import { normalizeEmailInput } from "./validate-email"

/**
 * A `ProjectMember` row joined with the identity fields the UI needs —
 * displayName/avatarUrl are on `User`, not `ProjectMember`. `email` is
 * OPTIONAL and omitted entirely (not sent as `""`) for a caller who isn't a
 * member or admin of the project — see `toMemberView`'s `includeEmail`
 * param. Omitting rather than blanking means a client can't mistake "not
 * shown to you" for "this account genuinely has no email."
 *
 * There is no `role` on a member row. `ProjectMember` is an ACCESS-LIST
 * entry: it decides whether its user can read an `invited` project, and
 * nothing else. Per-project authority comes from the caller's INSTANCE role
 * (`hasProjectManageAuthority` in `../auth/authorize.ts`).
 */
export interface MemberView {
  userId: string
  createdAt: string
  email?: string
  displayName: string
  avatarUrl: string
}

/**
 * Joins a `ProjectMember` row with its `User`. Returns `null` for an
 * orphaned membership row (the referenced user was deleted) rather than
 * throwing — storage has no FK enforcement across the two tables, so a
 * defensive skip here keeps one bad row from breaking the whole list.
 *
 * `includeEmail` (Important fix, whole-branch review): `GET
 * /projects/:id/members` is gated only on project READABILITY, which on a
 * `public-link` project (the anonymous-review product) means any
 * unauthenticated visitor can call it. Unlike `participants-routes.ts`'s
 * self-declared display names, a member's `email` is a verified GitHub
 * account identity — that must not be handed to an anonymous reader just
 * because the "Members" panel happens to render for them too. See the route
 * below for exactly who is entitled to it.
 */
async function toMemberView(
  storage: StorageAdapter,
  member: Pick<ProjectMember, "userId" | "createdAt">,
  includeEmail: boolean,
): Promise<MemberView | null> {
  const user = await storage.getUser(member.userId)
  if (!user) return null
  return {
    userId: member.userId,
    createdAt: member.createdAt,
    ...(includeEmail ? { email: user.email } : {}),
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
  }
}

/**
 * `GET /projects/:id/members` (readable-project gated, same rule as every
 * other read path — see `authorize.ts` — but `email` is FURTHER scoped to
 * any signed-in member of the viewer instance or an admin, see
 * `toMemberView`) and `POST`/`DELETE /projects/:id/members` (manage-gated
 * via `requireProjectManage`: admin authority, or an `editor` who can read
 * the project).
 *
 * Invite is by EMAIL, resolving to an EXISTING, ACTIVE `User` — there is no
 * pending-member state in v1 (unlike `participants-routes.ts`'s
 * invite-by-email, which creates a `pending` row for anyone). Identity comes
 * before membership: if nobody has ever signed in with that email, or the
 * account for it was removed, the invite 404s with a plain miss message
 * (Task 11) — the SAME message either way, so the response is not an oracle
 * for "someone used to be here." See the README for why the no-pending-state
 * scope cut is deliberate, not an oversight.
 */
export function createMembersRoutes(deps: AppDeps): Router {
  const router = Router()

  router.get("/projects/:id/members", async (req, res) => {
    // Resolves the caller itself, then hands the read gate to
    // `requireReadableProject` (auth/authorize.ts) — the one implementation of
    // the byte-identical-404 disclosure rule. This route used to inline a COPY
    // of that rule, because it needs the resolved `ctx` after the gate to
    // decide field scoping; the shared function now takes an already-resolved
    // context precisely so a caller in that position does not have to.
    const projectId = String(req.params.id)
    const ctx = await resolveReadContext(deps, req)
    if ("error" in ctx) {
      res.status(401).json({ error: ctx.error })
      return
    }
    const project = await requireReadableProject(deps, res, ctx, projectId)
    if (!project) return

    // WHO GETS `email` (M2 review fix). Two ways to be entitled to it, and
    // both are about this PROJECT:
    //
    //   1. `hasProjectManageAuthority` — an admin, or an `editor`. Emails are
    //      how the access list is managed: "add by email" is the only way to
    //      put someone on it, and a manager who cannot see the addresses
    //      already on it cannot tell two similarly-named colleagues apart.
    //   2. The caller holds a membership row on THIS project. They are a
    //      colleague on it, and their own address is already in the list they
    //      are being shown.
    //
    // Task 11 had widened this to `ctx.user !== null` — ANY signed-in account
    // on the instance. That is too wide: it hands every verified GitHub
    // address on a project's roster to a `viewer`-role account that has
    // nothing to do with that project, and on a `public-link` project the
    // route is readable by every signed-in stranger. Signing in is not
    // membership of anything.
    //
    // `hasProjectManageAuthority` rather than `hasAdminAuthority`: an admin
    // must see what the shared `adminToken` bearer sees (the manage predicate
    // already includes both), and an editor who can EDIT the list must be able
    // to READ it.
    //
    // Note this now converges with `isProjectInsider` (field-visibility.ts)
    // rather than diverging from it: both say "admin authority, or a row on
    // this project", and this one additionally admits an editor because
    // editing the roster is the whole reason this panel exists. They are still
    // two functions — `isProjectInsider` gates the participants/comments read
    // paths, where there is no roster to manage and so no editor exemption.
    const callerIsListed =
      ctx.user !== null && (await deps.storage.getProjectMember(project.id, ctx.user.id)) !== null
    const includeEmail = hasProjectManageAuthority(ctx) || callerIsListed

    const members = await deps.storage.listProjectMembers(project.id)
    const views = await Promise.all(members.map((m) => toMemberView(deps.storage, m, includeEmail)))
    res.json({ members: views.filter((v): v is MemberView => v !== null) })
  })

  router.post("/projects/:id/members", async (req, res) => {
    const project = await requireProjectManage(deps, req, res, String(req.params.id), "manage members")
    if (!project) return

    // `{ email }` only. The body used to also accept a `role`; `ProjectMember`
    // no longer carries one.
    //
    // X5: `normalizeEmailInput` trims and lowercases before the lookup below
    // — the raw value used to be handed to `getUserByEmail` unnormalized, so
    // a caller whose email carried surrounding whitespace (which
    // `getUserByEmail` does not strip, only lowercase) would 404 as "not a
    // member" even for an address that genuinely was one.
    const { email: rawEmail } = (req.body ?? {}) as Record<string, unknown>
    const email = normalizeEmailInput(rawEmail)
    if (email === null) {
      res.status(400).json({ error: "email is invalid" })
      return
    }

    const user = await deps.storage.getUserByEmail(email)
    // Task 11: a removed account is refused with the SAME message as an
    // email nobody has ever signed in with — no oracle here for "someone
    // used to be here." `user.status !== "active"` reads as `=== "removed"`
    // today (`UserStatus` is only those two values), written this way so a
    // future status is refused by default rather than silently admitted.
    if (!user || user.status !== "active") {
      res.status(404).json({
        error:
          "That email doesn't belong to a member of this viewer yet. Invite them from Settings first.",
      })
      return
    }

    const added = await deps.storage.addProjectMember({ projectId: project.id, userId: user.id })
    // `true` unconditionally, and it discloses nothing: the caller supplied
    // this exact email in the request body a few lines up, so echoing it back
    // cannot tell them anything they did not already know. (The GET route's
    // `includeEmail` is the real disclosure gate — it lists OTHER people.)
    const view = await toMemberView(deps.storage, added, true)
    res.status(201).json(view)
  })

  router.delete("/projects/:id/members/:userId", async (req, res) => {
    const project = await requireProjectManage(deps, req, res, String(req.params.id), "manage members")
    if (!project) return
    const userId = String(req.params.userId)

    /*
      No last-member guard. Removing the final person from an invite-only
      project is allowed, and it is allowed for everyone `requireProjectManage`
      already admits.

      There WAS one, from Phase 3b-1 Task 4 until 2026-08-29: an `editor` who
      drained an `"invited"` roster to zero locked themselves out along with
      everyone else, because their read of that project came from the access
      list, so the route refused with a 400. Admins were exempted later, since
      `canReadProject` admits admin authority regardless of the roster.

      Mo removed it: "people can lock themselves out if they want to and then
      ask an Admin if they make a mistake."

      That is a product call about who owns the consequence, and it is worth
      being clear that NOTHING is exposed by it. Removal never touches
      `access`, so an emptied roster cannot reopen a project to anyone — the
      failure mode is strictly the other way, a project only Admins can
      read. It is recoverable in one step by any Admin, which the guard's own
      exemption already proved, and the guard was buying that recovery at the
      price of an editor dismantling a roster having to add a throwaway member
      to delete afterwards.

      What went with the guard: a `getProjectMember` lookup, a `getUser` on the
      target, a full `listProjectMembers` plus a `getUser` per row, and the
      `getRequestContext`/`hasAdminAuthority` pair that decided the exemption.
      Every one of those existed only to answer "would this be the last active
      member", so a DELETE is now one storage call.
    */
    await deps.storage.removeProjectMember(project.id, userId)
    res.status(204).end()
  })

  return router
}
