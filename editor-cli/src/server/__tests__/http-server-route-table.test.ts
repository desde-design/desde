import { afterAll, beforeAll, describe, it, expect } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { request as httpRequest, type IncomingMessage } from "node:http"
import {
  ROUTE_TABLE,
  resolveRoute,
  startHttpServer,
  type AuthPolicy,
  type HttpServerHandle,
  type RouteEntry,
} from "../http-server.js"
import { newSecurityContext } from "../auth.js"
import { allowedHostValues, checkHost } from "../host-guard.js"
import { pickFreePort } from "../launcher-server.js"

/**
 * Audit Task 24 — guardrails on the declarative route table.
 *
 * `routeRequest` used to be a ~1000-line sequential if-chain with auth checked
 * in-band: a hand-maintained ~20-entry "read-only GET" allowlist decided,
 * before dispatch, whether a request got the strict or the lenient Origin
 * policy. Adding a route was a two-place edit, and forgetting the second place
 * silently changed a route's security posture.
 *
 * These tests are the net that makes the table self-enforcing:
 *   1. No route under `/api/` or `/mcp/` may be unauthenticated, and the
 *      posture must be declared on the entry itself (no inherited default).
 *   2. Public (`authPolicy: "none"`) routes are a closed, enumerated set.
 *   3. `(method, path)` is unique — no shadowed duplicate entries.
 *   4. The order-sensitive neighbours documented on `ROUTE_TABLE` hold.
 *   5. Every path from the pre-refactor allowlist still resolves to the SAME
 *      auth posture it had in the if-chain (behavior-identical bar).
 *   6. Security audit B10 — the DNS-rebinding `Host` guard applies to EVERY
 *      route in the table, including the `authPolicy: "none"` ones. That last
 *      part is the whole point, so it is asserted against a real booted
 *      server rather than against `resolveRoute` (which cannot see it).
 */

const BEARER_POLICIES: AuthPolicy[] = [
  "bearer-origin-if-present",
  "bearer-origin-required",
]

/**
 * The complete set of routes that answer without any credential. Every one of
 * these must be reachable BEFORE the UI holds a token (or is loaded by the
 * prototype iframe, which never holds one). Adding to this list is a security
 * decision — that's the point of enumerating it here.
 */
const PUBLIC_ROUTES = [
  { method: "ANY", path: "/vendor/html2canvas.min.js" },
  { method: "GET", path: "/__desde/bootstrap.js" },
  { method: "GET", path: "/*" },
]

const ALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]

/** Paths that no table descriptor spells out, probed to close blind spots. */
const FIXED_PATH_PROBES = [
  "/api/",
  "/api/x",
  "/api/editor",
  "/api/editor/",
  "/api/editor/unknown",
  "/api/editor/design-systems/updates",
  "/api/editor/drift/KButton",
  "/api/editor/comments/c1/replies",
  "/api/editor/chat/sessions/",
  "/mcp/",
  "/mcp/unknown",
]

/** Turn a route descriptor into a concrete pathname a request could carry. */
function concretize(descriptor: string): string {
  return descriptor.replace(/:id/g, "abc123").replace(/\*+/g, "x")
}

function indexOfEntry(predicate: (e: RouteEntry) => boolean): number {
  return ROUTE_TABLE.findIndex(predicate)
}

function entryAt(method: string, path: string): number {
  return indexOfEntry((e) => e.method === method && e.path === path)
}

