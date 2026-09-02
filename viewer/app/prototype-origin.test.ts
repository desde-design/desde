import { describe, expect, it } from "vitest"
import {
  CROSS_ORIGIN_IFRAME_SANDBOX,
  PATH_MODE_IFRAME_SANDBOX,
  prototypeAnonymouslyReadable,
  prototypeEmbedOrigin,
  prototypeHref,
  resolvePrototypeEmbed,
  type PrototypeEmbedTarget,
  type PrototypeTarget,
} from "./prototype-origin"

/**
 * Pins the three halves of security-audit findings B1, B2 and S8, plus the
 * measured constraint that bounds them:
 *
 * - S8: `VIEWER_SERVE_DOMAIN` was configurable, documented as "hard
 *   isolation", and completely inert — `prototypeOriginFor` had zero
 *   callers and both shell surfaces hardcoded `/p/{slug}/`.
 * - B1/B2: where the prototype is unavoidably same-origin, the review
 *   iframe must be sandboxed, and specifically must NOT carry
 *   `allow-same-origin` (nor `allow-popups`).
 * - The bound: isolating the prototype — by subdomain OR by sandbox — stops
 *   the reviewer's `SameSite=Lax` session cookie reaching its subresources
 *   (measured in Chromium, with an unsandboxed control), and
 *   `/p/{slug}/**` is authorization-gated per request. So isolation applies
 *   only where the assets load anonymously. See the module doc.
 */
const SHELL = "https://viewer.example.com"

/** A `public-link` prototype: its assets need no session cookie. */
function open(over: Partial<PrototypeTarget> = {}): PrototypeTarget {
  return {
    slug: "acme",
    serveDomain: null,
    publicUrl: SHELL,
    anonymouslyReadable: true,
    ...over,
  }
}

/** A `members` prototype with members: every asset read needs the cookie. */
function locked(over: Partial<PrototypeTarget> = {}): PrototypeTarget {
  return open({ anonymouslyReadable: false, ...over })
}

/**
 * A resolved embed target — the shape a server-resolved
 * `PrototypeOriginResponse` (Task 6) plus the shell's own origin would
 * produce. Defaults to a loopback happy path so each test only overrides
 * what it is actually testing.
 */
function embed(over: Partial<PrototypeEmbedTarget> = {}): PrototypeEmbedTarget {
  return {
    slug: "acme",
    shellOrigin: "http://localhost:45001",
    prototypeOrigin: "http://127.0.0.1:45001",
    mode: "loopback",
    capability: null,
    anonymouslyReadable: true,
    ...over,
  }
}

describe("prototypeAnonymouslyReadable", () => {
  it("is true for a public-link project when the instance allows public links", () => {
    expect(prototypeAnonymouslyReadable("public-link", true)).toBe(true)
  })

  // The kill switch (Milestone 2): with it off, a "public-link" project
  // behaves exactly like "all-members" — readable, but only once signed in.
  it("is false for a public-link project when the instance kill switch is off", () => {
    expect(prototypeAnonymouslyReadable("public-link", false)).toBe(false)
  })

  it("is false for an all-members project regardless of the kill switch", () => {
    expect(prototypeAnonymouslyReadable("all-members", true)).toBe(false)
    expect(prototypeAnonymouslyReadable("all-members", false)).toBe(false)
  })

  it("is false for an invited project regardless of the kill switch", () => {
    expect(prototypeAnonymouslyReadable("invited", true)).toBe(false)
    expect(prototypeAnonymouslyReadable("invited", false)).toBe(false)
  })
})

