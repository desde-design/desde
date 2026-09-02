/**
 * Build-runner tests against REAL git repositories on disk.
 *
 * A local path is a valid clone source, so the whole clone → install → build
 * → publish chain runs end to end with no GitHub App and no network. That
 * matters for the two security gates below: a mocked symlink proves nothing,
 * because the thing being tested is what the filesystem actually does.
 */
import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AssetStore } from "../../assets/types"
import type { Deployment, Project, ProjectRepoConfig } from "../../storage/types"
import { createInProcessBuildRunner } from "../in-process-build-runner"
import type { BuildLogChunk } from "../types"

const run = promisify(execFile)
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

/** Creates a real git repo whose "build" just copies a prepared tree. */
async function makeRepo(files: Record<string, string>, opts: { symlink?: [string, string] } = {}) {
  const dir = await tempDir("viewer-src-")
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    await fs.mkdir(join(full, ".."), { recursive: true })
    await fs.writeFile(full, content)
  }
  if (opts.symlink) {
    const [linkPath, target] = opts.symlink
    await fs.mkdir(join(dir, linkPath, ".."), { recursive: true }).catch(() => {})
    await fs.symlink(target, join(dir, linkPath))
  }
  await run("git", ["init", "-q", "-b", "main"], { cwd: dir })
  await run("git", ["config", "user.email", "t@t.test"], { cwd: dir })
  await run("git", ["config", "user.name", "T"], { cwd: dir })
  await run("git", ["add", "-A"], { cwd: dir })
  await run("git", ["commit", "-q", "-m", "init"], { cwd: dir })
  return dir
}

function collectingAssets(): AssetStore & { written: Map<string, Buffer>; deleted: string[] } {
  const written = new Map<string, Buffer>()
  const deleted: string[] = []
  return {
    written,
    deleted,
    async put(deploymentId, relPath, body) {
      written.set(relPath, body)
    },
    async get() {
      return null
    },
    async deleteDeployment(deploymentId) {
      deleted.push(deploymentId)
      // Mirrors what a real `AssetStore` does — proves cleanup actually
      // reclaims what was published, not merely that the method was called.
      written.clear()
    },
  }
}

const PROJECT = { id: "p1", slug: "s", name: "S" } as unknown as Project
const DEPLOYMENT = { id: "d1", projectId: "p1" } as unknown as Deployment

function repoConfig(over: Partial<ProjectRepoConfig> = {}): ProjectRepoConfig {
  return {
    installationId: 1,
    owner: "acme",
    name: "widget",
    defaultBranch: "main",
    branch: "main",
    installCommand: "true",
    buildCommand: "true",
    outputDir: "dist",
    autoDeploy: false,
    ...over,
  }
}

/**
 * Points the runner at a local path instead of github.com, and hands it a
 * stub token. The token minting seam is the ONLY stubbed thing here.
 */
function runnerFor(sourceDir: string, assets: AssetStore, over: Record<string, unknown> = {}) {
  return createInProcessBuildRunner({
    assets,
    githubApp: {
      async createInstallationToken() {
        return { token: "ghs_SUPERSECRET_TOKEN_VALUE", expiresAt: new Date(Date.now() + 3600e3).toISOString() }
      },
      async listInstallations() {
        return []
      },
      async listInstallationRepos() {
        return []
      },
    } as never,
    // Keeps the real clone/checkout/publish code path — only the URL differs.
    cloneUrlFor: () => sourceDir,
    ...over,
  } as never)
}

async function build(
  sourceDir: string,
  config: ProjectRepoConfig,
  assets = collectingAssets(),
  over: Record<string, unknown> = {},
) {
  const logs: BuildLogChunk[] = []
  const result = await runnerFor(sourceDir, assets, over).run({
    project: PROJECT,
    repo: config,
    deployment: DEPLOYMENT,
    onLog: (c) => logs.push(c),
  })
  return { result, assets, log: logs.map((l) => l.text).join("") }
}

