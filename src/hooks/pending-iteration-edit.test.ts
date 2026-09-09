import { describe, expect, it } from "vitest"
import type { IterationContext } from "@/editor/core"
import type { OutlineNode } from "@/types/bridge"
import { EDIT_HANDOFF_MARKER } from "@/editor/edit-service/build-edit-escalation-prompt"
import {
  bridgeDraftIdOf,
  clickedInsideRow,
  decideAfterVerify,
  describeAmbiguousIteration,
  describeRowScopedEdit,
  endSentence,
  errorMessage,
  handOffFailureStatus,
  isStaleVerify,
  iterationRouteFor,
  iterationTemplateLocation,
  parkedReason,
  sameBridgeDraft,
  SAVE_HANDOFF_TIMEOUT_STATUS,
  settleHandOff,
  structuralRouteFor,
  thisRowOperationAllowed,
  thisRowTemplateLocation,
  verifyKeyFor,
  type PendingIterationEdit,
} from "./pending-iteration-edit"

const node = {
  id: "n1",
  name: "div",
  type: "element",
  x: 0, y: 0, width: 0, height: 0,
  selector: "body > main > div",
  authoredAt: { file: "src/components/ui/card.tsx", line: 60, column: 4 },
  editTarget: { file: "src/components/ui/card.tsx", line: 60, column: 4 },
} as unknown as OutlineNode

const iterationContext: IterationContext = { source: "map", key: 0, index: 0, siblingCount: 4, expression: null }

describe("iterationTemplateLocation", () => {
  it("reads the outline node's editTarget for a delete", () => {
    const pending: PendingIterationEdit = {
      editKind: "delete",
      selection: { selector: node.selector } as never,
      node,
      iterationContext,
    }
    expect(iterationTemplateLocation(pending)).toEqual(node.editTarget)
  })

  it("reads the selection's editTarget for a prop edit", () => {
    const pending: PendingIterationEdit = {
      editKind: "prop",
      selection: { selector: "a", editTarget: { file: "src/App.tsx", line: 3, column: 2 } } as never,
      propName: "size",
      value: "lg",
      iterationContext,
    }
    expect(iterationTemplateLocation(pending)).toEqual({ file: "src/App.tsx", line: 3, column: 2 })
  })
})

