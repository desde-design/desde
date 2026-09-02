/**
 * Regression test for the empty-state "Open a local folder" tile
 * (Phase 3 attach/refresh, task 4 review fix): it must route through the
 * New Project dialog's two-step flow — same as the "New project" button
 * and the empty-state's clone tile — instead of calling the native folder
 * picker directly and bypassing the design-system step. This test only
 * exercises the empty-state → dialog wiring.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { toast } from "sonner"
import { LauncherPage, trimPathToTail } from "./launcher-page"
import type { DesktopBridge } from "@/types/desktop-bridge"
import { HOVER_REVEAL } from "@/components/blocks"

type FetchSig = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
let fetchMock: ReturnType<typeof vi.fn<FetchSig>>
let realFetch: typeof fetch

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

beforeEach(() => {
  // The launcher's view now lives in `window.location.hash`
  // (`use-launcher-route.ts`), and jsdom keeps ONE location for the whole
  // file. Without this reset, the first test that opens the create flow
  // leaves `#/new` behind and every later test renders the wizard instead of
  // the project list — which is what 11 of them did the moment routing
  // landed. Resetting here rather than in each suite keeps it true by
  // default for tests added later.
  window.location.hash = ""
  realFetch = globalThis.fetch
  fetchMock = vi.fn<FetchSig>()
  globalThis.fetch = fetchMock as unknown as typeof fetch
  fetchMock.mockImplementation((input) => {
    const url = String(input)
    if (url.endsWith("/api/launcher/projects")) {
      return Promise.resolve(json(200, { ok: true, projects: [] }))
    }
    return Promise.resolve(json(404, { ok: false, reason: "unhandled in test" }))
  })
})

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

describe("LauncherPage — empty-state local tile", () => {
  it("opens the New Project dialog instead of invoking the folder picker directly", async () => {
    render(<LauncherPage folderPickerSupported={true} />)

    const tile = await screen.findByTestId("launcher-empty-open-local")
    fireEvent.click(tile)

    // The dialog opens...
    await screen.findByTestId("new-project-page")
    // ...reusing the same local-folder entry point the dialog already has —
    // no separate native-picker path was taken. The tile deep-links, so the
    // dialog lands on its folder step rather than asking which source again.
    expect(screen.getByTestId("new-project-local-step")).toBeInTheDocument()

    // Crucially: no direct pick-folder call fired just from this click — the
    // old bypass invoked the native picker (and could go straight to /open)
    // without the user ever seeing the design-system step.
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).endsWith("/pick-folder")),
    ).toBe(false)
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/open"))).toBe(false)
  })

  it("still routes the clone tile through the dialog (unchanged)", async () => {
    render(<LauncherPage folderPickerSupported={true} />)

    const tile = await screen.findByTestId("launcher-empty-clone")
    fireEvent.click(tile)

    await screen.findByTestId("new-project-page")
    await waitFor(() => expect(screen.getByLabelText("Repository URL")).toBeInTheDocument())
  })
})

/**
 * The launcher is where an update must be visible with NO project open
 * (`tasks/electron-app.md` §4). `window.desdeDesktop` is the only gate,
 * per `useDesktopUpdates` — a plain browser tab must show nothing extra in
 * the nav.
 */
