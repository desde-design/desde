"use client"

/**
 * The editor chat panel — assistant-ui based.
 *
 * External surfaces:
 *   - ChatSessionMenu slot (session bar) renders above the message body.
 *   - The current selection renders as a removable badge in the input bar
 *     (right of the + button), not a separate header — clearing it calls
 *     `onClearSelection`.
 *   - Status banners (error, queued, overwrite_warning, rate_limit_warning,
 *     api_retry) render OUTSIDE the thread, just above the input.
 *
 * The message body is the assistant-ui thread (EditorChatThread inside
 * AssistantRuntimeProvider). The input is now assistant-ui's stock
 * `ComposerPrimitive` — submission flows through the runtime adapter
 * (`useEditorChatRuntime`'s `onNew` → `chat.submit`, `onCancel` →
 * `chat.abort`), so the bespoke textarea + Send/Stop + ⌘Enter footer is
 * gone. Per-session draft persistence is preserved by mirroring the
 * Editor's text into the session-keyed draft cache (`EditorDraftSync`).
 *
 * Keybinding: stock ComposerPrimitive sends on Enter (Shift+Enter = newline).
 * Mid-turn, that keybinding is ours instead — see MID_TURN_SEND below.
 *
 * A failure is ONE banner, in that same status row, and it is dismissible.
 * There used to be a second: this panel rendered `chat.error` in a bare div
 * of its own, so an HTTP failure (which sets both an `error` message and
 * `chat.error`) drew two banners saying the same thing, only one of which
 * could be dismissed. Every failure path now appends a message instead.
 */

// NOTE: `ComposerPrimitive` / `useComposerRuntime` keep the Editor name on
// purpose — they are assistant-ui's own export names for its message-editor
// widget, unrelated to this product's former name. Renaming them would just
// break the import.
import { memo, useCallback, useEffect, useMemo, useState } from "react"
import {
  AssistantRuntimeProvider,
  AttachmentPrimitive,
  ComposerPrimitive,
  ThreadPrimitive,
  useAttachment,
  useAuiState,
  useComposerRuntime,
} from "@assistant-ui/react"
import { ArrowUp, Loader2, Plus, StopCircle, X } from "lucide-react"
import { Alert } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { editorFetch } from "@/lib/editor-fetch"
import { useEditorChatRuntime } from "@/hooks/useEditorChatRuntime"
import { ChatStatusBanners } from "@/components/editor/chat-status-banners"
import { useEditorCapabilities } from "@/hooks/useEditorCapabilities"
import { EditorChatThread } from "@/components/editor/chat-thread"
import { EditToolUI, WriteToolUI } from "@/components/editor/chat-tool-ui"
import type { Selection } from "@/editor/core/selection"
import type {
  ChatMessage,
  ResendingSteer,
  UseEditorChatReturn,
} from "@/hooks/useEditorChat"
import type { ChatSessionDraftCache } from "@/hooks/useChatSessionDraftCache"

export interface EditorChatPanelProps {
  chat: UseEditorChatReturn
  /**
   * Current selection — surfaced as a removable badge in the input bar.
   * Pass null when nothing is selected (the badge is hidden).
   */
  selection?: Selection | null
  /**
   * Phase 6 — additional selections alongside `selection`. When this
   * array is non-empty the badge shows "N selected" instead of the
   * single-component name.
   */
  selectionMany?: Selection[]
  /**
   * Clear the current selection — invoked by the input-bar badge's ×.
   * Optional: when omitted the badge renders without a remove affordance.
   */
  onClearSelection?: () => void
  /**
   * Session bar rendered above the message body. The caller composes a
   * `<ChatSessionMenu>` (or omits it for surfaces that don't need
   * detached-session switching: test harnesses, legacy mode). When
   * supplied alongside `currentSessionId` + `draftCache`, the panel
   * scopes its editor draft to the active session so switching
   * chats preserves what the user was typing.
   */
  tabs?: React.ReactNode
  /**
   * Active sessionId for per-session draft scoping. null means
   * "new chat" (no session yet — next submit mints one). When
   * omitted the panel falls back to the stock Editor's single
   * draft shared across all sessions (legacy single-chat surfaces).
   */
  currentSessionId?: string | null
  /**
   * Per-session draft cache; required alongside `currentSessionId`.
   * The Editor's text is mirrored into / out of this cache keyed by
   * `currentSessionId` (see EditorDraftSync) so the value survives
   * session switches. See useChatSessionDraftCache.
   */
  draftCache?: ChatSessionDraftCache
  /**
   * Model picker chip rendered in the editor action row (left of the
   * selection badge). Injected by the right rail so the panel stays
   * decoupled from catalog fetching + chat-hook state.
   */
  modelPicker?: React.ReactNode
  className?: string
}

