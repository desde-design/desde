"use client"

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import {
  encodeMention,
  findActiveMentionToken,
  type MentionParticipant,
} from "@/components/annotations/mention-encoding"
import {
  displayToStorage,
  isInsideMention,
  project,
  projectWithMap,
  reconcile,
} from "@/components/annotations/mention-projection"

const MAX_MENTION_MATCHES = 8

/**
 * Roughly how tall the picker gets: the list caps at `max-h-32` (128px) and
 * the invite row and its failure line add the rest. Used only to decide which
 * side of the textarea to open on, so an approximation is enough.
 */
const PICKER_HEIGHT_ESTIMATE = 190

interface MentionInputProps {
  value: string
  onChange: (value: string) => void
  /**
   * Runs for keys the picker did not consume. While the picker is open it
   * owns Arrow/Enter/Escape, so a parent's Cmd+Enter submit still works and
   * a bare Enter picks a name instead of sending a half-typed mention.
   */
  onKeyDown?: (e: React.KeyboardEvent) => void
  /**
   * The @-mention directory. Empty (or omitted) means nobody is mentionable
   * here, and the picker never opens.
   */
  participants?: MentionParticipant[]
  /**
   * Invite-by-email, surfaced as a row under the matches. Omit it and the
   * row is not rendered: a surface that cannot invite must not offer to.
   * Resolves to the created participant so the caller's mention lands
   * immediately, or `null` when the invite failed.
   */
  onInvite?: (email: string) => Promise<MentionParticipant | null>
  /**
   * The base prompt, WITHOUT a trailing ellipsis or a mention hint: pass
   * `"Reply"`, not `"Reply… (@ to mention)"`. This component appends both,
   * and appends the hint only when someone is actually mentionable.
   *
   * That composition is the point. Before it, the hint was a hardcoded
   * string at four call sites and the picker was wired at none of them, so
   * every reply box in the product advertised a feature it did not have.
   * Deriving the promise from the capability is what stops that recurring.
   */
  placeholder?: string
  className?: string
  autoFocus?: boolean
}

/** True when this input can actually resolve an `@` to somebody. */
function canMention(participants: MentionParticipant[], onInvite?: unknown): boolean {
  return participants.length > 0 || typeof onInvite === "function"
}

