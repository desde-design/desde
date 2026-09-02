import { describe, expect, it } from "vitest"
import type { ScreenshotPlanStep } from "../core/screenshot-plan"
import { applyHealToStep, validateHealedTarget } from "./heal-plan-step"

const interactStep = (
  target: Partial<NonNullable<ScreenshotPlanStep["target"]>> = {},
): ScreenshotPlanStep => ({
  intent: "click the Create model button",
  kind: "interact",
  action: "click",
  target: {
    description: "the Create model submit button",
    role: "button",
    name: "Create model",
    resolvedSelector: "button.stale",
    ...target,
  },
})

describe("validateHealedTarget", () => {
  it("accepts a live element that matches role + exact name", () => {
    const v = validateHealedTarget(interactStep(), {
      found: true,
      selector: "button.create-v2",
      role: "button",
      name: "Create model",
    })
    expect(v).toEqual({ valid: true })
  })

  it("accepts a partial rename that still shares a token with the intent", () => {
    // "Create model" → "Create a model" — shares 'create'/'model'.
    const v = validateHealedTarget(interactStep(), {
      found: true,
      selector: "button.create-v2",
      role: "button",
      name: "Create a model",
    })
    expect(v.valid).toBe(true)
  })

  it("rejects when the proposal did not resolve (the heal MISS)", () => {
    expect(validateHealedTarget(interactStep(), null).valid).toBe(false)
    expect(validateHealedTarget(interactStep(), { found: false }).valid).toBe(false)
  })

  it("rejects a role mismatch (button intent, resolved a link)", () => {
    const v = validateHealedTarget(interactStep(), {
      found: true,
      selector: "a.nav",
      role: "link",
      name: "Create model",
    })
    expect(v.valid).toBe(false)
    expect(v.reason).toMatch(/role mismatch/i)
  })

  it("rejects an unrelated element even when role matches (the wrong-element guard)", () => {
    // Same role, but "Delete account" shares no significant token with the intent.
    const v = validateHealedTarget(interactStep(), {
      found: true,
      selector: "button.delete",
      role: "button",
      name: "Delete account",
    })
    expect(v.valid).toBe(false)
    expect(v.reason).toMatch(/doesn't match|intent/i)
  })

  it("rejects an element with no accessible name", () => {
    const v = validateHealedTarget(interactStep(), {
      found: true,
      selector: "button.icon",
      role: "button",
      name: "",
    })
    expect(v.valid).toBe(false)
    expect(v.reason).toMatch(/no accessible name/i)
  })

  it("does not reject on role when the step recorded no role (only name/description)", () => {
    const step = interactStep({ role: undefined })
    const v = validateHealedTarget(step, {
      found: true,
      selector: "button.create",
      role: "button",
      name: "Create model",
    })
    expect(v.valid).toBe(true)
  })

  it("matches intent via the description when the name drifts but the description carries the word", () => {
    const step = interactStep({ name: "Submit", description: "the button that saves the new model" })
    const v = validateHealedTarget(step, {
      found: true,
      selector: "button.save",
      role: "button",
      name: "Save model",
    })
    // 'model' is shared with the description.
    expect(v.valid).toBe(true)
  })

  it("refuses to heal a non-interact step", () => {
    const cap: ScreenshotPlanStep = {
      intent: "snap",
      kind: "capture",
      capture: { scope: "viewport", label: "x" },
    }
    expect(validateHealedTarget(cap, { found: true, selector: "x", name: "y" }).valid).toBe(false)
  })
})

describe("applyHealToStep", () => {
  it("rewrites resolvedSelector + role + name, preserving the description", () => {
    const healed = applyHealToStep(interactStep(), {
      found: true,
      selector: "button.create-v2",
      role: "button",
      name: "Create a model",
    })
    expect(healed.target?.resolvedSelector).toBe("button.create-v2")
    expect(healed.target?.role).toBe("button")
    expect(healed.target?.name).toBe("Create a model")
    // The durable NL intent is preserved (the next heal re-resolves against it).
    expect(healed.target?.description).toBe("the Create model submit button")
    // Other step fields untouched.
    expect(healed.kind).toBe("interact")
    expect(healed.action).toBe("click")
  })

  it("falls back to the step intent for description when the target had none", () => {
    const step: ScreenshotPlanStep = {
      intent: "click submit",
      kind: "interact",
      action: "click",
      target: { description: "", resolvedSelector: "old" },
    }
    const healed = applyHealToStep(step, { found: true, selector: "new", name: "Submit" })
    expect(healed.target?.description).toBe("click submit")
    expect(healed.target?.resolvedSelector).toBe("new")
  })
})
