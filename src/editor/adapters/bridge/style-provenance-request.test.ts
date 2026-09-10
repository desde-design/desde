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

/**
 * A version the shell accepts. `REQUIRED_BRIDGE_VERSION` is the document-id
 * bridge (round 16 X3), so every bridge that can handshake at all is well past
 * the style-provenance threshold.
 */
const CURRENT_BRIDGE_VERSION = '2026-09-10a-capture-document-id'

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
    // The id is required of every bridge the shell talks to.
    payload: { version, documentId: 'doc-a' },
  })
  await initPromise
  return { adapter, setup }
}

describe('BridgeFrameworkAdapter.supportsStyleProvenance', () => {
  let adapter: BridgeFrameworkAdapter

  afterEach(async () => {
    await adapter?.dispose()
  })

  it('is refused at the handshake on a bridge older than the shell requires', async () => {
    // Round 16 X3. The provenance gate's own threshold is now below
    // `REQUIRED_BRIDGE_VERSION`, so a bridge that would fail it cannot
    // handshake in the first place: it never reaches the gate.
    await expect(adapterWithVersion('2026-05-30a-verify')).rejects.toThrow(
      /older than required/,
    )
  })

  it('is true for a bridge the shell accepts', async () => {
    ;({ adapter } = await adapterWithVersion(CURRENT_BRIDGE_VERSION))
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
  it('resolves null without sending when no bridge has been accepted', async () => {
    // The version gate's "too old" arm is unreachable through the handshake now
    // (round 16 X3), so the reachable no-read case is an adapter that has seen
    // no accepted bridge: it must still answer null rather than send. Unlike
    // the next test, an iframe target IS attached here (init() is in flight) —
    // the handshake just hasn't completed, so no bridge has been accepted.
    adapter = new BridgeFrameworkAdapter()
    const setup = makeMockIframe()
    const target: AdapterTarget = { iframe: setup.iframe, origin: '*' }
    // Never resolves without a BRIDGE_READY reply; swallow the rejection
    // `dispose()` (afterEach) triggers so it doesn't surface as unhandled.
    adapter.init(target).catch(() => {})
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
    ;({ adapter, setup } = await adapterWithVersion(CURRENT_BRIDGE_VERSION))
    await expect(adapter.getStyleProvenance('.a', [])).resolves.toEqual({})
    expect(
      setup.postMessages.filter((m) => (m as { type: string }).type === 'GET_STYLE_PROVENANCE'),
    ).toHaveLength(0)
  })

  it('sends GET_STYLE_PROVENANCE and resolves the correlated reply', async () => {
    let setup: MockIframeSetup
    ;({ adapter, setup } = await adapterWithVersion(CURRENT_BRIDGE_VERSION))
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
    ;({ adapter, setup } = await adapterWithVersion(CURRENT_BRIDGE_VERSION))
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
      ;({ adapter } = await adapterWithVersion(CURRENT_BRIDGE_VERSION))
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
    ;({ adapter, setup } = await adapterWithVersion(CURRENT_BRIDGE_VERSION))
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
