import { randomUUID } from "node:crypto"
import { ConflictError, NotFoundError } from "./errors"
import { MAX_BUILD_LOG_BYTES, appendBounded, INTERRUPTED_BUILD_LOG_LINE } from "./log-append"
import { omitUndefined } from "./patch-utils"
import type {
  CreateUserInput,
  Deployment,
  DeploymentCreateInput,
  DeploymentUpdatePatch,
  DomainRule,
  EnqueueNotificationInput,
  InstanceInvite,
  InstanceRole,
  MachineToken,
  MachineTokenCreateInput,
  NotificationOutbox,
  Participant,
  Project,
  ProjectCreateInput,
  ProjectMember,
  ProjectRepoConfig,
  ProjectUpdatePatch,
  Session,
  SignInToken,
  StorageAdapter,
  StoredCommentInput,
  StoredCommentPatch,
  StoredCommentReplyInput,
  User,
  UserInstallationEntry,
  UserInstallations,
  UserProfilePatch,
  UserStatus,
} from "./types"
import type { Comment } from "@/types/bridge"

/**
 * Reference StorageAdapter impl. Used by API tests (fast, no files) and
 * as the executable definition of the contract's semantics.
 */
export class InMemoryStorage implements StorageAdapter {
  private projects = new Map<string, Project>()
  private deployments = new Map<string, Deployment>()
  private comments: Comment[] = []
  private participants: Participant[] = []
  private outbox: NotificationOutbox[] = []
  private optouts: { participantId: string; projectId: string | null }[] = []
  private users: User[] = []
  private sessions: Session[] = []
  private members: ProjectMember[] = []
  private machineTokens: MachineToken[] = []
  /** userId → the GitHub App installations that user could see at last sign-in. */
  private userInstallations = new Map<string, UserInstallations>()
  private instanceInvites: InstanceInvite[] = []
  private signInTokens: SignInToken[] = []
  /** domain (lowercased) → rule. Keying on the primary key makes upsert trivial. */
  private domainRules = new Map<string, DomainRule>()
  private instanceSettings = new Map<string, string>()
  private sequence = 0

  /** Monotonic stamp so ordering is deterministic even within one millisecond. */
  private nextTimestamp(): string {
    this.sequence += 1
    return new Date(Date.UTC(2020, 0, 1) + this.sequence).toISOString()
  }

  /** Deep-clone a Comment so returned values are detached from internal state. */
  private cloneComment(c: Comment): Comment {
    return {
      ...c,
      position: { ...c.position },
      author: { ...c.author },
      mentions: [...c.mentions],
      participantEmails: [...c.participantEmails],
      replies: c.replies.map((r) => ({
        ...r,
        author: { ...r.author },
        mentions: [...r.mentions],
      })),
    }
  }

  /** Clone a Participant so returned values are detached from internal state. */
  private cloneParticipant(p: Participant): Participant {
    return { ...p }
  }

  /** Deep-clone a NotificationOutbox so returned values are detached from internal state. */
  private cloneNotificationOutbox(n: NotificationOutbox): NotificationOutbox {
    return {
      ...n,
      recipientIds: [...n.recipientIds],
    }
  }

  /** Clone a User so returned values are detached from internal state. Shallow spread suffices — both are flat objects. */
  private cloneUser(u: User): User {
    return { ...u }
  }

  /** Clone a Session so returned values are detached from internal state. Shallow spread suffices — both are flat objects. */
  private cloneSession(s: Session): Session {
    return { ...s }
  }

  /** Clone a ProjectMember so returned values are detached from internal state. Shallow spread suffices — both are flat objects. */
  private cloneProjectMember(m: ProjectMember): ProjectMember {
    return { ...m }
  }

  /** Clone a Project so returned values are detached from internal state. `repoConfig` needs its own copy — the rest is flat. */
  private cloneProject(p: Project): Project {
    return { ...p, repoConfig: p.repoConfig ? { ...p.repoConfig } : null }
  }

  /** Clone a MachineToken so returned values are detached from internal state. `scopes` needs its own copy — the rest is flat. */
  private cloneMachineToken(t: MachineToken): MachineToken {
    return { ...t, scopes: [...t.scopes] }
  }

  /** Clone an InstanceInvite so returned values are detached from internal state. Shallow spread suffices — flat object. */
  private cloneInstanceInvite(i: InstanceInvite): InstanceInvite {
    return { ...i }
  }