describe("route table — auth posture is explicit", () => {
  it("declares an authPolicy on every entry (own property, no default)", () => {
    for (const entry of ROUTE_TABLE) {
      expect(
        Object.prototype.hasOwnProperty.call(entry, "authPolicy"),
        `route ${entry.method} ${entry.path} has no own authPolicy`,
      ).toBe(true)
      expect([...BEARER_POLICIES, "none"]).toContain(entry.authPolicy)
    }
  })

  it("never leaves an /api/ or /mcp/ route open", () => {
    const open = ROUTE_TABLE.filter(
      (e) =>
        (e.path.startsWith("/api/") || e.path.startsWith("/mcp/")) &&
        !BEARER_POLICIES.includes(e.authPolicy),
    ).map((e) => `${e.method} ${e.path}`)
    expect(open).toEqual([])
  })

  /**
   * The check above keys on the DESCRIPTOR string, which a matcher-based entry
   * could evade by declaring a `path` that doesn't reflect what `match` really
   * accepts (e.g. `path: "/internal"` with `match: (p) => p.startsWith("/api/")`).
   * Pin the descriptor to the matcher so the descriptor-keyed checks — and the
   * order assertions further down, which are all descriptor-keyed — stay honest.
   */
  it("gives every matcher-based entry a descriptor its own matcher accepts", () => {
    for (const entry of ROUTE_TABLE) {
      if (!entry.match) continue
      const concrete = concretize(entry.path)
      expect(
        entry.match(concrete),
        `descriptor ${entry.path} does not reflect its matcher (rejected ${concrete})`,
      ).toBe(true)
    }
  })

  /**
   * Descriptor-independent backstop for the same loophole: probe the real
   * resolver with concrete paths across every method and assert nothing under
   * `/api/` or `/mcp/` ever resolves to an unauthenticated route. Probes are
   * derived FROM the table (so new routes are covered automatically) plus a
   * fixed representative set.
   */
  it("resolves no /api/ or /mcp/ path to an unauthenticated route", () => {
    const derived = ROUTE_TABLE.map((e) => concretize(e.path))
    const probes = [...new Set([...derived, ...FIXED_PATH_PROBES])].filter(
      (p) => p.startsWith("/api/") || p.startsWith("/mcp/"),
    )
    const open: string[] = []
    for (const method of ALL_METHODS) {
      for (const path of probes) {
        const entry = resolveRoute(method, path)
        if (entry && entry.authPolicy === "none") open.push(`${method} ${path}`)
      }
    }
    expect(open).toEqual([])
  })

  it("keeps the unauthenticated surface to the enumerated public routes", () => {
    const publicEntries = ROUTE_TABLE.filter((e) => e.authPolicy === "none").map(
      (e) => ({ method: e.method, path: e.path }),
    )
    expect(publicEntries).toEqual(PUBLIC_ROUTES)
  })

  it("has no duplicate (method, path) entries", () => {
    const seen = new Set<string>()
    const dupes: string[] = []
    for (const entry of ROUTE_TABLE) {
      const key = `${entry.method} ${entry.path}`
      if (seen.has(key)) dupes.push(key)
      seen.add(key)
    }
    expect(dupes).toEqual([])
  })
})

