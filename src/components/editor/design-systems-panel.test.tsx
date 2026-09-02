/**
 * Tests for the "Scan health" section of the Design Systems panel —
 * `useDesignSystems` is mocked so each case drives a fixed `health` value.
 * Follows the mocked-hook pattern from editor-settings-menu.test.tsx.
 */

import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DriftEntry, GroundingHealth, SourceHealthEntry } from "@/editor/core"
import type { UseDesignSystems } from "@/hooks/useDesignSystems"
import type { UseDriftEntries } from "@/hooks/useDriftEntries"
import { DesignSystemsPanel } from "./design-systems-panel"

// `mock`-prefixed so vitest's hoisted `vi.mock` factory may reference it.
let mockResponse: UseDesignSystems
let mockDriftResponse: UseDriftEntries

vi.mock("@/hooks/useDesignSystems", () => ({
  useDesignSystems: () => mockResponse,
}))

vi.mock("@/hooks/useDriftEntries", () => ({
  useDriftEntries: () => mockDriftResponse,
}))

function baseResponse(overrides: Partial<UseDesignSystems> = {}): UseDesignSystems {
  return {
    systems: [],
    suggestions: [],
    health: null,
    reconciliation: null,
    declarationsError: null,
    updates: {},
    loading: false,
    error: null,
    busy: false,
    progress: null,
    hintProgress: null,
    addInstalled: async () => null,
    addNpm: async () => null,
    addRepo: async () => null,
    remove: async () => {},
    share: async () => true,
    reload: async () => {},
    checkUpdates: async () => {},
    refresh: async () => true,
    generateHints: async () => ({ probed: 0, hinted: 0, verified: 0, skipped: [], wroteCache: false }),
    clearError: () => {},
    ...overrides,
  }
}

function baseDriftResponse(overrides: Partial<UseDriftEntries> = {}): UseDriftEntries {
  return {
    entries: [],
    loading: false,
    error: null,
    busy: false,
    regeneratingKey: null,
    regenerateProgress: null,
    reload: async () => {},
    dismiss: async () => {},
    clearAll: async () => {},
    regenerateHints: async () => ({ probed: 0, hinted: 0, verified: 0, skipped: [] }),
    clearError: () => {},
    ...overrides,
  }
}

const driftEntry = (overrides: Partial<DriftEntry> = {}): DriftEntry => ({
  key: "UiButton::@acme/ui",
  component: "UiButton",
  importPath: "@acme/ui",
  designSystem: "@acme/ui",
  kinds: ["hint-miss"],
  count: 1,
  firstSeen: "2026-07-29T00:00:00.000Z",
  lastSeen: new Date(Date.now() - 5 * 60_000).toISOString(),
  ...overrides,
})

const registeredEntry = (
  overrides: Partial<UseDesignSystems["systems"][number]> = {},
): UseDesignSystems["systems"][number] => ({
  id: "@acme/ui",
  source: { kind: "installed", package: "@acme/ui" },
  package: "@acme/ui",
  version: "1.0.0",
  framework: "vue3",
  designSystem: "@acme/ui",
  importPath: "@acme/ui",
  addedAt: "2026-01-01T00:00:00.000Z",
  declared: true,
  hintCoverage: null,
  ...overrides,
})

function health(overrides: Partial<GroundingHealth> = {}): GroundingHealth {
  return {
    root: "/root",
    builtAt: new Date().toISOString(),
    sources: [],
    runtimeErrors: [],
    ...overrides,
  }
}

beforeEach(() => {
  // Default: no drift entries, so pre-existing tests (which never set
  // `mockDriftResponse` themselves) see the section hidden, as before.
  mockDriftResponse = baseDriftResponse()
})

