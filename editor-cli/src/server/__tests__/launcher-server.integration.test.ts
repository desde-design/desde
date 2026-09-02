/**
 * Integration coverage for the launcher server — home page (served from
 * the UI bundle), bootstrap script, recents, pick-folder, open, clone.
 * The editor spawn and the native folder picker are stubbed so no
 * Vite child boots and no OS dialog pops; clone uses a local source
 * repo (no network). HOME is redirected so the recents registry is
 * controlled. The UI bundle root points at a stub index.html — the
 * launcher serves whatever bundle it's given.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { request as httpRequest } from "node:http"
import { promisify } from "node:util"
import { startLauncher, type LauncherHandle } from "../launcher-server.js"
import { upsertProjectRegistryEntry } from "../projects-registry.js"
import { EditorBootFailure } from "../editor-boot-failure.js"
import type { FolderPickResult } from "../folder-picker.js"

const execFileAsync = promisify(execFile)

let handle: LauncherHandle
let tmpHome: string
let realHome: string | undefined
let tmp: string
let bundleRoot: string
const spawnStub = vi.fn(async (repoPath: string) => ({
  url: `http://127.0.0.1:9999/?opened=${encodeURIComponent(repoPath)}`,
}))
const pickFolderStub = vi.fn<() => Promise<FolderPickResult>>(async () => ({
  supported: true,
  path: "/picked/by/stub",
}))

async function pickFreePort(): Promise<number> {
  const net = await import("node:net")
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.unref()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address()
      const p = typeof addr === "object" && addr ? addr.port : 0
      probe.close(() => resolve(p))
    })
  })
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "launcher-home-"))
  realHome = process.env.HOME
  process.env.HOME = tmpHome
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "launcher-test-"))
  // Stub UI bundle — the launcher serves whatever index.html is at the root.
  bundleRoot = path.join(tmp, "bundle")
  await fs.mkdir(bundleRoot)
  await fs.writeFile(
    path.join(bundleRoot, "index.html"),
    "<!doctype html><html><head><title>Editor</title></head><body><div id=\"root\"></div></body></html>",
  )
  await fs.writeFile(path.join(bundleRoot, "app.js"), "// bundle js\n")
  spawnStub.mockClear()
  // Restore the default implementation, not just the call log: the
  // pre-check suite below swaps in a throwing spawn to reproduce a refused
  // boot, and `mockClear` alone would leak that into every later test.
  spawnStub.mockImplementation(async (repoPath: string) => ({
    url: `http://127.0.0.1:9999/?opened=${encodeURIComponent(repoPath)}`,
  }))
  pickFolderStub.mockClear()
  pickFolderStub.mockImplementation(async () => ({
    supported: true,
    path: "/picked/by/stub",
  }))
  const port = await pickFreePort()
  handle = await startLauncher({
    port,
    spawnEditor: spawnStub,
    pickFolder: pickFolderStub,
    uiBundleRoot: bundleRoot,
  })
})

afterEach(async () => {
  await handle.close()
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  await fs.rm(tmpHome, { recursive: true, force: true })
  await fs.rm(tmp, { recursive: true, force: true })
})

/**
 * `port: 0` has to work here, not just in `startHttpServer`.
 *
 * Three things were derived from the REQUESTED port: `listenOrigin` (which was
 * corrected after `listen`), the returned `url`, and `security.shellOrigin`
 * (which were not). So an ephemeral bind used to return `http://127.0.0.1:0`
 * and then 403 every legitimate POST, because the origin every
 * `originPolicy: "required"` route compares against named a port nothing had
 * bound.
 *
 * Asserting the URL alone would not have caught the second half — the URL is
 * the visible symptom, the Origin check is the one that makes the server
 * useless. So this drives a real origin-required POST.
 */
describe("startLauncher — ephemeral port", () => {
  it("reports the bound port and accepts its own Origin on a required-origin route", async () => {
    const h = await startLauncher({
      port: 0,
      spawnEditor: spawnStub,
      pickFolder: pickFolderStub,
      uiBundleRoot: bundleRoot,
    })
    try {
      expect(h.url).not.toMatch(/:0$/)
      const boundPort = Number(new URL(h.url).port)
      expect(boundPort).toBeGreaterThan(0)

      // The reported URL must be the one that actually serves.
      const boot = await fetch(`${h.url}/__desde/bootstrap.js`)
      expect(boot.status).toBe(200)
      const js = await boot.text()
      const m = js.match(/window\.__DESDE_LAUNCHER__=(\{.*\});/)
      expect(m).not.toBeNull()
      const token = (JSON.parse(m![1]) as { token: string }).token

      // The Origin check must accept the origin the handle advertises. This
      // is the half a URL assertion cannot see.
      const res = await fetch(`${h.url}/api/launcher/pick-folder`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: h.url,
          "Content-Type": "application/json",
        },
      })
      expect(res.status).not.toBe(403)
    } finally {
      await h.close()
    }
  })
})

/** The bootstrap script carries the per-session token; pull it out. */
async function tokenFromBootstrap(): Promise<string> {
  const res = await fetch(handle.url + "/__desde/bootstrap.js")
  const js = await res.text()
  const m = js.match(/window\.__DESDE_LAUNCHER__=(\{.*\});/)
  if (!m) throw new Error("launcher bootstrap payload not found")
  return (JSON.parse(m[1]) as { token: string }).token
}

function authedHeaders(token: string): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    origin: handle.url,
  }
}

