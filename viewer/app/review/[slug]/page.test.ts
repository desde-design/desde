import { describe, expect, it } from "vitest"
import { SHELL_ORIGIN_HEADER } from "../../../server/serve/prototype-origin-resolve"
import {
  internalApiBaseUrl,
  internalProjectsFetchInit,
  internalPrototypeOriginFetchInit,
  readPrototypeOrigin,
  resolveReviewProject,
  reviewShellOrigin,
  type ProjectSummary,
} from "./page"

describe("internalApiBaseUrl", () => {
  // Fix round 1 (Phase 3b-1 Task 3 review): the base URL used to be built
  // from the inbound Host/X-Forwarded-Proto headers, which are
  // attacker-controlled — combined with forwarding the session cookie, a
  // poisoned Host header would have exfiltrated it. It must now be
  // independent of anything in the request: always loopback, on the
  // trusted configured port.
  it("is always loopback on the given port, with no dependency on any request header", () => {
    expect(internalApiBaseUrl(3100)).toBe("http://127.0.0.1:3100")
    expect(internalApiBaseUrl(8443)).toBe("http://127.0.0.1:8443")
  })
})

describe("internalProjectsFetchInit", () => {
  it("forwards the inbound session cookie as the Cookie header (Phase 3b-1 Task 3)", () => {
    const init = internalProjectsFetchInit("viewer_session=abc.def")
    expect(init.headers).toEqual({ cookie: "viewer_session=abc.def" })
    expect(init.cache).toBe("no-store")
  })

  it("omits the headers key entirely for an anonymous visitor (no Cookie header on the inbound request)", () => {
    const init = internalProjectsFetchInit(null)
    expect(init.headers).toBeUndefined()
    expect(init.cache).toBe("no-store")
  })
})

describe("internalPrototypeOriginFetchInit", () => {
  // The internal hop's own `Host` is `127.0.0.1:<config.port>`, which is
  // never the spelling the reviewer typed. So the shell states its origin in
  // a header the route validates against a closed set (see
  // `server/api/prototype-origin-routes.ts`). Sending it is not optional:
  // without it, a reviewer on `localhost` would be paired against the
  // internal hop's host instead of their own.
  it("states the shell origin in the validated header", () => {
    const init = internalPrototypeOriginFetchInit(null, "http://localhost:3100")
    expect(init.headers).toEqual({ [SHELL_ORIGIN_HEADER]: "http://localhost:3100" })
    expect(init.cache).toBe("no-store")
  })

  // Same reason the projects hop forwards it: the route runs the caller's own
  // read check, so an unforwarded cookie makes every signed-in reviewer look
  // anonymous and a private project 404s for its own members.
  it("forwards the inbound session cookie alongside the header", () => {
    const init = internalPrototypeOriginFetchInit("viewer_session=abc.def", "http://localhost:3100")
    expect(init.headers).toEqual({
      cookie: "viewer_session=abc.def",
      [SHELL_ORIGIN_HEADER]: "http://localhost:3100",
    })
  })

  // `fetch` stringifies a `null` header value into the literal string
  // `"null"`, so the key is omitted rather than sent empty — the same rule
  // `internalProjectsFetchInit` follows.
  it("omits the cookie key entirely for an anonymous visitor, keeping the header", () => {
    const init = internalPrototypeOriginFetchInit(null, "http://127.0.0.1:3100")
    expect(init.headers).not.toHaveProperty("cookie")
    expect(init.headers).toEqual({ [SHELL_ORIGIN_HEADER]: "http://127.0.0.1:3100" })
  })
})

describe("reviewShellOrigin", () => {
  const loopbackConfig = {
    publicUrl: "http://localhost:3100",
    port: 3100,
    serveDomain: null,
    loopbackAvailable: true,
    prototypeOrigin: null,
  }

  // The zero-config laptop case this whole per-request lookup exists for: a
  // reviewer may type any of the three loopback spellings, and the prototype
  // must be paired against the one they actually used.
  it("uses an allowlisted loopback Host, so a reviewer on 127.0.0.1 is not paired as if on localhost", () => {
    expect(reviewShellOrigin(loopbackConfig, "127.0.0.1:3100")).toBe("http://127.0.0.1:3100")
    expect(reviewShellOrigin(loopbackConfig, "localhost:3100")).toBe("http://localhost:3100")
  })

  // Trusting the request Host here is only safe because the allowlist has
  // already reduced it to a closed set. An unrecognised Host contributes
  // nothing: the answer is `publicUrl`, exactly as if no Host had been sent.
  it("falls back to publicUrl for a Host the allowlist does not admit", () => {
    expect(reviewShellOrigin(loopbackConfig, "evil.example.com")).toBe("http://localhost:3100")
    expect(reviewShellOrigin(loopbackConfig, "localhost:9999")).toBe("http://localhost:3100")
    expect(reviewShellOrigin(loopbackConfig, undefined)).toBe("http://localhost:3100")
  })

  // Task 4b's rule, restated at this call site: a DEPLOYED instance reached
  // on its own loopback address is still the deployed shell. Every review
  // page render makes an internal fetch from `127.0.0.1`, so this is not a
  // hypothetical Host — it is the common one.
  it("keeps the public origin on a deployed instance, even when reached on its own loopback address", () => {
    const deployed = {
      publicUrl: "https://desde.acme.test",
      port: 3100,
      serveDomain: null,
      loopbackAvailable: true,
      prototypeOrigin: null,
    }
    expect(reviewShellOrigin(deployed, "127.0.0.1:3100")).toBe("https://desde.acme.test")
    expect(reviewShellOrigin(deployed, "desde.acme.test")).toBe("https://desde.acme.test")
  })

  // `reviewShellOrigin` only ever returns the shellOrigin string, which does
  // not change with `loopbackAvailable` — the mode is what changes, and this
  // page reads mode from the separate prototype-origin route response, not
  // from this function. This test is here anyway, to pin that
  // `loopbackAvailable` threading through this call site at least does not
  // change `shellOrigin` itself (it must not: the shell's own origin is
  // still `publicUrl` either way).
  it("loopbackAvailable does not change the resolved shellOrigin itself", () => {
    const containerConfig = {
      publicUrl: "http://localhost:3100",
      port: 3100,
      serveDomain: null,
      loopbackAvailable: false,
      prototypeOrigin: null,
    }
    expect(reviewShellOrigin(containerConfig, "localhost:3100")).toBe("http://localhost:3100")
  })
})