describe("DesignSystemsPanel scan health section", () => {
  it("renders no scan-health section when health is null (not built yet)", () => {
    mockResponse = baseResponse({ health: null })
    render(<DesignSystemsPanel />)
    expect(screen.queryByText("Scan health")).not.toBeInTheDocument()
    expect(screen.queryByText(/All sources built clean/)).not.toBeInTheDocument()
  })

  it("shows the all-clean state when every source is ok with no cache info", () => {
    const sources: SourceHealthEntry[] = [
      { step: "first-party", sourceId: "a", discovered: 3, status: "ok" },
      { step: "acme-ds", sourceId: "b", discovered: 10, status: "ok" },
    ]
    mockResponse = baseResponse({ health: health({ sources }) })
    render(<DesignSystemsPanel />)
    expect(screen.getByText("Scan health")).toBeInTheDocument()
    expect(screen.getByText("All sources built clean.")).toBeInTheDocument()
    expect(screen.queryByText("a")).not.toBeInTheDocument()
    expect(screen.queryByText("b")).not.toBeInTheDocument()
  })

  it("filters to interesting rows only and caps runtime errors at 5 with a +N more suffix", () => {
    const sources: SourceHealthEntry[] = [
      // ok + no cache -> not interesting, filtered out.
      { step: "first-party", sourceId: "clean-ok", discovered: 3, status: "ok" },
      // ok + cache -> interesting (cache info is news even when it succeeded).
      {
        step: "acme-ds",
        sourceId: "cached-ok",
        packageName: "@acme/design-system",
        discovered: 10,
        status: "ok",
        cache: "hit",
      },
      // skipped -> interesting.
      {
        step: "extra",
        sourceId: "skipped-one",
        discovered: 0,
        status: "skipped",
        reason: "not installed",
      },
      // failed -> interesting.
      {
        step: "broken",
        sourceId: "failed-one",
        discovered: 0,
        status: "failed",
        reason: "parse error",
      },
    ]
    const runtimeErrors = Array.from({ length: 7 }, (_, i) => ({
      sourceId: `src-${i}`,
      method: "listComponents",
      message: `boom-${i}`,
      at: new Date().toISOString(),
    }))
    mockResponse = baseResponse({ health: health({ sources, runtimeErrors }) })
    const { container } = render(<DesignSystemsPanel />)

    // Filtered out: the clean ok-with-no-cache row never renders.
    expect(screen.queryByText("clean-ok")).not.toBeInTheDocument()

    // Kept: ok-with-cache (rendered via packageName + a "cache hit" suffix),
    // skipped, and failed rows.
    expect(container.textContent).toContain("@acme/design-system")
    expect(screen.getByText("cache hit")).toBeInTheDocument()
    expect(screen.getByText("skipped-one")).toBeInTheDocument()
    expect(screen.getByText("not installed")).toBeInTheDocument()
    expect(screen.getByText("failed-one")).toBeInTheDocument()
    expect(screen.getByText("parse error")).toBeInTheDocument()

    // Runtime errors: exactly 5 lines shown, capped, plus a "+2 more" suffix.
    for (let i = 0; i < 5; i++) {
      expect(screen.getByText(`src-${i}: boom-${i}`)).toBeInTheDocument()
    }
    expect(screen.queryByText(/src-5: boom-5/)).not.toBeInTheDocument()
    expect(screen.queryByText(/src-6: boom-6/)).not.toBeInTheDocument()
    expect(screen.getByText("+2 more")).toBeInTheDocument()
  })
})