  /** Clone a SignInToken so returned values are detached from internal state. Shallow spread suffices — flat object. */
  private cloneSignInToken(t: SignInToken): SignInToken {
    return { ...t }
  }

  /** Clone a DomainRule so returned values are detached from internal state. Shallow spread suffices — flat object. */
  private cloneDomainRule(d: DomainRule): DomainRule {
    return { ...d }
  }

  async createProject(input: ProjectCreateInput): Promise<Project> {
    for (const existing of this.projects.values()) {
      if (existing.slug === input.slug) {
        throw new ConflictError(`Project slug already exists: ${input.slug}`)
      }
    }
    const project: Project = {
      id: randomUUID(),
      slug: input.slug,
      name: input.name,
      repoUrl: input.repoUrl ?? null,
      access: input.access ?? "all-members",
      activeDeploymentId: null,
      repoConfig: null,
      embeddedId: null,
      createdAt: this.nextTimestamp(),
    }
    this.projects.set(project.id, project)
    return this.cloneProject(project)
  }

  async getProject(id: string): Promise<Project | null> {
    const found = this.projects.get(id)
    return found ? this.cloneProject(found) : null
  }

  async getProjectBySlug(slug: string): Promise<Project | null> {
    for (const project of this.projects.values()) {
      if (project.slug === slug) return this.cloneProject(project)
    }
    return null
  }

