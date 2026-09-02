/**
 * Server-side storage seam.
 *
 * One impl per profile: SQLite (selfhost) and Firestore (gcp, Phase 4).
 * Every impl runs `storageAdapterContract` so "swap the backend and the
 * viewer behaves identically" is a checked property, not a hope — the
 * same discipline `commentStoreContract` applies in src/composer.
 *
 * Keep this interface free of vendor concepts (no SQL, no documents).
 */

import type { Comment, CommentAuthor, CommentPosition } from "@/types/bridge"

/**
 * Who may read a project (viewer-membership Task 9 — replaces the old
 * `ProjectVisibility` two-state field).
 *
 * - `"all-members"` — every signed-in member of this INSTANCE can read it.
 *   No per-project access list is consulted.
 * - `"invited"` — only the users on the project's `project_members` access
 *   list (plus anyone holding admin authority) can read it.
 * - `"public-link"` — anyone with the URL, signed in or not, WHILE the
 *   instance-wide public-link kill switch is on. With it off, a
 *   `"public-link"` project behaves exactly as `"all-members"`.
 *
 * The authorization rule that consumes this is `canReadProject`
 * (`server/auth/authorize.ts`), which is where the exhaustive per-value
 * behaviour is written down — including the kill switch and the fail-closed
 * default. This declaration is the storage shape only; adding a value here
 * deliberately fails to compile there until the rule is updated.
 *
 * Read authority and MANAGE authority are separate questions: reading is
 * this field plus the access list, while renaming, connecting a repo,
 * building or editing the roster is decided by the caller's `InstanceRole`
 * (`hasProjectManageAuthority`). A `ProjectMember` row grants access, never
 * authority.
 */
export type ProjectAccess = "all-members" | "invited" | "public-link"

/**
 * GitHub App-backed repo + build settings (Phase 3c-1). Set via
 * `StorageAdapter.setProjectRepoConfig`, cleared via
 * `clearProjectRepoConfig`. No build execution reads this yet — Phase 3c-2
 * (`BuildRunner`) is the first consumer; this phase only records it.
 */
export interface ProjectRepoConfig {
  /** The GitHub App installation this repo is reachable through. */
  installationId: number
  owner: string
  name: string
  /** The repo's default branch, as reported by GitHub at connect time — informational, not necessarily what gets built. */
  defaultBranch: string
  /** The branch actually built. */
  branch: string
  installCommand: string
  buildCommand: string
  outputDir: string
  /** Whether a push to `branch` should trigger a rebuild. Consumed starting Phase 3c-3; stored now. */
  autoDeploy: boolean
}

export interface Project {
  id: string
  /** URL-safe identifier used in /p/{slug}/ and in .desde/config.json. */
  slug: string
  name: string
  /**
   * A repo URL for DISPLAY / the legacy bundle-upload path — set directly
   * by whoever creates or edits the project (e.g.
   * "https://github.com/acme/proto"), free text, never validated against a
   * GitHub App installation. Deliberately independent of `repoConfig`
   * below: a project can have a `repoUrl` with no `repoConfig` (repo noted
   * for reference, prototype actually built by manual bundle upload), or a
   * `repoConfig` with no `repoUrl` (connected via the App; Phase 3c-1 does
   * not derive a display URL automatically). A later connect-repo route MAY
   * choose to also set `repoUrl` from `repoConfig.owner`/`repoConfig.name`
   * for display convenience — that's an API-layer decision, deliberately
   * not made here, so the storage layer doesn't silently couple the two.
   */
  repoUrl: string | null
  access: ProjectAccess
  /** Deployment currently served at /p/{slug}/. Null until the first upload. */
  activeDeploymentId: string | null
  /** GitHub App repo + build config. Null until connected — see `ProjectRepoConfig`'s doc comment. */
  repoConfig: ProjectRepoConfig | null
  /**
   * The project id embedded in the prototype repo's `.desde/config.json`,
   * once this project has adopted it. Null until then.
   *
   * This is the JOIN KEY between the Viewer and the Editor, and it is
   * deliberately separate from `id`: this project's own id is local to this
   * viewer instance, whereas the embedded id travels with the repo through
   * clones, renames and transfers. Unique across projects — two repos carrying
   * one id is the fork case, and letting the second claim it would silently
   * re-point comments.
   */
  embeddedId: string | null
  /** ISO-8601 UTC timestamp. Not guaranteed unique; `createdAt` has millisecond resolution. */
  createdAt: string
}

export interface ProjectCreateInput {
  slug: string
  name: string
  repoUrl?: string | null
  /** Defaults to `"all-members"` when omitted. */
  access?: ProjectAccess
}

export interface ProjectUpdatePatch {
  name?: string
  repoUrl?: string | null
  access?: ProjectAccess
  activeDeploymentId?: string | null
}

export type DeploymentStatus = "building" | "deployed" | "failed"

/**
 * A single root-absolute asset reference found by the deploy-time scan
 * (`build/root-absolute-scan.ts`) — see that module's header comment for
 * the three patterns and why each is anchored the way it is.
 */
export type RootAbsoluteAssetFindingKind = "html-attr" | "css-url" | "js-runtime-base"

export interface RootAbsoluteAssetFinding {
  /** Repo-relative path of the file the reference was found in. */
  file: string
  kind: RootAbsoluteAssetFindingKind
  /** A short excerpt of the matched text — enough to locate it, not the whole line. */
  sample: string
}

/**
 * A structured, deploy-time warning attached to a `Deployment`. `kind` is a
 * discriminant so a future warning type can be added without a schema
 * change — today there is exactly one.
 */
export interface DeploymentWarning {
  kind: "root-absolute-assets"
  summary: string
  findings: RootAbsoluteAssetFinding[]
}

