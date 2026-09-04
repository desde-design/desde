/**
 * Tests for the Editor settings menu + the project-conventions dialog it
 * opens. `useProjectKnowledge` is mocked so each case drives a fixed response.
 *
 * The dialog is a controlled component, so its content/state logic is tested
 * directly with `open` (avoids driving Radix's portal-based DropdownMenu in
 * jsdom). A single menu test covers the gear → menu-item → dialog wiring.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ProjectKnowledge } from "@/editor/core/project-knowledge"
import type { ProjectKnowledgeResponse } from "@/hooks/useProjectKnowledge"
import type { DesktopBridge } from "@/types/desktop-bridge"
import {
  EditorSettingsMenu,
  ProjectConventionsDialog,
} from "./editor-settings-menu"

// `mock`-prefixed so vitest's hoisted `vi.mock` factory may reference it.
let mockResponse: ProjectKnowledgeResponse

vi.mock("@/hooks/useProjectKnowledge", () => ({
  useProjectKnowledge: () => mockResponse,
}))

function knowledge(overrides: Partial<ProjectKnowledge> = {}): ProjectKnowledge {
  return {
    rules: "----- CLAUDE.md -----\nUse <script setup>.",
    rulesFiles: [{ path: "CLAUDE.md", chars: 40, truncated: false }],
    docIndex: [{ path: "docs/arch.md", title: "Architecture" }],
    truncated: false,
    ...overrides,
  }
}

/** Base response with the SDK fields defaulted off — legacy-mode shape. */
function response(
  overrides: Partial<ProjectKnowledgeResponse> = {},
): ProjectKnowledgeResponse {
  return {
    useRepoConventions: true,
    excludeFiles: [],
    sdkRuntime: false,
    nativeFiles: [],
    knowledge: knowledge(),
    ...overrides,
  }
}

const noop = () => {}

/**
 * The menu now mounts `useLlmCredentials`, which fetches on mount. Every test
 * needs a stub or the unawaited resolve lands outside `act()`. The default is
 * a configured key, so the first-run prompt stays shut in the pre-existing
 * cases.
 */
function stubCredentials(status: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(status), { status: 200 })),
  )
}

/**
 * Builds the `{ providers: { anthropic: ... } }` map shape from just the
 * Anthropic fields a given test cares about.
 */
function anthropicStatus(fields: {
  source: string
  maskedHint?: string
  storedHint?: string
  hasStoredKey?: boolean
  devMode?: boolean
  promptDismissed?: boolean
}) {
  const { devMode = false, promptDismissed = false, ...provider } = fields
  return {
    providers: {
      anthropic: {
        id: "anthropic",
        label: "Anthropic",
        hasStoredKey: false,
        apiKeyEnvVar: "ANTHROPIC_API_KEY",
        consoleUrl: "https://console.anthropic.com/settings/keys",
        maskPrefix: "sk-ant-",
        hasSubscriptionRuntime: true,
        ...provider,
      },
    },
    devMode,
    promptDismissed,
  }
}

beforeEach(() => {
  window.localStorage.clear()
  stubCredentials(
    anthropicStatus({
      source: "stored",
      maskedHint: "sk-ant-…4f2a",
      storedHint: "sk-ant-…4f2a",
      hasStoredKey: true,
    }),
  )
})

afterEach(() => {
  delete (window as { desdeDesktop?: unknown }).desdeDesktop
  vi.unstubAllGlobals()
})

