/**
 * Registration-surface tests for `buildEditorToolServer` — specifically
 * the canvas + screenshot-plan gate (`canvasEnabled`). The surface went
 * DORMANT by product decision 2026-08-04 (undertested; deliver editor
 * sooner, invest later — see CLAUDE.md § "Screenshot Capture"): the two
 * plan-authoring tools (`save_screenshot_plan`, `heal_plan_step`) must be
 * absent from the registered tool set by default, and present when the
 * caller threads `canvasEnabled: true` (mirrors how `getGrounding`/
 * `insertComponentTools` gate conditional registration).
 *
 * Uses the REAL `@anthropic-ai/claude-agent-sdk` (not mocked) so the
 * assertion is against the actual McpServer the SDK runtime gets —
 * `_registeredTools` is a private field on the vendored `McpServer`
 * class, read via a narrow cast for the sole purpose of listing names.
 */

import { describe, expect, it } from 'vitest'

import type { BridgeClient } from '../agent-tools/types'
import { toToolDefs } from '../agent-chat/tool-spec'
import {
  buildEditorToolServer,
  buildEditorToolSpecs,
  type EmitEditResult,
} from './editor-tools'

function stubBridge(): BridgeClient {
  return { send: async () => null }
}

async function stubEmitEdit(): Promise<EmitEditResult> {
  return { ok: true, editId: 'eid-1' }
}

function registeredToolNames(server: ReturnType<typeof buildEditorToolServer>): string[] {
  const instance = server.instance as unknown as {
    _registeredTools: Record<string, unknown>
  }
  return Object.keys(instance._registeredTools)
}

describe('buildEditorToolServer — canvasEnabled gate', () => {
  it('does NOT register save_screenshot_plan / heal_plan_step by default (canvasEnabled omitted)', () => {
    const server = buildEditorToolServer({
      bridge: stubBridge(),
      emitEdit: stubEmitEdit,
    })
    const names = registeredToolNames(server)
    expect(names).not.toContain('save_screenshot_plan')
    expect(names).not.toContain('heal_plan_step')
  })

  it('does NOT register them when canvasEnabled is explicitly false', () => {
    const server = buildEditorToolServer({
      bridge: stubBridge(),
      emitEdit: stubEmitEdit,
      canvasEnabled: false,
    })
    const names = registeredToolNames(server)
    expect(names).not.toContain('save_screenshot_plan')
    expect(names).not.toContain('heal_plan_step')
  })

  it('registers both tools when canvasEnabled is true', () => {
    const server = buildEditorToolServer({
      bridge: stubBridge(),
      emitEdit: stubEmitEdit,
      canvasEnabled: true,
    })
    const names = registeredToolNames(server)
    expect(names).toContain('save_screenshot_plan')
    expect(names).toContain('heal_plan_step')
  })

  it('never gates unrelated tools (navigate / interact / capture_screenshot stay registered either way)', () => {
    const off = registeredToolNames(
      buildEditorToolServer({ bridge: stubBridge(), emitEdit: stubEmitEdit }),
    )
    const on = registeredToolNames(
      buildEditorToolServer({
        bridge: stubBridge(),
        emitEdit: stubEmitEdit,
        canvasEnabled: true,
      }),
    )
    for (const always of ['navigate', 'interact', 'capture_screenshot', 'get_selection', 'get_page_info']) {
      expect(off).toContain(always)
      expect(on).toContain(always)
    }
  })
})

/**
 * Dormant lanes (`detach` / `swap`, product decision 2026-08-11 — see
 * `editor-cli/src/server/enabled-lanes.ts`) must not be reachable from the
 * agent's tool surface.
 *
 * Today they are not: no tool takes a `detach`/`swap` intent, and the only
 * structural edit the agent can name is `propose_prop_edit`. That is a FACT
 * rather than a gate, and this pins it — a future `detach_component` tool
 * would have to confront the dormancy here rather than shipping a tool the
 * dispatcher will refuse 400 with a config key the agent cannot set. The agent
 * repeatedly trying a lane and reporting failures is the exact outcome gating
 * at both ends exists to prevent.
 */
