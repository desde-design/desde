import { Router, type RequestHandler, type Response } from "express"
import type { AppDeps } from "../create-app"
import {
  canReadProject,
  getRequestContext,
  hasProjectManageAuthority,
  loadProjectReadPolicy,
  makeProjectMembership,
  requireProjectManage,
  isAnonymous,
  requireProjectReadWithPolicy,
  resolveReadContext,
  type ReadContext,
} from "../auth/authorize"
import { getAllowAnonymousComments, getAllowPublicLinks } from "../instance-settings"
import { withProjectLock } from "../project-locks"
import { ConflictError, NotFoundError } from "../storage/errors"
import { nextSlugCandidate } from "./free-slug"
import { decideResolution, parseRepoRemote } from "./project-resolve"
import type {
  Deployment,
  DeploymentStatus,
  DeploymentWarning,
  Project,
  ProjectAccess,
  ProjectRepoConfig,
} from "../storage/types"

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/
/**
 * How far the slug suffix search and its conflict retry will go before giving
 * up and letting the 409 through. Fifty `checkout-redesign-N` projects is
 * far past any real use and short of a loop that could hammer the database.
 */
const SLUG_ATTEMPT_LIMIT = 50

/** The first free candidate, plus which attempt number it was. */
async function findFreeSlugAttempt(
  deps: AppDeps,
  requested: string,
): Promise<{ slug: string; n: number }> {
  for (let n = 1; n <= SLUG_ATTEMPT_LIMIT; n++) {
    const candidate = nextSlugCandidate(requested, n)
    if ((await deps.storage.getProjectBySlug(candidate)) === null) return { slug: candidate, n }
  }
  return { slug: nextSlugCandidate(requested, SLUG_ATTEMPT_LIMIT), n: SLUG_ATTEMPT_LIMIT }
}
const ACCESS_VALUES: ProjectAccess[] = ["all-members", "invited", "public-link"]

/**
 * The public half of a `Deployment` — see `ProjectView.activeDeployment` for
 * why it is this narrow.
 */
export interface ActiveDeploymentView {
  status: DeploymentStatus
  /**
   * Deploy-time warnings (viewer-membership row 7 — root-absolute asset
   * references), or `null`. Included here, unlike `commitSha`/`buildLog`:
   * a warning describes asset REFERENCES already present in what this
   * deployment serves at `/p/{slug}/`, so any reader can already see the
   * same information by opening the page — unlike the build LOG, which can
   * carry install/build output from a private repo's toolchain (S2/S7).
   */
  warnings: DeploymentWarning[] | null
  /**
   * When the build was STARTED, not when it finished. `Deployment` stores no
   * completion time, so a long `building` row reads as older than it is. That
   * is the honest reading of the data we have; adding a `completedAt` column
   * is the fix if this ever needs to mean "last successful build."
   */
  createdAt: string
}

/**
 * The wire shape of a project.
 *
 * The private half — `repoConfig`, `repoUrl`, `embeddedId` — is OMITTED
 * (not blanked) for anyone who isn't an owner or the admin, the same
 * omit-don't-blank rule `MemberView.email` documents: a client must not be
 * able to mistake "not shown to you" for "this project genuinely has no
 * repo connected."
 */
export interface ProjectView {
  id: string
  slug: string
  name: string
  access: ProjectAccess
  activeDeploymentId: string | null
  createdAt: string
  /**
   * The deployment currently served at `/p/{slug}/`, when the route bothered
   * to load it. Three distinguishable states, on purpose:
   *
   * - **absent** — this route did not compute it (create/patch never do).
   * - **`null`** — there is no active deployment, or `activeDeploymentId`
   *   dangles at a row that no longer exists.
   * - **an object** — the live one.
   *
   * Same omit-don't-blank rule the private half follows: a client must never
   * be able to read "this route didn't ask" as "this project has never been
   * built."
   *
   * Only `status` and `createdAt` cross the wire. `commitSha` and `buildLog`
   * deliberately do not — the log can carry install/build output, which is
   * the same class of secret `repoConfig` is owner-gated for (security audit
   * S2). Status and a timestamp are already implied by what a reader can see
   * at `/p/{slug}/`, so they add no disclosure.
   */
  activeDeployment?: ActiveDeploymentView | null
  /** Owner/admin only — carries the GitHub App installation id and the build command line. */
  repoConfig?: ProjectRepoConfig | null
  /** Owner/admin only — free-text repo URL, i.e. the repo's identity. */
  repoUrl?: string | null
  /** Owner/admin only — the Editor join key, a capability someone may hold. */
  embeddedId?: string | null
}

