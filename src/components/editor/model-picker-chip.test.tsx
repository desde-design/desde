/**
 * ModelPickerChip fetches its catalog once and caches it at module
 * scope (so tab switches don't refetch) — see model-picker-chip.tsx.
 * Each test here isolates that module state with `vi.resetModules()`
 * and a dynamic re-import, following the pattern established in
 * editor-feature-flags.test.ts, so a successful fetch in one test
 * can't mask a failure-path assertion in another.
 *
 * `@/components/ui/dropdown-menu` is swapped for a faithful inline
 * version (root content always rendered, radio groups wired through
 * context) — Radix DropdownMenu doesn't reliably open under jsdom's
 * fireEvent (needs real pointer-capture semantics), and this repo
 * doesn't have `@testing-library/user-event` installed. Same approach
 * as branch-mode-controls.test.tsx's DropdownMenu mock. The
 * enable/disable + value-carry logic under test is ours, not Radix's.
 *
 * The provider SUBMENU is the one part that is not always-rendered. Its
 * open state is the component's own (`open` / `onOpenChange`), so a mock
 * that ignored it would have asserted against a submenu that is open by
 * construction and could not fail. It now renders its content only while
 * open — which is the whole of what the mock models about submenus. Radix's
 * portals, focus management and hover timing stay out of scope, and pushing
 * the mock toward being a second Radix would cost more than the gap.
 */
import { createContext, useContext, useState, type ReactNode } from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { SessionModelConfig } from "@/editor/core/model-catalog"

const CATALOG_RESPONSE = {
  catalogs: [
    {
      providerId: "anthropic",
      models: [
        {
          id: "claude-opus-4-8",
          label: "Opus 4.8",
          effortLevels: ["low", "medium", "high", "xhigh", "max"],
          defaultEffort: "medium",
          isDefault: true,
        },
        { id: "claude-haiku-4-5", label: "Haiku 4.5", effortLevels: null },
      ],
    },
  ],
  default: { provider: "anthropic", model: "claude-opus-4-8" },
}

vi.mock("@/lib/editor-fetch", () => ({
  editorFetch: vi.fn(async () => ({
    ok: true,
    json: async () => CATALOG_RESPONSE,
  })),
}))

/**
 * Two catalogs, used by the "two providers in one menu" suite below. Each
 * provider's ids overlap in shape only (never in value) with the other's, so
 * a test that gets the wrong provider's group would fail loudly rather than
 * by accident matching the right id.
 */
const TWO_PROVIDER_CATALOG = {
  catalogs: [
    {
      providerId: "anthropic",
      models: [
        {
          id: "claude-opus-4-8",
          label: "Opus 4.8",
          effortLevels: ["low", "medium", "high", "xhigh", "max"],
          defaultEffort: "medium",
          isDefault: true,
        },
        { id: "claude-haiku-4-5", label: "Haiku 4.5", effortLevels: null },
      ],
    },
    {
      providerId: "openai",
      models: [
        {
          id: "gpt-5.2",
          label: "GPT-5.2",
          effortLevels: ["low", "medium", "high"],
          defaultEffort: "medium",
          isDefault: true,
        },
      ],
    },
  ],
  default: { provider: "anthropic", model: "claude-opus-4-8" },
  defaultProviderId: "anthropic",
}

/** Same anthropic half as `TWO_PROVIDER_CATALOG`, openai dropped. */
const ANTHROPIC_ONLY_CATALOG = {
  catalogs: [TWO_PROVIDER_CATALOG.catalogs[0]],
  default: { provider: "anthropic", model: "claude-opus-4-8" },
  defaultProviderId: "anthropic",
}

/**
 * A stale/fresh pair used only by the invalidation-race test below. Both
 * name the same provider and id so the point-of-difference is purely the
 * label, which is what the assertion reads off the rendered chip.
 */
const RACE_STALE_CATALOG = {
  catalogs: [
    {
      providerId: "anthropic",
      models: [{ id: "claude-opus-4-8", label: "Stale Model", effortLevels: null, isDefault: true }],
    },
  ],
  default: { provider: "anthropic", model: "claude-opus-4-8" },
}
const RACE_FRESH_CATALOG = {
  catalogs: [
    {
      providerId: "anthropic",
      models: [{ id: "claude-opus-4-8", label: "Fresh Model", effortLevels: null, isDefault: true }],
    },
  ],
  default: { provider: "anthropic", model: "claude-opus-4-8" },
}

/**
 * Queues one catalog response for the NEXT fetch. Shared by every suite in
 * this file — `mockCatalogOnce` below is the same shape and predates this
 * one; kept as its own name there because it is scoped to the
 * session/server-agreement describe block that already reads that name.
 */
async function stubCatalog(body: unknown) {
  const { editorFetch } = await import("@/lib/editor-fetch")
  vi.mocked(editorFetch).mockResolvedValueOnce({
    ok: true,
    json: async () => body,
  } as unknown as Response)
}

interface RadioCtx {
  value: string
  onValueChange: (value: string) => void
}
const RadioGroupContext = createContext<RadioCtx | null>(null)