function EditorChatPanelImpl({
  chat,
  selection,
  selectionMany,
  onClearSelection,
  tabs,
  currentSessionId,
  draftCache,
  modelPicker,
  className,
}: EditorChatPanelProps) {
  const { runtime } = useEditorChatRuntime(chat)

  // Selection badge shown in the input bar (right of the + button). Hidden
  // when nothing is selected. Multi-select collapses to "N selected".
  const selectionBadge = describeSelection(selection, selectionMany)

  // Enabling a capability straight from the inline gap banner. `false` — the
  // panel's own fetch is not wanted here; we only need the action.
  const { enable: enableCapability } = useEditorCapabilities(false)

  // Fetch model catalog to get the active provider's capabilities
  const [catalog, setCatalog] = useState<Array<{ providerId: string; capabilities?: { vendorRateLimitEvents?: boolean } }> | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await editorFetch("/api/editor/chat/model-catalog")
        if (!res.ok) return
        const body = await res.json()
        if (!body || !Array.isArray(body.catalogs)) return
        if (!cancelled) setCatalog(body.catalogs)
      } catch {
        // Catalog unavailable — pass true (default) so banners render unchanged
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Extract vendorRateLimitEvents from the active provider's capabilities
  // Defaults to true when catalog hasn't loaded yet (safe default)
  const vendorRateLimitEvents = (() => {
    if (!catalog || !chat.modelConfig) return true
    const entry = catalog.find(c => c.providerId === chat.modelConfig!.provider)
    return entry?.capabilities?.vendorRateLimitEvents ?? true
  })()


  // Conversational messages (user + assistant) for the runtime.
  // Status messages are rendered by ChatStatusBanners below the thread.
  const hasConversation = chat.messages.some(
    (m) => m.kind === "user" || m.kind === "assistant",
  )

  // Live phase label for the working indicator — derived from the latest
  // in-flight tool call so the user sees "Editing App.vue…" rather than a
  // generic spinner. Only consulted while the runtime is running.
  const workingLabel = chat.submitting
    ? deriveWorkingLabel(chat.messages)
    : undefined

  return (
    <section
      className={cn("flex h-full min-h-0 flex-col", className)}
      data-testid="editor-chat-panel"
    >
      {tabs}

      {/* Everything below the session bar lives inside the runtime provider so
          the stock Editor input can mount even before the first message. */}
      <AssistantRuntimeProvider runtime={runtime}>
        {/* Tool UI registrations — render null, register via context */}
        <EditToolUI />
        <WriteToolUI />
        {/* Mirror the Editor's text into the per-session draft cache.
            Only when a cache is supplied (detached chat sessions enabled);
            legacy surfaces let the stock Editor hold its own single draft. */}
        {draftCache ? (
          <EditorDraftSync
            sessionId={currentSessionId ?? null}
            cache={draftCache}
          />
        ) : null}

        {/* -------------------------------------------------------------- */}
        {/* Message body — assistant-ui thread                             */}
        {/* -------------------------------------------------------------- */}
        <div
          className="min-h-0 flex-1 overflow-hidden"
          data-testid="editor-chat-messages"
        >
          {hasConversation ? (
            <EditorChatThread workingLabel={workingLabel} />
          ) : (
            <div className="py-2">
              <EmptyState />
            </div>
          )}
        </div>

        {/* -------------------------------------------------------------- */}
        {/* Footer — status banners + stock Editor input                 */}
        {/* -------------------------------------------------------------- */}
        <footer className="shrink-0 pt-2 pb-4">
          {/* Status banners sit just above the input, outside the thread */}
          <ChatStatusBanners
            messages={chat.messages}
            onDismiss={chat.dismissMessage}
            onEnableCapability={enableCapability}
            vendorRateLimitEvents={vendorRateLimitEvents}
          />
          <ResendingSteerRows steers={chat.resendingSteers} />

          {/* Dropzone wraps the input so dragging an image anywhere over
              the editor attaches it. Paste (⌘V) is handled by the stock
              Input once the attachment adapter is configured. */}
          <ComposerPrimitive.AttachmentDropzone className="rounded-lg [&[data-dragging=true]]:ring-2 [&[data-dragging=true]]:ring-ring">
            {/*
            `bg-card`, not `bg-background`: the rail's ground IS `bg-background`,
            so the composer was the same colour as the panel behind it and only
            its border said where the input started. `--card` is the theme's
            white, and it stays correct in dark mode and the three colour
            themes — which a literal white would not.
          */}
          <ComposerPrimitive.Root className="flex flex-col gap-1.5 rounded-lg border bg-card p-1.5 transition-colors focus-within:border-ring">
              {/* Pending image thumbnails (one row, horizontally scrollable) */}
              <div
                className="flex flex-wrap gap-1.5 empty:hidden"
                data-testid="editor-chat-attachments"
              >
                <ComposerPrimitive.Attachments
                  components={{ Image: ImageAttachmentChip, Attachment: ImageAttachmentChip }}
                />
              </div>
              {/* Text input spans the full width on its own row so the
                  user gets maximum typing space. */}
              <ComposerTextInput />
              {/* Action row below the input: attach + selection badge on
                  the left, send/stop pushed to the right edge. */}
              <div className="flex items-center gap-1.5">
                {/* Attach button — opens the file picker (image/* via the
                    adapter's accept). */}
                <ComposerPrimitive.AddAttachment asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="shrink-0 rounded-full"
                    aria-label="Attach image"
                    data-testid="editor-chat-attach"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </ComposerPrimitive.AddAttachment>
                {modelPicker}
                {/* Selection badge — right of +, removable via the ×.
                    Hidden when nothing is selected. */}
                {selectionBadge ? (
                  <Badge
                    variant="secondary"
                    className="min-w-0 max-w-40 shrink gap-0.5 py-0.5 pl-2 pr-0.5 font-normal"
                    data-testid="editor-chat-selection"
                  >
                    <span
                      className="min-w-0 truncate"
                      title={selectionBadge.title}
                    >
                      {selectionBadge.label}
                    </span>
                    {onClearSelection ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="size-4 shrink-0 rounded-full hover:bg-background/60"
                        aria-label="Clear selection"
                        onClick={onClearSelection}
                        data-testid="editor-chat-selection-clear"
                      >
                        <X className="size-2.5" />
                      </Button>
                    ) : null}
                  </Badge>
                ) : null}
                {/* Send is ALWAYS mounted; Stop appears beside it while a
                    turn runs rather than replacing it, because a running turn
                    is exactly when steering needs the button.

                    Grouped in one `ml-auto` box: `ml-auto` on each button
                    would split the row's free space between them and pull the
                    pair apart. Send is last so it never moves when Stop
                    appears — the primary action stays under the cursor. */}
                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                  <ThreadPrimitive.If running>
                    <ComposerPrimitive.Cancel asChild>
                      {/*
                        `ghost`, not `outline` (Mo, 2026-08-18). `StopCircle`
                        IS a circle with a square in it, so an outlined round
                        button drew a second ring around a glyph that already
                        had one. The button chrome is gone and the icon fills
                        the control, which is why it can be the same 24px as
                        Send without nesting two circles.

                        `strokeWidth` is set because the icon is drawn at 24px
                        while Send's arrow is drawn at 14px. lucide's default
                        stroke of 2 is measured on a 24px grid, so at 24px it
                        lands as a literal 2px line while Send's same stroke
                        scales down to ~1.2px. Side by side that made Stop the
                        heavier of the two (Mo, 2026-09-03: "really thick
                        lines"). 1.25 puts the two glyphs on the same optical
                        weight.
                      */}
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        className="shrink-0 rounded-full hover:bg-transparent"
                        aria-label="Stop"
                        data-testid="editor-chat-stop"
                      >
                        <StopCircle className="size-6" strokeWidth={1.25} />
                      </Button>
                    </ComposerPrimitive.Cancel>
                  </ThreadPrimitive.If>
                  <ComposerSendButton />
                </div>
              </div>
            </ComposerPrimitive.Root>
          </ComposerPrimitive.AttachmentDropzone>
        </footer>
      </AssistantRuntimeProvider>
    </section>
  )
}