describe("route table — order-sensitive neighbours", () => {
  it("puts GET /mcp/status ahead of the /mcp/* catch-all", () => {
    expect(entryAt("GET", "/mcp/status")).toBeLessThan(entryAt("ANY", "/mcp/*"))
  })

  it("puts the if-present /api/ escapes ahead of every strict /api/ entry", () => {
    const firstStrictApi = indexOfEntry(
      (e) =>
        e.path.startsWith("/api/") && e.authPolicy === "bearer-origin-required",
    )
    expect(entryAt("POST", "/api/editor/mcp/tool/*")).toBeLessThan(firstStrictApi)
    expect(entryAt("GET", "/api/editor/shell-bridge/poll")).toBeLessThan(
      firstStrictApi,
    )
  })

  it("puts the exact chat-sessions list ahead of the sessions/:id prefix routes", () => {
    const list = entryAt("GET", "/api/editor/chat/sessions")
    const lockEvents = entryAt("GET", "/api/editor/chat/sessions/:id/lock-events")
    const detail = entryAt("GET", "/api/editor/chat/sessions/:id")
    expect(list).toBeLessThan(lockEvents)
    expect(lockEvents).toBeLessThan(detail)
  })

  it("puts each prefix route's if-present GET slice ahead of its ANY sibling", () => {
    for (const path of [
      "/api/editor/comments/*",
      "/api/editor/notes/*",
      "/api/editor/screenshot-plans/*",
      "/api/editor/canvases/*",
    ]) {
      const get = entryAt("GET", path)
      const any = entryAt("ANY", path)
      expect(get, `missing GET slice for ${path}`).toBeGreaterThanOrEqual(0)
      expect(any, `missing ANY sibling for ${path}`).toBeGreaterThanOrEqual(0)
      expect(get).toBeLessThan(any)
    }
    expect(entryAt("GET", "/api/editor/design-systems")).toBeLessThan(
      entryAt("ANY", "/api/editor/design-systems/*"),
    )
    expect(entryAt("GET", "/api/editor/design-systems/suggestions")).toBeLessThan(
      entryAt("ANY", "/api/editor/design-systems/*"),
    )
    expect(entryAt("GET", "/api/editor/drift")).toBeLessThan(
      entryAt("ANY", "/api/editor/drift/*"),
    )
  })

  it("puts the /api/* 404 fallback ahead of the static catch-all, which is last", () => {
    expect(entryAt("ANY", "/api/*")).toBeLessThan(entryAt("GET", "/*"))
    expect(entryAt("GET", "/*")).toBe(ROUTE_TABLE.length - 1)
  })

  /**
   * The `ANY /api/*` terminal matches every remaining `/api/` path, so any route
   * appended AFTER it is unreachable — it would silently strict-404 instead of
   * running its handler. Pin the terminal as the LAST entry within the `/api/`
   * group so a route appended to the end of the table fails here.
   *
   * Descriptor-keyed, which the "descriptor its own matcher accepts" test above
   * makes sound: a matcher-based entry can't hide `/api/` reach behind a
   * non-`/api/` descriptor without also rejecting its own descriptor. The static
   * `GET /*` catch-all sits after the terminal by design and is excluded — being
   * shadowed for `/api/` paths is exactly what the terminal is for.
   */
  it("keeps the ANY /api/* terminal last within the /api/ group", () => {
    const terminal = entryAt("ANY", "/api/*")
    expect(terminal).toBeGreaterThanOrEqual(0)
    const shadowed = ROUTE_TABLE.map((e, i) => ({ e, i }))
      .filter(({ e, i }) => i > terminal && e.path.startsWith("/api/"))
      .map(({ e }) => `${e.method} ${e.path}`)
    expect(shadowed).toEqual([])
  })
})

