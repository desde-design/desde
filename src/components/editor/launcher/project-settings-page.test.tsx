import { describe, expect, it, vi, beforeEach } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { ProjectSettingsPage } from "./project-settings-page"

const PATH = "/Users/designer/prototypes/acme"

function settingsBody(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    path: PATH,
    name: "acme",
    designSystems: [
      {
        identity: "@acme/design-system",
        declaration: { source: { kind: "package", spec: "@acme/design-system" } },
      },
    ],
    readRoots: [{ name: "billing-web", path: "/repos/billing-web", description: "" }],
    warnings: [],
    ...over,
  }
}

function jsonRes(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})

function renderPage(onClose = vi.fn()) {
  render(
    <ProjectSettingsPage
      path={PATH}
      onClose={onClose}
      onInspectReadRoot={vi.fn(async () => null)}
    />,
  )
  return onClose
}

describe("ProjectSettingsPage", () => {
  it("shows every section at once on All, and filters to one on a tab", async () => {
    fetchMock.mockResolvedValue(jsonRes(settingsBody()))
    renderPage()

    // The default tab is a document: all three sections, each in its own box.
    expect(await screen.findByTestId("settings-section-general")).toBeInTheDocument()
    expect(screen.getByTestId("settings-section-design-systems")).toBeInTheDocument()
    expect(screen.getByTestId("settings-section-reference-dirs")).toBeInTheDocument()

    // Radix Tabs activate on mouseDown, not click.
    fireEvent.mouseDown(screen.getByTestId("settings-tab-design-systems"), { button: 0 })
    await waitFor(() => {
      expect(screen.queryByTestId("settings-section-general")).toBeNull()
    })
    expect(screen.getByTestId("settings-section-design-systems")).toBeInTheDocument()
    expect(screen.queryByTestId("settings-section-reference-dirs")).toBeNull()
  })

  it("says which sections save as you go, so the footer never implies a transaction it lacks", async () => {
    fetchMock.mockResolvedValue(jsonRes(settingsBody()))
    renderPage()

    const designSystems = await screen.findByTestId("settings-section-design-systems")
    expect(designSystems).toHaveTextContent(/save as you make them/i)
    // General does NOT say it, because it is the half the footer's Save owns.
    expect(screen.getByTestId("settings-section-general")).not.toHaveTextContent(
      /save as you make them/i,
    )
  })

  it("keeps Save disabled until the name actually changes", async () => {
    fetchMock.mockResolvedValue(jsonRes(settingsBody()))
    renderPage()

    const save = await screen.findByTestId("settings-save")
    expect(save).toBeDisabled()

    fireEvent.change(screen.getByTestId("settings-project-name"), {
      target: { value: "acme console" },
    })
    expect(save).toBeEnabled()
  })

  it("posts the rename to the launcher API and re-reads", async () => {
    fetchMock.mockResolvedValue(jsonRes(settingsBody()))
    renderPage()

    await screen.findByTestId("settings-project-name")
    fireEvent.change(screen.getByTestId("settings-project-name"), {
      target: { value: "acme console" },
    })
    fireEvent.click(screen.getByTestId("settings-save"))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) =>
        String(c[0]).includes("/api/launcher/project-name"),
      )
      expect(call).toBeDefined()
      expect(JSON.parse(String((call?.[1] as RequestInit)?.body))).toEqual({
        path: PATH,
        name: "acme console",
      })
    })
  })

  it("reads Done, not Cancel, while nothing is staged", async () => {
    // Calling it Cancel on a page with nothing pending would promise to undo
    // the design system that was already removed from disk.
    fetchMock.mockResolvedValue(jsonRes(settingsBody()))
    renderPage()

    expect(await screen.findByText("Done")).toBeInTheDocument()
    fireEvent.change(screen.getByTestId("settings-project-name"), {
      target: { value: "renamed" },
    })
    expect(screen.getByText("Cancel")).toBeInTheDocument()
  })

  it("removes a design system by identity, not by label", async () => {
    fetchMock.mockResolvedValue(jsonRes(settingsBody()))
    renderPage()

    await screen.findByTestId("settings-section-design-systems")
    fireEvent.pointerDown(
      screen.getByTestId("design-system-row-menu-@acme/design-system"),
      { button: 0, ctrlKey: false },
    )
    // Scoped by role: the reference-folders section below has its own
    // "Remove" button, so a bare text query matches two things.
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) =>
        String(c[0]).includes("/design-systems/remove"),
      )
      expect(call).toBeDefined()
      expect(JSON.parse(String((call?.[1] as RequestInit)?.body))).toEqual({
        path: PATH,
        identity: "@acme/design-system",
      })
    })
  })

  it("surfaces a malformed config instead of rendering an empty page", async () => {
    // The page's whole job in this state is to let someone fix the broken
    // half, so the other sections must still render.
    fetchMock.mockResolvedValue(
      jsonRes(
        settingsBody({
          designSystems: [],
          warnings: ['desde.config.json: "designSystems" must be an array'],
        }),
      ),
    )
    renderPage()

    expect(await screen.findByTestId("project-settings-warnings")).toHaveTextContent(
      /must be an array/,
    )
    expect(screen.getByTestId("settings-section-reference-dirs")).toBeInTheDocument()
  })

  it("reports a failed read rather than spinning forever", async () => {
    fetchMock.mockResolvedValue(jsonRes({ ok: false, reason: "Directory not found" }, 400))
    renderPage()

    expect(await screen.findByTestId("project-settings-error")).toHaveTextContent(
      "Directory not found",
    )
    expect(screen.queryByText(/Reading this project/i)).toBeNull()
  })
})
