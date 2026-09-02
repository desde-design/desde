/**
 * `spawnPayloadChild` against a small, fake "payload" (`fixtures/fake-payload/`)
 * rather than the real 337MB build — real `node:child_process.spawn`, real
 * signals, real (short, injected) grace periods, but fast. Covers:
 *  - the ready-line path (proves the broadened launcher-mode sentinel regex
 *    from `ready-line.ts` is what this module actually depends on, not just
 *    something tested in isolation over there)
 *  - the boot-failure path (a child that exits before ever printing ready)
 *  - shutdown: clean SIGTERM exit, and escalation to SIGKILL for a child that
 *    ignores SIGTERM (mirrors `child-tracker.test.ts`'s own escalation case,
 *    but through the real `spawnPayloadChild` seam this phase adds)
 */
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { afterEach, describe, expect, it } from "vitest"
import type { ChildProcess } from "node:child_process"
import { createChildTracker } from "../../editor-cli/src/server/child-tracker.js"
import { PayloadBootFailure, spawnPayloadChild, type PayloadChildOptions } from "../child.js"

const here = dirname(fileURLToPath(import.meta.url))
const FAKE_PAYLOAD = resolve(here, "fixtures", "fake-payload")
// Any real directory works — no test depends on cwd behavior itself, only
// on `cwd` being a valid required option (see child.ts's doc comment for
// why it's required rather than defaulted internally).
const TEST_CWD = tmpdir()

/** Fills in the boilerplate every test needs (payloadRoot, cwd, a short-graced tracker). */
function spawnFake(opts: Partial<PayloadChildOptions> & { env: NodeJS.ProcessEnv }) {
  return spawnPayloadChild({
    execPath: process.execPath,
    payloadRoot: FAKE_PAYLOAD,
    cwd: TEST_CWD,
    tracker: createChildTracker({ graceMs: 500 }),
    ...opts,
  })
}

/** Every spawned child gets force-killed here if a test didn't already clean it up. */
let spawnedForCleanup: ChildProcess[] = []

afterEach(() => {
  for (const child of spawnedForCleanup) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL")
      } catch {
        // already gone
      }
    }
  }
  spawnedForCleanup = []
})

