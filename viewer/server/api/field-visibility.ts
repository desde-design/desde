/**
 * "May this caller see the sensitive FIELDS of this project's records?" —
 * the predicate half of authorization, as distinct from the guards in
 * `../auth/authorize.ts`, which answer "may this caller touch this resource
 * at all" and write their own 404/403 response when the answer is no.
 *
 * The distinction matters because field scoping is not a refusal: the
 * request succeeds either way, and only the projection changes. A guard that
 * sends a response cannot be used to decide what to put IN a response.
 *
 * This exists because the same computation was written inline in
 * `members-routes.ts` (`includeEmail`, the only route that got field scoping
 * right) and nowhere else — which is exactly why `GET /participants` and the
 * comments read path shipped handing GitHub-verified member emails to
 * anonymous callers (security audit S3). One implementation, three call
 * sites, so they cannot drift again.
 *
 * NOTE — the ONE remaining divergence, and why it is exactly one clause wide
 * (M2 review fix). `members-routes.ts`'s `includeEmail` is
 * `hasProjectManageAuthority(ctx) || callerIsListed`. This function is
 * `hasAdminAuthority(ctx) || callerIsListed`. Same shape, same access-list
 * question — the members route additionally admits an `editor`.
 *
 * That extra clause is earned by what the members route is FOR: managing the
 * access list. Adding someone is by email, so a manager who cannot read the
 * addresses already on the list cannot tell two similarly-named colleagues
 * apart, and cannot confirm they removed the right person. `GET /participants`
 * and the comments read path have no roster to manage, so an editor there is
 * just another reader and gets no exemption.
 *
 * Task 11 had briefly widened the members route to `hasAdminAuthority(ctx) ||
 * ctx.user !== null` — any signed-in account on the instance, on the reading
 * that "does this account belong to a colleague" is an instance-level
 * question. It was reverted: on a `public-link` project that route is readable
 * by every signed-in stranger, so the rule handed a project's verified GitHub
 * addresses to `viewer`-role accounts with no connection to it at all. Signing
 * in is not membership of anything.
 */

import { hasAdminAuthority, makeProjectMembership, type ReadContext } from "../auth/authorize"
import type { StorageAdapter } from "../storage/types"

type MembershipStorage = Pick<StorageAdapter, "getProjectMember">

/**
 * True iff the caller holds admin authority, or is a signed-in user holding
 * an access-list row on this project.
 *
 * This is the line that separates "someone with a review link" from "someone
 * deliberately added to this project", and it is the right line for identity
 * disclosure: a member's email is a verified GitHub account identity, and an
 * anonymous holder of a `public-link` URL is not entitled to it just because
 * the panel that renders it happens to load for them too.
 *
 * Deliberately still ACCESS-LIST based, not role-based, unlike
 * `hasProjectManageAuthority`. The question here is "is this person part of
 * this project's roster", which is exactly what a membership row means. An
 * `editor` who can manage the project without being listed on it is
 * authorized to CHANGE that roster, and sees the emails through the members
 * route's own gate rather than by having identity disclosure quietly folded
 * into the manage rule.
 *
 * `hasAdminAuthority` rather than `ctx.isAdmin`: an `admin`-role session must
 * see exactly what the shared `adminToken` bearer sees, or the two admin
 * concepts disagree — which is what they did here until Authorization v2.
 *
 * A machine token resolves to its owning user (see `resolveReadContext`), so
 * a PAT belonging to a member counts as that member here — which is correct:
 * the token cannot see more than the human who minted it.
 */
export async function isProjectInsider(
  storage: MembershipStorage,
  ctx: ReadContext,
  projectId: string,
): Promise<boolean> {
  if (hasAdminAuthority(ctx)) return true
  if (!ctx.user) return false
  const membership = makeProjectMembership(storage)
  return (await membership.getMember(projectId, ctx.user.id)) !== null
}

/*
 * `isProjectOwnerOrAdmin` lived here until Authorization v2 and is GONE. It
 * gated the private repo half of `ProjectView` and the build log on holding
 * an access-list row (originally on `ProjectMember.role === "owner"`, until
 * that column was removed). Both of those are MANAGE-level disclosures — the
 * GitHub App installation id, the raw install/build command line, the
 * `embeddedId` capability — so they now follow the manage rule instead, which
 * is `hasProjectManageAuthority(ctx)` in `../auth/authorize.ts` applied
 * downstream of a read gate.
 *
 * It is not re-exported as a one-line alias on purpose: it took a `storage`
 * and a `projectId` it no longer needs, and keeping that signature would
 * imply this decision still depends on the project, which is precisely the
 * thing v2 changed.
 */
