/**
 * "Who can this reviewer @-mention on this project?"
 *
 * Until this module existed the answer was "whoever is in the project's
 * `participants` table", and that table has exactly two writers: an explicit
 * invite-by-email (`POST /projects/:id/participants`) and
 * `upsertAuthorParticipant`, which runs after somebody posts a comment. So on
 * a freshly connected project the mention picker was EMPTY — an instance with
 * two admitted members offered neither of them, because instance membership
 * never reached the participant directory. You could only mention people who
 * had already commented.
 *
 * That was coherent when a project's participants really were "the people in
 * this review thread". It stopped being coherent when the viewer became
 * invite-only (2026-08-21): a project now defaults to `all-members`, which
 * means every admitted member of the instance can open it, and someone you
 * can see in the members list but cannot mention is just a bug.
 *
 * ## The two id spaces
 *
 * An entry carries EITHER a real `participants.id`, or the synthetic
 * `user:<userId>` of an instance member who has no participant row yet.
 * `resolveMentionIds` (comments-routes.ts) turns the second into the first at
 * WRITE time, by upserting the member into the directory the moment they are
 * actually mentioned. Everything downstream of the write — the notification
 * outbox, the mention email, unsubscribe — keeps working on participant ids
 * alone and needed no change.
 *
 * Materializing at write time rather than at read time is deliberate. A GET
 * that writes would let any reader of a `public-link` project populate the
 * directory with the display names of everyone on the instance, which is
 * precisely the disclosure the scoping below exists to prevent.
 *
 * ## Scoping: the member half is for SIGNED-IN callers only
 *
 * An anonymous holder of a `public-link` URL gets exactly the list they got
 * before this module: the project's own participants, nothing more. Signing in
 * is what makes the instance's roster visible, and that is the same line
 * `field-visibility.ts` draws for email disclosure (security audit S3) — a
 * review link is not membership of anything.
 */

import {
  canReadProject,
  makeProjectMembership,
  type AuthorityContext,
  type ProjectReadPolicy,
} from "../auth/authorize"
import type { Participant, Project, StorageAdapter } from "../storage/types"

/**
 * Marks an entry whose id is a `users.id` rather than a `participants.id`.
 *
 * `:` cannot appear in either id (both are UUIDs), so the prefix is
 * unambiguous, and an id that does not carry it is a participant id exactly as
 * before.
 */
export const USER_MENTION_PREFIX = "user:"

/** Reads the user id out of a `user:`-prefixed mention id, or `null`. */
export function parseUserMentionId(id: string): string | null {
  return id.startsWith(USER_MENTION_PREFIX) ? id.slice(USER_MENTION_PREFIX.length) || null : null
}

/**
 * One mentionable person. Structurally a `Participant` minus the fields the
 * picker never reads, so `toParticipantView` projects it unchanged.
 */
export interface MentionDirectoryEntry {
  id: string
  email: string
  displayName: string
  status: Participant["status"]
}

type DirectoryStorage = Pick<
  StorageAdapter,
  "listParticipants" | "listUsers" | "getUser" | "getProjectMember"
>

/**
 * Every active instance member who can read `project`, as an
 * `AuthorityContext` run through the real `canReadProject` rule.
 *
 * Reusing that function rather than restating "all-members means everyone" is
 * the point: the read rule is exhaustive over `ProjectAccess` and guarded by a
 * `never`, so a fourth access value becomes a build failure there instead of
 * silently making a project's whole instance mentionable here.
 *
 * `isAdmin: false` on every candidate — that flag means "this REQUEST carried
 * the operator's shared bearer", which is a property of a request and not of a
 * person. A candidate who is an `admin`-role account still passes through
 * `hasAdminAuthority` inside the rule.
 */
async function readableMembers(
  storage: DirectoryStorage,
  project: Project,
  policy: ProjectReadPolicy,
) {
  const membership = makeProjectMembership(storage)
  const users = (await storage.listUsers()).filter((u) => u.status === "active")
  const readable = await Promise.all(
    users.map(async (user) => {
      const ctx: AuthorityContext = { user, isAdmin: false }
      return (await canReadProject(ctx, project, membership, policy)) ? user : null
    }),
  )
  return readable.filter((u) => u !== null)
}

/**
 * The project's participant rows, plus — for a signed-in caller — the instance
 * members who can read it and have no row yet.
 *
 * Merged on lowercased email, participants winning: someone who has already
 * commented keeps their real participant id and their stored `status`, so a
 * member who is also a participant appears ONCE. Without that merge the picker
 * would show the same person twice, and the two rows would resolve to the same
 * recipient.
 */
export async function buildMentionDirectory(
  storage: DirectoryStorage,
  caller: AuthorityContext,
  project: Project,
  policy: ProjectReadPolicy,
): Promise<MentionDirectoryEntry[]> {
  const participants = await storage.listParticipants(project.id)
  // Anonymous callers see the pre-existing list, unchanged. See the header.
  if (!caller.user) return participants

  const claimed = new Set(participants.map((p) => p.email.toLowerCase()))
  const members = await readableMembers(storage, project, policy)
  const extra: MentionDirectoryEntry[] = members
    .filter((u) => !claimed.has(u.email.toLowerCase()))
    .map((u) => ({
      id: `${USER_MENTION_PREFIX}${u.id}`,
      email: u.email,
      displayName: u.displayName || u.email.split("@")[0],
      // An admitted member is a real account, not an unconfirmed invite.
      status: "active" as const,
    }))

  return [...participants, ...extra]
}

/**
 * Is this user still allowed to be mentioned on this project — i.e. active,
 * and able to read it?
 *
 * Re-asked at write time rather than trusted from the picker's own output: the
 * `mentions` array is client-submitted, and the gap between loading the picker
 * and sending the comment is long enough for an account to be removed or a
 * project to be switched from `all-members` to `invited`.
 */
export async function isMentionableMember(
  storage: DirectoryStorage,
  userId: string,
  project: Project,
  policy: ProjectReadPolicy,
): Promise<{ email: string; displayName: string } | null> {
  const user = await storage.getUser(userId)
  if (!user || user.status !== "active") return null
  const membership = makeProjectMembership(storage)
  if (!(await canReadProject({ user, isAdmin: false }, project, membership, policy))) return null
  return { email: user.email, displayName: user.displayName || user.email.split("@")[0] }
}
