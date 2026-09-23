// A tiny stdio MCP server for `mcp-client-tools.test.ts` and the neutral
// loop's MCP tests. Written with the same SDK the client uses, so the tests
// exercise the real protocol rather than a hand-rolled imitation of it.
//
// Three tools:
//   - `echo({ text })` returns `text` as one text part, prefixed with
//     `ECHO_MCP_PREFIX` when that is set, so a test can see the child's env.
//   - `fail()` returns an `isError` result, the way a server reports a tool
//     failure without breaking the protocol.
//   - `dotted.name()` has a name MCP allows and model providers refuse.
//
// `ECHO_MCP_STDERR`, when set, is written to stderr at startup, so a test can
// show that a server's stderr does not leak onto the CLI's terminal.
// `ECHO_MCP_PIDFILE`, when set, receives this process's pid, so a test can
// check that the child is gone once the turn ends.

import { writeFileSync } from 'node:fs'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

if (process.env.ECHO_MCP_PIDFILE) writeFileSync(process.env.ECHO_MCP_PIDFILE, String(process.pid))
if (process.env.ECHO_MCP_STDERR) process.stderr.write(`${process.env.ECHO_MCP_STDERR}\n`)

const server = new McpServer({ name: 'echo-fixture', version: '1.0.0' })

server.registerTool(
  'echo',
  {
    description: 'Echo the given text back.',
    inputSchema: { text: z.string().describe('The text to echo.') },
  },
  async ({ text }) => ({
    content: [{ type: 'text', text: `${process.env.ECHO_MCP_PREFIX ?? ''}${text}` }],
  }),
)

server.registerTool(
  'fail',
  { description: 'Always fails.' },
  async () => ({ content: [{ type: 'text', text: 'fixture failure' }], isError: true }),
)

server.registerTool('dotted.name', { description: 'Never offered.' }, async () => ({
  content: [{ type: 'text', text: 'unreachable' }],
}))

await server.connect(new StdioServerTransport())
