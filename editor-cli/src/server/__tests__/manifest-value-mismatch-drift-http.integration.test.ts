/**
 * Caller-side guarantee for the Phase 5 carry-forward (g) manifest-value-
 * mismatch drift check, proven over the REAL `POST /api/editor/edit`
 * HTTP route (not just the helper in isolation — `manifest-value-mismatch-
 * drift.test.ts` already proves the helper itself never throws and never
 * records on failure; this file proves the EDIT RESPONSE is unaffected and
 * not delayed even when the drift check is slow and ultimately throws).
 *
 * Review round 2 (2026-07-30) caught that the first landing awaited the
 * check INSIDE `withCliSessionLock`, before `sendJson` — delaying the
 * triggering edit's own response and holding the per-repo lock for the
 * duration, blocking every other queued edit to the same repo. The fix
 * moved the check to fire-and-forget, called AFTER the response is sent
 * and OUTSIDE the lock. This file pins that fix: a `groundingLoaders` stub
 * that takes DELAY_MS and then rejects must not add anywhere near that to
 * the edit response, and a second queued edit to the same repo must not be
 * blocked behind the first edit's still-running background check.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { newSecurityContext } from "../auth.js"
import type { GroundingLoaders } from "../grounding-context.js"

const SFC_SOURCE = [
  "<template>",
  "  <div>",
  '    <KButton appearance="primary">Click</KButton>',
  "  </div>",
  "</template>",
].join("\n")

// SFC-absolute (line, column) of `<KButton`'s opening `<` — line 3, 4
// leading spaces, column 5 (1-based). Same convention `data-desde-src` uses.
const KBUTTON_LINE = 3
const KBUTTON_COLUMN = 5

/** Rejects after `delayMs` — simulates a slow, ultimately-failing grounding resolution. */
/**
 * A grounding loader that takes `delayMs` and then rejects, and TELLS YOU when
 * it did.
 *
 * `settled` is the point of the second return value. These tests prove the
 * response does not WAIT for the background drift check, and they used to
 * prove it with `expect(elapsedMs).toBeLessThan(DELAY_MS / 2)` — a wall-clock
 * budget, which conflates the property ("did not wait") with an absolute
 * machine-speed claim ("finished within 200ms"). Under the full parallel suite
 * a perfectly correct response measured 245ms and failed.
 *
 * With `settled` the assertion becomes an ORDERING one: the response resolved
 * before the loader did. That is true on any machine at any speed, and it is
 * what "does not wait for it" actually means.
 */
function slowThrowingGroundingLoaders(delayMs: number): {
  loaders: GroundingLoaders
  settled: Promise<void>
} {
  let markSettled!: () => void
  const settled = new Promise<void>((resolve) => {
    markSettled = resolve
  })
  return {
    loaders: {
      loadCreateGroundingService: () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => {
            markSettled()
            reject(new Error("grounding boom (simulated)"))
          }, delayMs)
        }),
    },
    settled,
  }
}

/**
 * Resolves to the label of whichever settled first.
 *
 * Used instead of a stopwatch: "the response won the race against the drift
 * check" is the property, and it holds regardless of how slow the machine is.
 */
async function firstToSettle<T>(
  a: { label: string; promise: Promise<T> },
  b: { label: string; promise: Promise<unknown> },
): Promise<string> {
  return Promise.race([a.promise.then(() => a.label), b.promise.then(() => b.label)])
}

const DELAY_MS = 400

/** Settles when the background drift check's loader rejects. */
let driftCheckSettled: Promise<void>
let handle: HttpServerHandle
let bundleDir: string
let repoDir: string
let token: string
let shellOrigin: string

function authedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  return fetch(input, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: shellOrigin,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  })
}

function propEditBody(value: string): string {
  return JSON.stringify({
    edit: {
      kind: "prop",
      file: "App.vue",
      line: KBUTTON_LINE,
      column: KBUTTON_COLUMN,
      propName: "appearance",
      value,
    },
  })
}

