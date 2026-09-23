// @vitest-environment node
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { connectMcpClientTools } from './mcp-client-tools'

const FIXTURE = fileURLToPath(new URL('./__fixtures__/echo-mcp-server.mjs', import.meta.url))

const echoServer = { command: process.execPath, args: [FIXTURE] }

describe('connectMcpClientTools', () => {
  it("lists a stdio server's tools under the mcp__<id>__ namespace and calls one", async () => {
    const tools = await connectMcpClientTools({ id: 'echo', server: echoServer, env: process.env })
    try {
      // `dotted.name` is left out: a provider refuses a `.` in a tool name,
      // and one refused name would fail every request of the turn.
      expect(tools.specs.map((s) => s.name).sort()).toEqual(['mcp__echo__echo', 'mcp__echo__fail'])
      const spec = tools.specs.find((s) => s.name === 'mcp__echo__echo')!
      expect(spec.kind).toBe('extension')
      expect(spec.description).toBe('Echo the given text back.')
      expect(spec.inputShape).toEqual({})
      expect(spec.inputJsonSchema).toMatchObject({
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      })
      const out = await spec.handler({ text: 'hi' }, {})
      expect(out.isError).toBeUndefined()
      expect(out.content[0]).toMatchObject({ type: 'text', text: 'hi' })
    } finally {
      await tools.close()
    }
  })

  it("reports a server-side tool failure as an isError result, not a throw", async () => {
    const tools = await connectMcpClientTools({ id: 'echo', server: echoServer, env: process.env })
    try {
      const fail = tools.specs.find((s) => s.name === 'mcp__echo__fail')!
      const out = await fail.handler({}, {})
      expect(out.isError).toBe(true)
      expect(out.content[0]).toMatchObject({ type: 'text', text: 'fixture failure' })
    } finally {
      await tools.close()
    }
  })

  it('starts the child with the config env laid over the inherited one', async () => {
    const tools = await connectMcpClientTools({
      id: 'echo',
      server: {
        ...echoServer,
        // ECHO_MCP_STDERR makes the fixture write to stderr at startup. The
        // pipe keeps it off the runner's terminal; the call still answers.
        env: { ECHO_MCP_PREFIX: 'config:', ECHO_MCP_STDERR: 'hello from stderr' },
      },
      env: { ...process.env, ECHO_MCP_PREFIX: 'inherited:', UNSET_IN_CHILD: undefined },
    })
    try {
      const spec = tools.specs.find((s) => s.name === 'mcp__echo__echo')!
      const out = await spec.handler({ text: 'hi' }, {})
      expect(out.content[0]).toMatchObject({ type: 'text', text: 'config:hi' })
    } finally {
      await tools.close()
    }
  })

  it('closes the child, after which a call fails rather than hanging', async () => {
    const tools = await connectMcpClientTools({ id: 'echo', server: echoServer, env: process.env })
    const spec = tools.specs.find((s) => s.name === 'mcp__echo__echo')!
    await tools.close()
    await expect(spec.handler({ text: 'late' }, {})).rejects.toThrow()
    // A second close is harmless.
    await tools.close()
  })

  it('rejects, naming the server, when the command cannot be started', async () => {
    await expect(
      connectMcpClientTools({
        id: 'ghost',
        server: { command: '/nonexistent-binary' },
        env: process.env,
      }),
    ).rejects.toThrow()
  })

  it('rejects when the server exits before answering, with its stderr in the message', async () => {
    await expect(
      connectMcpClientTools({
        id: 'crasher',
        server: {
          command: process.execPath,
          args: ['-e', 'process.stderr.write("boom: missing token\\n"); process.exit(3)'],
        },
        env: process.env,
      }),
    ).rejects.toThrow(/boom: missing token/)
  })
})