/** The provider submenu's controlled open state, as the mock below models it. */
const SubContext = createContext<{
  open: boolean
  onOpenChange?: (open: boolean) => void
} | null>(null)

/** Open the provider submenu the way a user does: click its trigger. */
function openProviderSubmenu() {
  fireEvent.click(screen.getByTestId("editor-provider-switcher"))
}

/** Values whose select would have dismissed the real Radix menu. */
const menuDismissals: string[] = []

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuSeparator: () => <hr />,
  // The submenu parts the provider switcher uses. This is not a second
  // implementation of Radix, and trying to make it one would be worse than
  // the gap it leaves: no portals, no focus management, no hover timing.
  //
  // It models exactly TWO facts, both of which the component owns and a
  // regression in either would be silent otherwise. The submenu's open state
  // is CONTROLLED by the component (`open` / `onOpenChange`), and its content
  // exists only while open. Everything else about a Radix submenu is out of
  // scope here and stays untested by this file.
  DropdownMenuPortal: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuSub: ({
    open,
    onOpenChange,
    children,
  }: {
    open?: boolean
    onOpenChange?: (open: boolean) => void
    children: ReactNode
  }) => (
    <SubContext.Provider value={{ open: open === true, onOpenChange }}>
      <div>{children}</div>
    </SubContext.Provider>
  ),
  DropdownMenuSubTrigger: ({
    children,
    ...rest
  }: {
    children: ReactNode
    [key: string]: unknown
  }) => {
    const ctx = useContext(SubContext)
    return (
      <div
        role="menuitem"
        aria-expanded={ctx?.open ?? false}
        onClick={() => ctx?.onOpenChange?.(!(ctx?.open ?? false))}
        {...rest}
      >
        {children}
      </div>
    )
  },
  DropdownMenuSubContent: ({ children }: { children: ReactNode }) => {
    const ctx = useContext(SubContext)
    // Uncontrolled (`open` never passed) reads as closed, so dropping the
    // controlled prop fails loudly rather than leaving the list on screen.
    return ctx?.open ? <div>{children}</div> : null
  },
  DropdownMenuRadioGroup: ({
    value,
    onValueChange,
    children,
  }: {
    value: string
    onValueChange: (value: string) => void
    children: ReactNode
  }) => (
    <RadioGroupContext.Provider value={{ value, onValueChange }}>
      {children}
    </RadioGroupContext.Provider>
  ),
  DropdownMenuRadioItem: ({
    value,
    children,
    onSelect,
    ...rest
  }: {
    value: string
    children: ReactNode
    onSelect?: (event: { preventDefault: () => void }) => void
    [key: string]: unknown
  }) => {
    const ctx = useContext(RadioGroupContext)
    return (
      <div
        role="menuitemradio"
        aria-checked={ctx?.value === value}
        onClick={() => {
          // Radix dismisses the menu on select unless the handler prevents
          // it. The mock models only that one fact, because the provider
          // switcher's whole bug was the dismissal discarding the choice.
          let dismissed = true
          onSelect?.({ preventDefault: () => { dismissed = false } })
          ctx?.onValueChange(value)
          if (dismissed) menuDismissals.push(value)
        }}
        {...rest}
      >
        {children}
      </div>
    )
  },
}))

afterEach(() => {
  vi.resetModules()
})

/**
 * Stateful wrapper so `onChange` actually re-renders the chip with the
 * new value — a bare `onChange={vi.fn()}` leaves `value` frozen, so any
 * assertion about what the chip renders AFTER a change is vacuous.
 */
function makeHarness(
  Chip: typeof import("./model-picker-chip").ModelPickerChip,
) {
  return function Harness({
    initial = null,
    sessionId = null,
    spy,
    adoptSpy,
  }: {
    initial?: SessionModelConfig | null
    sessionId?: string | null
    spy?: (config: SessionModelConfig | null) => void
    /**
     * Supplying this is what marks the session as client-minted. It
     * stands in for the rail's seed-only writer, so passing it also
     * updates `value` — otherwise an assertion about what the chip
     * renders after adopting would be vacuous.
     */
    adoptSpy?: (config: SessionModelConfig) => void
  }) {
    const [value, setValue] = useState<SessionModelConfig | null>(initial)
    return (
      <Chip
        value={value}
        sessionId={sessionId}
        onChange={(config) => {
          spy?.(config)
          setValue(config)
        }}
        onAdoptLastChosenModel={
          adoptSpy
            ? (config) => {
                adoptSpy(config)
                setValue(config)
              }
            : undefined
        }
      />
    )
  }
}