describe("DesignSystemsPanel shared-config + reconciliation state", () => {
  it("shows no 'not in shared config' hint or share button when a system is declared", () => {
    mockResponse = baseResponse({ systems: [registeredEntry({ declared: true })] })
    render(<DesignSystemsPanel />)
    expect(screen.queryByText("not in shared config")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Add to shared config" })).not.toBeInTheDocument()
  })

  it("shows the 'not in shared config' hint and a share button only for undeclared systems", () => {
    mockResponse = baseResponse({
      systems: [
        registeredEntry({ id: "@acme/ui", declared: true }),
        registeredEntry({ id: "@acme/other", package: "@acme/other", designSystem: "@acme/other", declared: false }),
      ],
    })
    render(<DesignSystemsPanel />)
    expect(screen.getAllByText("not in shared config")).toHaveLength(1)
    expect(screen.getAllByRole("button", { name: "Add to shared config" })).toHaveLength(1)
  })

  it("calls share(id) when the 'Add to shared config' button is clicked", () => {
    const share = vi.fn(async () => true)
    mockResponse = baseResponse({ systems: [registeredEntry({ declared: false })], share })
    render(<DesignSystemsPanel />)
    fireEvent.click(screen.getByRole("button", { name: "Add to shared config" }))
    expect(share).toHaveBeenCalledWith("@acme/ui")
  })

  it("renders no reconciliation callouts when reconciliation is null", () => {
    mockResponse = baseResponse({ reconciliation: null })
    render(<DesignSystemsPanel />)
    expect(screen.queryByText(/Setting up/)).not.toBeInTheDocument()
  })

  it("shows a 'Setting up N declared design system(s)…' callout listing each pending/running entry's kind + label", () => {
    mockResponse = baseResponse({
      reconciliation: {
        startedAt: "2026-01-01T00:00:00.000Z",
        entries: [
          { identity: "@acme/ui", label: "@acme/ui", kind: "installed", state: "pending" },
          {
            identity: "repo:https://github.com/acme/ds|main|",
            label: "https://github.com/acme/ds",
            kind: "repo",
            state: "running",
          },
          { identity: "@acme/done", label: "@acme/done", kind: "installed", state: "done" },
        ],
      },
    })
    render(<DesignSystemsPanel />)
    expect(screen.getByText("Setting up 2 declared design system(s)…")).toBeInTheDocument()
    // What's being ingested, not just the count — per-entry kind + label.
    expect(screen.getByText("installed: @acme/ui")).toBeInTheDocument()
    expect(screen.getByText("repo: https://github.com/acme/ds")).toBeInTheDocument()
    // The 'done' entry isn't in-flight — must not appear in this callout.
    expect(screen.queryByText(/@acme\/done/)).not.toBeInTheDocument()
  })

  it("shows a warning callout listing failed reconciliation entries by label + reason", () => {
    mockResponse = baseResponse({
      reconciliation: {
        startedAt: "2026-01-01T00:00:00.000Z",
        entries: [
          {
            identity: "@acme/broken",
            label: "@acme/broken",
            kind: "npm",
            state: "failed",
            reason: "npm install failed",
          },
        ],
      },
    })
    render(<DesignSystemsPanel />)
    expect(screen.getByText("@acme/broken: npm install failed")).toBeInTheDocument()
  })

  it("surfaces declarationsError in a warning callout", () => {
    mockResponse = baseResponse({ declarationsError: "invalid designSystems entry at index 0" })
    render(<DesignSystemsPanel />)
    expect(
      screen.getByText("Shared config has errors: invalid designSystems entry at index 0"),
    ).toBeInTheDocument()
  })
})

describe("DesignSystemsPanel staleness + refresh (Phase 3)", () => {
  it("shows no 'Update available' badge or Refresh button when the entry is fresh", () => {
    mockResponse = baseResponse({
      systems: [registeredEntry()],
      updates: { "@acme/ui": { id: "@acme/ui", state: "fresh" } },
    })
    render(<DesignSystemsPanel />)
    expect(screen.queryByText("Update available")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument()
  })

  it("shows an 'Update available' badge and a Refresh button only for a stale entry", () => {
    mockResponse = baseResponse({
      systems: [
        registeredEntry({ id: "@acme/ui" }),
        registeredEntry({ id: "@acme/other", package: "@acme/other", designSystem: "@acme/other" }),
      ],
      updates: {
        "@acme/ui": { id: "@acme/ui", state: "update-available", latest: "2.0.0" },
        "@acme/other": { id: "@acme/other", state: "fresh" },
      },
    })
    render(<DesignSystemsPanel />)
    expect(screen.getAllByText("Update available")).toHaveLength(1)
    expect(screen.getAllByRole("button", { name: "Refresh" })).toHaveLength(1)
  })

  it("calls refresh(id) when the per-row Refresh button is clicked", () => {
    const refresh = vi.fn(async () => true)
    mockResponse = baseResponse({
      systems: [registeredEntry({ id: "@acme/ui" })],
      updates: { "@acme/ui": { id: "@acme/ui", state: "update-available" } },
      refresh,
    })
    render(<DesignSystemsPanel />)
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
    expect(refresh).toHaveBeenCalledWith("@acme/ui")
  })

  it("does not render a 'Check for updates' button when there are no registered systems", () => {
    mockResponse = baseResponse({ systems: [] })
    render(<DesignSystemsPanel />)
    expect(screen.queryByRole("button", { name: "Check for updates" })).not.toBeInTheDocument()
  })

  it("calls checkUpdates(true) when 'Check for updates' is clicked", () => {
    const checkUpdates = vi.fn(async () => {})
    mockResponse = baseResponse({ systems: [registeredEntry()], checkUpdates })
    render(<DesignSystemsPanel />)
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }))
    expect(checkUpdates).toHaveBeenCalledWith(true)
  })
})