/**
 * One named phase of a build, for the deployment detail's step list.
 *
 * The phases are FIXED and generic — Clone, Install, Build, Publish — not the
 * commands that implement them. That is a privacy decision, not a naming one:
 * a step called `npm ci --registry=https://internal.acme/…` would put the
 * operator's install line in front of every project reader, which is exactly
 * what `buildLog` is withheld from non-owners to prevent. Names carry no
 * project-specific content, so steps ship to everyone who can read the
 * project while the log stays owner-only.
 *
 * `endedAt` is absent while a step runs. A step that never started is simply
 * not in the list — a build that fails at Install records Clone and Install
 * and stops, rather than padding the list with `pending` rows the runner
 * cannot promise it will reach.
 */
export interface BuildStep {
  name: "Clone" | "Install" | "Build" | "Publish"
  status: "running" | "succeeded" | "failed"
  /** ISO-8601 UTC. */
  startedAt: string
  /** ISO-8601 UTC, absent while the step is still running. */
  endedAt?: string
}

export interface Deployment {
  id: string
  projectId: string
  status: DeploymentStatus
  commitSha: string | null
  /**
   * The built commit's SUBJECT line (git's `%s`), or `null` — an uploaded
   * bundle has no commit, and rows predate the field. Captured by the build
   * runner at clone time, the same moment `commitSha` is resolved, so
   * webhook and manual builds record it through one code path. The
   * deployment cards render it beside the sha (Mo, 2026-08-30: "the title
   * or description of the push").
   */
  commitMessage: string | null
  buildLog: string
  /**
   * Deploy-time warnings recorded by the build/upload lane, or `null` when
   * none were found. Always recorded (including `null`) rather than left
   * absent — whether a project's CURRENT access + serve mode makes a
   * warning worth showing is a UI-time decision (access can change after
   * the deployment is created), not a scan-time one. See
   * `build/root-absolute-scan.ts`.
   */
  warnings: DeploymentWarning[] | null
  /**
   * The build's phases, or `null` for a deployment that never ran one — an
   * uploaded bundle, or a row created before this field existed.
   *
   * `null` and `[]` mean different things and both occur: `null` is "this
   * deployment has no phases to show", `[]` is "a build started and has not
   * recorded its first phase yet". The UI renders nothing for the first and a
   * running Clone for the second.
   */
  steps: BuildStep[] | null
  /** ISO-8601 UTC timestamp. Not guaranteed unique; `createdAt` has millisecond resolution. */
  createdAt: string
}

export interface DeploymentCreateInput {
  projectId: string
  status?: DeploymentStatus
  commitSha?: string | null
}

export interface DeploymentUpdatePatch {
  status?: DeploymentStatus
  buildLog?: string
  /**
   * The commit actually built. A build triggered on a BRANCH creates its
   * deployment before knowing the sha, so the runner resolves it during the
   * clone and it has to be writable afterwards — without this a
   * branch-triggered deployment permanently records `commitSha: null` and
   * nothing can say what is deployed. Found by a live build, not a test:
   * the runner already returned the sha and it was silently dropped.
   */
  commitSha?: string | null
  /** The built commit's subject line — resolved by the runner with the sha. */
  commitMessage?: string | null
  warnings?: DeploymentWarning[] | null
  /**
   * Replaces the whole list, rather than appending one step.
   *
   * The runner holds the authoritative array and rewrites it at each phase
   * boundary, which is a handful of writes per build — not the per-chunk
   * traffic that made `appendDeploymentLog` need its own append path.
   */
  steps?: BuildStep[] | null
}

/** Input for creating a comment. The author snapshot is denormalized — no user table exists until Phase 3. */
export interface StoredCommentInput {
  position: CommentPosition
  body: string
  author: CommentAuthor
  mentions?: string[]
}

export interface StoredCommentPatch {
  body?: string
  resolved?: boolean
  mentions?: string[]
}

export interface StoredCommentReplyInput {
  body: string
  author: CommentAuthor
  mentions?: string[]
}

/**
 * Project participant directory entry.
 * Active = has authored on the project; pending = invited by email, not yet seen.
 * `userId` linkage arrives with Phase 3 auth.
 */
export interface Participant {
  id: string
  projectId: string
  email: string
  displayName: string
  status: "active" | "pending"
  createdAt: string
}

export interface NotificationOutbox {
  id: string
  projectId: string
  commentId: string
  replyId: string | null
  recipientIds: string[]
  status: "pending" | "sending" | "sent" | "error"
  createdAt: string
}

export interface EnqueueNotificationInput {
  projectId: string
  commentId: string
  replyId?: string | null
  recipientIds: string[]
}

/**
 * What a user may do on this INSTANCE. `ProjectMember` (below) carries no
 * role of its own as of viewer-membership Task 9 — project membership is a
 * flat access-list entry, and per-project authority is decided from this
 * field instead.
 *
 * Ordered by authority, but deliberately NOT a number: nothing should be
 * comparing these with `>`. Every gate names the roles it accepts.
 */
export type InstanceRole = "admin" | "editor" | "viewer"

/**
 * Whether the account may still be used. `removed` is a soft delete: the row
 * stays, so every comment, membership and mention stamped with this id still
 * resolves to a name, but the person can no longer sign in (Task 4 onwards).
 */
export type UserStatus = "active" | "removed"

/**
 * An account on this viewer instance.
 *
 * **Email is the identity.** It is unique instance-wide, which is what lets
 * an invite, a mention or a sign-in resolve to exactly one account. Audit S18
 * previously had to refuse an ambiguous email at READ time because two rows
 * could hold one address; the uniqueness constraint means that state can no
 * longer form.
 *
 * A provider identity is an ATTACHMENT to that account, not its key: an
 * account can exist with none (invited by email, never signed in) and gains
 * one the first time its owner signs in — see `linkProviderIdentity`.
 */