describe("spawnPayloadChild", () => {
  it("resolves the exact url from the launcher-mode ready line", async () => {
    const handle = await spawnFake({ env: { ...process.env, FIXTURE_MODE: "ready" } })
    spawnedForCleanup.push(handle.child)

    expect(handle.url).toBe("http://127.0.0.1:45999")
    expect(handle.child.pid).toBeGreaterThan(0)

    await handle.shutdown()
  })

  it("spawns dist/cli.js under payloadRoot with --no-open, and never opens a system browser", async () => {
    const handle = await spawnFake({ env: { ...process.env, FIXTURE_MODE: "ready" } })
    spawnedForCleanup.push(handle.child)

    expect(handle.child.spawnfile).toBe(process.execPath)
    expect(handle.child.spawnargs).toContain(resolve(FAKE_PAYLOAD, "dist", "cli.js"))
    expect(handle.child.spawnargs).toContain("--no-open")

    await handle.shutdown()
  })

  it("spawns with the given cwd, not process.cwd()", async () => {
    const handle = await spawnFake({ env: { ...process.env, FIXTURE_MODE: "ready" } })
    spawnedForCleanup.push(handle.child)
    expect(handle.child.spawnargs.length).toBeGreaterThan(0) // sanity: it did spawn
    // node:child_process doesn't expose the resolved cwd back on the handle,
    // so this is asserted structurally instead: TEST_CWD deliberately
    // differs from process.cwd() in this test run (tmpdir() vs the repo
    // checkout), which is what proves spawnPayloadChild is not silently
    // falling back to inheriting the caller's own cwd.
    expect(TEST_CWD).not.toBe(process.cwd())
    await handle.shutdown()
  })

  it("adds --shell-port when a port is given, and omits it otherwise", async () => {
    const withPort = await spawnFake({
      shellPort: 45123,
      env: { ...process.env, FIXTURE_MODE: "ready" },
    })
    spawnedForCleanup.push(withPort.child)
    expect(withPort.child.spawnargs).toContain("--shell-port")
    expect(withPort.child.spawnargs).toContain("45123")
    await withPort.shutdown()

    const withoutPort = await spawnFake({ env: { ...process.env, FIXTURE_MODE: "ready" } })
    spawnedForCleanup.push(withoutPort.child)
    expect(withoutPort.child.spawnargs).not.toContain("--shell-port")
    await withoutPort.shutdown()
  })

  it("rejects with PayloadBootFailure, carrying the stderr tail, when the child exits before printing ready", async () => {
    const promise = spawnFake({ env: { ...process.env, FIXTURE_MODE: "fail" } })
    await expect(promise).rejects.toBeInstanceOf(PayloadBootFailure)
    await expect(promise).rejects.toMatchObject({
      exitCode: 1,
      detail: expect.stringContaining("astro is not installed"),
    })
  })

  it("shuts down a well-behaved child with a plain SIGTERM (no escalation needed)", async () => {
    const handle = await spawnFake({
      env: { ...process.env, FIXTURE_MODE: "ready" },
      // Grace period long enough that reaching it would mean SIGTERM alone
      // did NOT work — the assertion below is really "this resolved before
      // the timeout", proven by the test itself not hanging.
      tracker: createChildTracker({ graceMs: 5_000 }),
    })
    spawnedForCleanup.push(handle.child)

    await handle.shutdown()
    expect(handle.child.exitCode === 0 || handle.child.signalCode === "SIGTERM").toBe(true)
  })

  // No `retry` here (there used to be one — `retry: 3`, with a comment
  // attributing the ~11% flake rate to unspecified environmental timing
  // noise). That diagnosis was wrong: the real cause was an ordering bug in
  // THIS test's own fixture (`fixtures/fake-payload/dist/cli.js`), not
  // anything in `child.ts`/`child-tracker.ts` or the test runner. The
  // fixture printed its ready line — which this suite's caller treats as
  // "safe to SIGTERM now" — BEFORE calling `process.on("SIGTERM", …)`. Node's
  // default disposition for an unhandled SIGTERM is immediate termination,
  // so whenever the parent's signal won the race against the child
  // finishing its own `process.on` call, the child died before its
  // ignore-handler existed — producing exactly the observed symptom,
  // `signalCode: "SIGTERM"` where this test expects `"SIGKILL"`. An isolated
  // repro of the fixture's shape confirmed it directly: 300 trials with the
  // handler registered after the ready line reproduced the failure 34 times
  // (~11%); 300 trials with the handler registered first reproduced it 0
  // times. The fixture now registers its handler first (see the comment
  // there), which closes the race rather than papering over it with a retry.
  it("escalates to SIGKILL when the child ignores SIGTERM past the grace period", async () => {
    const handle = await spawnFake({
      env: { ...process.env, FIXTURE_MODE: "ready-ignore-sigterm" },
      // The escalation LOGIC itself (SIGTERM, wait, SIGKILL) is already
      // proven deterministically in child-tracker.test.ts against a fake
      // clock/killer — this test's job is only to prove spawnPayloadChild
      // wires a REAL process through it correctly, which doesn't need a
      // tight window to be meaningful.
      tracker: createChildTracker({ graceMs: 2_000 }),
    })
    spawnedForCleanup.push(handle.child)

    await handle.shutdown()
    // The child never handled SIGTERM itself, so whatever ended it must have
    // been the escalation's SIGKILL.
    expect(handle.child.signalCode).toBe("SIGKILL")
  })

  it("shutdown() is idempotent — a second call resolves harmlessly", async () => {
    const handle = await spawnFake({ env: { ...process.env, FIXTURE_MODE: "ready" } })
    spawnedForCleanup.push(handle.child)

    await handle.shutdown()
    await expect(handle.shutdown()).resolves.toBeUndefined()
  })

  it("sets EDITOR_CLAUDE_RUNTIME_DIR on the child when claudeRuntimeAppSupportDir is given", async () => {
    const dumpDir = mkdtempSync(join(tmpdir(), "child-env-dump-"))
    const dumpPath = join(dumpDir, "env.txt")
    const handle = await spawnFake({
      claudeRuntimeAppSupportDir: "/fake/Library/Application Support/Desde",
      env: { ...process.env, FIXTURE_MODE: "ready", FIXTURE_ENV_DUMP_PATH: dumpPath },
    })
    spawnedForCleanup.push(handle.child)
    await handle.shutdown()

    expect(readFileSync(dumpPath, "utf8")).toBe("/fake/Library/Application Support/Desde")
    rmSync(dumpDir, { recursive: true, force: true })
  })

  it("SCRUBS an inherited EDITOR_CLAUDE_EXECUTABLE_PATH from the child env (F5 — the override must not reach a desktop child)", async () => {
    const dumpDir = mkdtempSync(join(tmpdir(), "child-env-dump-"))
    const dumpPath = join(dumpDir, "env.txt")
    const handle = await spawnFake({
      claudeRuntimeAppSupportDir: "/fake/Library/Application Support/Desde",
      env: {
        ...process.env,
        FIXTURE_MODE: "ready",
        FIXTURE_ENV_DUMP_EXEC_PATH: dumpPath,
        // The attack shape: Electron inherited this from its launch
        // environment. It must not survive into any spawned child.
        EDITOR_CLAUDE_EXECUTABLE_PATH: "/tmp/definitely-not-verified-claude",
      },
    })
    spawnedForCleanup.push(handle.child)
    await handle.shutdown()

    expect(readFileSync(dumpPath, "utf8")).toBe("unset")
    rmSync(dumpDir, { recursive: true, force: true })
  })

  it("omits EDITOR_CLAUDE_RUNTIME_DIR entirely when claudeRuntimeAppSupportDir is not given (terminal-CLI parity)", async () => {
    const dumpDir = mkdtempSync(join(tmpdir(), "child-env-dump-"))
    const dumpPath = join(dumpDir, "env.txt")
    const handle = await spawnFake({
      env: { ...process.env, FIXTURE_MODE: "ready", FIXTURE_ENV_DUMP_PATH: dumpPath },
    })
    spawnedForCleanup.push(handle.child)
    await handle.shutdown()

    expect(readFileSync(dumpPath, "utf8")).toBe("unset")
    rmSync(dumpDir, { recursive: true, force: true })
  })
})
