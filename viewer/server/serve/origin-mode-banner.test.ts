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
        "[viewer] Loopback prototype listeners are meant for a browser on this same machine. " +
          "A containerized or remote deployment should set VIEWER_SERVE_DOMAIN, or a non-loopback VIEWER_PUBLIC_URL.",
      ],
    })
  })

  it("loopback: prints the port range and the Docker publish command when a range is configured (task 4)", () => {
    expect(
      originModeBannerLines({
        publicUrl: "http://localhost:3100",
        serveDomain: null,
        loopbackAvailable: true,
        loopbackPortRange: { from: 3101, to: 3120 },
      }),
    ).toEqual({
      mode: "loopback",
      lines: [
        // Not "<ephemeral>": the next line names 3101-3120, and an operator
        // reading two consecutive lines was being told two different things
        // about the same port (live acceptance finding, 2026-09-11).
        "[viewer] prototypes are served from the other loopback name on a port from the range below " +
          "(shell=http://localhost:3100 prototypes=http://127.0.0.1:<3101-3120>)",
        // Inside a container the socket is on every interface, so the line
        // that used to say "reachable only from a browser on this same host"
        // was not true there. What keeps the published ports private is the
        // `127.0.0.1:` prefix on the -p flag below.
        "[viewer] Loopback prototype listeners are meant for a browser on this same machine. " +
          "Inside a container the socket is on every interface, so publish the ports to this machine's " +
          "loopback, as the next line shows. A remote deployment should set VIEWER_SERVE_DOMAIN, or a " +
          "non-loopback VIEWER_PUBLIC_URL.",
        "[viewer] Loopback prototype ports: 3101-3120. In Docker, publish them to this machine's " +
          "loopback: -p 127.0.0.1:3101-3120:3101-3120",
      ],
    })
  })

  /**
   * With `loopbackBindAllInterfaces` the pairing never chooses `[::1]` — the
   * listener binds the IPv4 wildcard, so an IPv6 origin would refuse the
   * connection. The banner reads the same pairing the route does, so it
   * names `localhost` here where the no-range case below names `[::1]`.
   */
  it("loopback: a 127.0.0.1 shell with loopbackBindAllInterfaces names localhost, not [::1]", () => {
    const { lines } = originModeBannerLines({
      publicUrl: "http://127.0.0.1:3100",
      serveDomain: null,
      loopbackAvailable: true,
      loopbackPortRange: { from: 3101, to: 3120 },
      loopbackBindAllInterfaces: true,
    })
    expect(lines[0]).toContain("prototypes=http://localhost:<3101-3120>")
    expect(lines[0]).not.toContain("[::1]")
  })

  /**
   * Codex round 2, item 1. A range configured BY ITSELF (no
   * `loopbackBindAllInterfaces`) is the laptop case: the listener still
   * binds loopback, so `[::1]` is fine to keep naming.
   */
  it("loopback: a 127.0.0.1 shell with a range but no loopbackBindAllInterfaces still names [::1]", () => {
    const { lines } = originModeBannerLines({
      publicUrl: "http://127.0.0.1:3100",
      serveDomain: null,
      loopbackAvailable: true,
      loopbackPortRange: { from: 3101, to: 3120 },
    })
    expect(lines[0]).toContain("prototypes=http://[::1]:<3101-3120>")
  })

  it("loopback: no port-range line when loopbackPortRange is unset", () => {
    const { lines } = originModeBannerLines({
      publicUrl: "http://localhost:3100",
      serveDomain: null,
      loopbackAvailable: true,
    })
    expect(lines.some((line) => line.includes("Loopback prototype ports"))).toBe(false)
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
        "[viewer] Loopback prototype listeners are meant for a browser on this same machine. " +
          "A containerized or remote deployment should set VIEWER_SERVE_DOMAIN, or a non-loopback VIEWER_PUBLIC_URL.",
      ],
    })
  })

  /**
   * Codex round 6, Fix 1. `loopbackBindAllInterfaces` means Docker publishes
   * the ports, and an operator on `--network host` needs to be told to turn
   * it off with `VIEWER_LOOPBACK_BIND=loopback` — the wildcard bind is
   * unnecessary and a real exposure there, since host networking ignores
   * `-p` and faces the ports at the LAN directly.
   */
  describe("loopback: the wide-bind line (VIEWER_LOOPBACK_BIND)", () => {
    const WIDE_BIND_LINE =
      "[viewer] Prototype ports bind every interface so Docker can publish them. On --network host " +
      "set VIEWER_LOOPBACK_BIND=loopback."

    it("prints the extra line when the bind is widened", () => {
      const { lines } = originModeBannerLines({
        publicUrl: "http://localhost:3100",
        serveDomain: null,
        loopbackAvailable: true,
        loopbackPortRange: { from: 3101, to: 3120 },
        loopbackBindAllInterfaces: true,
      })
      expect(lines).toContain(WIDE_BIND_LINE)
    })

    it("does NOT print the line when the bind is not widened (a laptop)", () => {
      const { lines } = originModeBannerLines({
        publicUrl: "http://localhost:3100",
        serveDomain: null,
        loopbackAvailable: true,
      })
      expect(lines).not.toContain(WIDE_BIND_LINE)
    })

    it("does NOT print the line when loopbackBindAllInterfaces is explicitly false (VIEWER_LOOPBACK_BIND=loopback)", () => {
      const { lines } = originModeBannerLines({
        publicUrl: "http://localhost:3100",
        serveDomain: null,
        loopbackAvailable: true,
        loopbackPortRange: { from: 3101, to: 3120 },
        loopbackBindAllInterfaces: false,
      })
      expect(lines).not.toContain(WIDE_BIND_LINE)
    })

    // Task 5 (server-prototypes rework): the bind can now be wide AND
    // unrecognised at the same time (the shipped image forces `all`
    // unconditionally). That combination gets its own warning below instead
    // of this plain informational line — see the next describe block.
    it("does NOT print this plain line when the bind is wide but the layout is unrecognised; the warning below prints instead", () => {
      const { lines } = originModeBannerLines({
        publicUrl: "http://localhost:3100",
        serveDomain: null,
        loopbackAvailable: true,
        loopbackPortRange: { from: 3101, to: 3120 },
        loopbackBindAllInterfaces: true,
        loopbackBindNetworkUnrecognized: true,
        loopbackInContainer: true,
      })
      expect(lines).not.toContain(WIDE_BIND_LINE)
    })
  })

  /**
   * Codex round 10, Fix 2, still true after the Task 5 widening below: this
   * is the line for a bind that STAYED NARROW (`loopbackBindAllInterfaces`
   * false) while the layout was not recognised — a container was detected,
   * but `isLikelyBridgedNamespace()` (`container-detect.ts`) could not
   * recognise the layout (Podman, a bare physical NIC, or plain
   * `--network host`), so the bind stayed on the container's own loopback
   * instead of widening. When the bind is wide INSTEAD, the warning in the
   * next describe block prints, never this one — see task-5-brief.md,
   * decision 2.
   */
  describe("loopback: the network-layout-unrecognised line (bind stayed narrow)", () => {
    const UNRECOGNIZED_LINE =
      "[viewer] Prototype ports stay on the container's own loopback (VIEWER_LOOPBACK_BIND=auto). " +
      "With -p published ports set VIEWER_LOOPBACK_BIND=all. On --network host this is right."

    it("prints the line when the layout was not recognised (VIEWER_LOOPBACK_BIND=auto)", () => {
      const { lines } = originModeBannerLines({
        publicUrl: "http://localhost:3100",
        serveDomain: null,
        loopbackAvailable: true,
        loopbackPortRange: { from: 3101, to: 3120 },
        loopbackBindNetworkUnrecognized: true,
        loopbackInContainer: true,
      })
      expect(lines).toContain(UNRECOGNIZED_LINE)
    })

    it("prints the line for a container whose layout WAS recognised too: auto never widens (codex round 18)", () => {
      const { lines } = originModeBannerLines({
        publicUrl: "http://localhost:3100",
        serveDomain: null,
        loopbackAvailable: true,
        loopbackPortRange: { from: 3101, to: 3120 },
        loopbackBindNetworkUnrecognized: false,
        loopbackInContainer: true,
      })
      expect(lines).toContain(UNRECOGNIZED_LINE)
    })

    it("does NOT print the line under an explicit VIEWER_LOOPBACK_BIND=loopback: the operator meant it (Task 5 review)", () => {
      const { lines } = originModeBannerLines({
        publicUrl: "http://localhost:3100",
        serveDomain: null,
        loopbackAvailable: true,
        loopbackPortRange: { from: 3101, to: 3120 },
        loopbackBindAllInterfaces: false,
        loopbackBindNetworkUnrecognized: true,
        loopbackInContainer: true,
        loopbackBind: "loopback",
      })
      expect(lines).not.toContain(UNRECOGNIZED_LINE)
    })

    it("does NOT print the line when the layout was recognised as bridged (loopbackBindAllInterfaces: true)", () => {
      const { lines } = originModeBannerLines({
        publicUrl: "http://localhost:3100",
        serveDomain: null,
        loopbackAvailable: true,
        loopbackPortRange: { from: 3101, to: 3120 },
        loopbackBindAllInterfaces: true,
        loopbackBindNetworkUnrecognized: false,
      })
      expect(lines).not.toContain(UNRECOGNIZED_LINE)
    })

    it("does NOT print this line when the bind is wide AND unrecognised; the warning below prints instead", () => {
      const { lines } = originModeBannerLines({
        publicUrl: "http://localhost:3100",
        serveDomain: null,
        loopbackAvailable: true,
        loopbackPortRange: { from: 3101, to: 3120 },
        loopbackBindAllInterfaces: true,
        loopbackBindNetworkUnrecognized: true,
        loopbackInContainer: true,
      })
      expect(lines).not.toContain(UNRECOGNIZED_LINE)
    })

    it("does NOT print the line on a plain laptop (loopbackBindNetworkUnrecognized unset)", () => {
      const { lines } = originModeBannerLines({
        publicUrl: "http://localhost:3100",
        serveDomain: null,
        loopbackAvailable: true,
      })
      expect(lines).not.toContain(UNRECOGNIZED_LINE)
    })
  })

  /**
   * Server-prototypes rework, Task 5: the Docker image now states its bind
   * explicitly (`ENV VIEWER_LOOPBACK_BIND=all`) instead of leaving it to
   * container detection. That means the bind can be wide (forced by the
   * image or by an operator) on a container whose layout is NOT recognised
   * as bridged: a `--network host` container running the image without
   * overriding the bind back to `loopback`, or a runtime like Podman the
   * heuristic does not recognise. This line replaces the plain wide-bind
   * line for exactly that combination, and never appears alongside it or
   * alongside the narrow-bind line above (task-5-brief.md, decision 2).
   */
  describe("loopback: the wide-bind-but-unrecognised warning line (VIEWER_LOOPBACK_BIND=all)", () => {
    const WIDE_BIND_UNRECOGNIZED_LINE =
      "[viewer] Prototype ports bind every interface (VIEWER_LOOPBACK_BIND=all) and the network " +
      "layout was not recognised. With -p published ports that is right. On --network host set " +
      "VIEWER_LOOPBACK_BIND=loopback."

    it("prints the warning when the bind is wide and the namespace is not recognised as bridged", () => {
      const { lines } = originModeBannerLines({
        publicUrl: "http://localhost:3100",
        serveDomain: null,
        loopbackAvailable: true,
        loopbackPortRange: { from: 3101, to: 3120 },
        loopbackBindAllInterfaces: true,
        loopbackBindNetworkUnrecognized: true,
        loopbackInContainer: true,
      })
      expect(lines).toContain(WIDE_BIND_UNRECOGNIZED_LINE)
    })

    it("does NOT print the warning when the bind is wide and the namespace IS recognised as bridged", () => {
      const { lines } = originModeBannerLines({
        publicUrl: "http://localhost:3100",
        serveDomain: null,
        loopbackAvailable: true,
        loopbackPortRange: { from: 3101, to: 3120 },
        loopbackBindAllInterfaces: true,
        loopbackBindNetworkUnrecognized: false,
      })
      expect(lines).not.toContain(WIDE_BIND_UNRECOGNIZED_LINE)
    })

    it("does NOT print the warning when the bind stayed narrow, even if the namespace is unrecognised (the round-10 line prints instead)", () => {
      const { lines } = originModeBannerLines({
        publicUrl: "http://localhost:3100",
        serveDomain: null,
        loopbackAvailable: true,
        loopbackPortRange: { from: 3101, to: 3120 },
        loopbackBindAllInterfaces: false,
        loopbackBindNetworkUnrecognized: true,
        loopbackInContainer: true,
      })
      expect(lines).not.toContain(WIDE_BIND_UNRECOGNIZED_LINE)
    })

    it("prints at most one of the three bind-related lines for any combination", () => {
      const WIDE_BIND_LINE =
        "[viewer] Prototype ports bind every interface so Docker can publish them. On --network host " +
        "set VIEWER_LOOPBACK_BIND=loopback."
      const UNRECOGNIZED_LINE =
        "[viewer] Prototype ports stay on the container's own loopback because the network layout " +
        "was not recognised. If the viewer is in Docker with -p published ports, set " +
        "VIEWER_LOOPBACK_BIND=all."
      const bindRelatedLines = [WIDE_BIND_LINE, UNRECOGNIZED_LINE, WIDE_BIND_UNRECOGNIZED_LINE]

      for (const loopbackBindAllInterfaces of [true, false]) {
        for (const loopbackBindNetworkUnrecognized of [true, false]) {
          const { lines } = originModeBannerLines({
            publicUrl: "http://localhost:3100",
            serveDomain: null,
            loopbackAvailable: true,
            loopbackPortRange: { from: 3101, to: 3120 },
            loopbackBindAllInterfaces,
            loopbackBindNetworkUnrecognized,
          })
          const matches = bindRelatedLines.filter((line) => lines.includes(line))
          expect(matches.length).toBeLessThanOrEqual(1)
        }
      }
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
      {
        publicUrl: "http://localhost:3100",
        serveDomain: null,
        loopbackAvailable: true,
        loopbackPortRange: { from: 3101, to: 3120 },
        loopbackBindNetworkUnrecognized: true,
        loopbackInContainer: true,
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
