import { describe, expect, it } from "vitest"
import { resolveCliIframeUrl, mirrorLiveRouteToShellUrl } from "./editor-deeplink"

describe("resolveCliIframeUrl", () => {
  it("returns viteUrl when there's no existing ?url=", () => {
    expect(resolveCliIframeUrl(null, "http://localhost:5173/")).toBe("http://localhost:5173/")
  })

  it("returns the existing URL unchanged when its origin matches viteUrl", () => {
    const existing = "http://localhost:5173/checkout?step=2#top"
    expect(resolveCliIframeUrl(existing, "http://localhost:5173/")).toBe(existing)
  })

  it("re-bases a stale origin onto viteUrl, preserving path/search/hash", () => {
    // CLI restarted on a new port; the stored URL's path is authoritative.
    const existing = "http://localhost:5173/settings/profile?tab=2#x"
    const out = resolveCliIframeUrl(existing, "http://localhost:5199/")
    expect(out).toBe("http://localhost:5199/settings/profile?tab=2#x")
  })

  it("falls back to viteUrl when the stored value is not a valid absolute URL", () => {
    expect(resolveCliIframeUrl("/settings", "http://localhost:5173/")).toBe("http://localhost:5173/")
    expect(resolveCliIframeUrl("not a url", "http://localhost:5173/")).toBe("http://localhost:5173/")
  })
})

describe("mirrorLiveRouteToShellUrl", () => {
  const shell = "http://app.local/?url=http%3A%2F%2Flocalhost%3A5173%2F"

  it("mirrors the live path into ?url= keeping the canonical origin", () => {
    const next = mirrorLiveRouteToShellUrl(
      "http://localhost:5173/", // canonical (seeded) origin
      "http://worktree-abc:5173/dashboard?x=1#sec", // live payload (per-session origin)
      shell,
    )
    expect(next).not.toBeNull()
    const url = new URL(next!)
    // The mirrored ?url= keeps the canonical origin but adopts the live path.
    expect(url.searchParams.get("url")).toBe("http://localhost:5173/dashboard?x=1#sec")
  })

  it("returns null when the resulting shell href is unchanged (same route)", () => {
    // Live route equals what's already in ?url= → no replaceState needed.
    const next = mirrorLiveRouteToShellUrl(
      "http://localhost:5173/",
      "http://localhost:5173/",
      shell,
    )
    expect(next).toBeNull()
  })

  it("returns null when a URL is unparseable", () => {
    expect(mirrorLiveRouteToShellUrl("nope", "http://localhost:5173/x", shell)).toBeNull()
    expect(mirrorLiveRouteToShellUrl("http://localhost:5173/", "nope", shell)).toBeNull()
  })
})