describe("EditorSettingsMenu", () => {
  it("renders a more-menu trigger (menu closed by default)", async () => {
    mockResponse = response()
    render(<EditorSettingsMenu />)
    // Flush the credential fetch the menu now issues on mount, so its
    // setState lands inside act() rather than warning after the assertions.
    await act(async () => {})
    expect(screen.getByTestId("editor-settings")).toBeInTheDocument()
    // Dialog is closed until the menu item is chosen.
    expect(screen.queryByText("Project conventions")).not.toBeInTheDocument()
  })

  // The gear → "Model & references" → dialog path relies on Radix's
  // portal-based DropdownMenu, which uses pointer-capture APIs jsdom doesn't
  // implement. The dialog's own behavior is covered by the
  // ProjectConventionsDialog suite below; opening it from the menu is trusted
  // shadcn/Radix wiring and verified live, not in jsdom.

  // tasks/electron-app.md §3: window.desdeDesktop is the ONLY gate for
  // every desktop-only affordance — a plain browser tab must show no badge
  // at all, not merely a hidden/empty one.
  it("shows no desktop-update badge on the gear in a plain browser tab (window.desdeDesktop absent)", async () => {
    mockResponse = response()
    render(<EditorSettingsMenu />)
    await act(async () => {})
    expect(screen.queryByTestId("desktop-update-badge")).not.toBeInTheDocument()
  })

  it("shows a badge on the gear when the desktop bridge reports an actionable update", async () => {
    mockResponse = response()
    const bridge: DesktopBridge = {
      appVersion: "1.4.0",
      updates: {
        getState: async () => ({ phase: "ready", version: "1.5.0" }),
        onState: () => () => {},
        download: async () => {},
        restartAndInstall: async () => "installing" as const,
        checkForUpdates: async () => ({ performed: true }),
        getAutoDownload: async () => true,
        setAutoDownload: async () => {},
      },
      claudeRuntime: {
        getState: async () => ({ phase: "ready" }),
        onState: () => () => {},
        retry: () => {},
      },
      pickFolder: async () => null,
    }
    ;(window as unknown as { desdeDesktop: DesktopBridge }).desdeDesktop = bridge
    render(<EditorSettingsMenu />)
    // The button says the word now rather than wearing a dot. A dot says
    // "something in here changed" and makes the user open the menu to find
    // out what; an update has a deadline, so it says its own name.
    await waitFor(() => {
      expect(screen.getByTestId("editor-settings")).toHaveTextContent("Update")
    })
    expect(screen.queryByTestId("desktop-update-badge")).not.toBeInTheDocument()
  })

  it("keeps the quiet dot for phases that are progress rather than a call to act", async () => {
    mockResponse = response()
    const bridge: DesktopBridge = {
      appVersion: "1.4.0",
      updates: {
        getState: async () => ({ phase: "downloading", version: "1.5.0", percent: 43 }),
        onState: () => () => {},
        download: async () => {},
        restartAndInstall: async () => "installing" as const,
        checkForUpdates: async () => ({ performed: true }),
        getAutoDownload: async () => true,
        setAutoDownload: async () => {},
      },
      claudeRuntime: {
        getState: async () => ({ phase: "ready" }),
        onState: () => () => {},
        retry: () => {},
      },
      pickFolder: async () => null,
    }
    ;(window as unknown as { desdeDesktop: DesktopBridge }).desdeDesktop = bridge
    render(<EditorSettingsMenu />)
    await waitFor(() => {
      expect(screen.getByTestId("desktop-update-badge")).toHaveAttribute(
        "data-phase",
        "downloading",
      )
    })
    expect(screen.getByTestId("editor-settings")).not.toHaveTextContent("Update")
  })
})

