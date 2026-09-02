/**
 * GitHub App discovery routes (Phase 3c-1 Task 4): `GET
 * /github/installations` and `GET /github/installations/:id/repos`. Both are
 * account-scoped, not project-scoped — they answer "what can THIS CALLER
 * see", not "what can this project see" — so neither uses
 * `requireProjectRead`/`requireProjectManage`; the connect/disconnect
 * mutations that DO touch a specific project live in
 * `project-repo-routes.ts`.
 *
 * **Phase 3c-1b changed the subject of that question.** These routes
 * originally answered "what can the APP see", which meant any signed-in
 * account could enumerate every installation and private-repo name the App
 * could reach. Both now filter through `github/caller-installations.ts`
 * against the caller's own server-derived installation set.
 *
 * **Unconfigured-App shape.** Follows `auth-routes.ts`'s `/me` precedent
 * (`{ user, authEnabled }` — always 200, a flag distinguishes "signed out"
 * from "not configured on this deployment") rather than either 404ing or
 * simply not registering the routes: "there is no App client" is a
 * deployment-level fact the UI needs to render "install the GitHub App"
 * messaging, and that fact must be checkable WITHOUT signing in first (a
 * signed-out visitor should see "not configured", not "sign in required" —
 * see T5's distinct-states list in the phase plan). So both routes are
 * ALWAYS registered and answer `{ configured: false, installations: [] }` /
 * `{ configured: false, repos: [] }` before the signed-in check runs, never
 * a 500 and never a route the router fails to register. A status-code-based
 * feature test (404 vs 200) is exactly what 3a's `/me` doc comment calls
 * brittle — the same reasoning applies here.
 *
 * The fact is read off `deps.github.appClient`, the LIVE client, not
 * `config.githubApp` — an App created mid-process through the manifest flow
 * has to flip `configured` to true without a restart. See
 * `github-runtime.ts`.
 */

import { Router, type Request, type Response } from "express"
import type { AppDeps } from "../create-app"
import { resolveReadContext } from "../auth/authorize"
import { callerCanSeeInstallation, resolveCallerInstallations } from "../github/caller-installations"
import type { User } from "../storage/types"

/**
 * Resolves the signed-in caller for both routes below. Deliberately allows
 * EITHER a session cookie OR a valid machine token (unlike
 * `tokens-routes.ts`'s `resolveSessionOnlyUser`, which excludes PATs on
 * purpose because a leaked PAT must never be able to mint another PAT).
 * There is no equivalent escalation risk here — listing installations/repos
 * is read-only and grants no new credential — so a CI script authenticated
 * with a `read`-scoped PAT is "signed in" for this purpose same as a
 * browser session. The bare admin bearer (no cookie attached) resolves
 * `ctx.user` to `null` — see `resolveReadContext`'s doc comment, the admin
 * bearer asserts no identity of its own — so it does NOT count as signed in
 * here; there is no "installations for the admin" concept to answer.
 */
async function requireSignedInUser(
  deps: Pick<AppDeps, "storage" | "config">,
  req: Pick<Request, "headers" | "get">,
  res: Response,
): Promise<User | null> {
  const ctx = await resolveReadContext(deps, req)
  if ("error" in ctx) {
    res.status(401).json({ error: ctx.error })
    return null
  }
  if (!ctx.user) {
    res.status(401).json({ error: "Sign in required" })
    return null
  }
  return ctx.user
}