describe("prototypeHref", () => {
  it("stays on the shell's own path prefix in path mode (no serve domain)", () => {
    expect(prototypeHref(open())).toBe("/p/acme/")
  })

  it("moves the prototype to its own origin when a serve domain is configured", () => {
    expect(prototypeHref(open({ serveDomain: "proto.example.com" }))).toBe(
      "https://acme.proto.example.com/",
    )
  })

  it("carries the shell's scheme onto the isolated origin (http for a local deployment)", () => {
    // Task 11: the isolated origin also carries `publicUrl`'s EXPLICIT port.
    // A dev deployment on `http://localhost:3100` reaches the prototype at
    // `{slug}.{serveDomain}:3100`, and the Host allowlist compares that port —
    // a port-less origin would be refused with a 400 before routing.
    expect(
      prototypeHref(open({ serveDomain: "127.0.0.1.nip.io", publicUrl: "http://localhost:3100" })),
    ).toBe("http://acme.127.0.0.1.nip.io:3100/")
  })

  it("stays port-less when publicUrl carries no explicit port", () => {
    // `https://acme.proto.example.com` on a default-port (443) deployment: the
    // URL API drops a scheme-default port, so the origin is port-less, which is
    // exactly what the allowlist accepts for a no-explicit-port publicUrl.
    expect(prototypeHref(open({ serveDomain: "proto.example.com" }))).toBe(
      "https://acme.proto.example.com/",
    )
  })

  it("treats an empty serve domain as unset rather than emitting a dangling-dot hostname", () => {
    expect(prototypeHref(open({ serveDomain: "" }))).toBe("/p/acme/")
  })

  // The session cookie is host-only (no `Domain` attribute), so it is never
  // sent to `{slug}.{serveDomain}` — `server/serve/subdomain.ts` names that
  // as the point of the mode. Sending a cookie-gated prototype there would
  // 404 its HTML outright.
  //
  // Task 7 (the fail-closed iframe resolver) does NOT touch this function.
  // `prototypeHref` backs a top-level, same-tab navigation (the dashboard's
  // "Open" link), not the review iframe, and a link copied out of the
  // address bar has nowhere to carry a capability token the way the iframe
  // now can — so it keeps the old, simpler rule: isolate only when the
  // prototype needs no credential at all. This row still asserts exactly
  // what it asserted before Task 7.
  it("does NOT use the isolated origin for a prototype whose assets need the session cookie", () => {
    expect(prototypeHref(locked({ serveDomain: "proto.example.com" }))).toBe("/p/acme/")
  })
})

describe("PATH_MODE_IFRAME_SANDBOX", () => {
  it("omits allow-same-origin from the path-mode sandbox — the token the containment depends on", () => {
    // Adding `allow-same-origin` would keep the iframe in the viewer's
    // origin and restore the whole B1 attack path (prototype JS reaching
    // `window.parent` and minting a `dsv_` token as the reviewer), while
    // leaving the attribute superficially "present". Assert the absence,
    // not just the presence.
    const tokens = PATH_MODE_IFRAME_SANDBOX.split(" ")
    expect(tokens).not.toContain("allow-same-origin")
    // `allow-popups` is the `window.open('/api/v1/…')` lane (B2);
    // `allow-top-navigation` would let a prototype redirect the reviewer's
    // whole tab. Both stay out.
    expect(tokens).not.toContain("allow-popups")
    expect(tokens).not.toContain("allow-top-navigation")
    expect(tokens).toContain("allow-scripts")
  })
})

describe("CROSS_ORIGIN_IFRAME_SANDBOX", () => {
  // Pinned as a literal string, not just "contains these tokens": adding a
  // fourth token silently would be exactly the kind of drift this constant
  // exists to prevent. See its doc comment for why each denied token is
  // denied, and why `allow-same-origin` is safe here ONLY because
  // `resolvePrototypeEmbed` has already confirmed the origins differ.
  it("is exactly the three cross-origin tokens, nothing else, ever", () => {
    expect(CROSS_ORIGIN_IFRAME_SANDBOX).toBe("allow-scripts allow-forms allow-same-origin")
  })
})

