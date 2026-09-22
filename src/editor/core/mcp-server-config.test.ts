import { describe, expect, it } from 'vitest'

import { isMcpStdioServerConfig } from './mcp-server-config'

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