describe("ModelPickerChip", () => {
  it("shows the default model label when value is null", async () => {
    vi.resetModules()
    const { ModelPickerChip } = await import("./model-picker-chip")
    render(<ModelPickerChip value={null} onChange={() => {}} />)
    await waitFor(() => {
      expect(screen.getByTestId("editor-model-chip")).toHaveTextContent(
        "Opus 4.8",
      )
    })
  })

  it("shows the chosen model and effort", async () => {
    vi.resetModules()
    const { ModelPickerChip } = await import("./model-picker-chip")
    render(
      <ModelPickerChip
        value={{ provider: "anthropic", model: "claude-opus-4-8", effort: "low" }}
        onChange={() => {}}
      />,
    )
    await waitFor(() => {
      expect(screen.getByTestId("editor-model-chip")).toHaveTextContent(
        "Opus 4.8 · low",
      )
    })
  })

  it("selecting a model calls onChange and hides effort for non-effort models", async () => {
    vi.resetModules()
    const { ModelPickerChip } = await import("./model-picker-chip")
    const Harness = makeHarness(ModelPickerChip)
    const spy = vi.fn()
    render(<Harness spy={spy} />)
    await waitFor(() => screen.getByTestId("editor-model-chip"))
    // Effort is offered on the default (Opus 4.8) …
    expect(screen.getByText("Effort")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("editor-model-chip"))
    fireEvent.click(screen.getByRole("menuitemradio", { name: /haiku 4\.5/i }))
    expect(spy).toHaveBeenCalledWith({
      provider: "anthropic",
      model: "claude-haiku-4-5",
    })

    // … and gone once the chip re-renders on the non-effort model. The
    // harness is what makes this assertion real: with a frozen `value`
    // the `option.effortLevels ? … : null` branch never re-evaluates.
    await waitFor(() => {
      expect(screen.getByTestId("editor-model-chip")).toHaveTextContent(
        "Haiku 4.5",
      )
    })
    expect(screen.queryByText("Effort")).not.toBeInTheDocument()
    expect(
      screen.queryByRole("menuitemradio", { name: /^low$/i }),
    ).not.toBeInTheDocument()
  })

  it("renders nothing when the catalog fetch fails", async () => {
    vi.resetModules()
    const { ModelPickerChip } = await import("./model-picker-chip")
    const { editorFetch } = await import("@/lib/editor-fetch")
    vi.mocked(editorFetch).mockRejectedValueOnce(new Error("boom"))
    const { container } = render(
      <ModelPickerChip value={null} onChange={() => {}} />,
    )
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })
})

describe("two providers in one menu", () => {
  it("lists one provider at a time, behind a switcher naming the current one", async () => {
    // Was: both providers' groups listed together. With two vendors
    // credentialed that ran to 24 rows and filled the screen (Mo,
    // 2026-09-07), so the provider moved into its own submenu and the list
    // below shows only the running model's vendor until it is switched.
    vi.resetModules()
    const { ModelPickerChip } = await import("./model-picker-chip")
    await stubCatalog(TWO_PROVIDER_CATALOG)
    render(<ModelPickerChip value={null} onChange={() => {}} />)
    fireEvent.click(await screen.findByTestId("editor-model-chip"))
    expect(screen.getByTestId("editor-provider-switcher")).toHaveTextContent(
      "Anthropic",
    )
    expect(
      screen.getByTestId("editor-model-option-anthropic-claude-opus-4-8"),
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId("editor-model-option-openai-gpt-5.2"),
    ).not.toBeInTheDocument()
  })

  it("switching provider lists that vendor's models and changes nothing yet", async () => {
    vi.resetModules()
    const { ModelPickerChip } = await import("./model-picker-chip")
    await stubCatalog(TWO_PROVIDER_CATALOG)
    const onChange = vi.fn()
    render(<ModelPickerChip value={null} onChange={onChange} />)
    fireEvent.click(await screen.findByTestId("editor-model-chip"))
    openProviderSubmenu()
    fireEvent.click(screen.getByTestId("editor-provider-option-openai"))
    expect(
      screen.getByTestId("editor-model-option-openai-gpt-5.2"),
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId("editor-model-option-anthropic-claude-opus-4-8"),
    ).not.toBeInTheDocument()
    // Browsing is not choosing: the running model is untouched until one of
    // the listed models is picked.
    expect(onChange).not.toHaveBeenCalled()
  })

  it("reports the provider alongside the model when a pick crosses providers", async () => {
    vi.resetModules()
    const { ModelPickerChip } = await import("./model-picker-chip")
    await stubCatalog(TWO_PROVIDER_CATALOG)
    const onChange = vi.fn()
    render(<ModelPickerChip value={null} onChange={onChange} />)
    fireEvent.click(await screen.findByTestId("editor-model-chip"))
    openProviderSubmenu()
    fireEvent.click(screen.getByTestId("editor-provider-option-openai"))
    fireEvent.click(screen.getByTestId("editor-model-option-openai-gpt-5.2"))
    expect(onChange).toHaveBeenCalledWith({ provider: "openai", model: "gpt-5.2" })
  })

  it("shows the label of the model in the SESSION's provider, not the first catalog's", async () => {
    vi.resetModules()
    const { ModelPickerChip } = await import("./model-picker-chip")
    await stubCatalog(TWO_PROVIDER_CATALOG)
    render(
      <ModelPickerChip
        value={{ provider: "openai", model: "gpt-5.2" }}
        onChange={() => {}}
      />,
    )
    await waitFor(() => {
      expect(screen.getByTestId("editor-model-chip")).toHaveTextContent("GPT-5.2")
    })
  })

  it("does not carry effort across a model that has none", async () => {
    vi.resetModules()
    const { ModelPickerChip } = await import("./model-picker-chip")
    await stubCatalog(TWO_PROVIDER_CATALOG)
    const onChange = vi.fn()
    render(
      <ModelPickerChip
        value={{ provider: "anthropic", model: "claude-opus-4-8", effort: "high" }}
        onChange={onChange}
      />,
    )
    fireEvent.click(await screen.findByTestId("editor-model-chip"))
    fireEvent.click(
      screen.getByTestId("editor-model-option-anthropic-claude-haiku-4-5"),
    )
    expect(onChange).toHaveBeenCalledWith({
      provider: "anthropic",
      model: "claude-haiku-4-5",
    })
  })

  it("hides the effort control entirely for a model with no effort levels", async () => {
    vi.resetModules()
    const { ModelPickerChip } = await import("./model-picker-chip")
    await stubCatalog(TWO_PROVIDER_CATALOG)
    render(
      <ModelPickerChip
        value={{ provider: "anthropic", model: "claude-haiku-4-5" }}
        onChange={() => {}}
      />,
    )
    fireEvent.click(await screen.findByTestId("editor-model-chip"))
    expect(screen.queryByText("Effort")).not.toBeInTheDocument()
  })

  it("drops a session back to the served default when its provider stops being served", async () => {
    // Removing an OpenAI key mid-session stops that catalog being served. The
    // chip must never display a model the next turn will be refused for.
    vi.resetModules()
    const { ModelPickerChip } = await import("./model-picker-chip")
    await stubCatalog(ANTHROPIC_ONLY_CATALOG)
    const onChange = vi.fn()
    render(
      <ModelPickerChip
        value={{ provider: "openai", model: "gpt-5.2" }}
        onChange={onChange}
      />,
    )
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null))
  })
})

