import request from "supertest"
import { describe, expect, it } from "vitest"
import {
  assertNoTestHostRelaxation,
  buildHostAllowlist,
  buildSingleHostAllowlist,
  createHostAllowlistMiddleware,
  isAllowedHost,
  normalizeHostPort,
} from "./host-allowlist"
// The TEST factory, like every other suite. It sets `allowAnyLoopbackPort`
// (which this describe needs, since supertest binds an ephemeral port) and
// fills in the one `AppDeps` field a test app has no reason to build itself —
// see `__tests__/test-app.ts`.
import { createApp } from "../__tests__/test-app"
import { createSwappableApp } from "../__tests__/swappable-app"
import { testGithubRuntime } from "../__tests__/test-github-runtime"
import { InMemoryStorage } from "../storage/in-memory-storage"
import type { AssetStore } from "../assets/types"
import type { ViewerConfig } from "../config"

const LOOPBACK: Pick<ViewerConfig, "publicUrl" | "port" | "serveDomain" | "prototypeOrigin"> = {
  publicUrl: "http://localhost:3100",
  port: 3100,
  serveDomain: null,
  prototypeOrigin: null,
}

const PUBLIC_HTTPS: Pick<ViewerConfig, "publicUrl" | "port" | "serveDomain" | "prototypeOrigin"> = {
  publicUrl: "https://desde.acme.test",
  port: 3100,
  serveDomain: null,
  prototypeOrigin: null,
}

const WITH_SERVE_DOMAIN: Pick<ViewerConfig, "publicUrl" | "port" | "serveDomain" | "prototypeOrigin"> = {
  publicUrl: "https://desde.acme.test",
  port: 3100,
  serveDomain: "desde.acme.test",
  prototypeOrigin: null,
}

/**
 * `isAllowedHost` bound to one allowlist, so the tables below read as data.
 *
 * The param is the three-field Pick so the inline `accepts({ publicUrl, port,
 * serveDomain }, host)` call sites stay terse; `prototypeOrigin` defaults to
 * `null` here (the tables that exercise it pass a config constant instead).
 */
function accepts(
  config: Pick<ViewerConfig, "publicUrl" | "port" | "serveDomain"> &
    Partial<Pick<ViewerConfig, "prototypeOrigin">>,
  host: string | undefined,
): boolean {
  return isAllowedHost(
    buildHostAllowlist({ ...config, prototypeOrigin: config.prototypeOrigin ?? null }),
    host,
    config.serveDomain,
  )
}