describe("in-process build runner", () => {
  it("clones, builds, and publishes a real repo", async () => {
    const src = await makeRepo({
      "dist/index.html": "<!doctype html><title>hi</title>",
      "dist/assets/app.js": "console.log(1)",
    })
    const { result, assets } = await build(src, repoConfig())
    expect(result.ok).toBe(true)
    expect(result.fileCount).toBe(2)
    expect(assets.written.has("index.html")).toBe(true)
    expect(assets.written.has("assets/app.js")).toBe(true)
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/)
    // The subject line, captured at the same moment as the sha — `makeRepo`
    // commits with `-m "init"`.
    expect(result.commitMessage).toBe("init")
  })

  it("fails a build whose output has no index.html at its root", async () => {
    const src = await makeRepo({ "dist/main.js": "x" })
    const { result } = await build(src, repoConfig())
    expect(result.ok).toBe(false)
    expect(result.failureReason).toMatch(/index\.html/)
  })

  // viewer-membership row 7: this lane used to "quietly lose" the
  // root-absolute asset scan the upload lane already ran (see
  // `publish-output.ts`'s own header comment) — both lanes now share
  // `scanOutputTreeForRootAbsoluteAssets`, run here against the REAL output
  // tree the build just produced on disk.
  it("records a root-absolute asset warning on a build whose output bakes one", async () => {
    const src = await makeRepo({
      "dist/index.html": '<!doctype html><html><body><script src="/assets/app.js"></script></body></html>',
      "dist/assets/app.js": "console.log(1)",
    })
    const { result, log } = await build(src, repoConfig())
    expect(result.ok).toBe(true)
    expect(result.warnings).toEqual([
      {
        kind: "root-absolute-assets",
        summary: "1 root-absolute asset reference found in 1 file",
        findings: [{ file: "index.html", kind: "html-attr", sample: '<script src="/assets/app.js">' }],
      },
    ])
    expect(log).toMatch(/Warning: 1 root-absolute asset reference/)
  })

  it("records warnings: null for a build with no root-absolute references", async () => {
    const src = await makeRepo({
      "dist/index.html": '<!doctype html><html><body><script src="./assets/app.js"></script></body></html>',
      "dist/assets/app.js": "console.log(1)",
    })
    const { result } = await build(src, repoConfig())
    expect(result.ok).toBe(true)
    expect(result.warnings).toBeNull()
  })

  // MINOR 3 (coordinator review round 1) — mirrors the upload lane's
  // "completes the upload successfully even if the reference scan fails"
  // test: a scan bug must not turn a successful build into a reported
  // failure. `publishOutputDir` reads each of the 1 output file's bytes
  // once (call 1); the scan then re-reads that same recognized-extension
  // file as text (call 2) — make that call throw.
  it("completes the build successfully even if the reference scan fails", async () => {
    const src = await makeRepo({
      "dist/index.html": '<!doctype html><html><body><script src="/assets/app.js"></script></body></html>',
    })
    let readCount = 0
    const originalReadFile = fs.readFile
    const readFileSpy = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      readCount += 1
      if (readCount > 1) throw new Error("simulated scan failure")
      return originalReadFile.apply(fs, args)
    })

    try {
      const { result, log } = await build(src, repoConfig())
      expect(result.ok).toBe(true)
      expect(result.warnings).toBeNull()
      expect(log).toMatch(/Published 1 files/)
      expect(log).not.toMatch(/Warning:/)
    } finally {
      readFileSpy.mockRestore()
    }
  })

  /**
   * G1 — the headline gate. Phase 3c-1 validates the REQUEST-supplied half of
   * `outputDir`; it cannot validate repo CONTENT. This repo commits `dist` as
   * a symlink to `/`, with a completely legitimate `outputDir: "dist"`.
   * A REAL symlink, in a REAL git repo — a mock would prove nothing here.
   */
  it("refuses an outputDir that is a symlink escaping the checkout", async () => {
    const src = await makeRepo({ "README.md": "x" }, { symlink: ["dist", "/"] })
    const { result } = await build(src, repoConfig())
    expect(result.ok).toBe(false)
    expect(result.failureReason).toMatch(/outside the repository checkout/)
  })

  it("refuses a symlink INSIDE the output tree rather than silently skipping it", async () => {
    const src = await makeRepo(
      { "dist/index.html": "<!doctype html>" },
      { symlink: ["dist/secrets", "/etc/passwd"] },
    )
    const { result, assets } = await build(src, repoConfig())
    expect(result.ok).toBe(false)
    expect(result.failureReason).toMatch(/symlink/)
    // And nothing from the escaping tree was published on the way to failing.
    expect(assets.written.has("secrets")).toBe(false)
  })

  /**
   * The viewer process holds VIEWER_GITHUB_APP_PRIVATE_KEY,
   * VIEWER_SESSION_SECRET and VIEWER_ADMIN_TOKEN. `spawn`'s DEFAULT is to
   * hand all of it to `npm run build` from an arbitrary repo.
   */
  it("does not leak the viewer's environment into the build", async () => {
    process.env.VIEWER_TEST_SENTINEL = "must-not-appear-in-build"
    try {
      const src = await makeRepo({ "package.json": "{}" })
      const { result, assets } = await build(
        src,
        repoConfig({
          buildCommand: 'mkdir -p dist && printf "<!doctype html>" > dist/index.html && env > dist/env.txt',
        }),
      )
      expect(result.ok).toBe(true)
      const captured = assets.written.get("env.txt")?.toString("utf8") ?? ""
      expect(captured).not.toContain("must-not-appear-in-build")
      expect(captured).not.toContain("VIEWER_TEST_SENTINEL")
      // Sanity: the allowlist really did reach the child, so a passing
      // assertion above cannot be "env produced nothing at all".
      expect(captured).toContain("CI=true")
    } finally {
      delete process.env.VIEWER_TEST_SENTINEL
    }
  })

  /**
   * REGRESSION (2026-08-08, found by the end-to-end run, not by this suite).
   *
   * `buildEnv` hardcoded `NODE_ENV=production` for EVERY step. **npm** reads
   * that as `--omit=dev`, so the install step skipped devDependencies — which
   * is exactly where `vite`, `@vitejs/plugin-react` and `typescript` live in a
   * standard Vite project. Every such build then died with `Cannot find
   * package 'vite'`, and the error read like the repo's fault.
   *
   * Scope, measured (an earlier version of this comment overstated it): pnpm
   * >=10 and Yarn Berry ignore NODE_ENV for this purpose and install devDeps
   * anyway. The affected population is npm-installed repos — which is still
   * every repo using the default `installCommand: "npm ci"`.
   *
   * This suite missed it because its fixtures use `installCommand: "true"` —
   * no real package manager ever ran. These two tests assert the env each
   * step actually receives, which is the observable that was wrong.
   */
  it("does NOT set NODE_ENV=production for the install step (it would omit devDependencies)", async () => {
    const src = await makeRepo({ "package.json": "{}" })
    const { result, assets } = await build(
      src,
      repoConfig({
        // The install step runs in the checkout, so stash its env where the
        // build step can copy it into the published output for inspection.
        installCommand: "env > .install-env.txt",
        buildCommand: 'mkdir -p dist && printf "<!doctype html>" > dist/index.html && cp .install-env.txt dist/install-env.txt',
      }),
    )
    expect(result.ok).toBe(true)
    const installEnv = assets.written.get("install-env.txt")?.toString("utf8") ?? ""
    // Sanity first: the allowlist reached the install child at all, so a
    // passing assertion below cannot be "env produced nothing".
    expect(installEnv).toContain("CI=true")
    expect(installEnv).not.toMatch(/^NODE_ENV=/m)
  })

  it("DOES set NODE_ENV=production for the build step", async () => {
    const src = await makeRepo({ "package.json": "{}" })
    const { result, assets } = await build(
      src,
      repoConfig({
        buildCommand: 'mkdir -p dist && printf "<!doctype html>" > dist/index.html && env > dist/build-env.txt',
      }),
    )
    expect(result.ok).toBe(true)
    const buildEnvCaptured = assets.written.get("build-env.txt")?.toString("utf8") ?? ""
    expect(buildEnvCaptured).toContain("CI=true")
    expect(buildEnvCaptured).toMatch(/^NODE_ENV=production$/m)
  })

  it("never writes the installation token into the build log", async () => {
    const src = await makeRepo({ "dist/index.html": "<!doctype html>" })
    const { result, log } = await build(src, repoConfig({ buildCommand: "env | grep -i author || true" }))
    expect(result.ok).toBe(true)
    expect(log).not.toContain("ghs_SUPERSECRET_TOKEN_VALUE")
  })

  it("times out a hanging build and reports it as a failure", async () => {
    const src = await makeRepo({ "dist/index.html": "<!doctype html>" })
    const { result } = await build(src, repoConfig({ buildCommand: "sleep 30" }), collectingAssets(), {
      timeoutMs: 3_000,
    })
    expect(result.ok).toBe(false)
    expect(result.failureReason).toMatch(/timed out/i)
  }, 30_000)

  it("reports a failing build command rather than publishing a stale tree", async () => {
    const src = await makeRepo({ "dist/index.html": "<!doctype html>" })
    const { result, assets } = await build(src, repoConfig({ buildCommand: "exit 3" }))
    expect(result.ok).toBe(false)
    expect(result.failureReason).toMatch(/Build failed/)
    expect(assets.written.size).toBe(0)
  })

  /**
   * K01/S5 — a build that fails PARTWAY THROUGH publish (over the total-
   * output-bytes cap) must not strand whatever it already wrote to the
   * asset store. `index.html` sorts before `zzz-big.txt`
   * (`collectOutputFiles` publishes in sorted order), so `index.html`
   * publishes successfully before the cap trips on the second file —
   * proving `fail()` reclaims a REAL partial publish, not just a
   * before-anything-was-written failure.
   */
  it("cleans up assets already published when the output exceeds the total-bytes cap partway through", async () => {
    const src = await makeRepo({
      "dist/index.html": "<!doctype html>",
      "dist/zzz-big.txt": "x".repeat(1000),
    })
    const { result, assets } = await build(src, repoConfig(), collectingAssets(), {
      maxTotalOutputBytes: 100,
    })
    expect(result.ok).toBe(false)
    expect(result.failureReason).toMatch(/exceeds the/i)
    expect(assets.deleted).toEqual([DEPLOYMENT.id])
    // The index.html that DID publish before the cap tripped is gone too.
    expect(assets.written.size).toBe(0)
  })
})

