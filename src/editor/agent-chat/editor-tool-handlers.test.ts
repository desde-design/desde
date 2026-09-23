/**
 * Unit tests for the read-root tool handlers (`./read-root-tools`) and
 * other bridge-coupled handlers (`captureScreenshot`, `getPageInfo`,
 * `interact`, `navigate`, `verifyEdit`, `askUserQuestion`) in
 * `editor-tool-handlers.ts`. The underlying git logic is covered by
 * `agent-tools/git-tools.test.ts`; the read-root tests here verify the
 * SDK adapter shape — that ToolEntry results translate cleanly to
 * `EditorToolResult` and that the registry is propagated through
 * the fabricated `ToolContext`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BridgeClient } from '../agent-tools/types'
import type { ReadRoot, ReadRootRegistry } from '../core/read-roots'
import type { ReviewSurface } from '../core/review-surface'
import {
  askUserQuestion,
  captureScreenshot,
  getPageInfo,
  interact,
  navigate,
  verifyEdit,
} from './editor-tool-handlers'
import { locateSelectorRoute } from './locate-selector-route'
import {
  diffFile,
  listCommits,
  listReadRoots,
  readFileAtCommit,
  searchExternalFiles,
} from './read-root-tools'

// The auto-navigate recovery's selector→route resolution is filesystem-backed;
// mock it so these handler tests stay in-memory (its own logic is covered by
// locate-selector-route.test.ts).
vi.mock('./locate-selector-route', () => ({ locateSelectorRoute: vi.fn() }))

// A 1x1 transparent PNG data URL.
const PNG_1x1_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
const PNG_1x1_BASE64 = PNG_1x1_DATA_URL.split(',')[1]

function makeBridge(): BridgeClient {
  return { send: vi.fn(async () => null) }
}

function makeRegistry(roots: ReadRoot[]): ReadRootRegistry {
  return {
    roots,
    resolve: (name) => roots.find((r) => r.name === name),
  }
}

// ─── askUserQuestion tests ─────────────────────────────────────────────────

describe('askUserQuestion handler', () => {
  it('sends ask_user_question messageType with the correct payload and returns result as JSON text', async () => {
    const output = { selected: ['Option A'] }
    const send = vi.fn(async () => output)
    const bridge: BridgeClient = { send }

    const result = await askUserQuestion(
      { bridge },
      { question: 'Which style?', options: ['Option A', 'Option B'] },
    )

    expect(send).toHaveBeenCalledWith(
      'ask_user_question',
      { question: 'Which style?', options: ['Option A', 'Option B'], multiSelect: false },
      expect.objectContaining({ timeoutMs: 600_000 }),
    )
    expect(result.isError).toBeUndefined()
    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    expect(JSON.parse(result.content[0].text)).toEqual(output)
  })

  it('passes timeoutMs: 600_000 for the human-response window', async () => {
    const send = vi.fn(async () => ({ selected: ['A'] }))
    const bridge: BridgeClient = { send }

    await askUserQuestion({ bridge }, { question: 'Q?', options: ['A'] })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = (send.mock.calls[0] as any[])[2] as { timeoutMs?: number }
    expect(opts.timeoutMs).toBe(600_000)
  })

  it('returns isError when options array is empty', async () => {
    const bridge: BridgeClient = { send: vi.fn() }

    const result = await askUserQuestion(
      { bridge },
      { question: 'Q?', options: [] },
    )

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/non-empty/)
    // Bridge should not have been called
    expect(bridge.send).not.toHaveBeenCalled()
  })

  it('returns isError with explanatory text on bridge rejection (timeout/abort/dismiss)', async () => {
    const send = vi.fn(async () => {
      throw new Error('bridge_request \'ask_user_question\' timed out after 600000ms')
    })
    const bridge: BridgeClient = { send }

    const result = await askUserQuestion(
      { bridge },
      { question: 'Which layout?', options: ['Grid', 'List'] },
    )

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/ask_user_question failed/)
    expect(result.content[0].text).toMatch(/timed out/)
  })

  it('defaults multiSelect to false when not provided', async () => {
    const send = vi.fn(async () => ({ selected: ['X'] }))
    const bridge: BridgeClient = { send }

    await askUserQuestion({ bridge }, { question: 'Q?', options: ['X', 'Y'] })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = (send.mock.calls[0] as any[])[1] as { multiSelect: boolean }
    expect(payload.multiSelect).toBe(false)
  })

  it('passes multiSelect: true when provided', async () => {
    const send = vi.fn(async () => ({ selected: ['X', 'Y'] }))
    const bridge: BridgeClient = { send }

    await askUserQuestion(
      { bridge },
      { question: 'Q?', options: ['X', 'Y'], multiSelect: true },
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = (send.mock.calls[0] as any[])[1] as { multiSelect: boolean }
    expect(payload.multiSelect).toBe(true)
  })
})

// ─── captureScreenshot tests ────────────────────────────────────────────────

describe('captureScreenshot handler', () => {
  it('round-trips chat:capture_screenshot and returns a text note + image block', async () => {
    const send = vi.fn(async () => ({
      dataUrl: PNG_1x1_DATA_URL,
      width: 120,
      height: 64,
    }))
    const bridge: BridgeClient = { send }

    const result = await captureScreenshot({ bridge }, { scope: 'viewport' })

    expect(send).toHaveBeenCalledWith(
      'chat:capture_screenshot',
      { scope: 'viewport', selector: undefined },
      expect.objectContaining({ timeoutMs: 20_000 }),
    )
    expect(result.isError).toBeUndefined()
    expect(result.content).toHaveLength(2)
    const [note, image] = result.content
    expect(note.type).toBe('text')
    if (note.type === 'text') {
      expect(note.text).toMatch(/viewport/)
      expect(note.text).toMatch(/120×64/)
    }
    expect(image.type).toBe('image')
    if (image.type === 'image') {
      expect(image.mimeType).toBe('image/png')
      expect(image.data).toBe(PNG_1x1_BASE64) // base64 only, no data: prefix
      expect(image.data).not.toContain('data:')
    }
  })

  it("forwards the selector for scope 'selector'", async () => {
    const send = vi.fn(async () => ({ dataUrl: PNG_1x1_DATA_URL }))
    const bridge: BridgeClient = { send }

    await captureScreenshot({ bridge }, { scope: 'selector', selector: '#hero' })

    expect(send).toHaveBeenCalledWith(
      'chat:capture_screenshot',
      { scope: 'selector', selector: '#hero' },
      expect.anything(),
    )
  })

  it('returns isError when the bridge rejects (capture failed/timeout)', async () => {
    const send = vi.fn(async () => {
      throw new Error('Screenshot capture failed or timed out.')
    })
    const bridge: BridgeClient = { send }

    const result = await captureScreenshot({ bridge }, { scope: 'viewport' })

    expect(result.isError).toBe(true)
    expect(result.content[0].type).toBe('text')
    if (result.content[0].type === 'text') {
      expect(result.content[0].text).toMatch(/Screenshot capture failed/)
    }
  })

  it('returns isError when the reply carries no image', async () => {
    const bridge: BridgeClient = { send: vi.fn(async () => ({ width: 0, height: 0 })) }
    const result = await captureScreenshot({ bridge }, { scope: 'element' })
    expect(result.isError).toBe(true)
    if (result.content[0].type === 'text') {
      expect(result.content[0].text).toMatch(/no image/i)
    }
  })

  it('returns isError with the media-service reason for an unusable image', async () => {
    // Over-cap data URL → imageFromDataUrl refuses with a scope-down hint.
    const huge = `data:image/png;base64,${'A'.repeat(7_000_000)}`
    const bridge: BridgeClient = { send: vi.fn(async () => ({ dataUrl: huge })) }
    const result = await captureScreenshot({ bridge }, { scope: 'viewport' })
    expect(result.isError).toBe(true)
    if (result.content[0].type === 'text') {
      expect(result.content[0].text).toMatch(/unusable/i)
      expect(result.content[0].text).toMatch(/too large/i)
    }
  })
})

// ─── Read-root handler tests ────────────────────────────────────────────────

describe('listReadRoots handler', () => {
  it('serializes the registry as JSON text (success shape)', async () => {
    const registry = makeRegistry([
      { name: 'worktree', path: '/tmp/wt', isWorktree: true, isGit: true, gitPrefix: '', description: 'session' },
      { name: 'production', path: '/tmp/prod', isWorktree: false, isGit: true, gitPrefix: '', description: 'mirror' },
    ])
    const result = await listReadRoots({ bridge: makeBridge(), readRoots: registry })
    expect(result.isError).toBeUndefined()
    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    const parsed = JSON.parse(result.content[0].text) as {
      roots: Array<{ name: string; isWorktree: boolean; description?: string }>
    }
    expect(parsed.roots).toHaveLength(2)
    expect(parsed.roots[0]).toMatchObject({ name: 'worktree', isWorktree: true, isGit: true })
    expect(parsed.roots[1]).toMatchObject({ name: 'production', isWorktree: false, isGit: true })
    // `gitPrefix` is deliberately NOT in the tool's output: it is a
    // repo-relative path, and this tool's whole contract is that the model
    // never learns the user's directory layout.
    expect(result.content[0].text).not.toContain('gitPrefix')
    // The registry's raw `path` field must NOT leak — the model only
    // gets names + descriptions.
    expect(result.content[0].text).not.toContain('/tmp/prod')
  })

  it('returns isError with the underlying message when readRoots is undefined', async () => {
    const result = await listReadRoots({ bridge: makeBridge() })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/not configured/)
  })
})

describe('read-root tool error propagation', () => {
  // The git tools all share the same "unknown root" rejection. Smoke-
  // test that each handler surfaces a structured isError result with
  // the underlying message verbatim, so the model can read the
  // available-roots list and retry with a valid name.
  it.each([
    [
      'listCommits',
      () =>
        listCommits(
          { bridge: makeBridge(), readRoots: makeRegistry([]) },
          { root: 'nonexistent' },
        ),
    ],
    [
      'readFileAtCommit',
      () =>
        readFileAtCommit(
          { bridge: makeBridge(), readRoots: makeRegistry([]) },
          { root: 'nonexistent', path: 'src/x.vue', sha: 'HEAD' },
        ),
    ],
    [
      'diffFile',
      () =>
        diffFile(
          { bridge: makeBridge(), readRoots: makeRegistry([]) },
          { root: 'nonexistent', path: 'src/x.vue' },
        ),
    ],
    [
      'searchExternalFiles',
      () =>
        searchExternalFiles(
          { bridge: makeBridge(), readRoots: makeRegistry([]) },
          { root: 'nonexistent', query: 'foo' },
        ),
    ],
  ])('%s returns isError + text when the root is unknown', async (_name, run) => {
    const result = await run()
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/unknown read root/)
  })
})

// ─── capture_screenshot auto-navigate recovery ──────────────────────────────

describe('captureScreenshot no-match auto-navigate recovery', () => {
  beforeEach(() => {
    vi.mocked(locateSelectorRoute).mockReset()
  })

  /** A bridge whose `chat:capture_screenshot` returns the scripted results in
   * order (a 'no-match' entry rejects with the shell's token), and serves a
   * fixed page-info + echoing navigate. Records every send for assertions. */
  function scriptedBridge(opts: {
    captures: Array<'no-match' | { dataUrl: string; width?: number; height?: number }>
    pageInfo?: unknown
  }): { bridge: BridgeClient; sends: Array<{ type: string; payload: unknown }> } {
    const sends: Array<{ type: string; payload: unknown }> = []
    let captureCall = 0
    const send = vi.fn(async (type: string, payload?: unknown) => {
      sends.push({ type, payload })
      if (type === 'chat:capture_screenshot') {
        const r = opts.captures[captureCall++] ?? opts.captures[opts.captures.length - 1]
        if (r === 'no-match') {
          throw new Error('[capture:no-match] No element matches selector ".x" on /ai-gateway/abc/mcp-servers.')
        }
        return r
      }
      if (type === 'chat:get_page_info') {
        return opts.pageInfo ?? { route: '/ai-gateway/abc/mcp-servers' }
      }
      if (type === 'chat:navigate') return { route: (payload as { route: string }).route }
      return null
    })
    return { bridge: { send }, sends }
  }

  it('navigates to where the selector lives and returns the retried capture', async () => {
    vi.mocked(locateSelectorRoute).mockResolvedValue({
      ok: true,
      sourceFiles: ['src/components/mcp-server-create/MCPServerCreateStepWizard.vue'],
      routes: [{ path: '/ai-gateway/:id/mcp-servers/create', name: 'mcp-create' }],
      navigableUrls: ['/ai-gateway/abc/mcp-servers/create'],
    })
    const { bridge, sends } = scriptedBridge({
      captures: ['no-match', { dataUrl: PNG_1x1_DATA_URL, width: 100, height: 50 }],
    })

    const result = await captureScreenshot(
      { bridge, worktreeRoot: '/wt' },
      { scope: 'selector', selector: '.x' },
    )

    expect(result.isError).toBeUndefined()
    // Navigated to the param-filled URL between the two capture attempts.
    expect(sends.some((s) => s.type === 'chat:navigate' && (s.payload as { route: string }).route === '/ai-gateway/abc/mcp-servers/create')).toBe(true)
    // Image came back + a note explaining the auto-navigation.
    expect(result.content.some((b) => b.type === 'image')).toBe(true)
    const note = result.content.find((b) => b.type === 'text')
    expect(note?.type === 'text' && note.text).toMatch(/auto-navigated/i)
  })

  it('does NOT recover (and surfaces the clean miss) when there is no worktreeRoot', async () => {
    const { bridge, sends } = scriptedBridge({ captures: ['no-match'] })

    const result = await captureScreenshot(
      { bridge }, // no worktreeRoot
      { scope: 'selector', selector: '.x' },
    )

    expect(result.isError).toBe(true)
    expect(vi.mocked(locateSelectorRoute)).not.toHaveBeenCalled()
    expect(sends.filter((s) => s.type === 'chat:capture_screenshot')).toHaveLength(1)
    expect(sends.some((s) => s.type === 'chat:navigate')).toBe(false)
    if (result.content[0].type === 'text') {
      // The shell's [capture:no-match] token is stripped from the agent message.
      expect(result.content[0].text).toMatch(/No element matches selector/)
      expect(result.content[0].text).not.toMatch(/\[capture:/)
    }
  })

  it('returns a source-grounded error when the route needs params it cannot fill', async () => {
    vi.mocked(locateSelectorRoute).mockResolvedValue({
      ok: true,
      sourceFiles: ['src/components/mcp-server-create/MCPServerCreateStepWizard.vue'],
      routes: [{ path: '/ai-gateway/:id/mcp-servers/create', name: 'mcp-create' }],
      navigableUrls: [], // params unfillable from the current page
    })
    const { bridge, sends } = scriptedBridge({ captures: ['no-match'], pageInfo: { route: '/' } })

    const result = await captureScreenshot(
      { bridge, worktreeRoot: '/wt' },
      { scope: 'selector', selector: '.x' },
    )

    expect(result.isError).toBe(true)
    expect(sends.some((s) => s.type === 'chat:navigate')).toBe(false)
    if (result.content[0].type === 'text') {
      expect(result.content[0].text).toMatch(/MCPServerCreateStepWizard\.vue/)
      expect(result.content[0].text).toMatch(/\/ai-gateway\/:id\/mcp-servers\/create/)
      expect(result.content[0].text).toMatch(/param|concrete id/i)
    }
  })

  it('falls back to the original miss when the selector is nowhere in source', async () => {
    vi.mocked(locateSelectorRoute).mockResolvedValue({
      ok: false,
      sourceFiles: [],
      routes: [],
      navigableUrls: [],
    })
    const { bridge } = scriptedBridge({ captures: ['no-match'] })

    const result = await captureScreenshot(
      { bridge, worktreeRoot: '/wt' },
      { scope: 'selector', selector: '.x' },
    )

    expect(result.isError).toBe(true)
    if (result.content[0].type === 'text') {
      expect(result.content[0].text).toMatch(/No element matches selector/)
    }
  })
})