export interface User {
  id: string
  /** How the account was created, or last linked. */
  provider: "github" | "email"
  /** Null for email-created accounts never linked to a provider. */
  providerUserId: string | null
  /** Stored lowercased. UNIQUE across the instance — this is the identity. */
  email: string
  displayName: string
  avatarUrl: string
  role: InstanceRole
  status: UserStatus
  createdAt: string
}

export interface CreateUserInput {
  provider: "github" | "email"
  providerUserId: string | null
  email: string
  displayName: string
  avatarUrl: string
  role: InstanceRole
}

/** Fields a user (or an admin) may change without touching role or status. */
export interface UserProfilePatch {
  email?: string
  displayName?: string
  avatarUrl?: string
}

/**
 * One GitHub App installation a user could see at their last sign-in, plus
 * the repos WITHIN it that this user can personally reach.
 *
 * The second half exists because the first is not an access decision
 * (security audit B4). GitHub grants an *installation* access to a set of
 * repos; an individual org member may be denied most of them. Authorizing a
 * repo connect on installation visibility alone therefore let any signed-in
 * org member attach — and so clone, build and read — a private repo GitHub
 * itself would refuse them.
 */
export interface UserInstallationEntry {
  installationId: number
  /**
   * `owner/name`, LOWERCASED, for every repo in this installation the USER
   * can access — captured from `GET /user/installations/{id}/repositories`
   * with the user's own token, which is the only endpoint that answers the
   * per-user question at all.
   *
   * Three states, all distinct and all meaningful:
   * - a non-empty array — exactly these repos;
   * - `[]` — GitHub answered, and this user can reach NONE of them;
   * - `null` — the capture did not run or failed. Consumers MUST treat this
   *   as "authorizes nothing" (see `filterReposForCaller`), never as
   *   "unrestricted": an unknown entitlement must never be the permissive
   *   branch. It is the state every pre-B4 user is in until they sign in
   *   again, which is exactly the same refresh story the id set already has.
   */
  repoFullNames: string[] | null
}

/**
 * The GitHub App installations a specific user could see, as captured
 * during their most recent sign-in (Phase 3c-1b T2). This is authorization
 * INPUT: `GET /github/installations`, `/:id/repos` and
 * `PUT /projects/:id/repo` all filter against it, so nothing here may ever
 * originate from a client request body — the OAuth callback is the only
 * writer.
 *
 * It is a snapshot, not a live query: `syncedAt` says how old it is, and
 * `caller-installations.ts` refuses to honour one older than its max age.
 * There is deliberately no stored credential to refresh it with — signing
 * in again is the refresh.
 */
export interface UserInstallations {
  /**
   * One entry per installation. Carries the per-installation repo
   * entitlement alongside the id so the two can never disagree: they are
   * captured together and written in ONE transaction, so there is no
   * interleaving in which a user is authorized for an installation whose
   * repo set came from a different sign-in.
   */
  installations: UserInstallationEntry[]
  /** ISO-8601 UTC timestamp of the sign-in that captured this set. */
  syncedAt: string
}

/** Server-side session (opaque handle for sign-in state). */
export interface Session {
  id: string
  userId: string
  createdAt: string
  expiresAt: string
}

/**
 * One row on a project's access list (viewer-membership Task 9). `role` is
 * GONE — membership is now a flat yes/no; per-project authority (who may
 * manage vs. merely read) is decided from the user's INSTANCE role
 * (`InstanceRole`, above) starting Task 10, not from a per-membership field.
 */
export interface ProjectMember {
  projectId: string
  userId: string
  createdAt: string
}

export type MachineTokenScope = "read" | "write"

/**
 * A user-owned, named, scoped, revocable personal-access token (Phase 3b-2).
 * Authenticates AS its owning user — see `server/auth/machine-token.ts` for
 * mint/verify. Only `tokenHash` (never the plaintext secret) is persisted.
 */
export interface MachineToken {
  id: string
  userId: string
  name: string
  scopes: MachineTokenScope[]
  tokenHash: string
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
}

export interface MachineTokenCreateInput {
  /**
   * 16-hex-char public id segment, generated by `machine-token.ts`'s
   * `generateMachineToken` (NOT by the storage impl — unlike `User`/`Session`
   * ids, this one has to match the id embedded in the `dsv_<id>_<secret>`
   * token the caller was handed).
   */
  id: string
  userId: string
  name: string
  scopes: MachineTokenScope[]
  tokenHash: string
  expiresAt?: string | null
}

/**
 * An admin-minted invitation to join this instance (viewer-membership
 * Task 3). Only `tokenHash` is ever stored — the plaintext token is minted
 * and shown once by a later task, exactly like `MachineToken`.
 */
export interface InstanceInvite {
  /** 16-hex public id, embedded in the token — same convention as `MachineToken`. */
  id: string
  /** Stored lowercased. */
  email: string
  role: InstanceRole
  tokenHash: string
  /** `null` means the invite was minted via the instance's adminToken bearer, not by a signed-in admin. */
  createdByUserId: string | null
  createdAt: string
  expiresAt: string
  usedAt: string | null
  revokedAt: string | null
}

/**
 * A single-use sign-in token: either a magic link / admin-issued link to an
 * EXISTING account (`userId` set), or a domain-rule self-serve join for an
 * address that has no account yet (`email` set). Exactly one of the two is
 * ever non-null — enforced by a `CHECK` constraint on the SQLite side, and
 * by an explicit guard in both impls so the refusal carries a readable
 * message rather than surfacing as a raw constraint violation.
 */
