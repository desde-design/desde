/**
 * The Claude Agent SDK binding for Editor's domain-specific tools.
 *
 * `buildEditorToolSpecs` (in `../agent-chat/editor-tools.ts`) declares the
 * vendor-neutral tool list — name, description, input shape, handler — so
 * the neutral lane can consume the identical specs. This file is the thin
 * `tool()`/`createSdkMcpServer()` binding on top of that list for the
 * Claude Agent SDK lane. One line per spec.
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

export function buildEditorToolServer(
  opts: BuildEditorToolServerOpts,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'editor',
    version: '1',
    tools: buildEditorToolSpecs(opts).map((spec) =>
      tool(spec.name, spec.description, spec.inputShape, (input) =>
        // `ToolHandlerResult` is structurally a subset of the SDK's
        // `CallToolResult` (see tool-spec.ts) but lacks its forward-compat
        // index signature; the runtime shape is identical.
        spec.handler(input as Record<string, unknown>, { signal: opts.signal }) as Promise<CallToolResult>,
      ),
    ),
  })
}