/**
 * The invariant: the chip must never display a model different from the
 * one the next turn will actually run. The chip is the only component
 * holding the catalog, so it owns both halves — adopting the model the
 * user last chose for a chat that has none of its own, and dropping a
 * persisted choice the server would now reject.
 *
 * Whether the chain those halves belong to actually survives a project
 * reopen is chat-model-choice.test.tsx; this suite is the chip alone.
 */
describe("ModelPickerChip — session/server agreement", () => {
  /** Catalog response carrying a last chosen model. */
  const WITH_LAST_CHOSEN = {
    ...CATALOG_RESPONSE,
    lastChosenModel: { provider: "anthropic", model: "claude-haiku-4-5" },
  }

  async function mockCatalogOnce(body: unknown) {
    const { editorFetch } = await import("@/lib/editor-fetch")
    vi.mocked(editorFetch).mockResolvedValueOnce({
      ok: true,
      json: async () => body,
    } as unknown as Response)
  }

  it("adopts the last chosen model on the project-default session", async () => {
    vi.resetModules()
    const { ModelPickerChip } = await import("./model-picker-chip")
    await mockCatalogOnce(WITH_LAST_CHOSEN)
    const Harness = makeHarness(ModelPickerChip)
    const spy = vi.fn()
    // sessionId null = the next turn sends none, so the server resolves
    // the project-default session, which has no choice of its own.
    render(<Harness sessionId={null} spy={spy} />)

    await waitFor(() => {
      expect(screen.getByTestId("editor-model-chip")).toHaveTextContent(
        "Haiku 4.5",
      )
    })
    expect(spy).toHaveBeenCalledWith({
      provider: "anthropic",
      model: "claude-haiku-4-5",
    })
  })

  it("adopts the last chosen model onto a freshly minted session", async () => {
    vi.resetModules()
    const { ModelPickerChip } = await import("./model-picker-chip")
    await mockCatalogOnce(WITH_LAST_CHOSEN)
    const Harness = makeHarness(ModelPickerChip)
    const spy = vi.fn()
    const adoptSpy = vi.fn()
    // Opening a project mints a sessionId, so the next turn DOES send
    // one and the `sessionId === null` branch never fires. Without this
    // path the chat would silently start on the runtime catalog default
    // and the user's model choice would reset on every open.
    render(<Harness sessionId="minted-1" spy={spy} adoptSpy={adoptSpy} />)

    await waitFor(() => {
      expect(adoptSpy).toHaveBeenCalledWith({
        provider: "anthropic",
        model: "claude-haiku-4-5",
      })
    })
    // Routed through the caller's seed-only writer, not the plain
    // setter — the seeder names the session and refuses to overwrite.
    expect(spy).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByTestId("editor-model-chip")).toHaveTextContent(
        "Haiku 4.5",
      )
    })
    // Idempotent: the adopt moves `value` to a fixed point, so the
    // rerun it triggers must not fire again.
    expect(adoptSpy).toHaveBeenCalledTimes(1)
  })

  it("does NOT adopt the last chosen model onto a named session", async () => {
    vi.resetModules()
    const { ModelPickerChip } = await import("./model-picker-chip")
    await mockCatalogOnce(WITH_LAST_CHOSEN)
    const Harness = makeHarness(ModelPickerChip)
    const spy = vi.fn()
    // A session picked from the listing gets its own choice from
    // tab-switch hydration. Its value is null here. It legitimately runs
    // on the runtime default, and another chat's model would be the
    // wrong value to write. No adopt callback is what says so.
    render(<Harness sessionId="session-b" spy={spy} />)

    await waitFor(() => screen.getByTestId("editor-model-chip"))
    expect(spy).not.toHaveBeenCalled()
    expect(screen.getByTestId("editor-model-chip")).toHaveTextContent(
      "Opus 4.8",
    )
  })

  it("has nothing to adopt when nothing has ever been chosen", async () => {
    vi.resetModules()
    const { ModelPickerChip } = await import("./model-picker-chip")
    await mockCatalogOnce({ ...CATALOG_RESPONSE, lastChosenModel: null })
    const Harness = makeHarness(ModelPickerChip)
    const adoptSpy = vi.fn()
    render(<Harness sessionId="minted-1" adoptSpy={adoptSpy} />)

    await waitFor(() => screen.getByTestId("editor-model-chip"))
    expect(adoptSpy).not.toHaveBeenCalled()
    expect(screen.getByTestId("editor-model-chip")).toHaveTextContent(
      "Opus 4.8",
    )
  })

  it("drops a seeded model that has left the catalog", async () => {
    vi.resetModules()
    const { ModelPickerChip } = await import("./model-picker-chip")
    const Harness = makeHarness(ModelPickerChip)
    const spy = vi.fn()
    // Hydration seeded a model the server would now hard-400 as a
    // request override — and the chip would hide itself, leaving the
    // user with no picker and no way to send.
    render(
      <Harness
        sessionId="session-b"
        initial={{ provider: "anthropic", model: "claude-retired-1" }}
        spy={spy}
      />,
    )

    await waitFor(() => expect(spy).toHaveBeenCalledWith(null))
    // Back to the runtime default, and the chip is visible again.
    await waitFor(() => {
      expect(screen.getByTestId("editor-model-chip")).toHaveTextContent(
        "Opus 4.8",
      )
    })
  })

  it("drops an unknown provider", async () => {
    vi.resetModules()
    const { ModelPickerChip } = await import("./model-picker-chip")
    const Harness = makeHarness(ModelPickerChip)
    const spy = vi.fn()
    render(
      <Harness
        sessionId="session-b"
        initial={{ provider: "openai", model: "claude-opus-4-8" }}
        spy={spy}
      />,
    )
    await waitFor(() => expect(spy).toHaveBeenCalledWith(null))
  })

  it("normalizes an effort the model does not support", async () => {
    vi.resetModules()
    const { ModelPickerChip } = await import("./model-picker-chip")
    const Harness = makeHarness(ModelPickerChip)
    const spy = vi.fn()
    render(
      <Harness
        sessionId="session-b"
        initial={{
          provider: "anthropic",
          model: "claude-haiku-4-5",
          effort: "low",
        }}
        spy={spy}
      />,
    )
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({
        provider: "anthropic",
        model: "claude-haiku-4-5",
      }),
    )
  })

  it("leaves a still-valid choice alone", async () => {
    vi.resetModules()
    const { ModelPickerChip } = await import("./model-picker-chip")
    const Harness = makeHarness(ModelPickerChip)
    const spy = vi.fn()
    render(
      <Harness
        sessionId="session-b"
        initial={{
          provider: "anthropic",
          model: "claude-opus-4-8",
          effort: "high",
        }}
        spy={spy}
      />,
    )
    await waitFor(() => screen.getByTestId("editor-model-chip"))
    expect(spy).not.toHaveBeenCalled()
    expect(screen.getByTestId("editor-model-chip")).toHaveTextContent(
      "Opus 4.8 · high",
    )
  })

  it("drops a seeded choice it cannot validate when the catalog fetch fails", async () => {
    vi.resetModules()
    const { ModelPickerChip } = await import("./model-picker-chip")
    const { editorFetch } = await import("@/lib/editor-fetch")
    vi.mocked(editorFetch).mockRejectedValueOnce(new Error("boom"))
    const Harness = makeHarness(ModelPickerChip)
    const spy = vi.fn()
    // With no catalog the chip can't vouch for the seeded value, and it
    // never rendered, so the user cannot have picked it — it can only
    // be a persisted config. Sending it risks a 400 with the picker
    // hidden; dropping it makes the server re-derive the same choice
    // from its own record.
    render(
      <Harness
        sessionId="session-b"
        initial={{ provider: "anthropic", model: "claude-retired-1" }}
        spy={spy}
      />,
    )
    await waitFor(() => expect(spy).toHaveBeenCalledWith(null))
  })
})