// ─── ReviewSurface routing ──────────────────────────────────────────────────
//
// When a `reviewSurface` is present, the agent's view+drive ops must target the
// isolated surface (the headless Playwright sidecar) instead of the bridge →
// user's live iframe — so reviewing its own work never disrupts the user.

/** A fake ReviewSurface whose methods are spies; override per test. */
function makeSurface(overrides: Partial<ReviewSurface> = {}): {
  surface: ReviewSurface
  spies: { [K in keyof ReviewSurface]: ReturnType<typeof vi.fn> }
} {
  const spies = {
    navigate: vi.fn(async () => ({ route: '/x', alreadyThere: false })),
    getPageInfo: vi.fn(async () => ({ url: 'http://h/x', route: '/x', framework: 'vue3' })),
    resolveTarget: vi.fn(async () => ({ found: true, selector: '#btn', role: 'button', name: 'Go' })),
    performInteract: vi.fn(async () => ({ ok: true })),
    capture: vi.fn(async () => ({ dataUrl: PNG_1x1_DATA_URL, width: 10, height: 10 })),
    readRenderedValue: vi.fn(async () => ({ value: 'Submit', supported: true as const })),
    readMeasurements: vi.fn(async () => ({ measurements: null, supported: true as const })),
    currentRoute: vi.fn(() => '/x'),
    dispose: vi.fn(async () => {}),
  }
  // Merge overrides INTO the spies map so `spies.X` is the SAME reference the
  // surface uses — assertions on spies.X then track the actual calls.
  Object.assign(spies, overrides)
  return { surface: spies as unknown as ReviewSurface, spies }
}