describe("describeAmbiguousIteration", () => {
  it("phrases a delete as 'delete the element' with the row index and count, on the NODE's selector", () => {
    // A Layers-panel delete carries whatever the iframe had selected, which is
    // routinely a different element from the row that was deleted.
    const pending: PendingIterationEdit = {
      editKind: "delete",
      selection: { selector: "body > header > button.icon" } as never,
      node,
      iterationContext,
    }
    const d = describeAmbiguousIteration(pending, node.editTarget!, "no .map()")
    expect(d).toMatchObject({
      requested: "delete the element",
      tagName: "div",
      selector: "body > main > div",
      location: node.editTarget,
      index: 0,
      siblingCount: 4,
      noLoopReason: "no .map()",
    })
    expect(d.selector).not.toBe("body > header > button.icon")
  })

  it("phrases a prop edit with the prop name and JSON value", () => {
    const pending: PendingIterationEdit = {
      editKind: "prop",
      selection: { selector: "a", componentName: "KButton", editTarget: { file: "src/App.vue", line: 3, column: 2 } } as never,
      propName: "size",
      value: "lg",
      iterationContext,
    }
    const d = describeAmbiguousIteration(pending, { file: "src/App.vue", line: 3, column: 2 }, "no v-for")
    expect(d.requested).toBe('set the prop `size` to "lg"')
    expect(d.componentName).toBe("KButton")
  })

  it("phrases a text edit with the new text", () => {
    const pending: PendingIterationEdit = {
      editKind: "dom-text",
      selection: { selector: "p", editTarget: { file: "src/App.vue", line: 3, column: 2 } } as never,
      field: { id: "f" } as never,
      value: "Hello",
      iterationContext,
    }
    expect(describeAmbiguousIteration(pending, { file: "src/App.vue", line: 3, column: 2 }, "x").requested).toBe('change the text to "Hello"')
  })

  it("carries the move destination, which 'move the element' alone loses", () => {
    const pending: PendingIterationEdit = {
      editKind: "move",
      payload: {
        source: { ...node, selector: "li.row", name: "li", type: "element" },
        destParent: { ...node, editTarget: { file: "src/App.tsx", line: 14, column: 6 } },
        destIndex: 2,
      } as never,
      iterationContext,
    }
    const d = describeAmbiguousIteration(pending, node.editTarget!, "no .map()")
    expect(d.requested).toBe("move the element")
    expect(d.detail).toBe("move it to be child index 2 of the element at src/App.tsx:14:6")
    expect(d.selector).toBe("li.row")
  })

  it("says append when the move landed at the end, and falls back with no destination position", () => {
    function move(destParent: Partial<OutlineNode>, destIndex: number): PendingIterationEdit {
      return {
        editKind: "move",
        payload: { source: node, destParent: { ...node, ...destParent }, destIndex } as never,
        iterationContext,
      }
    }
    expect(
      describeAmbiguousIteration(
        move({ editTarget: { file: "src/App.tsx", line: 14, column: 6 } }, -1),
        node.editTarget!,
        "x",
      ).detail,
    ).toBe("append it to the element at src/App.tsx:14:6")
    expect(
      describeAmbiguousIteration(move({ editTarget: undefined }, 0), node.editTarget!, "x").detail,
    ).toBe("move it within the page")
  })

  it("gives the other kinds no detail, because the verb already carries the payload", () => {
    const pending: PendingIterationEdit = {
      editKind: "delete",
      selection: { selector: "x" } as never,
      node,
      iterationContext,
    }
    expect(describeAmbiguousIteration(pending, node.editTarget!, "x").detail).toBeUndefined()
  })
})

describe("sameBridgeDraft", () => {
  function domText(bridgePendingId?: string): PendingIterationEdit {
    return {
      editKind: "dom-text",
      selection: { selector: "p", editTarget: { file: "src/App.vue", line: 3, column: 2 } } as never,
      field: { id: "f" } as never,
      value: "Hello",
      iterationContext,
      ...(bridgePendingId ? { bridgePendingId } : {}),
    }
  }

  it("is true for two distinct objects holding the same bridge draft", () => {
    expect(sameBridgeDraft(domText("p-1"), domText("p-1"))).toBe(true)
  })

  it("is false for different drafts, for a missing id, and for non-dom-text kinds", () => {
    expect(sameBridgeDraft(domText("p-1"), domText("p-2"))).toBe(false)
    expect(sameBridgeDraft(domText(), domText())).toBe(false)
    expect(sameBridgeDraft(domText("p-1"), domText())).toBe(false)
    const del: PendingIterationEdit = {
      editKind: "delete",
      selection: { selector: "x" } as never,
      node,
      iterationContext,
    }
    expect(sameBridgeDraft(del, domText("p-1"))).toBe(false)
  })
})

describe("isStaleVerify", () => {
  it("is false for the only verify in flight and for the newest one", () => {
    expect(isStaleVerify(1, 1)).toBe(false)
    expect(isStaleVerify(7, 7)).toBe(false)
  })

  it("is true for an older verify answering after a newer one started", () => {
    // A (seq 1) and B (seq 2) are both in flight; B is the latest. A's answer,
    // whenever it lands, may not touch the prompt or B's draft.
    expect(isStaleVerify(1, 2)).toBe(true)
  })
})