/**
 * Memoized. A partial win by construction: `chat` changes identity on every
 * streamed flush, so this panel still re-renders during a turn — it is the
 * surface showing the tokens. What memo buys is the other direction: a
 * surface render caused by a branch poll, a layers refresh or a selection
 * change no longer re-renders the thread. That only holds because the rail
 * memoizes the `modelPicker` / `tabs` elements it passes in (see
 * `editor-right-rail.tsx`) — rebuilt inline they would change props
 * identity every render and defeat this memo entirely.
 */
export const EditorChatPanel = memo(EditorChatPanelImpl)
EditorChatPanel.displayName = "EditorChatPanel"

/* -------------------------------------------------------------------------- */
/* MID_TURN_SEND — unblocking the composer while a turn streams               */
/* -------------------------------------------------------------------------- */

/**
 * assistant-ui refuses to send while a turn is running in THREE independent
 * places, and all three read one flag: `thread.capabilities.queue`. Read from
 * the installed source (v0.14.11):
 *
 *   1. `ComposerPrimitive.Input`'s key handler —
 *      `primitives/composer/ComposerInput.js`:
 *        `const hasQueue = threadState.capabilities.queue;`
 *        `if (threadState.isRunning && !hasQueue) return;`
 *   2. `useComposerSend`, which `ComposerPrimitive.Send` is built from —
 *      `@assistant-ui/core/dist/react/primitive-hooks/useComposerSend.js`:
 *        `disabled = !s.composer.canSend || (s.thread.isRunning && !s.thread.capabilities.queue)`
 *   3. `ComposerPrimitive.Root`'s form `onSubmit`, which calls that same
 *      `useComposerSend` and returns early when it hands back null.
 *
 * `queue` is hard-coded `false` for us:
 * `runtimes/external-store/external-store-thread-runtime-core.js` sets
 * `queue: false` both in its initial capabilities and in
 * `__internal_setAdapter`. The queue seam belongs to the newer
 * `ExternalThread` resource client, which `useExternalStoreRuntime` is not,
 * so turning it on would mean migrating the runtime — a far larger change
 * than this feature warrants.
 *
 * The imperative `composer.send()` is the ONE path that is not gated:
 * `runtime/base/base-composer-runtime-core.js`'s `send()` checks `canSend`
 * alone, and `canSend` is `!isEmpty && !isSendDisabled`
 * (`default-thread-composer-runtime-core.js`) with no `isRunning` term. So
 * both the key handler and the Send button below call it directly, and
 * neither goes through the form.
 *
 * Consequence worth stating plainly: point 2 is why Send stays a plain
 * `Button` here instead of `ComposerPrimitive.Send`. Simply un-wrapping the
 * primitive from its `ThreadPrimitive.If running={false}` would leave a Send
 * button that is visible and permanently disabled for the whole turn, which
 * is the dead control this feature exists to remove.
 */

