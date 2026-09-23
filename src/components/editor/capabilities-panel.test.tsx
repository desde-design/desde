import { describe, expect, it, vi, beforeEach } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const fetchMock = vi.fn()
vi.mock("@/lib/editor-fetch", () => ({
  editorFetch: (...args: unknown[]) => fetchMock(...args),
}))

import { CapabilitiesPanel } from "./capabilities-panel"

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response
}

const FIGMA_OFF = {
  id: "figma",
  label: "Figma",
  summary: "Read Figma frames.",
  target: "mcp-extension" as const,
  activation: "next-message" as const,
  requiresEnv: "FIGMA_API_KEY",
  enabled: false,
  enableable: true,
  envReady: false,
  secretStored: false,
  secretFromEnvironment: false,
}

function listBody(over: Partial<Record<string, unknown>> = {}) {
  return {
    ok: true,
    configError: null,
    warnings: [],
    capabilities: [FIGMA_OFF],
    unknownExtensions: [],
    ...over,
  }
}

beforeEach(() => fetchMock.mockReset())

describe("CapabilitiesPanel", () => {
  it("lists a disabled capability with an Enable button", async () => {
    fetchMock.mockResolvedValue(jsonRes(listBody()))
    render(<CapabilitiesPanel open />)
    expect(await screen.findByText("Figma")).toBeInTheDocument()
    expect(screen.getByTestId("capability-enable-figma")).toBeInTheDocument()
  })

  it("posts only the capability id — never a spec", async () => {
    // The whole security posture: a command must never be expressible here.
    fetchMock.mockResolvedValue(jsonRes(listBody()))
    render(<CapabilitiesPanel open />)
    fireEvent.click(await screen.findByTestId("capability-enable-figma"))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/enable"))
      expect(call).toBeTruthy()
      const body = JSON.parse((call![1] as { body: string }).body) as Record<string, unknown>
      expect(Object.keys(body)).toEqual(["capabilityId"])
      expect(body.capabilityId).toBe("figma")
    })
  })

  it("says a capability is enabled-but-blocked, and offers the key form", async () => {
    // Config written, loader skipping it, nothing working. If this read the
    // same as plain "on", the user would be debugging silence.
    fetchMock.mockResolvedValue(
      jsonRes(listBody({ capabilities: [{ ...FIGMA_OFF, enabled: true, envReady: false }] })),
    )
    render(<CapabilitiesPanel open />)
    expect(await screen.findByText(/still needs an API key/i)).toBeInTheDocument()
    expect(screen.getByTestId("capability-key-figma")).toBeInTheDocument()
    // The env var is an implementation detail of where the key is stored. It
    // must not reach the reader — that was the whole point of the form.
    expect(screen.queryByText(/FIGMA_API_KEY/)).toBeNull()
    expect(screen.queryByText(/export /)).toBeNull()
  })

  it("saves a key through the form and never asks the reader about a variable", async () => {
    fetchMock.mockResolvedValue(
      jsonRes(listBody({ capabilities: [{ ...FIGMA_OFF, enabled: true, envReady: false }] })),
    )
    render(<CapabilitiesPanel open />)
    fireEvent.click(await screen.findByTestId("capability-key-figma"))

    // The dialog names the extension, not the variable it lands in.
    expect(await screen.findByText("Figma API key")).toBeInTheDocument()
    expect(screen.queryByText(/FIGMA_API_KEY/)).toBeNull()

    fireEvent.change(screen.getByTestId("extension-key-input"), {
      target: { value: "figd_secret" },
    })
    fireEvent.click(screen.getByTestId("extension-key-save"))

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (c) => String(c[0]).includes("/capabilities/secret"),
      )
      expect(post).toBeDefined()
      // The NAME travels, because the server allowlists on it. The value is
      // the thing the panel never learns back.
      expect(JSON.parse(String((post?.[1] as RequestInit)?.body))).toEqual({
        name: "FIGMA_API_KEY",
        value: "figd_secret",
      })
    })
  })

  it("shows a plain enabled capability as active, with no Enable button", async () => {
    fetchMock.mockResolvedValue(
      jsonRes(listBody({ capabilities: [{ ...FIGMA_OFF, enabled: true, envReady: true }] })),
    )
    render(<CapabilitiesPanel open />)
    expect(await screen.findByText("Active")).toBeInTheDocument()
    expect(screen.queryByTestId("capability-enable-figma")).toBeNull()
  })

  it("surfaces a malformed .mcp.json instead of rendering an empty panel", async () => {
    fetchMock.mockResolvedValue(
      jsonRes(listBody({ configError: "not valid JSON", capabilities: [] })),
    )
    render(<CapabilitiesPanel open />)
    expect(await screen.findByRole("alert")).toHaveTextContent(/no extensions can be turned on/i)
  })

  it("treats a 200 with the wrong shape as a failure, not as zero capabilities", async () => {
    // A catch-all route or a proxy answers 200 with anything. `res.ok` says
    // the request succeeded; it says nothing about the body.
    fetchMock.mockResolvedValue(jsonRes({ ok: true }))
    render(<CapabilitiesPanel open />)
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't load/i)
  })

  it("lists hand-written servers it does not curate", async () => {
    fetchMock.mockResolvedValue(jsonRes(listBody({ unknownExtensions: ["playwright"] })))
    render(<CapabilitiesPanel open />)
    expect(await screen.findByText("playwright")).toBeInTheDocument()
  })

  it("does not fetch while closed", () => {
    render(<CapabilitiesPanel open={false} />)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("offers no button for a capability that is a config edit", async () => {
    // Rendering Enable here would post to the MCP-only route and fail.
    fetchMock.mockResolvedValue(
      jsonRes(listBody({ capabilities: [{ ...FIGMA_OFF, id: "web-search", label: "Web search", enableable: false }] })),
    )
    render(<CapabilitiesPanel open />)
    expect(await screen.findByText("Set in config")).toBeInTheDocument()
    expect(screen.queryByTestId("capability-enable-web-search")).toBeNull()
  })
  it("does not nest the Enable button inside a button row", async () => {
    // ListRow defaults to a <button>; wrapping the Enable <button> in one is
    // invalid HTML and makes click/keyboard behaviour unreliable.
    fetchMock.mockResolvedValue(jsonRes(listBody()))
    render(<CapabilitiesPanel open />)
    const enable = await screen.findByTestId("capability-enable-figma")
    expect(enable.closest("button")).toBe(enable)
  })
  it("never labels a blocked capability Active", async () => {
    // It would contradict the setup instructions directly above it.
    fetchMock.mockResolvedValue(
      jsonRes(listBody({ capabilities: [{ ...FIGMA_OFF, enabled: true, envReady: false }] })),
    )
    render(<CapabilitiesPanel open />)
    // "Needs setup" as a label is replaced by the action that fixes it when
    // the block is a missing key, which is the only blocked case today.
    expect(await screen.findByTestId("capability-key-figma")).toBeInTheDocument()
    expect(screen.queryByText("Active")).toBeNull()
  })
})

