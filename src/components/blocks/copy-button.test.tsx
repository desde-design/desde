// @vitest-environment jsdom

/**
 * `CopyButton` — the success state, and the one way it could lie.
 *
 * The interesting case is not "does it copy". It is what the label says after
 * the `value` underneath it changes: `members-panel.tsx` swaps one one-time
 * secret for another in place (regenerate an invite, or create a second one),
 * so a button parked on "Copied" would be claiming the clipboard holds a
 * string it does not. The three hand-rolled buttons this block replaced each
 * reset their own `copyOk` at those call sites; the block has to do it for
 * them or the extraction is a regression.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { CopyButton } from "./copy-button"

const writeText = vi.fn<(v: string) => Promise<void>>()

beforeEach(() => {
  writeText.mockReset()
  writeText.mockResolvedValue(undefined)
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  })
})

afterEach(() => {
  cleanup()
})

describe("CopyButton", () => {
  it("writes the value and flips the label to Copied", async () => {
    render(<CopyButton value="dsv_secret" />)
    await act(async () => {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /copy/i }))
      })
    })

    await waitFor(() => expect(screen.getByRole("button", { name: /copied/i })).toBeTruthy())
    expect(writeText).toHaveBeenCalledWith("dsv_secret")
  })

  it("does NOT claim success when the clipboard write rejects", async () => {
    writeText.mockRejectedValue(new Error("not allowed"))
    render(<CopyButton value="dsv_secret" />)
    await act(async () => {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /copy/i }))
      })
    })

    await waitFor(() => expect(writeText).toHaveBeenCalled())
    // Still offering the action, never "Copied" over a write that failed.
    expect(screen.getByRole("button", { name: /^copy$/i })).toBeTruthy()
  })

  it("drops the success state when the value changes underneath it", async () => {
    const { rerender } = render(<CopyButton value="invite-a" />)
    await act(async () => {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /copy/i }))
      })
    })
    await waitFor(() => expect(screen.getByRole("button", { name: /copied/i })).toBeTruthy())

    // The surface reveals a DIFFERENT secret without unmounting the button.
    rerender(<CopyButton value="invite-b" />)

    // The clipboard holds invite-a, so the label must stop saying "Copied".
    expect(screen.getByRole("button", { name: /^copy$/i })).toBeTruthy()
    expect(screen.queryByRole("button", { name: /copied/i })).toBeNull()
  })

  it("expires the success state so the button goes back to offering the action", async () => {
    // Real timers with a tiny window, not `vi.useFakeTimers()`: the success
    // state is set after an awaited clipboard promise, and driving fake
    // timers across that microtask boundary updates state outside React's
    // `act` scope. A 20ms wait proves the same thing without the warning.
    render(<CopyButton value="dsv_secret" resetAfterMs={20} />)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /copy/i }))
    })
    expect(screen.getByRole("button", { name: /copied/i })).toBeTruthy()

    await waitFor(() => expect(screen.getByRole("button", { name: /^copy$/i })).toBeTruthy())
  })
})