/**
 * The composer textarea, with a mid-turn Enter interception layered on top of
 * stock behaviour.
 *
 * `ComposerInput` composes its handlers as
 * `onKeyDown: composeEventHandlers(onKeyDown, handleKeyPress)`, and
 * `composeEventHandlers` (`@radix-ui/primitive`) skips the second handler when
 * the first has called `preventDefault()`. That is the entire interception
 * mechanism, and `preventDefault()` is the load-bearing half of it: without
 * it the library's `handleKeyPress` still runs, hits its
 * `if (threadState.isRunning && !hasQueue) return;` and neither submits nor
 * prevents the default — so the browser inserts a newline into a textarea our
 * `send()` has just emptied. The visible regression is a stray leading
 * newline in the next message, which is exactly what the colocated test
 * asserts against.
 *
 * While idle the handler returns before inspecting anything, so every
 * Enter / IME / Shift+Enter / `submitMode` subtlety remains the library's
 * problem rather than something this file has to re-implement.
 */
function ComposerTextInput() {
  const composer = useComposerRuntime()
  const isRunning = useAuiState((s) => s.thread.isRunning)

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Idle stays 100% stock — bail before looking at the event at all.
      if (!isRunning) return
      if (e.key !== "Enter") return
      // Enter mid-IME-composition commits the candidate (CJK, and any other
      // composed input). Sending here would ship a half-typed word AND eat
      // the commit. The library's own handler guards this the same way; no
      // test in this repo would catch it, so the guard is the protection.
      if (e.nativeEvent.isComposing) return
      // Shift+Enter is a newline in both states: let the default through.
      if (e.shiftKey) return
      e.preventDefault()
      composer.send()
    },
    [isRunning, composer],
  )

  return (
    <ComposerPrimitive.Input
      autoFocus
      minRows={2}
      // react-textarea-autosize ignores the native `rows` attribute (it
      // defaults minRows=1 and sizes off that), so `rows={2}` here was
      // inert — a width change that reflowed the placeholder to one line
      // shrank the box toward min-h-0. `minRows` is the library's own
      // floor. maxRows=8 keeps the library's inline height at/below the
      // max-h-40 (160px) cap: text-base/leading-snug is a ~19px line,
      // +4px vertical padding (py-0.5) -> 8 * 19 + 4 = 156px <= 160px, so
      // the CSS cap and the library's own sizing agree instead of fighting.
      maxRows={8}
      // An edit first, a question second (Mo, 2026-09-02): the field is for
      // changing the prototype, and "ask about" read as read-only. No
      // trailing ellipsis, per the copy rules.
      placeholder="Describe an edit, or ask about the prototype"
      className="max-h-40 min-h-0 w-full resize-none bg-transparent px-1 py-0.5 text-base font-normal leading-snug outline-none placeholder:text-muted-foreground/70 disabled:opacity-50"
      data-testid="editor-chat-input"
      onKeyDown={handleKeyDown}
    />
  )
}

