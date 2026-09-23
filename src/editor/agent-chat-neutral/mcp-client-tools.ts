/**
 * A customer's stdio MCP server, connected for one neutral turn and exposed as
 * `ToolSpec`s.
 *
 * On the SDK lane the `claude` binary is the MCP client: `run-chat-turn-sdk.ts`
 * hands Figma and `.mcp.json` servers to its `mcpServers` map and the binary
 * spawns them. The neutral loop has no binary, so it spawns them itself, here.
 *
 * ## Same names as the SDK lane
 *
 * A tool is named `mcp__<id>__<tool>`, the namespace the SDK lane's
 * registration produces. That is what lets three things written once keep
 * working on both lanes: `handleExtensionTool` in `edit-ack.ts` (the read-only
 * prefix policy), the system prompt's `mcp__figma__*` wording, and any
 * `disallowedTools` list a caller passes.
 *
 * ## Trust
 *
 * The config is TRUSTED customer-authored input, like `package.json` (see
 * `extensions-config.ts`): whoever wrote it controls the child process. What
 * the server RETURNS is untrusted, and reaches the model only as a tool result.
 * Arguments are not validated here: the server validates its own, and its
 * schema is sent to the model as the server wrote it (`inputJsonSchema`).
 *
 * ## Env
 *
 * `server.env` arrives already interpolated. Both loaders
 * (`loadExtensions`, `loadFigmaConfig`) resolve `${VAR}` before a config
 * reaches the runtime, and skip an entry whose variable is unset. This module
 * does not interpolate a second time: a resolved secret that happens to
 * contain `${…}` would be rewritten, or refused as missing.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import type { ToolHandlerResult, ToolSpec } from '../agent-chat/tool-spec'
import type { McpStdioServerConfig } from '../core/mcp-server-config'

export interface McpClientToolsInput {
  /** The MCP namespace id: `figma`, or the key in `.mcp.json`. */
  id: string
  server: McpStdioServerConfig
  /** The env the child inherits, under `server.env`. Usually `process.env`. */
  env: NodeJS.ProcessEnv
  /** Aborts the startup handshake when the turn is cancelled. */
  signal?: AbortSignal
}

export interface McpClientTools {
  specs: ToolSpec[]
  /**
   * Ends the session and stops the child. Resolves once the child has exited,
   * or after {@link MCP_CLOSE_WAIT_MS}, whichever is first, so a server that
   * ignores its closed stdin cannot hold a turn open. The SDK's own escalation
   * (SIGTERM, then SIGKILL) carries on after that. Safe to call twice.
   */
  close(): Promise<void>
}

/**
 * One deadline for the WHOLE startup: spawn, initialize and every page of
 * `tools/list` together. A server that has not finished by then is treated as
 * failed for the turn. Generous because `npx -y <server>` downloads the
 * package on its first run.
 *
 * It is one deadline and not a per-request timeout, because a per-request
 * timeout bounds nothing: a server that answers each page promptly and always
 * returns another cursor would hold the turn before `turn_start` forever.
 */
const MCP_STARTUP_TIMEOUT_MS = 30_000

/**
 * Ceiling on `tools/list` pages. A server with more than this many pages of
 * tools is misbehaving, not large: the SDK's own servers list every tool on
 * one page.
 */
const MCP_MAX_TOOL_PAGES = 20

/** How long `close()` waits for the child before returning. */
const MCP_CLOSE_WAIT_MS = 1_500

/** How much of a server's stderr is kept for an error message. */
const STDERR_TAIL_BYTES = 4_096

/**
 * A tool name both shipped vendors accept. OpenAI caps at 64 characters and
 * Anthropic at 128, both on this alphabet. MCP allows more (`.` for one), and
 * one name outside it would 400 every request of the turn, so such a tool is
 * left out with a warning rather than sent.
 */
const WIRE_SAFE_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/

