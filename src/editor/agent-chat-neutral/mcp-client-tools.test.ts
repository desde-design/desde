// @vitest-environment node
import { fileURLToPath } from 'node:url'
import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js'
import { describe, expect, it, vi } from 'vitest'

import { connectMcpClientTools } from './mcp-client-tools'

// Records what the client hands the transport, then behaves exactly like the
// real one: the child still starts and the tests still talk to it.
const { transportParams } = vi.hoisted(() => ({
  transportParams: [] as StdioServerParameters[],
}))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('@modelcontextprotocol/sdk/client/stdio.js')>()
  class RecordingStdioClientTransport extends real.StdioClientTransport {
    constructor(params: StdioServerParameters) {
      transportParams.push(params)
      super(params)
    }
  }
  return { ...real, StdioClientTransport: RecordingStdioClientTransport }
})

/** Run `fn` with extra variables set on `process.env`, then restore them. */
async function withProcessEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before = new Map(Object.keys(vars).map((k) => [k, process.env[k]]))
  Object.assign(process.env, vars)
  try {
    return await fn()
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const FIXTURE = fileURLToPath(new URL('./__fixtures__/echo-mcp-server.mjs', import.meta.url))

const echoServer = { command: process.execPath, args: [FIXTURE] }

describe('connectMcpClientTools', () => {
  it("lists a stdio server's tools under the mcp__<id>__ namespace and calls one", async () => {
    const tools = await connectMcpClientTools({ id: 'echo', server: echoServer })
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
    const tools = await connectMcpClientTools({ id: 'echo', server: echoServer })
    try {
      const fail = tools.specs.find((s) => s.name === 'mcp__echo__fail')!
      const out = await fail.handler({}, {})
      expect(out.isError).toBe(true)
      expect(out.content[0]).toMatchObject({ type: 'text', text: 'fixture failure' })
    } finally {
      await tools.close()
    }
  })

  it('starts the child with the config env laid over the safe default env', async () => {
    const tools = await withProcessEnv({ ECHO_MCP_PREFIX: 'inherited:' }, () =>
      connectMcpClientTools({
        id: 'echo',
        server: {
          ...echoServer,
          // ECHO_MCP_STDERR makes the fixture write to stderr at startup. The
          // pipe keeps it off the runner's terminal; the call still answers.
          env: { ECHO_MCP_PREFIX: 'config:', ECHO_MCP_STDERR: 'hello from stderr' },
        },
      }),
    )
    try {
      const spec = tools.specs.find((s) => s.name === 'mcp__echo__echo')!
      const out = await spec.handler({ text: 'hi' }, {})
      expect(out.content[0]).toMatchObject({ type: 'text', text: 'config:hi' })
    } finally {
      await tools.close()
    }
  })

  it("does not hand the CLI's own env to the child: API keys stay behind", async () => {
    transportParams.length = 0
    const tools = await withProcessEnv(
      {
        ANTHROPIC_API_KEY: 'sk-ant-secret',
        OPENAI_API_KEY: 'sk-openai-secret',
        // The fixture echoes this one, so the child's view of it is visible.
        ECHO_MCP_PREFIX: 'leaked:',
      },
      () =>
        connectMcpClientTools({
          id: 'echo',
          server: { ...echoServer, env: { FROM_CONFIG: 'yes' } },
        }),
    )
    try {
      expect(transportParams).toHaveLength(1)
      const env = transportParams[0]!.env ?? {}
      expect(env).not.toHaveProperty('ANTHROPIC_API_KEY')
      expect(env).not.toHaveProperty('OPENAI_API_KEY')
      expect(env).not.toHaveProperty('ECHO_MCP_PREFIX')
      expect(env.FROM_CONFIG).toBe('yes')
      expect(env.PATH).toBe(process.env.PATH)
      // And the running child agrees: the CLI's variable never reached it.
      const spec = tools.specs.find((s) => s.name === 'mcp__echo__echo')!
      const out = await spec.handler({ text: 'hi' }, {})
      expect(out.content[0]).toMatchObject({ type: 'text', text: 'hi' })
    } finally {
      await tools.close()
    }
  })

  it('closes the child, after which a call fails rather than hanging', async () => {
    const tools = await connectMcpClientTools({ id: 'echo', server: echoServer })
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
      }),
    ).rejects.toThrow(/MCP server "ghost"/)
  })

  it.each([
    ['repeat', /MCP server "pager": it returned the same tools\/list cursor twice/],
    ['endless', /MCP server "pager": it listed more than 20 pages of tools/],
  ])(
    'rejects a server whose tools/list cursor never ends (%s), instead of following it forever',
    async (mode, message) => {
      const started = Date.now()
      await expect(
        connectMcpClientTools({
          id: 'pager',
          server: { ...echoServer, env: { ECHO_MCP_CURSOR: mode } },
          }),
      ).rejects.toThrow(message)
      // Ended by the cap, not by the 30s startup deadline.
      expect(Date.now() - started).toBeLessThan(10_000)
    },
  )

  it('rejects when the server exits before answering, with its stderr in the message', async () => {
    await expect(
      connectMcpClientTools({
        id: 'crasher',
        server: {
          command: process.execPath,
          args: ['-e', 'process.stderr.write("boom: missing token\\n"); process.exit(3)'],
        },
      }),
    ).rejects.toThrow(/MCP server "crasher": [\s\S]*boom: missing token/)
  })
})