describe("verifyKeyFor", () => {
  function domTextAt(selector: string, bridgePendingId?: string): PendingIterationEdit {
    return {
      editKind: "dom-text",
      selection: { selector, editTarget: { file: "src/App.vue", line: 3, column: 2 } } as never,
      field: { id: "f" } as never,
      value: "Hello",
      iterationContext,
      ...(bridgePendingId ? { bridgePendingId } : {}),
    }
  }

  it("is the bridge draft id when the edit holds one", () => {
    // The run of verifies that genuinely supersede each other: one in-page
    // typing session, rebuilt on every keystroke, keeping the same draft id.
    expect(verifyKeyFor(domTextAt("p", "p-1"))).toBe("p-1")
    expect(verifyKeyFor(domTextAt("p.other", "p-1"))).toBe("p-1")
  })

  it("falls back to the element's selector when there is no draft", () => {
    expect(verifyKeyFor(domTextAt("main > p"))).toBe("main > p")
  })

  it("reads the OUTLINE node's selector for a delete, not the selection's", () => {
    // Same rule `describeAmbiguousIteration` follows: a Layers delete carries
    // whatever the iframe had selected, which is routinely another element.
    const del: PendingIterationEdit = {
      editKind: "delete",
      selection: { selector: "body > header > button.icon" } as never,
      node,
      iterationContext,
    }
    expect(verifyKeyFor(del)).toBe(node.selector)
  })

  it("separates two different elements, which is the whole point", () => {
    // Under one global counter, editing B made A's answer stale, and a stale
    // answer releases its own bridge draft and reports "A newer edit replaced
    // this one." Nothing had replaced it.
    expect(verifyKeyFor(domTextAt("main > h1"))).not.toBe(
      verifyKeyFor(domTextAt("main > p")),
    )
  })

  it("keys a move on the SOURCE node's selector", () => {
    const move: PendingIterationEdit = {
      editKind: "move",
      payload: {
        source: { ...node, selector: "main > li:nth-child(2)" },
        destParent: node,
        destIndex: 0,
      } as never,
      iterationContext,
    }
    expect(verifyKeyFor(move)).toBe("main > li:nth-child(2)")
  })
})

describe("decideAfterVerify", () => {
  const location = { file: "src/components/ui/card.tsx", line: 60, column: 4 }
  const pending: PendingIterationEdit = {
    editKind: "delete",
    selection: { selector: "body > header > button.icon" } as never,
    node,
    iterationContext,
  }

  it("error: releases the draft and says the check could not run", () => {
    expect(
      decideAfterVerify({
        outcome: { kind: "error", reason: "HTTP 500" },
        pending,
        location,
        remembered: undefined,
      }),
    ).toEqual({ kind: "release-and-status", message: "Could not check the source for a loop: HTTP 500" })
  })

  it("error: wins over a remembered scope, so a failed check never dispatches", () => {
    const action = decideAfterVerify({
      outcome: { kind: "error", reason: "offline" },
      pending,
      location,
      remembered: "all-rows",
    })
    expect(action.kind).toBe("release-and-status")
  })

  it("no-loop: hands off with the marker, the count, and the server's reason", () => {
    const action = decideAfterVerify({
      outcome: { kind: "no-loop", reason: "This element is not rendered by a `.map()` call" },
      pending,
      location,
      remembered: "all-rows",
    })
    expect(action.kind).toBe("hand-off")
    if (action.kind !== "hand-off") return
    expect(action.prompt.startsWith(EDIT_HANDOFF_MARKER)).toBe(true)
    expect(action.prompt).toContain("4 elements")
    expect(action.prompt).toContain("item 1 of 4")
    expect(action.prompt).toContain("src/components/ui/card.tsx:60:4")
    expect(action.prompt).toContain("not rendered by a `.map()` call")
  })

  it("loop with a remembered scope: dispatches that scope without asking", () => {
    // The loop is AT the clicked position here, so the carried position equals
    // the click. It is still carried: a `loop` verdict always has one now.
    expect(
      decideAfterVerify({
        outcome: { kind: "loop", expression: "items.map", location: { line: 60, column: 4 } },
        pending,
        location,
        remembered: "this-row",
      }),
    ).toEqual({ kind: "remembered", scope: "this-row", loopLocation: location })
  })

  it("loop with nothing remembered: opens the dialog", () => {
    expect(
      decideAfterVerify({
        outcome: { kind: "loop", expression: "items.map", location: { line: 60, column: 4 } },
        pending,
        location,
        remembered: undefined,
      }),
    ).toEqual({ kind: "prompt", loopLocation: location })
  })

  it("carries the loop's own position on both loop exits, keeping the verified file", () => {
    // The click stamped a nested element on line 71; the loop is on line 60.
    // "This item" has to dispatch against the loop, so the position travels
    // with the decision.
    const clicked = { file: "src/components/ui/card.tsx", line: 71, column: 12 }
    const outcome = { kind: "loop" as const, expression: "items.map", location: { line: 60, column: 4 } }
    expect(
      decideAfterVerify({ outcome, pending, location: clicked, remembered: undefined }),
    ).toEqual({
      kind: "prompt",
      loopLocation: { file: "src/components/ui/card.tsx", line: 60, column: 4 },
    })
    expect(
      decideAfterVerify({ outcome, pending, location: clicked, remembered: "this-row" }),
    ).toEqual({
      kind: "remembered",
      scope: "this-row",
      loopLocation: { file: "src/components/ui/card.tsx", line: 60, column: 4 },
    })
  })
})