describe("build queue", () => {
  it("refuses a second concurrent build and names the one already running", async () => {
    const { createBuildQueue, BuildInProgressError } = await import("../build-queue")
    const { InMemoryStorage } = await import("../../storage/in-memory-storage")
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "q1", name: "Q", repoUrl: null })
    await storage.setProjectRepoConfig(project.id, repoConfig())

    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const queue = createBuildQueue({
      storage,
      assets: collectingAssets(),
      runner: {
        async run() {
          await gate
          return { ok: true, commitSha: "abc", commitMessage: null, fileCount: 1 }
        },
      },
    })

    const first = await queue.start(project.id)
    await expect(queue.start(project.id)).rejects.toBeInstanceOf(BuildInProgressError)
    // The refusal carries the in-flight id, so a caller can watch the build
    // that already exists instead of being told only "no".
    await queue.start(project.id).catch((e) => expect(e.deploymentId).toBe(first))
    release()
    await new Promise((r) => setTimeout(r, 50))
    // ...and once it finishes, the project is buildable again.
    await expect(queue.start(project.id)).resolves.toBeTypeOf("string")
    await queue.shutdown()
  })

  it("writes the runner's warnings onto the deployment once a build succeeds", async () => {
    const { createBuildQueue } = await import("../build-queue")
    const { InMemoryStorage } = await import("../../storage/in-memory-storage")
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "warn1", name: "Warn", repoUrl: null })
    await storage.setProjectRepoConfig(project.id, repoConfig())

    const warnings = [
      {
        kind: "root-absolute-assets" as const,
        summary: "1 root-absolute asset reference found in 1 file",
        findings: [{ file: "index.html", kind: "html-attr" as const, sample: '<script src="/a.js">' }],
      },
    ]
    const queue = createBuildQueue({
      storage,
      assets: collectingAssets(),
      runner: {
        async run() {
          return { ok: true, commitSha: "abc", commitMessage: null, fileCount: 1, warnings }
        },
      },
    })

    const id = await queue.start(project.id)
    await new Promise((r) => setTimeout(r, 50))
    await queue.shutdown()

    expect((await storage.getDeployment(id))?.warnings).toEqual(warnings)
  })

  it("writes warnings: null when the runner reports none", async () => {
    const { createBuildQueue } = await import("../build-queue")
    const { InMemoryStorage } = await import("../../storage/in-memory-storage")
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "warn2", name: "Warn2", repoUrl: null })
    await storage.setProjectRepoConfig(project.id, repoConfig())

    const queue = createBuildQueue({
      storage,
      assets: collectingAssets(),
      runner: {
        async run() {
          return { ok: true, commitSha: "abc", commitMessage: null, fileCount: 1 }
        },
      },
    })

    const id = await queue.start(project.id)
    await new Promise((r) => setTimeout(r, 50))
    await queue.shutdown()

    expect((await storage.getDeployment(id))?.warnings).toBeNull()
  })

  /**
   * K01 — the per-project check above stops the SAME project racing itself;
   * this is the GLOBAL cap across every project (`MAX_GLOBAL_CONCURRENT_BUILDS`,
   * currently 2), which is what actually bounds a webhook fan-out or several
   * owners clicking "Build" at once.
   */
  it("refuses a build past MAX_GLOBAL_CONCURRENT_BUILDS regardless of project", async () => {
    const { createBuildQueue, BuildQueueFullError, MAX_GLOBAL_CONCURRENT_BUILDS } = await import(
      "../build-queue"
    )
    const { InMemoryStorage } = await import("../../storage/in-memory-storage")
    const storage = new InMemoryStorage()
    const projects = await Promise.all(
      Array.from({ length: MAX_GLOBAL_CONCURRENT_BUILDS + 1 }, async (_, i) => {
        const p = await storage.createProject({ slug: `g${i}`, name: "G", repoUrl: null })
        await storage.setProjectRepoConfig(p.id, repoConfig())
        return p
      }),
    )

    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const queue = createBuildQueue({
      storage,
      assets: collectingAssets(),
      runner: {
        async run() {
          await gate
          return { ok: true, commitSha: "abc", commitMessage: null, fileCount: 1 }
        },
      },
    })

    // Fill every global slot, each on a DIFFERENT project (so the per-project
    // check never fires — only the global cap can be what refuses the next one).
    for (let i = 0; i < MAX_GLOBAL_CONCURRENT_BUILDS; i++) {
      await queue.start(projects[i].id)
    }
    const overflowProject = projects[MAX_GLOBAL_CONCURRENT_BUILDS]
    await expect(queue.start(overflowProject.id)).rejects.toBeInstanceOf(BuildQueueFullError)
    // Rejected BEFORE any storage write for the overflow project — no
    // deployment row was created for a build that never ran.
    expect(await storage.listDeployments(overflowProject.id)).toEqual([])

    release()
    await new Promise((r) => setTimeout(r, 50))
    // Once a slot frees up, the overflow project can build.
    await expect(queue.start(overflowProject.id)).resolves.toBeTypeOf("string")
    await queue.shutdown()
  })

  /**
   * S5 — the build lane leaked identically to the upload lane: every
   * push-triggered rebuild stranded the PREVIOUS deployment's assets
   * forever. Same asset-only sweep, run right after `activeDeploymentId`
   * flips to the new deployment.
   */
  it("reclaims a superseded deployment's assets once it falls off the retention window", async () => {
    const { createBuildQueue } = await import("../build-queue")
    const { DEPLOYMENT_RETENTION_COUNT } = await import("../publish-output")
    const { InMemoryStorage } = await import("../../storage/in-memory-storage")
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "gc1", name: "GC", repoUrl: null })
    await storage.setProjectRepoConfig(project.id, repoConfig())

    const assets = collectingAssets()
    // Each build's `put` writes into the SAME shared map keyed by relPath
    // only, so track which deployment id is "current" to assert against —
    // simpler: just record every deploymentId `deleteDeployment` is called
    // with, which is what retention actually does.
    const queue = createBuildQueue({
      storage,
      assets,
      runner: {
        async run() {
          return { ok: true, commitSha: "abc", commitMessage: null, fileCount: 1 }
        },
      },
    })

    const rounds = DEPLOYMENT_RETENTION_COUNT + 1
    const ids: string[] = []
    for (let i = 0; i < rounds; i++) {
      const id = await queue.start(project.id)
      ids.push(id)
      await new Promise((r) => setTimeout(r, 50))
    }
    await queue.shutdown()

    // The oldest deployment's assets were reclaimed once it fell out of the
    // retention window; the rest were not.
    expect(assets.deleted).toContain(ids[0])
    expect(assets.deleted).not.toContain(ids[ids.length - 1])
  })

  it("marks an interrupted build failed on shutdown rather than leaving it building forever", async () => {
    const { createBuildQueue } = await import("../build-queue")
    const { InMemoryStorage } = await import("../../storage/in-memory-storage")
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "q2", name: "Q", repoUrl: null })
    await storage.setProjectRepoConfig(project.id, repoConfig())

    const queue = createBuildQueue({
      storage,
      assets: collectingAssets(),
      runner: {
        run: (req) =>
          new Promise((resolveRun) => {
            req.signal?.addEventListener("abort", () =>
              resolveRun({ ok: false, commitSha: null, commitMessage: null, fileCount: 0, failureReason: "aborted" }),
            )
          }),
      },
    })

    const id = await queue.start(project.id)
    expect((await storage.getDeployment(id))?.status).toBe("building")
    await queue.shutdown()
    expect((await storage.getDeployment(id))?.status).toBe("failed")
  })

  /**
   * Found by a LIVE build, not by a test: the runner resolved the sha, put it
   * in its result, and the queue dropped it — so a branch-triggered
   * deployment permanently recorded `commitSha: null` and nothing could say
   * what was actually deployed. The earlier queue tests passed because they
   * used a stub returning a sha and never asserted it reached storage.
   */
  it("records the RESOLVED commit sha, not the requested one", async () => {
    const { createBuildQueue } = await import("../build-queue")
    const { InMemoryStorage } = await import("../../storage/in-memory-storage")
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "q4", name: "Q", repoUrl: null })
    await storage.setProjectRepoConfig(project.id, repoConfig())

    const queue = createBuildQueue({
      storage,
      assets: collectingAssets(),
      runner: {
        async run() {
          return { ok: true, commitSha: "0123456789abcdef0123456789abcdef01234567", commitMessage: null, fileCount: 1 }
        },
      },
    })
    // Triggered on a BRANCH — no sha is known at create time.
    const id = await queue.start(project.id)
    await new Promise((r) => setTimeout(r, 300))
    const d = await storage.getDeployment(id)
    expect(d?.commitSha).toBe("0123456789abcdef0123456789abcdef01234567")
    expect(d?.status).toBe("deployed")
    await queue.shutdown()
  })

  it("does not clobber the streamed log when writing the terminal status", async () => {
    const { createBuildQueue } = await import("../build-queue")
    const { InMemoryStorage } = await import("../../storage/in-memory-storage")
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "q3", name: "Q", repoUrl: null })
    await storage.setProjectRepoConfig(project.id, repoConfig())

    const queue = createBuildQueue({
      storage,
      assets: collectingAssets(),
      runner: {
        async run(req) {
          req.onLog({ stream: "stdout", text: "streamed-line\n" })
          return { ok: true, commitSha: "abc", commitMessage: null, fileCount: 1 }
        },
      },
    })
    const id = await queue.start(project.id)
    await new Promise((r) => setTimeout(r, 500))
    expect((await storage.getDeployment(id))?.buildLog).toContain("streamed-line")
    expect((await storage.getDeployment(id))?.status).toBe("deployed")
    await queue.shutdown()
  })
})
