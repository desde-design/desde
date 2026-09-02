import { describe, it, expect, beforeEach } from "vitest"
import { useEditorStore } from "@/stores/editor-only"
import type { ComponentManifest, Selection } from "@/editor/core"

const SELECTION: Selection = {
  targetId: "abc",
  selector: "abc",
  componentName: "UiButton",
  componentFile: "src/components/UiButton.vue",
  ancestry: [],
}

const MANIFEST: ComponentManifest = {
  id: "acme-ds:UiButton",
  name: "UiButton",
  framework: "vue3",
  designSystem: "acme-ds",
  source: {
    framework: "vue3",
    designSystem: "acme-ds",
    extractor: "test",
  },
  props: [],
}

describe("editor-only store", () => {
  beforeEach(() => {
    useEditorStore.getState().resetEditor()
  })

  it("initializes with null selection and manifest", () => {
    const state = useEditorStore.getState()
    expect(state.editorSelection).toBeNull()
    expect(state.editorManifest).toBeNull()
  })

  it("sets selection and manifest independently", () => {
    useEditorStore.getState().setEditorSelection(SELECTION)
    useEditorStore.getState().setEditorManifest(MANIFEST)
    const state = useEditorStore.getState()
    expect(state.editorSelection).toEqual(SELECTION)
    expect(state.editorManifest).toEqual(MANIFEST)
  })

  it("resetEditor clears both fields", () => {
    useEditorStore.getState().setEditorSelection(SELECTION)
    useEditorStore.getState().setEditorManifest(MANIFEST)
    useEditorStore.getState().resetEditor()
    const state = useEditorStore.getState()
    expect(state.editorSelection).toBeNull()
    expect(state.editorManifest).toBeNull()
  })

  describe("verifications", () => {
    const result = {
      editId: "e1",
      status: "pass" as const,
      expectedValue: "Submit",
      escalatable: false,
      detail: "ok",
      durationMs: 5,
    }

    it("begins a running record then completes it", () => {
      useEditorStore.getState().beginVerification("e1", 'label = "Submit"', 1000)
      let v = useEditorStore.getState().verifications
      expect(v).toHaveLength(1)
      expect(v[0]).toMatchObject({ editId: "e1", phase: "running" })
      useEditorStore.getState().completeVerification("e1", result)
      v = useEditorStore.getState().verifications
      expect(v[0]).toMatchObject({ phase: "done", result })
    })

    it("replaces the record for a re-edited editId instead of stacking", () => {
      useEditorStore.getState().beginVerification("e1", "first", 1)
      useEditorStore.getState().beginVerification("e1", "second", 2)
      const v = useEditorStore.getState().verifications
      expect(v).toHaveLength(1)
      expect(v[0].label).toBe("second")
    })

    it("caps the list at 25 (newest kept)", () => {
      for (let i = 0; i < 30; i++) {
        useEditorStore.getState().beginVerification(`e${i}`, `l${i}`, i)
      }
      const v = useEditorStore.getState().verifications
      expect(v).toHaveLength(25)
      expect(v[0].editId).toBe("e5") // oldest 5 dropped
      expect(v[v.length - 1].editId).toBe("e29")
    })

    it("resetEditor and clearVerifications empty the list", () => {
      useEditorStore.getState().beginVerification("e1", "x", 1)
      useEditorStore.getState().clearVerifications()
      expect(useEditorStore.getState().verifications).toHaveLength(0)
      useEditorStore.getState().beginVerification("e2", "y", 2)
      useEditorStore.getState().resetEditor()
      expect(useEditorStore.getState().verifications).toHaveLength(0)
    })
  })
})