export function createGithubRoutes(deps: AppDeps): Router {
  const router = Router()

  router.get("/github/installations", async (req, res) => {
    // Read into a local BEFORE the first `await`. `deps.github.appClient` is a
    // mutable property (the manifest flow replaces it mid-process), so
    // TypeScript's narrowing of it does not survive an intervening await —
    // and neither does the VALUE: a reload between the check and the use
    // would hand this handler a different client than the one it tested.
    const appClient = deps.github.appClient
    // The slug is read HERE, in the same synchronous step as the client, and
    // not down in the response below. Both describe the same App, and the two
    // reads are separated by two awaits — a reload landing between them would
    // pair the NEW App's slug with the OLD client's installations, sending the
    // UI to install an App that has nothing to do with the list it is showing.
    const appSlug = deps.github.config.githubApp?.slug ?? null
    if (!appClient) {
      res.json({ configured: false, appSlug: null, installations: [] })
      return
    }
    const user = await requireSignedInUser(deps, req, res)
    if (!user) return
    // Phase 3c-1b: THIS CALLER'S installations, not the App's. The previous
    // `listInstallations()` passthrough handed every signed-in account the
    // App's entire inventory — including the names of private repos'
    // owning orgs — which is the finding this phase closes. See
    // `caller-installations.ts`.
    const { installations, syncedAt, stale } = await resolveCallerInstallations(
      { storage: deps.storage, githubApp: appClient },
      user,
    )
    // `appSlug` lets the UI link at github.com/apps/{slug}/installations/new —
    // "install THIS App" — instead of the generic settings page, which makes an
    // operator hunt for the right App by name. The slug is public (it is in the
    // App's own URL); it is not a credential.
    // `?? null` rather than an assertion: the injected CLIENT and the parsed
    // CONFIG are independently nullable (tests inject a fake client with no
    // config at all), so the two are not interchangeable even though a real
    // boot sets them together.
    //
    // `installationsSyncedAt` / `installationsStale` exist so an empty list
    // is explainable: the set is a snapshot taken at sign-in, and the only
    // way to refresh it is to sign in again (no provider credential is
    // stored). Without the flag the UI could only say "you have no
    // installations", which is wrong advice for a caller whose snapshot
    // simply predates the App install.
    res.json({
      configured: true,
      appSlug,
      installations,
      installationsSyncedAt: syncedAt,
      installationsStale: stale,
    })
  })

  router.get("/github/installations/:id/repos", async (req, res) => {
    // Same read-before-await rule as the route above.
    const appClient = deps.github.appClient
    if (!appClient) {
      res.json({ configured: false, repos: [] })
      return
    }
    const user = await requireSignedInUser(deps, req, res)
    if (!user) return

    const installationId = Number(req.params.id)
    if (!Number.isInteger(installationId) || installationId <= 0) {
      res.status(400).json({ error: "installation id must be a positive integer" })
      return
    }

    // Same "installationId is not an authorization boundary" rule the
    // PUT /projects/:id/repo route enforces (see project-repo-routes.ts) —
    // a client-supplied id is verified server-side before it's used for
    // anything, rather than handed straight to `listInstallationRepos`.
    //
    // Phase 3c-1b changed WHAT it is verified against: the CALLER's
    // installation set, not the App's. `callerCanSeeInstallation` returns a
    // bare boolean precisely so this handler cannot tell "no such
    // installation" from "exists, but not yours" even if it wanted to —
    // both land on the single 404 below, byte-identical in status and body,
    // per Phase 3b-1's no-existence-oracle rule. That identity is
    // structural (one response statement, one code path), not a matter of
    // keeping two literals in sync.
    if (!(await callerCanSeeInstallation({ storage: deps.storage, githubApp: appClient }, user, installationId))) {
      res.status(404).json({ error: "Installation not found" })
      return
    }

    const repos = await appClient.listInstallationRepos(installationId)
    res.json({ configured: true, repos })
  })

  /**
   * Branch names for ONE repo in an installation, for the connect form's
   * branch picker.
   *
   * Two authorization checks, not one. `callerCanSeeInstallation` is the same
   * gate the repos route uses, and it is NOT sufficient here: it answers "may
   * this caller see this installation", while the client also names a repo.
   * Without the membership check below, a caller with any installation could
   * ask for branch names of any repo they could guess, and GitHub would
   * answer for a public one.
   *
   * So the repo must be IN the installation's list, which is the same
   * membership oracle `project-repo-routes.ts` uses and the reason
   * `getRepo` does not exist on the client (see `types.ts`). A repo that is
   * not in it lands on the SAME 404 as an installation the caller cannot see
   * — one response statement, one code path, so the handler cannot leak
   * which of the two it was.
   */
  router.get("/github/installations/:id/repos/:owner/:name/branches", async (req, res) => {
    // Same read-before-await rule as the routes above.
    const appClient = deps.github.appClient
    if (!appClient) {
      res.json({ configured: false, branches: [] })
      return
    }
    const user = await requireSignedInUser(deps, req, res)
    if (!user) return

    const installationId = Number(req.params.id)
    if (!Number.isInteger(installationId) || installationId <= 0) {
      res.status(400).json({ error: "installation id must be a positive integer" })
      return
    }

    const owner = String(req.params.owner)
    const name = String(req.params.name)

    const visible = await callerCanSeeInstallation(
      { storage: deps.storage, githubApp: appClient },
      user,
      installationId,
    )
    const inInstallation =
      visible &&
      (await appClient.listInstallationRepos(installationId)).some(
        (r) => r.owner.toLowerCase() === owner.toLowerCase() && r.name.toLowerCase() === name.toLowerCase(),
      )
    if (!inInstallation) {
      res.status(404).json({ error: "Repository not found" })
      return
    }

    const branches = await appClient.listBranches(installationId, owner, name)
    res.json({ configured: true, branches })
  })

  return router
}