/**
 * Send — always mounted, in both turn states.
 *
 * A plain `Button` rather than `ComposerPrimitive.Send` for reason 2 in the
 * MID_TURN_SEND note above: the primitive renders permanently disabled while
 * a turn runs. Everything else is stock. `disabled` is the composer's own
 * `canSend` (`!isEmpty && !isSendDisabled`), so disabled-on-empty-draft is
 * unchanged; only the `isRunning` term the primitive adds is dropped.
 *
 * `type="button"` is deliberate. This sits inside `ComposerPrimitive.Root`,
 * which is a `<form>` that sends on submit, so `type="submit"` would fire the
 * form's send AND this onClick and deliver the message twice while idle.
 */
function ComposerSendButton() {
  const composer = useComposerRuntime()
  const canSend = useAuiState((s) => s.composer.canSend)

  return (
    <Button
      type="button"
      // `icon-sm` (24px), down from `icon` (28px). Sized DOWN to meet Stop
      // rather than padding Stop up to meet it — Stop's size was the reason
      // it had a button ring at all.
      size="icon-sm"
      className="shrink-0 rounded-full"
      aria-label="Send"
      disabled={!canSend}
      onClick={() => composer.send()}
      data-testid="editor-chat-submit"
    >
      <ArrowUp className="size-3.5" />
    </Button>
  )
}

/* -------------------------------------------------------------------------- */
/* Resend indicator — making the ledger's recovery visible                     */
/* -------------------------------------------------------------------------- */

/**
 * Longest steer text shown inline before truncating. The rail is narrow and
 * this row sits above the composer, so a long message would push the
 * explanation off screen — which is the thing the row exists to say. The full
 * text is on the `title`.
 */
const RESENDING_TEXT_MAX = 60

/**
 * One row per steer the ledger is currently resending.
 *
 * Why this exists: when a turn is stopped with a steered message unaccounted
 * for, the client resubmits it as a fresh turn. The first attempt usually 409s
 * (the server still holds that session's turn lock) and the retry backs off.
 * Measured live, the whole recovery ran about 25 seconds with NOTHING on
 * screen — and the person watching, who had built the ledger, concluded it had
 * failed. If the author misreads the silence, a user certainly will.
 *
 * Deliberately not dismissible, unlike everything in `ChatStatusBanners`. This
 * state resolves itself in seconds, and a dismiss control on it would offer
 * the user a way to hide the only evidence their message survived.
 *
 * Deliberately not styled as a failure either. Nothing has gone wrong: the
 * message is fine and it is being delivered. So this takes the same neutral
 * `Alert` + spinner shape as the "waiting for an open chat slot" row it sits
 * beside, not the destructive one.
 */