describe("route resolution — postures match the pre-refactor if-chain", () => {
  // Every path the old inline `readOnlyGet` allowlist downgraded to
  // `if-present`, plus the strict counterparts that must NOT be downgraded.
  const cases: Array<[string, string, AuthPolicy]> = [
    // --- public ---
    ["GET", "/vendor/html2canvas.min.js", "none"],
    ["POST", "/vendor/html2canvas.min.js", "none"], // handler 405s internally
    ["GET", "/__desde/bootstrap.js", "none"],
    ["GET", "/index.html", "none"],
    ["GET", "/assets/app.js", "none"],
    // --- MCP: bearer, Origin optional ---
    ["GET", "/mcp/status", "bearer-origin-if-present"],
    ["POST", "/mcp/status", "bearer-origin-if-present"], // catch-all → 404 after auth
    ["GET", "/mcp/nope", "bearer-origin-if-present"],
    ["POST", "/api/editor/mcp/tool/get_page_info", "bearer-origin-if-present"],
    ["GET", "/api/editor/mcp/tool/get_page_info", "bearer-origin-required"], // falls to /api/* 404
    ["GET", "/api/editor/shell-bridge/poll", "bearer-origin-if-present"],
    ["POST", "/api/editor/shell-bridge/reply", "bearer-origin-required"],
    // --- the old read-only-GET allowlist ---
    ["GET", "/api/editor/icon-sets", "bearer-origin-if-present"],
    ["GET", "/api/editor/manifest", "bearer-origin-if-present"],
    ["GET", "/api/editor/catalog", "bearer-origin-if-present"],
    ["GET", "/api/editor/design-systems", "bearer-origin-if-present"],
    ["GET", "/api/editor/design-systems/suggestions", "bearer-origin-if-present"],
    ["GET", "/api/editor/chat/sessions", "bearer-origin-if-present"],
    ["GET", "/api/editor/chat/sessions/abc123", "bearer-origin-if-present"],
    ["GET", "/api/editor/chat/sessions/abc123/lock-events", "bearer-origin-if-present"],
    ["GET", "/api/editor/chat/model-catalog", "bearer-origin-if-present"],
    ["GET", "/api/editor/comments", "bearer-origin-if-present"],
    ["GET", "/api/editor/comments/c1/replies", "bearer-origin-if-present"],
    ["GET", "/api/editor/notes", "bearer-origin-if-present"],
    ["GET", "/api/editor/screenshot-plans", "bearer-origin-if-present"],
    ["GET", "/api/editor/canvases", "bearer-origin-if-present"],
    ["GET", "/api/editor/project-knowledge", "bearer-origin-if-present"],
    ["GET", "/api/editor/smoke-test", "bearer-origin-if-present"],
    ["GET", "/api/editor/design-tokens", "bearer-origin-if-present"],
    ["GET", "/api/editor/file", "bearer-origin-if-present"],
    ["GET", "/api/editor/conditional-groups", "bearer-origin-if-present"],
    ["GET", "/api/editor/branches", "bearer-origin-if-present"],
    ["GET", "/api/editor/home", "bearer-origin-if-present"],
    ["GET", "/api/editor/drift", "bearer-origin-if-present"],
    // --- strict: mutations, and non-GET on the allowlisted paths ---
    ["POST", "/api/editor/edit", "bearer-origin-required"],
    ["POST", "/api/editor/edit-iteration", "bearer-origin-required"],
    ["POST", "/api/editor/llm-fallback", "bearer-origin-required"],
    ["POST", "/api/editor/text-branches", "bearer-origin-required"],
    ["POST", "/api/editor/chat", "bearer-origin-required"],
    ["POST", "/api/editor/chat/bridge-reply", "bearer-origin-required"],
    ["POST", "/api/editor/chat/steer", "bearer-origin-required"],
    ["POST", "/api/editor/chat/edit-ack", "bearer-origin-required"],
    ["POST", "/api/editor/chat/sessions/abc/resolve-conflict", "bearer-origin-required"],
    ["POST", "/api/editor/chat/sessions/abc/apply-merge-resolution", "bearer-origin-required"],
    ["POST", "/api/editor/branches/switch", "bearer-origin-required"],
    ["POST", "/api/editor/branches/create", "bearer-origin-required"],
    ["POST", "/api/editor/branches/rename", "bearer-origin-required"],
    ["POST", "/api/editor/branches/publish", "bearer-origin-required"],
    ["POST", "/api/editor/branches/commit", "bearer-origin-required"],
    ["POST", "/api/editor/branches/discard", "bearer-origin-required"],
    ["POST", "/api/editor/branches/push", "bearer-origin-required"],
    ["POST", "/api/editor/branches/merge-push", "bearer-origin-required"],
    ["POST", "/api/editor/comments", "bearer-origin-required"],
    ["DELETE", "/api/editor/comments/c1", "bearer-origin-required"],
    ["PATCH", "/api/editor/notes/n1", "bearer-origin-required"],
    ["POST", "/api/editor/canvases", "bearer-origin-required"],
    ["POST", "/api/editor/screenshot-plans", "bearer-origin-required"],
    ["POST", "/api/editor/design-systems", "bearer-origin-required"],
    ["GET", "/api/editor/design-systems/updates", "bearer-origin-required"],
    ["POST", "/api/editor/drift", "bearer-origin-required"],
    ["DELETE", "/api/editor/drift/KButton", "bearer-origin-required"],
    ["POST", "/api/editor/drift/KButton/regenerate-hints", "bearer-origin-required"],
    ["GET", "/api/editor/drift/KButton", "bearer-origin-required"],
    ["POST", "/api/editor/smoke-test", "bearer-origin-required"],
    ["POST", "/api/editor/project/link", "bearer-origin-required"],
    ["GET", "/api/health", "bearer-origin-if-present"],
    // --- unknown API paths 404 after the strict gate, never fall to static ---
    ["GET", "/api/editor/nope", "bearer-origin-required"],
    ["POST", "/api/nope", "bearer-origin-required"],
    ["HEAD", "/api/editor/icon-sets", "bearer-origin-required"],
  ]

  it.each(cases)("%s %s → %s", (method, path, expected) => {
    const entry = resolveRoute(method, path)
    expect(entry, `no route matched ${method} ${path}`).toBeDefined()
    expect(entry?.authPolicy).toBe(expected)
  })

  it("405s (no match) for a non-GET request to an unrouted path", () => {
    expect(resolveRoute("POST", "/not-an-api-path")).toBeUndefined()
    expect(resolveRoute("DELETE", "/")).toBeUndefined()
  })
})