describe('ReviewSurface routing (agent view+drive ops bypass the bridge)', () => {
  it('navigate uses the surface, never the bridge', async () => {
    const send = vi.fn(async () => null)
    const { surface, spies } = makeSurface({
      navigate: vi.fn(async () => ({ route: '/settings', alreadyThere: false })),
    })

    const result = await navigate({ bridge: { send }, reviewSurface: surface }, { route: '/settings' })

    expect(spies.navigate).toHaveBeenCalledWith('/settings')
    expect(send).not.toHaveBeenCalled()
    expect(result.isError).toBeUndefined()
    if (result.content[0].type === 'text') expect(result.content[0].text).toMatch(/\/settings/)
  })

  it('interact resolves + performs on the surface, never the bridge', async () => {
    const send = vi.fn(async () => null)
    const { surface, spies } = makeSurface()

    const result = await interact(
      { bridge: { send }, reviewSurface: surface },
      { action: 'click', role: 'button', name: 'Go' },
    )

    expect(spies.resolveTarget).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'button', name: 'Go' }),
    )
    expect(spies.performInteract).toHaveBeenCalledWith(
      expect.objectContaining({ selector: '#btn', action: 'click' }),
    )
    expect(send).not.toHaveBeenCalled()
    expect(result.isError).toBeUndefined()
  })

  it('capture (viewport) uses the surface and returns the image', async () => {
    const send = vi.fn(async () => null)
    const { surface, spies } = makeSurface()

    const result = await captureScreenshot({ bridge: { send }, reviewSurface: surface }, { scope: 'viewport' })

    expect(spies.capture).toHaveBeenCalledWith({ scope: 'viewport', selector: undefined })
    expect(send).not.toHaveBeenCalled()
    expect(result.content.some((c) => c.type === 'image')).toBe(true)
  })

  it("capture scope:'element' resolves the user's selection via the bridge, then captures it by selector on the surface", async () => {
    // The user's selection lives in the user's live iframe → read over the bridge.
    const send = vi.fn(async () => ({ selector: '#user-selection' }))
    const { surface, spies } = makeSurface()

    await captureScreenshot({ bridge: { send }, reviewSurface: surface }, { scope: 'element' })

    expect(send).toHaveBeenCalledWith('chat:get_selection', undefined, expect.anything())
    expect(spies.capture).toHaveBeenCalledWith({ scope: 'selector', selector: '#user-selection' })
  })

  it('a surface no-match on a selector capture triggers auto-navigate recovery on the surface', async () => {
    const send = vi.fn(async () => null)
    const captureSpy = vi
      .fn()
      // first attempt misses, retry after navigate succeeds
      .mockResolvedValueOnce({ reason: 'no-match', error: 'no element matched' })
      .mockResolvedValueOnce({ dataUrl: PNG_1x1_DATA_URL, width: 10, height: 10 })
    const { surface, spies } = makeSurface({ capture: captureSpy })
    ;(locateSelectorRoute as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      sourceFiles: ['src/Page.vue'],
      routes: [{ path: '/page' }],
      navigableUrls: ['/page'],
    })

    const result = await captureScreenshot(
      { bridge: { send }, reviewSurface: surface, worktreeRoot: '/wt' },
      { scope: 'selector', selector: '.missing' },
    )

    expect(spies.navigate).toHaveBeenCalledWith('/page')
    expect(captureSpy).toHaveBeenCalledTimes(2)
    expect(result.isError).toBeUndefined()
    expect(result.content.some((c) => c.type === 'image')).toBe(true)
  })

  it('get_page_info reports the SURFACE route (not the user iframe) when a surface is active', async () => {
    // Codex #1: navigate moves the surface, so get_page_info must follow it or
    // the agent is told a stale route.
    const send = vi.fn(async () => ({ route: '/user-page' }))
    const { surface, spies } = makeSurface({
      getPageInfo: vi.fn(async () => ({ url: 'http://h/agent-page', route: '/agent-page', framework: 'vue3' })),
    })

    const result = await getPageInfo({ bridge: { send }, reviewSurface: surface })

    expect(spies.getPageInfo).toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(JSON.parse(result.content[0].type === 'text' ? result.content[0].text : '{}').route).toBe('/agent-page')
  })

  it('verify_edit reads the rendered value from the surface (always supported)', async () => {
    const send = vi.fn(async () => null)
    const { surface, spies } = makeSurface({
      readRenderedValue: vi.fn(async () => ({ value: 'Submit', supported: true as const })),
    })

    // Virtual clock: skip the real 600ms confirm-stable wait (load-immune).
    let t = 0
    const result = await verifyEdit(
      {
        bridge: { send },
        reviewSurface: surface,
        verifyTiming: {
          now: () => t,
          sleep: async (ms: number) => {
            t += ms
          },
        },
      },
      { file: 'a.vue', line: 1, selector: '#b', expectedValue: 'Submit', field: 'textContent' },
    )

    expect(spies.readRenderedValue).toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    const parsed = JSON.parse(result.content[0].type === 'text' ? result.content[0].text : '{}')
    expect(parsed.pass).toBe(true)
    expect(parsed.observed).toBe('Submit')
  })
})
