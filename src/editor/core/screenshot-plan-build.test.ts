import { describe, expect, it } from "vitest"
import { buildRouteEnumerationPlan } from "./screenshot-plan-build"
import { validateScreenshotPlan } from "./screenshot-plan"

describe("buildRouteEnumerationPlan", () => {
  const plan = buildRouteEnumerationPlan({
    name: "All screens",
    baseUrl: "http://localhost:5173",
    routes: [
      { path: "/", name: "home" },
      { path: "/about", name: "about" },
      { path: "/settings/profile" },
    ],
  })

  it("emits a navigate + capture pair per route", () => {
    expect(plan.source).toBe("route-enumeration")
    expect(plan.steps).toHaveLength(6)
    expect(plan.steps.map((s) => s.kind)).toEqual([
      "navigate",
      "capture",
      "navigate",
      "capture",
      "navigate",
      "capture",
    ])
  })

  it("uses the route path on navigate steps and a viewport capture", () => {
    expect(plan.steps[0]).toMatchObject({ kind: "navigate", route: "/" })
    expect(plan.steps[1]).toMatchObject({
      kind: "capture",
      capture: { scope: "viewport", label: "home" },
    })
    // Falls back to the path as the label when the route has no name.
    expect(plan.steps[5]).toMatchObject({
      kind: "capture",
      capture: { scope: "viewport", label: "/settings/profile" },
    })
  })

  it("produces a plan that passes validateScreenshotPlan", () => {
    const candidate = { ...plan, id: "p1", createdAt: "2026-06-12T00:00:00.000Z" }
    expect(validateScreenshotPlan(candidate)).toEqual({ valid: true, errors: [] })
  })

  it("produces an empty step list for no routes", () => {
    const empty = buildRouteEnumerationPlan({
      name: "x",
      baseUrl: "http://localhost:5173",
      routes: [],
    })
    expect(empty.steps).toEqual([])
  })
})