describe("resolvePrototypeEmbed", () => {
  describe("fail-closed: an equal or unusable prototype origin always falls back", () => {
    // The load-bearing case. `mode: "loopback"` says an origin to isolate
    // toward exists, but it turns out to BE the shell's own origin. If this
    // fell through to the cross-origin branch anyway, the sandbox would
    // carry `allow-same-origin` toward a SAME-origin frame — the classic
    // sandbox escape (the frame removes its own `sandbox` attribute from
    // the parent DOM and reloads). This check has to run before the mode
    // switch, not after, so no mode can ever reach that branch.
    it("falls back when prototypeOrigin is exactly equal to shellOrigin", () => {
      const result = resolvePrototypeEmbed(embed({ shellOrigin: SHELL, prototypeOrigin: SHELL }))
      expect(result.src).toBe("/p/acme/")
      expect(result.sandbox).toBe(PATH_MODE_IFRAME_SANDBOX)
    })

    it("falls back when the two origins differ only by a trailing slash", () => {
      const result = resolvePrototypeEmbed(
        embed({ shellOrigin: "http://localhost:3100", prototypeOrigin: "http://localhost:3100/" }),
      )
      expect(result.src).toBe("/p/acme/")
      expect(result.sandbox).toBe(PATH_MODE_IFRAME_SANDBOX)
    })

    it("falls back when the two origins differ only by case", () => {
      const result = resolvePrototypeEmbed(
        embed({ shellOrigin: "http://localhost:3100", prototypeOrigin: "HTTP://LOCALHOST:3100" }),
      )
      expect(result.src).toBe("/p/acme/")
      expect(result.sandbox).toBe(PATH_MODE_IFRAME_SANDBOX)
    })

    it("falls back when the two origins are equal once a default port is dropped", () => {
      const result = resolvePrototypeEmbed(
        embed({ shellOrigin: "https://desde.test", prototypeOrigin: "https://desde.test:443" }),
      )
      expect(result.src).toBe("/p/acme/")
      expect(result.sandbox).toBe(PATH_MODE_IFRAME_SANDBOX)
    })

    it("falls back when prototypeOrigin is null, even in loopback mode", () => {
      const result = resolvePrototypeEmbed(embed({ mode: "loopback", prototypeOrigin: null }))
      expect(result.src).toBe("/p/acme/")
      expect(result.sandbox).toBe(PATH_MODE_IFRAME_SANDBOX)
    })

    it("falls back when prototypeOrigin does not parse as a URL", () => {
      const result = resolvePrototypeEmbed(embed({ prototypeOrigin: "not a url" }))
      expect(result.src).toBe("/p/acme/")
      expect(result.sandbox).toBe(PATH_MODE_IFRAME_SANDBOX)
    })

    it("mode 'fallback' always uses the path prefix, even when a different, resolvable origin is present", () => {
      const result = resolvePrototypeEmbed(
        embed({ mode: "fallback", prototypeOrigin: "http://127.0.0.1:45001" }),
      )
      expect(result.src).toBe("/p/acme/")
      expect(result.sandbox).toBe(PATH_MODE_IFRAME_SANDBOX)
    })
  })

  // Moved here when `prototypeIframeProps` was deleted (Task 8): these two
  // rows are about what fallback mode does with the CAPABILITY, which is a
  // different question from the fail-closed group above.
  describe("fallback mode", () => {
    // MEASURED (Chromium, with an identical unsandboxed control on a second
    // navigation): an opaque origin has a null site-for-cookies, so the
    // iframe's own document request still carries `viewer_session` but every
    // subresource request does not. `/p/{slug}/**` authorizes per request —
    // the JS bundle, the CSS and the bridge bundle all 404 for a non-member —
    // so sandboxing here would serve the HTML and then blank the page.
    it("does NOT sandbox a prototype whose assets need the session cookie and has no capability", () => {
      const result = resolvePrototypeEmbed(
        embed({ mode: "fallback", prototypeOrigin: null, anonymouslyReadable: false, capability: null }),
      )
      expect(result.src).toBe("/p/acme/")
      expect(result.sandbox).toBeUndefined()
    })

    // The capability is what makes the sandbox affordable for a private
    // prototype: every relative subresource inherits the `~c` path segment,
    // so nothing depends on the cookie the opaque origin drops.
    it("carries the capability in the path prefix and sandboxes on it", () => {
      const result = resolvePrototypeEmbed(
        embed({
          mode: "fallback",
          prototypeOrigin: null,
          anonymouslyReadable: false,
          capability: "tok123",
        }),
      )
      expect(result.src).toContain("tok123")
      expect(result.sandbox).toBe(PATH_MODE_IFRAME_SANDBOX)
    })

    // The property under test is the ORIGIN, not the string: a relative
    // `/p/acme/` resolves back to the shell origin at load time, which is
    // exactly the S8 defect this whole module exists to close.
    it("resolves back to the SHELL origin — which is why the sandbox above is mandatory", () => {
      const result = resolvePrototypeEmbed(embed({ mode: "fallback", prototypeOrigin: null }))
      expect(new URL(result.src, SHELL).origin).toBe(new URL(SHELL).origin)
    })
  })

  describe("loopback mode", () => {
    it("embeds the paired loopback origin, sandboxed, with no capability anywhere in the URL", () => {
      const result = resolvePrototypeEmbed(
        embed({
          shellOrigin: "http://localhost:45001",
          prototypeOrigin: "http://127.0.0.1:45001",
          mode: "loopback",
          // The listener itself is the credential in loopback mode — a
          // capability present here must be ignored, not appended.
          capability: "should-be-ignored",
          anonymouslyReadable: false,
        }),
      )
      expect(result.src).toBe("http://127.0.0.1:45001/")
      expect(result.sandbox).toBe(CROSS_ORIGIN_IFRAME_SANDBOX)
      expect(result.src).not.toContain("~c")
    })
  })

  describe("prototype-origin mode (VIEWER_PROTOTYPE_ORIGIN)", () => {
    const PROTO = "https://proto.example.net"

    it("carries the capability as a `~c` PATH segment on a private prototype", () => {
      const result = resolvePrototypeEmbed(
        embed({
          shellOrigin: SHELL,
          mode: "prototype-origin",
          prototypeOrigin: PROTO,
          anonymouslyReadable: false,
          capability: "tok123",
        }),
      )
      // Path-namespaced under /p/{slug}/ on the shared origin, with the
      // capability in the PATH (never a query or cookie).
      expect(result.src).toBe("https://proto.example.net/p/acme/~c/tok123/")
      expect(result.sandbox).toBe(CROSS_ORIGIN_IFRAME_SANDBOX)
    })

    it("carries no `~c` on a publicly readable prototype", () => {
      const result = resolvePrototypeEmbed(
        embed({
          shellOrigin: SHELL,
          mode: "prototype-origin",
          prototypeOrigin: PROTO,
          anonymouslyReadable: true,
          capability: null,
        }),
      )
      expect(result.src).toBe("https://proto.example.net/p/acme/")
      expect(result.src).not.toContain("~c")
      expect(result.sandbox).toBe(CROSS_ORIGIN_IFRAME_SANDBOX)
    })

    it("puts the prototype on an origin DIFFERENT from the shell's", () => {
      const result = resolvePrototypeEmbed(
        embed({
          shellOrigin: SHELL,
          mode: "prototype-origin",
          prototypeOrigin: PROTO,
          anonymouslyReadable: true,
        }),
      )
      expect(new URL(result.src, SHELL).origin).not.toBe(new URL(SHELL).origin)
      expect(new URL(result.src, SHELL).origin).toBe(PROTO)
    })

    it("falls back when private and no capability was minted", () => {
      const result = resolvePrototypeEmbed(
        embed({
          shellOrigin: SHELL,
          mode: "prototype-origin",
          prototypeOrigin: PROTO,
          anonymouslyReadable: false,
          capability: null,
        }),
      )
      // Same-host path prefix, uncontained — the honest degradation.
      expect(result.src).toBe("/p/acme/")
      expect(result.sandbox).toBeUndefined()
    })

    it("fails closed to the path prefix when the resolved origin equals the shell's", () => {
      const result = resolvePrototypeEmbed(
        embed({
          shellOrigin: SHELL,
          mode: "prototype-origin",
          prototypeOrigin: SHELL,
          anonymouslyReadable: true,
          capability: null,
        }),
      )
      // Never emit CROSS_ORIGIN_IFRAME_SANDBOX toward a same-origin frame.
      expect(new URL(result.src, SHELL).origin).toBe(new URL(SHELL).origin)
      expect(result.sandbox).toBe(PATH_MODE_IFRAME_SANDBOX)
    })
  })

  describe("subdomain mode", () => {
    it("carries the capability as a `~c` query on a private prototype", () => {
      const result = resolvePrototypeEmbed(
        embed({
          mode: "subdomain",
          prototypeOrigin: "https://acme.proto.example.com",
          anonymouslyReadable: false,
          capability: "tok123",
        }),
      )
      expect(result.src).toBe("https://acme.proto.example.com/?~c=tok123")
      expect(result.sandbox).toBe(CROSS_ORIGIN_IFRAME_SANDBOX)
    })

    it("carries no query on a publicly readable prototype", () => {
      const result = resolvePrototypeEmbed(
        embed({
          mode: "subdomain",
          prototypeOrigin: "https://acme.proto.example.com",
          anonymouslyReadable: true,
          capability: null,
        }),
      )
      expect(result.src).toBe("https://acme.proto.example.com/")
      expect(result.sandbox).toBe(CROSS_ORIGIN_IFRAME_SANDBOX)
    })

    // Asserted as an ORIGIN comparison rather than a string match, because
    // that is the property finding S8 was about: the shell used to emit a
    // relative URL that resolved straight back to its own origin.
    it("puts the prototype on an origin DIFFERENT from the shell's", () => {
      const result = resolvePrototypeEmbed(
        embed({
          shellOrigin: SHELL,
          mode: "subdomain",
          prototypeOrigin: "https://acme.proto.example.com",
          anonymouslyReadable: true,
        }),
      )
      expect(new URL(result.src, SHELL).origin).not.toBe(new URL(SHELL).origin)
      expect(new URL(result.src, SHELL).origin).toBe("https://acme.proto.example.com")
    })

    // The server would 404 the document itself: there is no cookie on this
    // origin (host-only, never sent cross-host) and no capability to
    // authorize the request without one. Same-host is the honest
    // degradation — it serves SOMETHING, even if uncontained, rather than a
    // blank review surface.
    it("falls back when private and no capability was minted", () => {
      const result = resolvePrototypeEmbed(
        embed({
          mode: "subdomain",
          prototypeOrigin: "https://acme.proto.example.com",
          anonymouslyReadable: false,
          capability: null,
        }),
      )
      expect(result.src).toBe("/p/acme/")
      expect(result.sandbox).toBeUndefined()
    })
  })
})