/**
 * The trap this closes.
 *
 * Browsers do not send `Origin` on a same-origin GET, and page JS cannot add
 * it — it is a forbidden header. So a GET route declared
 * `bearer-origin-required` is unreachable from the Editor's own UI: it 403s
 * with a correct bearer, forever.
 *
 * It is a quiet failure. On 2026-08-09 three routes had it —
 * `GET /api/health`, `GET /api/editor/viewer-auth`, and the viewer proxy —
 * and the symptom was not an error anyone chased but a feature that silently
 * did nothing (the Editor stayed in local-comment mode with a viewer
 * configured, because the status probe 403'd). curl-based testing cannot find
 * it either, since curl sends whatever Origin you pass it.
 *
 * ANY routes are out of scope here: they knowingly span methods, and the two
 * that matter carry their own reasoning. This guards the case where someone
 * adds a plain GET and reaches for the stricter-sounding posture.
 */
describe("no GET route may require an Origin header", () => {
  it("every method:GET entry uses bearer-origin-if-present or none", () => {
    const offenders = ROUTE_TABLE.filter(
      (r) => r.method === "GET" && r.authPolicy === "bearer-origin-required",
    ).map((r) => String(r.path))
    expect(
      offenders,
      `these GET routes would 403 for the Editor UI (browsers omit Origin on same-origin GETs):\n${offenders.join("\n")}`,
    ).toEqual([])
  })
})

/**
 * Security audit B10 — DNS rebinding.
 *
 * The listener validated `Origin` and nothing else, so a page on a name that
 * had been rebound to 127.0.0.1 was, to the browser, same-origin with us: it
 * could read the per-boot bearer out of `/__desde/bootstrap.js` (CORP
 * does not apply to a request the browser considers same-origin) and then use
 * it on every `bearer-origin-if-present` GET, because browsers omit `Origin`
 * on same-origin GETs. Reads only — a write carries `Origin` and 403s — so
 * this was disclosure (repo source, chat transcripts), not code execution.
 *
 * `checkHost` runs before `resolveRoute`, which is the property these tests
 * pin: it must hold for the ungated bootstrap and the static catch-all too,
 * since those are exactly what the attack reads first.
 *
 * `node:http` with `setHost: false` rather than `fetch` — `Host` is a
 * forbidden header for the Fetch API, and the point here is to forge it.
 */