export async function connectMcpClientTools(
  input: McpClientToolsInput,
): Promise<McpClientTools> {
  const inherited: Record<string, string> = {}
  for (const [key, value] of Object.entries(input.env)) {
    if (value !== undefined) inherited[key] = value
  }
  const transport = new StdioClientTransport({
    command: input.server.command,
    args: input.server.args ?? [],
    env: { ...inherited, ...(input.server.env ?? {}) },
    // Piped, not inherited: a chatty server must not write over the CLI's
    // terminal. The tail is kept for the startup error message only.
    stderr: 'pipe',
  })
  let stderrTail = ''
  // Drained for the whole session, not only during startup. An unread pipe
  // fills, and a child blocked on a stderr write stops answering.
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_BYTES)
  })

  const client = new Client({ name: 'desde-editor', version: '1' })
  const deadline = AbortSignal.timeout(MCP_STARTUP_TIMEOUT_MS)
  const requestOpts = {
    // The per-request timeout is the SDK's own knob, set to the same value so
    // its default (60s) never outlasts the deadline. The signal is what
    // actually bounds startup as a whole.
    timeout: MCP_STARTUP_TIMEOUT_MS,
    signal: input.signal ? AbortSignal.any([input.signal, deadline]) : deadline,
  }

  let closing: Promise<void> | null = null
  const close = (): Promise<void> => {
    closing ??= Promise.race([
      client.close().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, MCP_CLOSE_WAIT_MS).unref()),
    ])
    return closing
  }

  let listed: Awaited<ReturnType<Client['listTools']>>['tools']
  try {
    await client.connect(transport, requestOpts)
    listed = []
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; ; page++) {
      if (page >= MCP_MAX_TOOL_PAGES) {
        throw new Error(`it listed more than ${MCP_MAX_TOOL_PAGES} pages of tools`)
      }
      const res = await client.listTools(cursor ? { cursor } : undefined, requestOpts)
      listed.push(...res.tools)
      cursor = res.nextCursor
      if (!cursor) break
      // The same cursor twice is a loop the server will never leave.
      if (seenCursors.has(cursor)) {
        throw new Error('it returned the same tools/list cursor twice')
      }
      seenCursors.add(cursor)
    }
  } catch (err) {
    await close()
    const reason =
      deadline.aborted && input.signal?.aborted !== true
        ? `it did not finish starting within ${MCP_STARTUP_TIMEOUT_MS / 1000}s`
        : err instanceof Error
          ? err.message
          : String(err)
    const stderr = stderrTail.trim()
    // Names the server, because a caller that starts several logs these side
    // by side.
    throw new Error(`MCP server "${input.id}": ${reason}${stderr ? `\n${stderr}` : ''}`, {
      cause: err,
    })
  }

  const specs: ToolSpec[] = []
  for (const tool of listed) {
    const name = `mcp__${input.id}__${tool.name}`
    if (!WIRE_SAFE_TOOL_NAME.test(name)) {
      console.warn(
        `[mcp-client-tools] MCP server "${input.id}": tool "${tool.name}" left out, its name cannot be sent to a model provider.`,
      )
      continue
    }
    specs.push({
      name,
      description: tool.description ?? '',
      inputShape: {},
      inputJsonSchema: tool.inputSchema as Record<string, unknown>,
      kind: 'extension',
      handler: async (args, ctx) => {
        const res = await client.callTool(
          { name: tool.name, arguments: args },
          undefined,
          ctx.signal ? { signal: ctx.signal } : undefined,
        )
        return toHandlerResult(res)
      },
    })
  }
  return { specs, close }
}

type CallToolResponse = Awaited<ReturnType<Client['callTool']>>

/**
 * An MCP tool result, in the two part types a `ToolHandlerResult` carries.
 * Text and image pass through. Anything else (audio, an embedded resource, a
 * resource link) becomes a text part holding its JSON, so the model still
 * sees what came back rather than an empty result.
 */
function toHandlerResult(res: CallToolResponse): ToolHandlerResult {
  const content: ToolHandlerResult['content'] = []
  const parts = Array.isArray(res.content) ? (res.content as unknown[]) : []
  for (const part of parts) {
    const p = part as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown }
    if (p.type === 'text' && typeof p.text === 'string') {
      content.push({ type: 'text', text: p.text })
    } else if (
      p.type === 'image' &&
      typeof p.data === 'string' &&
      typeof p.mimeType === 'string'
    ) {
      content.push({ type: 'image', data: p.data, mimeType: p.mimeType })
    } else {
      content.push({ type: 'text', text: JSON.stringify(part) })
    }
  }
  if (content.length === 0 && res.structuredContent !== undefined) {
    content.push({ type: 'text', text: JSON.stringify(res.structuredContent) })
  }
  if (content.length === 0 && 'toolResult' in res) {
    // The pre-2024-11 result shape, which the SDK still accepts.
    content.push({ type: 'text', text: JSON.stringify(res.toolResult) })
  }
  return { content, ...(res.isError === true ? { isError: true } : {}) }
}
