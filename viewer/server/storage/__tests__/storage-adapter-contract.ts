import { describe, expect, it } from "vitest"
import { ConflictError, NotFoundError } from "../errors"
import { LOG_TRUNCATION_MARKER, MAX_BUILD_LOG_BYTES } from "../log-append"
import type { ProjectRepoConfig, StorageAdapter, UserInstallationEntry } from "../types"

export interface StorageAdapterContractOptions {
  makeStore: () => Promise<StorageAdapter> | StorageAdapter
  cleanup?: () => Promise<void> | void
}

export function storageAdapterContract(
  name: string,
  opts: StorageAdapterContractOptions,
): void {
  describe(`StorageAdapter contract: ${name}`, () => {
    async function fresh(): Promise<StorageAdapter> {
      return await opts.makeStore()
    }

    it("starts empty", async () => {
      const store = await fresh()
      expect(await store.listProjects()).toEqual([])
      await store.close()
      await opts.cleanup?.()
    })

    it("creates a project with defaults and reads it back by id and slug", async () => {
      const store = await fresh()
      const created = await store.createProject({ slug: "acme", name: "Acme" })

      expect(created.id).toBeTruthy()
      expect(created.slug).toBe("acme")
      expect(created.name).toBe("Acme")
      expect(created.repoUrl).toBeNull()
      expect(created.access).toBe("all-members")
      expect(created.activeDeploymentId).toBeNull()
      expect(Date.parse(created.createdAt)).not.toBeNaN()

      expect(await store.getProject(created.id)).toEqual(created)
      expect(await store.getProjectBySlug("acme")).toEqual(created)
      expect(await store.listProjects()).toEqual([created])

      await store.close()
      await opts.cleanup?.()
    })

    it("returns null for unknown ids and slugs", async () => {
      const store = await fresh()
      expect(await store.getProject("nope")).toBeNull()
      expect(await store.getProjectBySlug("nope")).toBeNull()
      expect(await store.getDeployment("nope")).toBeNull()
      await store.close()
      await opts.cleanup?.()
    })

    it("rejects a duplicate slug", async () => {
      const store = await fresh()
      await store.createProject({ slug: "acme", name: "Acme" })
      await expect(
        store.createProject({ slug: "acme", name: "Acme Two" }),
      ).rejects.toThrow(/already exists/i)
      await store.close()
      await opts.cleanup?.()
    })

    it("updates a project and leaves unpatched fields alone", async () => {
      const store = await fresh()
      const created = await store.createProject({
        slug: "acme",
        name: "Acme",
        repoUrl: "https://github.com/acme/proto",
      })

      const updated = await store.updateProject(created.id, {
        name: "Acme Renamed",
        access: "public-link",
      })

      expect(updated.name).toBe("Acme Renamed")
      expect(updated.access).toBe("public-link")
      expect(updated.repoUrl).toBe("https://github.com/acme/proto")
      expect(updated.slug).toBe("acme")
      expect(await store.getProject(created.id)).toEqual(updated)

      await store.close()
      await opts.cleanup?.()
    })

    it("round-trips all three access values through create and update", async () => {
      const store = await fresh()

      const allMembers = await store.createProject({ slug: "am", name: "AM", access: "all-members" })
      expect(allMembers.access).toBe("all-members")
      const invited = await store.createProject({ slug: "inv", name: "Inv", access: "invited" })
      expect(invited.access).toBe("invited")
      const publicLink = await store.createProject({ slug: "pl", name: "PL", access: "public-link" })
      expect(publicLink.access).toBe("public-link")

      const toInvited = await store.updateProject(allMembers.id, { access: "invited" })
      expect(toInvited.access).toBe("invited")
      const toPublicLink = await store.updateProject(allMembers.id, { access: "public-link" })
      expect(toPublicLink.access).toBe("public-link")
      const toAllMembers = await store.updateProject(allMembers.id, { access: "all-members" })
      expect(toAllMembers.access).toBe("all-members")

      await store.close()
      await opts.cleanup?.()
    })

    it("throws when updating a missing project", async () => {
      const store = await fresh()
      await expect(store.updateProject("nope", { name: "x" })).rejects.toThrow(
        /not found/i,
      )
      await store.close()
      await opts.cleanup?.()
    })

    // -----------------------------------------------------------------
    // Embedded identity (the repo-side project id both surfaces join on)
    // -----------------------------------------------------------------

    it("defaults embeddedId to null and round-trips one that is set", async () => {
      const store = await fresh()
      const project = await store.createProject({ slug: "p", name: "P" })
      expect(project.embeddedId).toBeNull()

      const updated = await store.setProjectEmbeddedId(project.id, "emb-1")
      expect(updated.embeddedId).toBe("emb-1")
      expect((await store.getProject(project.id))?.embeddedId).toBe("emb-1")
      await store.close()
      await opts.cleanup?.()
    })

    it("finds a project by its embedded id, and returns null for an unknown one", async () => {
      const store = await fresh()
      const project = await store.createProject({ slug: "p", name: "P" })
      await store.setProjectEmbeddedId(project.id, "emb-1")

      expect((await store.getProjectByEmbeddedId("emb-1"))?.id).toBe(project.id)
      expect(await store.getProjectByEmbeddedId("nope")).toBeNull()
      await store.close()
      await opts.cleanup?.()
    })

    it("refuses to give two projects the same embedded id", async () => {
      // Two repos carrying one id is the fork case (C5). The store must not
      // silently let the second claim it -- comments hang off this join key.
      const store = await fresh()
      const a = await store.createProject({ slug: "a", name: "A" })
      const b = await store.createProject({ slug: "b", name: "B" })
      await store.setProjectEmbeddedId(a.id, "emb-1")
      await expect(store.setProjectEmbeddedId(b.id, "emb-1")).rejects.toThrow()
      await store.close()
      await opts.cleanup?.()
    })

    it("re-setting the SAME embedded id on the same project is idempotent", async () => {
      const store = await fresh()
      const project = await store.createProject({ slug: "p", name: "P" })
      await store.setProjectEmbeddedId(project.id, "emb-1")
      const again = await store.setProjectEmbeddedId(project.id, "emb-1")
      expect(again.embeddedId).toBe("emb-1")
      await store.close()
      await opts.cleanup?.()
    })

    it("throws when setting an embedded id on a missing project", async () => {
      const store = await fresh()
      await expect(store.setProjectEmbeddedId("nope", "emb-1")).rejects.toThrow()
      await store.close()
      await opts.cleanup?.()
    })

    it("drops the embedded id when the project is deleted, freeing it for reuse", async () => {
      const store = await fresh()
      const a = await store.createProject({ slug: "a", name: "A" })
      await store.setProjectEmbeddedId(a.id, "emb-1")
      await store.deleteProject(a.id)
      expect(await store.getProjectByEmbeddedId("emb-1")).toBeNull()

      const b = await store.createProject({ slug: "b", name: "B" })
      await expect(store.setProjectEmbeddedId(b.id, "emb-1")).resolves.toBeTruthy()
      await store.close()
      await opts.cleanup?.()
    })

    // -----------------------------------------------------------------
    // Repo lookup (the discovery index that prevents most collisions)
    // -----------------------------------------------------------------

    it("finds a connected project by its repo, case-insensitively", async () => {
      const store = await fresh()
      const project = await store.createProject({ slug: "p", name: "P" })
      await store.setProjectRepoConfig(project.id, {
        installationId: 1,
        owner: "Acme",
        name: "Proto",
        defaultBranch: "main",
        branch: "main",
        installCommand: "npm ci",
        buildCommand: "npm run build",
        outputDir: "dist",
        autoDeploy: true,
      })
      // GitHub treats owner/name case-insensitively, so a lookup that
      // disagreed would mint a duplicate project for the same repo.
      expect((await store.getProjectByRepo("acme", "proto"))?.id).toBe(project.id)
      expect((await store.getProjectByRepo("ACME", "PROTO"))?.id).toBe(project.id)
      await store.close()
      await opts.cleanup?.()
    })

    it("returns null from getProjectByRepo when nothing is connected", async () => {
      const store = await fresh()
      await store.createProject({ slug: "p", name: "P" })
      expect(await store.getProjectByRepo("acme", "proto")).toBeNull()
      await store.close()
      await opts.cleanup?.()
    })

    it("deletes a project", async () => {
      const store = await fresh()
      const created = await store.createProject({ slug: "acme", name: "Acme" })
      await store.deleteProject(created.id)
      expect(await store.getProject(created.id)).toBeNull()
      expect(await store.listProjects()).toEqual([])
      await store.close()
      await opts.cleanup?.()
    })

    // See StorageAdapter.listDeployments contract: ordering by createdAt requires
    // a deterministic secondary key (creation order) to handle ties within milliseconds.
    it("creates deployments scoped to their project, newest first", async () => {
      const store = await fresh()
      const a = await store.createProject({ slug: "a", name: "A" })
      const b = await store.createProject({ slug: "b", name: "B" })

      const first = await store.createDeployment({ projectId: a.id })
      const second = await store.createDeployment({
        projectId: a.id,
        commitSha: "abc123",
      })
      await store.createDeployment({ projectId: b.id })

      expect(first.status).toBe("building")
      expect(first.commitSha).toBeNull()
      expect(first.buildLog).toBe("")
      expect(second.commitSha).toBe("abc123")
      // Born null — only the runner's post-clone update ever sets it.
      expect(second.commitMessage).toBeNull()

      const listed = await store.listDeployments(a.id)
      expect(listed.map((d) => d.id)).toEqual([second.id, first.id])

      await store.close()
      await opts.cleanup?.()
    })

    it("updates the commit message the runner resolves at clone time, and reads it back", async () => {
      const store = await fresh()
      const project = await store.createProject({ slug: "msg", name: "Msg" })
      const deployment = await store.createDeployment({ projectId: project.id })

      const updated = await store.updateDeployment(deployment.id, {
        commitSha: "9e21c7f4",
        commitMessage: "Tighten checkout summary spacing",
      })
      expect(updated.commitMessage).toBe("Tighten checkout summary spacing")

      const readBack = await store.getDeployment(deployment.id)
      expect(readBack?.commitMessage).toBe("Tighten checkout summary spacing")
      // An update that says nothing about the message leaves it alone.
      const after = await store.updateDeployment(deployment.id, { status: "deployed" })
      expect(after.commitMessage).toBe("Tighten checkout summary spacing")

      await store.close()
      await opts.cleanup?.()
    })

    it("updates deployment status and build log", async () => {
      const store = await fresh()
      const project = await store.createProject({ slug: "a", name: "A" })
      const deployment = await store.createDeployment({ projectId: project.id })

      const updated = await store.updateDeployment(deployment.id, {
        status: "deployed",
        buildLog: "done\n",
      })

      expect(updated.status).toBe("deployed")
      expect(updated.buildLog).toBe("done\n")
      expect(await store.getDeployment(deployment.id)).toEqual(updated)

      await store.close()
      await opts.cleanup?.()
    })

    it("starts a new deployment with warnings: null, and round-trips a warnings array through updateDeployment", async () => {
      const store = await fresh()
      const project = await store.createProject({ slug: "a", name: "A" })
      const created = await store.createDeployment({ projectId: project.id })
      expect(created.warnings).toBeNull()

      const warnings = [
        {
          kind: "root-absolute-assets" as const,
          summary: "1 root-absolute asset reference found in 1 file",
          findings: [{ file: "index.html", kind: "html-attr" as const, sample: '<script src="/assets/x.js">' }],
        },
      ]
      const withWarnings = await store.updateDeployment(created.id, { warnings })
      expect(withWarnings.warnings).toEqual(warnings)
      expect(await store.getDeployment(created.id)).toEqual(withWarnings)

      // Clearing back to null is a distinct, real state — not merely "the
      // patch omitted the field" (`omitUndefined` lets an explicit `null`
      // through; only `undefined` is dropped).
      const cleared = await store.updateDeployment(created.id, { warnings: null })
      expect(cleared.warnings).toBeNull()
      expect(await store.getDeployment(created.id)).toEqual(cleared)

      await store.close()
      await opts.cleanup?.()
    })

    it("starts a new deployment with steps: null, and round-trips the phase list", async () => {
      const store = await fresh()
      const project = await store.createProject({ slug: "steps", name: "Steps" })
      const created = await store.createDeployment({ projectId: project.id })
      // `null`, not `[]`. An upload never runs phases and a build has not run
      // one yet; both are "nothing to show" rather than "an empty build".
      expect(created.steps).toBeNull()

      const running = [
        { name: "Clone" as const, status: "succeeded" as const, startedAt: "2026-08-22T10:00:00.000Z", endedAt: "2026-08-22T10:00:04.000Z" },
        { name: "Install" as const, status: "running" as const, startedAt: "2026-08-22T10:00:04.000Z" },
      ]
      const mid = await store.updateDeployment(created.id, { steps: running })
      expect(mid.steps).toEqual(running)
      expect(await store.getDeployment(created.id)).toEqual(mid)

      // The runner REPLACES the list at each boundary rather than appending,
      // so a later write must not merge with the earlier one.
      const finished = [
        { name: "Clone" as const, status: "succeeded" as const, startedAt: "2026-08-22T10:00:00.000Z", endedAt: "2026-08-22T10:00:04.000Z" },
        { name: "Install" as const, status: "failed" as const, startedAt: "2026-08-22T10:00:04.000Z", endedAt: "2026-08-22T10:00:09.000Z" },
      ]
      const after = await store.updateDeployment(created.id, { steps: finished })
      expect(after.steps).toEqual(finished)
      expect(after.steps).toHaveLength(2)

      // Clearing back to null is a real state, same as `warnings` above.
      const cleared = await store.updateDeployment(created.id, { steps: null })
      expect(cleared.steps).toBeNull()
      expect(await store.getDeployment(created.id)).toEqual(cleared)

      await store.close()
      await opts.cleanup?.()
    })

    it("points a project at its active deployment", async () => {
      const store = await fresh()
      const project = await store.createProject({ slug: "a", name: "A" })
      const deployment = await store.createDeployment({ projectId: project.id })

      const updated = await store.updateProject(project.id, {
        activeDeploymentId: deployment.id,
      })

      expect(updated.activeDeploymentId).toBe(deployment.id)
      await store.close()
      await opts.cleanup?.()
    })

    // See StorageAdapter.listProjects contract: ordering by createdAt requires
    // a deterministic secondary key (creation order) to handle ties within milliseconds.
    it("lists projects oldest-first by createdAt, in creation order", async () => {
      const store = await fresh()
      const a = await store.createProject({ slug: "a", name: "A" })
      const b = await store.createProject({ slug: "b", name: "B" })
      const c = await store.createProject({ slug: "c", name: "C" })

      const listed = await store.listProjects()
      expect(listed.map((p) => p.id)).toEqual([a.id, b.id, c.id])
      for (let i = 1; i < listed.length; i++) {
        expect(listed[i].createdAt >= listed[i - 1].createdAt).toBe(true)
      }

      await store.close()
      await opts.cleanup?.()
    })

    it("cascades deleteProject to that project's deployments, leaving another project's alone", async () => {
      const store = await fresh()
      const a = await store.createProject({ slug: "a", name: "A" })
      const b = await store.createProject({ slug: "b", name: "B" })
      const deploymentA = await store.createDeployment({ projectId: a.id })
      const deploymentB = await store.createDeployment({ projectId: b.id })

      await store.deleteProject(a.id)

      expect(await store.getDeployment(deploymentA.id)).toBeNull()
      expect(await store.listDeployments(a.id)).toEqual([])
      expect(await store.getDeployment(deploymentB.id)).toEqual(deploymentB)
      expect(await store.listDeployments(b.id)).toEqual([deploymentB])

      await store.close()
      await opts.cleanup?.()
    })

    it("is safe to call close() twice", async () => {
      const store = await fresh()
      // The contract (`StorageAdapter.close` doc comment) explicitly
      // promises "safe to call twice" — assert both calls actually resolve
      // (rather than reject) so an impl that throws/rejects on the second
      // `close()` (e.g. an unguarded `this.db.close()` on an
      // already-closed better-sqlite3 handle) fails this test instead of
      // silently passing on an unobserved rejection.
      await expect(store.close()).resolves.toBeUndefined()
      await expect(store.close()).resolves.toBeUndefined()
      await opts.cleanup?.()
    })

    it("does not let an explicit `undefined` in an update patch overwrite an existing field", async () => {
      const store = await fresh()
      const project = await store.createProject({
        slug: "acme",
        name: "Acme",
        repoUrl: "https://github.com/acme/proto",
      })

      const updatedProject = await store.updateProject(project.id, { name: undefined })
      expect(updatedProject.name).toBe("Acme")
      expect(updatedProject.repoUrl).toBe("https://github.com/acme/proto")
      expect(await store.getProject(project.id)).toEqual(updatedProject)

      const deployment = await store.createDeployment({ projectId: project.id })
      const withLog = await store.updateDeployment(deployment.id, { buildLog: "step 1\n" })
      const updatedDeployment = await store.updateDeployment(deployment.id, {
        buildLog: undefined,
      })
      expect(updatedDeployment.buildLog).toBe(withLog.buildLog)
      expect(updatedDeployment.status).toBe(withLog.status)

      await store.close()
      await opts.cleanup?.()
    })

    describe("project repo config", () => {
      function makeConfig(overrides: Partial<ProjectRepoConfig> = {}): ProjectRepoConfig {
        return {
          installationId: 12345,
          owner: "acme",
          name: "proto",
          defaultBranch: "main",
          branch: "main",
          installCommand: "npm ci",
          buildCommand: "npm run build",
          outputDir: "dist",
          autoDeploy: false,
          ...overrides,
        }
      }

      it("is null on a freshly created project", async () => {
        const store = await fresh()
        const project = await store.createProject({ slug: "acme", name: "Acme" })
        expect(project.repoConfig).toBeNull()
        expect(await store.getProject(project.id)).toEqual(project)
        await store.close()
        await opts.cleanup?.()
      })

      it("sets a repo config and reads it back via getProject/getProjectBySlug/listProjects", async () => {
        const store = await fresh()
        const project = await store.createProject({ slug: "acme", name: "Acme" })
        const config = makeConfig()

        const updated = await store.setProjectRepoConfig(project.id, config)
        expect(updated.repoConfig).toEqual(config)
        expect(updated.id).toBe(project.id)

        expect(await store.getProject(project.id)).toEqual(updated)
        expect(await store.getProjectBySlug("acme")).toEqual(updated)
        expect(await store.listProjects()).toEqual([updated])

        await store.close()
        await opts.cleanup?.()
      })

      it("replaces an existing repo config wholesale on a second set (no merge)", async () => {
        const store = await fresh()
        const project = await store.createProject({ slug: "acme", name: "Acme" })
        await store.setProjectRepoConfig(project.id, makeConfig({ branch: "main" }))

        const replacement = makeConfig({ branch: "dev", autoDeploy: true, installationId: 999 })
        const replaced = await store.setProjectRepoConfig(project.id, replacement)

        expect(replaced.repoConfig).toEqual(replacement)
        expect(await store.getProject(project.id)).toEqual(replaced)

        await store.close()
        await opts.cleanup?.()
      })

      it("clears a repo config back to null", async () => {
        const store = await fresh()
        const project = await store.createProject({ slug: "acme", name: "Acme" })
        await store.setProjectRepoConfig(project.id, makeConfig())

        const cleared = await store.clearProjectRepoConfig(project.id)
        expect(cleared.repoConfig).toBeNull()
        expect(await store.getProject(project.id)).toEqual(cleared)

        await store.close()
        await opts.cleanup?.()
      })

      it("clearProjectRepoConfig on an already-clear project is a no-op, not a throw", async () => {
        const store = await fresh()
        const project = await store.createProject({ slug: "acme", name: "Acme" })

        const cleared = await store.clearProjectRepoConfig(project.id)
        expect(cleared.repoConfig).toBeNull()

        await store.close()
        await opts.cleanup?.()
      })

      it("setProjectRepoConfig throws NotFoundError for a missing project", async () => {
        const store = await fresh()
        await expect(store.setProjectRepoConfig("nope", makeConfig())).rejects.toThrow(/not found/i)
        await store.close()
        await opts.cleanup?.()
      })

      it("clearProjectRepoConfig throws NotFoundError for a missing project", async () => {
        const store = await fresh()
        await expect(store.clearProjectRepoConfig("nope")).rejects.toThrow(/not found/i)
        await store.close()
        await opts.cleanup?.()
      })

      it("does not touch repoUrl, access, or other project fields", async () => {
        const store = await fresh()
        const project = await store.createProject({
          slug: "acme",
          name: "Acme",
          repoUrl: "https://github.com/acme/proto",
          access: "public-link",
        })
        const updated = await store.setProjectRepoConfig(project.id, makeConfig())
        expect(updated.repoUrl).toBe("https://github.com/acme/proto")
        expect(updated.access).toBe("public-link")
        expect(updated.name).toBe("Acme")
        await store.close()
        await opts.cleanup?.()
      })

      it("scopes repo config to its own project — clearing one leaves another's alone", async () => {
        const store = await fresh()
        const a = await store.createProject({ slug: "a", name: "A" })
        const b = await store.createProject({ slug: "b", name: "B" })
        await store.setProjectRepoConfig(a.id, makeConfig({ name: "repo-a" }))
        await store.setProjectRepoConfig(b.id, makeConfig({ name: "repo-b" }))

        await store.clearProjectRepoConfig(a.id)

        expect((await store.getProject(a.id))?.repoConfig).toBeNull()
        expect((await store.getProject(b.id))?.repoConfig?.name).toBe("repo-b")

        await store.close()
        await opts.cleanup?.()
      })

      it("deleteProject leaves no project to look up, even after a repo config was set", async () => {
        const store = await fresh()
        const project = await store.createProject({ slug: "acme", name: "Acme" })
        await store.setProjectRepoConfig(project.id, makeConfig())

        await store.deleteProject(project.id)
        expect(await store.getProject(project.id)).toBeNull()

        await store.close()
        await opts.cleanup?.()
      })

      it("returned repo configs are detached copies", async () => {
        const store = await fresh()
        const project = await store.createProject({ slug: "acme", name: "Acme" })
        const config = makeConfig()
        const updated = await store.setProjectRepoConfig(project.id, config)

        // Mutate the returned object; must not affect what's stored.
        if (updated.repoConfig) updated.repoConfig.branch = "mutated"

        expect((await store.getProject(project.id))?.repoConfig?.branch).toBe(config.branch)

        await store.close()
        await opts.cleanup?.()
      })
    })

    describe("comments", () => {
      const author = { uid: "viewer:mo", displayName: "Mo", email: "mo@example.com", photoURL: "" }
      const position = { anchorSelector: "#hero > button", page: "/", anchorX: 10, anchorY: 20 }

      it("creates comments with sequential per-project numbers and lists oldest-first", async () => {
        const store = await fresh()
        const a = await store.createProject({ slug: "c1", name: "c1", repoUrl: null })
        const b = await store.createProject({ slug: "c2", name: "c2", repoUrl: null })
        const first = await store.createComment(a.id, { position, body: "first", author })
        const second = await store.createComment(a.id, { position, body: "second", author })
        const other = await store.createComment(b.id, { position, body: "other project", author })
        expect(first.number).toBe(1)
        expect(second.number).toBe(2)
        expect(other.number).toBe(1) // numbering is per-project
        expect(first.resolved).toBe(false)
        expect(first.replies).toEqual([])
        expect(first.participantEmails).toEqual(["mo@example.com"])
        const listed = await store.listComments(a.id)
        expect(listed.map((c) => c.body)).toEqual(["first", "second"])
        await store.close()
        await opts.cleanup?.()
      })

      it("updates body/resolved/mentions and rejects a missing id", async () => {
        const store = await fresh()
        const p = await store.createProject({ slug: "c3", name: "c3", repoUrl: null })
        const c = await store.createComment(p.id, { position, body: "orig", author })
        const updated = await store.updateComment(c.id, { resolved: true, body: "edited" })
        expect(updated.resolved).toBe(true)
        expect(updated.body).toBe("edited")
        expect(updated.number).toBe(c.number) // untouched fields preserved
        await expect(store.updateComment("nope", { resolved: true })).rejects.toThrow(/not found/i)
        await store.close()
        await opts.cleanup?.()
      })

      it("accumulates replies and participantEmails", async () => {
        const store = await fresh()
        const p = await store.createProject({ slug: "c4", name: "c4", repoUrl: null })
        const c = await store.createComment(p.id, { position, body: "root", author })
        const replier = { uid: "viewer:sam", displayName: "Sam", email: "sam@example.com", photoURL: "" }
        const after = await store.addCommentReply(c.id, { body: "a reply", author: replier })
        expect(after.replies).toHaveLength(1)
        expect(after.replies[0].body).toBe("a reply")
        expect(after.participantEmails).toEqual(["mo@example.com", "sam@example.com"])
        await expect(store.addCommentReply("nope", { body: "x", author: replier })).rejects.toThrow(/not found/i)
        await store.close()
        await opts.cleanup?.()
      })

      it("deletes a comment and cascades comments on project delete", async () => {
        const store = await fresh()
        const p = await store.createProject({ slug: "c5", name: "c5", repoUrl: null })
        const keep = await store.createProject({ slug: "c6", name: "c6", repoUrl: null })
        const c = await store.createComment(p.id, { position, body: "bye", author })
        const kept = await store.createComment(keep.id, { position, body: "stays", author })
        await store.deleteComment(c.id)
        expect(await store.getComment(c.id)).toBeNull()
        await expect(store.deleteComment(c.id)).rejects.toThrow(/not found/i)
        await store.deleteProject(p.id)
        expect(await store.listComments(p.id)).toEqual([])
        expect(await store.getComment(kept.id)).not.toBeNull()
        await store.close()
        await opts.cleanup?.()
      })

      it("returned comments are detached copies — external mutation never corrupts stored state", async () => {
        const store = await fresh()
        const p = await store.createProject({ slug: "c7", name: "c7", repoUrl: null })
        const created = await store.createComment(p.id, { position, body: "immutable", author })
        created.mentions.push("evil@x.com")
        created.position.anchorSelector = "#hacked"
        created.author.displayName = "Hacked"
        const readBack = (await store.getComment(created.id))!
        expect(readBack.mentions).toEqual([])
        expect(readBack.position.anchorSelector).toBe("#hero > button")
        expect(readBack.author.displayName).toBe("Mo")
        readBack.participantEmails.push("evil2@x.com")
        const again = (await store.getComment(created.id))!
        expect(again.participantEmails).toEqual(["mo@example.com"])
        await store.close()
        await opts.cleanup?.()
      })
    })

    describe("participants", () => {
      it("upserts active + pending participants, deduped by email, listed oldest-first", async () => {
        const store = await fresh()
        const p = await store.createProject({ slug: "pd1", name: "pd1", repoUrl: null })
        const a = await store.upsertParticipant(p.id, { email: "mo@example.com", displayName: "Mo", status: "active" })
        const b = await store.upsertParticipant(p.id, { email: "sam@example.com", displayName: "Sam", status: "pending" })
        expect(a.status).toBe("active")
        expect(b.status).toBe("pending")
        const listed = await store.listParticipants(p.id)
        expect(listed.map((x) => x.email)).toEqual(["mo@example.com", "sam@example.com"])
        await store.close()
        await opts.cleanup?.()
      })

      it("dedupes by lowercased email, updates displayName, promotes pending→active but never demotes", async () => {
        const store = await fresh()
        const p = await store.createProject({ slug: "pd2", name: "pd2", repoUrl: null })
        const first = await store.upsertParticipant(p.id, { email: "Sam@Example.com", displayName: "Sam", status: "pending" })
        const promoted = await store.upsertParticipant(p.id, { email: "sam@example.com", displayName: "Samuel", status: "active" })
        expect(promoted.id).toBe(first.id) // same row
        expect(promoted.status).toBe("active")
        expect(promoted.displayName).toBe("Samuel")
        const demoteAttempt = await store.upsertParticipant(p.id, { email: "sam@example.com", displayName: "Samuel", status: "pending" })
        expect(demoteAttempt.status).toBe("active") // never demoted
        expect(await store.listParticipants(p.id)).toHaveLength(1)
        await store.close()
        await opts.cleanup?.()
      })

      it("scopes participants per project and cascades on project delete", async () => {
        const store = await fresh()
        const p = await store.createProject({ slug: "pd3", name: "pd3", repoUrl: null })
        const keep = await store.createProject({ slug: "pd4", name: "pd4", repoUrl: null })
        const mine = await store.upsertParticipant(p.id, { email: "x@x.com", displayName: "X", status: "active" })
        await store.upsertParticipant(keep.id, { email: "y@y.com", displayName: "Y", status: "active" })
        expect(await store.getParticipant(mine.id)).not.toBeNull()
        await store.deleteProject(p.id)
        expect(await store.listParticipants(p.id)).toEqual([])
        expect(await store.getParticipant(mine.id)).toBeNull()
        expect(await store.listParticipants(keep.id)).toHaveLength(1)
        await store.close()
        await opts.cleanup?.()
      })

      it("returned participants are detached copies", async () => {
        const store = await fresh()
        const p = await store.createProject({ slug: "pd5", name: "pd5", repoUrl: null })
        const created = await store.upsertParticipant(p.id, { email: "z@z.com", displayName: "Z", status: "active" })
        created.displayName = "HACKED"
        const readBack = await store.getParticipant(created.id)
        expect(readBack?.displayName).toBe("Z")
        await store.close()
        await opts.cleanup?.()
      })
    })

    describe("users and sessions", () => {
      const gh = { provider: "github" as const, providerUserId: "gh-1", email: "Mo@Example.com", displayName: "Mo", avatarUrl: "https://x/y.png", role: "editor" as const }

      it("creates a user, lowercasing the email, and keeps distinct provider identities distinct", async () => {
        const store = await fresh()
        const first = await store.createUser(gh)
        expect(first.id).toBeTruthy()
        expect(first.provider).toBe("github")
        expect(first.providerUserId).toBe("gh-1")
        // Email must be stored lowercased (Phase 3b links users↔participants by email)
        expect(first.email).toBe("mo@example.com")
        // A DIFFERENT provider identity is a different user — that is the
        // identity key this test exists to pin. It needs its own email as of
        // the 2026-08-09 security fix (audit S18), now enforced by a UNIQUE
        // email index: `getUserByEmail` — the membership-invite resolver —
        // otherwise had to guess between two rows sharing an address, and
        // silently picked the oldest, handing a private project to the wrong
        // person. The shared address here was incidental to the assertion, so
        // the intent is unchanged.
        const other = await store.createUser({
          ...gh,
          providerUserId: "gh-2",
          email: "other@example.com",
        })
        expect(other.id).not.toBe(first.id)
        expect(await store.getUser(first.id)).not.toBeNull()
        expect(await store.getUser("nope")).toBeNull()
        await store.close()
        await opts.cleanup?.()
      })

      it("creates, reads and deletes sessions; delete is idempotent", async () => {
        const store = await fresh()
        const user = await store.createUser({ ...gh, providerUserId: "gh-sess" })
        const expiresAt = new Date(Date.UTC(2099, 0, 1)).toISOString()
        const session = await store.createSession({ userId: user.id, expiresAt })
        expect(session.userId).toBe(user.id)
        const read = await store.getSession(session.id)
        expect(read?.id).toBe(session.id)
        await store.deleteSession(session.id)
        expect(await store.getSession(session.id)).toBeNull()
        await store.deleteSession(session.id) // idempotent — must not throw
        expect(await store.getSession("nope")).toBeNull()
        await store.close()
        await opts.cleanup?.()
      })

      it("returns an expired session row (expiry is the caller's policy) and can sweep it", async () => {
        const store = await fresh()
        const user = await store.createUser({ ...gh, providerUserId: "gh-exp" })
        const past = new Date(Date.UTC(2000, 0, 1)).toISOString()
        const now = new Date(Date.UTC(2026, 0, 1)).toISOString()
        const future = new Date(Date.UTC(2099, 0, 1)).toISOString()
        const stale = await store.createSession({ userId: user.id, expiresAt: past })
        const boundary = await store.createSession({ userId: user.id, expiresAt: now }) // expiresAt === now must be swept
        const live = await store.createSession({ userId: user.id, expiresAt: future })
        expect(await store.getSession(stale.id)).not.toBeNull()
        expect(await store.getSession(boundary.id)).not.toBeNull()
        const swept = await store.deleteExpiredSessions(now)
        expect(swept).toBe(2) // both stale (past) and boundary (===now) are swept
        expect(await store.getSession(stale.id)).toBeNull()
        expect(await store.getSession(boundary.id)).toBeNull()
        expect(await store.getSession(live.id)).not.toBeNull()
        await store.close()
        await opts.cleanup?.()
      })

      it("returns detached copies", async () => {
        const store = await fresh()
        const user = await store.createUser({ ...gh, providerUserId: "gh-copy" })
        user.displayName = "HACKED"
        expect((await store.getUser(user.id))?.displayName).not.toBe("HACKED")
        // Sessions must also be detached
        const expiresAt = new Date(Date.UTC(2099, 0, 1)).toISOString()
        const session = await store.createSession({ userId: user.id, expiresAt })
        session.userId = "evil-user-id"
        const readBack = await store.getSession(session.id)
        expect(readBack?.userId).toBe(user.id)
        await store.close()
        await opts.cleanup?.()
      })

      it("getUserByEmail finds a user case-insensitively and returns null for a miss (Phase 3b-1 Task 4 invite flow)", async () => {
        const store = await fresh()
        const user = await store.createUser({ ...gh, providerUserId: "gh-byemail" })
        expect((await store.getUserByEmail("mo@example.com"))?.id).toBe(user.id)
        // Stored lowercased — a mixed-case lookup must still hit.
        expect((await store.getUserByEmail("Mo@Example.COM"))?.id).toBe(user.id)
        expect(await store.getUserByEmail("nobody@example.com")).toBeNull()
        await store.close()
        await opts.cleanup?.()
      })
    })

    /**
     * Instance membership (viewer-membership Task 2). Three properties are
     * being pinned here, and all three are security properties rather than
     * conveniences:
     *
     * - **Email is THE identity.** It is unique across the whole instance, so
     *   an invite, a mention or a sign-in can resolve to exactly one account.
     *   Audit S18 previously had to refuse an ambiguous email at read time
     *   because two rows could hold one address; now the state cannot form.
     * - **A provider identity is an attachment, not the key.** An account can
     *   exist with none (invited by email, never signed in), and gains one
     *   the first time its owner signs in. It may never be silently moved
     *   between accounts — that would hand one person's memberships to
     *   another.
     * - **Role and status are stored, not derived.** Nothing in this task
     *   reads them for authorization yet; they are the substrate the
     *   admission gate is built on, so they must round-trip exactly.
     */
    describe("users: roles and identity", () => {
      const base = {
        provider: "github" as const,
        providerUserId: "gh-role-1",
        email: "Role.One@Example.com",
        displayName: "Role One",
        avatarUrl: "https://x/y.png",
        role: "editor" as const,
      }

      it("creates a user active, with the requested role and a lowercased email", async () => {
        const store = await fresh()
        const admin = await store.createUser({ ...base, role: "admin" })
        expect(admin.role).toBe("admin")
        expect(admin.status).toBe("active")
        expect(admin.email).toBe("role.one@example.com")
        expect(await store.getUser(admin.id)).toEqual(admin)
        await store.close()
        await opts.cleanup?.()
      })

      it("creates an account with NO provider identity (invited by email, never signed in)", async () => {
        const store = await fresh()
        const invited = await store.createUser({
          provider: "email",
          providerUserId: null,
          email: "invited@example.com",
          displayName: "invited@example.com",
          avatarUrl: "",
          role: "viewer",
        })
        expect(invited.provider).toBe("email")
        expect(invited.providerUserId).toBeNull()
        expect((await store.getUserByEmail("invited@example.com"))?.id).toBe(invited.id)

        // Two such accounts must be able to coexist: "no identity" is not a
        // value that can collide. (In SQLite this is what makes the identity
        // index PARTIAL rather than plain-unique — NULL = NULL is unknown,
        // but relying on that quirk is exactly the kind of thing a contract
        // test should pin rather than assume.)
        const second = await store.createUser({
          provider: "email",
          providerUserId: null,
          email: "invited-two@example.com",
          displayName: "invited-two@example.com",
          avatarUrl: "",
          role: "viewer",
        })
        expect(second.id).not.toBe(invited.id)
        await store.close()
        await opts.cleanup?.()
      })

      it("refuses a second account on one email — differing only by case is still the same address", async () => {
        const store = await fresh()
        await store.createUser(base)
        await expect(
          store.createUser({ ...base, providerUserId: "gh-role-2" }),
        ).rejects.toThrow(ConflictError)
        await expect(
          store.createUser({
            ...base,
            providerUserId: "gh-role-3",
            email: "ROLE.ONE@EXAMPLE.COM",
          }),
        ).rejects.toThrow(ConflictError)
        await store.close()
        await opts.cleanup?.()
      })

      it("refuses a second account on one provider identity", async () => {
        const store = await fresh()
        await store.createUser(base)
        await expect(
          store.createUser({ ...base, email: "someone.else@example.com" }),
        ).rejects.toThrow(ConflictError)
        await store.close()
        await opts.cleanup?.()
      })

      it("linkProviderIdentity fills a null identity and is idempotent for the same one", async () => {
        const store = await fresh()
        const invited = await store.createUser({
          provider: "email",
          providerUserId: null,
          email: "linkme@example.com",
          displayName: "linkme@example.com",
          avatarUrl: "",
          role: "editor",
        })

        const linked = await store.linkProviderIdentity(invited.id, "github", "gh-linked")
        expect(linked.id).toBe(invited.id)
        expect(linked.provider).toBe("github")
        expect(linked.providerUserId).toBe("gh-linked")
        expect((await store.getUserByProviderIdentity("github", "gh-linked"))?.id).toBe(invited.id)

        // Signing in twice must not be an error.
        const again = await store.linkProviderIdentity(invited.id, "github", "gh-linked")
        expect(again).toEqual(linked)

        await store.close()
        await opts.cleanup?.()
      })

      it("linkProviderIdentity refuses to overwrite a DIFFERENT identity or to steal one from another account", async () => {
        const store = await fresh()
        const mine = await store.createUser({ ...base, providerUserId: "gh-mine", email: "mine@example.com" })
        const theirs = await store.createUser({ ...base, providerUserId: "gh-theirs", email: "theirs@example.com" })

        // Re-pointing an account at a new identity is not a link, it is an
        // account takeover in slow motion — refuse rather than guess.
        await expect(store.linkProviderIdentity(mine.id, "github", "gh-somebody-new")).rejects.toThrow(
          ConflictError,
        )
        // And an identity another account already holds must never move.
        await expect(store.linkProviderIdentity(mine.id, "github", "gh-theirs")).rejects.toThrow(ConflictError)
        expect((await store.getUserByProviderIdentity("github", "gh-theirs"))?.id).toBe(theirs.id)
        expect((await store.getUser(mine.id))?.providerUserId).toBe("gh-mine")

        await expect(store.linkProviderIdentity("nope", "github", "gh-x")).rejects.toThrow(NotFoundError)

        await store.close()
        await opts.cleanup?.()
      })

      it("linkProviderIdentity is compare-and-set: two concurrent callers linking DIFFERENT identities onto the same identity-less row — exactly one wins", async () => {
        const store = await fresh()
        const invited = await store.createUser({
          provider: "email",
          providerUserId: null,
          email: "racer@example.com",
          displayName: "racer@example.com",
          avatarUrl: "",
          role: "editor",
        })

        const results = await Promise.allSettled([
          store.linkProviderIdentity(invited.id, "github", "gh-race-a"),
          store.linkProviderIdentity(invited.id, "github", "gh-race-b"),
        ])

        const fulfilled = results.filter(
          (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof store.linkProviderIdentity>>> =>
            r.status === "fulfilled",
        )
        const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected")

        // Both calls raced a genuinely null row — a last-writer-wins update
        // would let both resolve, silently discarding whichever identity
        // lost. Exactly one may succeed; the other must be told it lost.
        expect(fulfilled).toHaveLength(1)
        expect(rejected).toHaveLength(1)
        expect(rejected[0].reason).toBeInstanceOf(ConflictError)

        const winnerIdentity = fulfilled[0].value.providerUserId
        expect(["gh-race-a", "gh-race-b"]).toContain(winnerIdentity)

        // The row must hold the winner's identity, not a blend or the loser's.
        const row = await store.getUser(invited.id)
        expect(row?.providerUserId).toBe(winnerIdentity)

        await store.close()
        await opts.cleanup?.()
      })

      it("linkProviderIdentity: two DIFFERENT identity-less rows racing to link the SAME identity — exactly one wins, the other gets ConflictError not a raw error", async () => {
        const store = await fresh()
        const rowA = await store.createUser({
          provider: "email",
          providerUserId: null,
          email: "row-a@example.com",
          displayName: "row-a@example.com",
          avatarUrl: "",
          role: "editor",
        })
        const rowB = await store.createUser({
          provider: "email",
          providerUserId: null,
          email: "row-b@example.com",
          displayName: "row-b@example.com",
          avatarUrl: "",
          role: "editor",
        })

        // Each call's own row-level compare-and-set WHERE clause
        // (`id = <own id> AND provider_user_id IS NULL`) matches — these are
        // two DIFFERENT rows, so neither call can see the other's write via
        // that guard. It is the `users_by_provider` UNIQUE index — keyed on
        // (provider, providerUserId), not on id — that must catch the
        // collision instead.
        const results = await Promise.allSettled([
          store.linkProviderIdentity(rowA.id, "github", "gh-shared"),
          store.linkProviderIdentity(rowB.id, "github", "gh-shared"),
        ])

        const fulfilled = results.filter(
          (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof store.linkProviderIdentity>>> =>
            r.status === "fulfilled",
        )
        const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected")

        expect(fulfilled).toHaveLength(1)
        expect(rejected).toHaveLength(1)
        // The loser must be told it lost with a named ConflictError, not a
        // raw driver error (e.g. a SQLite UNIQUE constraint exception)
        // leaking out of the storage layer uncaught.
        expect(rejected[0].reason).toBeInstanceOf(ConflictError)

        const winnerId = fulfilled[0].value.id
        expect([rowA.id, rowB.id]).toContain(winnerId)
        const loserId = winnerId === rowA.id ? rowB.id : rowA.id

        expect((await store.getUser(winnerId))?.providerUserId).toBe("gh-shared")
        // The loser's row must be untouched — still identity-less, not a
        // half-applied write from the failed UPDATE.
        expect((await store.getUser(loserId))?.providerUserId).toBeNull()
        expect((await store.getUserByProviderIdentity("github", "gh-shared"))?.id).toBe(winnerId)

        await store.close()
        await opts.cleanup?.()
      })

      it("updateUserProfile patches named fields only, lowercases the email, and refuses one another account holds", async () => {
        const store = await fresh()
        const user = await store.createUser({ ...base, providerUserId: "gh-prof", email: "prof@example.com" })
        const other = await store.createUser({
          ...base,
          providerUserId: "gh-prof-other",
          email: "prof-other@example.com",
        })

        const renamed = await store.updateUserProfile(user.id, { displayName: "Renamed" })
        expect(renamed.displayName).toBe("Renamed")
        expect(renamed.email).toBe("prof@example.com") // untouched
        expect(renamed.avatarUrl).toBe(base.avatarUrl) // untouched
        expect(renamed.role).toBe("editor") // a profile patch is not a role change
        expect(renamed.status).toBe("active")

        const moved = await store.updateUserProfile(user.id, { email: "Prof.Moved@Example.com" })
        expect(moved.email).toBe("prof.moved@example.com")
        expect((await store.getUserByEmail("prof.moved@example.com"))?.id).toBe(user.id)

        // Re-writing the account's OWN email is not a conflict.
        await expect(
          store.updateUserProfile(user.id, { email: "prof.moved@example.com" }),
        ).resolves.toBeTruthy()

        await expect(
          store.updateUserProfile(user.id, { email: other.email }),
        ).rejects.toThrow(ConflictError)
        // The refusal must not have half-applied anything.
        expect((await store.getUser(user.id))?.email).toBe("prof.moved@example.com")

        await expect(store.updateUserProfile("nope", { displayName: "x" })).rejects.toThrow(NotFoundError)

        await store.close()
        await opts.cleanup?.()
      })

      it("round-trips role and status, and rejects a missing user", async () => {
        const store = await fresh()
        const user = await store.createUser({ ...base, providerUserId: "gh-rs", email: "rs@example.com" })

        expect((await store.updateUserRole(user.id, "admin")).role).toBe("admin")
        expect((await store.getUser(user.id))?.role).toBe("admin")
        expect((await store.updateUserRole(user.id, "viewer")).role).toBe("viewer")

        expect((await store.setUserStatus(user.id, "removed")).status).toBe("removed")
        expect((await store.getUser(user.id))?.status).toBe("removed")
        // A removed account keeps its role and stays readable by id — removal
        // is a status, not a delete, so everything stamped with this id
        // (comments, memberships) still resolves to a name.
        expect((await store.getUser(user.id))?.role).toBe("viewer")
        expect((await store.setUserStatus(user.id, "active")).status).toBe("active")

        await expect(store.updateUserRole("nope", "admin")).rejects.toThrow(NotFoundError)
        await expect(store.setUserStatus("nope", "removed")).rejects.toThrow(NotFoundError)

        await store.close()
        await opts.cleanup?.()
      })

      it("listUsers is oldest-first with a creation-order tie-break, and includes removed accounts", async () => {
        const store = await fresh()
        expect(await store.listUsers()).toEqual([])

        const first = await store.createUser({ ...base, providerUserId: "gh-l1", email: "l1@example.com" })
        const second = await store.createUser({ ...base, providerUserId: "gh-l2", email: "l2@example.com" })
        const third = await store.createUser({ ...base, providerUserId: "gh-l3", email: "l3@example.com" })
        await store.setUserStatus(second.id, "removed")

        const listed = await store.listUsers()
        expect(listed.map((u) => u.id)).toEqual([first.id, second.id, third.id])
        expect(listed.find((u) => u.id === second.id)?.status).toBe("removed")
        for (let i = 1; i < listed.length; i++) {
          expect(listed[i].createdAt >= listed[i - 1].createdAt).toBe(true)
        }

        // Detached copies, same as every other list on this interface.
        listed[0].displayName = "HACKED"
        expect((await store.getUser(first.id))?.displayName).not.toBe("HACKED")

        await store.close()
        await opts.cleanup?.()
      })

      it("countUsers counts every account, removed ones included — it answers 'is this instance empty'", async () => {
        const store = await fresh()
        expect(await store.countUsers()).toBe(0)

        const only = await store.createUser({ ...base, providerUserId: "gh-c1", email: "c1@example.com" })
        expect(await store.countUsers()).toBe(1)

        // The bootstrap question is "has anyone ever been admitted", not "is
        // anyone currently active". An instance whose only account was
        // removed must NOT read as empty, or the next visitor would be
        // bootstrapped straight to admin.
        await store.setUserStatus(only.id, "removed")
        expect(await store.countUsers()).toBe(1)

        await store.createUser({ ...base, providerUserId: "gh-c2", email: "c2@example.com" })
        expect(await store.countUsers()).toBe(2)

        await store.close()
        await opts.cleanup?.()
      })

      /**
       * Wave 2, codex round 2: `countUsers() === 0` then `createUser` used to
       * be two separate awaits in the gate's bootstrap rung, so two
       * concurrent first sign-ins could both observe zero and both become
       * admin. `createUserIfInstanceEmpty` closes that window by making the
       * check-then-insert one atomic operation at the storage layer.
       */
      it("createUserIfInstanceEmpty creates the account only when the instance is empty", async () => {
        const store = await fresh()
        const created = await store.createUserIfInstanceEmpty({
          ...base,
          providerUserId: "gh-boot-1",
          email: "boot1@example.com",
        })
        expect(created).not.toBeNull()
        expect(created?.role).toBe("editor")
        expect(created?.status).toBe("active")
        expect(await store.countUsers()).toBe(1)

        // A second call, instance no longer empty: refused with null, not a
        // second account.
        const second = await store.createUserIfInstanceEmpty({
          ...base,
          providerUserId: "gh-boot-2",
          email: "boot2@example.com",
        })
        expect(second).toBeNull()
        expect(await store.countUsers()).toBe(1)

        await store.close()
        await opts.cleanup?.()
      })

      it("createUserIfInstanceEmpty admits exactly one of two concurrent callers racing on an empty instance", async () => {
        const store = await fresh()
        expect(await store.countUsers()).toBe(0)

        const [a, b] = await Promise.all([
          store.createUserIfInstanceEmpty({
            ...base,
            providerUserId: "gh-race-a",
            email: "race-a@example.com",
          }),
          store.createUserIfInstanceEmpty({
            ...base,
            providerUserId: "gh-race-b",
            email: "race-b@example.com",
          }),
        ])

        const created = [a, b].filter((u) => u !== null)
        expect(created).toHaveLength(1)
        expect(await store.countUsers()).toBe(1)

        await store.close()
        await opts.cleanup?.()
      })
    })

    /**
     * Phase 3c-1b: the per-user GitHub App installation set. This is
     * authorization input for the connect-repo routes, so the three
     * properties pinned here are security properties, not conveniences:
     * replace-not-merge (a revoked installation must actually disappear),
     * empty ≠ absent (both authorize nothing, but only one means "sign in
     * again"), and detached copies.
     */
    describe("user installations", () => {
      const gh = {
        provider: "github" as const,
        providerUserId: "gh-inst",
        email: "inst@example.com",
        displayName: "Inst",
        avatarUrl: "",
        role: "editor" as const,
      }
      const syncedAt = new Date(Date.UTC(2026, 7, 7)).toISOString()

      /** Small builder to keep the entry literals below readable. */
      const entry = (installationId: number, repoFullNames: string[] | null): UserInstallationEntry => ({
        installationId,
        repoFullNames,
      })

      it("records a set, reads it back, and distinguishes 'never recorded' (null) from 'recorded empty'", async () => {
        const store = await fresh()
        const user = await store.createUser(gh)
        expect(await store.getUserInstallations(user.id)).toBeNull()

        await store.setUserInstallations(
          user.id,
          [entry(7, ["acme/repo-seven"]), entry(42, ["acme/repo-forty-two"])],
          syncedAt,
        )
        const read = await store.getUserInstallations(user.id)
        expect(
          read?.installations.map((i) => i.installationId).slice().sort((a, b) => a - b),
        ).toEqual([7, 42])
        expect(read?.syncedAt).toBe(syncedAt)

        // "I asked GitHub and this user can see none" is a real answer and
        // must not read back as "never asked" — the UI advises differently.
        await store.setUserInstallations(user.id, [], syncedAt)
        expect(await store.getUserInstallations(user.id)).toEqual({ installations: [], syncedAt })

        await store.close()
        await opts.cleanup?.()
      })

      it("round-trips repoFullNames: null distinctly from '[]' — null must never coerce to 'unrestricted' or to 'recorded empty'", async () => {
        const store = await fresh()
        const user = await store.createUser({ ...gh, providerUserId: "gh-inst-null-repos" })

        // Three installations, three distinct repo-entitlement states:
        // lookup failed (null), lookup succeeded but found nothing ([]),
        // lookup succeeded with repos.
        await store.setUserInstallations(
          user.id,
          [entry(1, null), entry(2, []), entry(3, ["acme/visible-repo"])],
          syncedAt,
        )
        const read = await store.getUserInstallations(user.id)
        const byId = new Map(read?.installations.map((i) => [i.installationId, i.repoFullNames]))
        expect(byId.get(1)).toBeNull()
        expect(byId.get(2)).toEqual([])
        expect(byId.get(3)).toEqual(["acme/visible-repo"])

        await store.close()
        await opts.cleanup?.()
      })

      it("REPLACES rather than merges — an installation the user lost access to disappears", async () => {
        const store = await fresh()
        const user = await store.createUser({ ...gh, providerUserId: "gh-inst-replace" })
        await store.setUserInstallations(
          user.id,
          [entry(1, ["acme/one"]), entry(2, ["acme/two"]), entry(3, ["acme/three"])],
          syncedAt,
        )
        const later = new Date(Date.UTC(2026, 7, 8)).toISOString()
        await store.setUserInstallations(user.id, [entry(2, ["acme/two"])], later)
        const read = await store.getUserInstallations(user.id)
        expect(read?.installations.map((i) => i.installationId)).toEqual([2])
        expect(read?.syncedAt).toBe(later)
        await store.close()
        await opts.cleanup?.()
      })

      it("keeps users' sets independent, de-duplicates ids, and throws NotFoundError for an unknown user", async () => {
        const store = await fresh()
        const a = await store.createUser({ ...gh, providerUserId: "gh-inst-a" })
        const b = await store.createUser({ ...gh, providerUserId: "gh-inst-b", email: "b@example.com" })
        await store.setUserInstallations(
          a.id,
          [entry(10, ["acme/ten-v1"]), entry(10, ["acme/ten-v2"]), entry(11, ["acme/eleven"])],
          syncedAt,
        )
        await store.setUserInstallations(b.id, [entry(20, ["acme/twenty"])], syncedAt)
        expect(
          (await store.getUserInstallations(a.id))?.installations
            .map((i) => i.installationId)
            .slice()
            .sort((x, y) => x - y),
        ).toEqual([10, 11])
        expect((await store.getUserInstallations(b.id))?.installations.map((i) => i.installationId)).toEqual([20])
        await expect(store.setUserInstallations("nope", [entry(1, ["acme/one"])], syncedAt)).rejects.toThrow(
          NotFoundError,
        )
        await store.close()
        await opts.cleanup?.()
      })

      it("returns detached copies", async () => {
        const store = await fresh()
        const user = await store.createUser({ ...gh, providerUserId: "gh-inst-copy" })
        await store.setUserInstallations(user.id, [entry(5, ["acme/five"])], syncedAt)
        const read = await store.getUserInstallations(user.id)
        read?.installations.push(entry(999, ["acme/nine-nine-nine"]))
        read?.installations[0]?.repoFullNames?.push("acme/mutated-in")
        const reread = await store.getUserInstallations(user.id)
        expect(reread?.installations.map((i) => i.installationId)).toEqual([5])
        expect(reread?.installations[0]?.repoFullNames).toEqual(["acme/five"])
        await store.close()
        await opts.cleanup?.()
      })
    })

    describe("notification outbox", () => {
      let slugCounter = 0

      it("enqueues pending, lists oldest-first, and claims exactly once", async () => {
        const store = await fresh()
        const p = await store.createProject({ slug: `n${++slugCounter}`, name: "n", repoUrl: null })
        const a = await store.enqueueNotification({ projectId: p.id, commentId: "c1", recipientIds: ["r1", "r2"] })
        const b = await store.enqueueNotification({ projectId: p.id, commentId: "c2", replyId: "rep1", recipientIds: ["r3"] })
        expect(a.status).toBe("pending")
        expect(a.replyId).toBeNull()
        expect(b.replyId).toBe("rep1")
        const pending = await store.listPendingNotifications(10)
        expect(pending.map((n) => n.commentId)).toEqual(["c1", "c2"])
        expect(await store.claimNotification(a.id)).toBe(true)
        expect(await store.claimNotification(a.id)).toBe(false) // already claimed — never twice
        expect((await store.listPendingNotifications(10)).map((n) => n.commentId)).toEqual(["c2"]) // a no longer pending
        await store.close()
        await opts.cleanup?.()
      })

      it("sets terminal status and rejects a missing id", async () => {
        const store = await fresh()
        const p = await store.createProject({ slug: `n${++slugCounter}`, name: "n", repoUrl: null })
        const n = await store.enqueueNotification({ projectId: p.id, commentId: "c", recipientIds: ["r"] })
        await store.claimNotification(n.id)
        await store.setNotificationStatus(n.id, "sent")
        expect((await store.getNotification(n.id))?.status).toBe("sent")
        await expect(store.setNotificationStatus("nope", "error")).rejects.toThrow(/not found/i)
        await store.close()
        await opts.cleanup?.()
      })

      it("records optouts (per-project and global) and reports them", async () => {
        const store = await fresh()
        const p = await store.createProject({ slug: `n${++slugCounter}`, name: "n", repoUrl: null })
        const q = await store.createProject({ slug: `n${++slugCounter}`, name: "n", repoUrl: null })
        await store.recordOptout({ participantId: "pa", projectId: p.id })
        await store.recordOptout({ participantId: "pa", projectId: p.id }) // idempotent
        expect(await store.isOptedOut("pa", p.id)).toBe(true)
        expect(await store.isOptedOut("pa", q.id)).toBe(false) // scoped to p
        await store.recordOptout({ participantId: "gb", projectId: null }) // global
        expect(await store.isOptedOut("gb", p.id)).toBe(true)
        expect(await store.isOptedOut("gb", q.id)).toBe(true)
        await store.close()
        await opts.cleanup?.()
      })

      it("cascades outbox + per-project optouts on project delete, keeps global optouts", async () => {
        const store = await fresh()
        const p = await store.createProject({ slug: `n${++slugCounter}`, name: "n", repoUrl: null })
        await store.enqueueNotification({ projectId: p.id, commentId: "c", recipientIds: ["r"] })
        await store.recordOptout({ participantId: "pp", projectId: p.id })
        await store.recordOptout({ participantId: "gg", projectId: null })
        await store.deleteProject(p.id)
        expect(await store.listPendingNotifications(10)).toEqual([])
        expect(await store.isOptedOut("pp", p.id)).toBe(false) // per-project optout gone with project
        // global optout survives (check against a fresh project)
        const fresh2 = await store.createProject({ slug: `n${++slugCounter}`, name: "n", repoUrl: null })
        expect(await store.isOptedOut("gg", fresh2.id)).toBe(true)
        await store.close()
        await opts.cleanup?.()
      })
    })

    describe("project members", () => {
      it("adds members and lists oldest-first by createdAt with creation-order tie-break", async () => {
        const store = await fresh()
        const p = await store.createProject({ slug: "pm1", name: "pm1", repoUrl: null })
        const u1 = await store.createUser({
          provider: "github",
          providerUserId: "gh-u1",
          email: "u1@example.com",
          displayName: "U1",
          avatarUrl: "https://x/y.png",
          role: "editor",
        })
        const u2 = await store.createUser({
          provider: "github",
          providerUserId: "gh-u2",
          email: "u2@example.com",
          displayName: "U2",
          avatarUrl: "https://x/y.png",
          role: "editor",
        })
        const u3 = await store.createUser({
          provider: "github",
          providerUserId: "gh-u3",
          email: "u3@example.com",
          displayName: "U3",
          avatarUrl: "https://x/y.png",
          role: "editor",
        })
        const u4 = await store.createUser({
          provider: "github",
          providerUserId: "gh-u4",
          email: "u4@example.com",
          displayName: "U4",
          avatarUrl: "https://x/y.png",
          role: "editor",
        })

        const m1 = await store.addProjectMember({ projectId: p.id, userId: u1.id })
        const _m2 = await store.addProjectMember({ projectId: p.id, userId: u2.id })
        const _m3 = await store.addProjectMember({ projectId: p.id, userId: u3.id })
        const _m4 = await store.addProjectMember({ projectId: p.id, userId: u4.id })

        expect(m1.projectId).toBe(p.id)
        expect(m1.userId).toBe(u1.id)

        // Verify 4-member list is in creation order
        const listed = await store.listProjectMembers(p.id)
        expect(listed).toHaveLength(4)
        expect(listed.map((m) => m.userId)).toEqual([u1.id, u2.id, u3.id, u4.id])
        // Verify createdAt is monotonically non-decreasing (oldest first)
        for (let i = 1; i < listed.length; i++) {
          expect(listed[i].createdAt >= listed[i - 1].createdAt).toBe(true)
        }

        await store.close()
        await opts.cleanup?.()
      })

      it("breaks ties by creation order when multiple members share createdAt", async () => {
        const store = await fresh()
        const p = await store.createProject({ slug: "pm1-tie", name: "pm1-tie", repoUrl: null })
        const u1 = await store.createUser({
          provider: "github",
          providerUserId: "gh-u1-tie",
          email: "u1tie@example.com",
          displayName: "U1Tie",
          avatarUrl: "https://x/y.png",
          role: "editor",
        })
        const u2 = await store.createUser({
          provider: "github",
          providerUserId: "gh-u2-tie",
          email: "u2tie@example.com",
          displayName: "U2Tie",
          avatarUrl: "https://x/y.png",
          role: "editor",
        })
        const u3 = await store.createUser({
          provider: "github",
          providerUserId: "gh-u3-tie",
          email: "u3tie@example.com",
          displayName: "U3Tie",
          avatarUrl: "https://x/y.png",
          role: "editor",
        })

        // Add three members in quick succession. SQLite's rowid provides
        // the tie-break determinism; in-memory synthetic clock advances
        // per call so natural ties are difficult to force at the JavaScript level.
        // This test verifies the contract: creation order is deterministic.
        const _m1 = await store.addProjectMember({ projectId: p.id, userId: u1.id })
        const _m2 = await store.addProjectMember({ projectId: p.id, userId: u2.id })
        const _m3 = await store.addProjectMember({ projectId: p.id, userId: u3.id })

        const listed = await store.listProjectMembers(p.id)
        // Contract: if createdAt happens to match (or if impls make times identical),
        // creation order must still be respected. This is verified by SQLite's rowid
        // and in-memory's push order into the array.
        expect(listed.map((m) => m.userId)).toEqual([u1.id, u2.id, u3.id])

        await store.close()
        await opts.cleanup?.()
      })

      it("getProjectMember returns a member or null", async () => {
        const store = await fresh()
        const p = await store.createProject({ slug: "pm2", name: "pm2", repoUrl: null })
        const u = await store.createUser({
          provider: "github",
          providerUserId: "gh-pm2",
          email: "pm2@example.com",
          displayName: "PM2",
          avatarUrl: "https://x/y.png",
          role: "editor",
        })

        const added = await store.addProjectMember({ projectId: p.id, userId: u.id })
        const fetched = await store.getProjectMember(p.id, u.id)
        expect(fetched).toEqual(added)

        const notFound = await store.getProjectMember(p.id, "unknown-user")
        expect(notFound).toBeNull()

        await store.close()
        await opts.cleanup?.()
      })

      it("idempotent re-add of an existing member returns the same row unchanged, never a duplicate", async () => {
        const store = await fresh()
        const p = await store.createProject({ slug: "pm3", name: "pm3", repoUrl: null })
        const u = await store.createUser({
          provider: "github",
          providerUserId: "gh-pm3",
          email: "pm3@example.com",
          displayName: "PM3",
          avatarUrl: "https://x/y.png",
          role: "editor",
        })

        const first = await store.addProjectMember({ projectId: p.id, userId: u.id })
        expect(first.projectId).toBe(p.id)
        expect(first.userId).toBe(u.id)

        // Re-adding the same (projectId, userId) pair is a no-op: same
        // createdAt, no new row.
        const again = await store.addProjectMember({ projectId: p.id, userId: u.id })
        expect(again).toEqual(first)

        const listed = await store.listProjectMembers(p.id)
        expect(listed).toHaveLength(1) // only one member, not a duplicate

        await store.close()
        await opts.cleanup?.()
      })

      it("removeProjectMember is idempotent (no throw on missing)", async () => {
        const store = await fresh()
        const p = await store.createProject({ slug: "pm4", name: "pm4", repoUrl: null })
        const u = await store.createUser({
          provider: "github",
          providerUserId: "gh-pm4",
          email: "pm4@example.com",
          displayName: "PM4",
          avatarUrl: "https://x/y.png",
          role: "editor",
        })

        await store.addProjectMember({ projectId: p.id, userId: u.id })
        await store.removeProjectMember(p.id, u.id)
        expect(await store.getProjectMember(p.id, u.id)).toBeNull()

        // Second remove should not throw
        await store.removeProjectMember(p.id, u.id)
        expect(await store.listProjectMembers(p.id)).toEqual([])

        await store.close()
        await opts.cleanup?.()
      })

      it("listProjectsForUser returns only that user's projects", async () => {
        const store = await fresh()
        const p1 = await store.createProject({ slug: "pm5a", name: "pm5a", repoUrl: null })
        const p2 = await store.createProject({ slug: "pm5b", name: "pm5b", repoUrl: null })
        const p3 = await store.createProject({ slug: "pm5c", name: "pm5c", repoUrl: null })
        const u1 = await store.createUser({
          provider: "github",
          providerUserId: "gh-u1-pm5",
          email: "u1pm5@example.com",
          displayName: "U1PM5",
          avatarUrl: "https://x/y.png",
          role: "editor",
        })
        const u2 = await store.createUser({
          provider: "github",
          providerUserId: "gh-u2-pm5",
          email: "u2pm5@example.com",
          displayName: "U2PM5",
          avatarUrl: "https://x/y.png",
          role: "editor",
        })

        await store.addProjectMember({ projectId: p1.id, userId: u1.id })
        await store.addProjectMember({ projectId: p2.id, userId: u1.id })
        await store.addProjectMember({ projectId: p3.id, userId: u2.id })

        const u1Projects = await store.listProjectsForUser(u1.id)
        expect(u1Projects.sort()).toEqual([p1.id, p2.id].sort())

        const u2Projects = await store.listProjectsForUser(u2.id)
        expect(u2Projects).toEqual([p3.id])

        const u3Projects = await store.listProjectsForUser("unknown-user")
        expect(u3Projects).toEqual([])

        await store.close()
        await opts.cleanup?.()
      })

      it("cascades members on project delete", async () => {
        const store = await fresh()
        const p = await store.createProject({ slug: "pm6a", name: "pm6a", repoUrl: null })
        const keep = await store.createProject({ slug: "pm6b", name: "pm6b", repoUrl: null })
        const u = await store.createUser({
          provider: "github",
          providerUserId: "gh-pm6",
          email: "pm6@example.com",
          displayName: "PM6",
          avatarUrl: "https://x/y.png",
          role: "editor",
        })

        await store.addProjectMember({ projectId: p.id, userId: u.id })
        await store.addProjectMember({ projectId: keep.id, userId: u.id })

        await store.deleteProject(p.id)

        expect(await store.listProjectMembers(p.id)).toEqual([])
        expect(await store.listProjectMembers(keep.id)).toHaveLength(1)
        expect(await store.listProjectsForUser(u.id)).toEqual([keep.id])

        await store.close()
        await opts.cleanup?.()
      })

      it("returned project members are detached copies", async () => {
        const store = await fresh()
        const p = await store.createProject({ slug: "pm7", name: "pm7", repoUrl: null })
        const u = await store.createUser({
          provider: "github",
          providerUserId: "gh-pm7",
          email: "pm7@example.com",
          displayName: "PM7",
          avatarUrl: "https://x/y.png",
          role: "editor",
        })

        const created = await store.addProjectMember({ projectId: p.id, userId: u.id })
        created.projectId = "hacked" // mutate the returned copy
        created.userId = "hacked-user"

        const readBack = await store.getProjectMember(p.id, u.id)
        expect(readBack?.projectId).toBe(p.id) // original unchanged
        expect(readBack?.userId).toBe(u.id) // original unchanged

        await store.close()
        await opts.cleanup?.()
      })
    })

    describe("machine tokens", () => {
      async function makeUser(store: StorageAdapter, providerUserId: string) {
        return store.createUser({
          provider: "github",
          providerUserId,
          email: `${providerUserId}@example.com`,
          displayName: providerUserId,
          avatarUrl: "https://x/y.png",
          role: "editor",
        })
      }

      it("creates a token and reads it back by id", async () => {
        const store = await fresh()
        const u = await makeUser(store, "mt-1")
        const created = await store.createMachineToken({
          id: "0123456789abcdef",
          userId: u.id,
          name: "editor-macbook",
          scopes: ["read"],
          tokenHash: "deadbeef",
        })

        expect(created.id).toBe("0123456789abcdef")
        expect(created.userId).toBe(u.id)
        expect(created.name).toBe("editor-macbook")
        expect(created.scopes).toEqual(["read"])
        expect(created.tokenHash).toBe("deadbeef")
        expect(created.lastUsedAt).toBeNull()
        expect(created.expiresAt).toBeNull()
        expect(Date.parse(created.createdAt)).not.toBeNaN()

        expect(await store.getMachineToken(created.id)).toEqual(created)

        await store.close()
        await opts.cleanup?.()
      })

      it("round-trips two scopes and a set expiresAt", async () => {
        const store = await fresh()
        const u = await makeUser(store, "mt-2")
        const expiresAt = new Date(Date.UTC(2099, 0, 1)).toISOString()
        const created = await store.createMachineToken({
          id: "1111111111111111",
          userId: u.id,
          name: "ci-token",
          scopes: ["read", "write"],
          tokenHash: "abc123",
          expiresAt,
        })

        expect(created.scopes).toEqual(["read", "write"])
        expect(created.expiresAt).toBe(expiresAt)
        expect(await store.getMachineToken(created.id)).toEqual(created)

        await store.close()
        await opts.cleanup?.()
      })

      it("getMachineToken returns null for an unknown id", async () => {
        const store = await fresh()
        expect(await store.getMachineToken("nope")).toBeNull()
        await store.close()
        await opts.cleanup?.()
      })

      it("lists a user's tokens oldest-first, scoped to that user only", async () => {
        const store = await fresh()
        const u1 = await makeUser(store, "mt-list-1")
        const u2 = await makeUser(store, "mt-list-2")

        const a = await store.createMachineToken({
          id: "2000000000000000",
          userId: u1.id,
          name: "a",
          scopes: ["read"],
          tokenHash: "h1",
        })
        const b = await store.createMachineToken({
          id: "2000000000000001",
          userId: u1.id,
          name: "b",
          scopes: ["read"],
          tokenHash: "h2",
        })
        await store.createMachineToken({
          id: "2000000000000002",
          userId: u2.id,
          name: "other-user",
          scopes: ["read"],
          tokenHash: "h3",
        })

        const listed = await store.listMachineTokensForUser(u1.id)
        expect(listed.map((t) => t.id)).toEqual([a.id, b.id])
        for (let i = 1; i < listed.length; i++) {
          expect(listed[i].createdAt >= listed[i - 1].createdAt).toBe(true)
        }

        expect(await store.listMachineTokensForUser("unknown-user")).toEqual([])

        await store.close()
        await opts.cleanup?.()
      })

      it("touchMachineToken updates lastUsedAt and is a no-op on a missing id", async () => {
        const store = await fresh()
        const u = await makeUser(store, "mt-touch")
        const created = await store.createMachineToken({
          id: "3000000000000000",
          userId: u.id,
          name: "t",
          scopes: ["read"],
          tokenHash: "h",
        })
        expect(created.lastUsedAt).toBeNull()

        const usedAt = new Date(Date.UTC(2026, 0, 1)).toISOString()
        await store.touchMachineToken(created.id, usedAt)
        expect((await store.getMachineToken(created.id))?.lastUsedAt).toBe(usedAt)

        // No-op on a missing id — must not throw.
        await store.touchMachineToken("nope", usedAt)

        await store.close()
        await opts.cleanup?.()
      })

      it("deleteMachineToken removes it and is idempotent on a missing id", async () => {
        const store = await fresh()
        const u = await makeUser(store, "mt-delete")
        const created = await store.createMachineToken({
          id: "4000000000000000",
          userId: u.id,
          name: "t",
          scopes: ["read"],
          tokenHash: "h",
        })

        await store.deleteMachineToken(created.id)
        expect(await store.getMachineToken(created.id)).toBeNull()

        // Idempotent — must not throw.
        await store.deleteMachineToken(created.id)
        await store.deleteMachineToken("nope")

        await store.close()
        await opts.cleanup?.()
      })

      it("deleteMachineTokensForUser removes only that user's tokens", async () => {
        const store = await fresh()
        const u1 = await makeUser(store, "mt-bulk-1")
        const u2 = await makeUser(store, "mt-bulk-2")
        const a = await store.createMachineToken({
          id: "5000000000000000",
          userId: u1.id,
          name: "a",
          scopes: ["read"],
          tokenHash: "h1",
        })
        const b = await store.createMachineToken({
          id: "5000000000000001",
          userId: u2.id,
          name: "b",
          scopes: ["read"],
          tokenHash: "h2",
        })

        await store.deleteMachineTokensForUser(u1.id)

        expect(await store.getMachineToken(a.id)).toBeNull()
        expect(await store.getMachineToken(b.id)).not.toBeNull()
        expect(await store.listMachineTokensForUser(u1.id)).toEqual([])

        await store.close()
        await opts.cleanup?.()
      })

      it("returned machine tokens are detached copies", async () => {
        const store = await fresh()
        const u = await makeUser(store, "mt-copy")
        const created = await store.createMachineToken({
          id: "6000000000000000",
          userId: u.id,
          name: "t",
          scopes: ["read"],
          tokenHash: "h",
        })
        created.name = "HACKED"
        created.scopes.push("write")

        const readBack = await store.getMachineToken(created.id)
        expect(readBack?.name).toBe("t")
        expect(readBack?.scopes).toEqual(["read"])

        await store.close()
        await opts.cleanup?.()
      })

      // Fix wave M5: only `createMachineToken`'s return was covered for
      // detachment. `getMachineToken` and `listMachineTokensForUser` are
      // the READ paths — the ones a caller actually holds onto — and
      // `scopes` is the field that matters most: an in-memory impl handing
      // back its own live array would let any consumer that mutates the
      // returned scopes silently escalate the stored token's authority.
      it("getMachineToken returns a detached copy — mutating it never reaches storage", async () => {
        const store = await fresh()
        const u = await makeUser(store, "mt-get-copy")
        const created = await store.createMachineToken({
          id: "7000000000000000",
          userId: u.id,
          name: "t",
          scopes: ["read"],
          tokenHash: "h",
        })

        const first = await store.getMachineToken(created.id)
        expect(first).not.toBeNull()
        first!.name = "HACKED"
        first!.scopes.push("write")
        first!.tokenHash = "tampered"

        const second = await store.getMachineToken(created.id)
        expect(second?.name).toBe("t")
        expect(second?.scopes).toEqual(["read"])
        expect(second?.tokenHash).toBe("h")

        await store.close()
        await opts.cleanup?.()
      })

      it("listMachineTokensForUser returns detached copies — mutating them never reaches storage", async () => {
        const store = await fresh()
        const u = await makeUser(store, "mt-list-copy")
        await store.createMachineToken({
          id: "7000000000000001",
          userId: u.id,
          name: "t",
          scopes: ["read"],
          tokenHash: "h",
        })

        const first = await store.listMachineTokensForUser(u.id)
        expect(first).toHaveLength(1)
        first[0].name = "HACKED"
        first[0].scopes.push("write")
        first.push({ ...first[0], id: "injected" })

        const second = await store.listMachineTokensForUser(u.id)
        expect(second).toHaveLength(1)
        expect(second[0].name).toBe("t")
        expect(second[0].scopes).toEqual(["read"])

        await store.close()
        await opts.cleanup?.()
      })
    })

    describe("instance invites", () => {
      let idCounter = 0
      function inviteId(): string {
        idCounter += 1
        return idCounter.toString(16).padStart(16, "0")
      }
      const farExpiry = new Date(Date.UTC(2099, 0, 1)).toISOString()

      it("creates an invite with defaults, lowercases the email, and reads it back", async () => {
        const store = await fresh()
        const id = inviteId()
        const created = await store.createInstanceInvite({
          id,
          email: "New.Person@Example.com",
          role: "editor",
          tokenHash: "hash-1",
          createdByUserId: null,
          expiresAt: farExpiry,
        })

        expect(created.id).toBe(id)
        expect(created.email).toBe("new.person@example.com")
        expect(created.role).toBe("editor")
        expect(created.tokenHash).toBe("hash-1")
        expect(created.createdByUserId).toBeNull()
        expect(created.expiresAt).toBe(farExpiry)
        expect(created.usedAt).toBeNull()
        expect(created.revokedAt).toBeNull()
        expect(Date.parse(created.createdAt)).not.toBeNaN()

        expect(await store.getInstanceInvite(id)).toEqual(created)

        await store.close()
        await opts.cleanup?.()
      })

      it("records createdByUserId when minted by a signed-in admin", async () => {
        const store = await fresh()
        const admin = await store.createUser({
          provider: "github",
          providerUserId: "gh-invite-admin",
          email: "admin@example.com",
          displayName: "Admin",
          avatarUrl: "https://x/y.png",
          role: "admin",
        })
        const created = await store.createInstanceInvite({
          id: inviteId(),
          email: "by-admin@example.com",
          role: "editor",
          tokenHash: "h",
          createdByUserId: admin.id,
          expiresAt: farExpiry,
        })
        expect(created.createdByUserId).toBe(admin.id)
        await store.close()
        await opts.cleanup?.()
      })

      it("getInstanceInvite returns null for an unknown id", async () => {
        const store = await fresh()
        expect(await store.getInstanceInvite("nope")).toBeNull()
        await store.close()
        await opts.cleanup?.()
      })

      it("lists oldest-first with creation-order tie-break", async () => {
        const store = await fresh()
        const a = await store.createInstanceInvite({
          id: inviteId(),
          email: "a@example.com",
          role: "viewer",
          tokenHash: "h",
          createdByUserId: null,
          expiresAt: farExpiry,
        })
        const b = await store.createInstanceInvite({
          id: inviteId(),
          email: "b@example.com",
          role: "viewer",
          tokenHash: "h",
          createdByUserId: null,
          expiresAt: farExpiry,
        })
        const listed = await store.listInstanceInvites()
        expect(listed.map((i) => i.id)).toEqual([a.id, b.id])
        await store.close()
        await opts.cleanup?.()
      })

      it("claim is exactly-once: two sequential claims are true then false", async () => {
        const store = await fresh()
        const created = await store.createInstanceInvite({
          id: inviteId(),
          email: "claim@example.com",
          role: "viewer",
          tokenHash: "h",
          createdByUserId: null,
          expiresAt: farExpiry,
        })
        const usedAt = new Date().toISOString()
        expect(await store.claimInstanceInvite(created.id, usedAt)).toBe(true)
        expect(await store.claimInstanceInvite(created.id, usedAt)).toBe(false)
        expect((await store.getInstanceInvite(created.id))?.usedAt).toBe(usedAt)
        await store.close()
        await opts.cleanup?.()
      })

      it("claim after revoke returns false", async () => {
        const store = await fresh()
        const created = await store.createInstanceInvite({
          id: inviteId(),
          email: "revoked-claim@example.com",
          role: "viewer",
          tokenHash: "h",
          createdByUserId: null,
          expiresAt: farExpiry,
        })
        await store.revokeInstanceInvite(created.id)
        expect(await store.claimInstanceInvite(created.id, new Date().toISOString())).toBe(false)
        await store.close()
        await opts.cleanup?.()
      })

      it("claim on an unknown id returns false", async () => {
        const store = await fresh()
        expect(await store.claimInstanceInvite("nope", new Date().toISOString())).toBe(false)
        await store.close()
        await opts.cleanup?.()
      })

      it("unclaimInstanceInvite resets usedAt to null, and the invite can be claimed again", async () => {
        const store = await fresh()
        const created = await store.createInstanceInvite({
          id: inviteId(),
          email: "unclaim@example.com",
          role: "viewer",
          tokenHash: "h",
          createdByUserId: null,
          expiresAt: farExpiry,
        })
        expect(await store.claimInstanceInvite(created.id, new Date().toISOString())).toBe(true)

        await store.unclaimInstanceInvite(created.id)
        expect((await store.getInstanceInvite(created.id))?.usedAt).toBeNull()

        // The compensating action's whole point: a rolled-back invite is
        // claimable again, exactly like a fresh one.
        const secondUsedAt = new Date().toISOString()
        expect(await store.claimInstanceInvite(created.id, secondUsedAt)).toBe(true)
        expect((await store.getInstanceInvite(created.id))?.usedAt).toBe(secondUsedAt)

        await store.close()
        await opts.cleanup?.()
      })

      it("unclaimInstanceInvite is idempotent and safe on a missing id", async () => {
        const store = await fresh()
        const created = await store.createInstanceInvite({
          id: inviteId(),
          email: "unclaim-twice@example.com",
          role: "viewer",
          tokenHash: "h",
          createdByUserId: null,
          expiresAt: farExpiry,
        })
        await store.claimInstanceInvite(created.id, new Date().toISOString())

        await store.unclaimInstanceInvite(created.id)
        await store.unclaimInstanceInvite(created.id) // second call — must not throw
        expect((await store.getInstanceInvite(created.id))?.usedAt).toBeNull()

        await expect(store.unclaimInstanceInvite("nope")).resolves.toBeUndefined()

        await store.close()
        await opts.cleanup?.()
      })

      it("resetInstanceInviteToken replaces tokenHash + expiresAt and revives a USED invite", async () => {
        const store = await fresh()
        const created = await store.createInstanceInvite({
          id: inviteId(),
          email: "reset@example.com",
          role: "viewer",
          tokenHash: "old-hash",
          createdByUserId: null,
          expiresAt: farExpiry,
        })
        await store.claimInstanceInvite(created.id, new Date().toISOString())

        const newExpiry = new Date(Date.UTC(2099, 5, 1)).toISOString()
        const reset = await store.resetInstanceInviteToken(created.id, "new-hash", newExpiry)
        expect(reset.tokenHash).toBe("new-hash")
        expect(reset.expiresAt).toBe(newExpiry)
        expect(reset.usedAt).toBeNull()
        expect(reset.revokedAt).toBeNull()

        // Revived: the atomic claim succeeds again.
        expect(await store.claimInstanceInvite(created.id, new Date().toISOString())).toBe(true)

        await store.close()
        await opts.cleanup?.()
      })

      it("resetInstanceInviteToken revives a REVOKED invite", async () => {
        const store = await fresh()
        const created = await store.createInstanceInvite({
          id: inviteId(),
          email: "revive@example.com",
          role: "viewer",
          tokenHash: "old-hash",
          createdByUserId: null,
          expiresAt: farExpiry,
        })
        await store.revokeInstanceInvite(created.id)

        const reset = await store.resetInstanceInviteToken(created.id, "new-hash", farExpiry)
        expect(reset.revokedAt).toBeNull()
        expect(await store.claimInstanceInvite(created.id, new Date().toISOString())).toBe(true)

        await store.close()
        await opts.cleanup?.()
      })

      it("resetInstanceInviteToken throws NotFoundError on a missing invite", async () => {
        const store = await fresh()
        await expect(
          store.resetInstanceInviteToken("nope", "h", farExpiry),
        ).rejects.toThrow(NotFoundError)
        await store.close()
        await opts.cleanup?.()
      })

      it("revokeInstanceInvite is idempotent and safe on a missing id", async () => {
        const store = await fresh()
        const created = await store.createInstanceInvite({
          id: inviteId(),
          email: "double-revoke@example.com",
          role: "viewer",
          tokenHash: "h",
          createdByUserId: null,
          expiresAt: farExpiry,
        })
        await store.revokeInstanceInvite(created.id)
        const first = await store.getInstanceInvite(created.id)
        expect(first?.revokedAt).not.toBeNull()

        await store.revokeInstanceInvite(created.id) // second call — must not throw or move the timestamp
        const second = await store.getInstanceInvite(created.id)
        expect(second?.revokedAt).toBe(first?.revokedAt)

        await expect(store.revokeInstanceInvite("nope")).resolves.toBeUndefined()

        await store.close()
        await opts.cleanup?.()
      })

      it("returns detached copies", async () => {
        const store = await fresh()
        const created = await store.createInstanceInvite({
          id: inviteId(),
          email: "copy@example.com",
          role: "viewer",
          tokenHash: "h",
          createdByUserId: null,
          expiresAt: farExpiry,
        })
        created.tokenHash = "HACKED"
        const readBack = await store.getInstanceInvite(created.id)
        expect(readBack?.tokenHash).toBe("h")
        await store.close()
        await opts.cleanup?.()
      })

      describe("getPendingInstanceInviteByEmail (C3)", () => {
        it("finds a pending invite by email, case-insensitively", async () => {
          const store = await fresh()
          const created = await store.createInstanceInvite({
            id: inviteId(),
            email: "pending@example.com",
            role: "editor",
            tokenHash: "h",
            createdByUserId: null,
            expiresAt: farExpiry,
          })
          expect((await store.getPendingInstanceInviteByEmail("Pending@Example.com"))?.id).toBe(
            created.id,
          )
          await store.close()
          await opts.cleanup?.()
        })

        it("returns null when no invite exists for that email", async () => {
          const store = await fresh()
          expect(await store.getPendingInstanceInviteByEmail("nobody@example.com")).toBeNull()
          await store.close()
          await opts.cleanup?.()
        })

        it("does not return a USED invite", async () => {
          const store = await fresh()
          const created = await store.createInstanceInvite({
            id: inviteId(),
            email: "used@example.com",
            role: "editor",
            tokenHash: "h",
            createdByUserId: null,
            expiresAt: farExpiry,
          })
          await store.claimInstanceInvite(created.id, new Date().toISOString())
          expect(await store.getPendingInstanceInviteByEmail("used@example.com")).toBeNull()
          await store.close()
          await opts.cleanup?.()
        })

        it("does not return a REVOKED invite", async () => {
          const store = await fresh()
          const created = await store.createInstanceInvite({
            id: inviteId(),
            email: "revoked@example.com",
            role: "editor",
            tokenHash: "h",
            createdByUserId: null,
            expiresAt: farExpiry,
          })
          await store.revokeInstanceInvite(created.id)
          expect(await store.getPendingInstanceInviteByEmail("revoked@example.com")).toBeNull()
          await store.close()
          await opts.cleanup?.()
        })

        it("does not return an EXPIRED invite", async () => {
          const store = await fresh()
          await store.createInstanceInvite({
            id: inviteId(),
            email: "expired@example.com",
            role: "editor",
            tokenHash: "h",
            createdByUserId: null,
            expiresAt: new Date(Date.now() - 1000).toISOString(),
          })
          expect(await store.getPendingInstanceInviteByEmail("expired@example.com")).toBeNull()
          await store.close()
          await opts.cleanup?.()
        })
      })

      describe("deleteExpiredInstanceInvites (M2)", () => {
        it("deletes an unused, unrevoked invite at or past its expiry, and leaves a live one", async () => {
          const store = await fresh()
          const now = new Date().toISOString()
          const past = new Date(Date.now() - 60_000).toISOString()

          const dead = await store.createInstanceInvite({
            id: inviteId(),
            email: "dead@example.com",
            role: "editor",
            tokenHash: "h",
            createdByUserId: null,
            expiresAt: past,
          })
          const live = await store.createInstanceInvite({
            id: inviteId(),
            email: "live@example.com",
            role: "editor",
            tokenHash: "h",
            createdByUserId: null,
            expiresAt: farExpiry,
          })

          expect(await store.deleteExpiredInstanceInvites(now)).toBe(1)
          expect(await store.getInstanceInvite(dead.id)).toBeNull()
          expect(await store.getInstanceInvite(live.id)).not.toBeNull()
          await store.close()
          await opts.cleanup?.()
        })

        /**
         * The whole point of M2: a USED invite is the audit trail proving an
         * account was created from it, and a REVOKED one is the audit trail
         * proving an admin pulled it. Neither is deleted just because its
         * expiry has passed — only a row nobody ever acted on is swept.
         */
        it("keeps a USED invite past its expiry — audit trail, not a live credential", async () => {
          const store = await fresh()
          const used = await store.createInstanceInvite({
            id: inviteId(),
            email: "used@example.com",
            role: "editor",
            tokenHash: "h",
            createdByUserId: null,
            expiresAt: new Date(Date.now() - 60_000).toISOString(),
          })
          await store.claimInstanceInvite(used.id, new Date().toISOString())

          expect(await store.deleteExpiredInstanceInvites(new Date().toISOString())).toBe(0)
          expect(await store.getInstanceInvite(used.id)).not.toBeNull()
          await store.close()
          await opts.cleanup?.()
        })

        it("keeps a REVOKED invite past its expiry — audit trail, not a live credential", async () => {
          const store = await fresh()
          const revoked = await store.createInstanceInvite({
            id: inviteId(),
            email: "revoked-expired@example.com",
            role: "editor",
            tokenHash: "h",
            createdByUserId: null,
            expiresAt: new Date(Date.now() - 60_000).toISOString(),
          })
          await store.revokeInstanceInvite(revoked.id)

          expect(await store.deleteExpiredInstanceInvites(new Date().toISOString())).toBe(0)
          expect(await store.getInstanceInvite(revoked.id)).not.toBeNull()
          await store.close()
          await opts.cleanup?.()
        })

        it("is a no-op returning 0 on an empty table", async () => {
          const store = await fresh()
          expect(await store.deleteExpiredInstanceInvites(new Date().toISOString())).toBe(0)
          await store.close()
          await opts.cleanup?.()
        })
      })
    })

    describe("sign-in tokens", () => {
      let idCounter = 0
      function tokenId(): string {
        idCounter += 1
        return `s${idCounter.toString(16).padStart(15, "0")}`
      }
      const farExpiry = new Date(Date.UTC(2099, 0, 1)).toISOString()

      it("creates a user-linked token (magic link / admin-issued) and reads it back", async () => {
        const store = await fresh()
        const user = await store.createUser({
          provider: "github",
          providerUserId: "gh-signin-1",
          email: "signin-1@example.com",
          displayName: "S1",
          avatarUrl: "https://x/y.png",
          role: "editor",
        })
        const created = await store.createSignInToken({
          id: tokenId(),
          userId: user.id,
          email: null,
          tokenHash: "h1",
          expiresAt: farExpiry,
        })

        expect(created.userId).toBe(user.id)
        expect(created.email).toBeNull()
        expect(created.tokenHash).toBe("h1")
        expect(created.usedAt).toBeNull()
        expect(created.expiresAt).toBe(farExpiry)
        expect(Date.parse(created.createdAt)).not.toBeNaN()

        expect(await store.getSignInToken(created.id)).toEqual(created)
        await store.close()
        await opts.cleanup?.()
      })

      it("creates an email-linked token (domain-rule self-serve join) and lowercases the email", async () => {
        const store = await fresh()
        const created = await store.createSignInToken({
          id: tokenId(),
          userId: null,
          email: "Join.Me@Example.com",
          tokenHash: "h2",
          expiresAt: farExpiry,
        })
        expect(created.userId).toBeNull()
        expect(created.email).toBe("join.me@example.com")
        await store.close()
        await opts.cleanup?.()
      })

      it("rejects a token with NEITHER userId nor email", async () => {
        const store = await fresh()
        await expect(
          store.createSignInToken({ id: tokenId(), userId: null, email: null, tokenHash: "h", expiresAt: farExpiry }),
        ).rejects.toThrow()
        await store.close()
        await opts.cleanup?.()
      })

      it("rejects a token with BOTH userId and email", async () => {
        const store = await fresh()
        const user = await store.createUser({
          provider: "github",
          providerUserId: "gh-signin-both",
          email: "both@example.com",
          displayName: "Both",
          avatarUrl: "https://x/y.png",
          role: "editor",
        })
        await expect(
          store.createSignInToken({
            id: tokenId(),
            userId: user.id,
            email: "both@example.com",
            tokenHash: "h",
            expiresAt: farExpiry,
          }),
        ).rejects.toThrow()
        await store.close()
        await opts.cleanup?.()
      })

      it("getSignInToken returns null for an unknown id", async () => {
        const store = await fresh()
        expect(await store.getSignInToken("nope")).toBeNull()
        await store.close()
        await opts.cleanup?.()
      })

      it("claim is exactly-once: two sequential claims are true then false", async () => {
        const store = await fresh()
        const created = await store.createSignInToken({
          id: tokenId(),
          userId: null,
          email: "claim@example.com",
          tokenHash: "h",
          expiresAt: farExpiry,
        })
        const usedAt = new Date().toISOString()
        expect(await store.claimSignInToken(created.id, usedAt)).toBe(true)
        expect(await store.claimSignInToken(created.id, usedAt)).toBe(false)
        expect((await store.getSignInToken(created.id))?.usedAt).toBe(usedAt)
        await store.close()
        await opts.cleanup?.()
      })

      it("claim on an unknown id returns false", async () => {
        const store = await fresh()
        expect(await store.claimSignInToken("nope", new Date().toISOString())).toBe(false)
        await store.close()
        await opts.cleanup?.()
      })

      it("returns detached copies", async () => {
        const store = await fresh()
        const created = await store.createSignInToken({
          id: tokenId(),
          userId: null,
          email: "copy@example.com",
          tokenHash: "h",
          expiresAt: farExpiry,
        })
        created.tokenHash = "HACKED"
        const readBack = await store.getSignInToken(created.id)
        expect(readBack?.tokenHash).toBe("h")
        await store.close()
        await opts.cleanup?.()
      })

      /**
       * `createdAt` must come off the REAL clock in every impl.
       *
       * Pinned in the contract rather than left to each adapter because the
       * in-memory one stamps most `createdAt` fields from a synthetic
       * monotonic counter based at 2020-01-01, and `hasRecentSignInTokenForSubject`
       * compares this field against a `Date.now()`-derived cutoff on behalf
       * of a rate control. Under the synthetic clock that comparison always
       * answers "long ago", so the throttle would never fire against the
       * in-memory adapter while firing correctly against SQLite — a
       * divergence in a security control that every route test would be
       * blind to.
       */
      it("stamps createdAt from the real clock, not a synthetic one", async () => {
        const store = await fresh()
        const before = Date.now()
        const created = await store.createSignInToken({
          id: tokenId(),
          userId: null,
          email: "clock@example.com",
          tokenHash: "h",
          expiresAt: farExpiry,
        })
        const stamped = Date.parse(created.createdAt)
        expect(stamped).toBeGreaterThanOrEqual(before - 1000)
        expect(stamped).toBeLessThanOrEqual(Date.now() + 1000)
        await store.close()
        await opts.cleanup?.()
      })

      describe("deleteExpiredSignInTokens", () => {
        it("deletes rows at or past their expiry and leaves live ones", async () => {
          const store = await fresh()
          const now = new Date().toISOString()
          const past = new Date(Date.now() - 60_000).toISOString()

          const dead = await store.createSignInToken({
            id: tokenId(),
            userId: null,
            email: "dead@example.com",
            tokenHash: "h",
            expiresAt: past,
          })
          const live = await store.createSignInToken({
            id: tokenId(),
            userId: null,
            email: "live@example.com",
            tokenHash: "h",
            expiresAt: farExpiry,
          })

          expect(await store.deleteExpiredSignInTokens(now)).toBe(1)
          expect(await store.getSignInToken(dead.id)).toBeNull()
          expect(await store.getSignInToken(live.id)).not.toBeNull()
          await store.close()
          await opts.cleanup?.()
        })

        /**
         * A CLAIMED token is spent, not deletable on sight — it is removed
         * on the same "expired means gone" rule as any other row, so a
         * claimed-but-unexpired one survives the sweep.
         */
        it("sweeps a claimed token once it expires, and not before", async () => {
          const store = await fresh()
          const claimed = await store.createSignInToken({
            id: tokenId(),
            userId: null,
            email: "claimed@example.com",
            tokenHash: "h",
            expiresAt: farExpiry,
          })
          await store.claimSignInToken(claimed.id, new Date().toISOString())

          expect(await store.deleteExpiredSignInTokens(new Date().toISOString())).toBe(0)
          expect(await store.getSignInToken(claimed.id)).not.toBeNull()

          // Same row, swept once "now" is past its expiry.
          expect(
            await store.deleteExpiredSignInTokens(new Date(Date.UTC(2100, 0, 1)).toISOString()),
          ).toBe(1)
          expect(await store.getSignInToken(claimed.id)).toBeNull()
          await store.close()
          await opts.cleanup?.()
        })

        it("is a no-op returning 0 on an empty table", async () => {
          const store = await fresh()
          expect(await store.deleteExpiredSignInTokens(new Date().toISOString())).toBe(0)
          await store.close()
          await opts.cleanup?.()
        })
      })

      describe("hasRecentSignInTokenForSubject", () => {
        /** `now` and a cutoff `seconds` in the past. */
        function windowOf(seconds: number) {
          return {
            now: new Date().toISOString(),
            createdAfter: new Date(Date.now() - seconds * 1000).toISOString(),
          }
        }

        it("is false when the subject holds nothing at all", async () => {
          const store = await fresh()
          expect(
            await store.hasRecentSignInTokenForSubject(
              { userId: null, email: "nobody@example.com" },
              windowOf(60),
            ),
          ).toBe(false)
          await store.close()
          await opts.cleanup?.()
        })

        it("is true for a fresh unclaimed token, matched by email", async () => {
          const store = await fresh()
          await store.createSignInToken({
            id: tokenId(),
            userId: null,
            email: "recent@example.com",
            tokenHash: "h",
            expiresAt: farExpiry,
          })
          expect(
            await store.hasRecentSignInTokenForSubject(
              { userId: null, email: "recent@example.com" },
              windowOf(60),
            ),
          ).toBe(true)
          await store.close()
          await opts.cleanup?.()
        })

        it("matches the email case-insensitively, as it is stored", async () => {
          const store = await fresh()
          await store.createSignInToken({
            id: tokenId(),
            userId: null,
            email: "Case@Example.com",
            tokenHash: "h",
            expiresAt: farExpiry,
          })
          expect(
            await store.hasRecentSignInTokenForSubject(
              { userId: null, email: "CASE@EXAMPLE.COM" },
              windowOf(60),
            ),
          ).toBe(true)
          await store.close()
          await opts.cleanup?.()
        })

        it("is true for a fresh unclaimed token, matched by userId", async () => {
          const store = await fresh()
          const user = await store.createUser({
            provider: "github",
            providerUserId: "gh-throttle",
            email: "throttle@example.com",
            displayName: "T",
            avatarUrl: "",
            role: "editor",
          })
          await store.createSignInToken({
            id: tokenId(),
            userId: user.id,
            email: null,
            tokenHash: "h",
            expiresAt: farExpiry,
          })
          expect(
            await store.hasRecentSignInTokenForSubject({ userId: user.id, email: null }, windowOf(60)),
          ).toBe(true)
          // …and does not answer for a DIFFERENT subject.
          expect(
            await store.hasRecentSignInTokenForSubject({ userId: "someone-else", email: null }, windowOf(60)),
          ).toBe(false)
          await store.close()
          await opts.cleanup?.()
        })

        it("does not match a subject's token across the userId/email divide", async () => {
          const store = await fresh()
          const user = await store.createUser({
            provider: "github",
            providerUserId: "gh-divide",
            email: "divide@example.com",
            displayName: "D",
            avatarUrl: "",
            role: "editor",
          })
          await store.createSignInToken({
            id: tokenId(),
            userId: user.id,
            email: null,
            tokenHash: "h",
            expiresAt: farExpiry,
          })
          // The user-linked row must not answer an EMAIL-subject question:
          // the two variants mean different things to the gate.
          expect(
            await store.hasRecentSignInTokenForSubject(
              { userId: null, email: "divide@example.com" },
              windowOf(60),
            ),
          ).toBe(false)
          await store.close()
          await opts.cleanup?.()
        })

        it("is false once the token has been claimed", async () => {
          const store = await fresh()
          const created = await store.createSignInToken({
            id: tokenId(),
            userId: null,
            email: "spent@example.com",
            tokenHash: "h",
            expiresAt: farExpiry,
          })
          await store.claimSignInToken(created.id, new Date().toISOString())
          expect(
            await store.hasRecentSignInTokenForSubject(
              { userId: null, email: "spent@example.com" },
              windowOf(60),
            ),
          ).toBe(false)
          await store.close()
          await opts.cleanup?.()
        })

        it("is false once the token has expired", async () => {
          const store = await fresh()
          await store.createSignInToken({
            id: tokenId(),
            userId: null,
            email: "stale@example.com",
            tokenHash: "h",
            expiresAt: new Date(Date.now() - 1000).toISOString(),
          })
          expect(
            await store.hasRecentSignInTokenForSubject(
              { userId: null, email: "stale@example.com" },
              windowOf(60),
            ),
          ).toBe(false)
          await store.close()
          await opts.cleanup?.()
        })

        it("is false when the token predates the window", async () => {
          const store = await fresh()
          await store.createSignInToken({
            id: tokenId(),
            userId: null,
            email: "older@example.com",
            tokenHash: "h",
            expiresAt: farExpiry,
          })
          // A zero-length window: the row was created before `createdAfter`,
          // which is the "the throttle has elapsed" case.
          const future = new Date(Date.now() + 60_000).toISOString()
          expect(
            await store.hasRecentSignInTokenForSubject(
              { userId: null, email: "older@example.com" },
              { now: new Date().toISOString(), createdAfter: future },
            ),
          ).toBe(false)
          await store.close()
          await opts.cleanup?.()
        })
      })

      describe("deleteSignInTokensForUser", () => {
        it("removes only that user's userId-linked tokens, and reports the count", async () => {
          const store = await fresh()
          const u1 = await store.createUser({
            provider: "github",
            providerUserId: "signin-bulk-1",
            email: "signin-bulk-1@example.com",
            displayName: "U1",
            avatarUrl: "",
            role: "editor",
          })
          const u2 = await store.createUser({
            provider: "github",
            providerUserId: "signin-bulk-2",
            email: "signin-bulk-2@example.com",
            displayName: "U2",
            avatarUrl: "",
            role: "editor",
          })
          const a = await store.createSignInToken({
            id: tokenId(),
            userId: u1.id,
            email: null,
            tokenHash: "h1",
            expiresAt: farExpiry,
          })
          const b = await store.createSignInToken({
            id: tokenId(),
            userId: u1.id,
            email: null,
            tokenHash: "h2",
            expiresAt: farExpiry,
          })
          const other = await store.createSignInToken({
            id: tokenId(),
            userId: u2.id,
            email: null,
            tokenHash: "h3",
            expiresAt: farExpiry,
          })

          expect(await store.deleteSignInTokensForUser(u1.id)).toBe(2)

          expect(await store.getSignInToken(a.id)).toBeNull()
          expect(await store.getSignInToken(b.id)).toBeNull()
          expect(await store.getSignInToken(other.id)).not.toBeNull()
          await store.close()
          await opts.cleanup?.()
        })

        /**
         * An email-linked token (domain-rule self-serve join — `userId:
         * null`) belongs to no account yet, so a user's own revocation must
         * never touch someone else's, or an unrelated one.
         */
        it("does not touch email-linked tokens", async () => {
          const store = await fresh()
          const u = await store.createUser({
            provider: "github",
            providerUserId: "signin-bulk-email",
            email: "signin-bulk-email@example.com",
            displayName: "U",
            avatarUrl: "",
            role: "editor",
          })
          const emailLinked = await store.createSignInToken({
            id: tokenId(),
            userId: null,
            email: "join@example.com",
            tokenHash: "h",
            expiresAt: farExpiry,
          })

          expect(await store.deleteSignInTokensForUser(u.id)).toBe(0)
          expect(await store.getSignInToken(emailLinked.id)).not.toBeNull()
          await store.close()
          await opts.cleanup?.()
        })

        it("is idempotent, returning 0 on a user with no tokens", async () => {
          const store = await fresh()
          const u = await store.createUser({
            provider: "github",
            providerUserId: "signin-bulk-empty",
            email: "signin-bulk-empty@example.com",
            displayName: "U",
            avatarUrl: "",
            role: "editor",
          })
          expect(await store.deleteSignInTokensForUser(u.id)).toBe(0)
          expect(await store.deleteSignInTokensForUser("unknown-user")).toBe(0)
          await store.close()
          await opts.cleanup?.()
        })

        it("removes a claimed (already-used) token too — revocation must not wait for expiry", async () => {
          const store = await fresh()
          const u = await store.createUser({
            provider: "github",
            providerUserId: "signin-bulk-claimed",
            email: "signin-bulk-claimed@example.com",
            displayName: "U",
            avatarUrl: "",
            role: "editor",
          })
          const created = await store.createSignInToken({
            id: tokenId(),
            userId: u.id,
            email: null,
            tokenHash: "h",
            expiresAt: farExpiry,
          })
          await store.claimSignInToken(created.id, new Date().toISOString())

          expect(await store.deleteSignInTokensForUser(u.id)).toBe(1)
          expect(await store.getSignInToken(created.id)).toBeNull()
          await store.close()
          await opts.cleanup?.()
        })
      })

      describe("deleteSignInTokensForEmail (fix wave 9, item 3)", () => {
        it("removes only that address's email-linked tokens, and reports the count", async () => {
          const store = await fresh()
          const a = await store.createSignInToken({
            id: tokenId(),
            userId: null,
            email: "join-bulk@example.com",
            tokenHash: "h1",
            expiresAt: farExpiry,
          })
          const b = await store.createSignInToken({
            id: tokenId(),
            userId: null,
            email: "join-bulk@example.com",
            tokenHash: "h2",
            expiresAt: farExpiry,
          })
          const other = await store.createSignInToken({
            id: tokenId(),
            userId: null,
            email: "someone-else@example.com",
            tokenHash: "h3",
            expiresAt: farExpiry,
          })

          expect(await store.deleteSignInTokensForEmail("join-bulk@example.com")).toBe(2)

          expect(await store.getSignInToken(a.id)).toBeNull()
          expect(await store.getSignInToken(b.id)).toBeNull()
          expect(await store.getSignInToken(other.id)).not.toBeNull()
          await store.close()
          await opts.cleanup?.()
        })

        it("matches case-insensitively", async () => {
          const store = await fresh()
          const created = await store.createSignInToken({
            id: tokenId(),
            userId: null,
            email: "Case.Match@Example.com",
            tokenHash: "h",
            expiresAt: farExpiry,
          })

          expect(await store.deleteSignInTokensForEmail("CASE.match@EXAMPLE.com")).toBe(1)
          expect(await store.getSignInToken(created.id)).toBeNull()
          await store.close()
          await opts.cleanup?.()
        })

        it("does not touch a userId-linked token, even one for an account at the same address", async () => {
          const store = await fresh()
          const u = await store.createUser({
            provider: "github",
            providerUserId: "signin-email-bulk",
            email: "signin-email-bulk@example.com",
            displayName: "U",
            avatarUrl: "",
            role: "editor",
          })
          const userLinked = await store.createSignInToken({
            id: tokenId(),
            userId: u.id,
            email: null,
            tokenHash: "h",
            expiresAt: farExpiry,
          })

          expect(await store.deleteSignInTokensForEmail("signin-email-bulk@example.com")).toBe(0)
          expect(await store.getSignInToken(userLinked.id)).not.toBeNull()
          await store.close()
          await opts.cleanup?.()
        })

        it("is idempotent, returning 0 for an address with no tokens", async () => {
          const store = await fresh()
          expect(await store.deleteSignInTokensForEmail("nobody@example.com")).toBe(0)
          await store.close()
          await opts.cleanup?.()
        })

        it("removes a claimed (already-used) token too — revocation must not wait for expiry", async () => {
          const store = await fresh()
          const created = await store.createSignInToken({
            id: tokenId(),
            userId: null,
            email: "claimed-email-bulk@example.com",
            tokenHash: "h",
            expiresAt: farExpiry,
          })
          await store.claimSignInToken(created.id, new Date().toISOString())

          expect(await store.deleteSignInTokensForEmail("claimed-email-bulk@example.com")).toBe(1)
          expect(await store.getSignInToken(created.id)).toBeNull()
          await store.close()
          await opts.cleanup?.()
        })
      })
    })

    describe("domain rules", () => {
      it("starts empty", async () => {
        const store = await fresh()
        expect(await store.listDomainRules()).toEqual([])
        await store.close()
        await opts.cleanup?.()
      })

      it("setDomainRule creates a rule, lowercased, with defaults", async () => {
        const store = await fresh()
        const created = await store.setDomainRule({ domain: "Example.com", role: "editor", createdByUserId: null })
        expect(created.domain).toBe("example.com")
        expect(created.role).toBe("editor")
        expect(created.createdByUserId).toBeNull()
        expect(Date.parse(created.createdAt)).not.toBeNaN()
        await store.close()
        await opts.cleanup?.()
      })

      it("lists alphabetically by domain", async () => {
        const store = await fresh()
        await store.setDomainRule({ domain: "zeta.com", role: "viewer", createdByUserId: null })
        await store.setDomainRule({ domain: "alpha.com", role: "viewer", createdByUserId: null })
        await store.setDomainRule({ domain: "mid.com", role: "viewer", createdByUserId: null })
        const listed = await store.listDomainRules()
        expect(listed.map((d) => d.domain)).toEqual(["alpha.com", "mid.com", "zeta.com"])
        await store.close()
        await opts.cleanup?.()
      })

      it("upsert semantics: re-adding the same domain updates the role and does not duplicate", async () => {
        const store = await fresh()
        const first = await store.setDomainRule({ domain: "acme.com", role: "viewer", createdByUserId: null })
        const second = await store.setDomainRule({ domain: "acme.com", role: "admin", createdByUserId: null })
        expect(second.role).toBe("admin")
        expect(second.createdAt).toBe(first.createdAt) // creation identity survives an upsert
        const listed = await store.listDomainRules()
        expect(listed).toHaveLength(1)
        expect(listed[0].role).toBe("admin")
        await store.close()
        await opts.cleanup?.()
      })

      it("removeDomainRule is idempotent", async () => {
        const store = await fresh()
        await store.setDomainRule({ domain: "gone.com", role: "viewer", createdByUserId: null })
        await store.removeDomainRule("gone.com")
        expect(await store.listDomainRules()).toEqual([])
        await expect(store.removeDomainRule("gone.com")).resolves.toBeUndefined() // second call
        await expect(store.removeDomainRule("never-existed.com")).resolves.toBeUndefined()
        await store.close()
        await opts.cleanup?.()
      })

      it("returns detached copies", async () => {
        const store = await fresh()
        const created = await store.setDomainRule({ domain: "detach.com", role: "viewer", createdByUserId: null })
        created.role = "admin"
        const listed = await store.listDomainRules()
        expect(listed[0].role).toBe("viewer")
        await store.close()
        await opts.cleanup?.()
      })
    })

    describe("instance settings", () => {
      it("returns null for an unset key", async () => {
        const store = await fresh()
        expect(await store.getInstanceSetting("nope")).toBeNull()
        await store.close()
        await opts.cleanup?.()
      })

      it("round-trips a set value", async () => {
        const store = await fresh()
        await store.setInstanceSetting("signup-mode", "invite-only")
        expect(await store.getInstanceSetting("signup-mode")).toBe("invite-only")
        await store.close()
        await opts.cleanup?.()
      })

      it("upsert: setting the same key again replaces the value", async () => {
        const store = await fresh()
        await store.setInstanceSetting("signup-mode", "invite-only")
        await store.setInstanceSetting("signup-mode", "open")
        expect(await store.getInstanceSetting("signup-mode")).toBe("open")
        await store.close()
        await opts.cleanup?.()
      })

      it("keeps keys independent", async () => {
        const store = await fresh()
        await store.setInstanceSetting("a", "1")
        await store.setInstanceSetting("b", "2")
        expect(await store.getInstanceSetting("a")).toBe("1")
        expect(await store.getInstanceSetting("b")).toBe("2")
        await store.close()
        await opts.cleanup?.()
      })
    })
    /**
     * Phase 3c-2. A build streams log chunks for minutes, so this is an
     * APPEND rather than a read-modify-write through `updateDeployment`
     * (which would be quadratic and would race the terminal status write).
     * Both impls share `appendBounded`, so the point of this block is to
     * prove they are actually wired to it — including the truncation
     * marker, which must appear exactly once and must never be silent.
     */
    let logSlug = 1
    describe("deployment build log append", () => {
      async function seedDeployment(store: StorageAdapter) {
        const p = await store.createProject({ slug: `log${logSlug++}`, name: "L", repoUrl: null })
        return store.createDeployment({ projectId: p.id })
      }

      it("appends chunks in order", async () => {
        const store = await fresh()
        const d = await seedDeployment(store)
        await store.appendDeploymentLog(d.id, "one\n", 1000)
        await store.appendDeploymentLog(d.id, "two\n", 1000)
        expect((await store.getDeployment(d.id))?.buildLog).toBe("one\ntwo\n")
        await store.close()
        await opts.cleanup?.()
      })

      it("truncates at the cap and says so, exactly once", async () => {
        const store = await fresh()
        const d = await seedDeployment(store)
        await store.appendDeploymentLog(d.id, "abcdefghij", 6)
        const first = (await store.getDeployment(d.id))?.buildLog ?? ""
        expect(first.startsWith("abcdef")).toBe(true)
        expect(first).toContain("truncated")
        // Further chunks are dropped, and the marker is NOT repeated.
        await store.appendDeploymentLog(d.id, "klmnop", 6)
        const second = (await store.getDeployment(d.id))?.buildLog ?? ""
        expect(second).toBe(first)
        expect(second.match(/truncated/g)?.length).toBe(1)
        await store.close()
        await opts.cleanup?.()
      })

      it("is a no-op for an unknown deployment rather than throwing", async () => {
        const store = await fresh()
        await expect(store.appendDeploymentLog("nope", "x", 100)).resolves.toBeUndefined()
        await store.close()
        await opts.cleanup?.()
      })
    })

    /**
     * Fix wave 9, item 2. The build queue is in-process and holds no durable
     * state — a crash or `SIGKILL` leaves a `"building"` row exactly where it
     * was, forever, since nothing else ever moves it out of that status. This
     * is the boot-time reconciliation that closes that.
     */
    describe("markInterruptedBuildsFailed", () => {
      it("flips every 'building' deployment to 'failed' and appends a log line, leaving other statuses alone", async () => {
        const store = await fresh()
        const p = await store.createProject({ slug: "reconcile-1", name: "R" })
        const building1 = await store.createDeployment({ projectId: p.id })
        const building2 = await store.createDeployment({ projectId: p.id })
        const deployed = await store.createDeployment({ projectId: p.id, status: "deployed" })
        const failed = await store.createDeployment({ projectId: p.id, status: "failed" })

        expect(await store.markInterruptedBuildsFailed()).toBe(2)

        const b1 = await store.getDeployment(building1.id)
        const b2 = await store.getDeployment(building2.id)
        expect(b1?.status).toBe("failed")
        expect(b2?.status).toBe("failed")
        expect(b1?.buildLog).toContain("interrupted")
        expect(b2?.buildLog).toContain("interrupted")

        // Untouched: already-terminal rows keep their status AND their log.
        const d = await store.getDeployment(deployed.id)
        const f = await store.getDeployment(failed.id)
        expect(d?.status).toBe("deployed")
        expect(d?.buildLog).toBe("")
        expect(f?.status).toBe("failed")
        expect(f?.buildLog).toBe("")

        await store.close()
        await opts.cleanup?.()
      })

      it("returns 0 and changes nothing when no deployment is building", async () => {
        const store = await fresh()
        const p = await store.createProject({ slug: "reconcile-2", name: "R" })
        await store.createDeployment({ projectId: p.id, status: "deployed" })

        expect(await store.markInterruptedBuildsFailed()).toBe(0)

        await store.close()
        await opts.cleanup?.()
      })

      it("is idempotent — a second call finds nothing left to flip", async () => {
        const store = await fresh()
        const p = await store.createProject({ slug: "reconcile-3", name: "R" })
        await store.createDeployment({ projectId: p.id })

        expect(await store.markInterruptedBuildsFailed()).toBe(1)
        expect(await store.markInterruptedBuildsFailed()).toBe(0)

        await store.close()
        await opts.cleanup?.()
      })

      /**
       * Fix wave 10, item 4. The interrupted-build log line used to be
       * appended with a raw concatenation that skipped `MAX_BUILD_LOG_BYTES`
       * entirely — the same cap every OTHER write to `buildLog` respects via
       * `appendBounded` (see the "deployment build log append" describe
       * above). A log already AT the cap when the server restarted would
       * grow past it every time. Now it goes through the same bounded path.
       */
      it("bounds the interrupted-build log line at the cap rather than growing past it", async () => {
        const store = await fresh()
        const p = await store.createProject({ slug: "reconcile-bounded", name: "R" })

        // Case 1: the log is EXACTLY at the cap, with no truncation marker
        // yet — the marker gets appended exactly once, bounded.
        const atCap = await store.createDeployment({ projectId: p.id })
        await store.appendDeploymentLog(atCap.id, "x".repeat(MAX_BUILD_LOG_BYTES), MAX_BUILD_LOG_BYTES)
        const before = (await store.getDeployment(atCap.id))?.buildLog ?? ""
        expect(before.length).toBe(MAX_BUILD_LOG_BYTES)
        expect(before).not.toContain(LOG_TRUNCATION_MARKER)

        // Case 2: the log is ALREADY at the cap AND already carries the
        // marker (as a real streaming build's own overflow would leave it) —
        // nothing should be appended at all, not even the marker again.
        const atCapWithMarker = await store.createDeployment({ projectId: p.id })
        await store.appendDeploymentLog(
          atCapWithMarker.id,
          "y".repeat(MAX_BUILD_LOG_BYTES + 10),
          MAX_BUILD_LOG_BYTES,
        )
        const alreadyMarked = (await store.getDeployment(atCapWithMarker.id))?.buildLog ?? ""
        expect(alreadyMarked.endsWith(LOG_TRUNCATION_MARKER)).toBe(true)

        expect(await store.markInterruptedBuildsFailed()).toBe(2)

        const afterAtCap = await store.getDeployment(atCap.id)
        expect(afterAtCap?.status).toBe("failed")
        // Grew by exactly the marker, once — not by the raw interrupted-log
        // line, and not left ungrown either.
        expect(afterAtCap?.buildLog).toBe(before + LOG_TRUNCATION_MARKER)
        expect(afterAtCap?.buildLog.length).toBe(MAX_BUILD_LOG_BYTES + LOG_TRUNCATION_MARKER.length)

        const afterAlreadyMarked = await store.getDeployment(atCapWithMarker.id)
        expect(afterAlreadyMarked?.status).toBe("failed")
        // Completely unchanged — a raw `+=` would have grown this every
        // single time `markInterruptedBuildsFailed` ran.
        expect(afterAlreadyMarked?.buildLog).toBe(alreadyMarked)

        await store.close()
        await opts.cleanup?.()
      })
    })
  })
}