/**
 * Serialises a project field by field. NEVER spread the entity here.
 *
 * Field-by-field construction means every reader — including an anonymous
 * holder of a `public-link` URL — only ever gets the private repo
 * owner/name, the built branch, the GitHub App `installationId`, the raw
 * install/build command line (the only place an operator can put a private
 * registry credential today) and the `embeddedId` capability on purpose
 * (security audit S2), and a future addition to `Project` cannot start
 * leaking here by accident; it has to be added on purpose.
 *
 * `effectivelyPublic` — the field that used to surface the state the plain
 * `visibility` column couldn't express (a `members` project with ZERO
 * members, readable by anyone despite its `visibility` literally reading
 * `"members"`) — was deleted with that column. `access` is a stored
 * tri-state, so it says what it means directly; there is nothing to derive.
 */
function toProjectView(
  project: Project,
  opts: {
    includePrivate: boolean
    /**
     * Pass `undefined` to omit the field, `null` to say "looked, found
     * none". Callers that never load a deployment must pass nothing at all
     * rather than `null` — see `ProjectView.activeDeployment`.
     */
    activeDeployment?: Deployment | null
  },
): ProjectView {
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    access: project.access,
    activeDeploymentId: project.activeDeploymentId,
    createdAt: project.createdAt,
    ...(opts.activeDeployment !== undefined
      ? {
          activeDeployment: opts.activeDeployment
            ? {
                status: opts.activeDeployment.status,
                warnings: opts.activeDeployment.warnings,
                createdAt: opts.activeDeployment.createdAt,
              }
            : null,
        }
      : {}),
    ...(opts.includePrivate
      ? {
          repoConfig: project.repoConfig,
          repoUrl: project.repoUrl,
          embeddedId: project.embeddedId,
        }
      : {}),
  }
}

/**
 * Loads the deployment currently served for a project, or `null`.
 *
 * Returns `null` for BOTH "never built" and "the id points at a row that is
 * gone" — the card cannot act on the difference and a dangling id is not a
 * reason to fail a whole list request.
 *
 * One point lookup per project, which makes the list route N+1. That is the
 * same shape `listProjects` already has for repo configs, and for the same
 * reason: this is a self-hosted single-process viewer whose project count is
 * measured in tens. If that ever stops being true, the fix is a batched
 * `getDeployments(ids)` on the storage adapter, not a cache here.
 */
async function loadActiveDeployment(
  storage: AppDeps["storage"],
  project: Project,
): Promise<Deployment | null> {
  if (!project.activeDeploymentId) return null
  return await storage.getDeployment(project.activeDeploymentId)
}

/**
 * Refuses `access: "public-link"` with the shared 409 when the instance-wide
 * kill switch is off, writing the response itself and returning `true` when
 * it did — callers `return` immediately on `true`, the same
 * guard-writes-its-own-response shape `requireProjectRead` etc. use in
 * `authorize.ts`. Shared by create and patch (Task 11 review fix; the two
 * routes had carried identical copies of this check).
 *
 * A caller who explicitly asks for `"public-link"` gets told why, rather
 * than silently handed a project that quietly isn't what they asked for —
 * so this only fires when `access` IS `"public-link"`; every other value
 * (including `undefined`) is untouched by the kill switch.
 */
async function refuseIfPublicLinksDisabled(
  deps: AppDeps,
  res: Response,
  access: unknown,
): Promise<boolean> {
  if (access !== "public-link") return false
  if (await getAllowPublicLinks(deps.storage)) return false
  res.status(409).json({ error: "Public links are disabled on this viewer" })
  return true
}