describe("DesignSystemsPanel probe-derived hints (Phase 4 Task 3)", () => {
  it("shows an enabled 'Generate hints' action for a probe-eligible (vue3) registered system, calling generateHints(id, useLlm) with useLlm:false by default", () => {
    const generateHints = vi.fn(async () => ({ probed: 0, hinted: 0, verified: 0, skipped: [], wroteCache: false }))
    mockResponse = baseResponse({ systems: [registeredEntry()], generateHints })
    render(<DesignSystemsPanel />)
    const button = screen.getByRole("button", { name: "Generate hints" })
    expect(button).toBeEnabled()
    fireEvent.click(button)
    expect(generateHints).toHaveBeenCalledWith("@acme/ui", false)
  })

  // Probing (Phase 4 Task 3) mounts the component in an isolation page that
  // only ever renders Vue — see `src/editor/hints/probe-capability.ts`. The
  // CLI's generate-hints route reads the SAME predicate and refuses a react
  // entry outright (see `editor-cli/src/server/design-systems-handler.test.ts`),
  // so offering an enabled button here would be a control that fails on
  // click. Disabled-with-a-title, not hidden, so the user can tell why.
  it("disables 'Generate hints' with an explanatory title for a react system, since probing is Vue-only", () => {
    const generateHints = vi.fn(async () => ({ probed: 0, hinted: 0, verified: 0, skipped: [], wroteCache: false }))
    mockResponse = baseResponse({
      systems: [registeredEntry({ framework: "react" })],
      generateHints,
    })
    render(<DesignSystemsPanel />)
    const button = screen.getByRole("button", { name: "Generate hints" })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute(
      "title",
      'Probe-derived rendering hints are Vue-only today; "react" isn\'t supported yet.',
    )
    fireEvent.click(button)
    expect(generateHints).not.toHaveBeenCalled()
  })

  it("passes useLlm:true once the LLM checkbox is checked (Phase 4 Task 5)", () => {
    const generateHints = vi.fn(async () => ({ probed: 0, hinted: 0, verified: 0, skipped: [], wroteCache: false }))
    mockResponse = baseResponse({ systems: [registeredEntry()], generateHints })
    render(<DesignSystemsPanel />)
    fireEvent.click(screen.getByTestId("use-llm-hints-checkbox"))
    fireEvent.click(screen.getByRole("button", { name: "Generate hints" }))
    expect(generateHints).toHaveBeenCalledWith("@acme/ui", true)
  })

  it("the LLM checkbox is unchecked by default and not rendered with no registered systems", () => {
    mockResponse = baseResponse({ systems: [] })
    render(<DesignSystemsPanel />)
    expect(screen.queryByTestId("use-llm-hints-checkbox")).not.toBeInTheDocument()
  })

  it("disables 'Generate hints' while busy", () => {
    mockResponse = baseResponse({ systems: [registeredEntry()], busy: true })
    render(<DesignSystemsPanel />)
    expect(screen.getByRole("button", { name: "Generate hints" })).toBeDisabled()
  })

  it("renders no coverage line when hintCoverage is null (never generated)", () => {
    mockResponse = baseResponse({ systems: [registeredEntry({ hintCoverage: null })] })
    render(<DesignSystemsPanel />)
    expect(screen.queryByText(/components hinted/)).not.toBeInTheDocument()
  })

  it("renders the 'H of N components hinted (V verified)' coverage line when hintCoverage is present", () => {
    mockResponse = baseResponse({
      systems: [registeredEntry({ hintCoverage: { hinted: 12, verified: 10, total: 20 } })],
    })
    render(<DesignSystemsPanel />)
    expect(screen.getByText("12 of 20 components hinted (10 verified)")).toBeInTheDocument()
  })

  it("shows probing progress in the header while a generate-hints run streams", () => {
    mockResponse = baseResponse({
      busy: true,
      hintProgress: { component: "UiButton", index: 2, total: 5 },
    })
    render(<DesignSystemsPanel />)
    expect(screen.getByText("Probing UiButton (3/5)")).toBeInTheDocument()
  })
})

