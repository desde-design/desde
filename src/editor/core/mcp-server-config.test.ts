import { describe, expect, it } from 'vitest'

import {
  isMcpStdioServerConfig,
  isReservedMcpServerId,
  isValidMcpServerId,
} from './mcp-server-config'

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
  it('accepts letters, digits, hyphens and single inner underscores', () => {
    for (const id of ['figma', 'figma-dev', 'Server2', 'my_server', 'a_b_c', 'a-_-b']) {
      expect(isValidMcpServerId(id), id).toBe(true)
    }
  })

  it('refuses anything that could put a `__` where the gate splits, or a `.`', () => {
    for (const id of ['editor__figma', 'a__b', '_x', 'x_', '_', 'a.b', '', 'a b']) {
      expect(isValidMcpServerId(id), id).toBe(false)
    }
  })

  it('keeps the first `__` after mcp__ at the separator for every accepted id', () => {
    // The gate's own extraction, as `handleExtensionTool` does it.
    const idOf = (toolName: string): string => {
      const rest = toolName.slice('mcp__'.length)
      return rest.slice(0, rest.indexOf('__'))
    }
    for (const id of ['figma', 'my_server', 'a_b_c', 'a-_-b', 'x-']) {
      expect(isValidMcpServerId(id), id).toBe(true)
      expect(idOf(`mcp__${id}__get_thing`), id).toBe(id)
      expect(idOf(`mcp__${id}___leading_underscore_tool`), id).toBe(id)
    }
  })
})

describe('isReservedMcpServerId', () => {
  it('reserves the built-in namespace, which the character rule alone lets through', () => {
    expect(isValidMcpServerId('editor')).toBe(true)
    expect(isReservedMcpServerId('editor')).toBe(true)
  })

  it('leaves every other id alone, including the pre-rename name', () => {
    for (const id of ['composer', 'figma', 'my_server', 'editor-2']) {
      expect(isReservedMcpServerId(id), id).toBe(false)
    }
  })
})