describe("buildHostAllowlist / isAllowedHost", () => {
  describe("loopback publicUrl", () => {
    it("accepts all three loopback spellings on the configured port", () => {
      expect(accepts(LOOPBACK, "localhost:3100")).toBe(true)
      expect(accepts(LOOPBACK, "127.0.0.1:3100")).toBe(true)
      expect(accepts(LOOPBACK, "[::1]:3100")).toBe(true)
    })

    it("compares the port, not just the host", () => {
      expect(accepts(LOOPBACK, "localhost:80")).toBe(false)
      expect(accepts(LOOPBACK, "localhost")).toBe(false)
      expect(accepts(LOOPBACK, "127.0.0.1:3101")).toBe(false)
    })

    it("rejects a host that is not in the closed set", () => {
      expect(accepts(LOOPBACK, "evil.com:3100")).toBe(false)
      expect(accepts(LOOPBACK, "localhost.evil.com:3100")).toBe(false)
    })

    it("rejects an absent or empty Host", () => {
      expect(accepts(LOOPBACK, undefined)).toBe(false)
      expect(accepts(LOOPBACK, "")).toBe(false)
    })

    it("matches the hostname case-insensitively", () => {
      expect(accepts(LOOPBACK, "LOCALHOST:3100")).toBe(true)
      expect(accepts(LOOPBACK, "LocalHost:3100")).toBe(true)
    })

    it("does not trim — a trailing space is a rejection", () => {
      expect(accepts(LOOPBACK, "127.0.0.1:3100 ")).toBe(false)
      expect(accepts(LOOPBACK, " 127.0.0.1:3100")).toBe(false)
    })

    it("rejects an unbracketed IPv6 literal", () => {
      expect(accepts(LOOPBACK, "::1:3100")).toBe(false)
      expect(accepts(LOOPBACK, "::1")).toBe(false)
    })

    /**
     * Neither is a legal `Host`, but both are what a probe reaches for: the
     * userinfo form to smuggle an allowed name past a naive `includes`, the
     * path form to smuggle one past a naive `startsWith`. An exact set
     * membership test refuses both without needing to know that.
     */
    it("rejects a Host carrying userinfo or a path", () => {
      expect(accepts(LOOPBACK, "user:pass@evil.com:3100")).toBe(false)
      expect(accepts(LOOPBACK, "evil.com@localhost:3100")).toBe(false)
      expect(accepts(LOOPBACK, "localhost:3100/x")).toBe(false)
      expect(accepts(LOOPBACK, "localhost:3100/../evil.com")).toBe(false)
    })
  })

  describe("non-loopback publicUrl", () => {
    it("accepts the bare host and the explicit scheme-default port", () => {
      expect(accepts(PUBLIC_HTTPS, "desde.acme.test")).toBe(true)
      expect(accepts(PUBLIC_HTTPS, "desde.acme.test:443")).toBe(true)
    })

    it("rejects any other port on that host", () => {
      expect(accepts(PUBLIC_HTTPS, "desde.acme.test:3100")).toBe(false)
      expect(accepts(PUBLIC_HTTPS, "desde.acme.test:80")).toBe(false)
    })

    /**
     * Superseded by task 4b, below: `localhost:3100` (the process's own
     * port) is now accepted on every configuration, including this one. What
     * still does NOT fall back is a loopback spelling on the WRONG port
     * (`127.0.0.1:443`, the public scheme-default) or the public hostname on
     * the wrong port — both stay covered by other tests in this file.
     */
    it("does not fall back to a loopback spelling on the wrong port", () => {
      expect(accepts(PUBLIC_HTTPS, "127.0.0.1:443")).toBe(false)
    })

    it("uses port 80 as the http default", () => {
      const httpConfig = { publicUrl: "http://desde.acme.test", port: 3100, serveDomain: null }
      expect(accepts(httpConfig, "desde.acme.test")).toBe(true)
      expect(accepts(httpConfig, "desde.acme.test:80")).toBe(true)
      expect(accepts(httpConfig, "desde.acme.test:443")).toBe(false)
    })

    it("rejects a port-less Host when publicUrl names an explicit port", () => {
      const explicitPort = { publicUrl: "https://desde.acme.test:8443", port: 3100, serveDomain: null }
      expect(accepts(explicitPort, "desde.acme.test:8443")).toBe(true)
      expect(accepts(explicitPort, "desde.acme.test")).toBe(false)
    })
  })

  /**
   * Task 4b. `viewer/app/review/[slug]/page.tsx` makes an internal fetch to
   * `http://127.0.0.1:<config.port>` (`internalApiBaseUrl`) to read the
   * project list, forwarding the reviewer's cookie. Before this task, that
   * request was refused with 400 on any deployment whose `publicUrl` was not
   * itself loopback, because the allowlist only accepted loopback spellings
   * when `publicUrl` was loopback too — so every review page 404'd on a real
   * deployment.
   *
   * The fix: always accept the three loopback spellings on `config.port`,
   * regardless of `publicUrl`. This is the address of the PROCESS'S OWN
   * LISTENER. A browser only ever sends a loopback Host when the URL bar
   * itself says `localhost`/`127.0.0.1`/`[::1]` — nothing remote can produce
   * it, including a DNS-rebinding page (which sends the attacker's chosen
   * hostname, not a loopback one). Behind a reverse proxy, the proxy forwards
   * the real public Host, so the public-host rule below still applies to
   * everything that actually arrives from outside.
   */
  describe("the process's own loopback address is always accepted (task 4b)", () => {
    it("accepts all three loopback spellings on config.port for a deployed instance", () => {
      expect(accepts(PUBLIC_HTTPS, "127.0.0.1:3100")).toBe(true)
      expect(accepts(PUBLIC_HTTPS, "localhost:3100")).toBe(true)
      expect(accepts(PUBLIC_HTTPS, "[::1]:3100")).toBe(true)
    })

    it("still rejects a loopback spelling on any other port", () => {
      expect(accepts(PUBLIC_HTTPS, "127.0.0.1:443")).toBe(false)
      expect(accepts(PUBLIC_HTTPS, "localhost:80")).toBe(false)
    })

    it("still rejects the public host on the process's own port, and any unrelated host", () => {
      expect(accepts(PUBLIC_HTTPS, "desde.acme.test:3100")).toBe(false)
      expect(accepts(PUBLIC_HTTPS, "evil.com:3100")).toBe(false)
    })

    it("applies to a serve-domain deployment too", () => {
      expect(accepts(WITH_SERVE_DOMAIN, "127.0.0.1:3100")).toBe(true)
      expect(accepts(WITH_SERVE_DOMAIN, "localhost:3100")).toBe(true)
      expect(accepts(WITH_SERVE_DOMAIN, "[::1]:3100")).toBe(true)
    })
  })

  /**
   * `config.port` is consulted in a second branch here too: a LOOPBACK `publicUrl`
   * with no explicit port. There `publicUrl` implies port 80 while the
   * process is really listening on `config.port`, and a browser that reached
   * this socket at all used that port — so accepting it costs nothing and
   * stops a `VIEWER_PUBLIC_URL=http://localhost` typo bricking the
   * deployment. It must NOT leak into any other branch.
   */
  describe("config.port fallback (loopback publicUrl with no explicit port)", () => {
    const IMPLICIT_LOOPBACK: Pick<ViewerConfig, "publicUrl" | "port" | "serveDomain" | "prototypeOrigin"> = {
      publicUrl: "http://localhost",
      port: 3100,
      serveDomain: null,
      prototypeOrigin: null,
    }

    it("accepts the listener's own port as well as the scheme default", () => {
      expect(accepts(IMPLICIT_LOOPBACK, "localhost:3100")).toBe(true)
      expect(accepts(IMPLICIT_LOOPBACK, "localhost:80")).toBe(true)
      expect(accepts(IMPLICIT_LOOPBACK, "localhost")).toBe(true)
    })

    it("extends the fallback to every loopback spelling", () => {
      expect(accepts(IMPLICIT_LOOPBACK, "127.0.0.1:3100")).toBe(true)
      expect(accepts(IMPLICIT_LOOPBACK, "[::1]:3100")).toBe(true)
    })

    it("is still a closed set — any other port loses", () => {
      expect(accepts(IMPLICIT_LOOPBACK, "localhost:9999")).toBe(false)
      expect(accepts(IMPLICIT_LOOPBACK, "localhost:443")).toBe(false)
    })

    it("is NOT applied to a non-loopback publicUrl with no explicit port", () => {
      expect(accepts(PUBLIC_HTTPS, "desde.acme.test:3100")).toBe(false)
      expect(accepts(PUBLIC_HTTPS, "desde.acme.test")).toBe(true)
      expect(accepts(PUBLIC_HTTPS, "desde.acme.test:443")).toBe(true)
    })

    it("is NOT applied when the loopback publicUrl names its port", () => {
      // LOOPBACK is `http://localhost:3100` with `port: 3100`; prove the
      // acceptance above comes from the explicit port, not this fallback
      // branch (`portSuffixesFor`'s "no explicit port" case, which cannot
      // fire here because publicUrl DOES name a port).
      const mismatched = { publicUrl: "http://localhost:3100", port: 9999, serveDomain: null }
      expect(accepts(mismatched, "localhost:3100")).toBe(true)
      // `localhost:9999` is ALSO now accepted — but not via this fallback.
      // It comes from task 4b's unconditional "the process's own port"
      // addition (see the describe block above), which fires regardless of
      // what publicUrl says. A port that is neither the explicit one (3100)
      // nor config.port (9999) is what actually isolates this fallback branch.
      expect(accepts(mismatched, "localhost:9999")).toBe(true)
      expect(accepts(mismatched, "localhost:1234")).toBe(false)
    })
  })

  describe("serve domain", () => {
    it("accepts a single slug label under the serve domain", () => {
      expect(accepts(WITH_SERVE_DOMAIN, "acme-proto.desde.acme.test")).toBe(true)
      expect(accepts(WITH_SERVE_DOMAIN, "acme-proto.desde.acme.test:443")).toBe(true)
    })

    it("still accepts the shell host itself", () => {
      expect(accepts(WITH_SERVE_DOMAIN, "desde.acme.test")).toBe(true)
    })

    it("is a suffix rule, not a substring one", () => {
      expect(accepts(WITH_SERVE_DOMAIN, "desde.acme.test.evil.com")).toBe(false)
      expect(accepts(WITH_SERVE_DOMAIN, "acme.desde.acme.test.evil.com")).toBe(false)
      expect(accepts(WITH_SERVE_DOMAIN, "xdesde.acme.test")).toBe(false)
    })

    it("allows only ONE label in front of the serve domain", () => {
      expect(accepts(WITH_SERVE_DOMAIN, "a.b.desde.acme.test")).toBe(false)
    })

    it("rejects a label that is not a valid slug", () => {
      expect(accepts(WITH_SERVE_DOMAIN, "-bad.desde.acme.test")).toBe(false)
      expect(accepts(WITH_SERVE_DOMAIN, "UPPER.desde.acme.test")).toBe(true) // lowercased first
      expect(accepts(WITH_SERVE_DOMAIN, "a.desde.acme.test")).toBe(false) // one char: too short
    })

    it("rejects an arbitrary port on a prototype host", () => {
      expect(accepts(WITH_SERVE_DOMAIN, "acme-proto.desde.acme.test:9999")).toBe(false)
      expect(accepts(WITH_SERVE_DOMAIN, "acme-proto.desde.acme.test:80")).toBe(false)
    })

    /**
     * The port rule is the SAME on a prototype host as on the shell host: the
     * suffix must be one `publicUrl` produces. A port-less Host is acceptable
     * only when `publicUrl` itself carries no explicit port.
     *
     * `prototypeOriginFor` (subdomain.ts) emits a port-less origin even when
     * `publicUrl` names a port, so on this deployment shape the product emits
     * an origin this allowlist refuses. That is a defect in
     * `prototypeOriginFor`, carried forward — not a reason for a second,
     * laxer port rule here.
     */
    it("compares the port on a prototype host when publicUrl names one", () => {
      const devSubdomain = {
        publicUrl: "http://localhost:3100",
        port: 3100,
        serveDomain: "proto.test",
      }
      expect(accepts(devSubdomain, "acme.proto.test:3100")).toBe(true)
      expect(accepts(devSubdomain, "acme.proto.test")).toBe(false)
      expect(accepts(devSubdomain, "acme.proto.test:80")).toBe(false)
      expect(accepts(devSubdomain, "acme.proto.test:9999")).toBe(false)
    })

    it("ignores the serve-domain rule when no serve domain is configured", () => {
      expect(isAllowedHost(buildHostAllowlist(LOOPBACK), "acme.proto.test", null)).toBe(false)
    })
  })

  /**
   * The allowlist a per-deployment loopback listener runs on. It replaced an
   * earlier `addRuntimeHost`/`removeRuntimeHost` pair that grew the MAIN
   * allowlist at runtime; that design is gone, because a listener turned out
   * to be a separate `http.Server` with an app of its own, so its Host never
   * reaches the main allowlist at all.
   */
  describe("buildSingleHostAllowlist", () => {
    it("accepts exactly the one host it was given", () => {
      const allowlist = buildSingleHostAllowlist("127.0.0.1:54321")
      expect(isAllowedHost(allowlist, "127.0.0.1:54321", null)).toBe(true)
      expect(isAllowedHost(allowlist, "127.0.0.1:54322", null)).toBe(false)
      expect(isAllowedHost(allowlist, "127.0.0.1", null)).toBe(false)
      expect(isAllowedHost(allowlist, "evil.example:54321", null)).toBe(false)
    })

    /**
     * The property that makes a listener an ORIGIN. `buildHostAllowlist`
     * expands a loopback host into all three spellings on purpose; a listener
     * must not inherit that, or the isolation the host flip buys would depend
     * on which name the browser happened to use.
     */
    it("never expands one loopback name into the other two", () => {
      const allowlist = buildSingleHostAllowlist("127.0.0.1:54321")
      expect(isAllowedHost(allowlist, "localhost:54321", null)).toBe(false)
      expect(isAllowedHost(allowlist, "[::1]:54321", null)).toBe(false)
    })

    it("normalizes its entry the way an inbound Host is normalized", () => {
      expect(isAllowedHost(buildSingleHostAllowlist("LocalHost:54321"), "localhost:54321", null)).toBe(true)
    })

    /**
     * A browser sends `[::1]:54321`, and only the already-bracketed entry
     * matches it. A bare `::1:54321` is NOT repaired — it is not a legal
     * `Host` value and cannot be split unambiguously, so it comes back
     * unchanged and matches nothing. That is the fail-closed outcome
     * `splitHostPort` documents, and it is why `loopback-listeners.ts`
     * brackets BEFORE joining the port rather than handing over a bare
     * `server.address().address`.
     */
    it("matches a bracketed IPv6 host, and does not repair an unbracketed one", () => {
      expect(isAllowedHost(buildSingleHostAllowlist("[::1]:54321"), "[::1]:54321", null)).toBe(true)
      expect(isAllowedHost(buildSingleHostAllowlist("::1:54321"), "[::1]:54321", null)).toBe(false)
    })

    /** No serve domain and no test relaxation reach a listener. */
    it("carries neither of this module's two widenings", () => {
      const allowlist = buildSingleHostAllowlist("127.0.0.1:54321")
      expect(allowlist.allowAnyLoopbackPort).toBe(false)
      expect(isAllowedHost(allowlist, "acme.proto.test:54321", "proto.test")).toBe(false)
    })

    /**
     * `normalizeHostPort` is exported so the listener app can normalize ONCE
     * and feed both its allowlist and its prototype-host predicate from the
     * same string. This pins that the two would agree.
     */
    it("exposes the same normalization its own entry went through", () => {
      expect(normalizeHostPort("LocalHost:54321")).toBe("localhost:54321")
      expect(normalizeHostPort(" 127.0.0.1:54321 ")).toBe("127.0.0.1:54321")
      expect(normalizeHostPort("[::1]:54321")).toBe("[::1]:54321")
      // No bracketing: an unbracketed IPv6 literal is not a legal Host and is
      // left to fail every comparison, rather than being guessed at.
      expect(normalizeHostPort("::1:54321")).toBe("::1:54321")
      // Whatever it produces, the allowlist admits — that equality is the
      // whole reason the listener app can normalize once and feed both rules.
      for (const raw of ["LocalHost:54321", "[::1]:54321", " 127.0.0.1:54321 "]) {
        expect(isAllowedHost(buildSingleHostAllowlist(raw), normalizeHostPort(raw), null), raw).toBe(true)
      }
    })
  })

  describe("allowAnyLoopbackPort (tests only)", () => {
    it("accepts any loopback spelling on any port", () => {
      const allowlist = buildHostAllowlist(PUBLIC_HTTPS, { allowAnyLoopbackPort: true })
      expect(isAllowedHost(allowlist, "127.0.0.1:54321", null)).toBe(true)
      expect(isAllowedHost(allowlist, "localhost:1", null)).toBe(true)
      expect(isAllowedHost(allowlist, "[::1]:65535", null)).toBe(true)
    })

    it("still rejects a non-loopback host and a non-numeric port", () => {
      const allowlist = buildHostAllowlist(PUBLIC_HTTPS, { allowAnyLoopbackPort: true })
      expect(isAllowedHost(allowlist, "evil.com:54321", null)).toBe(false)
      expect(isAllowedHost(allowlist, "127.0.0.1:54321 ", null)).toBe(false)
      expect(isAllowedHost(allowlist, "127.0.0.1:abc", null)).toBe(false)
    })

    it("is off by default", () => {
      expect(isAllowedHost(buildHostAllowlist(PUBLIC_HTTPS), "127.0.0.1:54321", null)).toBe(false)
    })
  })

  describe("assertNoTestHostRelaxation", () => {
    it("passes when the relaxation is absent or false", () => {
      expect(() => assertNoTestHostRelaxation({})).not.toThrow()
      expect(() => assertNoTestHostRelaxation({ allowAnyLoopbackPort: false })).not.toThrow()
    })

    it("throws when a real boot would enable it", () => {
      expect(() => assertNoTestHostRelaxation({ allowAnyLoopbackPort: true })).toThrow(
        /allowAnyLoopbackPort/,
      )
    })
  })
})