describe("launcher server", () => {
  it("serves the UI bundle index with the launcher bootstrap injected", async () => {
    const res = await fetch(handle.url + "/")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toMatch(/text\/html/)
    const html = await res.text()
    // The stub bundle's own content is served…
    expect(html).toContain('<div id="root">')
    // …with the bootstrap <script> injected before </head>.
    expect(html).toContain('<script src="/__desde/bootstrap.js"></script>')
    // The token is NOT inlined into the page (it lives in the CORP-guarded
    // bootstrap response).
    const token = await tokenFromBootstrap()
    expect(html).not.toContain(token)
  })

  /**
   * Security audit B10 — the same DNS-rebinding guard the editor's
   * `routeRequest` runs. The launcher is the higher-value of the two targets:
   * its bootstrap carries a bearer, and `/api/launcher/projects` behind that
   * bearer lists every repo path the user has ever opened. Reads only —
   * `open`/`clone` are Origin-gated and a browser always sends `Origin` on a
   * POST — so this is disclosure, not code execution.
   */
  describe("Host guard (B10)", () => {
    /** Exactly the headers given; node adds no `Host` of its own. */
    function raw(
      urlPath: string,
      headers: Record<string, string> = {},
    ): Promise<{ status: number; body: string }> {
      const port = Number(new URL(handle.url).port)
      return new Promise((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port, method: "GET", path: urlPath, headers, setHost: false },
          (res) => {
            let body = ""
            res.setEncoding("utf8")
            res.on("data", (c) => (body += c))
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
          },
        )
        req.once("error", reject)
        req.end()
      })
    }

    const PATHS = ["/", "/app.js", "/__desde/bootstrap.js", "/api/launcher/projects"]

    it("403s a spoofed Host on every path, ungated ones included", async () => {
      const wrong: string[] = []
      for (const p of PATHS) {
        const res = await raw(p, { host: "evil.test:4321" })
        if (res.status !== 403 || !/Invalid Host/.test(res.body)) {
          wrong.push(`${p} → ${res.status} ${res.body}`)
        }
        expect(res.body).not.toContain("__DESDE_LAUNCHER__")
      }
      expect(wrong).toEqual([])
    })

    it("still serves the launcher bootstrap on a legitimate Host", async () => {
      const port = new URL(handle.url).port
      for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
        const res = await raw("/__desde/bootstrap.js", { host })
        expect(res.status, host).toBe(200)
        expect(res.body, host).toContain("window.__DESDE_LAUNCHER__=")
      }
    })

    // MEASURED: node's own parser 400s a Host-less HTTP/1.1 request before the
    // handler runs, so `checkHost` never sees it. Either way, no token.
    it("never answers a request with no Host header", async () => {
      const res = await raw("/__desde/bootstrap.js")
      expect(res.status).toBe(400)
      expect(res.body).not.toContain("__DESDE_LAUNCHER__")
    })

    it("refuses a cross-site fetch of the bootstrap even on a good Host", async () => {
      const res = await raw("/__desde/bootstrap.js", {
        host: `127.0.0.1:${new URL(handle.url).port}`,
        "sec-fetch-site": "cross-site",
      })
      expect(res.status).toBe(403)
      expect(res.body).not.toContain("__DESDE_LAUNCHER__")
    })
  })

  it("serves bundle assets and refuses path traversal", async () => {
    const asset = await fetch(handle.url + "/app.js")
    expect(asset.status).toBe(200)
    expect(await asset.text()).toContain("bundle js")
    const traversal = await fetch(handle.url + "/..%2F..%2Fetc%2Fpasswd")
    // Either contained (SPA fallback to index) or rejected — never file
    // contents from outside the bundle root.
    const text = await traversal.text()
    expect(text).not.toContain("root:")
  })

  it("exposes folder-picker capability in the bootstrap payload", async () => {
    const res = await fetch(handle.url + "/__desde/bootstrap.js")
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin")
    const js = await res.text()
    const payload = JSON.parse(
      js.match(/window\.__DESDE_LAUNCHER__=(\{.*\});/)![1],
    ) as { folderPicker: { supported: boolean } }
    expect(typeof payload.folderPicker.supported).toBe("boolean")
  })

  it("returns recents from the registry", async () => {
    await upsertProjectRegistryEntry({ path: "/repo/a", slug: "app-a" })
    const token = await tokenFromBootstrap()
    const res = await fetch(handle.url + "/api/launcher/projects", {
      headers: { authorization: `Bearer ${token}` },
    })
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.projects.map((p: { path: string }) => p.path)).toContain("/repo/a")
  })

  it("rejects an unauthenticated open", async () => {
    const res = await fetch(handle.url + "/api/launcher/open", {
      method: "POST",
      headers: { "content-type": "application/json", origin: handle.url },
      body: JSON.stringify({ path: tmp }),
    })
    expect(res.status).toBe(401)
    expect(spawnStub).not.toHaveBeenCalled()
  })

  /**
   * The fixture is a real Vue + Vite repo, not a bare temp dir. It used to be
   * the latter, which meant this test was asserting that a folder Editor
   * cannot boot spawns a child anyway — the defect the pre-check closes.
   */
  it("opens a directory by spawning an editor", async () => {
    const openable = path.join(tmp, "openable")
    await fs.mkdir(openable)
    await fs.writeFile(
      path.join(openable, "package.json"),
      JSON.stringify({ dependencies: { vue: "^3.4.0" }, devDependencies: { vite: "^5.0.0" } }),
    )
    await fs.writeFile(path.join(openable, "vite.config.ts"), "export default {}")
    // A real repo: the boot's preflight refuses a non-repo, so the pre-check
    // has to as well, or the launcher would say yes to something that fails.
    await execFileAsync("git", ["-C", openable, "init", "-q"])
    const token = await tokenFromBootstrap()
    const res = await fetch(handle.url + "/api/launcher/open", {
      method: "POST",
      headers: authedHeaders(token),
      body: JSON.stringify({ path: openable }),
    })
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.url).toContain("opened=")
    expect(spawnStub).toHaveBeenCalledWith(openable)
  })

  /**
   * The launcher answers "we cannot boot this" ITSELF, instead of spawning a
   * child that answers it to a terminal and exits.
   *
   * The stub throws exactly what `defaultSpawnEditor` produces on a refused
   * boot, so a regression here reproduces the original symptom verbatim: the
   * modal showed `editor exited before it was ready (code 4)` and nothing else.
   */
  describe("unsupported-repo pre-check", () => {
    /** Writes a package.json (and optional extra files) into a fresh dir. */
    async function fixture(
      name: string,
      files: Record<string, string>,
      { git = false }: { git?: boolean } = {},
    ): Promise<string> {
      const dir = path.join(tmp, name)
      await fs.mkdir(dir, { recursive: true })
      for (const [file, body] of Object.entries(files)) {
        await fs.writeFile(path.join(dir, file), body)
      }
      // `git: true` for every fixture that is supposed to OPEN — the boot's
      // own preflight refuses a non-repo, so a would-be-openable fixture
      // without a `.git` is not actually openable.
      if (git) await execFileAsync("git", ["-C", dir, "init", "-q"])
      return dir
    }

    async function open(dir: string): Promise<{ status: number; body: Record<string, unknown> }> {
      const token = await tokenFromBootstrap()
      const res = await fetch(handle.url + "/api/launcher/open", {
        method: "POST",
        headers: authedHeaders(token),
        body: JSON.stringify({ path: dir }),
      })
      return { status: res.status, body: (await res.json()) as Record<string, unknown> }
    }

    beforeEach(() => {
      spawnStub.mockImplementation(async () => {
        throw new Error("editor exited before it was ready (code 4)")
      })
    })

    it("refuses a folder with no package.json without spawning anything", async () => {
      const dir = await fixture("bare-folder", {})
      const { status, body } = await open(dir)

      // Asserted FIRST because it is the symptom the user reported: the modal
      // rendered the child's exit code and nothing a person could act on.
      expect(JSON.stringify(body)).not.toContain("exited before it was ready")
      expect(spawnStub).not.toHaveBeenCalled()
      expect(status).toBe(400)
      const blocked = body.blocked as { code: string; remediation: string[] }
      expect(blocked.code).toBe("framework-unsupported")
      expect(blocked.remediation.length).toBeGreaterThan(0)
    })

    it("refuses a Svelte project as unsupported, naming what IS supported", async () => {
      const dir = await fixture("svelte-app", {
        "package.json": JSON.stringify({ devDependencies: { svelte: "^5.0.0", vite: "^5.0.0" } }),
        "vite.config.ts": "export default {}",
      })
      const { status, body } = await open(dir)

      expect(spawnStub).not.toHaveBeenCalled()
      expect(status).toBe(400)
      const blocked = body.blocked as {
        code: string
        supported: { id: string; label: string }[]
      }
      expect(blocked.code).toBe("framework-unsupported")
      // The supported list is derived from the host registry, so it names the
      // enabled in-process hosts this build has, never a literal in the UI.
      expect(blocked.supported.map((h) => h.id)).toContain("vite")
      expect(blocked.supported.find((h) => h.id === "vite")).toMatchObject({
        label: "Vite",
      })
      // `enabled` and `note` are gone: only supported hosts are listed at all.
      expect(Object.keys(blocked.supported[0]).sort()).toEqual(["id", "label"])
    })

    /**
     * A switched-off host is reported as plain "not supported" over the wire.
     *
     * It used to be its own `host-not-enabled` code, on the reasoning that the
     * host really is built and the distinction lets the UI tell the truth. Mo
     * cut that 2026-08-17: from where the user stands, "not built" and "built
     * and not turned on" are the same closed door.
     *
     * Driven through a project that switches `vite` off in its own config
     * rather than through whichever host happens to be default-off this week:
     * the default set is being flipped host by host, and a test pinned to
     * today's defaults would be measuring the calendar.
     */
    it("reports a built-but-switched-off host as plain unsupported", async () => {
      const dir = await fixture("vite-off", {
        "package.json": JSON.stringify({ dependencies: { vue: "^3.4.0" }, devDependencies: { vite: "^5.0.0" } }),
        "vite.config.ts": "export default {}",
        "desde.config.json": JSON.stringify({ hosts: { vite: false } }),
      })
      const { status, body } = await open(dir)

      expect(spawnStub).not.toHaveBeenCalled()
      expect(status).toBe(400)
      const blocked = body.blocked as {
        code: string
        summary: string
        remediation: string[]
        attachCovers: boolean
        supported: { id: string; label: string }[]
      }
      expect(blocked.code).toBe("framework-unsupported")
      expect(blocked.summary).toContain("Vite")
      // No config switch offered, and no attach consolation prize.
      expect(blocked.remediation).toEqual([])
      expect(blocked.attachCovers).toBe(false)
      // The host that is off does not appear in its own supported list.
      expect(blocked.supported.map((h) => h.id)).not.toContain("vite")
    })

    it("refuses an ambiguous repo with both frameworks' evidence quoted", async () => {
      const dir = await fixture("nuxt-and-astro", {
        "package.json": JSON.stringify({
          dependencies: { vue: "^3.4.0", nuxt: "^3.0.0", astro: "^4.0.0" },
        }),
        "nuxt.config.ts": "export default {}",
        "astro.config.mjs": "export default {}",
      })
      const { status, body } = await open(dir)

      expect(spawnStub).not.toHaveBeenCalled()
      expect(status).toBe(400)
      const blocked = body.blocked as { code: string; cause: string; remediation: string[] }
      expect(blocked.code).toBe("ambiguous-host")
      expect(blocked.cause).toContain("nuxt.config.ts")
      expect(blocked.cause).toContain("astro.config.mjs")
      expect(blocked.remediation.join(" ")).toContain("--host")
    })

    /**
     * MEASURED before the repo-state check existed, by booting the real CLI on
     * a non-git Vue + Vite app: it passed every framework check, spawned, died
     * on `Could not read .git directory`, exited 1, and the modal read
     * `editor exited before it was ready (code 1)`.
     */
    it("refuses a good app that is not a git repository, before spawning", async () => {
      const dir = await fixture("no-git-app", {
        "package.json": JSON.stringify({
          dependencies: { vue: "^3.4.0" },
          devDependencies: { vite: "^5.0.0" },
        }),
        "vite.config.ts": "export default {}",
      })
      const { status, body } = await open(dir)

      expect(spawnStub).not.toHaveBeenCalled()
      expect(status).toBe(400)
      const blocked = body.blocked as { code: string; remediation: string[] }
      expect(blocked.code).toBe("not-a-git-repo")
      expect(blocked.remediation.join(" ")).toContain("git init")
    })

    it("still spawns for a repo the pre-check passes", async () => {
      spawnStub.mockImplementation(async (repoPath: string) => ({
        url: `http://127.0.0.1:9999/?opened=${encodeURIComponent(repoPath)}`,
      }))
      const dir = await fixture(
        "vue-vite-app",
        {
          "package.json": JSON.stringify({
            dependencies: { vue: "^3.4.0" },
            devDependencies: { vite: "^5.0.0" },
          }),
          "vite.config.ts": "export default {}",
        },
        { git: true },
      )
      const { status, body } = await open(dir)

      expect(status).toBe(200)
      expect(body.ok).toBe(true)
      expect(body.blocked).toBeUndefined()
      expect(spawnStub).toHaveBeenCalledWith(dir)
    })

    /**
     * The residue the pre-check cannot cover: detection passes, the boot fails
     * for a reason only booting reveals. "Exited before it was ready" is honest
     * HERE, because here it is genuinely unexplained.
     */
    it("keeps the spawn-exit fallback for a boot that fails after the pre-check passes", async () => {
      const dir = await fixture(
        "vue-vite-broken",
        {
          "package.json": JSON.stringify({
            dependencies: { vue: "^3.4.0" },
            devDependencies: { vite: "^5.0.0" },
          }),
          "vite.config.ts": "export default {}",
        },
        { git: true },
      )
      const { status, body } = await open(dir)

      expect(spawnStub).toHaveBeenCalledWith(dir)
      expect(status).toBe(500)
      expect(body.reason).toContain("exited before it was ready")
      expect(body.blocked).toBeUndefined()
    })

    /**
     * The other half of that residue, and the one that is NOT unexplained.
     *
     * MEASURED against a real launcher before this was wired: a repo given
     * `{"hosts":{"astro":true}}` — the line the `host-not-enabled` notice tells
     * the user to add — passed the pre-check, spawned, and the child printed
     * "This project declares Astro but astro is not installed." with two
     * numbered steps, exited 4, and the modal said `editor exited before it was
     * ready (code 4)`. The branch's own remediation walked the user back into
     * the defect the branch exists to remove.
     */
    it("surfaces the child's own explanation when a boot fails with one", async () => {
      const dir = await fixture(
        "astro-declared-not-installed",
        {
          "package.json": JSON.stringify({
            dependencies: { astro: "^5.0.0", react: "^19.0.0" },
          }),
          "astro.config.mjs": "export default {}",
          "desde.config.json": JSON.stringify({ hosts: { astro: true } }),
        },
        { git: true },
      )
      const childSaid =
        "This project declares Astro but astro is not installed.\n\n" +
        "Attach mode does not use this seam and covers Astro fully:\n" +
        "it runs this project's own dev server (npx astro dev) and connects to it."
      spawnStub.mockImplementation(async () => {
        throw new EditorBootFailure(4, childSaid)
      })

      const { status, body } = await open(dir)
      const blocked = body.blocked as Record<string, unknown> | undefined

      expect(spawnStub).toHaveBeenCalledWith(dir)
      expect(status).toBe(400)
      // The whole point: what the child said reaches the user.
      expect(blocked).toBeDefined()
      expect(blocked?.code).toBe("boot-failed")
      expect(blocked?.cause).toContain("astro is not installed")
      expect(blocked?.cause).toContain("npx astro dev")
      // And it still carries the inventory every other refusal carries.
      expect(Array.isArray(blocked?.supported)).toBe(true)
      expect((blocked?.remediation as string[]).length).toBeGreaterThan(0)
    })

    /**
     * The discriminator, stated as a test: a child that said NOTHING has
     * genuinely explained nothing, and must not be dressed up as though it
     * had. It keeps the bare exit code.
     */
    it("keeps the bare exit code when the child died silently", async () => {
      const dir = await fixture(
        "vue-vite-silent-death",
        {
          "package.json": JSON.stringify({
            dependencies: { vue: "^3.4.0" },
            devDependencies: { vite: "^5.0.0" },
          }),
          "vite.config.ts": "export default {}",
        },
        { git: true },
      )
      spawnStub.mockImplementation(async () => {
        throw new EditorBootFailure(1, "")
      })

      const { status, body } = await open(dir)

      expect(status).toBe(500)
      expect(body.reason).toContain("exited before it was ready (code 1)")
      expect(body.blocked).toBeUndefined()
    })
  })

  /**
   * The early check the New Project dialog runs on a resolved path, before it
   * walks the user through naming and design systems — both of which WRITE to
   * the repo.
   */
  describe("inspect", () => {
    async function inspect(dir: string): Promise<Record<string, unknown>> {
      const token = await tokenFromBootstrap()
      const res = await fetch(handle.url + "/api/launcher/inspect", {
        method: "POST",
        headers: authedHeaders(token),
        body: JSON.stringify({ path: dir }),
      })
      return (await res.json()) as Record<string, unknown>
    }

    it("rejects an unauthenticated request", async () => {
      const res = await fetch(handle.url + "/api/launcher/inspect", {
        method: "POST",
        headers: { "content-type": "application/json", origin: handle.url },
        body: JSON.stringify({ path: tmp }),
      })
      expect(res.status).toBe(401)
    })

    it("reports blocked: null for a repo that can be opened", async () => {
      const dir = path.join(tmp, "inspect-ok")
      await fs.mkdir(dir)
      await fs.writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ dependencies: { vue: "^3.4.0" }, devDependencies: { vite: "^5.0.0" } }),
      )
      await fs.writeFile(path.join(dir, "vite.config.ts"), "export default {}")
      await execFileAsync("git", ["-C", dir, "init", "-q"])
      expect(await inspect(dir)).toMatchObject({ ok: true, blocked: null })
    })

    it("reports the same structured refusal open would, without spawning", async () => {
      const dir = path.join(tmp, "inspect-blocked")
      await fs.mkdir(dir)
      const json = await inspect(dir)
      expect(json.ok).toBe(true)
      expect((json.blocked as { code: string }).code).toBe("framework-unsupported")
      expect(spawnStub).not.toHaveBeenCalled()
    })
  })

  it("rejects opening a non-directory", async () => {
    const token = await tokenFromBootstrap()
    const res = await fetch(handle.url + "/api/launcher/open", {
      method: "POST",
      headers: authedHeaders(token),
      body: JSON.stringify({ path: path.join(tmp, "does-not-exist") }),
    })
    expect(res.status).toBe(400)
    expect(spawnStub).not.toHaveBeenCalled()
  })

  it("rejects an unauthenticated pick-folder", async () => {
    const res = await fetch(handle.url + "/api/launcher/pick-folder", {
      method: "POST",
      headers: { "content-type": "application/json", origin: handle.url },
      body: "{}",
    })
    expect(res.status).toBe(401)
    expect(pickFolderStub).not.toHaveBeenCalled()
  })

  it("pick-folder returns the picked path", async () => {
    const token = await tokenFromBootstrap()
    const res = await fetch(handle.url + "/api/launcher/pick-folder", {
      method: "POST",
      headers: authedHeaders(token),
      body: "{}",
    })
    const json = await res.json()
    expect(json).toMatchObject({ ok: true, supported: true, path: "/picked/by/stub" })
  })

  it("pick-folder surfaces user cancel", async () => {
    pickFolderStub.mockImplementationOnce(async () => ({
      supported: true,
      canceled: true,
    }))
    const token = await tokenFromBootstrap()
    const res = await fetch(handle.url + "/api/launcher/pick-folder", {
      method: "POST",
      headers: authedHeaders(token),
      body: "{}",
    })
    const json = await res.json()
    expect(json).toMatchObject({ ok: true, supported: true, canceled: true })
    expect(json.path).toBeUndefined()
  })

  it("pick-folder reports unsupported platforms", async () => {
    pickFolderStub.mockImplementationOnce(async () => ({ supported: false }))
    const token = await tokenFromBootstrap()
    const res = await fetch(handle.url + "/api/launcher/pick-folder", {
      method: "POST",
      headers: authedHeaders(token),
      body: "{}",
    })
    const json = await res.json()
    expect(json).toMatchObject({ ok: true, supported: false })
  })

  /**
   * `purpose` picks between two fixed AppleScript prompt strings (see
   * `folder-picker.ts`); the route is a closed-set pass-through, not
   * free-text, so both directions — the recognized value forwarding, and
   * everything else collapsing to the default — need coverage.
   */
  describe("pick-folder purpose", () => {
    it("passes purpose:\"reference\" through to the picker", async () => {
      const token = await tokenFromBootstrap()
      const res = await fetch(handle.url + "/api/launcher/pick-folder", {
        method: "POST",
        headers: authedHeaders(token),
        body: JSON.stringify({ purpose: "reference" }),
      })
      expect(res.status).toBe(200)
      expect(pickFolderStub).toHaveBeenCalledWith("reference")
    })

    it("defaults to \"project\" when purpose is absent", async () => {
      const token = await tokenFromBootstrap()
      const res = await fetch(handle.url + "/api/launcher/pick-folder", {
        method: "POST",
        headers: authedHeaders(token),
        body: "{}",
      })
      expect(res.status).toBe(200)
      expect(pickFolderStub).toHaveBeenCalledWith("project")
    })

    it("defaults to \"project\" for an unrecognized purpose value", async () => {
      const token = await tokenFromBootstrap()
      const res = await fetch(handle.url + "/api/launcher/pick-folder", {
        method: "POST",
        headers: authedHeaders(token),
        body: JSON.stringify({ purpose: "bogus" }),
      })
      expect(res.status).toBe(200)
      expect(pickFolderStub).toHaveBeenCalledWith("project")
    })

    /**
     * Regression risk called out explicitly: the route used to read no
     * body at all, so a request with none must still succeed rather than
     * throwing out of `readJsonBody` uncaught.
     */
    it("still works when the request has no JSON body at all", async () => {
      const token = await tokenFromBootstrap()
      const res = await fetch(handle.url + "/api/launcher/pick-folder", {
        method: "POST",
        headers: authedHeaders(token),
      })
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json).toMatchObject({ ok: true, supported: true, path: "/picked/by/stub" })
      expect(pickFolderStub).toHaveBeenCalledWith("project")
    })
  })

  it("clones a repo then spawns an editor on it", async () => {
    // Build a local source repo to clone.
    const source = path.join(tmp, "source")
    await fs.mkdir(source)
    await execFileAsync("git", ["-C", source, "init", "-q"])
    await execFileAsync("git", ["-C", source, "config", "user.email", "t@t.dev"])
    await execFileAsync("git", ["-C", source, "config", "user.name", "T"])
    await fs.writeFile(path.join(source, "f.txt"), "x")
    // A repo the pre-check passes: the clone route gates the spawn exactly as
    // `open` does, so cloning something unbootable no longer reaches a child.
    await fs.writeFile(
      path.join(source, "package.json"),
      JSON.stringify({ dependencies: { vue: "^3.4.0" }, devDependencies: { vite: "^5.0.0" } }),
    )
    await fs.writeFile(path.join(source, "vite.config.ts"), "export default {}")
    await execFileAsync("git", ["-C", source, "add", "."])
    await execFileAsync("git", ["-C", source, "commit", "-q", "-m", "i"])

    const dest = path.join(tmp, "cloned")
    const token = await tokenFromBootstrap()
    const res = await fetch(handle.url + "/api/launcher/clone", {
      method: "POST",
      headers: authedHeaders(token),
      body: JSON.stringify({ repoUrl: source, dest }),
    })
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.dest).toBe(dest)
    expect(spawnStub).toHaveBeenCalledWith(dest)
    // The clone actually happened.
    expect(await fs.readFile(path.join(dest, "f.txt"), "utf-8")).toBe("x")
  })

  it("clones a repo without spawning when open:false (deferred-open flow)", async () => {
    const source = path.join(tmp, "source2")
    await fs.mkdir(source)
    await execFileAsync("git", ["-C", source, "init", "-q"])
    await execFileAsync("git", ["-C", source, "config", "user.email", "t@t.dev"])
    await execFileAsync("git", ["-C", source, "config", "user.name", "T"])
    await fs.writeFile(path.join(source, "f.txt"), "x")
    await execFileAsync("git", ["-C", source, "add", "f.txt"])
    await execFileAsync("git", ["-C", source, "commit", "-q", "-m", "i"])

    const dest = path.join(tmp, "cloned-deferred")
    const token = await tokenFromBootstrap()
    const res = await fetch(handle.url + "/api/launcher/clone", {
      method: "POST",
      headers: authedHeaders(token),
      body: JSON.stringify({ repoUrl: source, dest, open: false }),
    })
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.dest).toBe(dest)
    expect(json.url).toBeUndefined()
    expect(spawnStub).not.toHaveBeenCalled()
    expect(await fs.readFile(path.join(dest, "f.txt"), "utf-8")).toBe("x")
  })

  describe("design-systems/suggest", () => {
    it("rejects an unauthenticated request", async () => {
      const res = await fetch(handle.url + "/api/launcher/design-systems/suggest", {
        method: "POST",
        headers: { "content-type": "application/json", origin: handle.url },
        body: JSON.stringify({ path: tmp }),
      })
      expect(res.status).toBe(401)
    })

    it("rejects a non-directory path", async () => {
      const token = await tokenFromBootstrap()
      const res = await fetch(handle.url + "/api/launcher/design-systems/suggest", {
        method: "POST",
        headers: authedHeaders(token),
        body: JSON.stringify({ path: path.join(tmp, "does-not-exist") }),
      })
      expect(res.status).toBe(400)
    })

    it("returns suggestions for a fixture path with an installed + imported Vue lib", async () => {
      const fixture = path.join(tmp, "suggest-fixture")
      await fs.mkdir(path.join(fixture, "node_modules/@acme/ui/dist/types/components"), {
        recursive: true,
      })
      await fs.mkdir(path.join(fixture, "src"), { recursive: true })
      await fs.writeFile(
        path.join(fixture, "package.json"),
        JSON.stringify({ dependencies: { "@acme/ui": "^1.0.0" } }),
      )
      await fs.writeFile(
        path.join(fixture, "node_modules/@acme/ui/package.json"),
        JSON.stringify({ name: "@acme/ui", version: "1.0.0" }),
      )
      await fs.writeFile(
        path.join(fixture, "node_modules/@acme/ui/dist/types/components/AButton.vue.d.ts"),
        "export default {}",
      )
      await fs.writeFile(
        path.join(fixture, "src/App.vue"),
        "<script setup>\nimport { AButton } from '@acme/ui'\n</script>",
      )

      const token = await tokenFromBootstrap()
      const res = await fetch(handle.url + "/api/launcher/design-systems/suggest", {
        method: "POST",
        headers: authedHeaders(token),
        body: JSON.stringify({ path: fixture }),
      })
      const json = await res.json()
      expect(json.ok).toBe(true)
      expect(json.suggestions).toEqual([
        expect.objectContaining({ package: "@acme/ui", framework: "vue3", componentCount: 1 }),
      ])
    })
  })

  describe("design-systems/declare", () => {
    it("rejects an unauthenticated request", async () => {
      const res = await fetch(handle.url + "/api/launcher/design-systems/declare", {
        method: "POST",
        headers: { "content-type": "application/json", origin: handle.url },
        body: JSON.stringify({ path: tmp, declarations: [] }),
      })
      expect(res.status).toBe(401)
    })

    it("validates every entry to 400 and writes nothing on any invalid entry", async () => {
      const target = path.join(tmp, "declare-invalid")
      await fs.mkdir(target)
      const token = await tokenFromBootstrap()
      const res = await fetch(handle.url + "/api/launcher/design-systems/declare", {
        method: "POST",
        headers: authedHeaders(token),
        body: JSON.stringify({
          path: target,
          declarations: [
            { source: { kind: "installed", package: "@acme/design-system" } },
            { source: { kind: "weird" } },
          ],
        }),
      })
      expect(res.status).toBe(400)
      const configPath = path.join(target, "desde.config.json")
      await expect(fs.access(configPath)).rejects.toThrow()
    })

    it("appends valid declarations to the fixture config, reporting appended/skipped", async () => {
      const target = path.join(tmp, "declare-target")
      await fs.mkdir(target)
      await fs.writeFile(
        path.join(target, "desde.config.json"),
        `${JSON.stringify(
          { designSystems: [{ kind: "installed", package: "@acme/design-system" }] },
          null,
          2,
        )}\n`,
      )

      const token = await tokenFromBootstrap()
      const res = await fetch(handle.url + "/api/launcher/design-systems/declare", {
        method: "POST",
        headers: authedHeaders(token),
        body: JSON.stringify({
          path: target,
          declarations: [
            // Duplicate identity of the existing entry — should be skipped.
            { source: { kind: "installed", package: "@acme/design-system" } },
            { source: { kind: "npm", spec: "@acme/ds@^2" } },
          ],
        }),
      })
      const json = await res.json()
      expect(json.ok).toBe(true)
      expect(json.appended).toHaveLength(1)
      expect(json.appended[0]).toMatchObject({ source: { kind: "npm", spec: "@acme/ds@^2" } })
      expect(json.skipped).toHaveLength(1)

      const config = JSON.parse(
        await fs.readFile(path.join(target, "desde.config.json"), "utf-8"),
      )
      expect(config.designSystems).toEqual([
        { kind: "installed", package: "@acme/design-system" },
        { kind: "npm", spec: "@acme/ds@^2" },
      ])
    })
  })

  /**
   * The read-only half of the reference-directories wizard: tells the
   * caller whether a picked folder is usable BEFORE the declare step
   * writes it. Mirrors `design-systems/suggest`'s role in that pair.
   */
  describe("read-roots/inspect", () => {
    async function inspect(
      body: Record<string, unknown>,
    ): Promise<{ status: number; body: Record<string, unknown> }> {
      const token = await tokenFromBootstrap()
      const res = await fetch(handle.url + "/api/launcher/read-roots/inspect", {
        method: "POST",
        headers: authedHeaders(token),
        body: JSON.stringify(body),
      })
      return { status: res.status, body: (await res.json()) as Record<string, unknown> }
    }

    it("rejects an unauthenticated request", async () => {
      const res = await fetch(handle.url + "/api/launcher/read-roots/inspect", {
        method: "POST",
        headers: { "content-type": "application/json", origin: handle.url },
        body: JSON.stringify({ path: tmp }),
      })
      expect(res.status).toBe(401)
    })

    it("rejects a missing path", async () => {
      const { status, body } = await inspect({})
      expect(status).toBe(400)
      expect(body.ok).toBe(false)
    })

    it("rejects a path that is not a directory", async () => {
      const { status, body } = await inspect({ path: path.join(tmp, "does-not-exist") })
      expect(status).toBe(400)
      expect(body.ok).toBe(false)
    })

    it("reports path, a suggestedName, and isGit:true for a real git repo", async () => {
      const dir = path.join(tmp, "inspect-git-repo")
      await fs.mkdir(dir)
      await execFileAsync("git", ["-C", dir, "init", "-q"])
      const { status, body } = await inspect({ path: dir })
      expect(status).toBe(200)
      expect(body).toMatchObject({ ok: true, path: dir, isGit: true })
      expect(typeof body.suggestedName).toBe("string")
      expect((body.suggestedName as string).length).toBeGreaterThan(0)
    })

    it("reports isGit:false for a plain (non-git) directory", async () => {
      const dir = path.join(tmp, "inspect-plain-dir")
      await fs.mkdir(dir)
      const { status, body } = await inspect({ path: dir })
      expect(status).toBe(200)
      expect(body).toMatchObject({ ok: true, isGit: false })
    })

    it("derives suggestedName from the folder basename, avoiding names already taken", async () => {
      const dir = path.join(tmp, "Billing Web")
      await fs.mkdir(dir)
      const first = await inspect({ path: dir })
      expect(first.body.suggestedName).toBe("billing-web")

      const second = await inspect({ path: dir, taken: ["billing-web"] })
      expect(second.body.suggestedName).toBe("billing-web-2")
    })
  })

  /**
   * The write half. Same two-tier contract as `design-systems/declare`:
   * a malformed entry 400s the whole batch before any write, a name
   * collision is reported as `skipped` rather than an error.
   */
  describe("read-roots/declare", () => {
    it("rejects an unauthenticated request", async () => {
      const res = await fetch(handle.url + "/api/launcher/read-roots/declare", {
        method: "POST",
        headers: { "content-type": "application/json", origin: handle.url },
        body: JSON.stringify({ path: tmp, declarations: [] }),
      })
      expect(res.status).toBe(401)
    })

    it("rejects declarations that are not an array", async () => {
      const target = path.join(tmp, "read-roots-declare-not-array")
      await fs.mkdir(target)
      const token = await tokenFromBootstrap()
      const res = await fetch(handle.url + "/api/launcher/read-roots/declare", {
        method: "POST",
        headers: authedHeaders(token),
        body: JSON.stringify({ path: target, declarations: "nope" }),
      })
      expect(res.status).toBe(400)
    })

    it("validates every entry to 400 and writes nothing on any invalid entry", async () => {
      const target = path.join(tmp, "read-roots-declare-invalid")
      await fs.mkdir(target)
      const token = await tokenFromBootstrap()
      const res = await fetch(handle.url + "/api/launcher/read-roots/declare", {
        method: "POST",
        headers: authedHeaders(token),
        body: JSON.stringify({
          path: target,
          declarations: [
            { name: "prod-app", path: "/some/path" },
            // Invalid: uppercase fails READ_ROOT_NAME_RE.
            { name: "Bad Name!", path: "/other/path" },
          ],
        }),
      })
      expect(res.status).toBe(400)
      const configPath = path.join(target, "desde.config.json")
      await expect(fs.access(configPath)).rejects.toThrow()
    })

    it("400s a batch naming the same root twice, writing nothing", async () => {
      const target = path.join(tmp, "read-roots-declare-dup-in-batch")
      await fs.mkdir(target)
      const token = await tokenFromBootstrap()
      const res = await fetch(handle.url + "/api/launcher/read-roots/declare", {
        method: "POST",
        headers: authedHeaders(token),
        body: JSON.stringify({
          path: target,
          declarations: [
            { name: "prod-app", path: "/some/path" },
            { name: "prod-app", path: "/other/path" },
          ],
        }),
      })
      expect(res.status).toBe(400)
      const json = (await res.json()) as { reason: string }
      expect(json.reason).toMatch(/duplicate name/)
      const configPath = path.join(target, "desde.config.json")
      await expect(fs.access(configPath)).rejects.toThrow()
    })

    it("400s a declaration pointing at the project's own folder, writing nothing", async () => {
      const target = path.join(tmp, "read-roots-declare-self-ref")
      await fs.mkdir(target)
      const token = await tokenFromBootstrap()
      const res = await fetch(handle.url + "/api/launcher/read-roots/declare", {
        method: "POST",
        headers: authedHeaders(token),
        body: JSON.stringify({
          path: target,
          declarations: [{ name: "self", path: target }],
        }),
      })
      expect(res.status).toBe(400)
      expect((await res.json()).reason).toMatch(/own folder/)
      // Writing it would have made the project refuse to boot.
      await expect(
        fs.access(path.join(target, "desde.config.json")),
      ).rejects.toThrow()
    })

    it("writes readRoots into the config file, matching exactly what's read back", async () => {
      const target = path.join(tmp, "read-roots-declare-target")
      await fs.mkdir(target)
      // A real directory: declare validates the filesystem before writing, so
      // a fictional path is now refused (it would be fatal at the next boot).
      const prodApp = path.join(tmp, "read-roots-declare-prod-app")
      await fs.mkdir(prodApp, { recursive: true })
      const token = await tokenFromBootstrap()
      const res = await fetch(handle.url + "/api/launcher/read-roots/declare", {
        method: "POST",
        headers: authedHeaders(token),
        body: JSON.stringify({
          path: target,
          declarations: [{ name: "prod-app", path: prodApp, description: "The prod app" }],
        }),
      })
      const json = await res.json()
      expect(json.ok).toBe(true)
      expect(json.appended).toHaveLength(1)
      expect(json.skipped).toHaveLength(0)

      const configPath = path.join(target, "desde.config.json")
      const config = JSON.parse(await fs.readFile(configPath, "utf-8"))
      expect(config).toEqual({
        readRoots: {
          "prod-app": { path: prodApp, description: "The prod app" },
        },
      })
    })

    it("400s a batch containing an already-used name, writing NOTHING", async () => {
      const target = path.join(tmp, "read-roots-declare-skip-existing")
      await fs.mkdir(target)
      const prodApp = path.join(tmp, "rr-skip-prod-app")
      const prodApp2 = path.join(tmp, "rr-skip-prod-app-2")
      const docsSite = path.join(tmp, "rr-skip-docs-site")
      for (const dir of [prodApp, prodApp2, docsSite]) {
        await fs.mkdir(dir, { recursive: true })
      }
      await fs.writeFile(
        path.join(target, "desde.config.json"),
        `${JSON.stringify({ readRoots: { "prod-app": { path: prodApp } } }, null, 2)}\n`,
      )

      const token = await tokenFromBootstrap()
      const res = await fetch(handle.url + "/api/launcher/read-roots/declare", {
        method: "POST",
        headers: authedHeaders(token),
        body: JSON.stringify({
          path: target,
          declarations: [
            // Collides with the entry already in the file.
            { name: "prod-app", path: prodApp2 },
            { name: "docs-site", path: docsSite },
          ],
        }),
      })
      expect(res.status).toBe(400)
      const json = await res.json()
      expect(json.ok).toBe(false)
      expect(json.reason).toMatch(/already has a reference folder named/)
      expect(json.collisions).toEqual(["prod-app"])

      const config = JSON.parse(
        await fs.readFile(path.join(target, "desde.config.json"), "utf-8"),
      )
      // The pre-existing entry is untouched, and the NON-colliding entry was
      // not written either. All-or-nothing: the client keeps every chip on a
      // failure, so a partial write would make rename-and-retry collide with
      // what the first attempt had already persisted.
      expect(config.readRoots["prod-app"]).toEqual({ path: prodApp })
      expect(config.readRoots["docs-site"]).toBeUndefined()
    })

    it("preserves unrelated pre-existing keys in the config file", async () => {
      const target = path.join(tmp, "read-roots-declare-preserve-keys")
      await fs.mkdir(target)
      await fs.writeFile(
        path.join(target, "desde.config.json"),
        `${JSON.stringify(
          { designSystems: [{ kind: "installed", package: "@acme/ui" }] },
          null,
          2,
        )}\n`,
      )

      const prodApp = path.join(tmp, "rr-preserve-prod-app")
      await fs.mkdir(prodApp, { recursive: true })
      const token = await tokenFromBootstrap()
      await fetch(handle.url + "/api/launcher/read-roots/declare", {
        method: "POST",
        headers: authedHeaders(token),
        body: JSON.stringify({
          path: target,
          declarations: [{ name: "prod-app", path: prodApp }],
        }),
      })

      const config = JSON.parse(
        await fs.readFile(path.join(target, "desde.config.json"), "utf-8"),
      )
      expect(config.designSystems).toEqual([{ kind: "installed", package: "@acme/ui" }])
      expect(config.readRoots["prod-app"]).toEqual({ path: prodApp })
    })
  })
})