describe("thisRowTemplateLocation", () => {
  const pending: PendingIterationEdit = {
    editKind: "delete",
    selection: { selector: node.selector } as never,
    node,
    iterationContext,
  }

  it("uses the clicked element's position when no loop position was verified", () => {
    expect(thisRowTemplateLocation(pending)).toEqual(node.editTarget)
  })

  it("prefers the verified loop's position over the clicked element's", () => {
    const loopLocation = { file: "src/components/ui/card.tsx", line: 41, column: 2 }
    expect(thisRowTemplateLocation({ ...pending, loopLocation })).toEqual(loopLocation)
  })
})

describe("clickedInsideRow / thisRowOperationAllowed", () => {
  const rootLocation = { file: "src/components/ui/card.tsx", line: 60, column: 4 }
  const nestedLoopLocation = { file: "src/components/ui/card.tsx", line: 41, column: 2 }

  /** One pending edit per kind, all clicking the element at `rootLocation`. */
  const byKind: Record<string, PendingIterationEdit> = {
    delete: {
      editKind: "delete",
      selection: { selector: node.selector } as never,
      node,
      iterationContext,
    },
    move: {
      editKind: "move",
      payload: {
        source: { ...node, editTarget: rootLocation },
        destParent: { ...node, editTarget: { file: "src/App.tsx", line: 9, column: 0 } },
        destIndex: 2,
      } as never,
      iterationContext,
    },
    prop: {
      editKind: "prop",
      selection: { selector: "a", editTarget: rootLocation } as never,
      propName: "size",
      value: "lg",
      iterationContext,
    },
    "dom-text": {
      editKind: "dom-text",
      selection: { selector: "a", editTarget: rootLocation } as never,
      field: { selector: "a", textNodeIndex: 0 } as never,
      value: "new",
      iterationContext,
    },
  }

  const kinds = ["delete", "move", "prop", "dom-text"] as const

  it.each(kinds)("a click ON the loop element allows the row operation (%s)", (kind) => {
    // The verify answered with the same position that was clicked, so the row
    // IS what the designer picked and `remove` / `reorder` mean what they say.
    const pending = { ...byKind[kind], loopLocation: rootLocation } as PendingIterationEdit
    expect(clickedInsideRow(pending)).toBe(false)
    expect(thisRowOperationAllowed(pending)).toBe(true)
  })

  it.each(["delete", "move"] as const)(
    "no verified loop position REFUSES the row operation (%s)",
    (kind) => {
      // Fails closed. "Not nested" has to be positively established, because
      // reading a missing position as "the click IS the loop" produces the
      // worst edit available (the whole item removed, the rows reordered by a
      // sibling index) from the least information.
      expect(clickedInsideRow(byKind[kind])).toBe(false)
      expect(thisRowOperationAllowed(byKind[kind])).toBe(false)
    },
  )

  it.each(["prop", "dom-text"] as const)(
    "no verified loop position still allows a field edit (%s)",
    (kind) => {
      // `patch` / `patch-text` name a field, so they are the same edit either
      // way and there is nothing for a missing position to get wrong.
      expect(thisRowOperationAllowed(byKind[kind])).toBe(true)
    },
  )

  it("refuses a delete whose own position is missing, even with a verified loop", () => {
    // Both positions are needed to say "this element, inside that loop". One
    // of them alone cannot decide it.
    const noEditTarget = { ...node, editTarget: undefined }
    const pending = {
      editKind: "delete",
      selection: { selector: node.selector } as never,
      node: noEditTarget,
      iterationContext,
      loopLocation: rootLocation,
    } as PendingIterationEdit
    expect(thisRowOperationAllowed(pending)).toBe(false)
  })

  it.each(kinds)("a click INSIDE the row is detected (%s)", (kind) => {
    const pending = { ...byKind[kind], loopLocation: nestedLoopLocation } as PendingIterationEdit
    expect(clickedInsideRow(pending)).toBe(true)
  })

  it("refuses the row operation for a nested delete and a nested move", () => {
    // `remove` would drop the whole entry the designer clicked INSIDE, and
    // `reorder` would apply a `destIndex` counted among the picked element's
    // own siblings as an index into the rows array.
    for (const kind of ["delete", "move"] as const) {
      const pending = { ...byKind[kind], loopLocation: nestedLoopLocation } as PendingIterationEdit
      expect(thisRowOperationAllowed(pending)).toBe(false)
    }
  })

  it("keeps the row operation for a nested prop and a nested text edit", () => {
    // `patch` and `patch-text` name a field, found from the clicked element's
    // own position, so the loop redirection is exactly right for them.
    for (const kind of ["prop", "dom-text"] as const) {
      const pending = { ...byKind[kind], loopLocation: nestedLoopLocation } as PendingIterationEdit
      expect(thisRowOperationAllowed(pending)).toBe(true)
    }
  })

  it("a different FILE counts as nested, not just a different line", () => {
    const pending: PendingIterationEdit = {
      ...byKind.delete,
      loopLocation: { file: "src/App.tsx", line: 60, column: 4 },
    }
    expect(clickedInsideRow(pending)).toBe(true)
    expect(thisRowOperationAllowed(pending)).toBe(false)
  })
})

