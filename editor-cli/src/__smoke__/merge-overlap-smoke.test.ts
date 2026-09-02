/**
 * Merge-overlap smoke test — validates the integration points between
 * the phase-3-notes-slice branch (CLI v1 Phases 1-3: storage/handlers,
 * shell-chrome rewrite, Comments/Notes/Flows/Canvas) and the main
 * branch's detached-sessions work (session picker + detail panel +
 * lock-events endpoint), as merged in commit 59a5052.
 *
 * The two branches both rewrote / extended these surfaces in
 * parallel:
 *
 *   1. editor-right-rail.tsx — phase-3 introduced a 4-tab layout
 *      (Edit / Annotations / Flows / Activity); main added a session
 *      picker into the chat panel header + a detail panel sibling.
 *      The merge keeps phase-3's structure and re-homes main's
 *      affordances inside it (Edit-tab chat header + sibling sheet).
 *
 *   2. editor-cli/src/server/http-server.ts — phase-3 registered
 *      artifact routes (comments/notes/screenshot-plans/canvases)
 *      + a /state polling route; main registered chat sessions list
 *      + detail + lock-events routes. The bootstrap.js payload also
 *      grew on both sides (detachedSessions flag vs. user identity).
 *      The merge unions both route exemption groups AND both payload
 *      fields.
 *
 *   3. src/components/editor/editor-surface.tsx — auto-merged;
 *      surface now threads BOTH phase-3's iframeMode/activeTab state
 *      AND main's chatSessions/onReAnchorToSession through to the
 *      right rail.
 *
 * This spec exercises (1)+(2) in a real browser against a real CLI
 * boot, which is the only way to catch wire-level breakage that
 * unit tests can't see (e.g. an auth-policy regression that 412s the
 * picker fetch; a route-prefix typo that 404s the artifact list).
 *
 * The covered overlap matrix:
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ Surface              │ Phase-3 added        │ Main added    │
 *   ├─────────────────────────────────────────────────────────────┤
 *   │ Right-rail tabs      │ 4 tabs (E/A/F/Ac)   │ —              │
 *   │ Chat panel header    │ —                    │ Session picker│
 *   │ HTTP /api/editor/  │ comments/notes/      │ chat/sessions │
 *   │                      │  plans/canvases/      │  + /:id +     │
 *   │                      │  state                │  lock-events  │
 *   │ Bootstrap payload    │ user.{username,…}    │ detachedSessns│
 *   └─────────────────────────────────────────────────────────────┘
 *
 * If a future change reverts one side, this test fails — which is
 * the whole point. The CLAUDE.md rule "the CLI edit handler and the
 * web edit route must stay behavior-identical" applies to merges
 * too: the bootstrap payload and route exemptions are shared
 * surface that both sides extended.
 *
 * Companion documents:
 *   - tasks/_archive/test-plans/merge-overlap-test-plan-2026-05-26.md
 *     — full plan + manual checks for the bits this spec can't drive
 *     (e.g. the session tab strip's per-row click behavior, exercised
 *     by chat-session-tabs.test.tsx).
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { resolve as resolvePath, join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { chromium, type Browser } from "playwright"

const REPO_ROOT = resolvePath(__dirname, "..", "..", "..")
// The spike fixture was relocated under tasks/_archive/spikes/ in the
// 2026-05-26 doc cleanup; the pre-cleanup path (tasks/spike-path-b/)
// no longer exists.
const TEST_APP_FIXTURE = resolvePath(
  REPO_ROOT,
  "tasks",
  "_archive",
  "spikes",
  "spike-path-b",
  "test-app",
)
const CLI_ENTRY = resolvePath(__dirname, "..", "cli.ts")

// Distinct ports from browser-smoke.test.ts (4322/5174) AND
// phase3-browser-smoke.test.ts (4323/5175) so all three smoke specs
// can run in parallel CI workers without colliding.
const SHELL_PORT = 4324
const VITE_PORT = 5176

const SHELL_URL = `http://127.0.0.1:${SHELL_PORT}`
const VITE_URL = `http://127.0.0.1:${VITE_PORT}`

let cli: ChildProcess | null = null
let browser: Browser | null = null
let tempAppDir: string | null = null
let cachedToken: string | null = null

const SYSTEM_CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

beforeAll(async () => {
  if (!existsSync(SYSTEM_CHROME)) {
    throw new Error(
      `Browser smoke requires Chrome at ${SYSTEM_CHROME}. Install Chrome or run \`npx playwright install chromium\` and adapt the launcher.`,
    )
  }
  if (!existsSync(TEST_APP_FIXTURE)) {
    throw new Error(`Spike test-app fixture missing at ${TEST_APP_FIXTURE}`)
  }
  if (!existsSync(resolvePath(TEST_APP_FIXTURE, "node_modules", ".bin", "vite"))) {
    throw new Error(
      `Spike test-app deps not installed; run \`npm install\` in ${TEST_APP_FIXTURE}`,
    )
  }

  // Copy the fixture into a tempdir + symlink node_modules. Skip
  // `.git` and `dist` for the same reasons as phase3-browser-smoke
  // (we run a fresh git init below; dist would bloat the copy).
  tempAppDir = mkdtempSync(join(tmpdir(), "editor-cli-merge-overlap-"))
  for (const entry of readdirSync(TEST_APP_FIXTURE)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") {
      continue
    }
    cpSync(resolvePath(TEST_APP_FIXTURE, entry), resolvePath(tempAppDir, entry), {
      recursive: true,
    })
  }
  symlinkSync(
    resolvePath(TEST_APP_FIXTURE, "node_modules"),
    resolvePath(tempAppDir, "node_modules"),
  )

  // Initialize a fresh git repo so the CLI's worktree-session mode
  // boots cleanly. Pin user identity locally so the test doesn't
  // depend on / pollute the global ~/.gitconfig. Same pattern as
  // phase3-browser-smoke.test.ts.
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", tempAppDir!, ...args], { stdio: "pipe" })
  git("init", "--quiet")
  git("config", "user.email", "merge-overlap-smoke@example.com")
  git("config", "user.name", "Merge Overlap Smoke")
  git("config", "commit.gpgsign", "false")
  writeFileSync(
    resolvePath(tempAppDir, ".gitignore"),
    "node_modules\n.desde\n",
  )
  git("add", "-A")
  git("commit", "--quiet", "-m", "merge-overlap smoke fixture baseline")

  cli = spawn(
    "npx",
    [
      "tsx",
      CLI_ENTRY,
      tempAppDir,
      "--no-open",
      "--shell-port",
      String(SHELL_PORT),
      "--vite-port",
      String(VITE_PORT),
    ],
    {
      cwd: resolvePath(__dirname, "..", ".."),
      stdio: "pipe",
      // Notes is a DORMANT surface, and this file's subject is the AUTH
      // layer in front of it: that its routes are exempt from the Origin
      // requirement, and that a nested GET reaches the handler's 404
      // rather than the auth gate's 403. Once the surface went dormant,
      // `dormantSurfaceRefusal` started answering 403 before either
      // assertion could be reached, so both tests silently stopped
      // testing what they are named for and simply failed.
      //
      // Turning the lane on is the fix rather than deleting them: the
      // dormancy gate itself is covered by 13 unit tests in
      // `__tests__/dormant-surfaces.test.ts`, and CLAUDE.md's rule is that
      // a dormant lane whose tests rot is a lane that cannot be
      // un-dormanted. These are that lane's route tests.
      env: { ...process.env, EDITOR_NOTES: "1" },
    },
  )
  cli.stdout?.on("data", (d) => process.stderr.write(`[cli] ${d}`))
  cli.stderr?.on("data", (d) => process.stderr.write(`[cli-err] ${d}`))

  await waitForUrl(`${SHELL_URL}/__desde/bootstrap.js`, 15_000)
  await waitForUrl(`${VITE_URL}/`, 15_000)

  browser = await chromium.launch({
    executablePath: SYSTEM_CHROME,
    headless: true,
  })
}, 45_000)

afterAll(async () => {
  if (browser) {
    await browser.close().catch(() => {})
  }
  if (cli) {
    cli.kill("SIGTERM")
    await new Promise<void>((r) => setTimeout(r, 1500))
    if (cli.exitCode === null) cli.kill("SIGKILL")
  }
  if (tempAppDir) {
    rmSync(tempAppDir, { recursive: true, force: true })
  }
}, 15_000)

describe("merge-overlap: bootstrap payload (phase-3 ⊕ main fields)", () => {
  it("emits BOTH detachedSessions flag (main) AND user identity (phase-3)", async () => {
    const res = await fetch(`${SHELL_URL}/__desde/bootstrap.js`)
    const text = await res.text()
    const match = text.match(/window\.__DESDE_CLI__=(\{.*\});/)
    if (!match) throw new Error("bootstrap.js shape unexpected")
    const payload = JSON.parse(match[1]) as {
      token: string
      shellOrigin: string
      viteUrl: string
      sessionId: string | null
      worktreePath: string | null
      detachedSessions?: boolean
      user?: { username: string; hostname: string }
    }

    // Sanity fields (would already fail other smokes if broken)
    expect(payload.token).toMatch(/^[a-f0-9]+$/)
    expect(payload.shellOrigin).toBe(SHELL_URL)
    expect(payload.viteUrl).toBe(VITE_URL)

    // Main-side: detachedSessions defaults to true when unset.
    // Regression would be the field disappearing entirely.
    expect(payload).toHaveProperty("detachedSessions")
    expect(typeof payload.detachedSessions).toBe("boolean")

    // Phase-3 side: cli user identity for CLI-authored comments/notes.
    expect(payload).toHaveProperty("user")
    expect(payload.user?.username).toEqual(expect.any(String))
    expect(payload.user?.hostname).toEqual(expect.any(String))
    expect(payload.user!.username.length).toBeGreaterThan(0)
    expect(payload.user!.hostname.length).toBeGreaterThan(0)
  })
})

describe("merge-overlap: HTTP route exemptions (both groups auth-pass with bearer)", () => {
  // Each branch added GET routes to the "read-only origin if-present"
  // exemption list. If the merge dropped EITHER half, the dropped
  // routes would 403 here for missing Origin (browsers don't always
  // send it on same-origin GETs).
  //
  // We test the auth-pass path: send Bearer but NO Origin. Codex
  // round-1 noted the v1 of this suite was too loose — accepting
  // 404 made a dropped handler indistinguishable from a working
  // exemption. v2 asserts:
  //   - List endpoints: 200 + the documented JSON key
  //   - Nested-id GETs with a known-missing id: 404 from the handler
  //     (not 403/401 from the auth gate)

  // [path, expectedKey, expectedStatus]
  // expectedStatus 200 = list endpoint returns an empty/populated
  // array under expectedKey. The empty repo always returns an empty
  // collection for these.
  const PHASE3_LIST_ROUTES: Array<[string, string]> = [
    ["/api/editor/comments", "comments"],
    ["/api/editor/notes", "notes"],
    ["/api/editor/screenshot-plans", "plans"],
    ["/api/editor/canvases", "canvases"],
  ]

  // Singleton (non-list) read-only routes — assert a documented field
  // instead of a collection key. (/api/editor/state died with the
  // worktree-session teardown, PR #16 2026-07-21; branches is the
  // branch-mode equivalent read.)
  const PHASE3_SINGLETON_ROUTES: Array<[string, string]> = [
    ["/api/editor/branches", "branches"],
  ]

  // Nested-id routes — assert a known-missing id returns the
  // handler's 404 reason, NOT the auth gate's 403. Catches the
  // case where someone reverts the `startsWith` exemption arm
  // to an exact-match check (would 403 every nested probe).
  const PHASE3_NESTED_GET_ROUTES: string[] = [
    "/api/editor/comments/missing-id",
    "/api/editor/notes/missing-id",
    "/api/editor/screenshot-plans/missing-id",
    "/api/editor/canvases/missing-id",
  ]

  it.each(PHASE3_LIST_ROUTES)(
    "phase-3 list endpoint %s returns 200 + { ok, %s: [] } without Origin",
    async (pathname, expectedKey) => {
      const token = await getToken()
      const res = await fetch(`${SHELL_URL}${pathname}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      })
      const bodyText = await res.text()
      expect(res.status, `Body: ${bodyText}`).toBe(200)
      const body = JSON.parse(bodyText) as Record<string, unknown>
      expect(body.ok).toBe(true)
      expect(body).toHaveProperty(expectedKey)
      expect(Array.isArray(body[expectedKey])).toBe(true)
    },
  )

  it.each(PHASE3_SINGLETON_ROUTES)(
    "phase-3 singleton endpoint %s returns 200 + documented field %s",
    async (pathname, expectedKey) => {
      const token = await getToken()
      const res = await fetch(`${SHELL_URL}${pathname}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      })
      const bodyText = await res.text()
      expect(res.status, `Body: ${bodyText}`).toBe(200)
      const body = JSON.parse(bodyText) as Record<string, unknown>
      expect(body.ok).toBe(true)
      expect(body).toHaveProperty(expectedKey)
    },
  )

  it.each(PHASE3_NESTED_GET_ROUTES.map((p) => [p]))(
    "phase-3 nested GET %s returns handler 404 (not auth 403)",
    async (pathname) => {
      const token = await getToken()
      const res = await fetch(`${SHELL_URL}${pathname}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      })
      // 404 = handler ran and reported missing. 403/401 = auth gate
      // killed the request before the handler saw it (exemption
      // narrowing regression).
      const bodyText = await res.text()
      expect(res.status, `Body: ${bodyText}`).toBe(404)
    },
  )

  it("main /api/editor/chat/sessions returns 200 + sessions array without Origin", async () => {
    const token = await getToken()
    const res = await fetch(`${SHELL_URL}/api/editor/chat/sessions`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    })
    const bodyText = await res.text()
    expect(res.status, `Body: ${bodyText}`).toBe(200)
    const body = JSON.parse(bodyText) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body).toHaveProperty("sessions")
    expect(Array.isArray(body.sessions)).toBe(true)
  })

  it("main /api/editor/chat/sessions/:id with missing id returns 404 (handler, not auth)", async () => {
    // Confirms the `startsWith(/api/editor/chat/sessions/)` exemption
    // arm survived. 404 = handler reported missing session. 403 =
    // auth gate blocked the request (exemption arm dropped).
    const token = await getToken()
    const res = await fetch(
      `${SHELL_URL}/api/editor/chat/sessions/does-not-exist`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
    )
    const bodyText = await res.text()
    expect(res.status, `Body: ${bodyText}`).toBe(404)
  })

  it("main /api/editor/chat/sessions/:id/lock-events with missing id is exempt", async () => {
    // Codex round-1 follow-up: lock-events is the OTHER detached-
    // sessions endpoint under the `:id/` prefix. Same exemption arm.
    const token = await getToken()
    const res = await fetch(
      `${SHELL_URL}/api/editor/chat/sessions/does-not-exist/lock-events`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
    )
    const bodyText = await res.text()
    // 404 = handler reported missing session. 403 = auth gate
    // blocked. Any other status (200 + empty list, 503, etc.) is
    // also acceptable as long as it's NOT 401/403.
    expect(
      [401, 403].includes(res.status),
      `lock-events returned ${res.status} — auth gate blocked it instead of letting the handler respond. Body: ${bodyText}`,
    ).toBe(false)
  })

  it("a route NOT in the exemption list still requires Origin (sanity)", async () => {
    // Negative control: if THIS passes auth, the exemption logic is
    // too permissive and the above positives don't prove anything.
    const token = await getToken()
    const res = await fetch(`${SHELL_URL}/api/editor/edit`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(403)
  })
})

describe("merge-overlap: right-rail layout (browser-rendered)", () => {
  // Risk zone 1 — the load-bearing merge conflict. Phase-3 introduced
  // the 4-tab rail; main re-homed its session affordances inside it.
  // This is the ONLY zone that unit tests can't fully cover at the
  // integration level, because it depends on the whole React tree
  // mounting under the real CLI bundle (not jsdom with mocked deps).
  //
  // This used to be deferred: the UI bundle imported `@/services/
  // firebase`, which threw `auth/invalid-api-key` at module load when
  // NEXT_PUBLIC_FIREBASE_* wasn't baked in, blocking the React mount in
  // headless smoke. Moot since 2026-08-08 — the Firebase auth surface was
  // deleted outright, so there is no init to throw and no config to bake.
  //
  // Note: main's session picker (`chat-session-picker-trigger`) was
  // replaced by a horizontal tab strip (`chat-session-tabs`, commit
  // 0cfda329) after the original test plan was written. We anchor on
  // the tab strip — same merge-overlap intent (main's session
  // affordance hosted inside phase-3's Edit-tab chat panel), current
  // testid.

  it("mounts the merged chrome + 4-tab rail + session tab strip", async () => {
    if (!browser) throw new Error("browser not initialized")
    const page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text())
    })
    const httpErrors: string[] = []
    page.on("response", (res) => {
      if (res.status() >= 400) {
        httpErrors.push(`${res.request().method()} ${res.status()} ${res.url()}`)
      }
    })

    // `domcontentloaded`, not `networkidle`: the editor page keeps a
    // Vite HMR socket open and polls `/api/editor/state`, so the
    // network never goes idle. The explicit testid waits below are the
    // real readiness signal.
    await page.goto(SHELL_URL, { waitUntil: "domcontentloaded", timeout: 15_000 })

    // Chrome mounted (the floating EditorToolbar). If the Firebase init
    // regression ever returns, the React tree never reaches this and
    // the wait times out — a precise signal, not a silent skip.
    await page
      .locator('[data-testid="editor-toolbar"]')
      .waitFor({ state: "visible", timeout: 15_000 })

    // Rail mounted with all four tabs (Edit / Chat / Comments /
    // Activity). A dropped tab makes the matching waitFor time out. (Playwright's locator.waitFor is the
    // assertion here — vitest's `expect` has no `toBeVisible` matcher.)
    await page
      .locator('[data-testid="editor-right-rail"]')
      .waitFor({ state: "visible", timeout: 10_000 })
    for (const tab of ["edit", "chat", "comments", "activity"]) {
      await page
        .locator(`[data-testid="right-rail-tab-${tab}"]`)
        .waitFor({ state: "visible", timeout: 10_000 })
    }

    // The session affordance: the tab strip was replaced by the
    // chat-session-menu dropdown (chat-session-menu.tsx) — it lives in
    // the Chat tab. Click the tab, then wait for the menu. A timeout
    // here means the session affordance was dropped.
    await page.locator('[data-testid="right-rail-tab-chat"]').click()
    await page
      .locator('[data-testid="chat-session-menu"]')
      .waitFor({ state: "visible", timeout: 10_000 })

    // Activity tab re-homes main's SessionLogPanel. forceMount keeps
    // it in the DOM but hidden until selected, so click then wait for
    // it to surface.
    await page.locator('[data-testid="right-rail-tab-activity"]').click()
    await page
      .locator('[data-testid="activity-panel-branch"]')
      .waitFor({ state: "visible", timeout: 10_000 })

    // The merged shell polls two endpoints on mount that the CLI
    // server intentionally does NOT implement. Shell components poll
    // them defensively and degrade to empty state in CLI mode:
    //   - session/orphans  → orphan-resume-dialog (detached sessions)
    //   - session/log      → Activity panel's SessionLogPanel
    // The Activity-panel / orphan backing endpoints are Phase 4 work
    // (not started — see tasks/STATUS.md), so a 4xx here is a known
    // gap, not a merge regression. Anything ELSE that 4xxs is a real
    // integration defect (e.g. a read-only GET that lost its Origin
    // exemption) and must fail this test — that's the whole point of
    // exercising the merged layout in a real browser.
    const KNOWN_UNIMPLEMENTED_ENDPOINTS = [
      "/api/editor/session/orphans",
      "/api/editor/session/log",
    ]
    const unexpectedHttp = httpErrors.filter(
      (e) => !KNOWN_UNIMPLEMENTED_ENDPOINTS.some((p) => e.includes(p)),
    )
    expect(
      unexpectedHttp,
      `Unexpected HTTP >=400 during layout smoke: ${unexpectedHttp.join("\n")}`,
    ).toEqual([])

    // Resource-load console errors are the browser's echo of the HTTP
    // 4xx above (no URL attached, so we gate on httpErrors instead).
    // Filter them out; what remains would be a real runtime error
    // (React render crash, uncaught exception, CSP violation).
    const unexpectedConsole = consoleErrors.filter(
      (e) => !/Failed to load resource/.test(e),
    )
    expect(
      unexpectedConsole,
      `Unexpected console errors during layout smoke: ${unexpectedConsole.join("\n")}`,
    ).toEqual([])
    await page.close()
  }, 30_000)
})

// ---------------------------------------------------------------------
// Helpers — local copies of the patterns in browser-smoke.test.ts;
// each smoke spec keeps its own copies to avoid coupling teardowns.
// (When a third+ spec wants the same helpers, factor into
// editor-cli/src/__smoke__/helpers.ts.)
// ---------------------------------------------------------------------

async function getToken(): Promise<string> {
  if (cachedToken) return cachedToken
  const res = await fetch(`${SHELL_URL}/__desde/bootstrap.js`)
  const text = await res.text()
  const match = text.match(/"token":"([a-f0-9]+)"/)
  if (!match) throw new Error("token not in bootstrap.js")
  cachedToken = match[1]
  return cachedToken
}

async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
      lastErr = new Error(`status ${res.status}`)
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(
    `URL ${url} not ready within ${timeoutMs}ms: ${(lastErr as Error)?.message ?? "unknown"}`,
  )
}