export interface SignInToken {
  id: string
  userId: string | null
  /** Stored lowercased when set. */
  email: string | null
  tokenHash: string
  /**
   * REAL wall-clock time, in both impls.
   *
   * Worth stating because the in-memory adapter stamps most `createdAt`
   * fields from a synthetic monotonic counter (see `nextTimestamp`), which is
   * fine for ordering and useless for anything compared against `Date.now()`.
   * `hasRecentSignInTokenForSubject` does exactly that comparison, on behalf
   * of a rate control — so a synthetic clock here would let the two impls
   * silently disagree about whether the throttle fires at all, which is the
   * class of divergence the shared contract suite exists to catch.
   */
  createdAt: string
  expiresAt: string
  usedAt: string | null
}

/**
 * An instance-wide rule: anyone signing in with an email at `domain` is
 * auto-admitted at `role`, no invite needed. `domain` is the primary key —
 * one rule per domain.
 */
export interface DomainRule {
  /** Stored lowercased, no leading `@`. */
  domain: string
  role: InstanceRole
  createdByUserId: string | null
  createdAt: string
}

export interface StorageAdapter {
  createProject(input: ProjectCreateInput): Promise<Project>
  getProject(id: string): Promise<Project | null>
  getProjectBySlug(slug: string): Promise<Project | null>
  /**
   * List all projects ordered oldest-first by `createdAt`. When two
   * projects share a `createdAt` value, the impl MUST break the tie by
   * creation order (earliest created first) — necessary because
   * `createdAt` has millisecond resolution and is not guaranteed unique.
   */
  listProjects(): Promise<Project[]>
  updateProject(id: string, patch: ProjectUpdatePatch): Promise<Project>
  /**
   * Cascades to every row this project owns, atomically (M4 — SqliteStorage
   * wraps the whole cascade in one transaction, so a mid-delete crash can
   * never leave the project half-gone): `comments`, `deployments`,
   * `participants`, `notification_outbox`, `notification_optouts`,
   * `project_members` (the access list), `project_repo_configs` (the
   * GitHub App connection), and `project_embedded_ids` (the Editor join
   * key), before the `projects` row itself.
   */
  deleteProject(id: string): Promise<void>

  /**
   * Set (create or wholesale-replace) a project's GitHub App repo + build
   * config. There is no partial-patch variant — the connect-repo route
   * always has the full form, so a second call fully replaces the first
   * rather than merging. Throws NotFoundError if the project doesn't exist.
   */
  setProjectRepoConfig(projectId: string, config: ProjectRepoConfig): Promise<Project>

  /**
   * Adopt a repo-embedded project id. Idempotent for the SAME project; throws
   * if another project already claims that id (the fork case), and
   * NotFoundError if the project doesn't exist.
   */
  setProjectEmbeddedId(projectId: string, embeddedId: string): Promise<Project>

  /** Look a project up by the id embedded in its repo. Null when unclaimed. */
  getProjectByEmbeddedId(embeddedId: string): Promise<Project | null>

  /**
   * Look a project up by its connected GitHub repo — the discovery index that
   * lets the Editor ask "do you already have a project for this remote?"
   * before minting a new one. Matched case-INSENSITIVELY, because GitHub
   * treats owner/name that way and a case-sensitive lookup would mint a
   * duplicate project for the same repo.
   */
  getProjectByRepo(owner: string, name: string): Promise<Project | null>

  /**
   * Clear a project's repo config back to null. Idempotent on the config
   * itself (clearing an already-clear config is a no-op, not an error) —
   * but still throws NotFoundError if the PROJECT doesn't exist, mirroring
   * `updateProject`. Must not touch deployments or `activeDeploymentId`.
   */
  clearProjectRepoConfig(projectId: string): Promise<Project>

  createDeployment(input: DeploymentCreateInput): Promise<Deployment>
  getDeployment(id: string): Promise<Deployment | null>
  /**
   * List deployments for a project ordered newest-first by `createdAt`.
   * When two deployments share a `createdAt` value, the impl MUST break the tie by
   * creation order (most recently created first). This is necessary because `createdAt`
   * has millisecond resolution; an impl backed by a real clock needs a deterministic
   * secondary ordering key (e.g., insertion sequence or SQL rowid).
   */
  listDeployments(projectId: string): Promise<Deployment[]>
  updateDeployment(id: string, patch: DeploymentUpdatePatch): Promise<Deployment>
  /**
   * Appends to a deployment's build log, bounded by `maxBytes`.
   *
   * An APPEND rather than a read-modify-write through `updateDeployment`:
   * a build emits log chunks continuously for minutes, and having each
   * caller read the whole log, concatenate, and write it back is both
   * quadratic and a lost-update race between the runner's chunks and the
   * terminal status write.
   *
   * Once `maxBytes` is reached the log stops growing and a truncation
   * marker is appended ONCE. Truncating silently would leave an operator
   * reading a log that simply stops mid-sentence with no indication that
   * the build kept going.
   */
  appendDeploymentLog(id: string, chunk: string, maxBytes: number): Promise<void>

  /**
   * Flip every deployment still `"building"` to `"failed"`, appending
   * `INTERRUPTED_BUILD_LOG_LINE` (`log-append.ts`) to each one's log.
   * Returns the number of rows flipped.
   *
   * Called once at boot (`server/index.ts`), before the app starts serving.
   *
   * The build queue (`server/build/build-queue.ts`) is in-process and holds
   * no durable state of its own. A graceful shutdown gets one chance to mark
   * an in-flight build `"failed"` before the process exits
   * (`buildQueue.shutdown()`, wired to SIGINT/SIGTERM in `server/index.ts`)
   * — but a crash or a `SIGKILL` skips that entirely, and nothing else ever
   * moves a `"building"` row out of that status. Left alone, that row is a
   * spinner in the UI that can never resolve, and it trips
   * `DELETE /projects/:id`'s still-building guard (fix wave 7, item 2)
   * forever — the project becomes permanently undeletable, not just while a
   * build is actually running.
   */
  markInterruptedBuildsFailed(): Promise<number>