describe("Host guard (B10) — booted server", () => {
  let handle: HttpServerHandle
  let bundleDir: string
  let repoDir: string
  let port: number

  beforeAll(async () => {
    bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-hostguard-bundle-"))
    await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>t</title>")
    repoDir = await mkdtemp(join(tmpdir(), "editor-cli-hostguard-repo-"))
    port = await pickFreePort()
    handle = await startHttpServer({
      host: "127.0.0.1",
      port,
      repoRoot: repoDir,
      uiBundleRoot: bundleDir,
      viteUrl: "http://localhost:5173",
      security: newSecurityContext(`http://127.0.0.1:${port}`),
    })
  })

  afterAll(async () => {
    await handle.close()
    await rm(bundleDir, { recursive: true, force: true })
    await rm(repoDir, { recursive: true, force: true })
  })

  interface RawResponse {
    status: number
    body: string
  }

  /** A request with EXACTLY the headers given — node adds no `Host` of its own. */
  function raw(
    method: string,
    path: string,
    headers: Record<string, string> = {},
  ): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, method, path, headers, setHost: false },
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

  function rejectedForHost(res: RawResponse): boolean {
    return res.status === 403 && /Invalid Host|Missing Host/.test(res.body)
  }

  /** Every table entry, as a concrete (method, path) a client could send. */
  const probes: Array<[string, string]> = [
    ...ROUTE_TABLE.map(
      (e): [string, string] => [
        e.method === "ANY" ? "GET" : e.method,
        concretize(e.path),
      ],
    ),
    // Paths no descriptor spells out, including the two the attack starts on.
    ["GET", "/"],
    ["GET", "/index.html"],
    ["GET", "/__desde/bootstrap.js"],
    ["POST", "/api/editor/edit"],
  ]

  /** Probe every entry, collect the ones that behaved wrong — one failure lists them all. */
  async function sweep(
    host: string,
    want: (res: RawResponse) => boolean,
  ): Promise<string[]> {
    const wrong: string[] = []
    for (const [method, path] of probes) {
      const res = await raw(method, path, { host })
      if (!want(res)) wrong.push(`${method} ${path} → ${res.status} ${res.body}`)
    }
    return wrong
  }

  it("403s a spoofed Host on every route, ungated ones included", async () => {
    expect(await sweep("evil.test:4321", rejectedForHost)).toEqual([])
  })

  it("lets a legitimate 127.0.0.1 Host through on every route", async () => {
    expect(
      await sweep(`127.0.0.1:${port}`, (res) => !rejectedForHost(res)),
    ).toEqual([])
  })

  it("lets a legitimate localhost Host through on every route", async () => {
    expect(await sweep(`localhost:${port}`, (res) => !rejectedForHost(res))).toEqual(
      [],
    )
  })

  it("still serves the bootstrap token on a legitimate Host", async () => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      const res = await raw("GET", "/__desde/bootstrap.js", { host })
      expect(res.status, host).toBe(200)
      expect(res.body, host).toContain("window.__DESDE_CLI__=")
    }
  })

  it("withholds the bootstrap token from a rebound name", async () => {
    const res = await raw("GET", "/__desde/bootstrap.js", {
      host: "evil.test:4321",
    })
    expect(res.status).toBe(403)
    expect(res.body).not.toContain("token")
  })

  it("rejects a loopback name on the WRONG port", async () => {
    // The rebinding name is attacker-chosen but the port is not — pinning the
    // port keeps a second listener on this machine from being impersonated.
    const res = await raw("GET", "/__desde/bootstrap.js", {
      host: `127.0.0.1:${port + 1}`,
    })
    expect(rejectedForHost(res)).toBe(true)
  })

  /**
   * The yardstick is the socket, not the shell origin.
   *
   * `Host` says which socket the client reached; `Origin` says which page sent
   * it. They carry the same port in production, so keying the guard off
   * `security.shellOrigin` looked equivalent — and broke three existing
   * integration tests that deliberately give the server a `shellOrigin` on a
   * different port from the one it listens on. Pinned here so the two stay
   * distinguished.
   */
  it("matches the port it listens on, not the one shellOrigin names", async () => {
    const otherPort = await pickFreePort()
    const shellPort = await pickFreePort()
    const dir = await mkdtemp(join(tmpdir(), "editor-cli-hostguard-alt-"))
    await writeFile(join(dir, "index.html"), "<!doctype html><title>t</title>")
    const alt = await startHttpServer({
      host: "127.0.0.1",
      port: otherPort,
      repoRoot: repoDir,
      uiBundleRoot: dir,
      viteUrl: "http://localhost:5173",
      security: newSecurityContext(`http://127.0.0.1:${shellPort}`),
    })
    try {
      const url = `http://127.0.0.1:${otherPort}/__desde/bootstrap.js`
      const good = await fetch(url) // undici sends Host: 127.0.0.1:<otherPort>
      expect(good.status).toBe(200)
    } finally {
      await alt.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  /**
   * Deliberate: an absent `Host` loses — but not here.
   *
   * MEASURED: `node:http`'s parser answers a Host-less HTTP/1.1 request with a
   * bare 400 and never runs the request handler, so `checkHost` never sees it.
   * What matters for B10 is that no token comes back either way; the
   * `checkHost` branch itself is unit-tested below as a backstop.
   */
  it("never answers a request with no Host header", async () => {
    const res = await raw("GET", "/__desde/bootstrap.js")
    expect(res.status).toBe(400)
    expect(res.body).not.toContain("token")
  })

  it("refuses a cross-site fetch of the bootstrap even on a good Host", async () => {
    const res = await raw("GET", "/__desde/bootstrap.js", {
      host: `127.0.0.1:${port}`,
      "sec-fetch-site": "cross-site",
    })
    expect(res.status).toBe(403)
    expect(res.body).not.toContain("token")
  })

  it("allows the same-origin fetch the editor's own page makes", async () => {
    const res = await raw("GET", "/__desde/bootstrap.js", {
      host: `127.0.0.1:${port}`,
      "sec-fetch-site": "same-origin",
    })
    expect(res.status).toBe(200)
  })
})

describe("checkHost", () => {
  const req = (headers: Record<string, string>) =>
    ({ headers }) as unknown as IncomingMessage

  it("accepts each loopback name on the listener's port", () => {
    for (const host of ["127.0.0.1:4321", "localhost:4321", "[::1]:4321"]) {
      expect(checkHost(req({ host }), "http://127.0.0.1:4321").ok, host).toBe(true)
    }
  })

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    expect(checkHost(req({ host: " LocalHost:4321 " }), "http://127.0.0.1:4321").ok).toBe(
      true,
    )
  })

  it("refuses a rebound name, and a loopback name on the wrong port", () => {
    for (const host of ["evil.test:4321", "127.0.0.1.nip.io:4321", "127.0.0.1:4322"]) {
      const result = checkHost(req({ host }), "http://127.0.0.1:4321")
      expect(result.ok, host).toBe(false)
      if (!result.ok) expect(result.status).toBe(403)
    }
  })

  /**
   * Backstop only — node's parser 400s a Host-less request before the handler
   * runs (see the booted-server test above). Pinned so the function stays
   * correct on its own terms if that ever changes.
   */
  it("refuses an absent or empty Host", () => {
    const cases: Array<Record<string, string>> = [{}, { host: "" }, { host: "   " }]
    for (const headers of cases) {
      const result = checkHost(req(headers), "http://127.0.0.1:4321")
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(403)
        expect(result.reason).toContain("Missing Host")
      }
    }
  })
})

