/**
 * The adapter's GET_STYLE_PROVENANCE round-trip: request/reply correlation by
 * requestId, the bridge-version gate, and graceful degradation on timeout.
 *
 * Fixture idiom copied from `index.test.ts` — the adapter's real connection
 * entry point is `init(target)` (which sends PING and awaits `BRIDGE_READY`
 * before resolving), and its real inbound-message entry point is the
 * `window`-level `message` listener it installs during `init()`, not a
 * public `handleMessage()` method. `emitFromBridge` dispatches a MessageEvent
 * whose `source` is the mock iframe's `contentWindow` and whose `data` carries
 * the `desde-bridge` envelope — the same path `RENDERED_VALUE_READ`
 * flows through.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BridgeFrameworkAdapter } from './index'
import type { AdapterTarget } from '../../core'

interface MockIframeSetup {
  iframe: HTMLIFrameElement
  contentWindow: { postMessage: ReturnType<typeof vi.fn> }
  postMessages: unknown[]
}

function makeMockIframe(): MockIframeSetup {
  const postMessages: unknown[] = []
  const contentWindow = {
    postMessage: vi.fn((message: unknown) => {
      postMessages.push(message)
    }),
  }
  const iframe = {
    src: 'https://prototype.example.com/dashboard',
    contentWindow,
  } as unknown as HTMLIFrameElement
  return { iframe, contentWindow, postMessages }
}

/** Dispatch a MessageEvent on window with `source` pointed at the mock content window. */
function emitFromBridge(
  contentWindow: { postMessage: ReturnType<typeof vi.fn> },
  message: Record<string, unknown>,
): void {
  const event = new Event('message') as MessageEvent
  Object.defineProperty(event, 'data', {
    value: { source: 'desde-bridge', ...message },
  })
  Object.defineProperty(event, 'source', { value: contentWindow })
  window.dispatchEvent(event)
}

/** Boot the adapter through the real handshake so `lastBridgeVersion` is set. */
async function adapterWithVersion(
  version: string,
): Promise<{ adapter: BridgeFrameworkAdapter; setup: MockIframeSetup }> {
  const adapter = new BridgeFrameworkAdapter()
  const setup = makeMockIframe()
  const target: AdapterTarget = { iframe: setup.iframe, origin: '*' }
  const initPromise = adapter.init(target)
  emitFromBridge(setup.contentWindow, {
    type: 'BRIDGE_READY',
    payload: { version },
  })
  await initPromise
  return { adapter, setup }
}

describe('BridgeFrameworkAdapter.supportsStyleProvenance', () => {
  let adapter: BridgeFrameworkAdapter

  afterEach(async () => {
    await adapter?.dispose()
  })

  it('is false on a bridge older than the provenance version', async () => {
    ;({ adapter } = await adapterWithVersion('2026-05-30a-verify'))
    expect(adapter.supportsStyleProvenance()).toBe(false)
  })

  it('is true from the provenance version onward', async () => {
    ;({ adapter } = await adapterWithVersion('2026-06-08a-style-provenance'))
    expect(adapter.supportsStyleProvenance()).toBe(true)
  })

  it('is false when no bridge version has been seen', () => {
    adapter = new BridgeFrameworkAdapter()
    expect(adapter.supportsStyleProvenance()).toBe(false)
  })
})

