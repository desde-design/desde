/**
 * Which host names a seam when it boots healthy and stamps nothing — and
 * whether that name survives the four hops between the declaration and the
 * sentence a customer reads.
 *
 * **The failure this file is about.** `injection-not-observed` is the one
 * verdict produced with nothing having thrown, so `verify.ts` deliberately
 * fabricates no seam for it and renders `stamperSeam` only when a host supplies
 * one. Next has one; nobody supplied it. MEASURED against the unfixed source,
 * with a swallowed-write run simulated at the HTTP boundary (200, text/html,
 * bridge tag, zero `data-desde-src` — the entire input `verifyStamping` ever sees):
 *
 * ```
 * { "verdict": "unstamped", "failureCode": "injection-not-observed",
 *   "seamOnFailure": null, "hostDeclaresStamperSeam": "(member does not exist)",
 *   "messageNamesSeamId": false, "messageHasNothingIsWrongParagraph": false }
 * ```
 *
 * The rendered message still said "Attach mode does not use this seam" — while
 * naming no seam — and the paragraph that tells the customer a private seam
 * means nothing is wrong with THEIR project never fired.
 *
 * **Why it is tested through `stampVerifyFor` and `decide` rather than at each
 * seam.** Four things have to line up (the host declares, `runResolvedHost`
 * copies, `stampVerifyFor` forwards, `ladder.render` prints) and any one of them
 * missing produces exactly the same seam-free message. Asserting the ends is
 * what catches that; asserting the middles is what passes while the ends are
 * still broken.
 */
import { describe, expect, it } from "vitest"
import { stampVerifyFor } from "../../core.js"
import { applyStampGate } from "../ladder.js"
import { getHostFactory, registeredHostIds, type AnyDevServerHost } from "../registry.js"
import { verifyStamping, type ProbeFetch } from "../verify.js"
import { createNextHost } from "../next/host.js"
import { createReactRouterHost } from "../react-router/host.js"
import type { HostRun } from "../run.js"
import type { HostSeam, StampExpectation } from "../types.js"

const BRIDGE_TAG = '<script data-prototype-flow="bridge" src="/__desde/bridge.js"></script>'
/** 200, text/html, bridge tag present, ZERO stamps — the swallowed-write shape. */
const HEALTHY_UNSTAMPED = `<!doctype html><html><head>${BRIDGE_TAG}</head><body><div>hi</div></body></html>`

const servesUnstamped: ProbeFetch = async () => ({
  status: 200,
  headers: {
    get: (name: string) =>
      name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null,
  },
  text: async () => HEALTHY_UNSTAMPED,
})

/**
 * A booted run, with only what `stampVerifyFor` reads filled in for real.
 *
 * Built from an ACTUAL host object rather than from literals: the point of the
 * exercise is that the seam the host declares is the seam that gets printed, and
 * a hand-written seam here would prove that a string travels, not that the
 * designation does.
 */
function runOf(host: AnyDevServerHost, expectation: StampExpectation): HostRun {
  return {
    url: "http://127.0.0.1:47010",
    base: "/",
    hostId: host.id,
    stamperSeam: host.stamperSeam,
    host: { id: host.id, displayName: host.displayName, devCommand: host.devCommand },
    coverage: { covered: [], uncovered: [] },
    boot: {
      transport: { kind: "direct", origin: "http://127.0.0.1:47010" },
      base: "/",
      bridgeTags: host.bridgeTags,
      hmr: { lanes: [], invalidate: () => undefined, reload: { hot: [], fullReload: [] } },
      security: { narrowedServerConfig: false, overridden: [], gaps: [] },
      stampExpectation: expectation,
      sideDoorOrigins: [],
      probeRoutes: [],
      close: async () => undefined,
    },
    close: async () => undefined,
  }
}

/**
 * The whole path: verify the served output, run the real gate, render.
 *
 * `applyStampGate` rather than `decide` directly, because the gate is the step
 * that closes the booted server before anything is printed — asserting the
 * message off `decide` alone would leave the shipped sequence untested.
 */
async function refusalFor(host: AnyDevServerHost, expectation: StampExpectation) {
  const run = runOf(host, expectation)
  const verification = await verifyStamping({
    ...stampVerifyFor(run, run),
    fetchImpl: servesUnstamped,
  })
  if (verification.evidence.verdict !== "unstamped") {
    throw new Error(`expected unstamped, got ${verification.evidence.verdict}`)
  }
  let closed = 0
  const gate = await applyStampGate({
    evidence: verification.evidence,
    mode: "auto",
    skipVerify: false,
    host: run.host,
    close: async () => {
      closed += 1
    },
  })
  if (gate.kind !== "refuse") throw new Error(`expected refuse, got ${gate.kind}`)
  return { failure: verification.evidence.failure, message: gate.decision.message, closed }
}