describe("allowedHostValues", () => {
  it("pairs every loopback name with the listener's own port", () => {
    expect(allowedHostValues("http://127.0.0.1:4321")).toEqual(
      new Set(["127.0.0.1:4321", "localhost:4321", "[::1]:4321"]),
    )
  })

  it("accepts a bare name only when the listener is on the default port", () => {
    const defaulted = allowedHostValues("http://127.0.0.1")
    expect(defaulted.has("localhost")).toBe(true)
    expect(defaulted.has("localhost:80")).toBe(true)
    expect(allowedHostValues("http://127.0.0.1:4321").has("localhost")).toBe(false)
  })

  it("keeps an IPv6 bind host in its bracketed Host-header form", () => {
    expect(allowedHostValues("http://[::1]:4321")).toEqual(
      new Set(["127.0.0.1:4321", "localhost:4321", "[::1]:4321"]),
    )
  })

  it("does not lock out a deliberately non-default bind host", () => {
    // No CLI flag sets this today, but `startHttpServer` takes a `host`; an
    // operator who binds a name on purpose must still reach their own server.
    expect(allowedHostValues("http://dev.internal:4321")).toContain(
      "dev.internal:4321",
    )
  })
})

describe("capabilities routes", () => {
  it("gates the ENABLE route strictly — it writes .mcp.json", () => {
    // .mcp.json decides which subprocesses the next turn spawns, so this must
    // never fall to the lenient read posture.
    const entry = resolveRoute("POST", "/api/editor/capabilities/enable")
    expect(entry?.authPolicy).toBe("bearer-origin-required")
  })

  it("lets the read route use the lenient posture", () => {
    expect(resolveRoute("GET", "/api/editor/capabilities")?.authPolicy).toBe(
      "bearer-origin-if-present",
    )
  })

  it("does not let the enable path resolve to the read route", () => {
    // Both live under the same prefix; a matcher mistake would silently
    // downgrade the write posture.
    const read = resolveRoute("GET", "/api/editor/capabilities")
    const write = resolveRoute("POST", "/api/editor/capabilities/enable")
    expect(read).not.toBe(write)
  })
})