describe("readPrototypeOrigin", () => {
  it("passes a well-formed loopback answer through", () => {
    expect(
      readPrototypeOrigin({
        mode: "loopback",
        origin: "http://127.0.0.1:45001",
        capabilityRequired: false,
      }),
    ).toEqual({ mode: "loopback", origin: "http://127.0.0.1:45001" })
  })

  it("passes a well-formed subdomain answer through", () => {
    expect(
      readPrototypeOrigin({
        mode: "subdomain",
        origin: "https://acme.desde.test",
        capabilityRequired: true,
      }),
    ).toEqual({ mode: "subdomain", origin: "https://acme.desde.test" })
  })

  it("keeps the null origin of a loopback project with nothing built", () => {
    expect(
      readPrototypeOrigin({
        mode: "loopback",
        origin: null,
        capabilityRequired: false,
        reason: "no-deployment",
      }),
    ).toEqual({ mode: "loopback", origin: null })
  })

  it("passes a fallback answer through unchanged", () => {
    expect(readPrototypeOrigin({ mode: "fallback", origin: null, capabilityRequired: true })).toEqual({
      mode: "fallback",
      origin: null,
    })
  })

  // Every unrecognised shape lands on fallback, which `resolvePrototypeEmbed`
  // then turns into today's sandboxed same-host embed. Failing closed matters
  // here because the alternative direction — inventing an isolated origin from
  // a shape we do not understand — is what would hand `allow-same-origin` to a
  // frame nobody vouched for.
  it.each([
    ["an unknown mode", { mode: "elsewhere", origin: "http://127.0.0.1:45001" }],
    ["a non-string origin", { mode: "loopback", origin: 45001 }],
    ["a missing mode", { origin: "http://127.0.0.1:45001" }],
    ["a bare string", "loopback"],
    ["null", null],
    ["an array", []],
  ])("falls back for %s", (_label, value) => {
    expect(readPrototypeOrigin(value)).toEqual({ mode: "fallback", origin: null })
  })
})

describe("resolveReviewProject", () => {
  const deployed: ProjectSummary = {
    id: "p1",
    slug: "acme",
    name: "Acme",
    activeDeploymentId: "d1",
    access: "public-link",
  }
  const undeployed: ProjectSummary = {
    id: "p2",
    slug: "no-deploy",
    name: "NoDeploy",
    activeDeploymentId: null,
    access: "public-link",
  }

  it("finds a readable, deployed project by slug", () => {
    expect(resolveReviewProject([deployed], "acme")).toEqual({ kind: "ok", project: deployed })
  })

  it("reports not-found for a slug absent from the (already access-filtered) list — the unreadable/nonexistent case", () => {
    // `GET /api/v1/projects` filters out unreadable projects server-side
    // (see projects-routes.ts), so from this function's perspective an
    // `invited` project the caller can't read is indistinguishable from
    // one that never existed — both are simply absent from `projects`.
    expect(resolveReviewProject([deployed], "locked")).toEqual({ kind: "not-found" })
  })

  it("reports no-deployment, NOT not-found, for a readable project nobody has built", () => {
    // This is the change of 2026-09-01. It used to collapse into the same
    // null as the unreadable case, so a project you were entitled to see
    // 404'd because nobody had built it, and the dashboard had to render its
    // card disabled. A disabled control says "you are not allowed"; the truth
    // was "there is nothing here yet".
    expect(resolveReviewProject([undeployed], "no-deploy")).toEqual({
      kind: "no-deployment",
      project: undeployed,
    })
  })

  it("never reports no-deployment for a slug that is not in the list", () => {
    // The security guard, and the reason this function checks absence FIRST.
    // An undeployed project sitting in the list must not tempt a future
    // refactor into answering "no-deployment" for some OTHER slug: that would
    // confirm the existence of a project the caller was never shown, which is
    // exactly what the byte-identical 404 exists to prevent.
    expect(resolveReviewProject([undeployed], "locked")).toEqual({ kind: "not-found" })
    expect(resolveReviewProject([], "no-deploy")).toEqual({ kind: "not-found" })
  })
})
