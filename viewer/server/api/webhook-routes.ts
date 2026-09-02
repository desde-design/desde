/**
 * `POST /api/v1/webhooks/github` — GitHub App push webhook (Phase 3c-3).
 *
 * This is the only route in the API that is authenticated by a SIGNATURE
 * rather than by an identity: GitHub is not a user, holds no session and no
 * PAT, and its request must be accepted on cryptographic evidence alone.
 * That makes the signature check the entire security boundary — everything
 * downstream (which project, which branch, whether to build) is derived from
 * a payload we have already proven GitHub wrote.
 */
import { Router } from "express"
import { createHmac, timingSafeEqual } from "node:crypto"
import type { AppDeps, RawBodyRequest } from "../create-app"
import { BuildQueueFullError } from "../build/build-queue"

/**
 * Constant-time compare of two signature strings.
 *
 * Both sides are hashed to a fixed-length digest first — the same technique
 * `authorize.ts` and `session-cookie.ts` use, and for the same two reasons:
 * `timingSafeEqual` throws on unequal-length buffers (which itself leaks the
 * expected length via which branch runs), and `!==` leaks a prefix match
 * through timing.
 */
function signaturesMatch(a: string, b: string): boolean {
  const da = createHmac("sha256", "cmp").update(a).digest()
  const db = createHmac("sha256", "cmp").update(b).digest()
  return timingSafeEqual(da, db)
}

/** `refs/heads/main` → `main`. Tags and other refs return null. */
export function branchFromRef(ref: unknown): string | null {
  if (typeof ref !== "string" || !ref.startsWith("refs/heads/")) return null
  const branch = ref.slice("refs/heads/".length)
  return branch.length > 0 ? branch : null
}

/**
 * How many recent `X-GitHub-Delivery` ids this process remembers for K05's
 * replay dedup, per app instance (scoped inside `createWebhookRoutes` below,
 * not module-level — see that function's comment). A `Map` in insertion
 * order, capped by evicting the oldest entry once over size: no timer sweep,
 * no storage table. 5,000 UUIDs is a few hundred KB — cheap — and comfortably
 * covers even a very active install (hundreds of pushes/day across every
 * connected repo) for weeks before the oldest entries age out, which is far
 * longer than GitHub's own redelivery window for a genuinely failed
 * delivery.
 */
const MAX_TRACKED_DELIVERY_IDS = 5_000

/**
 * How stale a push payload's own `repository.pushed_at` (Unix seconds) may
 * be before a delivery is refused outright, independent of the dedup above.
 * Dedup alone is not enough: `MAX_TRACKED_DELIVERY_IDS` is a BOUNDED ring, so
 * a captured signed payload replayed long after enough real traffic has
 * evicted its id would otherwise sail through as "never seen." A day is
 * generous — GitHub's own redelivery UI only offers deliveries from the last
 * several days, and no legitimate integration replays a push webhook a day
 * late — while still catching a payload captured and replayed well after the
 * fact.
 */
const MAX_PAYLOAD_AGE_MS = 24 * 60 * 60 * 1000

