/**
 * The tool list one neutral turn offers the model.
 *
 * ## Why the editor tools keep their `mcp__editor__` names
 *
 * On the SDK lane the model sees `mcp__editor__get_selection`, because the
 * tools are registered as an in-process MCP server. Those exact strings are
 * baked into the system prompt's tool catalogue, into `disallowedTools` lists
 * that callers pass (the edit-fix mini-turn strips
 * `mcp__editor__ask_user_question` by name), and into `edit-ack.ts`'s prefix
 * rules. Renaming them on this lane would fork all three. So the catalog
 * applies the SAME namespace, and everything written once keeps working on
 * both lanes.
 */

import type { ToolSpec } from '../agent-chat/tool-spec'
import {
  buildEditorToolSpecs,
  type BuildEditorToolServerOpts,
} from '../agent-chat-sdk/editor-tools'
import { buildBuiltinToolSpecs, type BuiltinToolOpts } from './builtin-tools'

/** The namespace the SDK's MCP registration produces, applied by hand here. */
export const EDITOR_TOOL_NAMESPACE = 'mcp__editor__'

export interface NeutralToolCatalogOpts extends BuiltinToolOpts {
  /** Everything `buildEditorToolSpecs` needs. Passed straight through. */
  editorToolOpts: BuildEditorToolServerOpts
  /**
   * Restrict the BUILT-INS to this list, by bare name. Mirrors the SDK's
   * `tools` option, which filters built-ins only and is a no-op for
   * MCP-namespaced names.
   */
  builtinTools?: readonly string[]
  /**
   * Remove these tools entirely, by FULL name (`Grep`,
   * `mcp__editor__ask_user_question`). Mirrors the SDK's `disallowedTools`.
   */
  disallowedTools?: readonly string[]
}

export function buildNeutralToolCatalog(opts: NeutralToolCatalogOpts): ToolSpec[] {
  const builtins = buildBuiltinToolSpecs(opts).filter(
    (spec) => opts.builtinTools === undefined || opts.builtinTools.includes(spec.name),
  )
  const editor = buildEditorToolSpecs(opts.editorToolOpts).map((spec) => ({
    ...spec,
    name: `${EDITOR_TOOL_NAMESPACE}${spec.name}`,
  }))
  const denied = new Set(opts.disallowedTools ?? [])
  return [...builtins, ...editor].filter((spec) => !denied.has(spec.name))
}