describe('BridgeFrameworkAdapter.getStyleProvenance', () => {
  let adapter: BridgeFrameworkAdapter

  afterEach(async () => {
    await adapter?.dispose()
  })

  // A read we could not perform resolves `null`, NOT `{}` — `verifyCascade`
  // turns a missing origin into a `fail`, so an unsubstantiated read must stay
  // distinguishable from "the read worked and found nothing".
  it('resolves null without sending when the bridge is too old', async () => {
    let setup: MockIframeSetup
    ;({ adapter, setup } = await adapterWithVersion('2026-05-30a-verify'))
    await expect(adapter.getStyleProvenance('.a', ['color'])).resolves.toBeNull()
    expect(
      setup.postMessages.filter((m) => (m as { type: string }).type === 'GET_STYLE_PROVENANCE'),
    ).toHaveLength(0)
  })

  it('resolves null when no iframe target is attached', async () => {
    adapter = new BridgeFrameworkAdapter()
    await expect(adapter.getStyleProvenance('.a', ['color'])).resolves.toBeNull()
  })

  it('resolves {} without sending when there are no properties to ask about', async () => {
    let setup: MockIframeSetup
    ;({ adapter, setup } = await adapterWithVersion('2026-06-08a-style-provenance'))
    await expect(adapter.getStyleProvenance('.a', [])).resolves.toEqual({})
    expect(
      setup.postMessages.filter((m) => (m as { type: string }).type === 'GET_STYLE_PROVENANCE'),
    ).toHaveLength(0)
  })

  it('sends GET_STYLE_PROVENANCE and resolves the correlated reply', async () => {
    let setup: MockIframeSetup
    ;({ adapter, setup } = await adapterWithVersion('2026-06-08a-style-provenance'))
    const pending = adapter.getStyleProvenance('.ui-card', ['color'])
    const request = setup.postMessages.find(
      (m) => (m as { type: string }).type === 'GET_STYLE_PROVENANCE',
    ) as { type: string; payload: { selector: string; properties: string[] }; requestId: string }
    expect(request.payload).toEqual({ selector: '.ui-card', properties: ['color'] })
    const origins = {
      color: {
        property: 'color',
        computedValue: 'rgb(0, 0, 0)',
        winningRule: null,
        varChain: [],
      },
    }
    emitFromBridge(setup.contentWindow, {
      type: 'STYLE_PROVENANCE_RESULT',
      payload: { selector: '.ui-card', origins },
      requestId: request.requestId,
    })
    await expect(pending).resolves.toEqual(origins)
  })

  it('ignores a reply whose requestId it does not own', async () => {
    let setup: MockIframeSetup
    ;({ adapter, setup } = await adapterWithVersion('2026-06-08a-style-provenance'))
    const pending = adapter.getStyleProvenance('.ui-card', ['color'])
    const request = setup.postMessages.find(
      (m) => (m as { type: string }).type === 'GET_STYLE_PROVENANCE',
    ) as { requestId: string }
    emitFromBridge(setup.contentWindow, {
      type: 'STYLE_PROVENANCE_RESULT',
      payload: { selector: '.ui-card', origins: { color: {} } },
      requestId: 'someone-elses-id',
    })
    // Still pending → settle it properly so the test doesn't leak a timer.
    emitFromBridge(setup.contentWindow, {
      type: 'STYLE_PROVENANCE_RESULT',
      payload: { selector: '.ui-card', origins: {} },
      requestId: request.requestId,
    })
    await expect(pending).resolves.toEqual({})
  })

  it('resolves null on timeout rather than rejecting or faking an empty read', async () => {
    vi.useFakeTimers()
    try {
      ;({ adapter } = await adapterWithVersion('2026-06-08a-style-provenance'))
      const pending = adapter.getStyleProvenance('.ui-card', ['color'])
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(pending).resolves.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves {} (not null) for a real reply that carries no origins', async () => {
    // The "class edit invalidated its own selector" shape: the bridge answers,
    // the selector just matched nothing. That is a SUCCESSFUL read with an
    // empty result — distinct from the null above.
    let setup: MockIframeSetup
    ;({ adapter, setup } = await adapterWithVersion('2026-06-08a-style-provenance'))
    const pending = adapter.getStyleProvenance('div.bg-white', ['background-color'])
    const request = setup.postMessages.find(
      (m) => (m as { type: string }).type === 'GET_STYLE_PROVENANCE',
    ) as { requestId: string }
    emitFromBridge(setup.contentWindow, {
      type: 'STYLE_PROVENANCE_RESULT',
      payload: { selector: 'div.bg-white', origins: {} },
      requestId: request.requestId,
    })
    await expect(pending).resolves.toEqual({})
  })
})
