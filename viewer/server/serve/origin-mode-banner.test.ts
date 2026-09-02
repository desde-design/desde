import { describe, expect, it } from "vitest"
import { originModeBannerLines } from "./origin-mode-banner"

describe("originModeBannerLines", () => {
  it("loopback: names the paired host and the literal <ephemeral> port", () => {
    expect(
      originModeBannerLines({
        publicUrl: "http://localhost:3100",
        serveDomain: null,
        loopbackAvailable: true,
      }),
    ).toEqual({
      mode: "loopback",
      lines: [
        "[viewer] prototypes are served from the other loopback name on an ephemeral port " +
          "(shell=http://localhost:3100 prototypes=http://127.0.0.1:<ephemeral>)",
        "[viewer] Loopback prototype listeners are reachable only from a browser on this same host. " +
          "A containerized or remote deployment should set VIEWER_SERVE_DOMAIN, or a non-loopback VIEWER_PUBLIC_URL.",
      ],
    })
  })

  it("loopback: pairs 127.0.0.1 with [::1] (numeric pairing, task 4b)", () => {
    expect(
      originModeBannerLines({
        publicUrl: "http://127.0.0.1:3100",
        serveDomain: null,
        loopbackAvailable: true,
      }),
    ).toEqual({
      mode: "loopback",
      lines: [
        "[viewer] prototypes are served from the other loopback name on an ephemeral port " +
          "(shell=http://127.0.0.1:3100 prototypes=http://[::1]:<ephemeral>)",
        "[viewer] Loopback prototype listeners are reachable only from a browser on this same host. " +
          "A containerized or remote deployment should set VIEWER_SERVE_DOMAIN, or a non-loopback VIEWER_PUBLIC_URL.",
      ],
    })
  })

  it("subdomain: names the configured serve domain, scheme taken from publicUrl", () => {
    expect(
      originModeBannerLines({
        publicUrl: "https://desde.example.com",
        serveDomain: "proto.example.com",
        loopbackAvailable: true,
      }),
    ).toEqual({
      mode: "subdomain",
      lines: [
        "[viewer] prototypes are served on their own subdomain: https://{slug}.proto.example.com",
      ],
    })
  })

  it("subdomain wins over loopback even when the shell itself is loopback", () => {
    expect(
      originModeBannerLines({
        publicUrl: "http://localhost:3100",
        serveDomain: "proto.test",
        loopbackAvailable: true,
      }),
    ).toEqual({
      mode: "subdomain",
      lines: ["[viewer] prototypes are served on their own subdomain: http://{slug}.proto.test"],
    })
  })

  it("fallback: the exact two-line warning, verbatim", () => {
    expect(
      originModeBannerLines({
        publicUrl: "https://desde.example.com",
        serveDomain: null,
        loopbackAvailable: true,
      }),
    ).toEqual({
      mode: "fallback",
      lines: [
        "[viewer] Prototypes built with a root-absolute asset base will not fully load for signed-in members in this mode.",
        "[viewer] Fix: set VIEWER_SERVE_DOMAIN (one wildcard DNS record), or build prototypes with a relative base.",
      ],
    })
  })

  it("fallback: a non-loopback http host with no serve domain also falls back", () => {
    expect(
      originModeBannerLines({
        publicUrl: "http://10.0.0.5:3100",
        serveDomain: null,
        loopbackAvailable: true,
      }).mode,
    ).toBe("fallback")
  })

  describe("prototype-origin (VIEWER_PROTOTYPE_ORIGIN)", () => {
    it("names the single shared origin, the cost, and that subdomain mode is stronger", () => {
      const banner = originModeBannerLines({
        publicUrl: "https://app.example.com",
        serveDomain: null,
        loopbackAvailable: true,
        prototypeOrigin: "https://proto.example.net",
      })
      expect(banner.mode).toBe("prototype-origin")
      expect(banner.lines[0]).toContain("https://proto.example.net")
      // The single-shared-origin cost, and the stronger-mode pointer.
      const joined = banner.lines.join(" ")
      expect(joined).toContain("share")
      expect(joined).toContain("VIEWER_SERVE_DOMAIN")
      expect(joined).toMatch(/stronger/i)
    })

    it("is informational (not fallback), so index.ts prints it with console.log", () => {
      // The banner mode drives log-vs-warn in index.ts: only "fallback" warns.
      expect(
        originModeBannerLines({
          publicUrl: "https://app.example.com",
          serveDomain: null,
          loopbackAvailable: false,
          prototypeOrigin: "https://proto.example.net",
        }).mode,
      ).toBe("prototype-origin")
    })

    it("subdomain still wins when both are set", () => {
      expect(
        originModeBannerLines({
          publicUrl: "https://app.example.com",
          serveDomain: "proto.example.com",
          loopbackAvailable: true,
          prototypeOrigin: "https://proto.example.net",
        }).mode,
      ).toBe("subdomain")
    })
  })

  it("no line contains an em dash", () => {
    for (const config of [
      { publicUrl: "http://localhost:3100", serveDomain: null, loopbackAvailable: true },
      { publicUrl: "https://desde.example.com", serveDomain: "proto.example.com", loopbackAvailable: true },
      { publicUrl: "https://desde.example.com", serveDomain: null, loopbackAvailable: true },
      { publicUrl: "http://localhost:3100", serveDomain: null, loopbackAvailable: false },
      {
        publicUrl: "https://app.example.com",
        serveDomain: null,
        loopbackAvailable: true,
        prototypeOrigin: "https://proto.example.net",
      },
    ]) {
      const { lines } = originModeBannerLines(config)
      for (const line of lines) {
        expect(line).not.toMatch(/—/)
      }
    }
  })

  /**
   * The Docker/remote follow-up. `loopbackAvailable: false` downgrades what
   * would have been loopback mode to fallback (see `resolveOrigins`), and
   * the banner has to say WHY — a plain fallback banner alone would read as
   * "no serve domain configured," which is not the actual cause here.
   */
  describe("downgraded loopback (loopbackAvailable: false)", () => {
    const DOWNGRADE_LINE =
      "[viewer] Loopback prototype listeners are disabled here (VIEWER_LOOPBACK_LISTENERS=auto detected " +
      "a container, or =off). Prototypes fall back to same-host path mode; root-absolute assets may not " +
      "fully load for signed-in members. For real isolation set VIEWER_SERVE_DOMAIN. If the browser " +
      "shares this host (host-network mode) set VIEWER_LOOPBACK_LISTENERS=on."

    it("prints the fallback warning plus the downgrade line, verbatim", () => {
      expect(
        originModeBannerLines({
          publicUrl: "http://localhost:3100",
          serveDomain: null,
          loopbackAvailable: false,
        }),
      ).toEqual({
        mode: "fallback",
        lines: [
          "[viewer] Prototypes built with a root-absolute asset base will not fully load for signed-in members in this mode.",
          "[viewer] Fix: set VIEWER_SERVE_DOMAIN (one wildcard DNS record), or build prototypes with a relative base.",
          DOWNGRADE_LINE,
        ],
      })
    })

    it("prints the downgrade line for every loopback spelling, not just localhost", () => {
      for (const publicUrl of ["http://localhost:3100", "http://127.0.0.1:3100", "http://[::1]:3100"]) {
        const { lines } = originModeBannerLines({ publicUrl, serveDomain: null, loopbackAvailable: false })
        expect(lines, publicUrl).toContain(DOWNGRADE_LINE)
      }
    })

    it("does NOT print the downgrade line for a genuinely non-loopback fallback", () => {
      // This deployment was never going to be loopback mode in the first
      // place — publicUrl is public, so loopbackAvailable is irrelevant to
      // it. Only a shell that WOULD have been loopback gets the extra line.
      const { lines } = originModeBannerLines({
        publicUrl: "https://desde.example.com",
        serveDomain: null,
        loopbackAvailable: false,
      })
      expect(lines).toEqual([
        "[viewer] Prototypes built with a root-absolute asset base will not fully load for signed-in members in this mode.",
        "[viewer] Fix: set VIEWER_SERVE_DOMAIN (one wildcard DNS record), or build prototypes with a relative base.",
      ])
    })

    it("does NOT print the downgrade line when loopbackAvailable is true", () => {
      const { lines } = originModeBannerLines({
        publicUrl: "http://localhost:3100",
        serveDomain: null,
        loopbackAvailable: true,
      })
      for (const line of lines) {
        expect(line).not.toContain("VIEWER_LOOPBACK_LISTENERS")
      }
    })

    it("subdomain still wins over a downgraded loopback shell", () => {
      expect(
        originModeBannerLines({
          publicUrl: "http://localhost:3100",
          serveDomain: "proto.test",
          loopbackAvailable: false,
        }).mode,
      ).toBe("subdomain")
    })
  })
})
