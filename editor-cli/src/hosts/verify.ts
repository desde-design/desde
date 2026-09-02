import type { HostFailure, HostSeam, StampEvidence, StampExpectation } from "./types.js"

/**
 * The boot-verification gate: did the source-code stamper actually reach the
 * served output?
 *
 * **Why this exists at all.** The dangerous failure in this seam is not a
 * crash — a crash is loud and lands at boot. It is a healthy 200-serving dev
 * server that stamps NOTHING: the app renders, elements are inspectable, and
 * only *edits* are refused, minutes after boot, mid-click, with nothing in the
 * logs. Next's documented `conf` option is exactly this shape (MEASURED: boots
 * fine, stamps zero). This module is what turns that into a boot-time refusal.
 *
 * **Why the verdict is three-valued.** "No stamps in the response" is proof of
 * failure only for a server-rendered document. A client-rendered app
 * legitimately serves a stamp-free index.html and stamps after hydration, where
 * an HTTP probe cannot see. Collapsing `indeterminate` into `unstamped` would
 * refuse to boot every SPA — including the plain-Vite path that ships today.
 * So the third value is not hedging; it is the difference between a gate and a
 * regression.
 *
 * **What may conclude, and what may only corroborate.** `moduleGraphEvidence()`
 * can PROMOTE a verdict to `stamped`, and can never on its own produce
 * `unstamped` (§ 1, `HostBoot.moduleGraphEvidence`): a cold or base-shifted
 * graph legitimately contains nothing. It is condition 5 of the teardown
 * conjunction — necessary, never sufficient.
 */

/** Marker the bridge `<script>` tag carries, in both injection lanes. */
const BRIDGE_TAG_MARKER = 'data-prototype-flow="bridge"'

/**
 * The subset of `fetch` this module uses, so a test can supply a fake without
 * standing up a server and without `any`. The global `fetch` is structurally
 * assignable to it (`string` narrows `RequestInfo | URL`; `Response` carries
 * `status`, `headers.get` and `text`).
 */
export type ProbeFetch = (url: string) => Promise<{
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}>

/** What one probed document told us. Kept per-route so a reason can name which. */
export interface RouteProbe {
  /** The path as requested, e.g. `/` or `/about`. */
  route: string
  /** The absolute URL fetched. */
  url: string
  /** `null` when the request never completed. */
  status: number | null
  contentType: string | null
  /** `content-type` claimed `text/html`. */
  html: boolean
  /** The bridge `<script>` tag was in this document. */
  bridgeTag: boolean
  /** `data-desde-src` occurrences in this document. */
  stamps: number
  /** First stamp value seen, for the "here is what we found" line. */
  sample: string | null
  /** Transport-level failure, verbatim. */
  error: string | null
}

export interface VerifyStampingRequest {
  /** Front-door origin the BROWSER uses — never an internal upstream. */
  url: string
  /** Computed at boot from the resolved config, never guessed from the host name. */
  stampExpectation: StampExpectation
  /** Extra document routes beyond `/`. Usually empty. */
  probeRoutes?: readonly string[]
  /** Present on every Vite-family host; absent for Next and attach. */
  moduleGraphEvidence?: (() => Promise<boolean>) | undefined
  /**
   * The seam that carries the stamper into this host, when the host has a
   * single designated one (Next's `next/dist/server/config`). Left UNDEFINED
   * on purpose by hosts that do not: the defining property of this failure is
   * that nothing threw, so naming a seam we merely suspect would put a
   * fabricated fact in front of the user. Rendered only when supplied.
   */
  stamperSeam?: HostSeam | undefined
  /** "Vite", "Next.js" — used in the one-sentence summary. */
  hostDisplayName: string
  fetchImpl?: ProbeFetch
}

export interface StampVerification {
  evidence: StampEvidence
  /**
   * The bridge tag was present in at least one probed document. Surfaced
   * because it is BOTH a teardown precondition (condition 3 — proving we
   * reached the app's own HTML rather than a proxy error page or an auth
   * redirect) and a fact the boot's smoke line reports in its own right.
   */
  bridgeTagPresent: boolean
  probes: RouteProbe[]
  /** `null` when the host offers no module graph, or it was never consulted. */
  moduleGraphSaidYes: boolean | null
}