  /** Oldest-first by per-project sequential `number`. */
  listComments(projectId: string): Promise<Comment[]>
  getComment(commentId: string): Promise<Comment | null>
  /** Assigns the next per-project `number` (starting at 1). */
  createComment(projectId: string, input: StoredCommentInput): Promise<Comment>
  /** Throws NotFoundError on a missing id. `undefined` patch fields never overwrite. */
  updateComment(commentId: string, patch: StoredCommentPatch): Promise<Comment>
  addCommentReply(commentId: string, reply: StoredCommentReplyInput): Promise<Comment>
  deleteComment(commentId: string): Promise<void>

  /** List participants for a project, oldest-first by `createdAt` (creation-order tie-break). */
  listParticipants(projectId: string): Promise<Participant[]>
  getParticipant(participantId: string): Promise<Participant | null>
  /**
   * Insert a participant or update an existing one. Deduped by (projectId, lowercased email).
   * If participant exists: update `displayName`, and PROMOTE `pending`→`active` if incoming status
   * is `active` (never demote active→pending). Otherwise insert.
   */
  upsertParticipant(projectId: string, input: { email: string; displayName: string; status: "active" | "pending" }): Promise<Participant>

  /** Enqueue a mention notification (status: pending). */
  enqueueNotification(input: EnqueueNotificationInput): Promise<NotificationOutbox>

  /** List all pending notifications, oldest-first by createdAt. */
  listPendingNotifications(limit: number): Promise<NotificationOutbox[]>

  /**
   * Atomically claim a pending notification for processing.
   * Returns true iff THIS call flipped the row from pending→sending (exactly once).
   * A second claim of the same row returns false.
   */
  claimNotification(id: string): Promise<boolean>

  /** Set terminal status (sent or error). Throws NotFoundError on missing. */
  setNotificationStatus(id: string, status: "sent" | "error"): Promise<void>

  /** Get a notification by id, or null if not found. */
  getNotification(id: string): Promise<NotificationOutbox | null>

  /**
   * Record an opt-out (per-project, or `projectId: null` for the row this
   * type calls "global"). Idempotent.
   *
   * NOTE: "global" here is per-*participant*, not per-person — participants
   * are per-project rows (a distinct id per `(project_id, email)` pair), so
   * this can't yet suppress mail for the same human in a DIFFERENT project.
   * Don't surface it to users as "unsubscribe from everything" until Phase 3
   * identity unification gives one id per person across projects; see
   * `unsubscribeConfirmationHtml` in `notify/mention-email.ts` for where
   * that copy boundary is enforced today.
   */
  recordOptout(input: { participantId: string; projectId: string | null }): Promise<void>

  /** Check if a participant is opted out (per-project, or via the `projectId: null` row — see `recordOptout`'s note on why that isn't cross-project yet). */
  isOptedOut(participantId: string, projectId: string): Promise<boolean>

  /**
   * Create an account. `email` is lowercased on the way in; `status` starts
   * `active`; `id` and `createdAt` are assigned by the impl.
   *
   * Throws `ConflictError` when the email is already held by ANY existing
   * row (including a `removed` one — a removed person's address is still
   * theirs, and a second row for it would recreate exactly the audit-S18
   * ambiguity this constraint exists to prevent), or when a non-null
   * `(provider, providerUserId)` is already held.
   *
   * There is deliberately no upsert. `upsertUser` — which created an account
   * as a side effect of looking one up — was the reason every sign-in was
   * also an admission decision; the caller now has to say which of "find",
   * "link" and "create" it means.
   */
  createUser(input: CreateUserInput): Promise<User>

  /**
   * Atomically create the FIRST account on an otherwise-empty instance —
   * refuses by returning `null` when any account already exists (a
   * `removed` one included, same as `countUsers`).
   *
   * Exists because `countUsers() === 0` then `createUser` is two separate
   * awaits, and two concurrent first sign-ins could both observe zero
   * between them — both would then be created as admin. This closes that
   * window by making the check and the insert one atomic operation: a
   * single `BEGIN IMMEDIATE` transaction for SQLite, and for the in-memory
   * impl, no `await` between the check and the write (JS run-to-completion
   * makes that ordering atomic without a lock).
   *
   * `status` starts `active`, same as `createUser`. Never throws
   * `ConflictError` — an empty instance has no existing row for the input's
   * email or provider identity to collide with, by construction.
   */
  createUserIfInstanceEmpty(input: CreateUserInput): Promise<User | null>

  /**
   * Patch a user's profile. Omitted fields are left alone; `email` is
   * lowercased. Throws `NotFoundError` for a missing user, and
   * `ConflictError` when the new email is held by a DIFFERENT account
   * (re-writing the account's own address is a no-op, not a conflict).
   *
   * Cannot change `role` or `status` — those have their own methods, because
   * "GitHub told us this person's display name changed" and "an admin
   * changed what this person may do" must never travel on one call.
   */
  updateUserProfile(userId: string, patch: UserProfilePatch): Promise<User>

  /**
   * Attach a provider identity to an account that has none — the moment an
   * email-invited account is claimed by its first sign-in. Also sets
   * `provider`, so the row records how it was last linked.
   *
   * Idempotent when the account already carries this exact identity.
   * Throws `ConflictError` when the account already carries a DIFFERENT one,
   * or when this identity belongs to another account. Both refusals are the
   * same rule: an identity may never be silently MOVED between accounts,
   * because that hands one person's memberships to another. Throws
   * `NotFoundError` for a missing user.
   */
  linkProviderIdentity(userId: string, provider: "github", providerUserId: string): Promise<User>

