/**
 * One tool declaration, two bindings.
 *
 * `editor-tools.ts` used to declare each tool directly against the Claude
 * Agent SDK's `tool(name, description, zodShape, handler)`. That made the
 * DECLARATION vendor-shaped even though every handler behind it was already
 * plain TypeScript. A `ToolSpec` is the same four things with no vendor in
 * them: the SDK lane maps a spec through `tool()`, and the neutral lane maps
 * the same spec through `toToolDefs` into `ToolDef[]`.
 *
 * The zod shape is kept as the source of truth for BOTH bindings rather than
 * hand-written JSON Schema, because the SDK's `tool()` validates against it
 * and the neutral loop validates against it too (see `run-chat-turn-neutral`).
 * One shape means the model's contract and the runtime's check cannot drift.
 */

import { z } from 'zod'

import type { ToolDef } from '../llm-providers/types'

/** What a handler is told about the call it is answering. */
export interface ToolHandlerContext {
  /** Aborts when the turn is cancelled. */
  signal?: AbortSignal
  /** The model's id for this call. Present on the neutral lane. */
  toolUseId?: string
}

/**
 * What a handler returns. Structurally a subset of the SDK's
 * `CallToolResult`, so the SDK binding passes it through untouched, and
 * exactly what the neutral loop turns into a `tool_result` event plus a
 * `ToolResultContent` message block.
 */
export interface ToolHandlerResult {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >
  isError?: boolean
}

export interface ToolSpec {
  /**
   * The name the MODEL sees. Editor tools are declared bare here
   * (`get_selection`) and namespaced to `mcp__editor__get_selection` by
   * `agent-chat-neutral/tool-catalog.ts`, which is the same name the SDK
   * lane's MCP registration produces. One namespace across both lanes is
   * what lets `disallowedTools`, the permission gate's prefix rules and the
   * system prompt's tool catalogue be written once.
   */
  name: string
  /** Model-facing description. This is the tool-selection prompt. */
  description: string
  /** Zod raw shape, as the SDK's `tool()` third argument. `{}` for no input. */
  inputShape: z.ZodRawShape
  handler(
    input: Record<string, unknown>,
    ctx: ToolHandlerContext,
  ): Promise<ToolHandlerResult>
  kind: 'editor' | 'builtin'
}

/**
 * Convert specs to the vendor-neutral `ToolDef[]` the `LLMProvider` seam
 * takes. Uses zod 4's own `z.toJSONSchema` (MEASURED: zod 4.4.3 is already a
 * dependency of both the root and `editor-cli`), so there is no schema
 * generator to maintain.
 *
 * `$schema` is removed because neither `tools[].input_schema` (Anthropic) nor
 * `function.parameters` (OpenAI) is a standalone JSON Schema document, and at
 * least one OpenAI-compatible vendor rejects the key outright.
 *
 * A duplicate name throws rather than silently keeping the last one: both
 * wire formats reject a duplicate at request time, and a 400 naming an
 * unrelated field is a much worse way to find out.
 */
export function toToolDefs(specs: readonly ToolSpec[]): ToolDef[] {
  const seen = new Set<string>()
  return specs.map((spec) => {
    if (seen.has(spec.name)) {
      throw new Error(`toToolDefs: duplicate tool name '${spec.name}'`)
    }
    seen.add(spec.name)
    const schema = z.toJSONSchema(z.object(spec.inputShape), {
      io: 'input',
    }) as Record<string, unknown>
    delete schema.$schema
    return {
      name: spec.name,
      description: spec.description,
      inputSchema: schema,
    }
  })
}
