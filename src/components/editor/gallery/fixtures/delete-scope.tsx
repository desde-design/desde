import type { OutlineNode } from "@/types/bridge"
import { DeleteScopeDialog } from "@/components/editor/delete-scope-dialog"
import type { SurfaceEntry } from "../types"

/**
 * The dialog's offered scopes come from `deleteScopeAvailability`
 * (src/editor/core/edit.ts): `definition` is available when `authoredAt.file`
 * is not under node_modules; `callsite` additionally requires `editTarget.file`
 * to be a DIFFERENT file (same-file callsites would produce an identical
 * edit). These four fixtures walk that matrix exhaustively.
 */
function node(over: Partial<OutlineNode> = {}): OutlineNode {
  return {
    id: "gallery-node",
    name: "UiButton",
    type: "component",
    x: 320,
    y: 244,
    width: 96,
    height: 32,
    selector: "main > section:nth-of-type(2) > button",
    componentFile: "/repo/node_modules/@acme/design-system/dist/UiButton.vue",
    packageName: "@acme/design-system",
    authoredAt: { file: "/repo/src/components/ActionBar.vue", line: 42, column: 6 },
    editTarget: { file: "/repo/src/pages/Settings.vue", line: 118, column: 10 },
    ...over,
  }
}

const LIBRARY_FILE = "/repo/node_modules/@acme/design-system/dist/UiButton.vue"
/**
 * A SECOND library file. Both "unavailable" states below need `authoredAt` and
 * `editTarget` to be DIFFERENT files: `useEditorEditing` only opens this dialog
 * when the callsite is a distinct file from the definition, and dispatches
 * `definition` silently otherwise. Two states previously used the same file for
 * both, so the product would never have shown them.
 */
const LIBRARY_CALLSITE_FILE = "/repo/node_modules/@acme/design-system/dist/UiCard.vue"

export const DELETE_SCOPE_SURFACE: SurfaceEntry = {
  id: "delete-scope",
  title: "Delete scope",
  kind: "modal",
  sourceFile: "src/components/editor/delete-scope-dialog.tsx",
  states: [
    {
      id: "delete-scope/both-scopes",
      label: "Both scopes available",
      render: (ctx) => (
        <DeleteScopeDialog
          open
          node={node()}
          onConfirm={(scope) => ctx.log("onConfirm", scope)}
          onCancel={() => ctx.log("onCancel")}
        />
      ),
    },
    {
      id: "delete-scope/callsite-only",
      label: "Callsite only (definition is an external library)",
      render: (ctx) => (
        <DeleteScopeDialog
          open
          node={node({ authoredAt: { file: LIBRARY_FILE, line: 12, column: 2 } })}
          onConfirm={(scope) => ctx.log("onConfirm", scope)}
          onCancel={() => ctx.log("onCancel")}
        />
      ),
    },
    {
      id: "delete-scope/definition-only",
      label: "Definition only (callsite is an external library)",
      render: (ctx) => (
        <DeleteScopeDialog
          open
          node={node({
            // Distinct files, and only the definition is editable: the
            // callsite lives in an external library, which editor never rewrites.
            authoredAt: { file: "/repo/src/components/ActionBar.vue", line: 42, column: 6 },
            editTarget: { file: LIBRARY_CALLSITE_FILE, line: 31, column: 4 },
          })}
          onConfirm={(scope) => ctx.log("onConfirm", scope)}
          onCancel={() => ctx.log("onCancel")}
        />
      ),
    },
    {
      id: "delete-scope/neither",
      label: "Dead end: all external-library files (no options, one Close)",
      render: (ctx) => (
        <DeleteScopeDialog
          open
          node={node({
            authoredAt: { file: LIBRARY_FILE, line: 12, column: 2 },
            editTarget: { file: LIBRARY_CALLSITE_FILE, line: 31, column: 4 },
          })}
          onConfirm={(scope) => ctx.log("onConfirm", scope)}
          onCancel={() => ctx.log("onCancel")}
        />
      ),
    },
    {
      // The OTHER cause of a dead end, and the reason the copy branches:
      // naming a package would be a confident wrong answer here.
      id: "delete-scope/unlocatable",
      label: "Dead end: no source file resolved",
      render: (ctx) => (
        <DeleteScopeDialog
          open
          node={node({ authoredAt: undefined, editTarget: undefined })}
          onConfirm={(scope) => ctx.log("onConfirm", scope)}
          onCancel={() => ctx.log("onCancel")}
        />
      ),
    },
  ],
}
