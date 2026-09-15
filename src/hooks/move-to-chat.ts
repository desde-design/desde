/**
 * A Layers-panel drop the deterministic move cannot make, phrased for chat.
 *
 * Two shapes arrive here (see `LayersChatMoveReason`): the source and the
 * drop target are written in different files, or they share a file but no
 * ancestor of the target is written in it. Both used to be refusals with a
 * sentence about files, which dead-ended the user. The drop is now accepted
 * and this turns it into the same hand-off prompt a refused deterministic
 * edit produces, so the agent sees the element, where it was dropped, and
 * why the direct path could not do it.
 *
 * Pure: no React, no status text. The hook decides when to send it.
 */
import type { StructuralEdit } from "@/editor/core"
import type { OutlineNode } from "@/types/bridge"
import type { LayersChatMovePayload } from "@/components/editor/layers-panel"
import { buildStructuralEditHandoffPrompt } from "@/editor/edit-service/build-edit-escalation-prompt"
import { describeStructuralEditForHandoff } from "./apply-edit-with-chat-handoff"

export interface MoveToChatHandoff {
  /** The chat prompt, fenced like every other structural hand-off. */
  prompt: string
  /** One or two sentences on why the direct move could not do it — the banner text. */
  why: string
}

/** The user-facing name of a row: its component name, else its tag. */
function labelOf(node: OutlineNode): string {
  return node.name
}

/**
 * Why the direct move could not make this drop, in words about files. Used
 * both as the hover banner and as the "why it refused" line of the prompt.
 */
export function describeWhyMoveGoesToChat(payload: LayersChatMovePayload): string {
  const name = labelOf(payload.source)
  return payload.reason === "different-file"
    ? `${name} is written in ${payload.sourceFile}; the drop target is written in ${payload.targetFile}. A direct move rewrites one file, so it cannot do this.`
    : `${name} is written in ${payload.sourceFile}, but nothing above the drop target on this page is written in that file. A direct move needs a parent in the same file, so it cannot do this.`
}

/**
 * A `move` edit the direct path could not make, as a hand-off. Shared by the
 * Layers-panel drop (below) and the canvas drag-move, which arrives with
 * selectors and positions rather than outline rows.
 */
export function buildMoveEditToChatHandoff(
  edit: StructuralEdit,
  why: string,
  tagName?: string | null,
): MoveToChatHandoff | null {
  const described = describeStructuralEditForHandoff(edit, why)
  if (!described) return null
  return {
    prompt: buildStructuralEditHandoffPrompt({ ...described, tagName: tagName ?? null }),
    why,
  }
}

export function buildMoveToChatHandoff(payload: LayersChatMovePayload): MoveToChatHandoff | null {
  const { source, target, position } = payload
  if (!source.editTarget || !target.editTarget) return null
  const why = describeWhyMoveGoesToChat(payload)
  // The same `move` edit the deterministic lane would have been asked for,
  // so the prompt builder describes it the way it describes every other
  // refused move. An "inside" drop appends to the target; a before/after
  // drop names the target as the sibling to land beside, and the parent is
  // whatever the target's parent is in source — which is exactly what the
  // direct path could not work out, so it is left unnamed.
  const edit: StructuralEdit = {
    kind: "move",
    id: `chat-move-${source.id}`,
    target: {
      targetId: source.selector,
      selector: source.selector,
      componentName: source.type === "component" ? source.name : undefined,
      componentFile: source.componentFile,
      packageName: source.packageName,
      editTarget: source.editTarget,
    },
    destination:
      position === "inside"
        ? { parentId: target.selector, index: -1, parentEditTarget: target.editTarget }
        : {
            parentId: "",
            index: 0,
            anchor: { editTarget: target.editTarget, placement: position },
          },
  }
  return buildMoveEditToChatHandoff(edit, why, source.type === "component" ? null : source.name)
}
