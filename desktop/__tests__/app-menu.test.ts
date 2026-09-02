/**
 * `app-menu.ts` — the mac appMenu item (About / Hide / Quit and friends).
 * F4 (tasks/electron-app.md §5 Phase 5b review): Electron's `{ role:
 * "appMenu" }` convenience auto-labels these from `app.getName()`, which
 * MEASURES as the packaged app's internal `package.json` name
 * (`@desde/desktop`), not `PRODUCT_NAME`. This test asserts the built
 * template carries explicit `PRODUCT_NAME`-based labels instead, and that
 * none of them can silently regress back to the internal name.
 */
import { describe, expect, it } from "vitest"
import type { MenuItemConstructorOptions } from "electron"
import { buildAppMenuItem } from "../app-menu.js"
import { PRODUCT_NAME } from "../product-name.js"

function submenuOf(item: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  const submenu = item.submenu
  if (!Array.isArray(submenu)) throw new Error("expected buildAppMenuItem()'s submenu to be an array")
  return submenu
}

describe("buildAppMenuItem", () => {
  it("labels the menu item itself with PRODUCT_NAME", () => {
    expect(buildAppMenuItem().label).toBe(PRODUCT_NAME)
  })

  it("labels the About item with PRODUCT_NAME, keeping the 'about' role", () => {
    const about = submenuOf(buildAppMenuItem()).find((i) => i.role === "about")
    expect(about).toBeDefined()
    expect(about?.label).toBe(`About ${PRODUCT_NAME}`)
  })

  it("labels the Hide item with PRODUCT_NAME, keeping the 'hide' role", () => {
    const hide = submenuOf(buildAppMenuItem()).find((i) => i.role === "hide")
    expect(hide).toBeDefined()
    expect(hide?.label).toBe(`Hide ${PRODUCT_NAME}`)
  })

  it("labels the Quit item with PRODUCT_NAME, keeping the 'quit' role", () => {
    const quit = submenuOf(buildAppMenuItem()).find((i) => i.role === "quit")
    expect(quit).toBeDefined()
    expect(quit?.label).toBe(`Quit ${PRODUCT_NAME}`)
  })

  it("keeps hideOthers, unhide, and services present with their native (unlabeled) roles", () => {
    const roles = submenuOf(buildAppMenuItem())
      .map((i) => i.role)
      .filter((r): r is NonNullable<typeof r> => r !== undefined)
    expect(roles).toEqual(expect.arrayContaining(["hideOthers", "unhide", "services"]))
  })

  it("carries a Licenses… item next to About, wired to whatever click handler is passed in (AGPL-3.0 relicensing)", () => {
    let clicked = false
    const openLicenses = () => {
      clicked = true
    }
    const licenses = submenuOf(buildAppMenuItem(openLicenses)).find((i) => i.label === "Licenses…")
    expect(licenses).toBeDefined()
    expect(typeof licenses?.click).toBe("function")
    ;(licenses?.click as () => void)()
    expect(clicked).toBe(true)
  })

  it("never surfaces the internal package name anywhere in the built item", () => {
    // The guard is about the PACKAGE name (`@desde/desktop`), not the product
    // name. It used to also assert no label matched the product name, which
    // made sense when the package was called `prototools` and the product was
    // not. The rename replaced both sides of that comparison, leaving a test
    // asserting that the app menu does not contain the name of the app: it
    // reads `Desde`, so `/desde/i` matched and the test could never pass
    // again. Same failure mode as STATUS.md's "renamed Desde → Desde".
    const item = buildAppMenuItem()
    const allLabels = [item.label, ...submenuOf(item).map((i) => i.label)].filter(
      (label): label is string => typeof label === "string",
    )
    expect(allLabels.length).toBeGreaterThan(0)
    for (const label of allLabels) {
      expect(label).not.toMatch(/@desde\/desktop/i)
      // No npm-style scope leaking through either, whatever it is called.
      expect(label).not.toMatch(/^@[a-z0-9-]+\//i)
    }
    // And the product name IS expected somewhere, which is what makes the
    // assertion above about leakage rather than about absence.
    expect(allLabels.some((l) => l.includes(PRODUCT_NAME))).toBe(true)
  })
})