/**
 * A 200 does not guarantee a SHAPE.
 *
 * `res.ok` only says the request succeeded. The body can still be something
 * else: an older server predating this route, a proxy or dev harness with a
 * catch-all answering `{ ok: true }` to anything unmatched, an SSO
 * interstitial. Accepting it took the success path and then threw on
 * `catalog.catalogs.length`, crashing the entire right rail instead of hiding
 * one chip.
 *
 * That is exactly how the self-host harness broke — its mock backend answers
 * `{ ok: true }` 200 for every unrecognised `/api/editor/*`, and this chip was
 * the one consumer that read the body.
 */
describe("ModelPickerChip — a malformed catalog must not crash the rail", () => {
  /** Mirrors the module-reset pattern the fetch-failure test above uses. */
  async function renderWithBody(body: unknown) {
    vi.resetModules()
    const { ModelPickerChip } = await import("./model-picker-chip")
    const { editorFetch } = await import("@/lib/editor-fetch")
    vi.mocked(editorFetch).mockResolvedValueOnce({
      ok: true,
      json: async () => body,
    } as unknown as Response)
    return render(<ModelPickerChip value={null} onChange={() => {}} />)
  }

  it("renders nothing for a 200 whose body is the wrong shape", async () => {
    // `{ ok: true }` is precisely what the self-host mock backend answers to
    // any unmatched /api/editor/* route. Accepting it threw on
    // `catalog.catalogs.length` and took the whole right rail down.
    const { container } = await renderWithBody({ ok: true })
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  it("renders nothing when `catalogs` is present but not an array", async () => {
    const { container } = await renderWithBody({ catalogs: null, default: null })
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })
})

/**
 * The user's most recent pick must outrank the cached catalog for as long as
 * that cache lives, and not one moment less.
 *
 * `catalogCache` is module state, so it survives a remount. The memory of what
 * the user picked was a `useRef`, which does not. Hiding and re-showing the
 * right rail therefore wiped the correction while leaving the stale value it
 * was correcting in place, and the next "+ New" silently reverted the user's
 * last choice. Both are module state now.
 */
describe("ModelPickerChip — the pick survives a remount", () => {
  const WITH_STALE_LAST_CHOSEN = {
    ...CATALOG_RESPONSE,
    // What the catalog was fetched with. The user is about to pick something
    // else, and this value must never win again afterwards.
    lastChosenModel: { provider: "anthropic", model: "claude-haiku-4-5" },
  }

  it("does not revert to the cached catalog after the chip unmounts and remounts", async () => {
    vi.resetModules()
    const { ModelPickerChip } = await import("./model-picker-chip")
    const { editorFetch } = await import("@/lib/editor-fetch")
    vi.mocked(editorFetch).mockResolvedValue({
      ok: true,
      json: async () => WITH_STALE_LAST_CHOSEN,
    } as unknown as Response)

    const Harness = makeHarness(ModelPickerChip)

    // 1. An existing session, so nothing adopts over it. The user picks Opus
    //    through the chip: that is the choice which must stick.
    const first = render(<Harness sessionId="s1" spy={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId("editor-model-chip")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId("editor-model-chip"))
    fireEvent.click(screen.getByRole("menuitemradio", { name: /opus 4\.8/i }))

    // 2. The rail is hidden and shown again: the chip unmounts and remounts,
    //    while the module-level catalog cache survives untouched.
    first.unmount()

    // 3. A freshly minted session with no choice of its own. `adoptSpy` is
    //    what marks it client-minted, so this is the adopt path. Before the
    //    fix the per-mount memory of the pick was gone and the stale cached
    //    Haiku won here, silently undoing step 1.
    const adoptSpy = vi.fn()
    render(<Harness sessionId="s2" adoptSpy={adoptSpy} spy={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId("editor-model-chip")).toBeInTheDocument()
    })
    expect(adoptSpy).not.toHaveBeenCalledWith({
      provider: "anthropic",
      model: "claude-haiku-4-5",
    })
  })
})

/**
 * `invalidateModelCatalogCache` is what a credential save/remove calls
 * (`useLlmCredentials.ts`) once the app's set of credentialed providers
 * changes. This chip must forget its cache and reconcile against the fresh
 * one — the same invariant as `catalog.lastChosenModel` going stale, just
 * triggered by a different event.
 */
describe("ModelPickerChip — forgets its catalog when invalidated", () => {
  it("refetches after the catalog cache is invalidated and drops a value the fresh catalogs no longer serve", async () => {
    vi.resetModules()
    const { ModelPickerChip, invalidateModelCatalogCache } = await import(
      "./model-picker-chip"
    )
    const { editorFetch } = await import("@/lib/editor-fetch")
    vi.mocked(editorFetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => TWO_PROVIDER_CATALOG,
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ANTHROPIC_ONLY_CATALOG,
      } as unknown as Response)

    const Harness = makeHarness(ModelPickerChip)
    const spy = vi.fn()
    render(
      <Harness
        sessionId="session-b"
        initial={{ provider: "openai", model: "gpt-5.2" }}
        spy={spy}
      />,
    )
    await waitFor(() => {
      expect(screen.getByTestId("editor-model-chip")).toHaveTextContent("GPT-5.2")
    })

    invalidateModelCatalogCache()

    // The fresh catalog no longer serves openai, so the chip must drop the
    // value and fall back to the served (anthropic) default.
    await waitFor(() => expect(spy).toHaveBeenCalledWith(null))
    await waitFor(() => {
      expect(screen.getByTestId("editor-model-chip")).toHaveTextContent("Opus 4.8")
    })
  })
})

/**
 * FX5 item 2: the invalidation race. `invalidateModelCatalogCache()` can run
 * WHILE a catalog fetch is still in flight (the user saves a credential
 * before the picker's first fetch has settled). If that fetch's promise
 * settles and the invalidation is called in the same synchronous tick — no
 * `await` between them — the fetch's `await` continuation can resume AFTER
 * the invalidation's version bump. A plain `setCatalogCache(body)` in that
 * continuation would then repopulate the cache with the catalog fetched
 * BEFORE the invalidation, and the picker would never issue the refetch
 * invalidation exists to trigger. This uses `createRoot` directly rather
 * than `@testing-library/react`'s `render` (and never wraps the
 * settle/invalidate pair in `act()`): `act()` forces a synchronous flush
 * between them that changes the very microtask ordering the race depends
 * on, and hides it — this reproduces the live repro's finding that the
 * race only shows up under production-shaped (non-`act`) scheduling.
 */
describe("ModelPickerChip — an in-flight fetch cannot defeat an invalidation racing it", () => {
  it("discards a catalog that settles after invalidation instead of repopulating the cache with it", async () => {
    vi.resetModules()
    const { ModelPickerChip, invalidateModelCatalogCache } = await import(
      "./model-picker-chip"
    )
    const { editorFetch } = await import("@/lib/editor-fetch")
    // Other tests in this file only rely on `mockResolvedValueOnce`'s
    // queueing order and never assert an absolute call count, so nothing
    // else here resets it. This test does assert a count, and the mock
    // instance is shared across the whole file, so it has to start clean.
    vi.mocked(editorFetch).mockClear()
    let resolveFirst!: (value: unknown) => void
    const firstFetch = new Promise((resolve) => {
      resolveFirst = resolve
    })
    vi.mocked(editorFetch)
      .mockReturnValueOnce(firstFetch as unknown as Promise<Response>)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => RACE_FRESH_CATALOG,
      } as unknown as Response)

    const el = document.createElement("div")
    document.body.appendChild(el)
    const root = createRoot(el)
    try {
      root.render(<ModelPickerChip value={null} onChange={() => {}} />)
      await waitFor(() => expect(editorFetch).toHaveBeenCalledTimes(1))

      // Settle the in-flight fetch, then let its FIRST `await` (on the
      // response itself) resume before invalidating — one microtask tick,
      // no more. That lands us mid-continuation: `res.ok` has been read and
      // `res.json()` called, but the SECOND `await` (on the parsed body)
      // has not resumed yet, so the write at the end of the effect has not
      // run. `invalidateModelCatalogCache()` bumps the module-level
      // version counter SYNCHRONOUSLY the moment it is called, before that
      // write runs — this is what makes the ordering deterministic rather
      // than a coin flip on React's own re-render scheduling.
      resolveFirst({ ok: true, json: () => RACE_STALE_CATALOG })
      await Promise.resolve()
      invalidateModelCatalogCache()

      await waitFor(() => expect(editorFetch).toHaveBeenCalledTimes(2))
      await waitFor(() => {
        expect(screen.getByTestId("editor-model-chip")).toHaveTextContent("Fresh Model")
      })
      expect(screen.queryByText("Stale Model")).not.toBeInTheDocument()
    } finally {
      root.unmount()
      el.remove()
    }
  })
})