describe("ProjectConventionsDialog", () => {
  it("explains when repo conventions are turned off", () => {
    mockResponse = response({ useRepoConventions: false, knowledge: null })
    render(<ProjectConventionsDialog open onOpenChange={noop} />)
    expect(screen.getByTestId("conventions-off")).toBeInTheDocument()
  })

  it("explains when conventions are on but no rule files are found", () => {
    mockResponse = response({ knowledge: knowledge({ rulesFiles: [] }) })
    render(<ProjectConventionsDialog open onOpenChange={noop} />)
    expect(screen.getByTestId("conventions-empty")).toBeInTheDocument()
  })

  it("lists the digest, rule files, and docs index", () => {
    mockResponse = response()
    render(<ProjectConventionsDialog open onOpenChange={noop} />)
    expect(screen.getByText("Project conventions")).toBeInTheDocument()
    expect(screen.getByText("CLAUDE.md")).toBeInTheDocument()
    expect(screen.getByText("docs/arch.md")).toBeInTheDocument()
    expect(screen.getByText(/Use <script setup>\./)).toBeInTheDocument()
  })

  it("surfaces a truncation warning when the digest was cut", () => {
    mockResponse = response({ knowledge: knowledge({ truncated: true }) })
    render(<ProjectConventionsDialog open onOpenChange={noop} />)
    expect(screen.getByText(/exceeded its size budget/i)).toBeInTheDocument()
  })

  it("shows a CLAUDE.md-only repo via native files in SDK mode", () => {
    mockResponse = response({
      sdkRuntime: true,
      nativeFiles: ["CLAUDE.md"],
      knowledge: knowledge({ rulesFiles: [], rules: "" }),
    })
    render(<ProjectConventionsDialog open onOpenChange={noop} />)
    expect(screen.getByText(/loaded directly by the agent/i)).toBeInTheDocument()
    expect(screen.getByText("CLAUDE.md")).toBeInTheDocument()
  })

  it("does not warn about truncation in SDK mode when only the native file is large", () => {
    mockResponse = response({
      sdkRuntime: true,
      nativeFiles: ["CLAUDE.md"],
      knowledge: knowledge({ rulesFiles: [], rules: "", truncated: false }),
    })
    render(<ProjectConventionsDialog open onOpenChange={noop} />)
    expect(
      screen.queryByText(/exceeded its size budget/i),
    ).not.toBeInTheDocument()
  })
})

