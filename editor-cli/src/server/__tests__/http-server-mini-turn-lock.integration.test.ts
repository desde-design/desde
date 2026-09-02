/**
 * The agent mini-turn must hold the working tree EXCLUSIVELY (Task 11 review,
 * Critical).
 *
 * Task 11 narrowed the edit lock from repo-wide to per-file so a slow LLM lane
 * stops blocking unrelated edits. That is safe for the deterministic and
 * llm-patch lanes, which only touch the files they were handed — but NOT for
 * the prop-refusal mini-turn (`edit-fix-mini-turn.ts`), which verifies its own
 * work by diffing whole-repo `git status` snapshots taken around the turn and,
 * on failure, rolls back everything that turned dirty inside that window.
 * With per-file scope, a legitimate concurrent edit to ANOTHER file during
 * those (up to 90s) would be:
 *   (a) reverted by the mini-turn's `git checkout -- <that file>` cleanup —
 *       silent data loss;
 *   (b) counted as agent output, so a genuinely no-op turn reports success; or
 *   (c) reported as "the agent also modified X".
 *
 * The fix is two-pass dispatch: pass 1 runs under the per-file locks with
 * `miniTurnPolicy: 'defer'` (writes nothing, refuses); the route then releases
 * and re-enters under the EXCLUSIVE tree lock for pass 2. This file proves the
 * resulting property end-to-end over the REAL HTTP route: while a mini-turn is
 * in flight on App.vue, an edit to Other.vue cannot land, and the mini-turn
 * therefore never observes it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { newSecurityContext } from "../auth.js"
import type { ApplicatorLoaders } from "../edit-handler.js"

/** Refuses with a bound-binding hint — the shape that engages the mini-turn. */
const BOUND_SOURCE = [
  "<template>",
  '  <KInput :placeholder="filterPlaceholder" />',
  "</template>",
].join("\n")

/** Plain literal prop — the deterministic lane applies it. */
const OTHER_SOURCE = [
  "<template>",
  '  <KInput placeholder="Search" />',
  "</template>",
].join("\n")

const OTHER_EDITED = OTHER_SOURCE.replace("Search", "Filter")
const BOUND_REWRITTEN = BOUND_SOURCE.replace(
  ':placeholder="filterPlaceholder"',
  'placeholder="Filter results"',
)

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

let handle: HttpServerHandle
let bundleDir: string
let repoDir: string
let token: string
let shellOrigin: string

/** Set by the mini-turn stub when it is entered. */
let miniTurnEntered: { promise: Promise<void>; resolve: () => void }
/** Held by the mini-turn stub until the test releases it. */
let miniTurnGate: { promise: Promise<void>; resolve: () => void }
let miniTurnCalls: number
/** Contents of Other.vue as observed from INSIDE the mini-turn's window. */
let otherSeenByMiniTurn: string | null
let boundApplicatorCalls: number