beforeEach(async () => {
  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-mvm-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")

  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-mvm-repo-"))
  await writeFile(join(repoDir, "App.vue"), SFC_SOURCE, "utf8")

  // `port: 0`, bound by the OS with no window for another worker to take it.
  // The shell ORIGIN is only string-compared by the Origin guard — nothing
  // listens on it — so it needs to be unique, not free.
  shellOrigin = "http://127.0.0.1:59998"
  const security = newSecurityContext(shellOrigin)
  token = security.token

  const grounding = slowThrowingGroundingLoaders(DELAY_MS)
  driftCheckSettled = grounding.settled

  handle = await startHttpServer({
    host: "127.0.0.1",
    port: 0,
    repoRoot: repoDir,
    uiBundleRoot: bundleDir,
    viteUrl: "http://localhost:5173",
    security,
    // Slow AND ultimately failing — proves the check is genuinely
    // fire-and-forget (not awaited before responding) and that a throw
    // deep inside it never surfaces as an unhandled rejection or a
    // spurious drift entry.
    groundingLoaders: grounding.loaders,
  })
})

afterEach(async () => {
  await handle.close()
  await rm(bundleDir, { recursive: true, force: true })
  await rm(repoDir, { recursive: true, force: true })
})

describe("POST /api/editor/edit — manifest-value-mismatch drift check never delays or breaks the response", () => {
  it("returns promptly with a successful result even when the background drift check is slow and throws", async () => {
    const request = authedFetch(`${handle.url}/api/editor/edit`, {
      method: "POST",
      body: propEditBody("secondary"),
    })

    // The property, stated as an ORDERING rather than a stopwatch: the
    // response settles before the drift check does. `expect(elapsedMs)
    // .toBeLessThan(DELAY_MS / 2)` used to stand in for this and failed at
    // 245ms under the full parallel suite — a correct response that was
    // merely slower than an arbitrary 200ms budget.
    const winner = await firstToSettle(
      { label: "response", promise: request },
      { label: "drift-check", promise: driftCheckSettled },
    )
    expect(winner).toBe("response")

    const res = await request
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; file?: string }
    expect(json.ok).toBe(true)
    expect(json.file).toBe("App.vue")

    // Give the background check time to run to completion (and throw) —
    // it must not surface as an unhandled rejection (which would fail the
    // test process) or record a spurious drift entry.
    await new Promise((r) => setTimeout(r, DELAY_MS + 200))

    const driftRes = await authedFetch(`${handle.url}/api/editor/drift`)
    expect(driftRes.status).toBe(200)
    const driftJson = (await driftRes.json()) as { entries: unknown[] }
    expect(driftJson.entries).toEqual([])
  })

  it("a second queued edit to the same repo is not blocked while the first edit's background drift check is still running", async () => {
    const first = await authedFetch(`${handle.url}/api/editor/edit`, {
      method: "POST",
      body: propEditBody("secondary"),
    })
    expect(first.status).toBe(200)

    // Immediately queue a second edit to the SAME file/repo. If the drift
    // check from the first edit were still holding the per-repo session
    // lock, this would be delayed by roughly DELAY_MS. It should instead
    // resolve promptly, since the lock was released as soon as the first
    // edit's `applyEdit` finished.
    const secondRequest = authedFetch(`${handle.url}/api/editor/edit`, {
      method: "POST",
      body: propEditBody("primary"),
    })

    // Same ordering assertion as above. If the first edit's drift check still
    // held the per-repo session lock, this second edit could not settle until
    // that check finished — so "response wins the race" IS "not blocked by
    // it", on any machine at any speed.
    const winner = await firstToSettle(
      { label: "response", promise: secondRequest },
      { label: "drift-check", promise: driftCheckSettled },
    )
    expect(winner).toBe("response")

    const second = await secondRequest
    expect(second.status).toBe(200)
    const json = (await second.json()) as { ok: boolean }
    expect(json.ok).toBe(true)
  })
})