function MentionPicker({
  query,
  matches,
  activeIndex,
  listId,
  optionId,
  placement,
  onSelect,
  onDismiss,
  onInvite,
}: {
  query: string
  matches: MentionParticipant[]
  activeIndex: number
  listId: string
  optionId: (index: number) => string
  placement: "above" | "below"
  onSelect: (participant: MentionParticipant) => void
  onDismiss: () => void
  /** Resolves true when somebody was actually invited. */
  onInvite?: (email: string) => Promise<boolean>
}) {
  const [inviteEmail, setInviteEmail] = useState("")
  const [inviting, setInviting] = useState(false)
  const [inviteFailed, setInviteFailed] = useState(false)

  // `aria-activedescendant` tells assistive tech which row is current, but it
  // does not scroll the list. The box shows about five of the eight matches,
  // so arrowing down past the fifth moved the highlight somewhere nobody
  // could see, and Enter then inserted a name that was never on screen.
  useEffect(() => {
    const el = document.getElementById(optionId(activeIndex))
    // jsdom has no scrollIntoView, and neither does every embedding.
    if (typeof el?.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" })
  }, [activeIndex, optionId])

  const handleInvite = useCallback(async () => {
    const email = inviteEmail.trim()
    if (!email || inviting || !onInvite) return
    setInviting(true)
    setInviteFailed(false)
    try {
      // Clear ONLY on success. A rejected address (a typo, a server that is
      // down) used to be wiped along with the rest, so the one thing the
      // person needed in order to try again was the thing that disappeared,
      // and nothing said anything had gone wrong.
      const invited = await onInvite(email)
      // A successful invite mentions the new person straight away, which
      // closes the token and unmounts this whole row, so the clear below is
      // belt and braces rather than the thing you see. The failure branch is
      // the one that matters.
      if (invited) setInviteEmail("")
      else setInviteFailed(true)
    } finally {
      setInviting(false)
    }
  }, [inviteEmail, inviting, onInvite])

  return (
    <div
      /* Escape has to be caught HERE as well as on the textarea. Focus can
         be inside this popup (the invite field, an option button), and a
         card that hosts this input closes its reply box on a window-level
         Escape — so an unhandled one here threw away the draft the user was
         part-way through writing. */
      onKeyDown={(e) => {
        if (e.key !== "Escape") return
        e.preventDefault()
        e.stopPropagation()
        onDismiss()
      }}
      className={cn(
        "absolute left-0 z-10 flex w-full flex-col overflow-hidden rounded-sm border border-border bg-popover shadow-lg",
        placement === "above" ? "bottom-full mb-1" : "top-full mt-1",
      )}
    >
      <ul id={listId} role="listbox" aria-label="Mention someone" className="max-h-32 overflow-y-auto p-1">
        {matches.length === 0 ? (
          <li className="px-2 py-1 text-xs text-muted-foreground">
            {query.trim() ? "No matches" : "Nobody to mention yet"}
          </li>
        ) : (
          matches.map((p, index) => (
            <li key={p.id} role="presentation">
              <Button
                type="button"
                role="option"
                id={optionId(index)}
                aria-selected={index === activeIndex}
                variant="ghost"
                size="sm"
                /* Out of the tab order, per the combobox pattern: the
                   textarea keeps focus and its arrows move the highlight.
                   Left tabbable, these were reachable but not activatable,
                   since Enter on a focused button fires `click` and the
                   selection is bound to `mousedown`. */
                tabIndex={-1}
                className={cn(
                  "w-full justify-start gap-1.5 px-2",
                  index === activeIndex && "bg-muted",
                )}
                /* Two handlers, one job. `mousedown` ONLY cancels the
                   default, which is what stops the textarea losing focus and
                   the caret the insertion reads. The selection itself hangs
                   off `click`, because a screen reader or voice control
                   activates a control by dispatching `click` with no
                   `mousedown` before it — bound to `mousedown` alone, these
                   rows did nothing at all for those users, and they are not
                   reachable by Tab either. */
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onSelect(p)}
              >
                <span className="truncate">{p.displayName}</span>
                {p.email ? (
                  <span className="truncate text-xs text-muted-foreground">{p.email}</span>
                ) : null}
              </Button>
            </li>
          ))
        )}
      </ul>
      {onInvite ? (
        <div className="flex items-center gap-1 border-t border-border p-1">
          <Input
            size="sm"
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="Invite by email…"
            className="text-xs"
          />
          <Button
            type="button"
            size="xs"
            disabled={!inviteEmail.trim() || inviting}
            onClick={() => void handleInvite()}
          >
            Invite
          </Button>
        </div>
      ) : null}
      {inviteFailed ? (
        /* Plain small text under the field it belongs to, not a banner: the
           error is about this one input, and boxing it would break that
           pairing. `role="status"` because the picker is already open when
           it appears, so nothing else would announce it. */
        <p role="status" className="px-2 pb-1.5 text-xs text-destructive">
          That invite did not go through. Check the address and try again.
        </p>
      ) : null}
    </div>
  )
}

/**
 * A textarea that resolves `@` against a participant directory and writes
 * the shared `@[Name](id)` wire format (`mention-encoding.ts`).
 *
 * ## Two coordinate systems
 *
 * `value` and `onChange` carry STORAGE, exactly as they always have, so every
 * parent submits the body unchanged and none of them can forget to encode.
 * What the textarea RENDERS is the display projection: `@Ana Whitfield`, not
 * `@[Ana Whitfield](7f9b83f8-…)`. See `mention-projection.ts` for why storage
 * stays the source of truth.
 *
 * So every offset in this component (`cursor`, `nav.start`, `dismissed.start`,
 * and everything `findActiveMentionToken` returns) is a DISPLAY offset. The
 * only places the two systems meet are `applyMention`, which converts, and the
 * change handler, which reconciles. Mixing them anywhere else splices at the
 * wrong place and garbles the visible sentence.
 *
 * The picker opens upward by default, because every mount site is a card whose
 * composer sits at its bottom, and it flips below when the card is anchored
 * near the top of the screen and there is no room. Either way it escapes the
 * composer's own box, so a parent that clips (`overflow-hidden`) cuts the list
 * in half; the mount sites deliberately do not. The parent must be positioned
 * (`relative`), since the list is absolute within it.
 */