/**
 * The creator-lockout guard (Task 11), shared by create and patch. Adds the
 * caller to a project's access list when — and only when — they are about to
 * make (or have just made) a project THEY cannot read:
 *
 * - `requestedAccess !== "invited"` → no-op. `"invited"` is the one value
 *   whose readability depends on the access list at all, so it is the only
 *   value that can lock a creator out of their own project.
 * - No resolved `ctx.user` (e.g. the adminToken bearer alone, no session) →
 *   no-op: nobody to add.
 * - `ctx.user.role === "admin"` → no-op. An admin can always read every
 *   project regardless of the access list, so there is no lockout to prevent,
 *   and adding them would put an authority grant's holder on a list that
 *   decides nothing for them.
 *
 * ## Keyed on the USER'S ROLE, not on the request's admin authority (M2 fix)
 *
 * This used to skip whenever `hasAdminAuthority(ctx)` was true, which folds in
 * `ctx.isAdmin` — the `adminToken` BEARER. So an editor who sent the operator
 * token alongside their own session cookie (the Editor CLI's machine path, a
 * curl script an operator hands a colleague) created an `"invited"` project
 * and was NOT added to it. The bearer is a per-REQUEST capability: it evaporates
 * the moment they reload the dashboard in a browser, and the project they just
 * made is then a 404 to them. The rule this guard exists to enforce is about
 * what the caller can read TOMORROW, and only their account's lasting role
 * answers that — so it reads `ctx.user.role`, never `ctx.isAdmin`.
 *
 * The adminToken-alone case (no cookie at all) is still a no-op, but for the
 * `!ctx.user` reason rather than the authority one: there is genuinely nobody
 * to add.
 *
 * ## Keyed on the REQUESTED access value, not on the stored project (fix wave 9, item 1)
 *
 * This used to run AFTER `createProject`/`updateProject` had already
 * committed the `"invited"` access value, gated on `project.access` (the
 * value the storage call returned). That put the write that can lock someone
 * out BEFORE the write that prevents it: if `addProjectMember` then failed
 * (a lock, an IO error), the project already existed — or was already
 * patched — with `access: "invited"` and no member on it, and the request's
 * own 500 doubled as a real, persisted lockout of its own caller.
 *
 * Both call sites now invoke this BEFORE the storage call that would commit
 * `"invited"`, using the request body's `access` field directly rather than
 * a stored value that doesn't exist yet (create) or shouldn't be trusted
 * until the write actually lands (patch). A failure here still 500s, but it
 * leaves the project on whatever access it already had — never a persisted
 * `"invited"` with the caller locked out of what they just did.
 *
 * `addProjectMember` is idempotent, so calling this on an already-`"invited"`,
 * already-member project (e.g. re-PATCHing `access: "invited"` again) is a
 * harmless no-op too, never a duplicate or an error.
 */
async function addCreatorBeforeLockout(
  deps: AppDeps,
  /**
   * The identity `requireWrite` resolved, from `res.locals` — `null` only if
   * this route were ever mounted without that guard, in which case there is no
   * caller to add and the no-op below is the right answer.
   */
  ctx: ReadContext | null,
  projectId: string,
  /** The `access` field straight off the request body — see the doc comment above. */
  requestedAccess: unknown,
): Promise<void> {
  if (requestedAccess !== "invited") return
  if (!ctx) return
  if (!ctx.user) return
  if (ctx.user.role === "admin") return
  await deps.storage.addProjectMember({ projectId, userId: ctx.user.id })
}