describe("LauncherPage — the settings gear and its update chrome", () => {
  afterEach(() => {
    delete (window as { desdeDesktop?: unknown }).desdeDesktop
  })

  it("still shows the settings gear in a plain browser tab, with no update chrome in it", async () => {
    // REVERSED on 2026-08-18, deliberately. This asserted that a browser tab's
    // header was byte-identical to the pre-auto-update one, which was right
    // while the only thing in that column was an update button a browser tab
    // can never use. The column now holds the settings gear, and the gear
    // holds the Anthropic API key — machine-level, and the only way a CLI
    // user sets a key before opening a project. Hiding it here would strand
    // them.
    //
    // What still has to hold is that NO UPDATE chrome appears: no badge, and
    // no update section inside the menu.
    render(<LauncherPage folderPickerSupported={true} />)
    await screen.findByText("Projects")
    expect(await screen.findByTestId("launcher-settings")).toBeInTheDocument()
    expect(screen.queryByTestId("desktop-update-badge")).not.toBeInTheDocument()

    // By ACCESSIBLE NAME, not text. The wordmark became outlines on
    // 2026-09-02, so "Desde" is an `aria-label` on an `img` role rather than a
    // text node. `getByText` stopped matching, which is the right failure: the
    // mark is a graphic now, and its name is the thing worth asserting.
    const wordmark = screen.getByRole("img", { name: "Desde" })
    expect(wordmark.closest("header")).not.toBeNull()
    // The gear's column, and nothing else, trails the wordmark.
    const row = wordmark.parentElement
    expect(row?.children).toHaveLength(2)
    expect(row?.children[0]).toBe(wordmark)
  })

  it("aligns the wordmark with the page content column", async () => {
    render(<LauncherPage folderPickerSupported={true} />)
    await screen.findByText("Projects")

    // The bar is full-bleed (its border and sticky ground must reach both
    // window edges) but its contents ride <main>'s column. jsdom computes no
    // layout, so this asserts the mechanism that produces the alignment: the
    // wordmark's row and <main> carry the same centring + max-width + padding.
    const row = screen.getByRole("img", { name: "Desde" }).parentElement
    const main = document.querySelector("main")
    for (const cls of ["mx-auto", "w-full", "max-w-5xl", "px-6"]) {
      expect(row?.className).toContain(cls)
      expect(main?.className).toContain(cls)
    }
    // The full-bleed bar must NOT re-add its own horizontal padding, which
    // would offset the column it wraps and undo the alignment.
    expect(
      screen.getByRole("img", { name: "Desde" }).closest("header")?.className,
    ).not.toMatch(/\bpx-\d/)
  })

  it("grows the gear to say Update when one is actionable, instead of a dot", async () => {
    // Same rule the project gear follows: a dot says "something in here
    // changed" and makes you open the menu to find out what, while an update
    // is the one thing behind this menu with a deadline, so it says its own
    // name. `downloading` and `error` keep the quiet dot — see the next test.
    const bridge: DesktopBridge = {
      appVersion: "1.4.0",
      updates: {
        getState: async () => ({ phase: "available", version: "1.5.0" }),
        onState: () => () => {},
        download: async () => {},
        restartAndInstall: () => {},
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

    render(<LauncherPage folderPickerSupported={true} />)
    await screen.findByTestId("launcher-settings")
    await waitFor(() => {
      expect(screen.getByTestId("launcher-settings")).toHaveTextContent("Update")
    })
    expect(screen.queryByTestId("desktop-update-badge")).not.toBeInTheDocument()
  })

  it("keeps the quiet dot while an update is downloading", async () => {
    const bridge: DesktopBridge = {
      appVersion: "1.4.0",
      updates: {
        getState: async () => ({ phase: "downloading", version: "1.5.0", percent: 40 }),
        onState: () => () => {},
        download: async () => {},
        restartAndInstall: () => {},
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

    render(<LauncherPage folderPickerSupported={true} />)
    await screen.findByTestId("launcher-settings")
    await waitFor(() => {
      expect(screen.getByTestId("desktop-update-badge")).toHaveAttribute(
        "data-phase",
        "downloading",
      )
    })
    expect(screen.getByTestId("launcher-settings")).not.toHaveTextContent("Update")
  })
})

describe("project card row tinting", () => {
  /**
   * The tint wrapper is the card Button's parent. Extract ONLY the tint
   * class rather than comparing whole classNames, so nothing else the
   * wrapper happens to carry can decide these assertions.
   *
   * That is not hypothetical tidiness. The wrapper briefly carried a
   * per-index tilt as well, and a full-className compare silently folded it
   * into every result: the tilt cycle was 4 long and the widest grid is 4
   * columns, so the compare agreed with a correct tint check at that one
   * breakpoint and disagreed at every other — green by coincidence, which is
   * worse than red. The tilt is gone; the narrow extraction stays.
   */
  const tintOf = (name: string) => {
    const cls = screen.getByTestId(`launcher-project-${name}`).parentElement?.className ?? ""
    const m = /bg-primary\/\d+/.exec(cls)
    expect(m, `no bg-primary tint found on ${name} (className: ${cls})`).not.toBeNull()
    return m![0]
  }

  function projectsPayload(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      path: `/repos/p${i}`,
      slug: `p${i}`,
      lastOpenedAt: new Date("2026-08-12T00:00:00Z").toISOString(),
    }))
  }

  beforeEach(() => {
    fetchMock.mockImplementation((input) => {
      const url = String(input)
      if (url.endsWith("/api/launcher/projects")) {
        return Promise.resolve(json(200, { ok: true, projects: projectsPayload(14) }))
      }
      return Promise.resolve(json(404, { ok: false, reason: "unhandled in test" }))
    })
  })

  it("bands the tint by row, and the band tracks the column count", async () => {
    // 1280px puts the grid at its widest step: 4 columns.
    window.innerWidth = 1280
    render(<LauncherPage folderPickerSupported={true} />)
    await screen.findByTestId("launcher-project-p0")

    // Cards 0-3 are row 1, 4-7 row 2, 8-11 row 3. Same row ⇒ same tint,
    // and each row must differ from the one above it.
    expect(tintOf("p0")).toBe(tintOf("p3"))
    expect(tintOf("p4")).toBe(tintOf("p7"))
    expect(tintOf("p0")).not.toBe(tintOf("p4"))
    expect(tintOf("p4")).not.toBe(tintOf("p8"))

    // The grid must actually BE 4 columns here, or the row assertions above
    // are just describing whatever number the component happened to pick.
    const grid = screen.getByTestId("launcher-project-p0").closest("div.grid")
    expect(grid).toHaveStyle({ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" })
  })

  it("re-bands when the viewport changes the column count", async () => {
    // The assertion that catches the drift the single COLUMN_STEPS list
    // exists to prevent. At 2 columns p2 opens a new row, so it must differ
    // from p0 — while at 4 columns (above) p0-p3 all share row 1's tint.
    // A hardcoded column count passes one of these two and fails the other.
    window.innerWidth = 500
    render(<LauncherPage folderPickerSupported={true} />)
    await screen.findByTestId("launcher-project-p0")

    const grid = screen.getByTestId("launcher-project-p0").closest("div.grid")
    expect(grid).toHaveStyle({ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" })

    expect(tintOf("p0")).toBe(tintOf("p1"))
    expect(tintOf("p2")).not.toBe(tintOf("p0"))
  })

  it("clamps the tint on rows past the last step instead of cycling", async () => {
    window.innerWidth = 1280
    render(<LauncherPage folderPickerSupported={true} />)
    await screen.findByTestId("launcher-project-p0")

    // 14 cards at 4 columns is 4 rows, and there are 4 tint steps, so row 4
    // lands exactly on the last one: nothing clamps yet and row 4 must still
    // be its own tint. (Five steps until 2026-09-01, when the darkest was
    // dropped — these assertions hold either way, but the reason they hold
    // changed, so the comment did too.)
    expect(tintOf("p12")).not.toBe(tintOf("p8"))
    // The clamp itself: the deepest row must never return to row 1's tint.
    expect(tintOf("p12")).not.toBe(tintOf("p0"))
  })

  it("gets lighter down the page (each row's tint is a weaker teal)", async () => {
    window.innerWidth = 1280
    render(<LauncherPage folderPickerSupported={true} />)
    await screen.findByTestId("launcher-project-p0")

    // Every row is the same teal token at a decreasing alpha, so "lighter"
    // is literally a falling opacity. Reading the number back proves the
    // direction rather than trusting the order the constants were written in.
    const alpha = (name: string) => Number(tintOf(name).split("/")[1])
    const rows = [alpha("p0"), alpha("p4"), alpha("p8"), alpha("p12")]
    expect(rows).toEqual([...rows].sort((a, b) => b - a))
    expect(new Set(rows).size).toBe(rows.length)
  })
})

describe("project card actions reveal on hover", () => {
  /**
   * The card's "..." menu is hidden until its own card is hovered (Mo,
   * 2026-08-25), and the Viewer's project card does the same. Both pull the
   * class recipe from `HOVER_REVEAL` rather than spelling it out, so this
   * asserts the WIRING — that the button takes the recipe and that the
   * wrapper gives it a `group` to hang off. `HOVER_REVEAL`'s own clauses are
   * pinned in `blocks/hover-reveal.test.ts`.
   *
   * jsdom has no hover, so the visual behaviour itself is not assertable
   * here; it was verified live in the Viewer gallery, including the case
   * where the pointer leaves the card into the open menu.
   */
  beforeEach(() => {
    fetchMock.mockImplementation((input) => {
      const url = String(input)
      if (url.endsWith("/api/launcher/projects")) {
        return Promise.resolve(
          json(200, {
            ok: true,
            projects: [
              { path: "/repos/one", slug: "one", lastOpenedAt: new Date("2026-08-12T00:00:00Z").toISOString() },
            ],
          }),
        )
      }
      return Promise.resolve(json(404, { ok: false, reason: "unhandled in test" }))
    })
  })

  it("gives the menu the reveal recipe, and the card a group to reveal from", async () => {
    render(<LauncherPage folderPickerSupported={true} />)
    const menu = await screen.findByTestId("project-menu-one")

    expect(menu.className).toContain(HOVER_REVEAL)

    // The recipe is inert without an ancestor carrying `group` — that pairing
    // is the part a refactor breaks silently.
    expect(menu.closest(".group")).not.toBeNull()
  })
})

describe("trimPathToTail", () => {
  it("leaves a path that already fits alone", () => {
    const short = "/Users/mo/Documents/prototools"
    expect(trimPathToTail(short)).toBe(short)
  })

  it("keeps the IDENTIFYING tail, not the head", () => {
    // The exact failure this exists for. These two scratchpad paths share a
    // 64-character head and differ only in the last segment, so a head-first
    // truncation renders them identical on screen.
    const a =
      "/private/tmp/claude-501/-Users-mauricechang-Documents-desde/eaa32113-462e-4233-ab29-a91644c10a7e/scratchpad/fixture-vite-app"
    const b =
      "/private/tmp/claude-501/-Users-mauricechang-Documents-desde/eaa32113-462e-4233-ab29-a91644c10a7e/scratchpad/substrate-copy"
    expect(trimPathToTail(a)).toContain("fixture-vite-app")
    expect(trimPathToTail(b)).toContain("substrate-copy")
    expect(trimPathToTail(a)).not.toBe(trimPathToTail(b))
    expect(trimPathToTail(a)).toMatch(/^…\//)
  })

  it("respects the budget and cuts on segment boundaries", () => {
    const long = "/a/very/long/path/" + "segment/".repeat(20) + "project"
    const out = trimPathToTail(long, 40)
    expect(out.length).toBeLessThanOrEqual(40)
    // Every retained piece must be a whole segment: no "…gment/project".
    const retained = out.replace(/^…/, "").split("/").filter(Boolean)
    const original = long.split("/").filter(Boolean)
    expect(original.slice(-retained.length)).toEqual(retained)
  })

  it("returns an over-budget final segment whole rather than nothing", () => {
    // The one case the trim cannot serve. Returning "…" alone would erase the
    // only identifying text on the card, so the segment wins and the CSS
    // clamp becomes the backstop.
    const out = trimPathToTail("/x/" + "z".repeat(80), 40)
    expect(out).toContain("z".repeat(80))
  })
})

describe("project search", () => {
  const NOW = new Date("2026-08-13T00:00:00Z").toISOString()
  const PROJECTS = [
    { path: "/repos/alpha-app", slug: "alpha-app", lastOpenedAt: NOW },
    { path: "/repos/beta-app", slug: "beta-app", lastOpenedAt: NOW },
    { path: "/scratch/alpha-app", slug: "alpha-app", lastOpenedAt: NOW },
  ]

  beforeEach(() => {
    fetchMock.mockImplementation((input) =>
      String(input).endsWith("/api/launcher/projects")
        ? Promise.resolve(json(200, { ok: true, projects: PROJECTS }))
        : Promise.resolve(json(404, { ok: false, reason: "unhandled in test" })),
    )
  })

  it("filters by name", async () => {
    render(<LauncherPage folderPickerSupported={true} />)
    await screen.findByTestId("launcher-project-beta-app")

    fireEvent.change(screen.getByTestId("launcher-search"), {
      target: { value: "beta" },
    })
    expect(screen.getByTestId("launcher-project-beta-app")).toBeInTheDocument()
    expect(screen.queryAllByTestId(/^launcher-project-alpha-app/)).toHaveLength(0)
  })

  it("filters by PATH, not just name", async () => {
    // Two projects here share the name `alpha-app` and differ only by
    // directory. Name-only matching would make one of them unreachable.
    //
    // The count below reads `^launcher-project-`, so no OTHER testid may
    // start with it — the per-card settings gear is `open-project-settings-`
    // for exactly that reason, after `launcher-project-settings-` doubled
    // this number.
    render(<LauncherPage folderPickerSupported={true} />)
    await screen.findByTestId("launcher-project-beta-app")

    fireEvent.change(screen.getByTestId("launcher-search"), {
      target: { value: "/scratch/" },
    })
    expect(screen.queryAllByTestId(/^launcher-project-/)).toHaveLength(1)
    expect(screen.getByTestId("launcher-project-alpha-app")).toBeInTheDocument()
  })

  it("shows a no-match state that is not the create-a-project state", async () => {
    render(<LauncherPage folderPickerSupported={true} />)
    await screen.findByTestId("launcher-project-beta-app")

    fireEvent.change(screen.getByTestId("launcher-search"), {
      target: { value: "zzzz" },
    })
    expect(screen.getByText("No matching projects")).toBeInTheDocument()
    // The create tiles belong to the empty-list state and must NOT appear
    // here: an over-narrow filter is not an invitation to make a project.
    expect(screen.queryByTestId("launcher-empty-open-local")).not.toBeInTheDocument()

    fireEvent.click(screen.getByText("Clear search"))
    expect(screen.getByTestId("launcher-project-beta-app")).toBeInTheDocument()
  })

  it("hides the search box when there is nothing to search, but keeps New project", async () => {
    fetchMock.mockImplementation((input) =>
      String(input).endsWith("/api/launcher/projects")
        ? Promise.resolve(json(200, { ok: true, projects: [] }))
        : Promise.resolve(json(404, { ok: false, reason: "unhandled in test" })),
    )
    render(<LauncherPage folderPickerSupported={true} />)
    await screen.findByTestId("launcher-empty-open-local")

    expect(screen.queryByTestId("launcher-search")).not.toBeInTheDocument()
    expect(screen.getByTestId("launcher-new-project")).toBeInTheDocument()
  })
})

/**
 * Mo, 2026-09-02: "I clicked check for updates and nothing happened
 * afterwards." The click's only feedback was a toast, and this page mounted
 * no toast host, so on the launcher it rendered into nothing. The feedback
 * is a dialog now (an explicit action gets a modal), and the page mounts a
 * toast host for the notices that still are toasts.
 */
describe("LauncherPage — Check for updates", () => {
  afterEach(() => {
    delete (window as { desdeDesktop?: unknown }).desdeDesktop
  })

  function bridgeWithCheck(check: () => Promise<{ performed: boolean }>): DesktopBridge {
    return {
      appVersion: "0.1.1",
      updates: {
        getState: async () => ({ phase: "idle" }),
        onState: () => () => {},
        download: async () => {},
        restartAndInstall: () => {},
        checkForUpdates: check,
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
  }

  it("opens a dialog that shows the check running, then that the app is up to date", async () => {
    let settle: ((r: { performed: boolean }) => void) | undefined
    const check = vi.fn(() => new Promise<{ performed: boolean }>((resolve) => { settle = resolve }))
    ;(window as unknown as { desdeDesktop: DesktopBridge }).desdeDesktop = bridgeWithCheck(check)

    render(<LauncherPage folderPickerSupported={true} />)
    fireEvent.pointerDown(await screen.findByTestId("launcher-settings"), { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByTestId("desktop-update-check-now"))

    expect(check).toHaveBeenCalledTimes(1)
    const dialog = await screen.findByTestId("desktop-update-check-dialog")
    expect(dialog).toHaveAttribute("data-view", "checking")
    expect(screen.getByText("Checking for updates")).toBeInTheDocument()

    settle?.({ performed: true })
    await waitFor(() =>
      expect(screen.getByTestId("desktop-update-check-dialog")).toHaveAttribute("data-view", "up-to-date"),
    )
    expect(screen.getByText("Version 0.1.1 is the latest available.")).toBeInTheDocument()
  })

  it("mounts a toast host, so notices raised on this page have somewhere to render", async () => {
    render(<LauncherPage folderPickerSupported={true} />)
    await screen.findByText("Projects")
    act(() => {
      toast("A notice raised on the launcher")
    })
    expect(await screen.findByText("A notice raised on the launcher")).toBeInTheDocument()
  })
})
