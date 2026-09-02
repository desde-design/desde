import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { newSecurityContext } from "../auth.js"

/**
 * Dormant SURFACES (in-app code view, Notes), asserted through the REAL HTTP
 * routes. Sibling of `http-server-dormant-lanes.integration.test.ts`, and it
 * exists for the same reason that one does.
 *
 * `dormant-surfaces.test.ts` proves the gate as a function. This proves the
 * gate is CONNECTED. A pure-function assertion passes identically whether or
 * not anything threads the value into it, so both ends are exercised here over
 * a socket, exactly as the shell and a stale client reach them:
 *
 *   · `/__desde/bootstrap.js` — what the UI reads to decide what to offer
 *   · `GET /api/editor/file`       — the code view's read route
 *   · `/api/editor/notes/*`        — the Notes store, read AND write
 *   · `/api/editor/canvases/*`     — the canvas store, read AND write
 *   · `/api/editor/screenshot-plans/*` — plan storage, read AND write
 *
 * Every case is PAIRED: the dormant half proves the refusal names the config
 * key, and the opted-in twin proves the very same request then succeeds. The
 * pair is what separates "gated" from "broken" — a route that 403s in both
 * halves would pass the first assertion on its own.
 */

let handle: HttpServerHandle
let bundleDir: string
let repoDir: string
let shellOrigin: string
let token: string

/**
 * Both surfaces also accept an env-var escape hatch. A developer with either
 * exported would otherwise silently flip this file's default half green, so
 * clear them per test and restore afterwards.
 */
// EDITOR_CANVAS belongs here for two reasons, not one: a test that sets it
// must not leak it into the next case, AND every "dormant by default" case
// above is only meaningful if an ambient value from the developer's own shell
// has been cleared first. Miss the second and these tests pass or fail
// depending on whose machine runs them.
const ENV_KEYS = ["EDITOR_CODE_VIEW", "EDITOR_NOTES", "EDITOR_CANVAS"] as const
const savedEnv = new Map<string, string | undefined>()

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
})

async function pickFreePort(): Promise<number> {
  const net = await import("node:net")
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      server.close(() => resolve(port))
    })
  })
}

type EditorConfig = { codeView?: boolean; notes?: boolean; canvas?: boolean }

async function boot(editor?: EditorConfig): Promise<void> {
  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>t</title>")
  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-surfaces-repo-"))
  await writeFile(
    join(repoDir, "App.vue"),
    "<template>\n  <div>hello</div>\n</template>\n",
  )
  const port = await pickFreePort()
  shellOrigin = `http://127.0.0.1:${port}`
  const security = newSecurityContext(shellOrigin)
  token = security.token
  handle = await startHttpServer({
    host: "127.0.0.1",
    port,
    repoRoot: repoDir,
    uiBundleRoot: bundleDir,
    viteUrl: "http://localhost:5173",
    security,
    ...(editor ? { editor } : {}),
  })
}

afterEach(async () => {
  await handle?.close()
  await rm(bundleDir, { recursive: true, force: true })
  await rm(repoDir, { recursive: true, force: true })
  for (const key of ENV_KEYS) {
    const was = savedEnv.get(key)
    if (was === undefined) delete process.env[key]
    else process.env[key] = was
  }
  savedEnv.clear()
})

async function readBootstrapPayload(): Promise<Record<string, unknown>> {
  const res = await fetch(`${shellOrigin}/__desde/bootstrap.js`)
  const jsonText = (await res.text())
    .trim()
    .replace(/^window\.__DESDE_CLI__=/, "")
    .replace(/;$/, "")
  return JSON.parse(jsonText) as Record<string, unknown>
}

interface ApiResult {
  status: number
  json: { ok?: boolean; reason?: string; notes?: unknown[]; content?: string }
}

async function get(path: string): Promise<ApiResult> {
  const res = await fetch(`${shellOrigin}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return { status: res.status, json: (await res.json()) as ApiResult["json"] }
}

async function post(path: string, body: unknown): Promise<ApiResult> {
  const res = await fetch(`${shellOrigin}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: shellOrigin,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as ApiResult["json"] }
}

const NEW_NOTE = {
  body: "a note",
  position: { anchorSelector: "div", page: "/" },
  author: { uid: "u1", displayName: "Tester", email: "", photoURL: "" },
}

