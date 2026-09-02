/**
 * The readonly type box.
 *
 * A prop whose type the rail cannot edit still shows what that type IS, and
 * the manifest records it verbatim — so its length is bounded by whatever the
 * library author wrote, not by the rail. vue-router's `to` is the case that
 * broke it.
 */

import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { PropControl } from "./prop-control"
import type { ComponentPropManifest } from "@/editor/core"

/** vue-router's `to`, verbatim — 88 characters with no break opportunity. */
const LONG_UNION =
  "string | RouteLocationAsRelativeGeneric | RouteLocationAsPathGeneric | undefined"

function typedProp(valueType: string): ComponentPropManifest {
  return {
    name: "to",
    type: valueType,
    required: false,
    control: { kind: "unknown", valueType },
  } as ComponentPropManifest
}

describe("PropControl — the readonly type box", () => {
  it("clips a type too long for the row instead of overflowing it", () => {
    render(<PropControl prop={typedProp(LONG_UNION)} currentValue={undefined} />)

    const box = screen.getByText(LONG_UNION)
    // `truncate` is what keeps it on one line. Without it the union wrapped to
    // three lines inside a fixed h-6 box and painted over the props above and
    // below — a type nobody can edit hiding two that they can.
    expect(box.className).toContain("truncate")
    // And the clip has to be enforced by the box, not just requested by the
    // text: a flex child will otherwise refuse to shrink below its content.
    expect(box.parentElement?.className).toContain("overflow-hidden")
    expect(box.parentElement?.className).toContain("h-6")
  })

  it("keeps the full type reachable, since truncating hides it", () => {
    render(<PropControl prop={typedProp(LONG_UNION)} currentValue={undefined} />)
    expect(screen.getByTitle(LONG_UNION)).toBeInTheDocument()
  })

  it("still shows a short type in full", () => {
    render(<PropControl prop={typedProp("CardMetric[]")} currentValue={undefined} />)
    expect(screen.getByText("CardMetric[]")).toBeInTheDocument()
  })
})