  async listProjects(): Promise<Project[]> {
    return [...this.projects.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((p) => this.cloneProject(p))
  }

  async updateProject(id: string, patch: ProjectUpdatePatch): Promise<Project> {
    const existing = this.projects.get(id)
    if (!existing) throw new NotFoundError("Project", id)
    const updated: Project = { ...existing, ...omitUndefined(patch) }
    this.projects.set(id, updated)
    return this.cloneProject(updated)
  }

  async deleteProject(id: string): Promise<void> {
    this.projects.delete(id)
    for (const [key, deployment] of this.deployments) {
      if (deployment.projectId === id) this.deployments.delete(key)
    }
    this.comments = this.comments.filter((c) => c.projectId !== id)
    this.participants = this.participants.filter((p) => p.projectId !== id)
    this.outbox = this.outbox.filter((o) => o.projectId !== id)
    this.optouts = this.optouts.filter((opt) => opt.projectId !== id) // keep global optouts (projectId === null)
    this.members = this.members.filter((m) => m.projectId !== id)
  }

  async setProjectRepoConfig(projectId: string, config: ProjectRepoConfig): Promise<Project> {
    const existing = this.projects.get(projectId)
    if (!existing) throw new NotFoundError("Project", projectId)
    const updated: Project = { ...existing, repoConfig: { ...config } }
    this.projects.set(projectId, updated)
    return this.cloneProject(updated)
  }

  async clearProjectRepoConfig(projectId: string): Promise<Project> {
    const existing = this.projects.get(projectId)
    if (!existing) throw new NotFoundError("Project", projectId)
    const updated: Project = { ...existing, repoConfig: null }
    this.projects.set(projectId, updated)
    return this.cloneProject(updated)
  }

  async setProjectEmbeddedId(projectId: string, embeddedId: string): Promise<Project> {
    const existing = this.projects.get(projectId)
    if (!existing) throw new NotFoundError("Project", projectId)
    for (const [id, p] of this.projects) {
      // Two repos carrying one id is the fork case. Refuse rather than
      // silently re-point whatever hangs off the join key.
      if (id !== projectId && p.embeddedId === embeddedId) {
        throw new ConflictError(
          `Embedded project id ${embeddedId} is already claimed by project ${id}`,
        )
      }
    }
    const updated: Project = { ...existing, embeddedId }
    this.projects.set(projectId, updated)
    return this.cloneProject(updated)
  }

  async getProjectByEmbeddedId(embeddedId: string): Promise<Project | null> {
    for (const p of this.projects.values()) {
      if (p.embeddedId === embeddedId) return this.cloneProject(p)
    }
    return null
  }

  async getProjectByRepo(owner: string, name: string): Promise<Project | null> {
    const o = owner.toLowerCase()
    const n = name.toLowerCase()
    for (const p of this.projects.values()) {
      const rc = p.repoConfig
      if (rc && rc.owner.toLowerCase() === o && rc.name.toLowerCase() === n) {
        return this.cloneProject(p)
      }
    }
    return null
  }

  async createDeployment(input: DeploymentCreateInput): Promise<Deployment> {
    const deployment: Deployment = {
      id: randomUUID(),
      projectId: input.projectId,
      status: input.status ?? "building",
      commitSha: input.commitSha ?? null,
      commitMessage: null,
      buildLog: "",
      warnings: null,
      // `null`, not `[]`: a deployment has no phases until a build records
      // one, and an upload never will.
      steps: null,
      createdAt: this.nextTimestamp(),
    }
    this.deployments.set(deployment.id, deployment)
    return { ...deployment }
  }

  async getDeployment(id: string): Promise<Deployment | null> {
    const found = this.deployments.get(id)
    return found ? { ...found } : null
  }

  async listDeployments(projectId: string): Promise<Deployment[]> {
    return [...this.deployments.values()]
      .filter((d) => d.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((d) => ({ ...d }))
  }

  async appendDeploymentLog(id: string, chunk: string, maxBytes: number): Promise<void> {
    const d = this.deployments.get(id)
    if (!d) return
    const next = appendBounded(d.buildLog, chunk, maxBytes)
    if (next === null) return
    d.buildLog = next
  }

  async markInterruptedBuildsFailed(): Promise<number> {
    let count = 0
    for (const d of this.deployments.values()) {
      if (d.status !== "building") continue
      d.status = "failed"
      // Fix wave 10, item 4: through the same bounded-append path every
      // OTHER write to `buildLog` goes through — a raw `+=` here bypassed
      // `MAX_BUILD_LOG_BYTES` entirely, so a log already at (or near) the cap
      // when the server restarted could grow past it. `appendBounded`
      // returns `null` when the log is already at cap and already carries
      // the truncation marker, in which case there is nothing to append but
      // the status flip above still stands.
      const bounded = appendBounded(d.buildLog, INTERRUPTED_BUILD_LOG_LINE, MAX_BUILD_LOG_BYTES)
      if (bounded !== null) d.buildLog = bounded
      count++
    }
    return count
  }

  async updateDeployment(
    id: string,
    patch: DeploymentUpdatePatch,
  ): Promise<Deployment> {
    const existing = this.deployments.get(id)
    if (!existing) throw new NotFoundError("Deployment", id)
    const updated: Deployment = { ...existing, ...omitUndefined(patch) }
    this.deployments.set(id, updated)
    return { ...updated }
  }

  async listComments(projectId: string): Promise<Comment[]> {
    return this.comments
      .filter((c) => c.projectId === projectId)
      .sort((a, b) => a.number - b.number)
      .map((c) => this.cloneComment(c))
  }

  async getComment(commentId: string): Promise<Comment | null> {
    const found = this.comments.find((c) => c.id === commentId)
    return found ? this.cloneComment(found) : null
  }

  async createComment(projectId: string, input: StoredCommentInput): Promise<Comment> {
    const number =
      this.comments.filter((c) => c.projectId === projectId).reduce((m, c) => Math.max(m, c.number), 0) + 1
    const comment: Comment = {
      id: randomUUID(),
      number,
      position: { ...input.position },
      body: input.body,
      author: { ...input.author },
      createdAt: this.nextTimestamp(),
      resolved: false,
      replies: [],
      mentions: [...(input.mentions ?? [])],
      participantEmails: input.author.email ? [input.author.email] : [],
      projectId,
    }
    this.comments.push(comment)
    return this.cloneComment(comment)
  }

  async updateComment(commentId: string, patch: StoredCommentPatch): Promise<Comment> {
    const found = this.comments.find((c) => c.id === commentId)
    if (!found) throw new NotFoundError("Comment", commentId)
    const safePatch = omitUndefined({
      body: patch.body,
      resolved: patch.resolved,
      mentions: patch.mentions ? [...patch.mentions] : undefined,
    })
    Object.assign(found, safePatch)
    return (await this.getComment(commentId))!
  }

  async addCommentReply(commentId: string, reply: StoredCommentReplyInput): Promise<Comment> {
    const found = this.comments.find((c) => c.id === commentId)
    if (!found) throw new NotFoundError("Comment", commentId)
    found.replies.push({
      id: randomUUID(),
      body: reply.body,
      author: { ...reply.author },
      createdAt: this.nextTimestamp(),
      mentions: [...(reply.mentions ?? [])],
    })
    if (reply.author.email && !found.participantEmails.includes(reply.author.email)) {
      found.participantEmails.push(reply.author.email)
    }
    return (await this.getComment(commentId))!
  }

  async deleteComment(commentId: string): Promise<void> {
    const idx = this.comments.findIndex((c) => c.id === commentId)
    if (idx === -1) throw new NotFoundError("Comment", commentId)
    this.comments.splice(idx, 1)
  }

  async listParticipants(projectId: string): Promise<Participant[]> {
    return this.participants
      .filter((p) => p.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((p) => this.cloneParticipant(p))
  }

  async getParticipant(participantId: string): Promise<Participant | null> {
    const found = this.participants.find((p) => p.id === participantId)
    return found ? this.cloneParticipant(found) : null
  }

  async upsertParticipant(
    projectId: string,
    input: { email: string; displayName: string; status: "active" | "pending" },
  ): Promise<Participant> {
    const lowerEmail = input.email.toLowerCase()
    const existing = this.participants.find((p) => p.projectId === projectId && p.email === lowerEmail)

    if (existing) {
      existing.displayName = input.displayName
      if (input.status === "active") {
        existing.status = "active"
      }
      return this.cloneParticipant(existing)
    }

    const participant: Participant = {
      id: randomUUID(),
      projectId,
      email: lowerEmail,
      displayName: input.displayName,
      status: input.status,
      createdAt: this.nextTimestamp(),
    }
    this.participants.push(participant)
    return this.cloneParticipant(participant)
  }

  async enqueueNotification(input: EnqueueNotificationInput): Promise<NotificationOutbox> {
    const notification: NotificationOutbox = {
      id: randomUUID(),
      projectId: input.projectId,
      commentId: input.commentId,
      replyId: input.replyId ?? null,
      recipientIds: [...input.recipientIds],
      status: "pending",
      createdAt: this.nextTimestamp(),
    }
    this.outbox.push(notification)
    return this.cloneNotificationOutbox(notification)
  }

  async listPendingNotifications(limit: number): Promise<NotificationOutbox[]> {
    return this.outbox
      .filter((n) => n.status === "pending")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit)
      .map((n) => this.cloneNotificationOutbox(n))
  }

  async claimNotification(id: string): Promise<boolean> {
    const found = this.outbox.find((n) => n.id === id)
    if (!found || found.status !== "pending") {
      return false
    }
    found.status = "sending"
    return true
  }

  async setNotificationStatus(id: string, status: "sent" | "error"): Promise<void> {
    const found = this.outbox.find((n) => n.id === id)
    if (!found) throw new NotFoundError("Notification", id)
    found.status = status
  }

  async getNotification(id: string): Promise<NotificationOutbox | null> {
    const found = this.outbox.find((n) => n.id === id)
    return found ? this.cloneNotificationOutbox(found) : null
  }

  async recordOptout(input: { participantId: string; projectId: string | null }): Promise<void> {
    const existing = this.optouts.find(
      (opt) => opt.participantId === input.participantId && opt.projectId === input.projectId,
    )
    if (!existing) {
      this.optouts.push({
        participantId: input.participantId,
        projectId: input.projectId,
      })
    }
  }

  async isOptedOut(participantId: string, projectId: string): Promise<boolean> {
    return this.optouts.some(
      (opt) => opt.participantId === participantId && (opt.projectId === null || opt.projectId === projectId),
    )
  }

  async createUser(input: CreateUserInput): Promise<User> {
    const lowerEmail = input.email.toLowerCase()

    // Email is the identity, so it is unique instance-wide — a `removed`
    // account still holds its address. See `StorageAdapter.createUser`.
    if (this.users.some((u) => u.email === lowerEmail)) {
      throw new ConflictError(
        `Email already belongs to another account: ${lowerEmail}. ` +
          `An operator must remove the stale account before it can be reused.`,
      )
    }
    // "No provider identity" is not a value that can collide — several
    // email-invited accounts may sit at null together.
    if (
      input.providerUserId !== null &&
      this.users.some(
        (u) => u.provider === input.provider && u.providerUserId === input.providerUserId,
      )
    ) {
      throw new ConflictError(
        `Provider identity already belongs to another account: ${input.provider}/${input.providerUserId}`,
      )
    }

    const user: User = {
      id: randomUUID(),
      provider: input.provider,
      providerUserId: input.providerUserId,
      email: lowerEmail,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl,
      role: input.role,
      status: "active",
      createdAt: this.nextTimestamp(),
    }
    this.users.push(user)
    return this.cloneUser(user)
  }

  async createUserIfInstanceEmpty(input: CreateUserInput): Promise<User | null> {
    // No `await` between this check and the push below — see the doc
    // comment on `StorageAdapter.createUserIfInstanceEmpty`. JS run-to-
    // completion means once a caller reaches this call, it runs to the end
    // synchronously before any OTHER coroutine (including a second racing
    // call to this same method) gets a turn, so the check and the write
    // cannot be interleaved by a concurrent caller.
    if (this.users.length > 0) return null

    const user: User = {
      id: randomUUID(),
      provider: input.provider,
      providerUserId: input.providerUserId,
      email: input.email.toLowerCase(),
      displayName: input.displayName,
      avatarUrl: input.avatarUrl,
      role: input.role,
      status: "active",
      createdAt: this.nextTimestamp(),
    }
    this.users.push(user)
    return this.cloneUser(user)
  }

  async updateUserProfile(userId: string, patch: UserProfilePatch): Promise<User> {
    const existing = this.users.find((u) => u.id === userId)
    if (!existing) throw new NotFoundError("User", userId)

    const clean = omitUndefined(patch)
    const email = clean.email === undefined ? existing.email : clean.email.toLowerCase()

    if (email !== existing.email && this.users.some((u) => u.id !== userId && u.email === email)) {
      throw new ConflictError(
        `Email already belongs to another account: ${email}. ` +
          `An operator must remove the stale account before it can be reused.`,
      )
    }

    existing.email = email
    existing.displayName = clean.displayName ?? existing.displayName
    existing.avatarUrl = clean.avatarUrl ?? existing.avatarUrl
    return this.cloneUser(existing)
  }

  async linkProviderIdentity(
    userId: string,
    provider: "github",
    providerUserId: string,
  ): Promise<User> {
    // Mirrors the SQLite impl's compare-and-set on the write, not just the
    // read-then-decide checks below. Nothing here awaits before the mutation
    // at the bottom, so JS run-to-completion (see `createUserIfInstanceEmpty`
    // above) already gives this the same guarantee: once a racing call
    // reaches this method, it runs to its own return synchronously before a
    // second racing call gets a turn, so the second call always observes the
    // first one's write and takes the conflict branch above instead of
    // clobbering it.
    const existing = this.users.find((u) => u.id === userId)
    if (!existing) throw new NotFoundError("User", userId)

    if (existing.providerUserId !== null) {
      if (existing.provider === provider && existing.providerUserId === providerUserId) {
        return this.cloneUser(existing) // idempotent — signing in twice is not an error
      }
      throw new ConflictError(
        `Account ${userId} is already linked to ${existing.provider}/${existing.providerUserId} ` +
          `and cannot be re-linked to ${provider}/${providerUserId}.`,
      )
    }

    if (this.users.some((u) => u.provider === provider && u.providerUserId === providerUserId)) {
      throw new ConflictError(
        `Provider identity already belongs to another account: ${provider}/${providerUserId}`,
      )
    }

    existing.provider = provider
    existing.providerUserId = providerUserId
    return this.cloneUser(existing)
  }

  async updateUserRole(userId: string, role: InstanceRole): Promise<User> {
    const existing = this.users.find((u) => u.id === userId)
    if (!existing) throw new NotFoundError("User", userId)
    existing.role = role
    return this.cloneUser(existing)
  }

  async setUserStatus(userId: string, status: UserStatus): Promise<User> {
    const existing = this.users.find((u) => u.id === userId)
    if (!existing) throw new NotFoundError("User", userId)
    existing.status = status
    return this.cloneUser(existing)
  }

  async listUsers(): Promise<User[]> {
    // `nextTimestamp` is monotonic, so array order already IS createdAt
    // order; sorting anyway states the contract rather than relying on that,
    // and JS sort is stable so the creation-order tie-break holds.
    return [...this.users]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((u) => this.cloneUser(u))
  }

  async countUsers(): Promise<number> {
    return this.users.length
  }

  async getUser(userId: string): Promise<User | null> {
    const found = this.users.find((u) => u.id === userId)
    return found ? this.cloneUser(found) : null
  }

  async getUserByProviderIdentity(
    provider: "github",
    providerUserId: string,
  ): Promise<User | null> {
    const found = this.users.find(
      (u) => u.provider === provider && u.providerUserId === providerUserId,
    )
    return found ? this.cloneUser(found) : null
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const lowerEmail = email.toLowerCase()
    // Audit S18: refuse on ambiguity rather than taking the first insertion —
    // see `StorageAdapter.getUserByEmail`. The `.find()` this replaced agreed
    // with SQLite's lowest-rowid behaviour, so both impls were confidently
    // wrong together and the shared contract never caught it.
    const matches = this.users.filter((u) => u.email === lowerEmail)
    if (matches.length > 1) {
      throw new ConflictError(
        `Email is ambiguous: more than one account holds ${lowerEmail}. ` +
          `An operator must remove the stale account before it can be used.`,
      )
    }
    return matches[0] ? this.cloneUser(matches[0]) : null
  }

  async setUserInstallations(
    userId: string,
    installations: UserInstallationEntry[],
    syncedAt: string,
  ): Promise<void> {
    if (!this.users.some((u) => u.id === userId)) throw new NotFoundError("User", userId)
    // De-duplicated and copied: the caller's arrays must not remain aliased
    // by internal state, and a duplicated id would make the set's size
    // misleading without changing what it authorizes. Last entry wins for a
    // duplicated installation id — matching SQLite, whose per-id inserts
    // land in the same rows.
    const byId = new Map<number, UserInstallationEntry>()
    for (const entry of installations) {
      byId.set(entry.installationId, {
        installationId: entry.installationId,
        repoFullNames:
          entry.repoFullNames === null
            ? null
            : [...new Set(entry.repoFullNames.map((n) => n.toLowerCase()))].sort(),
      })
    }
    this.userInstallations.set(userId, { installations: [...byId.values()], syncedAt })
  }

  async getUserInstallations(userId: string): Promise<UserInstallations | null> {
    const found = this.userInstallations.get(userId)
    if (!found) return null
    return {
      installations: found.installations.map((e) => ({
        installationId: e.installationId,
        repoFullNames: e.repoFullNames === null ? null : [...e.repoFullNames],
      })),
      syncedAt: found.syncedAt,
    }
  }

  async createSession(input: { userId: string; expiresAt: string }): Promise<Session> {
    const session: Session = {
      id: randomUUID(),
      userId: input.userId,
      createdAt: this.nextTimestamp(),
      expiresAt: input.expiresAt,
    }
    this.sessions.push(session)
    return this.cloneSession(session)
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const found = this.sessions.find((s) => s.id === sessionId)
    return found ? this.cloneSession(found) : null
  }

  async deleteSession(sessionId: string): Promise<void> {
    // Idempotent: do not throw if session doesn't exist (logout must be safe to double-fire)
    const idx = this.sessions.findIndex((s) => s.id === sessionId)
    if (idx !== -1) {
      this.sessions.splice(idx, 1)
    }
  }

  async deleteExpiredSessions(now: string): Promise<number> {
    const before = this.sessions.length
    this.sessions = this.sessions.filter((s) => s.expiresAt > now)
    return before - this.sessions.length
  }

  async deleteSessionsForUser(userId: string): Promise<number> {
    // Idempotent: zero rows is a normal result, never an error.
    const before = this.sessions.length
    this.sessions = this.sessions.filter((s) => s.userId !== userId)
    return before - this.sessions.length
  }

  async addProjectMember(input: { projectId: string; userId: string }): Promise<ProjectMember> {
    const existing = this.members.find((m) => m.projectId === input.projectId && m.userId === input.userId)
    if (existing) return this.cloneProjectMember(existing)

    const member: ProjectMember = {
      projectId: input.projectId,
      userId: input.userId,
      createdAt: this.nextTimestamp(),
    }
    this.members.push(member)
    return this.cloneProjectMember(member)
  }

  async listProjectMembers(projectId: string): Promise<ProjectMember[]> {
    return this.members
      .filter((m) => m.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((m) => this.cloneProjectMember(m))
  }

  async getProjectMember(projectId: string, userId: string): Promise<ProjectMember | null> {
    const found = this.members.find((m) => m.projectId === projectId && m.userId === userId)
    return found ? this.cloneProjectMember(found) : null
  }

  async removeProjectMember(projectId: string, userId: string): Promise<void> {
    // Idempotent: do not throw if member doesn't exist
    const idx = this.members.findIndex((m) => m.projectId === projectId && m.userId === userId)
    if (idx !== -1) {
      this.members.splice(idx, 1)
    }
  }

  async listProjectsForUser(userId: string): Promise<string[]> {
    return this.members
      .filter((m) => m.userId === userId)
      .map((m) => m.projectId)
  }

  async createMachineToken(input: MachineTokenCreateInput): Promise<MachineToken> {
    const token: MachineToken = {
      id: input.id,
      userId: input.userId,
      name: input.name,
      scopes: [...input.scopes],
      tokenHash: input.tokenHash,
      createdAt: this.nextTimestamp(),
      lastUsedAt: null,
      expiresAt: input.expiresAt ?? null,
    }
    this.machineTokens.push(token)
    return this.cloneMachineToken(token)
  }

  async getMachineToken(id: string): Promise<MachineToken | null> {
    const found = this.machineTokens.find((t) => t.id === id)
    return found ? this.cloneMachineToken(found) : null
  }

  async listMachineTokensForUser(userId: string): Promise<MachineToken[]> {
    return this.machineTokens
      .filter((t) => t.userId === userId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((t) => this.cloneMachineToken(t))
  }

  async touchMachineToken(id: string, lastUsedAt: string): Promise<void> {
    // No-op on a missing id — mirrors the fire-and-forget contract in
    // machine-token.ts: a storage blip or a raced revoke must never throw.
    const found = this.machineTokens.find((t) => t.id === id)
    if (found) found.lastUsedAt = lastUsedAt
  }

  async deleteMachineToken(id: string): Promise<void> {
    // Idempotent: does NOT throw on a missing id (mirrors removeProjectMember/deleteSession).
    const idx = this.machineTokens.findIndex((t) => t.id === id)
    if (idx !== -1) this.machineTokens.splice(idx, 1)
  }

  async deleteMachineTokensForUser(userId: string): Promise<void> {
    this.machineTokens = this.machineTokens.filter((t) => t.userId !== userId)
  }

  async createInstanceInvite(input: {
    id: string
    email: string
    role: InstanceRole
    tokenHash: string
    createdByUserId: string | null
    expiresAt: string
  }): Promise<InstanceInvite> {
    const invite: InstanceInvite = {
      id: input.id,
      email: input.email.toLowerCase(),
      role: input.role,
      tokenHash: input.tokenHash,
      createdByUserId: input.createdByUserId,
      createdAt: this.nextTimestamp(),
      expiresAt: input.expiresAt,
      usedAt: null,
      revokedAt: null,
    }
    this.instanceInvites.push(invite)
    return this.cloneInstanceInvite(invite)
  }

  async getInstanceInvite(id: string): Promise<InstanceInvite | null> {
    const found = this.instanceInvites.find((i) => i.id === id)
    return found ? this.cloneInstanceInvite(found) : null
  }

  async listInstanceInvites(): Promise<InstanceInvite[]> {
    return [...this.instanceInvites]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((i) => this.cloneInstanceInvite(i))
  }

  async getPendingInstanceInviteByEmail(email: string): Promise<InstanceInvite | null> {
    const nowIso = new Date().toISOString()
    const lowered = email.toLowerCase()
    const matches = this.instanceInvites.filter(
      (i) =>
        i.email === lowered && i.usedAt === null && i.revokedAt === null && i.expiresAt > nowIso,
    )
    if (matches.length === 0) return null
    const newest = matches.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b))
    return this.cloneInstanceInvite(newest)
  }

  async resetInstanceInviteToken(id: string, tokenHash: string, expiresAt: string): Promise<InstanceInvite> {
    const found = this.instanceInvites.find((i) => i.id === id)
    if (!found) throw new NotFoundError("InstanceInvite", id)
    found.tokenHash = tokenHash
    found.expiresAt = expiresAt
    found.usedAt = null
    found.revokedAt = null
    return this.cloneInstanceInvite(found)
  }

  async claimInstanceInvite(id: string, usedAt: string): Promise<boolean> {
    const found = this.instanceInvites.find((i) => i.id === id)
    if (!found || found.usedAt !== null || found.revokedAt !== null) return false
    found.usedAt = usedAt
    return true
  }

  async unclaimInstanceInvite(id: string): Promise<void> {
    const found = this.instanceInvites.find((i) => i.id === id)
    if (!found) return // idempotent — no-op on a missing id
    found.usedAt = null
  }

  async revokeInstanceInvite(id: string): Promise<void> {
    const found = this.instanceInvites.find((i) => i.id === id)
    if (!found) return // idempotent — no-op on a missing id
    if (found.revokedAt === null) found.revokedAt = this.nextTimestamp()
  }

  async deleteExpiredInstanceInvites(now: string): Promise<number> {
    const before = this.instanceInvites.length
    this.instanceInvites = this.instanceInvites.filter(
      (i) => !(i.usedAt === null && i.revokedAt === null && i.expiresAt <= now),
    )
    return before - this.instanceInvites.length
  }

  async createSignInToken(input: {
    id: string
    userId: string | null
    email: string | null
    tokenHash: string
    expiresAt: string
  }): Promise<SignInToken> {
    // Mirrors the SQLite CHECK constraint — same refusal, same message.
    if ((input.userId === null) === (input.email === null)) {
      throw new Error(
        `SignInToken requires exactly one of userId or email to be set (got userId=${JSON.stringify(input.userId)}, email=${JSON.stringify(input.email)})`,
      )
    }
    const token: SignInToken = {
      id: input.id,
      userId: input.userId,
      email: input.email ? input.email.toLowerCase() : null,
      tokenHash: input.tokenHash,
      // REAL time, not `nextTimestamp()` — the one field in this impl that
      // deliberately breaks the synthetic-clock convention. See
      // `SignInToken.createdAt`'s doc comment: this value is compared against
      // a `Date.now()`-derived cutoff by the mint throttle, and a 2020-epoch
      // counter would make that comparison always answer "long ago", so the
      // throttle would silently never fire against this adapter while firing
      // correctly against SQLite. Nothing orders sign-in tokens, so the
      // monotonicity the counter buys is not needed here.
      createdAt: new Date().toISOString(),
      expiresAt: input.expiresAt,
      usedAt: null,
    }
    this.signInTokens.push(token)
    return this.cloneSignInToken(token)
  }

  async getSignInToken(id: string): Promise<SignInToken | null> {
    const found = this.signInTokens.find((t) => t.id === id)
    return found ? this.cloneSignInToken(found) : null
  }

  async claimSignInToken(id: string, usedAt: string): Promise<boolean> {
    const found = this.signInTokens.find((t) => t.id === id)
    if (!found || found.usedAt !== null) return false
    found.usedAt = usedAt
    return true
  }

  async deleteExpiredSignInTokens(now: string): Promise<number> {
    const before = this.signInTokens.length
    this.signInTokens = this.signInTokens.filter((t) => t.expiresAt > now)
    return before - this.signInTokens.length
  }

  async deleteSignInTokensForUser(userId: string): Promise<number> {
    // `userId` only — an email-linked (domain-rule) token has `userId: null`
    // and belongs to no account, so a per-user revocation must not touch it.
    const before = this.signInTokens.length
    this.signInTokens = this.signInTokens.filter((t) => t.userId !== userId)
    return before - this.signInTokens.length
  }

  async deleteSignInTokensForEmail(email: string): Promise<number> {
    // `email` only — a userId-linked token has `email: null` and can never
    // match a real address, so this can't touch one by construction. Matched
    // against the lowercased form, same as `email` is stored.
    const normalized = email.toLowerCase()
    const before = this.signInTokens.length
    this.signInTokens = this.signInTokens.filter((t) => t.email !== normalized)
    return before - this.signInTokens.length
  }

  async hasRecentSignInTokenForSubject(
    subject: { userId: string | null; email: string | null },
    window: { now: string; createdAfter: string },
  ): Promise<boolean> {
    const email = subject.email === null ? null : subject.email.toLowerCase()
    return this.signInTokens.some(
      (t) =>
        (subject.userId !== null ? t.userId === subject.userId : t.email === email) &&
        t.usedAt === null &&
        t.expiresAt > window.now &&
        t.createdAt > window.createdAfter,
    )
  }

  async listDomainRules(): Promise<DomainRule[]> {
    return [...this.domainRules.values()]
      .sort((a, b) => a.domain.localeCompare(b.domain))
      .map((d) => this.cloneDomainRule(d))
  }

  async setDomainRule(input: {
    domain: string
    role: InstanceRole
    createdByUserId: string | null
  }): Promise<DomainRule> {
    const domain = input.domain.toLowerCase()
    const existing = this.domainRules.get(domain)
    // Upsert: re-adding an existing domain only updates `role` — creation
    // identity (`createdByUserId`/`createdAt`) survives, mirroring the
    // SQLite impl's ON CONFLICT DO UPDATE SET role = excluded.role.
    if (existing) {
      existing.role = input.role
      return this.cloneDomainRule(existing)
    }
    const rule: DomainRule = {
      domain,
      role: input.role,
      createdByUserId: input.createdByUserId,
      createdAt: this.nextTimestamp(),
    }
    this.domainRules.set(domain, rule)
    return this.cloneDomainRule(rule)
  }

  async removeDomainRule(domain: string): Promise<void> {
    this.domainRules.delete(domain.toLowerCase())
  }

  async getInstanceSetting(key: string): Promise<string | null> {
    return this.instanceSettings.get(key) ?? null
  }

  async setInstanceSetting(key: string, value: string): Promise<void> {
    this.instanceSettings.set(key, value)
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}
