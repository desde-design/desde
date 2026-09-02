import { describe, expect, it } from "vitest"
import {
  singleChoiceDisambiguationMessage,
  singleChoiceDisambiguationToastId,
} from "./single-choice-disambiguation-notice"

describe("singleChoiceDisambiguationMessage", () => {
  it("names the blast radius", () => {
    const { title, description } = singleChoiceDisambiguationMessage({ rowCount: 8 })
    expect(title).toBe("This edit changes all 8 items")
    // The asymmetry is the whole point of saying anything: the write lands on
    // the code, so items that do not exist yet are affected too.
    expect(description).toContain("Items added later are affected too")
  })

  it("does not say 'all 1 items' for a single candidate", () => {
    // `rowCount` is `candidates.length`, which is legitimately 1 when a lone
    // candidate still fails the callsite proof in `classifyMutationScope`.
    const { title, description } = singleChoiceDisambiguationMessage({ rowCount: 1 })
    expect(title).toBe("This edit changes the shared code")
    expect(description).not.toMatch(/\b1 items?\b/)
  })

  /**
   * Regression guard, from cross-session review. This notice fires from the
   * RESOLVE, which only posts to the bridge. The source write is a debounced
   * dispatch after that and can still throw, so past tense would report success
   * for a failed edit. Worse, at this moment there is no undo entry yet: a user
   * who read "Undo is in the toolbar" and reacted at once would have reverted
   * their PREVIOUS commit. Both shipped briefly on 2026-08-17.
   *
   * If this is ever moved to fire from the dispatch success path, delete this
   * test rather than working around it.
   */
  it("states intent, not outcome, and never points at an undo it is racing", () => {
    for (const rowCount of [1, 8]) {
      const { title, description } = singleChoiceDisambiguationMessage({ rowCount })
      const all = `${title} ${description}`
      expect(title).toMatch(/^This edit changes\b/)
      expect(all).not.toMatch(/\bundo\b/i)
      expect(all).not.toMatch(/\bchanged\b|\blanded\b|\bwas\b/i)
    }
  })

  it("stays kind-neutral — this fires for class and style edits too", () => {
    for (const rowCount of [1, 8]) {
      const { description } = singleChoiceDisambiguationMessage({ rowCount })
      expect(description).not.toMatch(/\btext\b/i)
    }
  })
})

describe("singleChoiceDisambiguationToastId", () => {
  it("keys on the shared source position so repeats replace rather than stack", () => {
    expect(singleChoiceDisambiguationToastId("src/App.vue:12:4")).toBe(
      "disambiguation-auto-resolved:src/App.vue:12:4",
    )
    expect(singleChoiceDisambiguationToastId("src/App.vue:12:4")).toBe(
      singleChoiceDisambiguationToastId("src/App.vue:12:4"),
    )
  })
})
