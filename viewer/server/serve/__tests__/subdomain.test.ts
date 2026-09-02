/**
 * Subdomain serving mode (Phase 3d).
 *
 * The security claim being tested is stronger than path mode's: a prototype
 * on its own origin cannot reach the API because the BROWSER won't route it
 * there and the shell's host-only cookie is never sent — not because of a
 * header we emit. The routing half of that is what a server test can prove,
 * so it is what these assert.
 */
import request from "supertest"
import { beforeEach, describe, expect, it } from "vitest"
import type { AssetStore, StoredAsset } from "../../assets/types"
import { loadConfig } from "../../config"
import { createApp } from "../../__tests__/test-app"
import { createSwappableApp } from "../../__tests__/swappable-app"
import { tmpViewerDataDir } from "../../__tests__/test-config"
import { InMemoryStorage } from "../../storage/in-memory-storage"
import { prototypeOriginFor, resolveIsolatedOriginCsp, slugFromHost } from "../subdomain"
import { mintPrototypeCapability } from "../prototype-capability"
import { CAPABILITY_COOKIE_NAME } from "../prototype-capability-path"
import { testGithubRuntime } from "../../__tests__/test-github-runtime"
import { upsertTestUser } from "../../__tests__/user-fixtures"

const DOMAIN = "proto.test"

/**
 * A prototype `Host` as a browser would send it against this file's
 * deployment, whose `publicUrl` is `http://localhost:3100`.
 *
 * The port is not decoration. The Host allowlist
 * (`server/serve/host-allowlist.ts`, mounted first in `createApp`) compares
 * the port on a `{slug}.{serveDomain}` host exactly as it does on the shell
 * host, so a port-less Host is refused with a 400 before routing when
 * `publicUrl` names a port. `slugFromHost` itself strips the port, so what
 * these tests exercise downstream is unchanged.
 */
function protoHost(slug: string): string {
  return `${slug}.${DOMAIN}:3100`
}

function assetsWith(files: Record<string, StoredAsset>): AssetStore {
  return {
    async put() {},
    async get(_deploymentId, relPath) {
      return files[relPath] ?? null
    },
    async deleteDeployment() {},
  }
}

describe("slugFromHost", () => {
  it("extracts a single-label slug", () => {
    expect(slugFromHost("acme.proto.test", DOMAIN)).toEqual({ slug: "acme" })
    expect(slugFromHost("ACME.Proto.Test", DOMAIN)).toEqual({ slug: "acme" })
    // A dev deployment is reached on a port; the configured domain never
    // carries one.
    expect(slugFromHost("acme.proto.test:3100", DOMAIN)).toEqual({ slug: "acme" })
  })

  it("returns null when subdomain mode is off", () => {
    expect(slugFromHost("acme.proto.test", null)).toBeNull()
  })

  it("rejects the bare serve domain — it has no slug", () => {
    expect(slugFromHost("proto.test", DOMAIN)).toBeNull()
  })

  /**
   * A wildcard certificate for `*.proto.test` does not cover
   * `a.b.proto.test`, and a nested label would also let `evil.acme.…`
   * shadow `acme.…` if anything were ever set domain-wide.
   */
  it("rejects a nested label", () => {
    expect(slugFromHost("a.b.proto.test", DOMAIN)).toBeNull()
  })

  it("rejects a host that merely ends with the domain string", () => {
    // `evilproto.test` ends with "proto.test" as a SUBSTRING but is a
    // different domain entirely — the check must be label-boundary aware.
    expect(slugFromHost("evilproto.test", DOMAIN)).toBeNull()
    expect(slugFromHost("notproto.test", DOMAIN)).toBeNull()
  })

  it("rejects a label that is not a valid slug", () => {
    expect(slugFromHost("-bad.proto.test", DOMAIN)).toBeNull()
    expect(slugFromHost("a.proto.test", DOMAIN)).toBeNull() // too short
    expect(slugFromHost("UPPER_CASE.proto.test", DOMAIN)).toBeNull()
  })

  it("returns null for a missing host", () => {
    expect(slugFromHost(undefined, DOMAIN)).toBeNull()
  })
})