export function createWebhookRoutes(deps: AppDeps): Router {
  const router = Router()

  // K05: scoped to this router instance (fresh per `createApp` call, same
  // lifetime as `build-queue.ts`'s `inFlight` map), not module-level — a
  // module-level Set would leak delivery ids across every test's `createApp`
  // in the same process and make dedup tests order-dependent on each other.
  // A `Set` (not a `Map`) because only presence matters; `Set` iterates in
  // insertion order, which is what makes evicting the oldest entry a simple
  // "delete the first key seen" once over the size cap.
  const seenDeliveryIds = new Set<string>()
  function rememberDelivery(id: string): void {
    seenDeliveryIds.add(id)
    if (seenDeliveryIds.size > MAX_TRACKED_DELIVERY_IDS) {
      const oldest = seenDeliveryIds.values().next().value
      if (oldest !== undefined) seenDeliveryIds.delete(oldest)
    }
  }

  router.post(
    "/webhooks/github",
    async (req, res) => {
      // `deps.github.config`, NOT `deps.config`: the latter is the boot-time
      // snapshot, and an App provisioned through the manifest flow writes its
      // webhook secret mid-process. Reading the snapshot would 503 every push
      // delivery until the next restart — the restart this whole runtime
      // exists to remove.
      const secret = deps.github.config.githubApp?.webhookSecret
      if (!secret) {
        // Not configured: refuse rather than accept unverified input. A
        // webhook endpoint that processes unauthenticated payloads when a
        // secret is missing is strictly worse than one that is switched off.
        res.status(503).json({ error: "Webhooks are not configured" })
        return
      }

      // The RAW bytes captured by `express.json`'s `verify` hook in
      // create-app.ts — NOT `req.body`, which is the parsed object. The
      // signature covers exactly what GitHub sent, and re-serializing a
      // parsed object produces different bytes (key order, whitespace,
      // unicode escaping), so an HMAC over it would never match.
      const bodyBuf = (req as unknown as RawBodyRequest).rawBody
      if (!bodyBuf) {
        // Only reachable if the `verify` hook is removed or the route is
        // remounted outside that parser. Fail closed and say why.
        console.error("[viewer] webhook received with no raw body captured — check express.json's verify hook")
        res.status(500).json({ error: "Webhook body unavailable" })
        return
      }
      const signature = req.get("x-hub-signature-256") ?? ""
      const expected = `sha256=${createHmac("sha256", secret).update(bodyBuf).digest("hex")}`
      if (!signature || !signaturesMatch(signature, expected)) {
        res.status(401).json({ error: "Invalid signature" })
        return
      }

      // K05: dedup ONLY runs past this point, i.e. only for a request that
      // has ALREADY proven itself genuine. Checking a delivery id before the
      // signature would let an unauthenticated caller pre-poison the
      // tracked-id set with a guessed/observed id, silently swallowing the
      // real delivery when GitHub actually sends it.
      //
      // A signed delivery can otherwise be replayed without limit — anyone
      // who has ever observed one valid signed payload (a proxy log, a
      // misconfigured delivery viewer, a compromised downstream consumer)
      // could resend it forever, and every replay creates a fresh build +
      // deployment (S5's disk/inode growth) for a project that never
      // actually pushed again. `X-GitHub-Delivery` is a UUID GitHub mints
      // once per delivery ATTEMPT — a genuine retry of the SAME delivery
      // reuses it — so remembering ids already accepted turns a replay into
      // a no-op 200, identical to how GitHub's own redelivery UI expects a
      // retry to be handled (idempotent, not an error). The header is
      // optional here (not hard-required) because GitHub always sends it in
      // practice but nothing about the signature check depends on it — a
      // request missing it just skips dedup rather than being refused.
      const deliveryId = req.get("x-github-delivery")
      if (deliveryId) {
        if (seenDeliveryIds.has(deliveryId)) {
          res.json({ ok: true, ignored: "duplicate delivery" })
          return
        }
        rememberDelivery(deliveryId)
      }

      const event = req.get("x-github-event") ?? ""
      if (event === "ping") {
        res.json({ ok: true })
        return
      }
      if (event !== "push") {
        // Everything else is acknowledged and ignored. A non-2xx would make
        // GitHub mark the delivery failed and retry forever for events we
        // deliberately do not handle.
        res.json({ ok: true, ignored: event })
        return
      }

      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(bodyBuf.toString("utf8")) as Record<string, unknown>
      } catch {
        res.status(400).json({ error: "Malformed payload" })
        return
      }

      // K05, complementary to the dedup above: `repository.pushed_at` is
      // GitHub's own timestamp (Unix seconds) for when the push happened.
      // Reject anything implausibly old rather than trust it at face value —
      // this is what still catches a replay of a payload whose delivery id
      // has aged out of the bounded `seenDeliveryIds` ring. Missing or
      // non-numeric is not itself suspicious (this is best-effort, not the
      // primary defense) so it is skipped rather than refused.
      const repoForStaleness = payload.repository as { pushed_at?: unknown } | undefined
      const pushedAtMs =
        typeof repoForStaleness?.pushed_at === "number" ? repoForStaleness.pushed_at * 1000 : null
      if (pushedAtMs !== null && Date.now() - pushedAtMs > MAX_PAYLOAD_AGE_MS) {
        res.json({ ok: true, ignored: "stale delivery" })
        return
      }

      const repo = payload.repository as { full_name?: unknown } | undefined
      const fullName = typeof repo?.full_name === "string" ? repo.full_name.toLowerCase() : null
      const branch = branchFromRef(payload.ref)
      const after = typeof payload.after === "string" ? payload.after : null
      if (!fullName || !branch) {
        res.json({ ok: true, ignored: "not a branch push" })
        return
      }
      // A branch DELETE arrives as a push whose `after` is all zeroes.
      // Building it would clone a ref that no longer exists.
      if (after && /^0+$/.test(after)) {
        res.json({ ok: true, ignored: "branch deleted" })
        return
      }

      const projects = await deps.storage.listProjects()
      const matches = projects.filter((p) => {
        const cfg = p.repoConfig
        if (!cfg || !cfg.autoDeploy) return false
        return `${cfg.owner}/${cfg.name}`.toLowerCase() === fullName && cfg.branch === branch
      })

      // One read for the whole fan-out, taken before the loop's first await:
      // a reload partway through must not leave half the matched projects
      // building on the old queue and half on the new one.
      const buildQueue = deps.github.buildQueue
      const started: string[] = []
      for (const project of matches) {
        if (!buildQueue) break
        try {
          started.push(await buildQueue.start(project.id, after))
        } catch (error) {
          // K01: global capacity is exhausted — every remaining project in
          // this fan-out would reject identically, so stop trying instead of
          // burning a lookup per remaining match for a foregone conclusion.
          // A per-project `BuildInProgressError` (below) is NOT this: only
          // that one project is blocked, so the loop keeps trying the rest.
          if (error instanceof BuildQueueFullError) break
          // Already building (or transiently failed to start). Swallowed on
          // purpose: a 5xx here makes GitHub retry the delivery, which would
          // hammer a project that is mid-build. The push that is already
          // running will produce the same tip anyway.
        }
      }

      // Always 200, even when nothing matched. GitHub shows a failed delivery
      // prominently, and "no project is wired to this repo" is not an error
      // an operator should have to chase in the deliveries tab.
      res.json({ ok: true, matched: matches.length, started: started.length })
    },
  )

  return router
}
