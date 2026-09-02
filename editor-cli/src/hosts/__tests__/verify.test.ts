/**
 * The boot-verification ladder's evidence half.
 *
 * The failure this whole module exists to catch is a healthy 200-serving dev
 * server that stamps nothing, so the tests that matter most are the ones that
 * prove verification does NOT fire when something else is wrong: a broken
 * server, a proxy error page, a client-rendered app. Every one of those looks
 * identical to "the stamper is dead" through a two-valued check, and blaming
 * stamping for them would send the user to fix the wrong thing.
 */
import { describe, expect, it, vi } from "vitest"
import { verifyStamping, type ProbeFetch, type VerifyStampingRequest } from "../verify.js"

const BRIDGE_TAG = '<script data-prototype-flow="bridge" src="/@desde-bridge.js"></script>'

interface FakeDoc {
  status?: number
  contentType?: string | null
  body?: string
  /** Transport-level failure instead of a response. */
  throws?: string
}

/** A fetch over a route → document map. Anything unlisted 404s, as a real one would. */
function fakeFetch(docs: Record<string, FakeDoc>): ProbeFetch {
  return async (url: string) => {
    const route = new URL(url).pathname
    const doc = docs[route] ?? { status: 404, contentType: "text/plain", body: "Not found" }
    if (doc.throws) throw new Error(doc.throws)
    const contentType = doc.contentType === undefined ? "text/html; charset=utf-8" : doc.contentType
    return {
      status: doc.status ?? 200,
      headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? contentType : null) },
      text: async () => doc.body ?? "",
    }
  }
}

/** A document that satisfies every teardown precondition EXCEPT carrying stamps. */
const HEALTHY_UNSTAMPED = `<!doctype html><html><head>${BRIDGE_TAG}</head><body><div>hi</div></body></html>`

function request(overrides: Partial<VerifyStampingRequest> = {}): VerifyStampingRequest {
  return {
    url: "http://127.0.0.1:45100",
    stampExpectation: "required-in-html",
    hostDisplayName: "Next.js",
    fetchImpl: fakeFetch({ "/": { body: HEALTHY_UNSTAMPED } }),
    ...overrides,
  }
}

describe("verifyStamping — the conclusive verdict", () => {
  it("returns unstamped, with a HostFailure, when all five conditions hold", async () => {
    const result = await verifyStamping(request())

    expect(result.evidence.verdict).toBe("unstamped")
    if (result.evidence.verdict !== "unstamped") throw new Error("unreachable")
    expect(result.evidence.failure.code).toBe("injection-not-observed")
    // The failure must say the SERVER is fine — the customer's first instinct
    // on a stamping failure is that their project is broken, and it is not.
    expect(result.evidence.failure.summary).toContain("The server is healthy")
    expect(result.evidence.failure.summary).toContain("Next.js")
    expect(result.evidence.failure.cause).toContain("0 data-desde-src")
    expect(result.evidence.failure.attachCovers).toBe(true)
    expect(result.bridgeTagPresent).toBe(true)
  })

  it("renders a supplied stamper seam and fabricates none when the host has no designated one", async () => {
    const withSeam = await verifyStamping(
      request({
        stamperSeam: {
          id: "next/dist/server/config",
          stability: "private",
          expression: 'require("next/dist/server/config").default',
          buys: "the only in-memory channel for the source-code stamper",
        },
      }),
    )
    if (withSeam.evidence.verdict !== "unstamped") throw new Error("expected unstamped")
    expect(withSeam.evidence.failure.seam?.id).toBe("next/dist/server/config")

    // Nothing threw in this failure class, so a host that does not designate a
    // seam must not have one guessed for it.
    const withoutSeam = await verifyStamping(request())
    if (withoutSeam.evidence.verdict !== "unstamped") throw new Error("expected unstamped")
    expect(withoutSeam.evidence.failure.seam).toBeUndefined()
  })
})