describe("prototypeOriginFor", () => {
  it("is port-less when publicUrl carries no explicit port", () => {
    // A deployed instance on a scheme-default port. The URL API drops 443, so
    // the emitted origin is port-less — exactly what the allowlist accepts for
    // a no-explicit-port publicUrl.
    expect(prototypeOriginFor("acme", "proto.example.com", "https://app.example.com")).toBe(
      "https://acme.proto.example.com",
    )
    expect(prototypeOriginFor("acme", "proto.example.com", "https://app.example.com:443")).toBe(
      "https://acme.proto.example.com",
    )
  })

  it("carries publicUrl's EXPLICIT port onto the prototype origin", () => {
    // Task 11 / task 4b: a loopback dev deployment on :3100 with a serve
    // domain. A port-less origin here is unreachable AND refused by the Host
    // allowlist, which compares the port.
    expect(prototypeOriginFor("acme", "proto.test", "http://localhost:3100")).toBe(
      "http://acme.proto.test:3100",
    )
  })

  it("carries the shell's scheme", () => {
    expect(prototypeOriginFor("acme", "proto.test", "http://localhost:3100")).toMatch(/^http:\/\//)
    expect(prototypeOriginFor("acme", "proto.example.com", "https://app.example.com")).toMatch(
      /^https:\/\//,
    )
  })
})

describe("resolveIsolatedOriginCsp", () => {
  it("uses connect-src 'self' and names the shell in frame-ancestors", () => {
    const csp = resolveIsolatedOriginCsp(null, "https://app.example.com") ?? ""
    // Stronger than path mode: on its own origin, 'self' IS the prototype.
    expect(csp).toContain("connect-src 'self'")
    // The review page iframes the prototype cross-origin, so 'self' here
    // would block the product's main surface.
    expect(csp).toContain("frame-ancestors https://app.example.com")
    expect(csp).toContain("frame-src 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("form-action 'none'")
  })

  it("honours the off switch and a custom policy", () => {
    expect(resolveIsolatedOriginCsp("off", "https://app.example.com")).toBeNull()
    expect(resolveIsolatedOriginCsp("default-src 'none'", "https://x")).toBe("default-src 'none'")
  })

  // Subdomain mode gives a prototype a real origin (not opaque), which is
  // exactly the condition that makes service workers registrable — see the
  // matching path-mode assertion in serve-router.test.ts. This policy is
  // built from its own string (not derived from resolvePrototypeCsp), so it
  // needs its own denial.
  it("denies worker-src, same as path mode", () => {
    const csp = resolveIsolatedOriginCsp(null, "https://app.example.com") ?? ""
    expect(csp).toContain("worker-src 'none'")
  })
})

describe("subdomain serving end to end", () => {
  let storage: InMemoryStorage

  beforeEach(() => {
    storage = new InMemoryStorage()
  })

  /**
   * ONE stable app object for this whole file — see `__tests__/swappable-app.ts`.
   * 7 listening servers per run before this; every test calls this factory
   * exactly once.
   */
  const stable = createSwappableApp()

  function appWith(files: Record<string, StoredAsset>) {
    stable.use(
      createApp({
        storage,
        assets: assetsWith(files),
        config: loadConfig({ VIEWER_PUBLIC_URL: "http://localhost:3100", VIEWER_SERVE_DOMAIN: DOMAIN, VIEWER_DATA_DIR: tmpViewerDataDir() }),
        bridgeScript: "// bridge",
        bridgeVersion: "test-1",
        github: testGithubRuntime(),
      }),
    )
    return stable.app
  }

  async function seed(slug: string) {
    const project = await storage.createProject({ slug, name: slug, access: "public-link" })
    const dep = await storage.createDeployment({ projectId: project.id, status: "deployed" })
    await storage.updateProject(project.id, { activeDeploymentId: dep.id })
    return project
  }

  const html = (body: string): StoredAsset => ({ body: Buffer.from(body), contentType: "text/html" })

  it("serves the prototype at the origin root", async () => {
    await seed("acme")
    const built = appWith({ "index.html": html("<!doctype html><h1>hi</h1>") })
    const res = await request(built).get("/").set("Host", protoHost("acme")).expect(200)
    expect(res.text).toContain("<h1>hi</h1>")
  })

  /**
   * `Access-Control-Allow-Origin: *` exists for ONE condition: the path-mode
   * review frame is sandboxed without `allow-same-origin`, so its own module
   * scripts arrive as CORS requests with `Origin: null`
   * (`serve/prototype-cors.ts`). On a real origin the document's assets are
   * same-origin with it, so CORS never runs and the header has no job. It is
   * withheld from BOTH isolated modes together rather than only from the
   * loopback one, so there is a single rule (`servesAtRoot`) instead of a
   * per-mode exception list.
   */
  it("sends no Access-Control-Allow-Origin", async () => {
    await seed("acme")
    const built = appWith({
      "index.html": html("<!doctype html><h1>hi</h1>"),
      "assets/app.js": { body: Buffer.from("export const a=1"), contentType: "text/javascript" },
    })
    for (const path of ["/", "/assets/app.js", "/__desde/bridge-test-1.js"]) {
      const res = await request(built).get(path).set("Host", protoHost("acme")).expect(200)
      expect(res.headers["access-control-allow-origin"], path).toBeUndefined()
    }
  })

  /**
   * The Phase 1.5 rewriting exists because `<base href>` does not rebase
   * ROOT-relative URLs, which made a stock Vite build render blank under
   * path serving. On a subdomain the prototype IS at the root, so that
   * whole class of problem — and its documented residue for apps with an
   * explicit base path — simply does not arise.
   */
  it("does not rewrite root-relative asset URLs or inject a base href", async () => {
    await seed("acme")
    const built = appWith({ "index.html": html('<!doctype html><script src="/assets/app.js"></script>') })
    const res = await request(built).get("/").set("Host", protoHost("acme")).expect(200)
    expect(res.text).toContain('src="/assets/app.js"')
    expect(res.text).not.toContain("/p/acme/assets/app.js")
    expect(res.text).not.toContain("<base ")
  })

  it("emits the subdomain CSP, not the path-scoped one", async () => {
    await seed("acme")
    const built = appWith({ "index.html": html("<!doctype html>") })
    const res = await request(built).get("/").set("Host", protoHost("acme")).expect(200)
    const csp = res.headers["content-security-policy"] ?? ""
    expect(csp).toContain("connect-src 'self'")
    expect(csp).not.toContain("/p/acme/")
    expect(res.headers["x-content-type-options"]).toBe("nosniff")
  })

  /**
   * Task 9 / task 4b: on a PROTOTYPE host, the request's own `Host` can
   * never be trusted for the shell origin — there is no way to read the
   * reviewer's actual shell spelling off a slug host at all. So
   * `frame-ancestors` must name `publicUrl` here, exactly as it did before
   * shell-origin resolution became per-request, even though this deployment's
   * `publicUrl` is itself a loopback address (the same condition that DOES
   * let the main app's own host flip on the shell's own hosts — this proves
   * a prototype host is not one of them).
   *
   * Known limit, documented rather than fixed here (task 11's territory):
   * subdomain mode has no way to learn which loopback spelling the reviewer's
   * shell is actually on, so it always assumes `publicUrl`.
   */
  it("names publicUrl in frame-ancestors, never the slug host's own spelling", async () => {
    await seed("acme")
    const built = appWith({ "index.html": html("<!doctype html>") })
    const res = await request(built).get("/").set("Host", protoHost("acme")).expect(200)
    const csp = res.headers["content-security-policy"] ?? ""
    expect(csp).toContain("frame-ancestors http://localhost:3100")
  })

  /**
   * THE point of this mode. On a prototype origin the API is not merely
   * CSP-blocked — it is not routed there at all, so the boundary survives
   * even the documented `VIEWER_PROTOTYPE_CSP=off` escape hatch.
   */
  it("does not route the API on a prototype subdomain", async () => {
    await seed("acme")
    const built = appWith({ "index.html": html("<!doctype html>") })
    // Same path that returns JSON on the shell host.
    const onShell = await request(built).get("/api/v1/health").set("Host", `localhost:3100`)
    expect(onShell.status).toBe(200)
    expect(onShell.body.status).toBe("ok")

    // The property that matters is NOT a particular status — it is that the
    // API did not answer. On the prototype origin this path resolves as an
    // ASSET, so what comes back is whatever the prototype has there (an
    // index.html fallback, or a 404), never the API's JSON.
    const onPrototype = await request(built).get("/api/v1/health").set("Host", protoHost("acme"))
    expect(onPrototype.body?.status).not.toBe("ok")
    expect(onPrototype.text ?? "").not.toContain('"profile"')
  })

  it("serves the bridge from the origin root", async () => {
    await seed("acme")
    const built = appWith({ "index.html": html("<!doctype html>") })
    const page = await request(built).get("/").set("Host", protoHost("acme")).expect(200)
    expect(page.text).toContain('src="/__desde/bridge-test-1.js"')
    await request(built).get("/__desde/bridge-test-1.js").set("Host", protoHost("acme")).expect(200)
  })

  it("still 404s an unknown slug, and a project the caller cannot read", async () => {
    const project = await storage.createProject({ slug: "locked", name: "L", access: "invited" })
    const user = await upsertTestUser(storage, {
      provider: "github",
      providerUserId: "o",
      email: "o@x.com",
      displayName: "O",
      avatarUrl: "",
    })
    await storage.addProjectMember({ projectId: project.id, userId: user.id })
    const dep = await storage.createDeployment({ projectId: project.id, status: "deployed" })
    await storage.updateProject(project.id, { activeDeploymentId: dep.id })

    const built = appWith({ "index.html": html("<!doctype html>") })
    const missing = await request(built).get("/").set("Host", protoHost("nosuchslug"))
    const unreadable = await request(built).get("/").set("Host", protoHost("locked"))
    expect(missing.status).toBe(404)
    expect(unreadable.status).toBe(404)
    // The access gate's byte-identity survives the rewrite.
    expect(unreadable.text).toBe(missing.text)
  })

  it("leaves the shell host untouched when subdomain mode is on", async () => {
    await seed("acme")
    const built = appWith({ "index.html": html("<!doctype html><h1>hi</h1>") })
    // Path serving keeps working for the same project.
    const viaPath = await request(built).get("/p/acme/").set("Host", "localhost:3100").expect(200)
    expect(viaPath.text).toContain("<h1>hi</h1>")
    expect(viaPath.headers["content-security-policy"]).toContain("/p/acme/")
  })

  /**
   * Task 11: a PRIVATE prototype on its own subdomain. The session cookie is
   * host-only and never reaches `{slug}.{serveDomain}`, so a private prototype
   * authorizes its document load with a `?~c=` query the shell mints, the
   * server promotes it to a host-only `dsv_cap` cookie, and every same-site
   * subresource request after that carries the cookie.
   */
  describe("capability on the document load (task 11)", () => {
    const SECRET = "sesh-secret"

    /** An authed http deployment (publicUrl on :3100), so `Secure` is absent. */
    function authedAppWith(files: Record<string, StoredAsset>) {
      stable.use(
        createApp({
          storage,
          assets: assetsWith(files),
          config: loadConfig({
            VIEWER_SESSION_SECRET: SECRET,
            VIEWER_PUBLIC_URL: "http://localhost:3100",
            VIEWER_SERVE_DOMAIN: DOMAIN,
            VIEWER_DATA_DIR: tmpViewerDataDir(),
          }),
          bridgeScript: "// bridge",
          bridgeVersion: "test-1",
          github: testGithubRuntime(),
        }),
      )
      return stable.app
    }

    /** An authed https deployment, so a set `dsv_cap` cookie carries `Secure`. */
    function authedHttpsAppWith(files: Record<string, StoredAsset>) {
      stable.use(
        createApp({
          storage,
          assets: assetsWith(files),
          config: loadConfig({
            VIEWER_SESSION_SECRET: SECRET,
            VIEWER_PUBLIC_URL: "https://app.example.com",
            VIEWER_SERVE_DOMAIN: "proto.example.com",
            VIEWER_DATA_DIR: tmpViewerDataDir(),
          }),
          bridgeScript: "// bridge",
          bridgeVersion: "test-1",
          github: testGithubRuntime(),
        }),
      )
      return stable.app
    }

    async function seedPrivate(slug: string) {
      const project = await storage.createProject({ slug, name: slug, access: "invited" })
      const owner = await upsertTestUser(storage, {
        provider: "github",
        providerUserId: `owner-${slug}`,
        email: `owner-${slug}@x.com`,
        displayName: "Owner",
        avatarUrl: "",
      })
      await storage.addProjectMember({ projectId: project.id, userId: owner.id })
      const dep = await storage.createDeployment({ projectId: project.id, status: "deployed" })
      await storage.updateProject(project.id, { activeDeploymentId: dep.id })
      return { project, deploymentId: dep.id }
    }

    function mint(slug: string, deploymentId: string, now?: number): string {
      const token = mintPrototypeCapability({ secret: SECRET, slug, deploymentId, now })
      expect(token).not.toBeNull()
      return token as string
    }

    const js = (body: string): StoredAsset => ({ body: Buffer.from(body), contentType: "text/javascript" })

    it("404s a private prototype with no capability — byte-identical to an unknown slug, no cookie", async () => {
      await seedPrivate("locked")
      const built = authedAppWith({ "index.html": html("<!doctype html><body>secret</body>") })
      const denied = await request(built).get("/").set("Host", protoHost("locked"))
      const missing = await request(built).get("/").set("Host", protoHost("nosuchslug"))
      expect(denied.status).toBe(404)
      expect(missing.status).toBe(404)
      expect(denied.text).toBe(missing.text)
      expect(denied.headers["set-cookie"]).toBeUndefined()
    })

    it("verifies a `?~c=` query, sets a host-only dsv_cap cookie, and serves index.html at / with no base href", async () => {
      const { deploymentId } = await seedPrivate("locked")
      const token = mint("locked", deploymentId)
      const built = authedAppWith({ "index.html": html("<!doctype html><body>secret</body>") })
      const res = await request(built).get(`/?~c=${token}`).set("Host", protoHost("locked")).expect(200)
      expect(res.text).toContain("secret")
      expect(res.text).not.toContain("<base ")
      const setCookie = (res.headers["set-cookie"] as unknown as string[]) ?? []
      expect(setCookie).toHaveLength(1)
      const cookie = setCookie[0]
      expect(cookie).toContain(`${CAPABILITY_COOKIE_NAME}=${token}`)
      expect(cookie).toContain("Path=/")
      expect(cookie).toContain("HttpOnly")
      expect(cookie).toContain("SameSite=Lax")
      // Host-only (no Domain), session cookie (no Max-Age).
      expect(cookie).not.toMatch(/Domain=/i)
      expect(cookie).not.toMatch(/Max-Age/i)
      // http publicUrl → no Secure.
      expect(cookie).not.toMatch(/Secure/i)
    })

    it("sets Secure on the dsv_cap cookie when publicUrl is https", async () => {
      const { deploymentId } = await seedPrivate("locked")
      const token = mint("locked", deploymentId)
      const built = authedHttpsAppWith({ "index.html": html("<!doctype html><body>secret</body>") })
      const res = await request(built)
        .get(`/?~c=${token}`)
        .set("Host", "locked.proto.example.com")
        .expect(200)
      const cookie = ((res.headers["set-cookie"] as unknown as string[]) ?? [])[0] ?? ""
      expect(cookie).toContain(`${CAPABILITY_COOKIE_NAME}=${token}`)
      expect(cookie).toMatch(/Secure/i)
    })

    it("accepts the dsv_cap cookie on a subsequent subresource request and does not re-set it", async () => {
      const { deploymentId } = await seedPrivate("locked")
      const token = mint("locked", deploymentId)
      const built = authedAppWith({
        "index.html": html("<!doctype html>"),
        "assets/app.js": js("export const a=1"),
      })
      const res = await request(built)
        .get("/assets/app.js")
        .set("Host", protoHost("locked"))
        .set("Cookie", `${CAPABILITY_COOKIE_NAME}=${token}`)
        .expect(200)
      expect(res.text).toContain("export const a=1")
      expect(res.headers["set-cookie"]).toBeUndefined()
    })

    it("404s a forged dsv_cap cookie exactly as an absent one", async () => {
      await seedPrivate("locked")
      const built = authedAppWith({
        "index.html": html("<!doctype html>"),
        "assets/app.js": js("export const a=1"),
      })
      const forged = await request(built)
        .get("/assets/app.js")
        .set("Host", protoHost("locked"))
        .set("Cookie", `${CAPABILITY_COOKIE_NAME}=not-a-real-token`)
      const missing = await request(built).get("/assets/app.js").set("Host", protoHost("nosuchslug"))
      expect(forged.status).toBe(404)
      expect(missing.status).toBe(404)
      expect(forged.text).toBe(missing.text)
      expect(forged.headers["set-cookie"]).toBeUndefined()
    })

    it("404s an expired capability token on the query and sets no cookie", async () => {
      const { deploymentId } = await seedPrivate("locked")
      // Minted an hour ago with the default 30-minute TTL → already expired.
      const expired = mint("locked", deploymentId, Date.now() - 60 * 60 * 1000)
      const built = authedAppWith({ "index.html": html("<!doctype html>") })
      const res = await request(built).get(`/?~c=${expired}`).set("Host", protoHost("locked"))
      expect(res.status).toBe(404)
      expect(res.headers["set-cookie"]).toBeUndefined()
    })

    it("404s a forged `?~c=` query and sets no cookie", async () => {
      await seedPrivate("locked")
      const built = authedAppWith({ "index.html": html("<!doctype html>") })
      const res = await request(built).get("/?~c=not-a-real-token").set("Host", protoHost("locked"))
      expect(res.status).toBe(404)
      expect(res.headers["set-cookie"]).toBeUndefined()
    })

    it("404s a `?~c=` query with an illegal charset before it is used, and sets no cookie", async () => {
      await seedPrivate("locked")
      const built = authedAppWith({ "index.html": html("<!doctype html>") })
      // Decodes to `has space!`, outside the capability charset.
      const res = await request(built).get("/?~c=has%20space%21").set("Host", protoHost("locked"))
      expect(res.status).toBe(404)
      expect(res.headers["set-cookie"]).toBeUndefined()
    })

    it("serves a public prototype with no capability and sets no cookie", async () => {
      await seed("acme")
      const built = appWith({ "index.html": html("<!doctype html><h1>hi</h1>") })
      const res = await request(built).get("/").set("Host", protoHost("acme")).expect(200)
      expect(res.headers["set-cookie"]).toBeUndefined()
    })

    it("ignores a `?~c=` query on the SHELL host and sets no cookie", async () => {
      const { deploymentId } = await seedPrivate("locked")
      const token = mint("locked", deploymentId)
      const built = authedAppWith({ "index.html": html("<!doctype html><body>secret</body>") })
      // On the shell host the private prototype is reached via /p/{slug}/, and
      // the `?~c=` query is not a credential there.
      const res = await request(built).get(`/p/locked/?~c=${token}`).set("Host", "localhost:3100")
      expect(res.status).toBe(404)
      expect(res.headers["set-cookie"]).toBeUndefined()
    })

    it("still honours the path `~c/` capability form on the shell host, and never sets the cookie there", async () => {
      const { deploymentId } = await seedPrivate("locked")
      const token = mint("locked", deploymentId)
      const built = authedAppWith({ "index.html": html("<!doctype html><body>secret</body>") })
      const res = await request(built)
        .get(`/p/locked/~c/${token}/`)
        .set("Host", "localhost:3100")
        .expect(200)
      expect(res.text).toContain("secret")
      expect(res.headers["set-cookie"]).toBeUndefined()
    })
  })
})