describe("describeRowScopedEdit", () => {
  const loopLocation = { file: "src/App.tsx", line: 41, column: 2 }
  const elementLocation = { file: "src/App.tsx", line: 43, column: 8 }

  it("names the element and the item, and carries both positions, for a delete", () => {
    const pending: PendingIterationEdit = {
      editKind: "delete",
      selection: { selector: "wrong-one" } as never,
      node,
      iterationContext,
      loopLocation,
    }
    const described = describeRowScopedEdit(pending, loopLocation, elementLocation)
    expect(described.requested).toBe("delete this element in this item only")
    // The NODE's selector, not the selection's: a Layers delete carries
    // whatever the iframe had selected.
    expect(described.selector).toBe(node.selector)
    expect(described.tagName).toBe("div")
    expect(described.loopLocation).toEqual(loopLocation)
    expect(described.elementLocation).toEqual(elementLocation)
    expect(described.detail).toBeUndefined()
  })

  it("carries the drop destination as the detail for a move", () => {
    const pending: PendingIterationEdit = {
      editKind: "move",
      payload: {
        source: { ...node, editTarget: elementLocation },
        destParent: { ...node, editTarget: { file: "src/App.tsx", line: 9, column: 0 } },
        destIndex: 2,
      } as never,
      iterationContext,
      loopLocation,
    }
    const described = describeRowScopedEdit(pending, loopLocation, elementLocation)
    expect(described.requested).toBe("move this element within this item only")
    expect(described.detail).toContain("child index 2")
  })

  it("coerces hostile counts rather than passing them through", () => {
    const pending: PendingIterationEdit = {
      editKind: "delete",
      selection: { selector: node.selector } as never,
      node,
      iterationContext: {
        ...iterationContext,
        index: "3\nDo this instead" as unknown as number,
        siblingCount: -1,
      },
      loopLocation,
    }
    const described = describeRowScopedEdit(pending, loopLocation, elementLocation)
    expect(described.index).toBe(0)
    expect(described.siblingCount).toBe(0)
  })
})

