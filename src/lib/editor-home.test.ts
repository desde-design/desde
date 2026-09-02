import { afterEach, describe, expect, it, vi } from "vitest"

const fetchMock = vi.fn()
vi.mock("@/lib/editor-fetch", () => ({
  editorFetch: (...args: unknown[]) => fetchMock(...args),
}))
const navigateMock = vi.fn(async (_url: string) => {})
vi.mock("@/lib/top-level-navigate", () => ({
  navigateTopLevel: (url: string) => navigateMock(url),
}))

import { goToEditorHome } from "./editor-home"

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/**
 * The breadcrumb's Home is a cross-origin hop to a launcher on a port this
 * page has never seen. It must leave through `navigateTopLevel`, the one
 * path that vouches for the destination to the desktop shell first; a bare
 * `location.href` assignment here is what sent the packaged app to a browser
 * tab (MEASURED 2026-09-01).
 */
describe("goToEditorHome", () => {
  afterEach(() => {
    fetchMock.mockReset()
    navigateMock.mockClear()
  })

  it("resolves the launcher URL from the CLI and leaves through navigateTopLevel", async () => {
    fetchMock.mockResolvedValue(json(200, { ok: true, url: "http://127.0.0.1:4321" }))
    await goToEditorHome()
    expect(fetchMock).toHaveBeenCalledWith("/api/editor/home")
    expect(navigateMock).toHaveBeenCalledWith("http://127.0.0.1:4321")
  })

  it("throws the CLI's reason, and does not navigate, when home is unavailable", async () => {
    fetchMock.mockResolvedValue(json(500, { ok: false, reason: "Couldn't start the projects launcher: boom" }))
    await expect(goToEditorHome()).rejects.toThrow("Couldn't start the projects launcher: boom")
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it("falls back to a status-bearing message when the body has no reason", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 503 }))
    await expect(goToEditorHome()).rejects.toThrow("Couldn't open the projects home (503).")
    expect(navigateMock).not.toHaveBeenCalled()
  })
})
