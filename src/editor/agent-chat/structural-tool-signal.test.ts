/**
 * FX20 item 3 (codex review + adversarial verification, 2026-09-06) — every
 * structural write tool has to see the turn's abort signal.
 *
 * ## What went wrong twice, and why this test is at the wiring level
 *
 * `brokeredWrite` grew a `signal` check that returns `stopped` before it
 * touches a file, so pressing Stop while a batch is queued behind the shared
 * per-file lock ends the batch instead of waiting an unbounded time and then
 * writing. Measured previously at a 2,952 ms wait against a three-second
 * holder.
 *
 * Only `manage_package` was ever handed the signal. `signal` is in scope at
 * every one of the call sites in `editor-tools.ts` — it is destructured once
 * and passed to other tools three lines away — so nothing failed, nothing
 * typechecked wrong, and six of the seven structural write paths kept
 * waiting. The wave that fixed it disclosed FIVE; the count was six, and the
 * one it missed (`download_asset`) is the worst of them, because it also runs
 * a network fetch that Stop could not reach.
 *
 * That is why the assertion below is on the WIRING and is table-driven over
 * every structural write tool the catalog offers, rather than on one handler
 * at a time. A per-handler test proves the handler that was remembered; this
 * one fails when a NEW write tool is added without a signal, which is the
 * shape of the defect both times.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const seen = vi.hoisted(() => ({ calls: [] as Array<{ tool: string; hasSignal: boolean }> }))

/**
 * Every handler is replaced by a recorder. The catalog is what is under
 * test, not the writes, so the stubs do nothing but note whether the options
 * object they were handed carried a signal.
 */
vi.mock('./fs-structural-tools', () => {
  const record = (tool: string) => async (opts: { signal?: AbortSignal }) => {
    seen.calls.push({ tool, hasSignal: opts.signal !== undefined })
    return { content: [{ type: 'text' as const, text: '{}' }] }
  }
  return {
    deleteFileHandler: record('delete_file'),
    renameFileHandler: record('rename_file'),
    insertComponentHandler: record('insert_component'),
    insertElementHandler: record('insert_element'),
    scaffoldRouteHandler: record('scaffold_route'),
    managePackageHandler: record('manage_package'),
    downloadAssetHandler: record('download_asset'),
  }
})

import type { BridgeClient } from '../agent-tools/types'
import { buildEditorToolSpecs } from './editor-tools'

const bridge: BridgeClient = { async send() { return null } }

/**
 * The seven structural write tools and one call each that reaches their
 * handler. The arguments only have to satisfy the spec's own shape — the
 * handlers are stubbed.
 */
const WRITE_TOOLS: ReadonlyArray<[string, Record<string, unknown>]> = [
  ['delete_file', { path: 'src/Old.vue' }],
  ['rename_file', { from: 'src/A.vue', to: 'src/B.vue' }],
  ['insert_component', { componentName: 'KButton', file: 'src/App.vue', line: 3, column: 5 }],
  ['insert_element', { snippet: '<div />', file: 'src/App.vue', line: 3, column: 5 }],
  ['scaffold_route', { path: '/about' }],
  ['manage_package', { operation: 'add', packageName: 'left-pad' }],
  ['download_asset', { url: 'https://example.com/a.png', destPath: 'public/a.png' }],
]

describe('every structural write tool is handed the turn signal (FX20 item 3)', () => {
  let controller: AbortController

  beforeEach(() => {
    seen.calls = []
    controller = new AbortController()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  const specs = () =>
    buildEditorToolSpecs({
      bridge,
      signal: controller.signal,
      emitEdit: async () => ({ ok: true, editId: 'e1' }),
      worktreeRoot: '/tmp/does-not-matter',
      // `insert_component` is registered only when grounding is available.
      getGrounding: async () => null as never,
      webPolicy: { allowedHosts: ['example.com'] } as never,
      packageManagerAdapter: { install: async () => ({ ok: true }) } as never,
    })

  it.each(WRITE_TOOLS)('passes signal into %s', async (name, input) => {
    const spec = specs().find((s) => s.name === name)
    expect(spec, `${name} is not in the catalog`).toBeDefined()
    await spec!.handler(input, {})
    expect(seen.calls).toEqual([{ tool: name, hasSignal: true }])
  })

  /**
   * Anti-drift. The list above is hand-written, so a new structural write
   * tool could be added and simply not appear in it. This asserts the other
   * direction: every tool whose handler comes from `fs-structural-tools` is
   * named in the table.
   */
  it('names every tool backed by a structural write handler', async () => {
    const structural = new Set(WRITE_TOOLS.map(([n]) => n))
    for (const spec of specs()) {
      seen.calls = []
      try {
        await spec.handler({} as Record<string, unknown>, {})
      } catch {
        // A spec that throws on empty input is not a structural stub — the
        // stubs never throw — so it is not one of the tools under test.
        continue
      }
      if (seen.calls.length > 0) {
        expect(structural.has(spec.name), `${spec.name} writes but is not in the table`).toBe(true)
      }
    }
  })
})