/**
 * CX7 item 2: after a FAILED first fetch, `catalogCache` is already `null`.
 * `invalidateModelCatalogCache()` sets it to `null` again — a change
 * `useSyncExternalStore` can't see if the fetch effect keys off the cache
 * value itself, so the effect never reruns and the chip stays hidden
 * forever, even after the user saves the key the failure was about.
 */
describe("ModelPickerChip — recovers from a failed first fetch once invalidated", () => {
  it("refetches and renders after invalidation, even though the first fetch failed", async () => {
    vi.resetModules()
    const { ModelPickerChip, invalidateModelCatalogCache } = await import(
      "./model-picker-chip"
    )
    const { editorFetch } = await import("@/lib/editor-fetch")
    vi.mocked(editorFetch)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => CATALOG_RESPONSE,
      } as unknown as Response)

    const { container } = render(<ModelPickerChip value={null} onChange={() => {}} />)
    await waitFor(() => expect(container).toBeEmptyDOMElement())

    invalidateModelCatalogCache()

    await waitFor(() => {
      expect(screen.getByTestId("editor-model-chip")).toHaveTextContent("Opus 4.8")
    })
  })
})

describe("effort is a slider, not a list of rows", () => {
  it("shows the running effort and moves the model onto the stop the slider lands on", async () => {
    // Was five radio rows plus a "Default" row, which doubled the menu's
    // length for a value most turns never change. The stops are the model's
    // own ladder with the catalog default at index 0.
    vi.resetModules()
    const { ModelPickerChip } = await import("./model-picker-chip")
    await stubCatalog(TWO_PROVIDER_CATALOG)
    const onChange = vi.fn()
    render(
      <ModelPickerChip
        value={{ provider: "anthropic", model: "claude-opus-4-8", effort: "high" }}
        onChange={onChange}
      />,
    )
    fireEvent.click(await screen.findByTestId("editor-model-chip"))
    expect(screen.getByTestId("editor-effort-value")).toHaveTextContent("high")
    // No radio rows for the levels any more.
    expect(
      screen.queryByRole("menuitemradio", { name: /^high$/i }),
    ).not.toBeInTheDocument()
  })

  it("opens on the model's own default level when the session has no effort", async () => {
    // Was a "Default" stop meaning "send nothing, let the vendor decide".
    // That word named an implementation detail rather than a level (Mo,
    // 2026-09-07), so the ladder now starts at the level the catalog names.
    vi.resetModules()
    const { ModelPickerChip } = await import("./model-picker-chip")
    await stubCatalog(TWO_PROVIDER_CATALOG)
    render(<ModelPickerChip value={null} onChange={() => {}} />)
    fireEvent.click(await screen.findByTestId("editor-model-chip"))
    expect(screen.getByTestId("editor-effort-value")).toHaveTextContent("medium")
    expect(screen.queryByText("Default")).not.toBeInTheDocument()
  })

  it("falls back to the middle of the ladder when the catalog names no default", async () => {
    // A live-listed model whose ladder does not contain the vendor default
    // gets no `defaultEffort` at all, and the slider still has to start
    // somewhere real.
    vi.resetModules()
    const { ModelPickerChip } = await import("./model-picker-chip")
    await stubCatalog({
      catalogs: [
        {
          providerId: "anthropic",
          models: [
            {
              id: "claude-brand-new-7",
              label: "Brand New 7",
              effortLevels: ["low", "high", "max"],
              isDefault: true,
            },
          ],
        },
      ],
      default: { provider: "anthropic", model: "claude-brand-new-7" },
      defaultProviderId: "anthropic",
    })
    render(<ModelPickerChip value={null} onChange={() => {}} />)
    fireEvent.click(await screen.findByTestId("editor-model-chip"))
    expect(screen.getByTestId("editor-effort-value")).toHaveTextContent("high")
  })

  it("shows no effort control for a model with no ladder", async () => {
    vi.resetModules()
    const { ModelPickerChip } = await import("./model-picker-chip")
    await stubCatalog(TWO_PROVIDER_CATALOG)
    render(
      <ModelPickerChip
        value={{ provider: "anthropic", model: "claude-haiku-4-5" }}
        onChange={() => {}}
      />,
    )
    fireEvent.click(await screen.findByTestId("editor-model-chip"))
    expect(screen.queryByTestId("editor-effort-value")).not.toBeInTheDocument()
    expect(screen.queryByText("Effort")).not.toBeInTheDocument()
  })
})

