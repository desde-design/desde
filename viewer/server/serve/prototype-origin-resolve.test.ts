import { describe, expect, it } from "vitest"
import {
  LOOPBACK_HOSTS,
  assertIsolatedOrigins,
  assertOriginConfig,
  assertPrototypeOriginConfig,
  loopbackBindHostFor,
  pairedLoopbackHost,
  resolveOrigins,
} from "./prototype-origin-resolve"

describe("LOOPBACK_HOSTS", () => {
  it("is the three loopback spellings a browser can use", () => {
    expect(LOOPBACK_HOSTS).toEqual(["localhost", "127.0.0.1", "[::1]"])
  })
})

describe("pairedLoopbackHost", () => {
  /**
   * Task 4b: changed to NUMERIC pairs. A listener (`loopback-listeners.ts`)
   * must bind an ADDRESS, never the name `localhost` — a browser is free to
   * resolve `localhost` to either `127.0.0.1` or `::1`, so a listener bound
   * to one of those addresses could be unreachable through the name if the
   * browser's resolver picked the other family. Task 4 originally paired
   * every numeric address back to `"localhost"`; that is superseded here.
   */
  it("pairs localhost with 127.0.0.1", () => {
    expect(pairedLoopbackHost("localhost")).toBe("127.0.0.1")
  })

  it("pairs 127.0.0.1 with [::1], not with localhost (task 4b: numeric pairs)", () => {
    expect(pairedLoopbackHost("127.0.0.1")).toBe("[::1]")
  })

  it("pairs [::1] with 127.0.0.1, not with localhost (task 4b: numeric pairs)", () => {
    expect(pairedLoopbackHost("[::1]")).toBe("127.0.0.1")
  })

  it("returns null for a non-loopback hostname", () => {
    expect(pairedLoopbackHost("desde.acme.test")).toBeNull()
  })
})

describe("loopbackBindHostFor", () => {
  /**
   * The sibling to `pairedLoopbackHost`: a caller derives WHICH loopback
   * name to use from `pairedLoopbackHost`, then calls this to get the
   * literal address `server.listen()` accepts (which wants a bare address,
   * not a Host-header spelling — no brackets).
   */
  it("strips the brackets from [::1]", () => {
    expect(loopbackBindHostFor("[::1]")).toBe("::1")
  })

  it("leaves 127.0.0.1 unchanged", () => {
    expect(loopbackBindHostFor("127.0.0.1")).toBe("127.0.0.1")
  })

  it("agrees with pairedLoopbackHost's non-null outputs end to end", () => {
    for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
      const paired = pairedLoopbackHost(hostname)
      expect(paired).not.toBeNull()
      // Every non-null pairedLoopbackHost output is a valid loopbackBindHostFor input.
      expect(() => loopbackBindHostFor(paired as "127.0.0.1" | "[::1]")).not.toThrow()
    }
  })
})

