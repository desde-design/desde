/**
 * ModelPickerChip fetches its catalog once and caches it at module
 * scope (so tab switches don't refetch) — see model-picker-chip.tsx.
 * Each test here isolates that module state with `vi.resetModules()`
 * and a dynamic re-import, following the pattern established in
 * editor-feature-flags.test.ts, so a successful fetch in one test
 * can't mask a failure-path assertion in another.
 *
 * `@/components/ui/dropdown-menu` is swapped for a faithful inline
 * version (content always rendered, radio groups wired through
 * context) — Radix DropdownMenu doesn't reliably open under jsdom's
 * fireEvent (needs real pointer-capture semantics), and this repo
 * doesn't have `@testing-library/user-event` installed. Same approach
 * as branch-mode-controls.test.tsx's DropdownMenu mock. The
 * enable/disable + value-carry logic under test is ours, not Radix's.
 */
import { createContext, useContext, useState, type ReactNode } from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
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
    ...rest
  }: {
    value: string
    children: ReactNode
    [key: string]: unknown
  }) => {
    const ctx = useContext(RadioGroupContext)
    return (
      <div
        role="menuitemradio"
        aria-checked={ctx?.value === value}
        onClick={() => ctx?.onValueChange(value)}
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
  it("labels each provider's group and lists its own models beneath", async () => {
    vi.resetModules()
    const { ModelPickerChip } = await import("./model-picker-chip")
    await stubCatalog(TWO_PROVIDER_CATALOG)
    render(<ModelPickerChip value={null} onChange={() => {}} />)
    fireEvent.click(await screen.findByTestId("editor-model-chip"))
    expect(screen.getByText("Anthropic")).toBeInTheDocument()
    expect(screen.getByText("OpenAI")).toBeInTheDocument()
    expect(
      screen.getByTestId("editor-model-option-anthropic-claude-opus-4-8"),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId("editor-model-option-openai-gpt-5.2"),
    ).toBeInTheDocument()
  })

  it("reports the provider alongside the model when a pick crosses providers", async () => {
    vi.resetModules()
    const { ModelPickerChip } = await import("./model-picker-chip")
    await stubCatalog(TWO_PROVIDER_CATALOG)
    const onChange = vi.fn()
    render(<ModelPickerChip value={null} onChange={onChange} />)
    fireEvent.click(await screen.findByTestId("editor-model-chip"))
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