/**
 * The Anthropic API key dialog opens from the launcher's settings gear as
 * well as the editor's, and the hook behind it polls
 * `/api/editor/llm-credentials` on mount. Until 2026-09-02 the launcher had
 * no such route, so the request fell through to the static bundle's SPA
 * fallback: a 200 carrying `index.html`, which the hook then tried to parse
 * as JSON. The dialog opened already showing "Unexpected token '<'" with
 * nothing typed. These pin both halves: the route answers JSON, and no other
 * `/api/*` path can ever fall through to HTML again.
 */
describe("launcher server — LLM credentials", () => {
  it("answers the credentials status as JSON, not the SPA fallback", async () => {
    const token = await tokenFromBootstrap()
    const res = await fetch(handle.url + "/api/editor/llm-credentials", {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    const body = (await res.json()) as { source: string; devMode: boolean }
    expect(typeof body.source).toBe("string")
    expect(typeof body.devMode).toBe("boolean")
  })

  it("refuses an unauthenticated credential write", async () => {
    const res = await fetch(handle.url + "/api/editor/llm-credentials", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-ant-nope" }),
    })
    // 403 today: the strict-origin check runs before the bearer check and this
    // request carries neither. Either refusal is the point, so the assertion
    // does not pin their order.
    expect([401, 403]).toContain(res.status)
    // JSON, not "method not allowed" text: the hook reads `error` off it.
    expect(res.headers.get("content-type")).toContain("application/json")
  })

  it("answers an unknown /api path with a JSON 404 rather than index.html", async () => {
    const token = await tokenFromBootstrap()
    const res = await fetch(handle.url + "/api/editor/does-not-exist", {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(404)
    expect(res.headers.get("content-type")).toContain("application/json")
  })
})