  /** Set a user's instance role. Throws `NotFoundError` for a missing user. */
  updateUserRole(userId: string, role: InstanceRole): Promise<User>

  /**
   * Set a user's account status. Throws `NotFoundError` for a missing user.
   * `removed` is a soft delete — the row, its id, and its role all survive.
   */
  setUserStatus(userId: string, status: UserStatus): Promise<User>

  /** All accounts, oldest-first by `createdAt`, creation-order tie-break. Includes `removed` ones. */
  listUsers(): Promise<User[]>

  /**
   * How many accounts exist, `removed` ones INCLUDED. This answers the
   * bootstrap question "has this instance ever admitted anyone" — an
   * instance whose only account was removed must not read as empty, or the
   * next visitor would be bootstrapped straight to admin.
   */
  countUsers(): Promise<number>

  /** Get a user by id, or null if not found. */
  getUser(userId: string): Promise<User | null>

  /**
   * Get a user by (provider, providerUserId). Null when no account carries
   * that identity — including when the person exists but was invited by
   * email and has never signed in, which is why a miss here is not "no such
   * person" and must be followed by a `getUserByEmail`.
   *
   * Also serves the refused-sign-in revocation path (audit K08): a sign-in
   * blocked by `VIEWER_ALLOWED_EMAIL_DOMAINS` must be able to revoke that
   * account's existing sessions and tokens, and it cannot look the account
   * up by email — the email it was refused ON is not necessarily the one on
   * the stored row.
   */
  getUserByProviderIdentity(provider: "github", providerUserId: string): Promise<User | null>

  /**
   * Get a user by email (case-insensitive — compared against the stored
   * lowercased form, the same normalization `createUser` applies). Used by
   * the membership invite flow to resolve an invited email to an account.
   *
   * REFUSES with `ConflictError` when more than one row holds that email
   * rather than picking one (security audit S18). Before this, SQLite
   * returned the LOWEST rowid — the earliest-created account — so an invite
   * to a reassigned corporate address granted a private project to the
   * previous holder, and the membership row (keyed on `userId`) survived any
   * later email change. Guessing is the one thing this must not do.
   *
   * The UNIQUE email index means this state can no longer FORM, so the guard
   * is defense in depth: it is the last thing standing if a future migration,
   * a hand-edited database or a second impl ever lets it back in.
   */
  getUserByEmail(email: string): Promise<User | null>

  /**
   * Record (wholesale-replace) the GitHub App installations a user can see
   * AND, per installation, the repos within it that user can reach — stamped
   * `syncedAt`. Replaces rather than merges: an installation (or a repo) the
   * user has LOST access to must disappear, which a merge could never do.
   * An empty array is a legitimate value (the user can see none) and is
   * stored as such, distinct from "never recorded" — see `getUserInstallations`.
   * Throws NotFoundError if the user doesn't exist.
   *
   * Both halves are written in ONE transaction. A separate
   * `setUserInstallationRepos` would let a crash leave a user authorized for
   * an installation whose repo entitlement came from a previous sign-in —
   * i.e. the exact stale-authorization shape this data exists to prevent.
   */
  setUserInstallations(
    userId: string,
    installations: UserInstallationEntry[],
    syncedAt: string,
  ): Promise<void>

  /**
   * The user's recorded installation set, or `null` if one has never been
   * recorded (a user who last signed in before Phase 3c-1b, or whose
   * capture failed). `null` and `{ installationIds: [] }` are deliberately
   * different: both grant nothing, but only the first means "we don't know,
   * sign in again".
   */
  getUserInstallations(userId: string): Promise<UserInstallations | null>

  /**
   * Create a session with a random UUID `id`. The `expiresAt` is stored
   * as-is; expiry policy lives in the caller (e.g., Task 2's `getCurrentUser`).
   */
  createSession(input: { userId: string; expiresAt: string }): Promise<Session>

  /**
   * Get a session by id, or null if not found. Returns the row even if
   * expired — the caller decides expiry policy.
   */
  getSession(sessionId: string): Promise<Session | null>

  /**
   * Delete a session by id. Idempotent: does NOT throw on a missing id
   * because logout must be safe to double-fire (e.g., concurrent requests,
   * expired sessions with automatic cleanup).
   */
  deleteSession(sessionId: string): Promise<void>

  /**
   * Delete all sessions where `expiresAt <= now`, returning the count deleted.
   * The caller (e.g., server startup or periodic maintenance) decides sweep policy.
   */
  deleteExpiredSessions(now: string): Promise<number>

  /**
   * Delete EVERY session belonging to one user, returning the count deleted.
   * Idempotent (zero sessions is not an error) — revocation must be safe to
   * double-fire, same rule `deleteSession` follows.
   *
   * The revocation lever `deleteSession` could not provide (audit K09):
   * logout only ever deleted the session whose cookie was presented, so a
   * session stolen from another browser, or one left live on a lost laptop,
   * survived every action the user could take. Backs "sign out everywhere",
   * the refused-sign-in revocation (K08), and the admin revocation route.
   */
  deleteSessionsForUser(userId: string): Promise<number>

  /**
   * Add a user to a project's access list. Idempotent on (projectId, userId)
   * — re-adding an existing member returns the existing row unchanged
   * (same `createdAt`), never a duplicate.
   */
  addProjectMember(input: { projectId: string; userId: string }): Promise<ProjectMember>

  /**
   * List project members, oldest-first by `createdAt`, creation-order tie-break.
   */
  listProjectMembers(projectId: string): Promise<ProjectMember[]>