function ResendingSteerRows({ steers }: { steers: ResendingSteer[] }) {
  if (steers.length === 0) return null
  return (
    <div data-testid="chat-resending-steers">
      {steers.map((steer) => (
        <ResendingSteerRow key={steer.id} steer={steer} />
      ))}
    </div>
  )
}

function ResendingSteerRow({ steer }: { steer: ResendingSteer }) {
  const full = steer.text.trim()
  const hasText = full.length > 0
  // An image-only steer has no text to quote, the same fallback the ledger's
  // own failure banner uses.
  const label = hasText
    ? `“${truncateSteerText(full)}”`
    : "your image attachment"

  return (
    <Alert
      // `role="status"` overrides the primitive's `role="alert"`: this is
      // progress, not a problem, and it must not interrupt a screen reader.
      role="status"
      className="mb-2 flex items-start gap-1.5 text-muted-foreground"
      data-testid="chat-resending-steer"
    >
      {/* `size-2.5` and `mt-1`, matching every other banner spinner. 13px
          text has a cap height near 9px, so a 12px ring overshot the letters
          it sat beside. */}
      <Loader2 className="mt-1 size-2.5 shrink-0 animate-spin" aria-hidden="true" />
      <span>
        {/* Says only what is KNOWN. The earlier wording — "because the turn
            stopped before it reached the agent" — asserted a cause the client
            cannot see, and the sweep fires on four different paths: the user
            pressed Stop, the stream died, the network failed, the POST never
            answered. On one of those, recorded live (Chrome raised
            ERR_NETWORK_IO_SUSPENDED), the message HAD already reached the
            agent and the transcript shows the user bubble twice — so both
            halves of that sentence were false. What is true on every path is
            only this: the turn ended, and nothing confirmed the message. */}
        Resending{" "}
        <span className="text-foreground" title={hasText ? full : undefined}>
          {label}
        </span>
        . The previous turn ended before this could be confirmed.
        {/* Attempt 1 is the common case and says nothing worth reading; a
            number only appears once a retry has actually happened. */}
        {steer.attempt > 1 ? ` Attempt ${steer.attempt}.` : ""}
      </span>
    </Alert>
  )
}

function truncateSteerText(text: string): string {
  if (text.length <= RESENDING_TEXT_MAX) return text
  return `${text.slice(0, RESENDING_TEXT_MAX).trimEnd()}…`
}

/**
 * A pending image attachment chip in the editor — a thumbnail rendered from
 * the attachment's File (object URL, revoked on unmount) with a remove button.
 * Rendered by `ComposerPrimitive.Attachments` within each attachment's
 * context, so `useAttachment()` resolves the current item. Falls back to the
 * file name when there's no previewable file.
 */
function ImageAttachmentChip() {
  const file = useAttachment((a) => a.file)
  const name = useAttachment((a) => a.name)
  const src = useMemo(
    () => (file ? URL.createObjectURL(file) : undefined),
    [file],
  )
  useEffect(() => {
    return () => {
      if (src) URL.revokeObjectURL(src)
    }
  }, [src])

  return (
    <div
      className="group relative h-12 w-12 overflow-hidden rounded border bg-muted"
      data-testid="editor-chat-attachment-chip"
    >
      {src ? (
        <img src={src} alt={name} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center px-0.5 text-center text-2xs leading-tight text-muted-foreground">
          {name}
        </div>
      )}
      <AttachmentPrimitive.Remove asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Remove attachment"
          className="absolute right-0 top-0 rounded-none rounded-bl opacity-0 transition-opacity group-hover:opacity-100"
        >
          <X className="h-2.5 w-2.5" />
        </Button>
      </AttachmentPrimitive.Remove>
    </div>
  )
}

/**
 * The examples are EDITS, at three sizes (Mo, 2026-09-02: the earlier
 * "what file is this in?" / "show me the props" read as informational and
 * "didn't resonate"; this chat is for changing the prototype). One tweak, one
 * layout change, one whole page, so the range is the message.
 */