describe("EditorSettingsMenu — API key section", () => {
  it("marks the gear when no credential is configured", async () => {
    mockResponse = response()
    stubCredentials(anthropicStatus({ source: "none" }))
    render(<EditorSettingsMenu />)
    await waitFor(() =>
      expect(
        screen.getByTestId("editor-settings-credential-marker"),
      ).toBeInTheDocument(),
    )
  })

  it("does not mark the gear when a credential exists", async () => {
    mockResponse = response()
    stubCredentials(anthropicStatus({ source: "subscription" }))
    render(<EditorSettingsMenu />)
    await waitFor(() => expect(screen.getByTestId("editor-settings")).toBeInTheDocument())
    expect(screen.queryByTestId("editor-settings-credential-marker")).toBeNull()
  })

  it("auto-opens the credential dialog when nothing is configured", async () => {
    mockResponse = response()
    stubCredentials(anthropicStatus({ source: "none" }))
    render(<EditorSettingsMenu />)
    await waitFor(() =>
      expect(screen.getByText("AI provider keys")).toBeInTheDocument(),
    )
  })

  it("does not auto-open once the prompt has been dismissed", async () => {
    mockResponse = response()
    // Server-side now, not localStorage: the editor's port (and so its origin)
    // changes per project, which made a browser-scoped flag forgettable.
    stubCredentials(anthropicStatus({ source: "none", promptDismissed: true }))
    render(<EditorSettingsMenu />)
    await waitFor(() =>
      expect(
        screen.getByTestId("editor-settings-credential-marker"),
      ).toBeInTheDocument(),
    )
    // The marker is up but the dialog stayed shut.
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})

/**
 * There is ONE dot on the gear (2026-09-02). There used to be two, told apart
 * only by corner and hue, and the corners existed to stop them overlapping
 * rather than to mean anything.
 *
 * The history is worth keeping because both halves of it are load-bearing.
 * Codex review round four found that the credential marker and the update
 * badge both sat at `-right-0.5 -top-0.5` with the marker rendering second, so
 * a missing credential HID update-ready and update-error. The fix moved the
 * marker to the bottom-right. That worked and was unreadable: Mo, reading the
 * amber bottom-right dot in the project view, took it for an update
 * indicator. A dot can say "look here"; it cannot say which of four things.
 *
 * So one dot, one corner, priority-ordered, with the menu carrying the words.
 * These tests pin the priority, because the failure they replace was silent
 * in exactly the same way: an indicator that renders, in the right place,
 * meaning something other than what the reader thinks.
 */
describe("EditorSettingsMenu gear indicator", () => {
  const noCredentials = () =>
    stubCredentials(anthropicStatus({ source: "none" }))

  it("puts the credential dot in the top-right corner", async () => {
    mockResponse = response()
    noCredentials()
    render(<EditorSettingsMenu />)
    const marker = await screen.findByTestId("editor-settings-credential-marker")
    expect(marker.className).toContain("-top-0.5")
    expect(marker.className).not.toContain("-bottom-0.5")
  })

  it("shows only one dot, so nothing has to share a corner", async () => {
    mockResponse = response()
    noCredentials()
    render(<EditorSettingsMenu />)
    await screen.findByTestId("editor-settings-credential-marker")
    // The update badge is the other dot that used to be on this button. With
    // no desktop bridge there is no update state, so it must not render — and
    // with one, the assertion below proves it takes the corner alone.
    expect(screen.queryByTestId("desktop-update-badge")).not.toBeInTheDocument()
  })

  it("lets an update outrank a missing credential for the one corner", async () => {
    mockResponse = response()
    noCredentials()
    // `downloading`. `updateReady` covers BOTH `available` and `ready`, and
    // those replace the dot with the word "Update" (see the test above), so
    // `downloading` and `error` are the only phases that put a dot on this
    // button at all — which makes `downloading` the only honest way to ask
    // which indicator wins the corner.
    const bridge: DesktopBridge = {
      appVersion: "1.4.0",
      updates: {
        getState: async () => ({ phase: "downloading", version: "1.5.0", percent: 43 }),
        onState: () => () => {},
        download: async () => {},
        restartAndInstall: async () => "installing" as const,
        checkForUpdates: async () => ({ performed: true }),
        getAutoDownload: async () => true,
        setAutoDownload: async () => {},
      },
      claudeRuntime: {
        getState: async () => ({ phase: "ready" }),
        onState: () => () => {},
        retry: () => {},
      },
      pickFolder: async () => null,
    }
    ;(window as unknown as { desdeDesktop: DesktopBridge }).desdeDesktop = bridge
    render(<EditorSettingsMenu />)
    await waitFor(() => {
      expect(screen.getByTestId("desktop-update-badge")).toHaveAttribute("data-phase", "downloading")
    })
    // The credential dot stands down rather than stacking. This is the exact
    // case the bottom-right workaround existed for, now handled by priority.
    expect(screen.queryByTestId("editor-settings-credential-marker")).not.toBeInTheDocument()
  })
})

/**
 * "Check for updates" opens a dialog (Mo, 2026-09-02: an explicit action
 * gets a modal, not a toast). The menu closes on select, so the dialog is
 * this menu's to own; this proves the wiring from the item to it.
 */
describe("EditorSettingsMenu — Check for updates opens the check dialog", () => {
  afterEach(() => {
    delete (window as { desdeDesktop?: unknown }).desdeDesktop
  })

  it("shows the check running in a dialog, then the result", async () => {
    mockResponse = response()
    let settle: ((r: { performed: boolean }) => void) | undefined
    const bridge: DesktopBridge = {
      appVersion: "0.1.1",
      updates: {
        getState: async () => ({ phase: "idle" }),
        onState: () => () => {},
        download: async () => {},
        restartAndInstall: async () => "installing" as const,
        checkForUpdates: () => new Promise((resolve) => { settle = resolve }),
        getAutoDownload: async () => true,
        setAutoDownload: async () => {},
      },
      claudeRuntime: {
        getState: async () => ({ phase: "ready" }),
        onState: () => () => {},
        retry: () => {},
      },
      pickFolder: async () => null,
    }
    ;(window as unknown as { desdeDesktop: DesktopBridge }).desdeDesktop = bridge
    render(<EditorSettingsMenu />)

    fireEvent.pointerDown(await screen.findByTestId("editor-settings"), { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByTestId("desktop-update-check-now"))

    expect(await screen.findByTestId("desktop-update-check-dialog")).toHaveAttribute("data-view", "checking")
    settle?.({ performed: true })
    await waitFor(() =>
      expect(screen.getByTestId("desktop-update-check-dialog")).toHaveAttribute("data-view", "up-to-date"),
    )
  })
})