export async function verifyStamping(req: VerifyStampingRequest): Promise<StampVerification> {
  const doFetch: ProbeFetch = req.fetchImpl ?? ((url) => fetch(url))
  const routes = dedupeRoutes(["/", ...(req.probeRoutes ?? [])])
  const probes: RouteProbe[] = []
  for (const route of routes) {
    probes.push(await probeRoute(doFetch, req.url, route))
  }

  const bridgeTagPresent = probes.some((p) => p.bridgeTag)
  const htmlStamps = probes.reduce((sum, p) => sum + p.stamps, 0)

  if (htmlStamps > 0) {
    // Conclusive on its own, and reached BEFORE the module graph is consulted:
    // there is no path from here to a weaker verdict, which is the
    // "never demote" rule expressed as control flow rather than as a comment.
    const first = probes.find((p) => p.sample !== null)
    return {
      evidence: {
        verdict: "stamped",
        how: `served HTML at ${first?.url ?? req.url}`,
        sample: first?.sample ?? "",
        count: htmlStamps,
      },
      bridgeTagPresent,
      probes,
      moduleGraphSaidYes: null,
    }
  }

  // Only now, and only because the HTML said nothing. A throw here is not a
  // verdict — a graph walk that errors is an absence of evidence, so it lands
  // as `null` and the conjunction below treats it as "did not say yes".
  let moduleGraphSaidYes: boolean | null = null
  if (req.moduleGraphEvidence) {
    moduleGraphSaidYes = await req.moduleGraphEvidence().catch(() => null)
  }

  if (moduleGraphSaidYes === true) {
    return {
      evidence: {
        verdict: "stamped",
        how: "the dev server's module graph (a compiled module carries data-desde-src)",
        // The walk answers a boolean, not a location. Saying so beats
        // inventing a plausible-looking path.
        sample: "(module graph — attribute observed in compiled output)",
        count: 0,
      },
      bridgeTagPresent,
      probes,
      moduleGraphSaidYes,
    }
  }

  // ── The teardown conjunction (§ 6) ──────────────────────────────────────
  // Five conditions, ALL of which must hold before we are allowed to blame the
  // stamper. Each `unmet` line below is a real failure mode that a two-valued
  // check would have mis-attributed: a 502 from the proxy, an auth redirect, a
  // client-rendered app, a cold graph. Blaming stamping for a server that is
  // simply broken sends the user to fix the wrong thing.
  const unmet: string[] = []
  if (req.stampExpectation !== "required-in-html") {
    unmet.push(expectationReason(req.stampExpectation))
  }
  for (const p of probes) {
    if (p.error !== null) unmet.push(`${p.route} could not be fetched (${p.error})`)
    else if (p.status !== 200) unmet.push(`${p.route} returned HTTP ${p.status}`)
    else if (!p.html) unmet.push(`${p.route} is ${p.contentType ?? "an unknown content type"}, not text/html`)
  }
  if (!bridgeTagPresent) {
    unmet.push(
      "the bridge <script> tag was not in any probed document, so this may not be the app's own HTML " +
        "(a proxy error page, an auth redirect, or a stripped transformIndexHtml would all look like this)",
    )
  }
  if (moduleGraphSaidYes === null && req.moduleGraphEvidence) {
    unmet.push("the module-graph walk failed, so it could neither confirm nor rule out stamping")
  }

  if (unmet.length > 0) {
    return {
      evidence: { verdict: "indeterminate", reason: unmet.join("; ") },
      bridgeTagPresent,
      probes,
      moduleGraphSaidYes,
    }
  }

  const checked = probes.map((p) => p.url).join(", ")
  const failure: HostFailure = {
    code: "injection-not-observed",
    summary:
      `Editor booted your ${req.hostDisplayName} dev server, but the source-code stamper is not ` +
      "running. The server is healthy; every edit would have been refused.",
    ...(req.stamperSeam ? { seam: req.stamperSeam } : {}),
    cause:
      `Checked ${checked} (server-rendered, HTTP 200, bridge tag present). ` +
      "Found 0 data-desde-src attributes.",
    remediation: [
      // Deliberately generic. The concrete two-command form — with this host's
      // own dev command and the repo path the user typed — is rendered by
      // `ladder.ts`, which is the only place that knows both. One renderer with
      // the facts beats two with different wordings.
      "Start the project's own dev server and re-run Editor with --attach <url>. Attach mode " +
        "does not use the in-process stamper channel.",
    ],
    // Attach mode needs none of our in-process seams, so it covers this.
    attachCovers: true,
  }

  return {
    evidence: { verdict: "unstamped", how: `served HTML at ${checked}`, failure },
    bridgeTagPresent,
    probes,
    moduleGraphSaidYes,
  }
}

/**
 * Why zero stamps is inconclusive for this expectation. Phrased as the missing
 * condition, because it is read inside a "could not conclude because …" list.
 */
function expectationReason(expectation: StampExpectation): string {
  switch (expectation) {
    case "module-graph":
      return "this host's stamps live in the module graph, not the served HTML, so the document says nothing"
    case "post-hydration":
      return "this app renders on the client, so stamps appear only after hydration where an HTTP probe cannot see them"
    case "partial":
      return "this host stamps only part of its source (`.astro` markup has no stamper), so a stamp-free document is expected"
    case "required-in-html":
      // Unreachable — the caller only asks when the expectation is NOT this.
      return "server-rendered"
  }
}

async function probeRoute(doFetch: ProbeFetch, origin: string, route: string): Promise<RouteProbe> {
  const url = origin.replace(/\/+$/, "") + route
  try {
    const res = await doFetch(url)
    const contentType = res.headers.get("content-type")
    const body = await res.text()
    return {
      route,
      url,
      status: res.status,
      contentType,
      html: (contentType ?? "").toLowerCase().includes("text/html"),
      bridgeTag: body.includes(BRIDGE_TAG_MARKER),
      stamps: countStamps(body),
      sample: firstStamp(body),
      error: null,
    }
  } catch (err) {
    return {
      route,
      url,
      status: null,
      contentType: null,
      html: false,
      bridgeTag: false,
      stamps: 0,
      sample: null,
      error: (err as Error).message,
    }
  }
}

function countStamps(body: string): number {
  // `data-desde-src=` rather than the bare attribute name: the latter also matches
  // the stamper's own source text if a repo happens to serve it, and matches
  // this file's prose in a self-hosted demo.
  return body.match(/data-desde-src=/g)?.length ?? 0
}

function firstStamp(body: string): string | null {
  return /data-desde-src="([^"]*)"/.exec(body)?.[1] ?? null
}

/** `/` first, everything else in declared order, no duplicates. */
function dedupeRoutes(routes: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of routes) {
    const route = raw.startsWith("/") ? raw : `/${raw}`
    if (seen.has(route)) continue
    seen.add(route)
    out.push(route)
  }
  return out
}