describe("createHostAllowlistMiddleware", () => {
  function run(host: string | undefined) {
    const middleware = createHostAllowlistMiddleware(buildHostAllowlist(LOOPBACK), null)
    const sent: { status?: number; body?: unknown } = {}
    let nexted = false
    const res = {
      status(code: number) {
        sent.status = code
        return this
      },
      json(body: unknown) {
        sent.body = body
        return this
      },
    }
    middleware(
      { headers: host === undefined ? {} : { host } } as never,
      res as never,
      (() => {
        nexted = true
      }) as never,
    )
    return { ...sent, nexted }
  }

  it("calls next() for an allowed host", () => {
    expect(run("localhost:3100")).toEqual({ nexted: true })
  })

  it("answers 400 with a constant body that never echoes the Host", () => {
    const denied = run("evil.com:3100")
    expect(denied.nexted).toBe(false)
    expect(denied.status).toBe(400)
    expect(denied.body).toEqual({ error: "Unexpected host" })
    expect(JSON.stringify(denied.body)).not.toContain("evil.com")
  })

  it("answers 400 for an absent Host", () => {
    const denied = run(undefined)
    expect(denied.nexted).toBe(false)
    expect(denied.status).toBe(400)
    expect(denied.body).toEqual({ error: "Unexpected host" })
  })
})