describe("switching provider keeps the menu open", () => {
  it("does not dismiss the menu, and lists the newly chosen provider's models", async () => {
    // Reported by Mo, 2026-09-07: picking a provider closed the whole menu
    // and changed nothing. A Radix radio item dismisses on select, and the
    // close handler then reset the browsing state, so the choice was
    // discarded on the way out.
    menuDismissals.length = 0
    vi.resetModules()
    const { ModelPickerChip } = await import("./model-picker-chip")
    await stubCatalog(TWO_PROVIDER_CATALOG)
    render(<ModelPickerChip value={null} onChange={() => {}} />)
    fireEvent.click(await screen.findByTestId("editor-model-chip"))
    openProviderSubmenu()
    fireEvent.click(screen.getByTestId("editor-provider-option-openai"))
    expect(menuDismissals).toEqual([])
    expect(screen.getByTestId("editor-provider-switcher")).toHaveTextContent(
      "OpenAI",
    )
    expect(
      screen.getByTestId("editor-model-option-openai-gpt-5.2"),
    ).toBeInTheDocument()
  })

  it("keeps the provider submenu closed until its trigger is used", async () => {
    // The submenu's open state is the component's, not Radix's default. This
    // asserts the controlled `open` actually reaches it: without the prop the
    // mock reads as closed, and with the prop stuck open the first assertion
    // fails instead.
    vi.resetModules()
    const { ModelPickerChip } = await import("./model-picker-chip")
    await stubCatalog(TWO_PROVIDER_CATALOG)
    render(<ModelPickerChip value={null} onChange={() => {}} />)
    fireEvent.click(await screen.findByTestId("editor-model-chip"))
    expect(
      screen.queryByTestId("editor-provider-option-openai"),
    ).not.toBeInTheDocument()
    openProviderSubmenu()
    expect(
      screen.getByTestId("editor-provider-option-openai"),
    ).toBeInTheDocument()
  })

  it("closes the provider submenu once a provider is chosen", async () => {
    // The other half of the same fix. Preventing the radio item's default
    // keeps the ROOT menu open; the submenu still has to close on its own, or
    // the provider list stays over the models it was opened to change.
    vi.resetModules()
    const { ModelPickerChip } = await import("./model-picker-chip")
    await stubCatalog(TWO_PROVIDER_CATALOG)
    render(<ModelPickerChip value={null} onChange={() => {}} />)
    fireEvent.click(await screen.findByTestId("editor-model-chip"))
    openProviderSubmenu()
    fireEvent.click(screen.getByTestId("editor-provider-option-openai"))
    expect(
      screen.queryByTestId("editor-provider-option-openai"),
    ).not.toBeInTheDocument()
    expect(
      screen.getByTestId("editor-model-option-openai-gpt-5.2"),
    ).toBeInTheDocument()
  })
})