// No explicit `Request`/`Response` annotations on the handlers below — see
// the same note in serve-router.ts: typing the params that way widens
// `req.params` to Express 5's generic `ParamsDictionary` (`string |
// string[]`), which fails strict typecheck. Leaving the callback untyped
// lets TS infer the precise per-route params type instead.
export function createProjectsRoutes(
  deps: AppDeps,
  requireWrite: RequestHandler,
): Router {
  const router = Router()

  // Filters rather than 404s: an unreadable project is simply absent from
  // the list (see authorize.ts — a 403/omission distinction doesn't apply
  // to a list endpoint the way it does to a by-id lookup).
  router.get("/projects", async (req, res) => {
    const projects = await deps.storage.listProjects()
    const ctx = await resolveReadContext(deps, req)
    if ("error" in ctx) {
      res.status(401).json({ error: ctx.error })
      return
    }
    const membership = makeProjectMembership(deps.storage)
    // Loaded ONCE for the whole list, not per project: it is an
    // instance-wide setting, and re-reading it inside the loop would make a
    // mid-request toggle produce a list whose entries disagree about the
    // rule they were filtered by.
    const policy = await loadProjectReadPolicy(deps.storage)
    // Manage authority is a property of the CALLER, not of the project, so it
    // is computed once too. Sound only because it is applied downstream of
    // the `canReadProject` filter below — an unreadable project never reaches
    // the projection at all.
    const canManage = hasProjectManageAuthority(ctx)
    const readable: ProjectView[] = []
    for (const project of projects) {
      if (await canReadProject(ctx, project, membership, policy)) {
        readable.push(
          toProjectView(project, {
            includePrivate: canManage,
            activeDeployment: await loadActiveDeployment(deps.storage, project),
          }),
        )
      }
    }
    // Instance-wide, not per-project — read once for the whole response
    // rather than inside the loop, same reasoning as `policy` above.
    res.json({ projects: readable, publicLinksEnabled: policy.allowPublicLinks })
  })

  router.get("/projects/:id", async (req, res) => {
    // ONE read of the caller and ONE read of the instance policy (M2 review
    // fix). This route previously called `requireProjectRead` (which resolves
    // the caller and loads the policy internally), then re-resolved the caller
    // for `includePrivate`, then re-read `allowPublicLinks` for the response —
    // three round-trips for two facts the guard had in hand, and a
    // `publicLinksEnabled` sampled at a DIFFERENT instant from the one that
    // decided readability. `requireProjectReadWithPolicy` is the same guard
    // handing both back instead of discarding them.
    const access = await requireProjectReadWithPolicy(deps, req, res, req.params.id)
    if (!access) return
    const { project, ctx, policy } = access
    res.json({
      ...toProjectView(project, {
        activeDeployment: await loadActiveDeployment(deps.storage, project),
        // Downstream of the read gate above, which is the precondition
        // `hasProjectManageAuthority` cannot check for itself.
        includePrivate: hasProjectManageAuthority(ctx),
      }),
      // Task 11: the instance-wide kill-switch state, merged onto the
      // project object rather than folded into `toProjectView` — it is a
      // fact about the INSTANCE, not a field of the project entity, and
      // `toProjectView` stays a pure per-project projection.
      publicLinksEnabled: policy.allowPublicLinks,
      // Whether THIS caller may write comments here, answered by the server
      // rather than re-derived in the browser.
      //
      // The client cannot compute it: an anonymous visitor is refused
      // `GET /instance/settings` (admin only), and the rule combines that
      // instance setting with what the caller's credential resolved to. This
      // repo has shipped the same defect three times by having the client
      // reason about auth from a flag that meant something narrower than it
      // looked, so the answer is computed where the refusal is.
      //
      // Sent on the same read that decided visibility, so it cannot be sampled
      // at a different instant from the policy above.
      canComment: !isAnonymous(ctx) || (await getAllowAnonymousComments(deps.storage)),
    })
  })

  /**
   * Reconcile a checkout against this viewer's projects — the protocol the
   * Editor calls before creating a project, and again when linking an
   * existing one. See `project-resolve.ts` for why the decision is made here
   * rather than in shared code.
   *
   * Public-read, like the comments routes: it reveals only whether a project
   * exists for an id or a repo the caller already knows, and answering
   * requires no membership. The alternative -- gating it -- would mean the
   * Editor could not prevent a duplicate project without first being signed
   * in, which is exactly the collision this exists to avoid.
   */
  router.post("/projects/resolve", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const embeddedId = typeof body.embeddedId === "string" ? body.embeddedId.trim() : ""
    const remoteUrl = typeof body.remoteUrl === "string" ? body.remoteUrl.trim() : ""
    const name = typeof body.name === "string" ? body.name : undefined

    if (embeddedId === "" && remoteUrl === "") {
      res.status(400).json({ error: "embeddedId or remoteUrl is required" })
      return
    }

    const byEmbeddedId = embeddedId
      ? await deps.storage.getProjectByEmbeddedId(embeddedId)
      : null

    // An unparseable remote is not an error -- it just means the by-repo
    // discovery index can't help, so we fall through to mint/adopt on the id.
    const parsed = remoteUrl ? parseRepoRemote(remoteUrl) : null
    const byRepo = parsed
      ? await deps.storage.getProjectByRepo(parsed.owner, parsed.name)
      : null

    res.json(
      decideResolution(
        {
          ...(embeddedId ? { embeddedId } : {}),
          ...(remoteUrl ? { remoteUrl } : {}),
          ...(name !== undefined ? { name } : {}),
        },
        { byEmbeddedId, byRepo },
      ),
    )
  })

  router.post("/projects", requireWrite, async (req, res) => {
    const { slug, name, repoUrl, access } = req.body ?? {}

    if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) {
      res.status(400).json({
        error:
          "Invalid slug: use 2-63 lowercase letters, digits or hyphens, starting with a letter or digit",
      })
      return
    }
    if (typeof name !== "string" || name.trim() === "") {
      res.status(400).json({ error: "name is required" })
      return
    }
    if (access !== undefined && !ACCESS_VALUES.includes(access)) {
      res.status(400).json({ error: `access must be one of ${ACCESS_VALUES.join(", ")}` })
      return
    }
    if (await refuseIfPublicLinksDisabled(deps, res, access)) return

    try {
      // Fix wave 9, item 1: when the request asks for `access: "invited"`,
      // the project is created on its harmless default first — never
      // `"invited"` in THIS call — so the creator-lockout guard below can add
      // the membership row before the value that depends on it is ever
      // written. See `addCreatorBeforeLockout`'s doc comment for the defect
      // this ordering replaces. Any other requested value (including
      // `undefined`) carries no lockout risk and is set here directly, same
      // as before.
      // A taken slug is not the caller's problem any more (Mo, 2026-08-29:
      // "can we not be smart and append some digits to make the slug unique.
      // We also don't have to show that to the user"). `checkout-redesign`
      // becomes `checkout-redesign-2`, and the 409 that used to send someone
      // back to invent a variation is gone.
      //
      // Two layers, and both are needed. `findFreeSlug` ASKS which candidates
      // are free, which is a read followed by a write with a gap in between —
      // two creates racing on the same name can both be told `-2` is free. So
      // the create is also retried on `ConflictError`, advancing the suffix
      // each time. The search makes collisions rare; the retry makes them
      // correct.
      //
      // The retry is scoped to THIS call. Everything after it (the membership
      // row, the access flip) already has its own rollback below, and a
      // conflict cannot originate there.
      let project: Project | undefined
      let attempt = await findFreeSlugAttempt(deps, slug)
      for (;;) {
        try {
          project = await deps.storage.createProject({
            slug: attempt.slug,
            name: name.trim(),
            repoUrl: typeof repoUrl === "string" ? repoUrl : null,
            access: access === "invited" ? undefined : access,
          })
          break
        } catch (createError) {
          if (!(createError instanceof ConflictError) || attempt.n >= SLUG_ATTEMPT_LIMIT) throw createError
          attempt = { slug: nextSlugCandidate(slug, attempt.n + 1), n: attempt.n + 1 }
        }
      }
      // Creator-lockout guard (Task 11; narrowed from the Phase 3b-1/3b-2
      // membership-on-create rule, which added EVERY signed-in creator
      // regardless of `access` — see `addCreatorBeforeLockout` for the full
      // rule). This route is already `requireWrite`-gated, so reaching here
      // always means admin authority or an `editor`-role caller (with
      // `write` scope when the credential is a PAT).
      //
      // `getRequestContext` reads the identity that guard already resolved
      // (M2 review fix) — this used to call `resolveReadContext` a second
      // time, which is both a wasted session/PAT lookup and a chance for the
      // handler to act on a different answer than the gate did.
      //
      // Fix wave 11, item 2: the post-create steps below run AFTER the row
      // exists, so a throw in either leaves a PROVISIONAL project behind —
      // created at the harmless `all-members` default when the caller asked
      // for `invited`, with the slug now taken. That is worse than a clean
      // failure two ways: an `invited` project stranded at `all-members` is
      // readable by every instance member (the exact contents the caller
      // wanted restricted), and the squatted slug blocks a retry. So on any
      // failure here we roll the provisional row back and rethrow, making
      // the 500 mean "nothing persisted". (For non-`invited` access both
      // steps are no-ops — `addCreatorBeforeLockout` returns early and the
      // flip is skipped — so this rollback only ever fires for `invited`.)
      try {
        const ctx = getRequestContext(res)
        await addCreatorBeforeLockout(deps, ctx, project.id, access)
        if (access === "invited") {
          // The membership row (if any) is in place — now it's safe to
          // commit the value that depends on it. Between `createProject`
          // above and this call the project briefly exists at its harmless
          // `all-members` default; that window is bounded to these two
          // `await`s and closes on success. This ordering (row first, flip
          // second) is the fix wave 9, item 1 trade: committing `invited`
          // FIRST then adding the row is what could strand the creator
          // locked out if `addProjectMember` failed.
          project = await deps.storage.updateProject(project.id, { access: "invited" })
        }
      } catch (postCreateError) {
        // Best-effort cleanup. If the rollback delete ITSELF fails, log it
        // and still surface the ORIGINAL failure — the caller needs the 500
        // that names why the create failed, not the delete's error. Worst
        // case a stranded row survives, exactly the pre-fix state.
        try {
          await deps.storage.deleteProject(project.id)
        } catch (rollbackError) {
          console.error(
            `[viewer] failed to roll back provisional project ${project.id} after a create failure:`,
            rollbackError,
          )
        }
        throw postCreateError
      }
      // `requireWrite` already proved the caller holds instance-editor
      // authority (admin bearer, `admin` role, or `editor` role), which is
      // the manage rule for the project they just created — so the private
      // half is theirs to see. Routed through the projection anyway so there
      // is exactly ONE function that decides what a project looks like on
      // the wire.
      res.status(201).json(toProjectView(project, { includePrivate: true }))
    } catch (error) {
      if (error instanceof ConflictError) {
        res.status(409).json({ error: error.message })
        return
      }
      throw error
    }
  })

  router.patch("/projects/:id", requireWrite, async (req, res) => {
    const { name, repoUrl, access } = req.body ?? {}
    if (access !== undefined && !ACCESS_VALUES.includes(access)) {
      res.status(400).json({ error: `access must be one of ${ACCESS_VALUES.join(", ")}` })
      return
    }
    if (await refuseIfPublicLinksDisabled(deps, res, access)) return
    try {
      // Composing a plain `RequestHandler`-typed guard (`requireWrite`) with
      // this route handler makes Express 5's overload resolution widen the
      // inferred `req.params` for the WHOLE handler array back to
      // `ParamsDictionary` (`string | string[]`) — unlike the guard-free GET
      // above, whose params stay precisely inferred from the route string.
      // A single named `:id` segment is never an array (only the `{*rest}`
      // wildcard is), so this is a safe, non-widening coercion, not a cast
      // past a real ambiguity.
      const id = String(req.params.id)
      // Creator-lockout guard (Task 11), the PATCH sibling of the create
      // route's version above — see `addCreatorBeforeLockout` for the full
      // rule. Fix wave 9, item 1: invoked BEFORE `updateProject`, not after
      // — the old order committed the access change first and added the
      // membership row second, so an `addProjectMember` failure there left a
      // real, already-invited project with its own caller not on the list.
      // Reading `access` straight off the request body (rather than waiting
      // for the updated project) is what makes running it first possible; it
      // is still a no-op for a PATCH that never touches `access` (a plain
      // rename), and reads the identity `requireWrite` resolved rather than
      // resolving the request a second time — see the create route above.
      await addCreatorBeforeLockout(deps, getRequestContext(res), id, access)
      const project = await deps.storage.updateProject(id, {
        ...(typeof name === "string" ? { name: name.trim() } : {}),
        ...(repoUrl !== undefined ? { repoUrl: repoUrl === null ? null : String(repoUrl) } : {}),
        ...(access !== undefined ? { access } : {}),
      })
      // Manage-gated (`requireWrite` with an `:id` param routes to
      // `requireProjectManage`) — see the create route above for why this
      // still goes through the projection.
      res.json(toProjectView(project, { includePrivate: true }))
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message })
        return
      }
      throw error
    }
  })

  // Task 11: route-only — the delete UI comes with Task 12. DB rows cascade
  // via `storage.deleteProject` (comments, deployments, participants, the
  // notification outbox/optouts, members, and the repo config all go with
  // the project row; see that method's storage-layer doc comment) — but the
  // built-prototype ASSET directories on disk are a separate store keyed by
  // deployment id, so this route reclaims them itself below, AFTER the DB
  // delete has actually committed.
  router.delete("/projects/:id", async (req, res) => {
    const project = await requireProjectManage(deps, req, res, String(req.params.id), "delete this project")
    if (!project) return
    // Fix wave 10, item 2: the whole body below runs under the project's
    // lock, so it cannot interleave with a build (or bundle-upload) START
    // racing on the same project id — see `project-locks.ts`. The build
    // itself, once started, runs OUTSIDE any lock (it can take minutes); only
    // its brief "does the project still exist, create a deployment row" start
    // is what this has to serialize against.
    await withProjectLock(project.id, async () => {
      // Snapshotted BEFORE the DB delete: the deployment ROWS are what name
      // the asset directories, and `deleteProject` below cascades them away,
      // so this is the last moment their ids are readable.
      const deployments = await deps.storage.listDeployments(project.id)
      // Fix wave 7, item 2: a build in progress writes its OWN asset
      // directory as it goes (`in-process-build-runner.ts`) and, on success,
      // updates the project's `activeDeploymentId` — both AFTER this route
      // could otherwise have already cascaded the DB rows and reclaimed
      // every deployment directory below. A build finishing into a project
      // that no longer exists writes files nothing will ever serve or clean
      // up, and can race the `Promise.allSettled` cleanup below into
      // deleting a directory the build is still writing. Refusing while any
      // deployment is `"building"` closes the race at its source instead of
      // chasing it downstream.
      if (deployments.some((d) => d.status === "building")) {
        res.status(409).json({
          error: "A build is in progress. Wait for it to finish, then delete the project.",
        })
        return
      }
      // DB FIRST (wave 2, codex round 2 review fix). `deleteProject` is
      // already transactional (see its own doc comment), so it either fully
      // lands or fully doesn't. The route used to delete the on-disk asset
      // directories BEFORE this call — so a DB failure here (a lock, an IO
      // error) left a project whose row (and every reference to it:
      // comments, members, the dashboard listing) still existed, but whose
      // built files were already gone. Doing the DB delete first means a
      // failure here leaves the project exactly as it was, files included,
      // and the request 500s instead of quietly half-deleting it.
      await deps.storage.deleteProject(project.id)
      // Asset directories are keyed by DEPLOYMENT id, not project id, and
      // `storage.deleteProject` above only ever cleans DB rows — it never
      // touches `deps.assets`. The only other caller of `assets.deleteDeployment`
      // is `pruneSupersededDeploymentAssets` (build/publish-output.ts), which
      // runs on the OPPOSITE trigger (a new deployment activating for this
      // same project), so nothing reclaims a deleted project's deployment
      // directories unless this route does it itself (review fix, Task 11).
      //
      // In PARALLEL (M2 review fix) and best-effort (`allSettled`, not
      // `all`): these are independent directory removals with no ordering
      // between them, and the DB delete has already committed by this
      // point, so a cleanup failure here is a disk-cleanliness problem, not
      // a reason to report the delete as failed — the alternative is a
      // project the operator can never remove because one old deployment's
      // asset directory has a permissions problem. `all` would reject on
      // the first failure and skip the rest; `allSettled` runs them all and
      // logs each.
      const cleanups = await Promise.allSettled(
        deployments.map((deployment) => deps.assets.deleteDeployment(deployment.id)),
      )
      cleanups.forEach((result, index) => {
        if (result.status === "rejected") {
          console.error(
            `[viewer] failed to delete assets for deployment ${deployments[index]?.id}:`,
            result.reason,
          )
        }
      })
      res.status(204).end()
    })
  })

  return router
}