describe('buildEditorToolServer — dormant lanes have no agent tool', () => {
  it('registers no detach/swap tool under any option combination', () => {
    for (const canvasEnabled of [undefined, false, true]) {
      const names = registeredToolNames(
        buildEditorToolServer({
          bridge: stubBridge(),
          emitEdit: stubEmitEdit,
          ...(canvasEnabled !== undefined ? { canvasEnabled } : {}),
        }),
      )
      for (const name of names) {
        expect(name).not.toMatch(/detach|swap/i)
      }
    }
  })
})

/**
 * `buildEditorToolSpecs` is the vendor-neutral declaration `editor-tools.ts`
 * now builds first — `buildEditorToolServer` is a thin `tool()` binding on
 * top of it. These tests pin that the two stay in lockstep (same names, same
 * order) and that the specs alone are enough to drive the neutral lane.
 */
describe('buildEditorToolSpecs', () => {
  const stubOpts = {
    bridge: stubBridge(),
    emitEdit: stubEmitEdit,
    worktreeRoot: '/tmp/does-not-matter',
  }

  it('declares the same tools, in the same order, as the SDK server registers', () => {
    const specs = buildEditorToolSpecs(stubOpts)
    const server = buildEditorToolServer(stubOpts)
    expect(specs.map((s) => s.name)).toEqual(registeredToolNames(server))
  })

  it('names tools BARE, so the caller owns the namespace', () => {
    const specs = buildEditorToolSpecs(stubOpts)
    expect(specs.some((s) => s.name === 'get_selection')).toBe(true)
    expect(specs.every((s) => !s.name.startsWith('mcp__'))).toBe(true)
  })

  it('marks every spec as an editor tool', () => {
    const specs = buildEditorToolSpecs(stubOpts)
    expect(specs.every((s) => s.kind === 'editor')).toBe(true)
  })

  it('every spec converts to a ToolDef with a real description', () => {
    const defs = toToolDefs(buildEditorToolSpecs(stubOpts))
    expect(defs.length).toBeGreaterThan(20)
    expect(defs.every((d) => d.description.length > 20)).toBe(true)
    expect(defs.every((d) => d.inputSchema.type === 'object')).toBe(true)
  })

  it('registers the canvas plan tools only when the canvas surface is on', () => {
    const off = buildEditorToolSpecs(stubOpts).map((s) => s.name)
    const on = buildEditorToolSpecs({ ...stubOpts, canvasEnabled: true }).map((s) => s.name)
    expect(off).not.toContain('save_screenshot_plan')
    expect(on).toContain('save_screenshot_plan')
  })

  it('registers the grounding tools only when a grounding resolver is supplied', () => {
    const off = buildEditorToolSpecs(stubOpts).map((s) => s.name)
    const on = buildEditorToolSpecs({
      ...stubOpts,
      getGrounding: async () => ({}) as never,
    }).map((s) => s.name)
    expect(off).not.toContain('list_components')
    expect(on).toContain('list_components')
  })

  it('propose_prop_edit still routes through the orchestrator s emitEdit', async () => {
    const seen: unknown[] = []
    const specs = buildEditorToolSpecs({
      ...stubOpts,
      emitEdit: async (payload: unknown) => {
        seen.push(payload)
        return { ok: true as const, editId: 'e9' }
      },
    })
    const spec = specs.find((s) => s.name === 'propose_prop_edit')!
    const out = await spec.handler(
      { selector: '.btn', propName: 'variant', value: 'danger' },
      {},
    )
    expect(seen).toEqual([
      { type: 'prop_edit', selector: '.btn', targetId: undefined, propName: 'variant', value: 'danger' },
    ])
    expect(out.isError).toBeUndefined()
    expect(out.content[0]).toMatchObject({ type: 'text' })
    expect(String((out.content[0] as { text: string }).text)).toContain('e9')
  })
})