describe("verifyStamping — the teardown conjunction refuses to fire", () => {
  it("on a non-200 response — a broken server is not a stamping failure", async () => {
    const result = await verifyStamping(
      request({ fetchImpl: fakeFetch({ "/": { status: 502, body: HEALTHY_UNSTAMPED } }) }),
    )

    expect(result.evidence.verdict).toBe("indeterminate")
    if (result.evidence.verdict !== "indeterminate") throw new Error("unreachable")
    expect(result.evidence.reason).toContain("HTTP 502")
  })

  it("when the bridge tag is absent — that may not be the app's own HTML", async () => {
    const result = await verifyStamping(
      request({ fetchImpl: fakeFetch({ "/": { body: "<html><body>login</body></html>" } }) }),
    )

    expect(result.evidence.verdict).toBe("indeterminate")
    if (result.evidence.verdict !== "indeterminate") throw new Error("unreachable")
    expect(result.evidence.reason).toContain("bridge <script> tag")
    expect(result.bridgeTagPresent).toBe(false)
  })

  it("on a non-HTML response", async () => {
    const result = await verifyStamping(
      request({
        fetchImpl: fakeFetch({ "/": { contentType: "application/json", body: HEALTHY_UNSTAMPED } }),
      }),
    )

    expect(result.evidence.verdict).toBe("indeterminate")
    if (result.evidence.verdict !== "indeterminate") throw new Error("unreachable")
    expect(result.evidence.reason).toContain("not text/html")
  })

  it("when the server could not be reached at all", async () => {
    const result = await verifyStamping(
      request({ fetchImpl: fakeFetch({ "/": { throws: "ECONNREFUSED" } }) }),
    )

    expect(result.evidence.verdict).toBe("indeterminate")
    if (result.evidence.verdict !== "indeterminate") throw new Error("unreachable")
    expect(result.evidence.reason).toContain("ECONNREFUSED")
    expect(result.probes[0]?.error).toBe("ECONNREFUSED")
  })

  it.each(["module-graph", "post-hydration", "partial"] as const)(
    "when the expectation is %s — zero stamps in the document proves nothing there",
    async (stampExpectation) => {
      const result = await verifyStamping(request({ stampExpectation }))

      // This is the case that would refuse to boot every client-rendered app if
      // `indeterminate` did not exist as its own verdict.
      expect(result.evidence.verdict).toBe("indeterminate")
    },
  )

  it("when a probed route beyond / is unhealthy, even though / is perfect", async () => {
    const result = await verifyStamping(
      request({
        probeRoutes: ["/about"],
        fetchImpl: fakeFetch({
          "/": { body: HEALTHY_UNSTAMPED },
          "/about": { status: 500, body: "boom" },
        }),
      }),
    )

    expect(result.evidence.verdict).toBe("indeterminate")
    if (result.evidence.verdict !== "indeterminate") throw new Error("unreachable")
    expect(result.evidence.reason).toContain("/about")
  })
})

describe("verifyStamping — module-graph evidence promotes but never demotes", () => {
  it("promotes indeterminate to stamped", async () => {
    const result = await verifyStamping(
      request({
        // The plain-Vite shape: nothing in the served index.html, everything in
        // the graph.
        stampExpectation: "module-graph",
        moduleGraphEvidence: async () => true,
      }),
    )

    expect(result.evidence.verdict).toBe("stamped")
    if (result.evidence.verdict !== "stamped") throw new Error("unreachable")
    expect(result.evidence.how).toContain("module graph")
    expect(result.moduleGraphSaidYes).toBe(true)
  })

  it("promotes even a full teardown conjunction to stamped", async () => {
    // Every one of the other four conditions holds. The graph alone stops the
    // teardown, which is the "never on its own produce unstamped" rule seen
    // from the other side.
    const result = await verifyStamping(request({ moduleGraphEvidence: async () => true }))

    expect(result.evidence.verdict).toBe("stamped")
  })

  it("never demotes a document that carried stamps, and is not even consulted", async () => {
    const graph = vi.fn(async () => false)
    const result = await verifyStamping(
      request({
        moduleGraphEvidence: graph,
        fetchImpl: fakeFetch({
          "/": { body: `<html><head>${BRIDGE_TAG}</head><body><b data-desde-src="src/App.vue:3:2">x</b></body></html>` },
        }),
      }),
    )

    expect(result.evidence.verdict).toBe("stamped")
    if (result.evidence.verdict !== "stamped") throw new Error("unreachable")
    expect(result.evidence.sample).toBe("src/App.vue:3:2")
    expect(result.evidence.count).toBe(1)
    // Not merely ignored — never asked. The graph cannot contradict a document
    // that already answered.
    expect(graph).not.toHaveBeenCalled()
  })

  it("treats a throwing graph walk as absence of evidence, not as a verdict", async () => {
    const result = await verifyStamping(
      request({
        moduleGraphEvidence: async () => {
          throw new Error("graph exploded")
        },
      }),
    )

    // All five teardown conditions would otherwise hold. A walk that errored
    // told us nothing, and "nothing" must not be read as "no stamps".
    expect(result.evidence.verdict).toBe("indeterminate")
    if (result.evidence.verdict !== "indeterminate") throw new Error("unreachable")
    expect(result.evidence.reason).toContain("module-graph walk failed")
    expect(result.moduleGraphSaidYes).toBeNull()
  })
})

describe("verifyStamping — probing", () => {
  it("counts stamps across every probed route, and reports the first sample", async () => {
    const result = await verifyStamping(
      request({
        probeRoutes: ["/about"],
        fetchImpl: fakeFetch({
          "/": { body: `<html><head>${BRIDGE_TAG}</head><body>nothing</body></html>` },
          "/about": {
            body: `<html><body><b data-desde-src="src/About.vue:1:1">a</b><i data-desde-src="src/About.vue:2:1">b</i></body></html>`,
          },
        }),
      }),
    )

    expect(result.evidence.verdict).toBe("stamped")
    if (result.evidence.verdict !== "stamped") throw new Error("unreachable")
    expect(result.evidence.count).toBe(2)
    expect(result.evidence.sample).toBe("src/About.vue:1:1")
    expect(result.probes.map((p) => p.route)).toEqual(["/", "/about"])
  })

  it("probes / exactly once even when a host lists it explicitly", async () => {
    const fetchImpl = vi.fn(fakeFetch({ "/": { body: HEALTHY_UNSTAMPED } }))
    const result = await verifyStamping(request({ probeRoutes: ["/", "/"], fetchImpl }))

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(result.probes).toHaveLength(1)
  })
})