export function EmptyState() {
  return (
    <div className="px-3 py-4 text-center text-xs text-muted-foreground">
      <p className="mb-1 font-normal text-foreground">Start a conversation</p>
      <p>
        Ask for an edit, from a tweak to a whole page. Try{" "}
        &quot;make this button secondary&quot;, &quot;put these cards two per row
        on mobile&quot;, or &quot;add a settings page with a form and a save
        button&quot;.
      </p>
    </div>
  )
}

/**
 * Mirrors the stock Editor's text into a session-keyed draft cache so
 * half-typed prompts survive switching session tabs.
 *
 * The external-store runtime is NOT remounted per session (one `chat`
 * instance buckets all sessions internally), so the Editor holds a single
 * draft that would otherwise bleed across tabs. Two effects keep it scoped:
 *   1. On `sessionId` change, load that session's saved draft into the
 *      Editor (`setText`).
 *   2. Subscribe to Editor changes and persist the current text back to
 *      the cache. Stock Editor clears its text on submit, which writes an
 *      empty draft here — correct, the draft was consumed.
 *
 * Effect ordering on a session switch: React runs the subscribe effect's
 * cleanup (unsubscribe) before the load effect's body, so the `setText` for
 * the incoming session can't fire a stale write under the outgoing session.
 */
function EditorDraftSync({
  sessionId,
  cache,
}: {
  sessionId: string | null
  cache: ChatSessionDraftCache
}) {
  const editor = useComposerRuntime()

  useEffect(() => {
    const saved = cache.getDraft(sessionId)
    editor.setText(saved ?? "")
    // Intentionally keyed on sessionId only — `editor`/`cache` are stable
    // refs, and we must not re-load (clobbering live edits) when they tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  useEffect(() => {
    return editor.subscribe(() => {
      cache.setDraft(sessionId, editor.getState().text)
    })
  }, [sessionId, editor, cache])

  return null
}

/**
 * Build the input-bar selection badge text from the current selection(s).
 * Multi-select collapses to "N selected"; a single selection shows the
 * element tag or component name. Returns null when nothing is selected so
 * the badge is hidden. `title` carries the fuller identity for hover.
 */
function describeSelection(
  selection: Selection | null | undefined,
  selectionMany: Selection[] | undefined,
): { label: string; title: string } | null {
  if (selectionMany && selectionMany.length > 0) {
    return {
      label: `${selectionMany.length} selected`,
      title: selectionMany
        .map((s) => s.componentName ?? s.tagName ?? s.selector)
        .join(", "),
    }
  }
  if (selection) {
    const label = selection.selectedAsElement
      ? selection.tagName ?? selection.selector
      : selection.componentName ?? selection.tagName ?? selection.selector
    const title = selection.selectedAsElement
      ? selection.selector
      : selection.componentFile ?? selection.selector
    return { label, title }
  }
  return null
}

/**
 * Friendly working-indicator label derived from the latest in-flight tool
 * call (a `tool_use` block with no `result` yet). Falls back to "Thinking…"
 * when the agent is between tools or hasn't called one. Filenames are
 * basename-only to stay legible at the rail's width.
 */
function deriveWorkingLabel(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.kind === "assistant") {
      for (let j = m.blocks.length - 1; j >= 0; j--) {
        const b = m.blocks[j]
        if (b.type === "tool_use" && b.result === undefined) {
          return friendlyToolLabel(b.name, b.input)
        }
      }
      return "Thinking…"
    }
    if (m.kind === "user") return "Thinking…"
  }
  return "Thinking…"
}

const TOOL_VERBS: Record<string, string> = {
  Edit: "Editing",
  Write: "Writing",
  MultiEdit: "Editing",
  Read: "Reading",
  Glob: "Searching",
  Grep: "Searching",
  Bash: "Running command",
}

function friendlyToolLabel(name: string, input: unknown): string {
  const verb = TOOL_VERBS[name]
  const base =
    input && typeof input === "object"
      ? pickFileName(input as Record<string, unknown>)
      : undefined
  if (verb && base) return `${verb} ${base}…`
  if (verb) return `${verb}…`
  return `Running ${name}…`
}

function pickFileName(input: Record<string, unknown>): string | undefined {
  const raw = input.file_path ?? input.path ?? input.filePath
  if (typeof raw !== "string" || raw.length === 0) return undefined
  return raw.split("/").pop() || raw
}