describe("dormant surfaces over HTTP — default (nothing opted in)", () => {
  it("the bootstrap tells the shell both surfaces are off", async () => {
    await boot()
    const payload = await readBootstrapPayload()
    expect(payload.codeView).toBe(false)
    expect(payload.notes).toBe(false)
  })

  it("GET /api/editor/file refuses, naming editor.codeView", async () => {
    await boot()
    const { status, json } = await get(
      "/api/editor/file?path=" + encodeURIComponent("App.vue"),
    )
    expect(status).toBe(403)
    expect(json.ok).toBe(false)
    expect(json.reason).toContain("codeView")
    // The file that WOULD have been read must not leak through the refusal.
    expect(json.content).toBeUndefined()
  })

  it("GET /api/editor/notes refuses, naming editor.notes", async () => {
    await boot()
    const { status, json } = await get("/api/editor/notes")
    expect(status).toBe(403)
    expect(json.ok).toBe(false)
    expect(json.reason).toContain("notes")
    expect(json.notes).toBeUndefined()
  })

  it("POST /api/editor/notes refuses too, so the write half is closed", async () => {
    // The read and write slices are separate route entries with different auth
    // policies. Gating one and not the other is the exact drift this pair of
    // assertions exists to catch.
    await boot()
    const { status, json } = await post("/api/editor/notes", NEW_NOTE)
    expect(status).toBe(403)
    expect(json.ok).toBe(false)
    expect(json.reason).toContain("notes")
  })

  it("GET /api/editor/canvases refuses, naming editor.canvas", async () => {
    // The canvas surface went dormant 2026-08-04, but its routes stayed open
    // until 2026-09-01: 17 canvas endpoints and 8 screenshot-plan ones,
    // create/patch/delete included, all answering with the surface off. This
    // is the read half of closing that.
    await boot()
    const { status, json } = await get("/api/editor/canvases")
    expect(status).toBe(403)
    expect(json.ok).toBe(false)
    expect(json.reason).toContain("canvas")
  })

  it("POST /api/editor/canvases refuses too, so the write half is closed", async () => {
    await boot()
    const { status, json } = await post("/api/editor/canvases", { name: "n" })
    expect(status).toBe(403)
    expect(json.ok).toBe(false)
    expect(json.reason).toContain("canvas")
  })

  it("GET /api/editor/screenshot-plans refuses, the surface's other route family", async () => {
    // Two route families, one surface. Gating only the canvases half would
    // have left plan creation and route-enumeration reachable.
    await boot()
    const { status, json } = await get("/api/editor/screenshot-plans")
    expect(status).toBe(403)
    expect(json.ok).toBe(false)
    expect(json.reason).toContain("canvas")
  })

  it("POST /api/editor/screenshot-plans refuses too", async () => {
    await boot()
    const { status, json } = await post("/api/editor/screenshot-plans", { name: "n" })
    expect(status).toBe(403)
    expect(json.ok).toBe(false)
    expect(json.reason).toContain("canvas")
  })

  it("leaves the layers panel's file reads working", async () => {
    // `handleConditionalGroupsRoute` calls the same `readPrototypeFile` the
    // code view does. The gate is on the ROUTE for exactly this reason, so a
    // dormant code view must not take the layers panel down with it.
    await boot()
    const { status } = await get(
      "/api/editor/conditional-groups?file=" + encodeURIComponent("App.vue"),
    )
    expect(status).toBe(200)
  })
})

describe("dormant surfaces over HTTP — opted in", () => {
  it("the bootstrap reports exactly the opted-in surface, per surface", async () => {
    await boot({ codeView: true })
    const payload = await readBootstrapPayload()
    expect(payload.codeView).toBe(true)
    expect(payload.notes).toBe(false)
  })

  it("the same file request now reads the file", async () => {
    await boot({ codeView: true })
    const { status, json } = await get(
      "/api/editor/file?path=" + encodeURIComponent("App.vue"),
    )
    // Load-bearing: not merely "a different refusal". The route runs.
    expect(status).toBe(200)
    expect(json.ok).toBe(true)
    expect(json.content).toContain("hello")
  })

  it("the same notes requests now reach the store", async () => {
    await boot({ notes: true })
    expect((await readBootstrapPayload()).notes).toBe(true)
    const created = await post("/api/editor/notes", NEW_NOTE)
    expect(created.status).toBe(201)
    const listed = await get("/api/editor/notes")
    expect(listed.status).toBe(200)
    expect(listed.json.notes).toHaveLength(1)
  })

  it("the same canvas requests now reach the store", async () => {
    await boot({ canvas: true })
    const created = await post("/api/editor/canvases", { name: "A canvas" })
    // Load-bearing: the route RUNS, rather than merely refusing differently.
    expect(created.status).toBe(201)
    const listed = await get("/api/editor/canvases")
    expect(listed.status).toBe(200)
  })

  it("opting canvas in does not open the other dormant surfaces", async () => {
    // One flag, one surface. A shared refusal helper is exactly where a
    // gate can accidentally become an all-or-nothing switch.
    await boot({ canvas: true })
    expect((await get("/api/editor/canvases")).status).toBe(200)
    expect((await get("/api/editor/notes")).status).toBe(403)
    expect(
      (await get("/api/editor/file?path=" + encodeURIComponent("App.vue"))).status,
    ).toBe(403)
  })

  it("EDITOR_CANVAS=1 alone opens the canvas routes", async () => {
    process.env.EDITOR_CANVAS = "1"
    await boot()
    expect((await get("/api/editor/canvases")).status).toBe(200)
  })

  it("the env var alone opens a surface, matching EDITOR_CANVAS", async () => {
    process.env.EDITOR_NOTES = "1"
    await boot()
    expect((await readBootstrapPayload()).notes).toBe(true)
    expect((await get("/api/editor/notes")).status).toBe(200)
  })
})