describe("DesignSystemsPanel drift section (Phase 5 Task 5)", () => {
  it("renders no Drift section (not even an empty state) when the log is empty", () => {
    mockResponse = baseResponse()
    mockDriftResponse = baseDriftResponse({ entries: [] })
    render(<DesignSystemsPanel />)
    expect(screen.queryByText("Drift")).not.toBeInTheDocument()
  })

  it("renders one row per entry with component, package, kind badges, count, and relative lastSeen", () => {
    mockResponse = baseResponse()
    mockDriftResponse = baseDriftResponse({
      entries: [
        driftEntry({
          component: "UiButton",
          importPath: "@acme/ui",
          kinds: ["hint-miss", "unknown-props"],
          count: 3,
        }),
      ],
    })
    render(<DesignSystemsPanel />)
    expect(screen.getByText("Drift")).toBeInTheDocument()
    expect(screen.getByText("UiButton")).toBeInTheDocument()
    expect(screen.getByText("@acme/ui")).toBeInTheDocument()
    expect(screen.getByText("hint miss")).toBeInTheDocument()
    expect(screen.getByText("unknown props")).toBeInTheDocument()
    expect(screen.getByText(/seen ×3/)).toBeInTheDocument()
    expect(screen.getByText(/5m ago/)).toBeInTheDocument()
  })

  it("shows an 'Add design system' action only for an unknown-component entry whose package isn't registered", () => {
    mockResponse = baseResponse({ systems: [] })
    mockDriftResponse = baseDriftResponse({
      entries: [
        driftEntry({
          key: "KWidget::@nope/ui",
          component: "KWidget",
          importPath: "@nope/ui",
          designSystem: undefined,
          kinds: ["unknown-component"],
        }),
      ],
    })
    render(<DesignSystemsPanel />)
    expect(screen.getByTestId("drift-add-design-system")).toBeInTheDocument()
  })

  it("hides 'Add design system' once the owning package IS registered, showing 'Refresh design system' instead", () => {
    mockResponse = baseResponse({ systems: [registeredEntry({ id: "@acme/ui" })] })
    mockDriftResponse = baseDriftResponse({
      entries: [
        driftEntry({
          component: "UiButton",
          importPath: "@acme/ui",
          designSystem: "@acme/ui",
          kinds: ["unknown-component"],
        }),
      ],
    })
    render(<DesignSystemsPanel />)
    expect(screen.queryByTestId("drift-add-design-system")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Refresh design system" })).toBeInTheDocument()
  })

  it("hides 'Add design system' for a non-unknown-component kind even when unregistered", () => {
    mockResponse = baseResponse({ systems: [] })
    mockDriftResponse = baseDriftResponse({
      entries: [driftEntry({ kinds: ["hint-miss"] })],
    })
    render(<DesignSystemsPanel />)
    expect(screen.queryByTestId("drift-add-design-system")).not.toBeInTheDocument()
  })

  it("explains the manifest matched and points at 'Regenerate hints' when repair.outcome is 'unchanged'", () => {
    mockResponse = baseResponse()
    mockDriftResponse = baseDriftResponse({
      entries: [
        driftEntry({
          repair: { attemptedAt: "2026-07-29T00:00:00.000Z", outcome: "unchanged" },
        }),
      ],
    })
    render(<DesignSystemsPanel />)
    // "manifest" is our word for the cached record of what a component
    // accepts, not anything the reader has. What still has to hold is the
    // DISTINCTION: nothing was found stale, so the escalation is hints.
    expect(
      screen.getByText(/Nothing stale in this component: regenerate hints to refresh them/),
    ).toBeInTheDocument()
    expect(screen.queryByText(/manifest/i)).not.toBeInTheDocument()
  })

  it("explains no prior cache existed and points at 'Regenerate hints' when repair.outcome is 'seeded'", () => {
    mockResponse = baseResponse()
    mockDriftResponse = baseDriftResponse({
      entries: [
        driftEntry({
          repair: { attemptedAt: "2026-07-29T00:00:00.000Z", outcome: "seeded" },
        }),
      ],
    })
    render(<DesignSystemsPanel />)
    expect(
      // Still says "read, not fixed" — the outcome that must not be confused
      // with `repaired` — without naming the cache.
      screen.getByText(/This component hadn't been read yet, so it was read now\. If this still won't attribute, regenerate hints/),
    ).toBeInTheDocument()
  })

  it("shows the repair reason alongside a failed outcome", () => {
    mockResponse = baseResponse()
    mockDriftResponse = baseDriftResponse({
      entries: [
        driftEntry({
          repair: {
            attemptedAt: "2026-07-29T00:00:00.000Z",
            outcome: "failed",
            reason: "no tsconfig resolvable",
          },
        }),
      ],
    })
    render(<DesignSystemsPanel />)
    expect(screen.getByText("Auto-repair failed: no tsconfig resolvable")).toBeInTheDocument()
  })

  it("hides 'Regenerate hints' when the entry has no resolved designSystem (the server 422s that case unconditionally)", () => {
    mockResponse = baseResponse()
    mockDriftResponse = baseDriftResponse({
      entries: [driftEntry({ designSystem: undefined, importPath: undefined })],
    })
    render(<DesignSystemsPanel />)
    expect(screen.queryByRole("button", { name: "Regenerate hints" })).not.toBeInTheDocument()
  })

  it("shows 'Regenerate hints' when the entry has a resolved designSystem", () => {
    mockResponse = baseResponse()
    mockDriftResponse = baseDriftResponse({
      entries: [driftEntry({ designSystem: "@acme/ui" })],
    })
    render(<DesignSystemsPanel />)
    expect(screen.getByRole("button", { name: "Regenerate hints" })).toBeInTheDocument()
  })

  it("puts the full repair reason in a title attribute for hover (the row itself truncates)", () => {
    mockResponse = baseResponse()
    mockDriftResponse = baseDriftResponse({
      entries: [
        driftEntry({
          repair: {
            attemptedAt: "2026-07-29T00:00:00.000Z",
            outcome: "failed",
            reason: "a very long reason that would otherwise be clipped by truncate styling",
          },
        }),
      ],
    })
    render(<DesignSystemsPanel />)
    const reasonEl = screen.getByText(
      "Auto-repair failed: a very long reason that would otherwise be clipped by truncate styling",
    )
    expect(reasonEl).toHaveAttribute(
      "title",
      "Auto-repair failed: a very long reason that would otherwise be clipped by truncate styling",
    )
  })

  it("calls regenerateHints(key) when 'Regenerate hints' is clicked", () => {
    const regenerateHints = vi.fn(async () => ({ probed: 1, hinted: 1, verified: 1, skipped: [] }))
    mockResponse = baseResponse()
    mockDriftResponse = baseDriftResponse({
      entries: [driftEntry({ key: "UiButton::@acme/ui" })],
      regenerateHints,
    })
    render(<DesignSystemsPanel />)
    fireEvent.click(screen.getByRole("button", { name: "Regenerate hints" }))
    expect(regenerateHints).toHaveBeenCalledWith("UiButton::@acme/ui")
  })

  it("calls refresh(id) on the MATCHED registered entry when 'Refresh design system' is clicked", () => {
    const refresh = vi.fn(async () => true)
    mockResponse = baseResponse({
      systems: [registeredEntry({ id: "@acme/ui", designSystem: "@acme/ui", importPath: "@acme/ui" })],
      refresh,
    })
    mockDriftResponse = baseDriftResponse({
      entries: [driftEntry({ designSystem: "@acme/ui", importPath: "@acme/ui" })],
    })
    render(<DesignSystemsPanel />)
    fireEvent.click(screen.getByRole("button", { name: "Refresh design system" }))
    expect(refresh).toHaveBeenCalledWith("@acme/ui")
  })

  it("calls dismiss(key) per row and clearAll() from the header", () => {
    const dismiss = vi.fn(async () => {})
    const clearAll = vi.fn(async () => {})
    mockResponse = baseResponse()
    mockDriftResponse = baseDriftResponse({
      entries: [driftEntry({ key: "UiButton::@acme/ui" })],
      dismiss,
      clearAll,
    })
    render(<DesignSystemsPanel />)
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(dismiss).toHaveBeenCalledWith("UiButton::@acme/ui")
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }))
    expect(clearAll).toHaveBeenCalled()
  })

  it("shows probing progress in the header while a regenerate-hints run streams", () => {
    mockResponse = baseResponse()
    mockDriftResponse = baseDriftResponse({
      entries: [driftEntry()],
      busy: true,
      regenerateProgress: { component: "UiButton", index: 0, total: 1 },
    })
    render(<DesignSystemsPanel />)
    expect(screen.getByText("Probing UiButton (1/1)")).toBeInTheDocument()
  })

  it("surfaces a drift error in a dismissible callout", () => {
    const clearError = vi.fn()
    mockResponse = baseResponse()
    mockDriftResponse = baseDriftResponse({
      entries: [driftEntry()],
      error: "component not found",
      clearError,
    })
    render(<DesignSystemsPanel />)
    expect(screen.getByText("component not found")).toBeInTheDocument()
    // Two "Dismiss" buttons render (the error callout's + the row's) —
    // scope to the alert region to click the callout's own button.
    const alert = screen.getByRole("alert")
    fireEvent.click(alert.querySelector("button") as HTMLButtonElement)
    expect(clearError).toHaveBeenCalled()
  })
})