describe("the designated stamper seam reaches the customer's message", () => {
  it("names next/dist/server/config on a swallowed-write Next run", async () => {
    const { failure, message, closed } = await refusalFor(createNextHost(), "required-in-html")

    expect(failure.code).toBe("injection-not-observed")
    // The seam is not a consolation prize for a server left running: the gate
    // tore it down first, and the message says so two lines below.
    expect(closed).toBe(1)
    // The finding, stated as the assertion: the seam id has to OCCUR.
    expect(message).toContain("next/dist/server/config")
    expect(failure.seam?.id).toBe("next/dist/server/config")
    // …and with it, the two things `ladder.render` gates on a seam being
    // present. Without them the message tells the user their server is broken
    // and gives them nothing to search for.
    expect(message).toContain('Expression: require("next/dist/server/config").default')
    expect(message).toContain("the only in-memory channel for the source-code stamper")
    expect(message).toContain("Nothing is wrong with your project")
    // The sentence that was already being printed, which only makes sense once
    // the seam above is named.
    expect(message).toContain("Attach mode does not use this seam")
  })

  it("still fabricates nothing for a host that designates no seam", async () => {
    // React Router reaches this verdict too (an `ssr: true` app reports
    // `required-in-html`) and deliberately designates nothing — the stamper is a
    // plugin in an array handed straight to a `createServer` we call ourselves,
    // so no seam is the answer to "what did not deliver". The failure must stay
    // seam-free rather than acquire a plausible-looking one.
    const { failure, message } = await refusalFor(createReactRouterHost(), "required-in-html")

    expect(failure.code).toBe("injection-not-observed")
    expect(failure.seam).toBeUndefined()
    expect(message).not.toContain("Seam:")
    expect(message).not.toContain("Nothing is wrong with your project")
    // Still fully actionable without one: the state, and the way out.
    expect(message).toContain("The server is healthy")
    expect(message).toContain("npx react-router dev")
  })

  it("passes no seam in attach mode, which has no in-process seam to name", () => {
    const handle = { url: "http://127.0.0.1:47011", base: "/", close: async () => undefined }
    const request = stampVerifyFor(handle, null)

    expect(request.stamperSeam).toBeUndefined()
    // And it could not render one anyway — `post-hydration` can never complete
    // the § 6 teardown conjunction. Asserted so the two facts stay linked.
    expect(request.stampExpectation).toBe("post-hydration")
  })
})

describe("every host's designation is one of its own declared seams", () => {
  /**
   * The table, spelled out rather than derived.
   *
   * A designation is a CLAIM — "if this host stamps nothing, this is the channel
   * that did not deliver" — and the constraint it lives under is that no host
   * may acquire one by accident. Deriving the expectation from the code under
   * test would assert that whatever is there is what is there. Each `null` has
   * its reason in that host's source, next to `seams`.
   */
  const EXPECTED: Record<string, string | null> = {
    // `module-graph`, and no forwarding step to drop the plugin array.
    vite: null,
    // Reachable, but the stamper is handed straight to `createServer`.
    "react-router": null,
    // `partial` — the verdict is unreachable, so a designation would be inert.
    astro: null,
    // `overrides.vite.plugins` IS a forwarding step, and its silent failure is
    // exactly this verdict.
    nuxt: "NuxtConfig.vite.plugins",
    // The config memo is the only in-memory route a Turbopack loader has.
    next: "next/dist/server/config",
    // A registry entry since the detection rewrite, and the ONLY host whose
    // `seams` array is empty — which is why it can never designate one. That
    // emptiness is not an omission: it is what makes "attach mode does not use
    // this seam and covers your framework fully" true at the bottom of every
    // other host's failure message.
    attach: null,
  }

  it("covers every registered host, so a new one cannot slip past the table", () => {
    expect(registeredHostIds().sort()).toEqual(Object.keys(EXPECTED).sort())
  })

  for (const id of Object.keys(EXPECTED)) {
    it(`${id} designates ${EXPECTED[id] ?? "nothing"}`, () => {
      const factory = getHostFactory(id as ReturnType<typeof registeredHostIds>[number])
      if (!factory) throw new Error(`no factory for ${id}`)
      const host = factory()

      expect(host.stamperSeam?.id ?? null).toBe(EXPECTED[id])

      if (host.stamperSeam) {
        // By IDENTITY, not by value. Two literals with the same text would pass
        // an equality check and then drift the moment one of them is edited —
        // which is the failure `bridgeTags` solves the same way, with one
        // module-level constant referenced twice.
        expect(host.seams).toContain<HostSeam>(host.stamperSeam)
      }
    })
  }
})