describe("resolveOrigins", () => {
  it("loopback shell on localhost:3100 pairs the prototype to 127.0.0.1", () => {
    expect(
      resolveOrigins({
        requestHost: "localhost:3100",
        hostAllowed: true,
        hostIsPrototype: false,
        publicUrl: "http://localhost:3100",
        serveDomain: null,
        loopbackAvailable: true,
      }),
    ).toEqual({
      mode: "loopback",
      shellOrigin: "http://localhost:3100",
      prototypeHost: "127.0.0.1",
    })
  })

  it("loopback shell on 127.0.0.1:3100 pairs the prototype to [::1] (task 4b: numeric pairs)", () => {
    expect(
      resolveOrigins({
        requestHost: "127.0.0.1:3100",
        hostAllowed: true,
        hostIsPrototype: false,
        publicUrl: "http://localhost:3100",
        serveDomain: null,
        loopbackAvailable: true,
      }),
    ).toEqual({
      mode: "loopback",
      shellOrigin: "http://127.0.0.1:3100",
      prototypeHost: "[::1]",
    })
  })

  it("loopback shell on [::1]:3100 pairs the prototype to 127.0.0.1 (task 4b: numeric pairs)", () => {
    expect(
      resolveOrigins({
        requestHost: "[::1]:3100",
        hostAllowed: true,
        hostIsPrototype: false,
        publicUrl: "http://localhost:3100",
        serveDomain: null,
        loopbackAvailable: true,
      }),
    ).toEqual({
      mode: "loopback",
      shellOrigin: "http://[::1]:3100",
      prototypeHost: "127.0.0.1",
    })
  })

  it("a non-allowed Host falls back to publicUrl for the shell origin", () => {
    const result = resolveOrigins({
      requestHost: "evil.com:9999",
      hostAllowed: false,
      hostIsPrototype: false,
      publicUrl: "https://desde.acme.test",
      serveDomain: null,
      loopbackAvailable: true,
    })
    expect(result).toEqual({
      mode: "fallback",
      shellOrigin: "https://desde.acme.test",
      prototypeHost: null,
    })
  })

  it("a non-allowed Host decides mode from publicUrl, not the request", () => {
    // The request host names a loopback spelling, but it was rejected by
    // the allowlist (hostAllowed: false), so it must not leak into the
    // mode decision. publicUrl is public, so mode is fallback.
    const result = resolveOrigins({
      requestHost: "localhost:3100",
      hostAllowed: false,
      hostIsPrototype: false,
      publicUrl: "https://desde.acme.test",
      serveDomain: null,
      loopbackAvailable: true,
    })
    expect(result.mode).toBe("fallback")
    expect(result.shellOrigin).toBe("https://desde.acme.test")
  })

  it("strips a trailing slash from publicUrl when it is used verbatim", () => {
    const result = resolveOrigins({
      requestHost: undefined,
      hostAllowed: false,
      hostIsPrototype: false,
      publicUrl: "https://desde.acme.test/",
      serveDomain: null,
      loopbackAvailable: true,
    })
    expect(result.shellOrigin).toBe("https://desde.acme.test")
  })

  it("is subdomain mode whenever serveDomain is set, even on a loopback shell", () => {
    const result = resolveOrigins({
      requestHost: "localhost:3100",
      hostAllowed: true,
      hostIsPrototype: false,
      publicUrl: "http://localhost:3100",
      serveDomain: "desde.test",
      loopbackAvailable: true,
    })
    expect(result.mode).toBe("subdomain")
    expect(result.prototypeHost).toBeNull()
  })

  it("is fallback mode for a public hostname with no serveDomain", () => {
    const result = resolveOrigins({
      requestHost: "desde.acme.test",
      hostAllowed: true,
      hostIsPrototype: false,
      publicUrl: "https://desde.acme.test",
      serveDomain: null,
      loopbackAvailable: true,
    })
    expect(result).toEqual({
      mode: "fallback",
      shellOrigin: "https://desde.acme.test",
      prototypeHost: null,
    })
  })

  it("lowercases the request Host before using it", () => {
    const result = resolveOrigins({
      requestHost: "LOCALHOST:3100",
      hostAllowed: true,
      hostIsPrototype: false,
      publicUrl: "http://localhost:3100",
      serveDomain: null,
      loopbackAvailable: true,
    })
    expect(result.shellOrigin).toBe("http://localhost:3100")
    expect(result.mode).toBe("loopback")
  })

  it("takes the scheme from publicUrl, never from the request", () => {
    // A loopback shell reached over https (e.g. behind a local TLS proxy):
    // the shellOrigin must still use https, since there is no reliable
    // scheme on the request itself behind a proxy. (The MODE such a shell
    // gets is a separate rule — see the https-loopback describe below.)
    const result = resolveOrigins({
      requestHost: "localhost:3100",
      hostAllowed: true,
      hostIsPrototype: false,
      publicUrl: "https://localhost:3100",
      serveDomain: null,
      loopbackAvailable: true,
    })
    expect(result.shellOrigin).toBe("https://localhost:3100")
  })

  /**
   * Hard requirement 7, the mixed-content rule.
   *
   * A per-deployment loopback listener is ALWAYS http: it binds a raw
   * ephemeral port, with no certificate and no name to put one on. A browser
   * blocks an http frame inside an https page as mixed content, and it does
   * so silently. `loopback-listeners.ts`'s `ensure` refuses a non-http shell
   * origin outright for exactly that reason — so reporting "loopback" for an
   * https shell would make every review a permanent 503 rather than a
   * degraded-but-working page.
   *
   * Fallback is the safe direction: it is the status quo path (`/p/{slug}/`
   * with its capability and sandbox), which works.
   */
  describe("an https loopback publicUrl cannot be loopback mode", () => {
    it("is fallback, with no prototype host, on an https loopback shell", () => {
      const result = resolveOrigins({
        requestHost: "localhost:3100",
        hostAllowed: true,
        hostIsPrototype: false,
        publicUrl: "https://localhost:3100",
        serveDomain: null,
        loopbackAvailable: true,
      })
      expect(result).toEqual({
        mode: "fallback",
        shellOrigin: "https://localhost:3100",
        prototypeHost: null,
      })
    })

    it("is fallback for every loopback spelling, not just the name", () => {
      for (const spelling of ["localhost:3100", "127.0.0.1:3100", "[::1]:3100"]) {
        const result = resolveOrigins({
          requestHost: spelling,
          hostAllowed: true,
          hostIsPrototype: false,
          publicUrl: "https://127.0.0.1:3100",
          serveDomain: null,
          loopbackAvailable: true,
        })
        expect(result.mode, spelling).toBe("fallback")
        expect(result.prototypeHost, spelling).toBeNull()
      }
    })

    it("still lets a serveDomain win — subdomain mode is https by design", () => {
      const result = resolveOrigins({
        requestHost: "localhost:3100",
        hostAllowed: true,
        hostIsPrototype: false,
        publicUrl: "https://localhost:3100",
        serveDomain: "desde.test",
        loopbackAvailable: true,
      })
      expect(result.mode).toBe("subdomain")
    })

    it("the same publicUrl over http IS loopback mode — the scheme is the only difference", () => {
      const result = resolveOrigins({
        requestHost: "localhost:3100",
        hostAllowed: true,
        hostIsPrototype: false,
        publicUrl: "http://localhost:3100",
        serveDomain: null,
        loopbackAvailable: true,
      })
      expect(result.mode).toBe("loopback")
      expect(result.prototypeHost).toBe("127.0.0.1")
    })
  })

  /**
   * Task 4b, the defect this task exists to close. Before this fix, a
   * request reaching a DEPLOYED instance on its own loopback address (the
   * internal `internalApiBaseUrl` fetch, or a curious human hitting
   * `127.0.0.1:<port>` directly on the box the process runs on) got treated
   * as if the shell itself were loopback: mode flipped to "loopback" and
   * shellOrigin became the request's Host, which is wrong — a deployed
   * instance reached on its own loopback address is still the deployed
   * shell. It must not flip into loopback mode (which would imply opening a
   * loopback prototype listener), and its bridge/CSP origins must stay the
   * public ones.
   */
  describe("a deployed instance reached on its own loopback address (the defect this task closes)", () => {
    it("stays fallback mode with the public shellOrigin, even though the request Host is allowed and loopback", () => {
      const result = resolveOrigins({
        requestHost: "127.0.0.1:3100",
        hostAllowed: true,
        hostIsPrototype: false,
        publicUrl: "https://desde.acme.test",
        serveDomain: null,
        loopbackAvailable: true,
      })
      expect(result).toEqual({
        mode: "fallback",
        shellOrigin: "https://desde.acme.test",
        prototypeHost: null,
      })
    })

    it("stays subdomain mode with the public shellOrigin, when a serveDomain is configured", () => {
      const result = resolveOrigins({
        requestHost: "127.0.0.1:3100",
        hostAllowed: true,
        hostIsPrototype: false,
        publicUrl: "https://desde.acme.test",
        serveDomain: "proto.acme.test",
        loopbackAvailable: true,
      })
      expect(result).toEqual({
        mode: "subdomain",
        shellOrigin: "https://desde.acme.test",
        prototypeHost: null,
      })
    })
  })

  /**
   * Task 4b, the second half: a LOOPBACK `publicUrl` with a serve domain
   * configured (the dev `/etc/hosts` setup). Here the request Host CAN be a
   * legitimate reason to trust it — but only when it names the shell, not
   * when it names a `{slug}.{serveDomain}` prototype host that the
   * allowlist happens to admit too. `slugFromHost` cannot be imported here
   * (this module stays import-free), so the caller passes `hostIsPrototype`
   * instead — it has the registry that already knows the answer.
   */
  describe("hostIsPrototype guards a loopback publicUrl with a serve domain", () => {
    it("does not let a serve-domain prototype Host become the shell origin", () => {
      const result = resolveOrigins({
        requestHost: "acme-proto.desde.test:3100",
        hostAllowed: true,
        hostIsPrototype: true,
        publicUrl: "http://localhost:3100",
        serveDomain: "desde.test",
        loopbackAvailable: true,
      })
      expect(result).toEqual({
        mode: "subdomain",
        shellOrigin: "http://localhost:3100",
        prototypeHost: null,
      })
    })

    it("still trusts the request Host for the shell's own loopback name", () => {
      // Same publicUrl/serveDomain as above, but the request names the
      // SHELL, not a prototype subdomain — hostIsPrototype: false.
      const result = resolveOrigins({
        requestHost: "127.0.0.1:3100",
        hostAllowed: true,
        hostIsPrototype: false,
        publicUrl: "http://localhost:3100",
        serveDomain: "desde.test",
        loopbackAvailable: true,
      })
      expect(result.shellOrigin).toBe("http://127.0.0.1:3100")
      expect(result.mode).toBe("subdomain")
    })
  })

  /**
   * The Docker/remote follow-up. A container reached through a published
   * port (`docker run -p 3100:3100`) with a default loopback `publicUrl`
   * would otherwise resolve to "loopback" mode — but the per-deployment
   * listener binds inside the CONTAINER's own loopback interface, which the
   * host browser cannot reach through the one published port. So this
   * branch is gated on the caller's `loopbackAvailable`: when it is
   * `false`, a shell that would have been loopback downgrades to
   * "fallback" instead, with no listener host to offer.
   */
  describe("loopbackAvailable gates the loopback branch (Docker/remote auto-fallback)", () => {
    it("downgrades a loopback shell to fallback when loopbackAvailable is false", () => {
      const result = resolveOrigins({
        requestHost: "localhost:3100",
        hostAllowed: true,
        hostIsPrototype: false,
        publicUrl: "http://localhost:3100",
        serveDomain: null,
        loopbackAvailable: false,
      })
      expect(result).toEqual({
        mode: "fallback",
        shellOrigin: "http://localhost:3100",
        prototypeHost: null,
      })
    })

    it("downgrades every loopback spelling, not just localhost", () => {
      for (const spelling of ["localhost:3100", "127.0.0.1:3100", "[::1]:3100"]) {
        const result = resolveOrigins({
          requestHost: spelling,
          hostAllowed: true,
          hostIsPrototype: false,
          publicUrl: "http://127.0.0.1:3100",
          serveDomain: null,
          loopbackAvailable: false,
        })
        expect(result.mode, spelling).toBe("fallback")
        expect(result.prototypeHost, spelling).toBeNull()
      }
    })

    it("stays loopback mode when loopbackAvailable is true (the existing behavior)", () => {
      const result = resolveOrigins({
        requestHost: "localhost:3100",
        hostAllowed: true,
        hostIsPrototype: false,
        publicUrl: "http://localhost:3100",
        serveDomain: null,
        loopbackAvailable: true,
      })
      expect(result.mode).toBe("loopback")
      expect(result.prototypeHost).toBe("127.0.0.1")
    })

    it("serveDomain still wins regardless of loopbackAvailable", () => {
      const result = resolveOrigins({
        requestHost: "localhost:3100",
        hostAllowed: true,
        hostIsPrototype: false,
        publicUrl: "http://localhost:3100",
        serveDomain: "desde.test",
        loopbackAvailable: false,
      })
      expect(result.mode).toBe("subdomain")
    })

    it("a non-loopback shell is fallback either way — loopbackAvailable is irrelevant outside the loopback branch", () => {
      const result = resolveOrigins({
        requestHost: "desde.acme.test",
        hostAllowed: true,
        hostIsPrototype: false,
        publicUrl: "https://desde.acme.test",
        serveDomain: null,
        loopbackAvailable: false,
      })
      expect(result.mode).toBe("fallback")
    })
  })
})