/**
 * "Add design system" replaces the panel body with the stepped flow. The three
 * sources used to live in a permanent tab strip at the bottom of the list,
 * which made this surface four sections deep and left a half-filled form on
 * screen for everyone who only came to read the list.
 */
describe("DesignSystemsPanel add mode", () => {
  it("swaps the list for the stepped flow, and back again on cancel", () => {
    mockResponse = baseResponse({
      systems: [registeredEntry({ designSystem: "@acme/design-system" })],
      suggestions: [
        {
          package: "@acme/other-ui",
          version: "1.4.0",
          componentCount: 4,
          framework: "vue3",
          importFrequency: 2,
        },
      ],
    })
    mockDriftResponse = baseDriftResponse()
    render(<DesignSystemsPanel />)

    // The tab strip is gone: nothing add-related is on screen until asked for.
    expect(screen.queryByTestId("add-design-system-source")).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId("open-add-design-system"))
    expect(screen.getByTestId("add-design-system-source")).toBeInTheDocument()
    expect(screen.queryByText("@acme/design-system")).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId("add-design-system-cancel"))
    expect(screen.getByText("@acme/design-system")).toBeInTheDocument()
  })

  it("returns to the list once an add succeeds, so the new row is visible", async () => {
    const addNpm = vi.fn().mockResolvedValue({ package: "@acme/widgets" })
    mockResponse = baseResponse({ addNpm })
    mockDriftResponse = baseDriftResponse()
    render(<DesignSystemsPanel />)

    fireEvent.click(screen.getByTestId("open-add-design-system"))
    fireEvent.click(screen.getByTestId("add-design-system-npm"))
    fireEvent.click(screen.getByTestId("add-design-system-next"))
    fireEvent.change(screen.getByLabelText("Package"), { target: { value: "@acme/widgets" } })
    fireEvent.click(screen.getByRole("button", { name: "Add" }))

    expect(addNpm).toHaveBeenCalledWith("@acme/widgets")
    await screen.findByTestId("open-add-design-system")
    expect(screen.queryByTestId("add-design-system-npm-step")).not.toBeInTheDocument()
  })

  it("deep-links a drift row straight to the npm form with the spec filled in", () => {
    mockResponse = baseResponse()
    mockDriftResponse = baseDriftResponse({
      entries: [driftEntry({ kinds: ["unknown-component"], importPath: "@acme/widgets" })],
    })
    render(<DesignSystemsPanel />)

    fireEvent.click(screen.getByTestId("drift-add-design-system"))
    // The row already answered "where from", so the picker is skipped.
    expect(screen.queryByTestId("add-design-system-source")).not.toBeInTheDocument()
    expect(screen.getByLabelText("Package")).toHaveValue("@acme/widgets")
  })
})
