/**
 * Dormant lanes — the OFFERING half (product decision 2026-08-11,
 * `tasks/dev-server-hosts.md` § 9e). `detach` and `swap` must not be presented
 * by the product unless the prototype opted in with `lanes.<id>: true`.
 *
 * Why this asserts the WIRING rather than the rendered menu item: both panels
 * already treat an absent handler as "this action does not exist"
 * (`canDetach = !!onDetach && …` in inspector-panel.tsx,
 * `detachAvailable = !!onDetach && …` in layers-panel.tsx), and their own
 * suites already pin that contract. Gating at the single place the handlers
 * are wired reuses it instead of adding a second, drift-prone copy of the
 * "should this be offered" rule inside each panel.
 *
 * The flags are read at module load from the CLI bootstrap, so each case
 * re-imports the rail after planting `window.__DESDE_CLI__` — the same
 * shape `editor-feature-flags.test.ts` uses.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { render } from "@testing-library/react"

vi.mock("@/components/editor/comments-panel", () => ({
  CommentsPanel: () => <div data-testid="comments-panel-stub" />,
}))
vi.mock("@/components/editor/chat-session-menu", () => ({
  ChatSessionMenu: () => <div data-testid="chat-session-menu-stub" />,
}))
vi.mock("@/components/editor/model-picker-chip", () => ({
  ModelPickerChip: () => <div data-testid="model-picker-chip-stub" />,
}))

/**
 * Capture what the two panels are handed. Mocked rather than rendered so the
 * assertion is about the wiring decision, not about Radix menu internals.
 */
const inspectorProps: Record<string, unknown>[] = []
const layersProps: Record<string, unknown>[] = []
vi.mock("@/components/editor/inspector-panel", () => ({
  InspectorPanel: (props: Record<string, unknown>) => {
    inspectorProps.push(props)
    return <div data-testid="inspector-panel-stub" />
  },
}))
vi.mock("@/components/editor/layers-panel", () => ({
  LayersPanel: (props: Record<string, unknown>) => {
    layersProps.push(props)
    return <div data-testid="layers-panel-stub" />
  },
}))

type StubWindow = { __DESDE_CLI__?: Record<string, unknown> }
const originalWindowCli = (globalThis as unknown as StubWindow).__DESDE_CLI__

afterEach(() => {
  if (originalWindowCli === undefined) {
    delete (globalThis as unknown as StubWindow).__DESDE_CLI__
  } else {
    ;(globalThis as unknown as StubWindow).__DESDE_CLI__ = originalWindowCli
  }
  inspectorProps.length = 0
  layersProps.length = 0
  vi.resetModules()
})

