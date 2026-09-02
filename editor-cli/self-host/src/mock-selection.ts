import type { Selection, ComponentManifest } from "@/editor/core"

/**
 * A mock selection + manifest seeded into the editor store at boot so
 * the inspector ("Edit" tab) renders its FULLY POPULATED state — prop
 * inputs, the variant/size dropdowns, boolean toggles, the editable-text
 * field, and the class editor — with NO live bridge.
 *
 * Why: the inspector is prop-driven by `useEditorStore.editorSelection`
 * + `editorManifest` (see useEditorEditing — `editing.editorSelection`
 * IS the store value). Normally the bridge fills those on element
 * selection; in this nested harness the inner bridge can't connect, so
 * the Edit tab would otherwise sit on its empty "no selection" state and
 * none of the input controls would render — nothing to style/redesign.
 * Seeding the store sidesteps the bridge entirely. The store cleanup that
 * nulls the selection only runs on unmount (not mount), and the bridge
 * never connects to overwrite it, so the seed sticks.
 */

export const MOCK_MANIFEST: ComponentManifest = {
  id: "self-host/Button",
  name: "Button",
  framework: "react",
  designSystem: "self-host",
  importPath: "@/components/ui/button",
  description: "Primary action button used across the editor chrome.",
  props: [
    {
      name: "variant",
      type: "string",
      required: false,
      description: "Visual style.",
      control: {
        kind: "finite-choice",
        options: [
          { label: "Default", value: "default" },
          { label: "Primary", value: "primary" },
          { label: "Destructive", value: "destructive" },
          { label: "Ghost", value: "ghost" },
          { label: "Outline", value: "outline" },
        ],
      },
    },
    {
      name: "size",
      type: "string",
      required: false,
      description: "Control size.",
      control: {
        kind: "finite-choice",
        options: [
          { label: "Small", value: "sm" },
          { label: "Medium", value: "md" },
          { label: "Large", value: "lg" },
        ],
      },
    },
    { name: "disabled", type: "boolean", required: false, description: "Disable interaction.", control: { kind: "boolean" } },
    { name: "loading", type: "boolean", required: false, description: "Show a spinner.", control: { kind: "boolean" } },
    { name: "label", type: "string", required: false, description: "Button text.", control: { kind: "text" } },
  ],
}

export const MOCK_SELECTION: Selection = {
  targetId: "self-host-mock-button",
  selector: "button.btn-primary",
  componentName: "Button",
  componentFile: "src/components/ui/button.tsx",
  isLibrary: false,
  authoredAt: { file: "src/components/editor/commit-push-controls.tsx", line: 120, column: 8 },
  editTarget: { file: "src/components/editor/commit-push-controls.tsx", line: 120, column: 8 },
  ancestry: [
    {
      targetId: "self-host-mock-toolbar",
      componentName: "CommitPushControls",
      componentFile: "src/components/editor/commit-push-controls.tsx",
    },
  ],
  tagName: "button",
  classes: [
    "inline-flex",
    "items-center",
    "gap-2",
    "rounded-md",
    "bg-primary",
    "px-4",
    "py-2",
    "text-sm",
    "font-semibold",
    "text-white",
    "shadow-sm",
  ],
  currentProps: { variant: "primary", size: "md", disabled: false, loading: false, label: "Save changes" },
  currentAttrs: { type: "button" },
  editableTexts: [
    { id: "txt-label", label: "Label", value: "Save changes", kind: "prop", propName: "label" },
  ],
  computedStyles: {
    padding: "8px 16px",
    color: "rgb(255, 255, 255)",
    "background-color": "rgb(99, 102, 241)",
    "font-size": "14px",
    "font-weight": "600",
    "border-radius": "6px",
  },
}
