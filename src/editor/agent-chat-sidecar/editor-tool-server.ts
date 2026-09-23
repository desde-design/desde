/**
 * The Claude Agent SDK binding for Desde's tools.
 *
 * `ToolSpec` (in `../agent-chat/tool-spec.ts`) is the vendor-neutral tool
 * declaration: name, description, input shape, handler. The neutral lane runs
 * specs itself. This file is the thin `tool()`/`createSdkMcpServer()` binding
 * that hands the same specs to the SDK as one in-process MCP server named
 * `editor`. One line per spec.
 *
 * `buildSidecarToolServer` takes ANY spec: Desde's editor tools and its own
 * built-ins (`Read`, `Write`, `Edit`, `Glob`, `Grep`, `TodoWrite`) alike. The
 * sidecar registers the whole neutral catalog through it, so the SDK's own
 * built-ins can stay off.
 *
 * `tool()` validates `input` against `inputShape` before calling, so the
 * handler's cast in each spec is checked on this lane. The neutral lane does
 * the same validation itself, against the same shape, before it calls the
 * handler (see `run-chat-turn-neutral.ts`).
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import {
  buildEditorToolSpecs,
  type BuildEditorToolServerOpts,
} from '../agent-chat/editor-tools'
import type { ToolSpec } from '../agent-chat/tool-spec'
import { EDITOR_TOOL_NAMESPACE } from '../agent-chat-neutral/tool-catalog'

/**
 * Register `specs` as the `editor` MCP server.
 *
 * A name that already carries the `mcp__editor__` namespace has it removed
 * first. The neutral catalog applies that namespace by hand to its editor
 * tools, and the SDK applies it again to everything on this server, so
 * without the strip the model would see `mcp__editor__mcp__editor__…`.
 *
 * The consequence for built-ins: the SDK names them `mcp__editor__Read`,
 * `mcp__editor__Write` and so on, never the bare `Read` the neutral lane uses.
 * The permission gate matches both spellings (`bareToolName` in
 * `../agent-chat/edit-ack.ts`).
 */
export function buildSidecarToolServer(
  specs: readonly ToolSpec[],
  signal?: AbortSignal,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'editor',
    version: '1',
    tools: specs.map((spec) => {
      // `tool()` takes a zod shape only. A spec carrying a raw JSON Schema
      // (an MCP server's own tool) would be registered with an empty shape
      // and silently accept anything, so refuse it loudly instead. Those
      // servers are registered as their own `mcpServers` entries.
      if (spec.inputJsonSchema !== undefined) {
        throw new Error(
          `buildSidecarToolServer: '${spec.name}' carries a JSON Schema; register its MCP server directly instead.`,
        )
      }
      const name = spec.name.startsWith(EDITOR_TOOL_NAMESPACE)
        ? spec.name.slice(EDITOR_TOOL_NAMESPACE.length)
        : spec.name
      return tool(name, spec.description, spec.inputShape, (input) =>
        // `ToolHandlerResult` is structurally a subset of the SDK's
        // `CallToolResult` (see tool-spec.ts) but lacks its forward-compat
        // index signature; the runtime shape is identical.
        spec.handler(input as Record<string, unknown>, { signal }) as Promise<CallToolResult>,
      )
    }),
  })
}

/** The editor tools alone, as their own server. */
export function buildEditorToolServer(
  opts: BuildEditorToolServerOpts,
): McpSdkServerConfigWithInstance {
  return buildSidecarToolServer(buildEditorToolSpecs(opts), opts.signal)
}
