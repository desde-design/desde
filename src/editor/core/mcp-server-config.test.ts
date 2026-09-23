import { describe, expect, it } from 'vitest'

import { isMcpStdioServerConfig, isValidMcpServerId } from './mcp-server-config'

describe('isMcpStdioServerConfig', () => {
  it('accepts command with optional args and env', () => {
    expect(isMcpStdioServerConfig({ command: 'npx', args: ['-y', 'x'], env: { A: '1' } })).toBe(
      true,
    )
    expect(isMcpStdioServerConfig({ args: [] })).toBe(false)
  })

  it('accepts a bare command with no args or env', () => {
    expect(isMcpStdioServerConfig({ command: 'figma-mcp' })).toBe(true)
  })

  it('rejects a non-array args field', () => {
    expect(isMcpStdioServerConfig({ command: 'npx', args: 'oops' })).toBe(false)
  })

  it('rejects non-object input', () => {
    expect(isMcpStdioServerConfig(null)).toBe(false)
    expect(isMcpStdioServerConfig(undefined)).toBe(false)
    expect(isMcpStdioServerConfig('npx')).toBe(false)
  })
})

describe('isValidMcpServerId', () => {
  it('accepts letters, digits and hyphens', () => {
    expect(isValidMcpServerId('figma')).toBe(true)
    expect(isValidMcpServerId('figma-dev')).toBe(true)
    expect(isValidMcpServerId('Server2')).toBe(true)
  })

  it('refuses anything that could put a `__` in a tool name, or a `.`', () => {
    for (const id of ['editor__figma', 'a__b', 'a_', '_a', 'my_server', 'a.b', '', 'a b']) {
      expect(isValidMcpServerId(id), id).toBe(false)
    }
  })
})
