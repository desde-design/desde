import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { newSecurityContext } from "../auth.js"
import type { DormantLaneId } from "../enabled-lanes.js"

/**
 * Dormant lanes, asserted through the REAL HTTP routes.
 *
 * `dormant-lanes.test.ts` proves the gate as a function; this proves the gate
 * is CONNECTED. That distinction has cost this branch four green-but-meaningless
 * results already: a pure-function assertion passes identically whether or not
 * anything threads the value into it, so the offering and the two dispatch
 * surfaces are exercised here over a socket, exactly as the shell and a stale
 * client reach them.
 *
 * Three routes, because a dormant lane has three ways out:
 *   · `/__desde/bootstrap.js` — what the UI reads to decide what to offer
 *   · `POST /api/editor/edit`      — the deterministic dispatcher
 *   · `POST /api/editor/llm-fallback` — the repair lane, which takes the same
 *     `intent.kind` and rewrites the whole file
 */

let handle: HttpServerHandle
let bundleDir: string
let repoDir: string
let shellOrigin: string
let token: string

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

async function boot(enabledLanes?: ReadonlySet<DormantLaneId>): Promise<void> {
  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>t</title>")
  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-lanes-repo-"))
  await writeFile(
    join(repoDir, "App.vue"),
    "<template>\n  <Card />\n</template>\n",
  )
  await writeFile(
    join(repoDir, "Card.vue"),
    '<template>\n  <div class="card">body</div>\n</template>\n',
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
    ...(enabledLanes ? { enabledLanes } : {}),
  })
}

afterEach(async () => {
  await handle?.close()
  await rm(bundleDir, { recursive: true, force: true })
  await rm(repoDir, { recursive: true, force: true })
})

async function readBootstrapPayload(): Promise<Record<string, unknown>> {
  const res = await fetch(`${shellOrigin}/__desde/bootstrap.js`)
  const jsonText = (await res.text())
    .trim()
    .replace(/^window\.__DESDE_CLI__=/, "")
    .replace(/;$/, "")
  return JSON.parse(jsonText) as Record<string, unknown>
}

async function post(
  path: string,
  body: unknown,
): Promise<{ status: number; json: { ok?: boolean; reason?: string } }> {
  const res = await fetch(`${shellOrigin}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: shellOrigin,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as { ok?: boolean; reason?: string } }
}

const DETACH = {
  edit: {
    kind: "detach",
    file: "App.vue",
    line: 2,
    column: 3,
    componentFile: "Card.vue",
    componentName: "Card",
  },
}

describe("dormant lanes over HTTP — default (nothing opted in)", () => {
  it("the bootstrap tells the shell both lanes are off", async () => {
    await boot()
    expect((await readBootstrapPayload()).lanes).toEqual({
      detach: false,
      swap: false,
    })
  })

  it("POST /api/editor/edit refuses a detach 400, naming the config key", async () => {
    await boot()
    const { status, json } = await post("/api/editor/edit", DETACH)
    expect(status).toBe(400)
    expect(json.ok).toBe(false)
    expect(json.reason).toContain("lanes.detach")
  })

  it("POST /api/editor/llm-fallback refuses the same kind 400", async () => {
    await boot()
    const { status, json } = await post("/api/editor/llm-fallback", {
      file: "App.vue",
      intent: { kind: "swap", description: "swap it" },
      errorReason: "applicator refused",
    })
    expect(status).toBe(400)
    expect(json.ok).toBe(false)
    expect(json.reason).toContain("lanes.swap")
  })
})

describe("dormant lanes over HTTP — opted in", () => {
  it("the bootstrap reports exactly the opted-in lane, per-lane", async () => {
    await boot(new Set<DormantLaneId>(["detach"]))
    expect((await readBootstrapPayload()).lanes).toEqual({
      detach: true,
      swap: false,
    })
  })

  it("the same detach request now reaches the applicator and applies", async () => {
    await boot(new Set<DormantLaneId>(["detach"]))
    const { status, json } = await post("/api/editor/edit", DETACH)
    // Load-bearing: not merely "a different refusal". The lane runs.
    expect(status).toBe(200)
    expect(json.ok).toBe(true)
  })
})
