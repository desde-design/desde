/**
 * HTTP-handler tests for screenshot plans: CRUD + screenshots parity with
 * flows, plus the route-enumeration endpoint driven against a temp repo with
 * a real Vue Router file.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Readable } from "node:stream"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { IncomingMessage, ServerResponse } from "node:http"

import type {
  ScreenshotPlan,
  ScreenshotPlanCreateInput,
} from "../../../../src/editor/core"
import type { FlowScreenshot } from "../../../../src/types/bridge"
import { createLocalScreenshotPlanStore } from "../stores/local-screenshot-plan-store"
import {
  handleScreenshotPlansRequest,
  matchesScreenshotPlansRoute,
} from "../screenshot-plans-handler"

let tmp: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "plans-handler-test-"))
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

interface CapturedRes {
  res: ServerResponse
  result: () => { status: number; body: unknown }
}

function mockReq(method: string, url: string, body?: unknown): IncomingMessage {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = Readable.from(payload) as unknown as IncomingMessage
  req.method = method
  req.url = url
  return req
}

function mockRes(): CapturedRes {
  let status = 0
  let body = ""
  const res = {
    statusCode: 0,
    setHeader() {},
    end(chunk?: string) {
      status = (this as unknown as ServerResponse).statusCode
      body = chunk ?? ""
    },
  } as unknown as ServerResponse
  return {
    res,
    result: () => ({ status, body: body ? JSON.parse(body) : undefined }),
  }
}

interface PlanResp {
  ok?: boolean
  reason?: string
  plan?: ScreenshotPlan
  plans?: ScreenshotPlan[]
  screenshots?: FlowScreenshot[]
  skipped?: { path: string; why: string }[]
}

async function call(
  method: string,
  url: string,
  body?: unknown,
  framework?: "vue3" | "react",
): Promise<{ status: number; body: PlanResp }> {
  const store = createLocalScreenshotPlanStore(tmp)
  const { res, result } = mockRes()
  await handleScreenshotPlansRequest(mockReq(method, url, body), res, {
    store,
    repoRoot: tmp,
    framework,
  })
  return result() as { status: number; body: PlanResp }
}

const PREFIX = "/api/editor/screenshot-plans"

const sampleCreate = (
  o: Partial<ScreenshotPlanCreateInput> = {},
): ScreenshotPlanCreateInput => ({
  name: "All screens",
  baseUrl: "http://localhost:5173",
  source: "route-enumeration",
  steps: [
    { intent: "Navigate to /about", kind: "navigate", route: "/about" },
    {
      intent: "Capture /about",
      kind: "capture",
      capture: { scope: "viewport", label: "about" },
    },
  ],
  ...o,
})

const ROUTER = `import { createRouter, createWebHistory } from 'vue-router'
import Home from '../views/Home.vue'
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: Home },
    { path: '/about', name: 'about', component: () => import('../views/About.vue') },
    { path: '/users/:id', name: 'user', component: () => import('../views/User.vue') },
  ],
})
export default router`

async function writeRouter(source = ROUTER): Promise<void> {
  await fs.mkdir(path.join(tmp, "src", "router"), { recursive: true })
  await fs.writeFile(path.join(tmp, "src", "router", "index.ts"), source)
}

const REACT_ROUTER = `import { createBrowserRouter } from 'react-router-dom'
import Home from '../views/Home'
import About from '../views/About'
import User from '../views/User'

const router = createBrowserRouter([
  { path: '/', element: <Home /> },
  { path: '/about', element: <About /> },
  { path: '/users/:id', element: <User /> },
])

export default router`

async function writeReactRouter(source = REACT_ROUTER): Promise<void> {
  await fs.mkdir(path.join(tmp, "src"), { recursive: true })
  await fs.writeFile(path.join(tmp, "src", "router.tsx"), source)
}

// Data-router projects commonly keep the route TABLE in plain .ts (no JSX —
// `Component:`/`lazy:` reference components instead of embedding `<Foo />`
// element literals), with JSX confined to the component files themselves.
const REACT_ROUTER_PLAIN_TS = `import { createBrowserRouter } from 'react-router-dom'
import Home from '../views/Home'
import About from '../views/About'

const router = createBrowserRouter([
  { path: '/', Component: Home },
  { path: '/about', Component: About },
])

export default router`

async function writeReactRouterPlainTs(source = REACT_ROUTER_PLAIN_TS): Promise<void> {
  await fs.mkdir(path.join(tmp, "src"), { recursive: true })
  await fs.writeFile(path.join(tmp, "src", "router.ts"), source)
}

describe("matchesScreenshotPlansRoute", () => {
  it("matches the prefix and sub-paths only", () => {
    expect(matchesScreenshotPlansRoute(PREFIX)).toBe(true)
    expect(matchesScreenshotPlansRoute(`${PREFIX}/abc`)).toBe(true)
    expect(matchesScreenshotPlansRoute("/api/editor/flows")).toBe(false)
  })
})

describe("CRUD", () => {
  it("creates, lists, and gets a plan", async () => {
    const created = await call("POST", PREFIX, sampleCreate())
    expect(created.status).toBe(201)
    expect(created.body.plan!.id).toBeTruthy()
    const id = created.body.plan!.id

    const listed = await call("GET", PREFIX)
    expect(listed.status).toBe(200)
    expect((listed.body.plans ?? []).map((p) => p.id)).toContain(id)

    const got = await call("GET", `${PREFIX}/${id}`)
    expect(got.status).toBe(200)
    expect(got.body.plan!.name).toBe("All screens")
  })

  it("rejects a create missing required fields", async () => {
    const r = await call("POST", PREFIX, sampleCreate({ baseUrl: "" }))
    expect(r.status).toBe(400)
    expect(r.body.reason).toMatch(/baseUrl|required/i)
  })

  it("rejects a create with a malformed step", async () => {
    const r = await call("POST", PREFIX, {
      ...sampleCreate(),
      steps: [{ intent: "bad navigate", kind: "navigate" }], // no route
    })
    expect(r.status).toBe(400)
    expect(r.body.reason).toMatch(/invalid plan|route/i)
  })

  it("404s an unknown id", async () => {
    const r = await call("GET", `${PREFIX}/nope`)
    expect(r.status).toBe(404)
  })

  it("patches and deletes", async () => {
    const created = await call("POST", PREFIX, sampleCreate())
    const id = created.body.plan!.id
    const patched = await call("PATCH", `${PREFIX}/${id}`, { name: "Renamed" })
    expect(patched.status).toBe(200)
    expect(patched.body.plan!.name).toBe("Renamed")
    const deleted = await call("DELETE", `${PREFIX}/${id}`)
    expect(deleted.status).toBe(200)
    expect((await call("GET", `${PREFIX}/${id}`)).status).toBe(404)
  })

  it("rejects a PATCH whose merged steps are malformed", async () => {
    const created = await call("POST", PREFIX, sampleCreate())
    const id = created.body.plan!.id
    // A capture step missing its required `capture` spec — the create path
    // would reject it; PATCH must too (it used to persist silently).
    const r = await call("PATCH", `${PREFIX}/${id}`, {
      steps: [{ intent: "snap", kind: "capture" }],
    })
    expect(r.status).toBe(400)
    expect(r.body.reason).toMatch(/invalid plan|capture/i)
    // The stored plan is unchanged (still has the original valid steps).
    const got = await call("GET", `${PREFIX}/${id}`)
    expect(got.body.plan!.steps.some((s) => s.kind === "navigate")).toBe(true)
  })

  it("404s a PATCH to an unknown id", async () => {
    const r = await call("PATCH", `${PREFIX}/nope`, { name: "x" })
    expect(r.status).toBe(404)
  })

  it("405s an unsupported method on the collection", async () => {
    const r = await call("PUT", PREFIX, {})
    expect(r.status).toBe(405)
  })
})

describe("screenshots", () => {
  it("saves + reads screenshots; 404 when the plan is missing", async () => {
    const created = await call("POST", PREFIX, sampleCreate())
    const id = created.body.plan!.id
    const shots = [
      { stepIndex: 1, dataUrl: "data:image/png;base64,AAAA", width: 100, height: 80 },
    ]
    const saved = await call("POST", `${PREFIX}/${id}/screenshots`, {
      screenshots: shots,
    })
    expect(saved.status).toBe(200)
    const got = await call("GET", `${PREFIX}/${id}/screenshots`)
    expect(got.body.screenshots!).toHaveLength(1)

    const orphan = await call("POST", `${PREFIX}/missing/screenshots`, {
      screenshots: shots,
    })
    expect(orphan.status).toBe(404)
  })
})

describe("route-enumeration", () => {
  it("enumerates routes, builds + persists a navigate→capture plan", async () => {
    await writeRouter()
    const r = await call("POST", `${PREFIX}/route-enumeration`, {
      baseUrl: "http://localhost:5173",
    })
    expect(r.status).toBe(201)
    expect(r.body.plan!.source).toBe("route-enumeration")
    // / and /about are static → 2 nav+capture pairs (4 steps); /users/:id skipped.
    expect(r.body.plan!.steps).toHaveLength(4)
    expect(r.body.plan!.steps[0]).toMatchObject({ kind: "navigate", route: "/" })
    expect((r.body.skipped ?? []).some((s) => s.path === "/users/:id")).toBe(true)

    // Persisted — shows up in the list.
    const listed = await call("GET", PREFIX)
    expect((listed.body.plans ?? []).map((p) => p.id)).toContain(r.body.plan!.id)
  })

  it("422s when no router file can be found", async () => {
    const r = await call("POST", `${PREFIX}/route-enumeration`, {
      baseUrl: "http://localhost:5173",
    })
    expect(r.status).toBe(422)
    expect(r.body.reason).toMatch(/auto-detect|router/i)
  })

  it("400s when baseUrl is missing", async () => {
    await writeRouter()
    const r = await call("POST", `${PREFIX}/route-enumeration`, {})
    expect(r.status).toBe(400)
    expect(r.body.reason).toMatch(/baseUrl/i)
  })

  it("enumerates routes for a React prototype (real React Router temp repo), builds + persists a plan", async () => {
    await writeReactRouter()
    const r = await call(
      "POST",
      `${PREFIX}/route-enumeration`,
      { baseUrl: "http://localhost:5173" },
      "react",
    )
    expect(r.status).toBe(201)
    expect(r.body.plan!.source).toBe("route-enumeration")
    // / and /about are static → 2 nav+capture pairs (4 steps); /users/:id skipped.
    expect(r.body.plan!.steps).toHaveLength(4)
    expect(r.body.plan!.steps[0]).toMatchObject({ kind: "navigate", route: "/" })
    expect((r.body.skipped ?? []).some((s) => s.path === "/users/:id")).toBe(true)

    // Persisted — shows up in the list.
    const listed = await call("GET", PREFIX)
    expect((listed.body.plans ?? []).map((p) => p.id)).toContain(r.body.plan!.id)
  })

  it("auto-detects a plain .ts React router (no JSX — Component:/lazy: shape)", async () => {
    await writeReactRouterPlainTs()
    const r = await call(
      "POST",
      `${PREFIX}/route-enumeration`,
      { baseUrl: "http://localhost:5173" },
      "react",
    )
    expect(r.status).toBe(201)
    expect(r.body.plan!.steps).toHaveLength(4)
    expect((r.body.plan!.steps ?? []).map((s) => (s.kind === "navigate" ? s.route : undefined))).toEqual(
      expect.arrayContaining(["/", "/about"]),
    )
  })

  it("422s when no React router file can be found (vue-only temp repo)", async () => {
    await writeRouter()
    const r = await call(
      "POST",
      `${PREFIX}/route-enumeration`,
      { baseUrl: "http://localhost:5173" },
      "react",
    )
    expect(r.status).toBe(422)
    expect(r.body.reason).toMatch(/auto-detect|router/i)
    // Nothing persisted for the rejected request.
    const listed = await call("GET", PREFIX)
    expect(listed.body.plans ?? []).toHaveLength(0)
  })

  it("422s when the router has no static routes", async () => {
    await writeRouter(`import { createRouter, createWebHistory } from 'vue-router'
const router = createRouter({
  history: createWebHistory(),
  routes: [ { path: '/:id', name: 'x', component: X } ],
})
export default router`)
    const r = await call("POST", `${PREFIX}/route-enumeration`, {
      baseUrl: "http://localhost:5173",
    })
    expect(r.status).toBe(422)
    expect(r.body.reason).toMatch(/no statically-navigable/i)
  })
})