function authedFetch(path: string, body: unknown): Promise<Response> {
  return fetch(`${handle.url}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: shellOrigin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
}

function propEdit(file: string, value: string): unknown {
  return {
    edit: { kind: "prop", file, line: 2, column: 3, propName: "placeholder", value },
  }
}

/**
 * Applicator stubs. `applyPropEdit` branches on the SOURCE (the handler passes
 * file contents, not the path): the bound spelling refuses with a fallback
 * hint (→ mini-turn lane), the literal spelling applies deterministically.
 */
function makeLoaders(): ApplicatorLoaders {
  return {
    loadApplyPropEdit: async () => ({
      applyPropEdit: ({ source }: { source: string }) => {
        if (source.includes(":placeholder=")) {
          boundApplicatorCalls++
          return {
            ok: false as const,
            reason: 'Cannot overwrite bound prop "placeholder" — source uses v-bind.',
            fallback: { kind: "bound-binding" as const, expression: "filterPlaceholder" },
          }
        }
        return { ok: true as const, source: source.replace("Search", "Filter") }
      },
    }),
    loadApplyMoveEdit: async () => ({ applyMoveEdit: () => ({ ok: false, reason: "stub" }) }),
    loadApplyDetachEdit: async () => ({
      applyDetachEdit: () => ({ ok: false, reason: "stub" }),
    }),
    loadStyleGrounding: async () => ({
      loadStyleGrounding: () => ({ tokens: [], classTaxonomy: [], preprocessor: "css" as const }),
    }),
    loadRunEditFixMiniTurn: async () =>
      ({
        runEditFixMiniTurn: async () => {
          miniTurnCalls++
          // Observe the OTHER file from inside the turn's window — this is
          // exactly what the real turn's git snapshot diff would see, and
          // what would be misattributed / rolled back if a concurrent edit
          // could land here.
          otherSeenByMiniTurn = readFileSync(join(repoDir, "Other.vue"), "utf8")
          miniTurnEntered.resolve()
          await miniTurnGate.promise
          otherSeenByMiniTurn = readFileSync(join(repoDir, "Other.vue"), "utf8")
          await writeFile(join(repoDir, "App.vue"), BOUND_REWRITTEN, "utf8")
          return { outcome: "applied", notes: "Rewrote filterPlaceholder binding" }
        },
      }) as unknown as typeof import("../../../../src/editor/agent-chat-sdk/edit-fix-mini-turn"),
  } as unknown as ApplicatorLoaders
}

beforeEach(async () => {
  miniTurnEntered = deferred()
  miniTurnGate = deferred()
  miniTurnCalls = 0
  boundApplicatorCalls = 0
  otherSeenByMiniTurn = null

  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-miniturn-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")

  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-miniturn-repo-"))
  await writeFile(join(repoDir, "App.vue"), BOUND_SOURCE, "utf8")
  await writeFile(join(repoDir, "Other.vue"), OTHER_SOURCE, "utf8")
  // The mini-turn refuses outright when it can't snapshot git state, so the
  // fixture must be a real repo (same rationale as edit-handler.parity).
  execFileSync("git", ["init", "-q"], { cwd: repoDir })
  execFileSync("git", ["add", "-A"], { cwd: repoDir })
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"],
    { cwd: repoDir },
  )

  /*
    `port: 0` — bound by the OS during `listen`, with no window in which
    another process can take it. This used to pre-pick a port with a local
    `pickFreePort` helper that bound 0, read the number, closed, and let
    `startHttpServer` bind it again; see `http-server-ephemeral-port.test.ts`
    for why that close-then-rebind gap is worth not having.

    NOT what made this file flaky. That was a 26-second headless browser
    launch on the mini-turn lane, fixed by `EDITOR_REVIEW_SURFACE: "off"` in
    `vitest.config.ts`.

    The shell ORIGIN is a different matter and stays a literal: it is only
    ever compared against as a string by the Origin guard, and nothing listens
    on it, so it needs to be unique rather than free.
  */
  shellOrigin = "http://127.0.0.1:59999"
  const security = newSecurityContext(shellOrigin)
  token = security.token

  handle = await startHttpServer({
    host: "127.0.0.1",
    port: 0,
    repoRoot: repoDir,
    uiBundleRoot: bundleDir,
    viteUrl: "http://localhost:5173",
    security,
    applicatorLoaders: makeLoaders(),
  })
})

afterEach(async () => {
  miniTurnGate.resolve()
  await handle.close()
  await rm(bundleDir, { recursive: true, force: true })
  await rm(repoDir, { recursive: true, force: true })
})

describe("POST /api/editor/edit — mini-turn runs whole-tree exclusive", () => {
  it("blocks a concurrent edit to another file, so the turn can't observe or revert it", async () => {
    const appEdit = authedFetch("/api/editor/edit", propEdit("App.vue", "Filter results"))
    await miniTurnEntered.promise
    expect(miniTurnCalls).toBe(1)

    // An edit to a DIFFERENT file, issued while the mini-turn holds the tree.
    // Under per-file-only locking it would sail through (different key) and
    // land inside the turn's snapshot window.
    let otherSettled = false
    const otherEdit = authedFetch("/api/editor/edit", propEdit("Other.vue", "Filter")).then(
      (r) => {
        otherSettled = true
        return r
      },
    )
    await new Promise((r) => setTimeout(r, 300))
    expect(otherSettled).toBe(false)
    expect(await readFile(join(repoDir, "Other.vue"), "utf8")).toBe(OTHER_SOURCE)

    miniTurnGate.resolve()

    const appRes = await appEdit
    expect(appRes.status).toBe(200)
    const appJson = (await appRes.json()) as { ok: boolean; fallbackUsed?: string }
    expect(appJson.ok).toBe(true)
    expect(appJson.fallbackUsed).toBe("agent-mini-turn")

    // The turn never saw the concurrent edit — nothing to misattribute or
    // roll back.
    expect(otherSeenByMiniTurn).toBe(OTHER_SOURCE)

    const otherRes = await otherEdit
    expect(otherRes.status).toBe(200)
    expect(((await otherRes.json()) as { ok: boolean }).ok).toBe(true)

    // Both edits are on disk; neither clobbered the other.
    expect(await readFile(join(repoDir, "App.vue"), "utf8")).toBe(BOUND_REWRITTEN)
    expect(await readFile(join(repoDir, "Other.vue"), "utf8")).toBe(OTHER_EDITED)
    // Exactly one turn: pass 1 deferred without running it, pass 2 ran it.
    expect(miniTurnCalls).toBe(1)
    // …and the deterministic applicator ran twice for App.vue (pass 1 + the
    // cheap re-attempt in pass 2, which re-validates the file after the gap).
    expect(boundApplicatorCalls).toBe(2)
  })

  it("does not serialize two deterministic edits to different files", async () => {
    // Control: the exclusivity above is specific to the mini-turn lane. Two
    // ordinary edits to different files still run concurrently (that's the
    // whole point of Task 11) — proven by both completing well inside the
    // time a serialized pair would need if either blocked the other.
    await writeFile(join(repoDir, "App.vue"), OTHER_SOURCE, "utf8")
    const [a, b] = await Promise.all([
      authedFetch("/api/editor/edit", propEdit("App.vue", "Filter")),
      authedFetch("/api/editor/edit", propEdit("Other.vue", "Filter")),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(miniTurnCalls).toBe(0)
    expect(await readFile(join(repoDir, "App.vue"), "utf8")).toBe(OTHER_EDITED)
    expect(await readFile(join(repoDir, "Other.vue"), "utf8")).toBe(OTHER_EDITED)
  })
})