describe("mounted in createApp", () => {
  const nullAssets: AssetStore = {
    async put() {},
    async get() {
      return null
    },
    async deleteDeployment() {},
  }

  const config: ViewerConfig = {
    profile: "selfhost",
    port: 3100,
    dataDir: ".tmp",
    publicUrl: "http://localhost:3100",
    adminToken: null,
    serveDomain: null,
    devBundler: "turbopack",
    email: null,
    emailSource: null,
    unsubscribeSecret: null,
    sessionSecret: "test-session-secret",
    githubAuth: null,
    githubApp: null,
    prototypeCsp: null,
    prototypeOrigin: null,
    allowedEmailDomains: null,
    seedDemoProject: false,
    trustProxy: false,
    loopbackListeners: "auto",
    loopbackAvailable: true,
  }

  /** ONE stable app object for this file — see `__tests__/swappable-app.ts`. */
  const stable = createSwappableApp()
  stable.use(
    createApp({
      storage: new InMemoryStorage(),
      assets: nullAssets,
      config,
      bridgeScript: "// bridge",
      github: testGithubRuntime(),
    }),
  )

  it("refuses an unexpected Host before any route runs", async () => {
    const res = await request(stable.app).get("/api/v1/health").set("Host", "evil.com")
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: "Unexpected host" })
  })

  it("refuses an unexpected Host on a prototype path too", async () => {
    const res = await request(stable.app).get("/p/demo/index.html").set("Host", "evil.com:3100")
    expect(res.status).toBe(400)
  })

  it("lets an allowed Host through to the route", async () => {
    const res = await request(stable.app).get("/api/v1/health")
    expect(res.status).toBe(200)
  })
})
