/**
 * `useEditorParticipants` — the Editor's @-mention directory.
 *
 * The URL is worth pinning. It has to go through the CLI's viewer proxy,
 * which forwards ONLY `/api/editor/viewer` + `/api/v1/projects/<configured>/**`
 * and 403s anything else. A wrong path here fails the way the whole mention
 * defect failed: quietly, as a `console.warn` and an empty picker.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { useEditorParticipants } from "./useEditorParticipants"

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function ok(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body } as Response)
}

describe("useEditorParticipants", () => {
  it("reads the prototype's directory through the CLI's viewer proxy", async () => {
    fetchMock.mockReturnValueOnce(
      ok({
        participants: [
          { id: "p_rin", displayName: "Rin Adeyemi", email: "rin@example.com", status: "active" },
        ],
      }),
    )
    const { result } = renderHook(() => useEditorParticipants("proj_1"))

    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/editor/viewer/api/v1/projects/proj_1/participants",
    )
    expect(result.current[0]).toMatchObject({ id: "p_rin", displayName: "Rin Adeyemi" })
  })

  it("makes no request at all on a local-only repo", async () => {
    const { result } = renderHook(() => useEditorParticipants(null))
    await waitFor(() => expect(result.current).toEqual([]))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("encodes the project id rather than splicing it into the path", async () => {
    fetchMock.mockReturnValueOnce(ok({ participants: [] }))
    renderHook(() => useEditorParticipants("a/../b"))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    // The proxy rejects dot segments in every spelling, so a raw id would
    // turn a directory load into a 403 the user never sees.
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/editor/viewer/api/v1/projects/a%2F..%2Fb/participants",
    )
  })

  it("keeps rows whose email was redacted for a non-insider", async () => {
    fetchMock.mockReturnValueOnce(
      ok({ participants: [{ id: "p_sam", displayName: "Sam Okafor", status: "active" }] }),
    )
    const { result } = renderHook(() => useEditorParticipants("proj_1"))
    await waitFor(() => expect(result.current).toHaveLength(1))
  })

  it("drops malformed rows instead of handing them to the picker", async () => {
    fetchMock.mockReturnValueOnce(
      ok({
        participants: [
          { id: "p_ok", displayName: "Fine" },
          { id: 7, displayName: "Bad id" },
          { displayName: "No id" },
          { id: "p_bad_email", displayName: "Bad", email: 42 },
          "not an object",
        ],
      }),
    )
    const { result } = renderHook(() => useEditorParticipants("proj_1"))
    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(result.current[0].id).toBe("p_ok")
  })

  it("reports an empty directory rather than throwing when the load fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    fetchMock.mockReturnValueOnce(Promise.resolve({ ok: false, status: 401 } as Response))
    const { result } = renderHook(() => useEditorParticipants("proj_1"))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(result.current).toEqual([])
  })

  it("clears the directory when the repo stops being linked", async () => {
    fetchMock.mockReturnValueOnce(
      ok({ participants: [{ id: "p_rin", displayName: "Rin Adeyemi" }] }),
    )
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useEditorParticipants(id),
      { initialProps: { id: "proj_1" as string | null } },
    )
    await waitFor(() => expect(result.current).toHaveLength(1))

    rerender({ id: null })
    await waitFor(() => expect(result.current).toEqual([]))
  })
})