describe("resolveOrigins — prototype-origin mode (VIEWER_PROTOTYPE_ORIGIN)", () => {
  it("is prototype-origin mode when prototypeOrigin is set and no serveDomain, carrying the origin", () => {
    const result = resolveOrigins({
      requestHost: "app.example.com",
      hostAllowed: true,
      hostIsPrototype: false,
      publicUrl: "https://app.example.com",
      serveDomain: null,
      loopbackAvailable: true,
      prototypeOrigin: "https://proto.example.net",
    })
    expect(result).toEqual({
      mode: "prototype-origin",
      shellOrigin: "https://app.example.com",
      prototypeHost: null,
      prototypeOrigin: "https://proto.example.net",
    })
  })

  it("serveDomain wins over prototypeOrigin when both are set", () => {
    const result = resolveOrigins({
      requestHost: "app.example.com",
      hostAllowed: true,
      hostIsPrototype: false,
      publicUrl: "https://app.example.com",
      serveDomain: "proto.example.com",
      loopbackAvailable: true,
      prototypeOrigin: "https://proto.example.net",
    })
    expect(result.mode).toBe("subdomain")
    // No prototype-origin field is carried in a mode that is not prototype-origin.
    expect(result).not.toHaveProperty("prototypeOrigin")
  })

  it("prototypeOrigin beats loopback, even on a loopback shell (precedence: subdomain > prototypeOrigin > loopback)", () => {
    const result = resolveOrigins({
      requestHost: "localhost:3100",
      hostAllowed: true,
      hostIsPrototype: false,
      publicUrl: "http://localhost:3100",
      serveDomain: null,
      loopbackAvailable: true,
      prototypeOrigin: "http://proto.example.net:3100",
    })
    expect(result.mode).toBe("prototype-origin")
    expect(result.prototypeHost).toBeNull()
    expect(result.prototypeOrigin).toBe("http://proto.example.net:3100")
  })

  it("carries no prototype-origin field for loopback/subdomain/fallback modes", () => {
    for (const config of [
      { publicUrl: "http://localhost:3100", serveDomain: null }, // loopback
      { publicUrl: "https://app.example.com", serveDomain: "proto.example.com" }, // subdomain
      { publicUrl: "https://app.example.com", serveDomain: null }, // fallback
    ]) {
      const result = resolveOrigins({
        requestHost: undefined,
        hostAllowed: false,
        hostIsPrototype: false,
        publicUrl: config.publicUrl,
        serveDomain: config.serveDomain,
        loopbackAvailable: true,
      })
      expect(result, config.publicUrl).not.toHaveProperty("prototypeOrigin")
    }
  })
})

