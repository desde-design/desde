import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, createEvent, fireEvent, render, screen } from "@testing-library/react"

// The panel mounts `useEditorCapabilities(false)` (action-only, no fetch) and
// nothing else in this file talks to the CLI. Mocked anyway so an accidental
// call fails loudly instead of hitting an undefined global.
vi.mock("@/lib/editor-fetch", () => ({
  editorFetch: vi.fn(),
}))

import { EditorChatPanel } from "./editor-chat-panel"
import type { UseEditorChatReturn } from "@/hooks/useEditorChat"

/**
 * Composer behaviour while a turn is streaming.
 *
 * assistant-ui refuses to send mid-turn in three places, all gated on
 * `thread.capabilities.queue`, which `useExternalStoreRuntime` hard-codes to
 * false. The panel routes around it with an `onKeyDown` that intercepts plain
 * Enter and an always-mounted Send button calling the imperative
 * `composer.send()`. These tests drive the REAL primitives — no library mock —
 * so a version bump that moves the interception seam fails here rather than in
 * the product.
 *
 * `chat.submitting` is what the runtime adapter reports as `isRunning`, so it
 * is the single switch between the two states under test.
 */

function makeChat(overrides: Partial<UseEditorChatReturn> = {}) {
  return {
    messages: [],
    submitting: false,
    error: null,
    submit: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    resendingSteers: [],
    abort: vi.fn(),
    clearLocal: vi.fn(),
    dismissMessage: vi.fn(),
    hydrateFromTranscript: vi.fn(),
    hasSessionBucket: vi.fn(() => false),
    modelConfig: null,
    setModelConfig: vi.fn(),
    seedModelConfig: vi.fn(),
    ...overrides,
  } as unknown as UseEditorChatReturn
}

function renderPanel(chat: UseEditorChatReturn) {
  render(<EditorChatPanel chat={chat} />)
  return screen.getByTestId("editor-chat-input") as HTMLTextAreaElement
}

/**
 * Type into the composer. `fireEvent.change` is what reaches the primitive's
 * controlled `onChange` -> `composer.setText`; assigning `.value` directly
 * would leave the composer's own state empty and make every send a silent
 * no-op the assertions could not tell apart from a blocked one.
 */
function type(input: HTMLTextAreaElement, text: string) {
  fireEvent.change(input, { target: { value: text } })
}

/**
 * Run an interaction and let the composer finish reacting to it.
 *
 * Two separate delays are being drained here, which is why a bare
 * `await act(async () => …)` is not enough:
 *   - `BaseComposerRuntimeCore.send()` awaits its attachment list before
 *     calling `handleSend`, so the append (and our `onNew` -> submit/steer)
 *     lands a microtask after the event.
 *   - clearing the draft propagates through the store's own scheduler, which
 *     MEASURED needs a macrotask to reach React on the imperative-send path.
 *     (It settles within the same act on the form-submit path — a harness
 *     scheduling difference, not a product one.)
 *
 * Without this drain a "was not called" assertion passes for the wrong
 * reason: it observes the gap, never the behaviour.
 */
