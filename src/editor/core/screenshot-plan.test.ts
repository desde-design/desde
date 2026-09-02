import { describe, expect, it } from "vitest"
import {
  validateScreenshotPlan,
  type ScreenshotPlan,
} from "./screenshot-plan"

const validPlan = (
  overrides: Partial<ScreenshotPlan> = {},
): ScreenshotPlan => ({
  id: "plan-1",
  name: "Create model flow",
  baseUrl: "http://localhost:5173",
  source: "prompt",
  prompt: "go to model-create, fill the form, submit",
  createdAt: "2026-06-12T00:00:00.000Z",
  steps: [
    { intent: "open model-create", kind: "navigate", route: "/models/new" },
    {
      intent: "fill the name field",
      kind: "interact",
      action: "fill",
      target: { description: "the model name input" },
      value: "gpt-x",
    },
    {
      intent: "submit the form",
      kind: "interact",
      action: "click",
      target: { description: "the Create button", role: "button", name: "Create" },
    },
    {
      intent: "snapshot the result",
      kind: "capture",
      capture: { scope: "viewport", label: "model created" },
    },
  ],
  ...overrides,
})

describe("validateScreenshotPlan", () => {
  it("accepts a well-formed plan", () => {
    const res = validateScreenshotPlan(validPlan())
    expect(res).toEqual({ valid: true, errors: [] })
  })

  it("rejects a non-object", () => {
    expect(validateScreenshotPlan(null).valid).toBe(false)
    expect(validateScreenshotPlan("nope").valid).toBe(false)
  })

  it("flags missing top-level fields", () => {
    const res = validateScreenshotPlan(
      validPlan({ id: "", name: "", baseUrl: "", createdAt: "" }),
    )
    expect(res.valid).toBe(false)
    expect(res.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/id/),
        expect.stringMatching(/name/),
        expect.stringMatching(/baseUrl/),
        expect.stringMatching(/createdAt/),
      ]),
    )
  })

  it("rejects an unknown source", () => {
    const res = validateScreenshotPlan(
      validPlan({ source: "magic" as ScreenshotPlan["source"] }),
    )
    expect(res.valid).toBe(false)
    expect(res.errors.some((e) => /source/.test(e))).toBe(true)
  })

  it("requires steps to be an array", () => {
    const res = validateScreenshotPlan(
      validPlan({ steps: "x" as unknown as ScreenshotPlan["steps"] }),
    )
    expect(res.valid).toBe(false)
    expect(res.errors).toContain("steps must be an array")
  })

  it("flags a step missing its intent", () => {
    const res = validateScreenshotPlan(
      validPlan({
        steps: [{ intent: "", kind: "navigate", route: "/x" }],
      }),
    )
    expect(res.valid).toBe(false)
    expect(res.errors.some((e) => /intent/.test(e))).toBe(true)
  })

  it("requires route for navigate", () => {
    const res = validateScreenshotPlan(
      validPlan({ steps: [{ intent: "go", kind: "navigate" }] }),
    )
    expect(res.valid).toBe(false)
    expect(res.errors.some((e) => /route/.test(e))).toBe(true)
  })

  it("requires a valid action + target for interact", () => {
    const res = validateScreenshotPlan(
      validPlan({
        steps: [
          {
            intent: "do",
            kind: "interact",
            action: "tap" as never,
          },
        ],
      }),
    )
    expect(res.valid).toBe(false)
    expect(res.errors.some((e) => /action/.test(e))).toBe(true)
    expect(res.errors.some((e) => /target/.test(e))).toBe(true)
  })

  it("requires value for fill / select interactions", () => {
    const res = validateScreenshotPlan(
      validPlan({
        steps: [
          {
            intent: "fill",
            kind: "interact",
            action: "fill",
            target: { description: "the input" },
          },
        ],
      }),
    )
    expect(res.valid).toBe(false)
    expect(res.errors.some((e) => /value/.test(e))).toBe(true)
  })

  it("does not require value for click interactions", () => {
    const res = validateScreenshotPlan(
      validPlan({
        steps: [
          {
            intent: "click",
            kind: "interact",
            action: "click",
            target: { description: "the button" },
          },
        ],
      }),
    )
    expect(res).toEqual({ valid: true, errors: [] })
  })

  it("requires capture scope + label", () => {
    const res = validateScreenshotPlan(
      validPlan({
        steps: [
          {
            intent: "snap",
            kind: "capture",
            capture: { scope: "weird" as never, label: "" },
          },
        ],
      }),
    )
    expect(res.valid).toBe(false)
    expect(res.errors.some((e) => /scope/.test(e))).toBe(true)
    expect(res.errors.some((e) => /label/.test(e))).toBe(true)
  })

  it("requires selector when capture scope is selector", () => {
    const res = validateScreenshotPlan(
      validPlan({
        steps: [
          {
            intent: "snap el",
            kind: "capture",
            capture: { scope: "selector", label: "the card" },
          },
        ],
      }),
    )
    expect(res.valid).toBe(false)
    expect(res.errors.some((e) => /selector/.test(e))).toBe(true)
  })

  it("rejects an unknown step kind", () => {
    const res = validateScreenshotPlan(
      validPlan({
        steps: [{ intent: "x", kind: "teleport" as never }],
      }),
    )
    expect(res.valid).toBe(false)
    expect(res.errors.some((e) => /kind/.test(e))).toBe(true)
  })
})
