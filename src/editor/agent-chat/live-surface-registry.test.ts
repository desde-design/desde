import { describe, expect, it } from 'vitest'
import {
  LIVE_SURFACE_CAPABILITIES,
  LIVE_SURFACE_TOOL_NAMES,
} from './live-surface-registry'

describe('live-surface registry', () => {
  it('registers the bridge round-trip tools', () => {
    expect(LIVE_SURFACE_CAPABILITIES.map((c) => c.name)).toEqual([
      'get_selection',
      'get_page_info',
      'navigate',
      'pin_selections',
      'capture_screenshot',
      'interact',
    ])
  })

  it('derives namespaced tool names (no hand-listing drift)', () => {
    expect(LIVE_SURFACE_TOOL_NAMES).toEqual([
      'mcp__editor__get_selection',
      'mcp__editor__get_page_info',
      'mcp__editor__navigate',
      'mcp__editor__pin_selections',
      'mcp__editor__capture_screenshot',
      'mcp__editor__interact',
    ])
  })

  it('every capability has a description, an input schema, and a handler', () => {
    for (const cap of LIVE_SURFACE_CAPABILITIES) {
      expect(cap.description.length).toBeGreaterThan(0)
      expect(typeof cap.inputSchema).toBe('object')
      expect(typeof cap.run).toBe('function')
    }
  })

  it('no-input tools declare an empty schema; pin_selections declares selectors', () => {
    const byName = Object.fromEntries(
      LIVE_SURFACE_CAPABILITIES.map((c) => [c.name, c]),
    )
    expect(Object.keys(byName.get_selection.inputSchema)).toEqual([])
    expect(Object.keys(byName.get_page_info.inputSchema)).toEqual([])
    expect(Object.keys(byName.navigate.inputSchema)).toEqual(['route'])
    expect(Object.keys(byName.pin_selections.inputSchema)).toEqual(['selectors'])
    expect(Object.keys(byName.capture_screenshot.inputSchema).sort()).toEqual([
      'scope',
      'selector',
    ])
  })
})