async function settle(interact: () => void) {
  await act(async () => {
    interact()
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/**
 * Dispatch a keydown and hand back the event so a test can read
 * `defaultPrevented`.
 *
 * `defaultPrevented` is the honest instrument for the stray-newline
 * regression. jsdom does not implement the browser's default text-editing
 * behaviour for key events, so it never inserts the newline that a real
 * browser would — asserting on `input.value` alone could not distinguish a
 * fixed handler from a broken one. What the value CAN show is that our
 * handler did not leave a newline behind on its own, so both are asserted:
 * `defaultPrevented` proves the browser's insertion is suppressed (and, by
 * `composeEventHandlers`' contract, that the library's swallowing handler was
 * skipped), and the empty value proves nothing was stranded in the draft.
 */
function pressKey(
  input: HTMLTextAreaElement,
  init: { key: string; shiftKey?: boolean; isComposing?: boolean },
): KeyboardEvent {
  return createEvent.keyDown(input, init) as KeyboardEvent
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("EditorChatPanel composer — while a turn is running", () => {
  it("submits on Enter and leaves NO stray newline", async () => {
    const chat = makeChat({ submitting: true })
    const input = renderPanel(chat)

    type(input, "second thought")
    const event = pressKey(input, { key: "Enter" })
    await settle(() => fireEvent(input, event))

    expect(chat.steer).toHaveBeenCalledTimes(1)
    expect(chat.steer).toHaveBeenCalledWith("second thought", undefined)
    // The regression: drop `preventDefault()` from our handler and the
    // library's own handler runs, returns early on the queue gate, and
    // neither submits nor prevents the default — so a real browser inserts a
    // newline into the textarea the send just cleared.
    expect(event.defaultPrevented).toBe(true)
    expect(input.value).toBe("")
  })

  it("inserts a newline on Shift+Enter and does not submit", async () => {
    const chat = makeChat({ submitting: true })
    const input = renderPanel(chat)

    type(input, "line one")
    const event = pressKey(input, { key: "Enter", shiftKey: true })
    await settle(() => fireEvent(input, event))

    expect(chat.steer).not.toHaveBeenCalled()
    expect(chat.submit).not.toHaveBeenCalled()
    // Default left alone => the browser owns the newline, which is the only
    // way a newline can be inserted at all.
    expect(event.defaultPrevented).toBe(false)
    expect(input.value).toBe("line one")
  })

  it("does not submit on Enter during IME composition", async () => {
    const chat = makeChat({ submitting: true })
    const input = renderPanel(chat)

    type(input, "にほん")
    // `isComposing` lives on the native event; createEvent forwards it.
    const event = pressKey(input, { key: "Enter", isComposing: true })
    await settle(() => fireEvent(input, event))

    expect(chat.steer).not.toHaveBeenCalled()
    expect(chat.submit).not.toHaveBeenCalled()
    // The default must reach the IME so Enter commits the candidate.
    expect(event.defaultPrevented).toBe(false)
    expect(input.value).toBe("にほん")
  })

  it("renders Send and Stop together", () => {
    renderPanel(makeChat({ submitting: true }))

    expect(screen.getByTestId("editor-chat-submit")).toBeInTheDocument()
    expect(screen.getByTestId("editor-chat-stop")).toBeInTheDocument()
  })

  it("keeps Send clickable, not the disabled primitive", async () => {
    const chat = makeChat({ submitting: true })
    const input = renderPanel(chat)

    type(input, "steer me")
    const send = screen.getByTestId("editor-chat-submit")
    // `ComposerPrimitive.Send` would be disabled here: `useComposerSend` adds
    // `|| (isRunning && !capabilities.queue)` and queue is false for us.
    expect(send).not.toBeDisabled()

    await settle(() => fireEvent.click(send))
    expect(chat.steer).toHaveBeenCalledWith("steer me", undefined)
  })

  it("disables Send on an empty draft", () => {
    renderPanel(makeChat({ submitting: true }))
    expect(screen.getByTestId("editor-chat-submit")).toBeDisabled()
  })

  it("Stop aborts the turn", async () => {
    const chat = makeChat({ submitting: true })
    renderPanel(chat)

    await settle(() => fireEvent.click(screen.getByTestId("editor-chat-stop")))
    expect(chat.abort).toHaveBeenCalledTimes(1)
  })
})

describe("EditorChatPanel composer — while idle", () => {
  it("submits on Enter through the library's own path, exactly once", async () => {
    const chat = makeChat({ submitting: false })
    const input = renderPanel(chat)

    type(input, "first message")
    await settle(() => fireEvent.keyDown(input, { key: "Enter" }))

    // Our handler returns before touching the event when idle, so this is the
    // library's `requestSubmit()` -> form onSubmit -> send. Exactly one send:
    // a handler that also ran when idle would double-fire here.
    expect(chat.submit).toHaveBeenCalledTimes(1)
    expect(chat.submit).toHaveBeenCalledWith("first message", undefined)
    expect(chat.steer).not.toHaveBeenCalled()
    expect(input.value).toBe("")
  })

  it("leaves Shift+Enter to the library and does not submit", async () => {
    const chat = makeChat({ submitting: false })
    const input = renderPanel(chat)

    type(input, "line one")
    const event = pressKey(input, { key: "Enter", shiftKey: true })
    await settle(() => fireEvent(input, event))

    expect(chat.submit).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
    expect(input.value).toBe("line one")
  })

  it("shows Send without Stop", () => {
    renderPanel(makeChat({ submitting: false }))

    expect(screen.getByTestId("editor-chat-submit")).toBeInTheDocument()
    expect(screen.queryByTestId("editor-chat-stop")).not.toBeInTheDocument()
  })

  it("clicking Send submits once", async () => {
    const chat = makeChat({ submitting: false })
    const input = renderPanel(chat)

    type(input, "click me")
    await settle(() =>
      fireEvent.click(screen.getByTestId("editor-chat-submit")),
    )

    // `type="button"`, not `type="submit"`: inside ComposerPrimitive.Root's
    // <form> a submit-typed button would fire the form's own send as well and
    // deliver the message twice.
    expect(chat.submit).toHaveBeenCalledTimes(1)
    expect(chat.submit).toHaveBeenCalledWith("click me", undefined)
  })
})

/**
 * The resend indicator.
 *
 * When a turn is stopped with a steered message unaccounted for, the client
 * resubmits it, and the first attempt normally 409s on the server's still-held
 * turn lock. Measured live, the whole recovery took about 25 seconds and the
 * panel showed nothing for any of it — long enough that the person watching
 * concluded the message had been lost. These tests pin the row that says
 * otherwise.
 */
describe("EditorChatPanel — resending steers", () => {
  it("renders nothing when no steer is being resent", () => {
    renderPanel(makeChat({ resendingSteers: [] }))

    expect(screen.queryByTestId("chat-resending-steers")).not.toBeInTheDocument()
  })

  it("renders a spinner row naming the message being resent", () => {
    renderPanel(
      makeChat({
        resendingSteers: [
          { id: "s1", text: "Actually make it 12px", attempt: 1 },
        ],
      }),
    )

    const row = screen.getByTestId("chat-resending-steer")
    expect(row).toHaveTextContent("Actually make it 12px")
    // The copy claims only what the client can know. It must NOT say the turn
    // was stopped, nor that the message never reached the agent: the sweep
    // also fires on stream death and network failure, and on one recorded
    // network failure the message had already been delivered.
    expect(row).toHaveTextContent(
      "The previous turn ended before this could be confirmed",
    )
    expect(row.textContent).not.toContain("stopped")
    expect(row.textContent).not.toContain("reached the agent")
    // Exact, because `toHaveTextContent` normalises whitespace and would not
    // notice the stray space JSX leaves before a `.` that starts its own line.
    expect(row.textContent).toBe(
      "Resending “Actually make it 12px”. The previous turn ended before this could be confirmed.",
    )
    // Informational, not a failure: `role="status"` rather than the Alert
    // primitive's default `role="alert"`, so it does not interrupt.
    expect(row).toHaveAttribute("role", "status")
    // The spinner is the whole point — a static row reads as a dead end.
    expect(row.querySelector(".animate-spin")).not.toBeNull()
    // Not dismissible: it clears itself, and a control to hide it would offer
    // the user a way to hide the only evidence their message survived.
    expect(row.querySelector("button")).toBeNull()
  })

  it("shows the attempt number only once a retry has happened", () => {
    const { rerender } = render(
      <EditorChatPanel
        chat={makeChat({
          resendingSteers: [{ id: "s1", text: "one", attempt: 1 }],
        })}
      />,
    )
    // Attempt 1 is the common case and says nothing worth reading.
    expect(screen.getByTestId("chat-resending-steer")).not.toHaveTextContent(
      "Attempt",
    )

    rerender(
      <EditorChatPanel
        chat={makeChat({
          resendingSteers: [{ id: "s1", text: "one", attempt: 3 }],
        })}
      />,
    )
    expect(screen.getByTestId("chat-resending-steer")).toHaveTextContent(
      "Attempt 3.",
    )
  })

  it("renders one row per steer being resent", () => {
    renderPanel(
      makeChat({
        resendingSteers: [
          { id: "s1", text: "one", attempt: 1 },
          { id: "s2", text: "two", attempt: 2 },
        ],
      }),
    )

    expect(screen.getAllByTestId("chat-resending-steer")).toHaveLength(2)
  })

  it("truncates a long message inline and keeps the full text on hover", () => {
    const long =
      "Please leave the hero button completely alone, I only ever meant the pricing cards on the marketing page"
    renderPanel(makeChat({ resendingSteers: [{ id: "s1", text: long, attempt: 1 }] }))

    const quoted = screen.getByTitle(long)
    expect(quoted.textContent?.length).toBeLessThan(long.length)
    expect(quoted.textContent).toContain("Please leave the hero button")
  })
})