async function renderRailWith(
  lanes: { detach?: boolean; swap?: boolean } | undefined,
): Promise<void> {
  ;(globalThis as unknown as StubWindow).__DESDE_CLI__ = {
    ...(lanes !== undefined ? { lanes } : {}),
  }
  vi.resetModules()
  const { EditorRightRail } = await import("./editor-right-rail")
  const editing = {
    editorSelection: {
      selector: "#el",
      targetId: "#el",
      componentName: "KButton",
    },
    editorManifest: null,
    status: { kind: "ready" },
    layersRoots: null,
    layersRefreshing: false,
    refreshLayers: vi.fn(),
    handleLayerSelect: vi.fn(),
    handleLayerHover: vi.fn(),
    handleLayerMove: vi.fn(),
    handleLayerMoveRefused: vi.fn(),
    handleLayerDetach: vi.fn(),
    handleLayerDelete: vi.fn(),
    handleLayerInsert: vi.fn(),
    handleLayerUnwrap: vi.fn(),
    handleLayerFlattenConditional: vi.fn(),
    handlePropEdit: vi.fn(),
    handleInsertElement: vi.fn(),
    beginInsertPlacement: vi.fn(),
    cancelInsertPlacement: vi.fn(),
    handleDetach: vi.fn(),
    handleSwap: vi.fn(),
    handleEditComponent: vi.fn(),
    handleEditTextField: vi.fn(),
    handleClassesEdit: vi.fn(),
    handleScopedStyleEdit: vi.fn(),
    handleTokenStyleEdit: vi.fn(),
    handleEditTextBranch: vi.fn(),
    handlePickIcon: vi.fn(),
  }
  const chat = {
    messages: [],
    submitting: false,
    error: null,
    submit: vi.fn(),
    // Required on the real hook's return: the panel renders one spinner row
    // per steer being resent, so an omitted array crashes the render.
    resendingSteers: [],
    abort: vi.fn(),
    clearLocal: vi.fn(),
    hydrateFromTranscript: vi.fn(),
    hasSessionBucket: vi.fn(() => false),
    modelConfig: null,
    setModelConfig: vi.fn(),
    seedModelConfig: vi.fn(),
  }
  const chatSessions = {
    enabled: true,
    sessions: [],
    loading: false,
    error: null,
    currentSessionId: null,
    getChatSessionId: () => null,
    onSessionEvent: vi.fn(),
    onStreamComplete: vi.fn(),
    selectSession: vi.fn(),
    newSession: vi.fn(),
    refetch: vi.fn().mockResolvedValue(undefined),
  }
  /* eslint-disable @typescript-eslint/no-explicit-any -- the rail's editing/chat
     APIs are 100+ members wide; the three stubs above carry exactly what this
     suite renders, and widening them to the real types would obscure that. */
  render(
    <EditorRightRail
      activeTab="edit"
      onTabChange={vi.fn()}
      editing={editing as any}
      chat={chat as any}
      chatSessions={chatSessions as any}
      selectionMany={null}
      iframeRef={{ current: null }}
      commentBridge={{} as any}
      commentSync={{} as any}
      onCommentModeChange={vi.fn()}
    />,
  )
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

describe("dormant lanes — detach is not offered by default", () => {
  it("does not wire the inspector's Detach action", async () => {
    await renderRailWith(undefined)
    expect(inspectorProps.at(-1)?.onDetach).toBeUndefined()
  })

  it("does not wire the layers-panel Detach action", async () => {
    await renderRailWith(undefined)
    expect(layersProps.at(-1)?.onDetach).toBeUndefined()
  })

  it("wires both again with lanes.detach: true", async () => {
    await renderRailWith({ detach: true })
    expect(inspectorProps.at(-1)?.onDetach).toBeTypeOf("function")
    expect(layersProps.at(-1)?.onDetach).toBeTypeOf("function")
  })
})

describe("dormant lanes — swap is not offered by default", () => {
  it("does not wire the inspector's Swap action", async () => {
    await renderRailWith(undefined)
    expect(inspectorProps.at(-1)?.onSwap).toBeUndefined()
  })

  /**
   * The icon picker rides the SAME `kind: 'swap'` applicator
   * (`useEditorEditing.handlePickIcon` builds a `StructuralEdit` with
   * `kind: "swap"`), so it carries the same Vue-only inconsistency and the
   * same dispatch refusal. Leaving it offered would be a control that fails on
   * click — the exact failure gating at both ends exists to prevent.
   */
  it("does not wire the icon picker, which dispatches kind: 'swap'", async () => {
    await renderRailWith(undefined)
    expect(inspectorProps.at(-1)?.onPickIcon).toBeUndefined()
  })

  it("wires both again with lanes.swap: true", async () => {
    await renderRailWith({ swap: true })
    expect(inspectorProps.at(-1)?.onSwap).toBeTypeOf("function")
    expect(inspectorProps.at(-1)?.onPickIcon).toBeTypeOf("function")
  })
})

describe("dormant lanes — the two lanes gate independently", () => {
  it("lanes.detach alone leaves swap dormant", async () => {
    await renderRailWith({ detach: true })
    expect(inspectorProps.at(-1)?.onDetach).toBeTypeOf("function")
    expect(inspectorProps.at(-1)?.onSwap).toBeUndefined()
    expect(inspectorProps.at(-1)?.onPickIcon).toBeUndefined()
  })

  it("lanes.swap alone leaves detach dormant", async () => {
    await renderRailWith({ swap: true })
    expect(inspectorProps.at(-1)?.onSwap).toBeTypeOf("function")
    expect(inspectorProps.at(-1)?.onDetach).toBeUndefined()
    expect(layersProps.at(-1)?.onDetach).toBeUndefined()
  })

  it("leaves every non-dormant action wired", async () => {
    await renderRailWith(undefined)
    const inspector = inspectorProps.at(-1)
    const layers = layersProps.at(-1)
    expect(inspector?.onPropEdit).toBeTypeOf("function")
    expect(inspector?.onEditComponent).toBeTypeOf("function")
    expect(inspector?.onScopedStyleEdit).toBeTypeOf("function")
    expect(layers?.onMove).toBeTypeOf("function")
    expect(layers?.onDelete).toBeTypeOf("function")
    expect(layers?.onUnwrap).toBeTypeOf("function")
    expect(layers?.onFlattenConditional).toBeTypeOf("function")
  })
})