describe("assertPrototypeOriginConfig", () => {
  it("does nothing when prototypeOrigin is unset", () => {
    expect(() =>
      assertPrototypeOriginConfig({ publicUrl: "https://app.example.com", prototypeOrigin: null }),
    ).not.toThrow()
  })

  it("passes for a genuinely cross-site origin sharing the scheme", () => {
    expect(() =>
      assertPrototypeOriginConfig({
        publicUrl: "https://app.example.com",
        prototypeOrigin: "https://proto.example.net",
      }),
    ).not.toThrow()
  })

  it("throws when the prototype origin equals the shell origin (same-origin sandbox escape)", () => {
    expect(() =>
      assertPrototypeOriginConfig({
        publicUrl: "https://app.example.com",
        prototypeOrigin: "https://app.example.com",
      }),
    ).toThrow()
  })

  it("throws when the schemes differ (mixed content)", () => {
    expect(() =>
      assertPrototypeOriginConfig({
        publicUrl: "https://app.example.com",
        prototypeOrigin: "http://proto.example.net",
      }),
    ).toThrow()
  })

  it("throws when the two share a registrable domain (same-site cookie toss)", () => {
    expect(() =>
      assertPrototypeOriginConfig({
        publicUrl: "https://app.example.com",
        prototypeOrigin: "https://proto.example.com",
      }),
    ).toThrow(/VIEWER_PROTOTYPE_ORIGIN/)
  })

  it("throws same-site case-insensitively", () => {
    expect(() =>
      assertPrototypeOriginConfig({
        publicUrl: "https://App.Example.COM",
        prototypeOrigin: "https://Proto.Example.com",
      }),
    ).toThrow(/VIEWER_PROTOTYPE_ORIGIN/)
  })
})