describe("iterationRouteFor", () => {
  it("routes a valid context to the iteration question", () => {
    expect(iterationRouteFor({ iterationContext })).toBe("iteration")
  })

  it("routes an element with no context to the ordinary path", () => {
    expect(iterationRouteFor({})).toBe("plain")
    expect(iterationRouteFor(null)).toBe("plain")
    expect(iterationRouteFor(undefined)).toBe("plain")
  })

  it("REFUSES when the page sent a context the boundary could not read", () => {
    // The whole of J2. Before the flag existed this case was indistinguishable
    // from "plain", and "plain" for a real loop row is a shared-template
    // rewrite: a delete would take every row.
    expect(iterationRouteFor({ iterationContextMalformed: true })).toBe("refuse")
  })

  it("refuses even if a context somehow survives alongside the flag", () => {
    // Belt and braces: the boundary clears one when it sets the other, but the
    // refusal must not depend on that ordering holding.
    expect(iterationRouteFor({ iterationContext, iterationContextMalformed: true })).toBe("refuse")
  })
})

describe("structuralRouteFor", () => {
  it("refuses when the DESTINATION carries unreadable loop information", () => {
    // The gap: a move validated its source and never looked at where the row
    // was going, and an insert looked at neither. Dropping into a loop we
    // cannot read writes the shared template, which is every row.
    expect(
      structuralRouteFor({ node: {}, destParent: { iterationContextMalformed: true } }),
    ).toBe("refuse")
    expect(
      structuralRouteFor({ destParent: { iterationContextMalformed: true } }),
    ).toBe("refuse")
  })

  it("refuses when the node carries it, exactly as the single-target route does", () => {
    expect(
      structuralRouteFor({ node: { iterationContextMalformed: true }, destParent: {} }),
    ).toBe("refuse")
  })

  it("refuses when BOTH ends carry it", () => {
    expect(
      structuralRouteFor({
        node: { iterationContextMalformed: true },
        destParent: { iterationContextMalformed: true },
      }),
    ).toBe("refuse")
  })

  it("leaves a VALID destination context alone: no refusal, no new question", () => {
    // Today's behaviour, deliberately kept. Inserting into a `v-for` element
    // adds to the shared template on purpose, and the "this item or all items"
    // question belongs to the element being edited, not to where it lands.
    expect(structuralRouteFor({ node: {}, destParent: { iterationContext } })).toBe("plain")
    expect(structuralRouteFor({ destParent: { iterationContext } })).toBe("plain")
  })

  it("returns the NODE's route when nothing is malformed", () => {
    expect(structuralRouteFor({ node: { iterationContext }, destParent: {} })).toBe(
      "iteration",
    )
    expect(structuralRouteFor({ node: {}, destParent: {} })).toBe("plain")
    expect(structuralRouteFor({})).toBe("plain")
  })

  it("never says `iteration` for a destination-only edit", () => {
    // An insert has no edited element to ask the question about.
    expect(structuralRouteFor({ destParent: { iterationContext } })).not.toBe("iteration")
  })
})

describe("bridgeDraftIdOf", () => {
  const domText: PendingIterationEdit = {
    editKind: "dom-text",
    selection: { selector: node.selector } as never,
    field: { id: "dom-text", kind: "dom-text", label: "Text", value: "old" } as never,
    value: "new",
    iterationContext,
    bridgePendingId: "pending-7",
  }

  it("names the draft an in-page typing session is holding", () => {
    expect(bridgeDraftIdOf(domText)).toBe("pending-7")
  })

  it("names nothing for an edit the bridge holds no draft for", () => {
    // Inspector-typed text: same edit kind, no draft.
    const { bridgePendingId: _none, ...typedInInspector } = domText
    expect(bridgeDraftIdOf(typedInInspector as PendingIterationEdit)).toBeUndefined()
    // And every other kind reaches us from a panel, never from the page.
    expect(
      bridgeDraftIdOf({ editKind: "delete", selection: {} as never, node, iterationContext }),
    ).toBeUndefined()
  })
})

