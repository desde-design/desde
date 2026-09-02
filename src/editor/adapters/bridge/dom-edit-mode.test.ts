/**
 * Phase A tests for `BridgeFrameworkAdapter`'s DOM-edit-mode surface.
 * These exercise the bridge ↔ adapter wiring: mutation event dispatch into
 * listeners, v-for disambiguation flow, resolution-failed surfacing, and
 * dispose clearing subscriptions. Bridge-side capture mechanics
 * (contentEditable, MutationObserver, instancePath walk) are tested
 * separately at the bridge layer.
 *
 * `enterDomEditMode` (the entry point that used to gate this surface) had
 * zero production callers and was removed in share-readiness Phase 3
 * Batch A — the message handlers exercised below never actually checked
 * `domEditModeActive`, so capture dispatch works unconditionally once the
 * adapter is initialized. `exitDomEditMode` survives as an adapter-teardown
 * no-op (see its doc comment in `./index.ts`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeFrameworkAdapter } from './index'
import type {
  AdapterTarget,
  Mutation,
  PendingMutation,
} from '../../core'
import type { BridgeMutation, BridgePendingMutation } from '@/types/bridge'

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

function emitBridgeReady(
  setup: MockIframeSetup,
  version = '2026-05-07a-dom',
): void {
  const event = new Event('message') as MessageEvent
  Object.defineProperty(event, 'data', {
    value: {
      source: 'desde-bridge',
      type: 'BRIDGE_READY',
      payload: { version },
    },
  })
  Object.defineProperty(event, 'source', { value: setup.contentWindow })
  window.dispatchEvent(event)
}

function emitFromBridge(
  setup: MockIframeSetup,
  message: Record<string, unknown>,
): void {
  const event = new Event('message') as MessageEvent
  Object.defineProperty(event, 'data', {
    value: { source: 'desde-bridge', ...message },
  })
  Object.defineProperty(event, 'source', { value: setup.contentWindow })
  window.dispatchEvent(event)
}

function makeBridgeMutation(overrides: Partial<BridgeMutation> = {}): BridgeMutation {
  return {
    id: 'm-1',
    kind: 'text',
    sourceLoc: 'src/components/Card.vue:12:4',
    resolutionKind: 'direct',
    scope: 'definition',
    callsiteLoc: null,
    instancePath: 'App>HomePage>Card',
    selector: '[data-testid="card-title"]',
    before: 'Hello',
    after: 'Hi',
    ...overrides,
  }
}

describe('BridgeFrameworkAdapter — DOM-edit-mode (Phase A)', () => {
  let adapter: BridgeFrameworkAdapter
  let setup: MockIframeSetup

  beforeEach(async () => {
    adapter = new BridgeFrameworkAdapter()
    setup = makeMockIframe()
    const target: AdapterTarget = { iframe: setup.iframe, origin: '*' }
    const initPromise = adapter.init(target)
    emitBridgeReady(setup)
    await initPromise
    setup.postMessages.length = 0
  })

  afterEach(async () => {
    await adapter.dispose()
  })

  it('adapter is a thin proxy: no getPendingMutations/clearPendingMutations on contract', () => {
    expect(
      (adapter as unknown as Record<string, unknown>).getPendingMutations,
    ).toBeUndefined()
    expect(
      (adapter as unknown as Record<string, unknown>).clearPendingMutations,
    ).toBeUndefined()
  })

  it('exitDomEditMode from clean state is a no-op', async () => {
    await expect(adapter.exitDomEditMode()).resolves.toBeUndefined()
    expect(setup.postMessages).not.toContainEqual(
      expect.objectContaining({ type: 'EXIT_DOM_EDIT_MODE' }),
    )
  })

  it('MUTATION_CAPTURED dispatches the mutation to subscribed listeners', async () => {
    const listener = vi.fn<(m: Mutation) => void>()
    adapter.onMutationCaptured(listener)

    const wire = makeBridgeMutation({ before: 'Hello', after: 'Hi' })
    emitFromBridge(setup, { type: 'MUTATION_CAPTURED', payload: wire })

    expect(listener).toHaveBeenCalledTimes(1)
    const got = listener.mock.calls[0][0]
    expect(got.id).toBe('m-1')
    expect(got.before).toBe('Hello')
    expect(got.after).toBe('Hi')
    expect(got.resolutionKind).toBe('direct')
  })

  it('MUTATION_AWAITING_DISAMBIGUATION dispatches a PendingMutation to subscribed listeners', async () => {
    const listener = vi.fn<(p: PendingMutation) => void>()
    adapter.onMutationAwaitingDisambiguation(listener)

    const draftMutation = makeBridgeMutation()
    const { instancePath: _ip, ...draft } = draftMutation
    void _ip
    const pending: BridgePendingMutation = {
      pendingId: 'pending-1',
      draft,
      candidates: [
        { instancePath: 'App>List>Item[0]', selector: '[data-i="0"]', origin: false },
        { instancePath: 'App>List>Item[1]', selector: '[data-i="1"]', origin: true },
      ],
    }
    emitFromBridge(setup, {
      type: 'MUTATION_AWAITING_DISAMBIGUATION',
      payload: pending,
    })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0].pendingId).toBe('pending-1')
    expect(listener.mock.calls[0][0].candidates).toHaveLength(2)
  })

  it('MUTATION_RESOLUTION_FAILED dispatches the failure to subscribed listeners', async () => {
    const listener = vi.fn<(f: { id: string; reason: string; selector: string }) => void>()
    adapter.onResolutionFailed(listener)

    emitFromBridge(setup, {
      type: 'MUTATION_RESOLUTION_FAILED',
      payload: {
        id: 'f-1',
        reason: 'No data-desde-src ancestor — cannot map this edit to source.',
        selector: 'div.unanchored',
      },
    })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0].id).toBe('f-1')
  })

  it('listener throw inside onMutationCaptured does not break the adapter', async () => {
    const throwing = vi.fn(() => {
      throw new Error('listener bug')
    })
    const ok = vi.fn()
    adapter.onMutationCaptured(throwing)
    adapter.onMutationCaptured(ok)
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    emitFromBridge(setup, {
      type: 'MUTATION_CAPTURED',
      payload: makeBridgeMutation(),
    })

    expect(throwing).toHaveBeenCalled()
    expect(ok).toHaveBeenCalled() // Other listeners still fire.
    consoleSpy.mockRestore()
  })

  it('resolveMutationDisambiguation sends RESOLVE_MUTATION_DISAMBIGUATION to bridge', async () => {
    adapter.resolveMutationDisambiguation('pending-1', 'this-instance')
    expect(setup.postMessages).toContainEqual({
      type: 'RESOLVE_MUTATION_DISAMBIGUATION',
      payload: { pendingId: 'pending-1', choice: 'this-instance' },
    })
  })

  it('dispose clears listeners — they do not survive across reinit', async () => {
    const captured = vi.fn()
    adapter.onMutationCaptured(captured)

    await adapter.dispose()

    setup = makeMockIframe()
    const target: AdapterTarget = { iframe: setup.iframe, origin: '*' }
    const initPromise = adapter.init(target)
    emitBridgeReady(setup)
    await initPromise

    // The listener from the prior session should be gone.
    emitFromBridge(setup, {
      type: 'MUTATION_CAPTURED',
      payload: makeBridgeMutation(),
    })
    expect(captured).not.toHaveBeenCalled()
  })
})
