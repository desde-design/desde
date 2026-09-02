import { describe, expect, it } from "vitest"
import { DeniedContent } from "./page"

/**
 * `DeniedContent` is the sync presentational half of the `/denied` route (the
 * default export is `async`, because Next 16 hands `searchParams` in as a
 * Promise). Rendering it through `react-dom/server` would need a DOM-ish
 * environment this suite does not configure, so these read the returned
 * element tree directly — enough to assert WHICH copy variant was selected,
 * which is the only branch this component has.
 */
function copyOf(reason?: string): { title: unknown; description: unknown } {
  // <main> → <EmptyState title=… description=… />
  const main = DeniedContent({ reason }) as {
    props: { children: { props: { title: unknown; description: unknown } } }
  }
  return main.props.children.props
}

describe("DeniedContent", () => {
  it("shows the invite-only copy by default", () => {
    expect(copyOf().title).toBe("This viewer is invite-only")
  })

  it("shows the invite-link copy for reason=invite-invalid", () => {
    expect(copyOf("invite-invalid").title).toBe("That invite link is no longer valid")
  })

  it("shows the sign-in-link copy for reason=link-invalid", () => {
    expect(copyOf("link-invalid").title).toBe("That sign-in link is no longer valid")
  })

  it("falls back to the default copy for an unrecognized reason", () => {
    expect(copyOf("something-else").title).toBe("This viewer is invite-only")
  })

  /**
   * `reason` comes off the query string, so it is attacker-chosen. A plain
   * object literal inherits from `Object.prototype`, so a bare
   * `COPY_BY_REASON[reason]` lookup resolves `"constructor"`, `"toString"` and
   * friends to FUNCTIONS rather than `undefined` — the `??` fallback then
   * keeps the function, `copy.title` is `undefined`, and the page renders
   * blank. Every one of these must land on the default copy.
   */
  it.each(["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "__defineGetter__"])(
    "falls back to the default copy for the prototype-chain key %j",
    (reason) => {
      const copy = copyOf(reason)
      expect(copy.title).toBe("This viewer is invite-only")
      expect(copy.description).toBe("Ask an admin to invite you.")
    },
  )
})