describe("prototypeEmbedOrigin", () => {
  /*
   * The one guarantee this function exists for: it can never disagree with
   * `resolvePrototypeEmbed`, because it is DERIVED from that function's own
   * answer rather than re-deciding the same question.
   *
   * That matters because the shell pins its postMessage target to this
   * origin. If the two ever disagreed the failure would be silent and total:
   * a pinned target against an opaque frame drops every message, so the
   * bridge is never configured and the review surface is dead on arrival —
   * the same class of failure the missing BRIDGE_READY ping produced.
   */
  it("is the isolated origin whenever the embed actually uses one", () => {
    expect(
      prototypeEmbedOrigin(
        embed({
          shellOrigin: "http://localhost:45001",
          prototypeOrigin: "http://127.0.0.1:45001",
          mode: "loopback",
        }),
      ),
    ).toBe("http://127.0.0.1:45001")

    expect(
      prototypeEmbedOrigin(
        embed({
          mode: "subdomain",
          prototypeOrigin: "https://acme.proto.example.com",
          anonymouslyReadable: false,
          capability: "tok123",
        }),
      ),
    ).toBe("https://acme.proto.example.com")
  })

  it("is null whenever the embed fell back to the shell's own path prefix", () => {
    // Plain fallback mode.
    expect(prototypeEmbedOrigin(embed({ mode: "fallback", prototypeOrigin: null }))).toBeNull()
    // Isolated mode, but nothing built yet — the answer the loopback route
    // gives for a project with no active deployment.
    expect(prototypeEmbedOrigin(embed({ mode: "loopback", prototypeOrigin: null }))).toBeNull()
    // Isolated mode, but the origin IS the shell's — the fail-closed case.
    expect(
      prototypeEmbedOrigin(embed({ shellOrigin: SHELL, prototypeOrigin: SHELL, mode: "loopback" })),
    ).toBeNull()
    // Subdomain, private, no capability to authorize the document load.
    expect(
      prototypeEmbedOrigin(
        embed({
          mode: "subdomain",
          prototypeOrigin: "https://acme.proto.example.com",
          anonymouslyReadable: false,
          capability: null,
        }),
      ),
    ).toBeNull()
  })

  it("never leaks the capability into the origin it reports", () => {
    const origin = prototypeEmbedOrigin(
      embed({
        mode: "subdomain",
        prototypeOrigin: "https://acme.proto.example.com",
        anonymouslyReadable: false,
        capability: "tok123",
      }),
    )
    expect(origin).not.toContain("tok123")
    expect(origin).not.toContain("?")
  })
})