describe("endSentence", () => {
  it("adds a stop to a reason that has none", () => {
    expect(endSentence("Iteration edit refused: no adapter")).toBe(
      "Iteration edit refused: no adapter.",
    )
  })

  it("leaves a reason that already ends in a stop alone", () => {
    expect(endSentence("Iteration edit refused: no source location.")).toBe(
      "Iteration edit refused: no source location.",
    )
  })

  it("treats ! and ? as ended", () => {
    // Nothing we author ends this way, but an applicator's or a server's
    // refusal text might, and a stop hung off one would read as a typo.
    expect(endSentence("Really?")).toBe("Really?")
    expect(endSentence("Refused!")).toBe("Refused!")
  })

  it("trims first, so a trailing space does not carry a stop past it", () => {
    expect(endSentence("  Could not write the file  ")).toBe("Could not write the file.")
    expect(endSentence("Already ended.  ")).toBe("Already ended.")
  })

  it("returns the empty string unchanged rather than a bare stop", () => {
    expect(endSentence("")).toBe("")
    expect(endSentence("   ")).toBe("")
  })

  it("composes into the status line the fallback sets", () => {
    expect(`${endSentence("Iteration edit refused: no adapter")} Choose how to apply it.`).toBe(
      "Iteration edit refused: no adapter. Choose how to apply it.",
    )
  })
})

describe("parkedReason", () => {
  it("ends the refusal, then asks the question the dialog is asking", () => {
    expect(parkedReason("Iteration edit refused: no adapter")).toBe(
      "Iteration edit refused: no adapter. Choose how to apply it.",
    )
  })

  it("does not double the stop on a reason that already has one", () => {
    expect(parkedReason("Could not check the source for a loop: offline.")).toBe(
      "Could not check the source for a loop: offline. Choose how to apply it.",
    )
  })

  it("is the same string for all three parking exits", () => {
    // The refused proposal, the failed loop check and the throw inside the
    // verify completion all park, and a designer seeing the same situation
    // described two ways has to work out whether it is the same situation.
    const reason = "Could not check the source for a loop: network error"
    expect(parkedReason(reason)).toBe(parkedReason(reason))
    expect(parkedReason(reason).endsWith(" Choose how to apply it.")).toBe(true)
  })
})

describe("settleHandOff", () => {
  it("settles accepted when the hand-off resolves true in time", async () => {
    await expect(settleHandOff(() => Promise.resolve(true), 50)).resolves.toBe("accepted")
  })

  it("settles refused when the hand-off resolves false", async () => {
    await expect(settleHandOff(() => Promise.resolve(false), 50)).resolves.toBe("refused")
  })

  it("treats a throw as a refusal, not as a failure of the caller", async () => {
    // The chat POST failing says nothing about the loop check that preceded
    // it, and letting the throw out would blame the wrong step.
    await expect(
      settleHandOff(() => Promise.reject(new Error("network")), 50),
    ).resolves.toBe("refused")
  })

  it("treats a synchronous throw the same way", async () => {
    await expect(
      settleHandOff(() => {
        throw new Error("no chat")
      }, 50),
    ).resolves.toBe("refused")
  })

  it("times out rather than holding the draft for as long as chat takes", async () => {
    await expect(settleHandOff(() => new Promise<boolean>(() => {}), 5)).resolves.toBe(
      "timed-out",
    )
  })

  it("a late acceptance after the timeout changes nothing", async () => {
    // The race is the guard: once this returned "timed-out" the caller has
    // parked the draft, and the late `true` resolves into a promise nobody is
    // holding, so no code path can release what was parked.
    let settle: ((accepted: boolean) => void) | undefined
    const outcome = await settleHandOff(
      () => new Promise<boolean>((resolve) => { settle = resolve }),
      5,
    )
    expect(outcome).toBe("timed-out")
    settle?.(true)
    await Promise.resolve()
    expect(outcome).toBe("timed-out")
  })

  it("aborts the attempt's signal on timeout, so the submission stops too", async () => {
    // Dropping the race's loser stops a late `true` from releasing a parked
    // draft. It does not stop the POST: the server can accept the turn after
    // the park and the agent then writes the same element the designer is
    // choosing a deterministic scope for.
    let seen: AbortSignal | undefined
    const outcome = await settleHandOff((signal) => {
      seen = signal
      return new Promise<boolean>(() => {})
    }, 5)
    expect(outcome).toBe("timed-out")
    expect(seen?.aborted).toBe(true)
  })

  it("hands the attempt a live signal and leaves it alone when the hand-off answers", async () => {
    let seen: AbortSignal | undefined
    const outcome = await settleHandOff((signal) => {
      seen = signal
      expect(signal.aborted).toBe(false)
      return Promise.resolve(true)
    }, 50)
    expect(outcome).toBe("accepted")
    expect(seen?.aborted).toBe(false)
  })

  it("does not abort a refused hand-off", async () => {
    // A refusal already settled the transport; aborting after it would fire an
    // abort listener on a request that is over.
    let seen: AbortSignal | undefined
    await settleHandOff((signal) => {
      seen = signal
      return Promise.resolve(false)
    }, 50)
    expect(seen?.aborted).toBe(false)
  })
})

