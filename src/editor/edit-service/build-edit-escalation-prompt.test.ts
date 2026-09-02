import { describe, it, expect } from "vitest"
import {
  buildEditEscalationPrompt,
  buildPropEditEscalationPrompt,
  buildCommentFixPrompt,
  decodeCommentMentions,
  type EscalationMutation,
} from "./build-edit-escalation-prompt"

describe("buildEditEscalationPrompt", () => {
  it("describes a single text edit with file:line and selector", () => {
    const m: EscalationMutation = {
      kind: "text",
      sourceLoc: "src/components/ProtoPolicyExistingList.vue:21:9",
      selector: "button.add-btn",
      before: "Add (3)",
      after: "Add 3",
    }
    const prompt = buildEditEscalationPrompt([m])
    expect(prompt).toContain('Change the text from "Add (3)" to "Add 3"')
    // column stripped, line kept
    expect(prompt).toContain("src/components/ProtoPolicyExistingList.vue:21")
    expect(prompt).not.toContain(":21:9")
    expect(prompt).toContain("selector: button.add-btn")
    expect(prompt).toContain("couldn't be applied automatically")
  })

  it("describes an attr edit by target name", () => {
    const m: EscalationMutation = {
      kind: "attr",
      sourceLoc: "src/App.vue:5:3",
      selector: "div.card",
      target: "title",
      before: "Old",
      after: "New",
    }
    const prompt = buildEditEscalationPrompt([m])
    expect(prompt).toContain('Change the `title` attribute from "Old" to "New"')
  })

  it("pluralizes the intro and lists every mutation for a batch", () => {
    const a: EscalationMutation = {
      kind: "text",
      sourceLoc: "src/A.vue:1:1",
      selector: "h1",
      before: "x",
      after: "y",
    }
    const b: EscalationMutation = {
      kind: "attr",
      sourceLoc: "src/B.vue:2:1",
      selector: "img",
      target: "alt",
      before: "p",
      after: "q",
    }
    const prompt = buildEditEscalationPrompt([a, b])
    expect(prompt).toContain("2 edits")
    expect(prompt.match(/^- /gm)?.length).toBe(2)
  })

  it("handles a null sourceLoc and empty before/after", () => {
    const m: EscalationMutation = {
      kind: "text",
      sourceLoc: null,
      selector: "span",
      before: "",
      after: "hi",
    }
    const prompt = buildEditEscalationPrompt([m])
    expect(prompt).toContain('from "" to "hi"')
    expect(prompt).not.toContain(" at ")
  })
})

describe("buildPropEditEscalationPrompt", () => {
  it("frames a prop edit with component name, location, prop name, and new value", () => {
    const prompt = buildPropEditEscalationPrompt({
      propName: "placeholder",
      newValue: "Filter results",
      componentName: "UiInput",
      editTargetLocation: "src/views/AIGatewayConsumerCreate.vue:38",
      selector: "input.acme-input",
    })
    expect(prompt).toContain("`placeholder` prop")
    expect(prompt).toContain("<UiInput>")
    expect(prompt).toContain("src/views/AIGatewayConsumerCreate.vue:38")
    expect(prompt).toContain('"Filter results"')
    expect(prompt).toContain("input.acme-input")
    expect(prompt).toContain("trace the binding")
  })

  it("falls back to 'element' when componentName is absent", () => {
    const prompt = buildPropEditEscalationPrompt({
      propName: "title",
      newValue: "Hi",
      editTargetLocation: null,
      selector: "div",
    })
    expect(prompt).toContain("on element")
    expect(prompt).not.toContain("at ")
    expect(prompt).toContain('"Hi"')
  })

  it("renders a numeric prop value unquoted with a 'number literal' annotation", () => {
    // Regression: the previous version stringified value → `"42"` which
    // looked like a string literal to the chat agent and risked
    // `:max="\"42\""` edits in source.
    const prompt = buildPropEditEscalationPrompt({
      propName: "max",
      newValue: 42,
      componentName: "UiInput",
      editTargetLocation: "src/App.vue:5",
      selector: "input",
    })
    expect(prompt).toContain("42 (number literal)")
    expect(prompt).not.toContain('"42"')
  })

  it("renders a boolean prop value unquoted with a 'boolean literal' annotation", () => {
    const prompt = buildPropEditEscalationPrompt({
      propName: "disabled",
      newValue: true,
      componentName: "UiButton",
      editTargetLocation: "src/App.vue:7",
      selector: "button",
    })
    expect(prompt).toContain("true (boolean literal)")
    expect(prompt).not.toContain('"true"')
  })
})

describe("decodeCommentMentions", () => {
  it("strips @[Name](email) encoding to @Name", () => {
    expect(decodeCommentMentions("cc @[Jane Doe](jane@x.com) please")).toBe(
      "cc @Jane Doe please",
    )
  })

  it("decodes multiple mentions and leaves plain text untouched", () => {
    expect(
      decodeCommentMentions("@[A](a@x) and @[B](b@y) — fix the spacing"),
    ).toBe("@A and @B — fix the spacing")
    expect(decodeCommentMentions("no mentions here")).toBe("no mentions here")
  })
})

describe("buildCommentFixPrompt", () => {
  it("includes the decoded body, selector, page, and number reference", () => {
    const prompt = buildCommentFixPrompt({
      body: "Make this heading larger, cc @[Mo](mo@x.com)",
      selector: "#app > main > h1",
      page: "/dashboard",
      number: 4,
    })
    expect(prompt).toContain("comment #4")
    expect(prompt).toContain('"Make this heading larger, cc @Mo"')
    expect(prompt).toContain("selector: #app > main > h1")
    expect(prompt).toContain('page "/dashboard"')
  })

  it("falls back to the screenshot-by-selector hint when no sourceLoc is known", () => {
    const prompt = buildCommentFixPrompt({
      body: "tweak this",
      selector: "div.card",
      page: "/",
    })
    expect(prompt).toContain("capture_screenshot")
    expect(prompt).toContain('scope "selector"')
    // No "  source: file:line" anchor line when unresolved.
    expect(prompt).not.toContain("  source:")
  })

  it("anchors on file:line (column stripped) when a sourceLoc is provided", () => {
    const prompt = buildCommentFixPrompt({
      body: "fix",
      selector: "div.card",
      page: "/",
      sourceLoc: "src/pages/Home.vue:42:7",
    })
    expect(prompt).toContain("source: src/pages/Home.vue:42")
    expect(prompt).not.toContain(":42:7")
    expect(prompt).toContain("Start from src/pages/Home.vue:42")
    // The screenshot hint is replaced by the stronger source anchor.
    expect(prompt).not.toContain("capture_screenshot")
  })
})