export function MentionInput({
  value,
  onChange,
  onKeyDown,
  participants = [],
  onInvite,
  placeholder,
  className,
  autoFocus,
}: MentionInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // Set by `applyMention`, applied once the projected value has been written
  // to the DOM. Inserting a mention is the ONLY edit that changes what the
  // textarea shows out from under the browser: an ordinary keystroke, even one
  // that degrades a mention, projects back to the characters already on screen,
  // so React's write-back is a no-op and the caret is left alone.
  const pendingCaretRef = useRef<number | null>(null)
  const listId = useId()
  // Cursor tracked as state rather than read off the ref during render (the
  // refs rule), refreshed on every event that can move the caret.
  const [cursor, setCursor] = useState(0)
  // The highlighted match, carried WITH the token it was chosen against — the
  // start offset AND the query. A bare index survives a query change, so
  // narrowing to one match and then deleting back to four left the highlight
  // on row 3 of a list the user has not looked at, and Enter inserted
  // somebody they never picked. Keying on the query alone was not enough
  // either: abandon a `@` you had arrowed down in, start a fresh one
  // somewhere else, and both have the empty query, so the new picker opened
  // on the old row.
  const [nav, setNav] = useState<{ start: number; query: string; index: number } | null>(null)
  // What Escape dismissed, if anything.
  const [dismissed, setDismissed] = useState<{ start: number; query: string } | null>(null)
  // Whether an IME composition is open. The key handler reads this off the
  // event, but the caret effect runs outside any event and needs the flag.
  const composingRef = useRef(false)
  // Which side of the textarea the list opens on. Above by default, because
  // that is where it belongs for a composer at the bottom of a card.
  const [placement, setPlacement] = useState<"above" | "below">("above")

  const mentionsPossible = canMention(participants, onInvite)

  // What the writer sees, plus where each live mention sits in it.
  const projection = useMemo(() => projectWithMap(value), [value])
  const display = projection.display

  const token = useMemo(() => {
    if (!mentionsPossible) return null
    const found = findActiveMentionToken(display, cursor)
    // An `@` that belongs to a mention already resolved is not a query. Left
    // unguarded, clicking after the first word of `@Ana Whitfield` reopened
    // the picker on it, and choosing a name replaced half the name and left
    // the rest of it stranded in the sentence.
    if (found && isInsideMention(projection.mentions, found.start)) return null
    return found
  }, [mentionsPossible, display, cursor, projection.mentions])
  // A dismissal covers the token it was made on and anything typed onto the
  // end of it. Editing the query back down, or starting a token somewhere
  // else, is a new question and gets the picker back — otherwise deleting an
  // `@` and retyping it in the same spot stayed silent forever.
  const isDismissed =
    dismissed !== null &&
    token !== null &&
    token.start === dismissed.start &&
    token.query.startsWith(dismissed.query)
  const open = token !== null && !isDismissed

  const matches = useMemo(() => {
    if (!token) return []
    const q = token.query.trim().toLowerCase()
    const filtered = q
      ? participants.filter(
          // `email` is omitted for non-insiders (audit S3), so it must be
          // treated as optional: an unguarded `.toLowerCase()` here threw
          // and took the whole picker down for anonymous reviewers.
          (p) =>
            p.displayName.toLowerCase().includes(q) ||
            (p.email?.toLowerCase().includes(q) ?? false),
        )
      : participants
    return filtered.slice(0, MAX_MENTION_MATCHES)
  }, [participants, token])

  // Back to the top whenever the token moves, then clamped, so the highlight
  // is always on a row that is actually in the list.
  const navIndex =
    nav !== null && token !== null && nav.start === token.start && nav.query === token.query
      ? nav.index
      : 0
  const boundedIndex = matches.length === 0 ? 0 : Math.min(navIndex, matches.length - 1)

  const applyMention = useCallback(
    (participant: MentionParticipant) => {
      const el = textareaRef.current
      // Display offsets, both of them: this is what the DOM reports.
      const activeCursor = el?.selectionStart ?? cursor
      const active = findActiveMentionToken(display, activeCursor)
      if (!active) return

      // ...converted to storage offsets before touching `value`. The token
      // being replaced is always in literal text (the picker refuses to open
      // inside a resolved mention), so neither conversion has to snap.
      const storageStart = displayToStorage(value, active.start, "start")
      const storageCursor = displayToStorage(value, activeCursor, "end")
      const insertedStorage = encodeMention(participant.displayName, participant.id) + " "
      const next = value.slice(0, storageStart) + insertedStorage + value.slice(storageCursor)
      // Back to display space for the caret. Measured from the projection of
      // what was inserted, not from the token's length, because the name is
      // sanitized on the way in and the two can differ.
      const nextCursor = active.start + project(insertedStorage).length

      onChange(next)
      setCursor(nextCursor)
      setNav(null)
      setDismissed(null)
      // Consumed by the layout effect below. Not `requestAnimationFrame`: that
      // runs after paint, so the caret was visibly in the wrong place for a
      // frame, and it could land after a parent's post-submit reset.
      pendingCaretRef.current = nextCursor
    },
    [value, display, cursor, onChange],
  )

  const handleInvite = useCallback(
    async (email: string): Promise<boolean> => {
      if (!onInvite) return false
      const created = await onInvite(email)
      if (!created) return false
      applyMention(created)
      return true
    },
    [onInvite, applyMention],
  )

  // Measured when the list opens, not at render, because the card these
  // inputs sit in is positioned relative to a comment pin: a pin in the TOP
  // half of the screen anchors the card by its `top`, which puts the textarea
  // near the top edge and sends an upward-opening list off-screen entirely.
  // Nothing about that is knowable from props.
  useLayoutEffect(() => {
    if (!open) return
    const rect = textareaRef.current?.getBoundingClientRect()
    if (!rect) return
    // A zero-height viewport is not a cramped one, it is a page that is not
    // being shown: a hidden pane, an offscreen capture, a detached document.
    // Measured live, that reads as "no room anywhere" and flips the list to
    // the wrong side, where it then STAYS, because this only runs when the
    // list opens. Keep the default rather than act on a measurement that
    // cannot be right.
    if (window.innerHeight <= 0) return
    const roomAbove = rect.top
    const roomBelow = window.innerHeight - rect.bottom
    // Stay above unless there is genuinely not room and below is better, so
    // the list does not flip about while the page is merely short.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPlacement(roomAbove < PICKER_HEIGHT_ESTIMATE && roomBelow > roomAbove ? "below" : "above")
  }, [open])

  // Applies the caret `applyMention` asked for, once the projected value has
  // reached the DOM.
  const applyPendingCaret = useCallback(() => {
    const next = pendingCaretRef.current
    if (next === null) return
    // Never move the caret mid-composition: writing a selection while an IME
    // is open aborts or scrambles the composition. HOLD the request rather
    // than consuming it, or picking a name while composing leaves the caret at
    // the end of the field with nothing to put it back. `onCompositionEnd`
    // drains it, since a composition ending does not on its own re-render.
    if (composingRef.current) return
    pendingCaretRef.current = null
    const el = textareaRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(next, next)
  }, [])

  useLayoutEffect(applyPendingCaret)

  const trackCursor = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    setCursor(e.currentTarget.selectionStart ?? e.currentTarget.value.length)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // An IME composition owns these keys first. Typing an `@` query in
    // Japanese, Korean or Chinese, Enter COMMITS the candidate the IME is
    // offering; treating it as "pick the highlighted participant" replaces
    // half-composed text with a mention the user never chose. Arrow keys
    // move through the IME's own candidate list, and Escape cancels the
    // composition. So while composing, the picker consumes nothing and the
    // parent sees every key exactly as it did before this input existed.
    const composing = (e.nativeEvent as KeyboardEvent).isComposing
    if (open && !composing) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault()
        if (matches.length === 0) return
        const delta = e.key === "ArrowDown" ? 1 : -1
        setNav({
          start: token.start,
          query: token.query,
          index: (matches.length + boundedIndex + delta) % matches.length,
        })
        return
      }
      // Bare Enter picks the highlighted name. Modified Enter is the
      // parent's submit and must fall through, or Cmd+Enter would silently
      // stop sending whenever a mention token happened to be open.
      if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey && matches.length > 0) {
        e.preventDefault()
        applyMention(matches[boundedIndex])
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        // Stops the card's window-level Escape handler, which would
        // otherwise close the reply box (or the whole thread) on the same
        // keypress that was only meant to dismiss the picker.
        e.stopPropagation()
        setDismissed({ start: token.start, query: token.query })
        return
      }
    }
    onKeyDown?.(e)
  }

  const composedPlaceholder = placeholder
    ? mentionsPossible
      ? `${placeholder}… (@ to mention)`
      : `${placeholder}…`
    : undefined

  return (
    <>
      {open ? (
        <MentionPicker
          query={token.query}
          matches={matches}
          activeIndex={boundedIndex}
          listId={listId}
          optionId={(index) => `${listId}-option-${index}`}
          placement={placement}
          onSelect={applyMention}
          onDismiss={() => setDismissed({ start: token.start, query: token.query })}
          onInvite={onInvite ? handleInvite : undefined}
        />
      ) : null}
      <Textarea
        ref={textareaRef}
        value={display}
        onCompositionStart={() => {
          composingRef.current = true
        }}
        onCompositionEnd={() => {
          composingRef.current = false
          applyPendingCaret()
        }}
        onChange={(e) => {
          // The browser edited DISPLAY text; fold that edit back into storage.
          // `onChange` keeps firing during a composition, as it always has, so
          // the parent's value is never stale when Send is clicked.
          onChange(reconcile(value, e.target.value))
          trackCursor(e)
        }}
        onKeyDown={handleKeyDown}
        onKeyUp={trackCursor}
        onClick={trackCursor}
        placeholder={composedPlaceholder}
        className={className}
        autoFocus={autoFocus}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={
          open && matches.length > 0 ? `${listId}-option-${boundedIndex}` : undefined
        }
      />
    </>
  )
}