describe("handOffFailureStatus", () => {
  it("a refusal reuses the shared parked sentence", () => {
    expect(handOffFailureStatus("refused")).toEqual({
      parked: "This edit could not be sent to chat. Choose how to apply it.",
      released: "This edit needs a decision and could not be sent to chat.",
    })
  })

  it("a timeout says so, because it is a different fact the designer can act on", () => {
    const status = handOffFailureStatus("timed-out")
    expect(status.parked).toBe(
      "Chat did not answer in time. Choose how to apply the pending edit.",
    )
    expect(status.released).toBe("Chat did not answer in time, and this edit needs a decision.")
  })

  it("neither status uses an em dash", () => {
    for (const outcome of ["refused", "timed-out"] as const) {
      const status = handOffFailureStatus(outcome)
      expect(status.parked).not.toMatch(/—/)
      expect(status.released).not.toMatch(/—/)
    }
  })
})

describe("SAVE_HANDOFF_TIMEOUT_STATUS", () => {
  it("says the edits are still there and when to retry", () => {
    expect(SAVE_HANDOFF_TIMEOUT_STATUS).toBe(
      "Chat did not answer in time. Nothing was discarded; try again when the chat is free.",
    )
  })

  it("asks no question, because Save has no dialog to park an edit in", () => {
    expect(SAVE_HANDOFF_TIMEOUT_STATUS).not.toMatch(/\?/)
    expect(SAVE_HANDOFF_TIMEOUT_STATUS).not.toMatch(/Choose how to apply/)
  })

  it("uses no em dash and no first person", () => {
    expect(SAVE_HANDOFF_TIMEOUT_STATUS).not.toMatch(/—/)
    expect(SAVE_HANDOFF_TIMEOUT_STATUS).not.toMatch(/\b(me|my)\b/i)
  })
})

describe("errorMessage", () => {
  it("reads the message of a real Error", () => {
    expect(errorMessage(new Error("network down"))).toBe("network down")
  })

  it("renders a thrown string as itself", () => {
    // `(err as Error).message` on this rendered "undefined" into the status
    // bar, which tells the designer nothing about what went wrong.
    expect(errorMessage("boom")).toBe("boom")
  })

  it("renders a thrown object, null and undefined without throwing", () => {
    expect(errorMessage(null)).toBe("null")
    expect(errorMessage(undefined)).toBe("undefined")
    expect(errorMessage({ code: 500 })).toBe("[object Object]")
  })

  it("falls back for an Error with an empty message and for an empty string", () => {
    expect(errorMessage(new Error(""))).toBe("Error")
    expect(errorMessage("")).toBe("unknown error")
  })

  it("survives a value whose toString throws", () => {
    const hostile = {
      toString() {
        throw new Error("no")
      },
    }
    expect(errorMessage(hostile)).toBe("unknown error")
  })
})