  /**
   * Get a project member by (projectId, userId), or null if not found.
   */
  getProjectMember(projectId: string, userId: string): Promise<ProjectMember | null>

  /**
   * Remove a project member. Idempotent: does NOT throw on a missing (projectId, userId) pair.
   */
  removeProjectMember(projectId: string, userId: string): Promise<void>

  /**
   * List project IDs that a user is a member of.
   */
  listProjectsForUser(userId: string): Promise<string[]>

  /** Create a machine token row. `createdAt` and `lastUsedAt: null` are assigned by the impl. */
  createMachineToken(input: MachineTokenCreateInput): Promise<MachineToken>

  /** Get a machine token by id, or null if not found. */
  getMachineToken(id: string): Promise<MachineToken | null>

  /** List a user's machine tokens, oldest-first by `createdAt`, creation-order tie-break. */
  listMachineTokensForUser(userId: string): Promise<MachineToken[]>

  /** Update `lastUsedAt`. No-op (does NOT throw) on a missing id — a storage blip while touching a timestamp must never fail the request. */
  touchMachineToken(id: string, lastUsedAt: string): Promise<void>

  /** Delete a machine token. Idempotent: does NOT throw on a missing id (mirrors `removeProjectMember` / `deleteSession` — revocation must be safe to double-fire). */
  deleteMachineToken(id: string): Promise<void>

  /** Delete all machine tokens owned by a user. Used when a user account is removed. */
  deleteMachineTokensForUser(userId: string): Promise<void>

  /** Create an instance invite. `usedAt`/`revokedAt` start `null`; `createdAt` is assigned by the impl. `email` is lowercased. */
  createInstanceInvite(input: {
    id: string
    email: string
    role: InstanceRole
    tokenHash: string
    createdByUserId: string | null
    expiresAt: string
  }): Promise<InstanceInvite>

  /** Get an instance invite by id, or null if not found. */
  getInstanceInvite(id: string): Promise<InstanceInvite | null>

  /** All invites, oldest-first by `createdAt`, creation-order tie-break. */
  listInstanceInvites(): Promise<InstanceInvite[]>

  /**
   * The pending invite for this email, or null. "Pending" means unused,
   * unrevoked, AND unexpired — the same three conditions `admitSignIn`'s
   * `isClaimable` checks on a caller-supplied invite. Case-insensitive:
   * lowercases `email` before comparing, matching how `createInstanceInvite`
   * stores it.
   *
   * Exists so the admission gate (`auth/gate.ts`) can honour a pending
   * invite on EVERY door — GitHub sign-in, a self-serve magic link, not just
   * the `/auth/invite/<token>` link itself — without a caller having to
   * thread one through from a route that never looked one up. If more than
   * one pending invite somehow exists for an email (it shouldn't:
   * `POST /instance/invites` refuses a second one while an unexpired,
   * unused invite is live), the most recently created wins.
   */
  getPendingInstanceInviteByEmail(email: string): Promise<InstanceInvite | null>

  /**
   * Regenerate an invite: replaces `tokenHash` and `expiresAt`, and clears
   * `usedAt`/`revokedAt` — so a used or revoked invite can be reissued
   * without minting a new id. Throws `NotFoundError` on a missing id.
   */
  resetInstanceInviteToken(id: string, tokenHash: string, expiresAt: string): Promise<InstanceInvite>

  /**
   * Atomically claim an invite: sets `usedAt` iff it is currently unused
   * AND unrevoked. Returns true iff THIS call flipped it (exactly once) —
   * a second claim, or a claim on a revoked invite, returns false. Mirrors
   * `claimNotification`.
   */
  claimInstanceInvite(id: string, usedAt: string): Promise<boolean>

  /**
   * The compensating action for `claimInstanceInvite`: resets `usedAt` back
   * to `null`. Exists for `admitSignIn` (`auth/gate.ts`) to call when the
   * claim succeeded but account creation failed afterward — without it, the
   * invite is spent and the person is stranded until an admin regenerates
   * it. Idempotent, including on a missing id: safe to call from a
   * best-effort rollback that must never throw a SECOND error over the one
   * that triggered it.
   */
  unclaimInstanceInvite(id: string): Promise<void>

  /** Set `revokedAt` if not already set. Idempotent, including on a missing id. */
  revokeInstanceInvite(id: string): Promise<void>

  /**
   * Deletes every invite that is UNUSED, UNREVOKED, and at or past its
   * `expiresAt` — the same three conditions `deriveInviteState`
   * (instance-routes.ts) uses to show `"expired"` in the members panel.
   * Returns how many were removed.
   *
   * A USED or REVOKED row is left alone no matter how old — it is the audit
   * trail proving an account was created from it, or that an admin pulled
   * it, never a live credential by that point (`claimInstanceInvite` is
   * exactly-once; a revoked invite fails `isClaimable` regardless of
   * expiry). Only a row nobody ever acted on is swept, on the same "expired
   * means gone" rule `deleteExpiredSignInTokens` follows for the table that
   * actually does need a full sweep — this table doesn't NEED one for the
   * same reason (invites are admin-minted, not an unauthenticated write
   * surface), but a table that only ever grows is still worth trimming.
   *
   * Run on the same sweep tick as `deleteExpiredSessions` /
   * `deleteExpiredSignInTokens` (`session-sweep.ts`).
   */
  deleteExpiredInstanceInvites(now: string): Promise<number>

  /**
   * Create a sign-in token. Exactly one of `userId`/`email` must be
   * non-null — see `SignInToken`'s doc comment. `email` is lowercased when
   * set; `usedAt` starts `null`; `createdAt` is assigned by the impl.
   */
  createSignInToken(input: {
    id: string
    userId: string | null
    email: string | null
    tokenHash: string
    expiresAt: string
  }): Promise<SignInToken>