describe("assertOriginConfig", () => {
  it("passes for a loopback publicUrl with no serveDomain", () => {
    expect(() => assertOriginConfig({ publicUrl: "http://localhost:3100", serveDomain: null })).not.toThrow()
  })

  it("passes for a public publicUrl with an unrelated serveDomain", () => {
    expect(() =>
      assertOriginConfig({ publicUrl: "https://app.acme.test", serveDomain: "proto.acme.test" }),
    ).not.toThrow()
  })

  it("throws when serveDomain equals publicUrl's hostname", () => {
    expect(() =>
      assertOriginConfig({ publicUrl: "https://desde.test", serveDomain: "desde.test" }),
    ).toThrow(/VIEWER_SERVE_DOMAIN/)
  })

  it("throws case-insensitively when serveDomain equals publicUrl's hostname", () => {
    expect(() =>
      assertOriginConfig({ publicUrl: "https://Desde.Test", serveDomain: "DESDE.TEST" }),
    ).toThrow()
  })

  it("throws when publicUrl's host itself parses as a {slug}.{serveDomain} host", () => {
    expect(() =>
      assertOriginConfig({ publicUrl: "https://app.desde.test", serveDomain: "desde.test" }),
    ).toThrow(/VIEWER_PUBLIC_URL/)
  })

  it("allows a serveDomain alongside a loopback publicUrl (dev /etc/hosts setup)", () => {
    expect(() =>
      assertOriginConfig({ publicUrl: "http://localhost:3100", serveDomain: "desde.test" }),
    ).not.toThrow()
  })

  it("does not throw on a merely similar hostname (no dot boundary)", () => {
    // "notdesde.test" ends with "desde.test" as a raw string, but not at a
    // label boundary, so it must not be treated as a {slug}.{serveDomain} host.
    expect(() =>
      assertOriginConfig({ publicUrl: "https://notdesde.test", serveDomain: "desde.test" }),
    ).not.toThrow()
  })
})

describe("assertIsolatedOrigins", () => {
  it("throws for identical origins", () => {
    expect(() => assertIsolatedOrigins("http://localhost:3100", "http://localhost:3100")).toThrow()
  })

  it("throws for identical origins that differ by a trailing slash", () => {
    expect(() => assertIsolatedOrigins("http://localhost:3100/", "http://localhost:3100")).toThrow()
  })

  it("throws for identical origins that differ by case", () => {
    expect(() => assertIsolatedOrigins("http://LOCALHOST:3100", "http://localhost:3100")).toThrow()
  })

  it("throws when schemes differ", () => {
    expect(() => assertIsolatedOrigins("http://localhost:3100", "https://localhost:3100")).toThrow()
  })

  it("passes for a genuinely distinct loopback pairing", () => {
    expect(() => assertIsolatedOrigins("http://localhost:3100", "http://127.0.0.1:45001")).not.toThrow()
  })
})