  /** Get a sign-in token by id, or null if not found. */
  getSignInToken(id: string): Promise<SignInToken | null>

  /** Atomic, single-use claim: sets `usedAt` iff currently unused. Returns true iff THIS call claimed it. */
  claimSignInToken(id: string, usedAt: string): Promise<boolean>

  /**
   * Delete every sign-in token that can no longer be redeemed — any row with
   * `expiresAt <= now`, claimed or not. Returns how many were removed.
   *
   * This table needs a sweep in a way the others do not, because
   * `POST /auth/magic-link` is UNAUTHENTICATED and, on an instance with a
   * domain rule, its subject space is unbounded: every address at that domain
   * is a row somebody can cause to be written without ever holding a
   * credential. Nothing else deletes these rows — redemption sets `usedAt`,
   * it does not remove them — so without this the table only ever grows.
   *
   * A CLAIMED but not-yet-expired token is deliberately left alone rather
   * than deleted on sight: it is already spent (`claimSignInToken` is
   * exactly-once), so it authorizes nothing, and one rule — "expired means
   * gone" — is easier to hold than two.
   *
   * Mirrors `deleteExpiredSessions`, and runs on the same sweep tick.
   */
  deleteExpiredSignInTokens(now: string): Promise<number>

  /**
   * Whether `subject` already holds a sign-in token that is unclaimed,
   * unexpired at `now`, and was created strictly after `createdAfter`.
   *
   * `subject` takes the same shape as `createSignInToken`'s: exactly one of
   * `userId`/`email` is non-null, and the impl matches on whichever it is.
   * `email` is compared lowercased, as it is stored.
   *
   * Deliberately a BOOLEAN and not the row. This exists for one caller — the
   * per-subject mint throttle in `POST /auth/magic-link` — and that caller
   * must not disclose anything at all about what it found: it answers the
   * same `202` either way. Returning a `SignInToken` would hand a future edit
   * an expiry it could put in a `Retry-After`, which is precisely the
   * membership oracle the whole route is shaped to avoid.
   */
  hasRecentSignInTokenForSubject(
    subject: { userId: string | null; email: string | null },
    window: { now: string; createdAfter: string },
  ): Promise<boolean>

  /**
   * Delete every userId-linked sign-in token belonging to one user —
   * claimed or not, expired or not — returning the count removed.
   * Idempotent (zero rows is not an error), same rule `deleteSessionsForUser`
   * / `deleteMachineTokensForUser` follow: revocation must be safe to
   * double-fire.
   *
   * Never touches an email-linked token (`userId: null`, a domain-rule
   * self-serve join) — that row names no account yet, so there is nothing
   * here for it to belong to.
   *
   * The revocation lever `DELETE /instance/members/:userId` and
   * `revokeStandingCredentials` (audit K08's refused-sign-in path,
   * `auth-routes.ts`) were both missing until fix wave 8, item 2: without
   * it, an outstanding admin-issued sign-in link (a 24-hour credential,
   * `POST /instance/members/:userId/signin-link`) or magic link survived a
   * removal untouched. `deleteSessionsForUser`/`deleteMachineTokensForUser`
   * only killed what the account already had LIVE; a link waiting to be
   * clicked was neither of those, and it kept working the moment the
   * account was restored — the same account, the same token, the removal
   * having done nothing to it at all.
   */
  deleteSignInTokensForUser(userId: string): Promise<number>

  /**
   * Delete every EMAIL-linked sign-in token for `email` (a domain-rule
   * self-serve-join credential — `userId: null`) — claimed or not, expired
   * or not — returning the count removed. Matched case-insensitively; the
   * impl lowercases `email` before comparing, so a caller may pass the
   * address in whatever case it holds it. Idempotent, same rule
   * `deleteSignInTokensForUser` follows.
   *
   * Never touches a userId-linked token, even one for an account that holds
   * this same address — that is `deleteSignInTokensForUser`'s job, and the
   * two are deliberately separate calls rather than one that reaches for
   * both, so a caller cannot revoke one kind while believing it revoked
   * both.
   *
   * Fix wave 9, item 3, the email-linked sibling of the gap
   * `deleteSignInTokensForUser` closed in fix wave 8: `deleteSignInTokensForUser`
   * cannot reach an email-linked row by construction, since that row names
   * no account, only an address. An email-linked link can predate any
   * account at that address, or be a second one minted after an account
   * already exists, and — because redeeming it resolves by ADDRESS, not by
   * id — it goes on admitting into WHATEVER account currently holds that
   * address, including one created or restored after the link was minted.
   * `DELETE /instance/members/:userId` and `revokeStandingCredentials`
   * (`auth-routes.ts`) both call this alongside `deleteSignInTokensForUser`.
   */
  deleteSignInTokensForEmail(email: string): Promise<number>

  /** All domain rules, alphabetical by domain. */
  listDomainRules(): Promise<DomainRule[]>

  /**
   * Create or replace the rule for `domain` (upsert, keyed on the
   * lowercased domain). Re-adding an existing domain updates its `role`;
   * `createdByUserId`/`createdAt` are left as they were on the first call.
   */
  setDomainRule(input: { domain: string; role: InstanceRole; createdByUserId: string | null }): Promise<DomainRule>

  /** Remove a domain rule. Idempotent: does NOT throw on an unknown domain. */
  removeDomainRule(domain: string): Promise<void>

  /** Get an instance setting's value, or null if unset. */
  getInstanceSetting(key: string): Promise<string | null>

  /** Set (create or replace) an instance setting's value. */
  setInstanceSetting(key: string, value: string): Promise<void>

  /** Release resources (db handles). Safe to call twice. */
  close(): Promise<void>
}
