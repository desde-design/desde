"use client"

import { useState, useCallback, useEffect, type CSSProperties } from "react"
import { Button } from "@/components/ui/button"
import { MentionInput } from "@/components/annotations/mention-input"
import type { MentionParticipant } from "@/components/annotations/mention-encoding"
import { MentionText } from "@/components/annotations/mention-text"
import { Check, ArrowUp, Trash2, X, Reply, Sparkles } from "lucide-react"

interface AnnotationReply {
  id: string
  body: string
  author: { displayName: string }
}

export interface AnnotationCardProps {
  variant: "comment" | "note"
  body: string
  author: { displayName: string }
  replies: AnnotationReply[]
  resolved: boolean
  /**
   * Reply handler. Returns `{ ok: false }` to keep the user's draft
   * intact on failure (network error, validation rejection). Plain
   * `void` returns are treated as success — preserves the historical
   * synchronous-write callers. The CLI override path returns the
   * envelope from `useLocal{Comments,Notes}.addReply` so users don't
   * lose typed replies when the HTTP write rejects.
   */
  onReply: (encodedBody: string) => void | Promise<void | { ok?: boolean }>
  onResolve: () => void
  onDelete: () => void
  onClose: () => void
  /**
   * Optional "Fix with AI" action. When provided, a button in the footer
   * hands the comment to the chat agent. Only the CLI comment path wires
   * this (the web/note paths pass nothing → no button), so it's a pure
   * additive opt-in with no effect elsewhere.
   */
  onFix?: () => void
  /**
   * The @-mention directory for the reply box. Omitted (or empty) means
   * nobody is mentionable on this surface, and the reply placeholder stops
   * offering `@` rather than promising a picker that cannot open — which is
   * what it did on every surface until 2026-09-03.
   *
   * Wired by the Viewer's review shell (the prototype's participants) and by
   * the Editor when the repo is linked to a Viewer prototype. Notes and the
   * canvas pass nothing: both are local-only, so there is no directory.
   */
  participants?: MentionParticipant[]
  /** Invite-by-email from inside the picker. See `MentionInput`. */
  onInvite?: (email: string) => Promise<MentionParticipant | null>
}

const BG_COLORS: Record<string, string> = {
  comment: "var(--background)",
  note: "var(--note)",
}

/**
 * The card's outline, per variant.
 *
 * It used to be hard-coded to `var(--note)` for BOTH, so a comment card wore
 * the note colour — a pink ring on the viewer's review popup, which is a
 * teal product. The background already followed the variant; the outline was
 * simply missed.
 *
 * Comments ring in `--primary`, which IS the brand teal and carries its own
 * dark-mode value, so this needs no second token and cannot drift from the
 * rest of the UI. Notes keep `--note`, which is what distinguishes them.
 */
const RING_COLORS: Record<string, string> = {
  comment: "var(--primary)",
  note: "var(--note)",
}

/**
 * The card's surface: ground plus outline, per variant.
 *
 * Exported because the NEW-comment composers are different components from
 * this one, and they had drifted: one was carrying a plain grey
 * `border border-border` and `rounded-sm` while the thread popup had a teal
 * outline and `rounded`. Two cards that open in the same place, one click
 * apart, looking like two products.
 *
 * One definition, several callers, so they cannot drift again. The radius is
 * not in here on purpose: it is a plain utility class every side can write.
 * Neither is `overflow-hidden`, which no card that hosts a `MentionInput` can
 * take (its picker is absolutely positioned and opens out of the card).
 */
export function annotationCardSurface(variant: "comment" | "note"): CSSProperties {
  return {
    background: BG_COLORS[variant],
    outline: `2px solid color-mix(in oklch, ${RING_COLORS[variant]} 50%, transparent)`,
    outlineOffset: "-1px",
  }
}

export function AnnotationCard({
  variant,
  body,
  author,
  replies,
  resolved,
  onReply,
  onResolve,
  onDelete,
  onClose,
  onFix,
  participants,
  onInvite,
}: AnnotationCardProps) {
  const [replyText, setReplyText] = useState("")
  const [showReplyInput, setShowReplyInput] = useState(false)
  const [replySubmitting, setReplySubmitting] = useState(false)

  const handleSubmitReply = useCallback(async () => {
    if (!replyText.trim() || replySubmitting) return
    // The body already carries `@[Name](id)` tokens: the picker writes the
    // wire format straight into the text, so there is no separate mention
    // list to reconcile at submit time.
    const encodedBody = replyText.trim()
    // Await the handler so a CLI override returning `{ ok: false }`
    // (network rejection) keeps the draft intact. Default synchronous
    // callers return `void`, which we treat as success.
    setReplySubmitting(true)
    try {
      const result = await onReply(encodedBody)
      if (result && (result as { ok?: boolean }).ok === false) return
      setReplyText("")
      setShowReplyInput(false)
    } finally {
      setReplySubmitting(false)
    }
  }, [replyText, replySubmitting, onReply])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void handleSubmitReply()
    }
  }

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showReplyInput) {
          setShowReplyInput(false)
          setReplyText("")
        } else {
          onClose()
        }
      }
    }
    window.addEventListener("keydown", handleEsc)
    return () => window.removeEventListener("keydown", handleEsc)
  }, [showReplyInput, onClose])

  return (
    <div
      /* No `overflow-hidden`, deliberately, and for the same reason the
         Viewer's new-comment composer dropped it: the reply box's mention
         picker is absolutely positioned, so it opens out of the reply row
         and a clip here cut its list in half. Nothing else needs it, since
         the only child that paints to a corner is this element. */
      className="group/card flex w-80 flex-col rounded shadow-xl"
      style={annotationCardSurface(variant)}
    >
      {/* Header — author + actions */}
      <div className="flex flex-none items-center justify-between px-3 py-1.5">
        <span className="text-xs text-muted-foreground">{author.displayName}</span>
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/card:opacity-100 group-focus-within/card:opacity-100">
          <Button
            variant={resolved ? "secondary" : "ghost"}
            size="icon-xs"
            title={resolved ? "Resolved" : "Resolve"}
            onClick={onResolve}
          >
            <Check className="h-2.5 w-2.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-destructive"
            title="Delete"
            onClick={onDelete}
          >
            <Trash2 className="h-2.5 w-2.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            title="Close"
            onClick={onClose}
          >
            <X className="h-2.5 w-2.5" />
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="max-h-96 overflow-y-auto">
        <div className="px-3 pb-2 pt-0.5">
          <p className="text-base"><MentionText text={body} /></p>
        </div>
        {replies.map((reply) => (
          <div key={reply.id} className="border-t border-border px-3 py-2.5">
            <span className="text-xs text-muted-foreground">{reply.author.displayName}</span>
            <p className="mt-0.5 text-base">
              <MentionText text={reply.body} />
            </p>
          </div>
        ))}
      </div>

      {/* Reply */}
      {showReplyInput ? (
        <div className="border-t border-border p-3">
          <div className="relative">
            <MentionInput
              placeholder="Reply"
              value={replyText}
              onChange={setReplyText}
              onKeyDown={handleKeyDown}
              participants={participants}
              onInvite={onInvite}
              className="min-h-[44px] resize-none bg-white pr-10 text-base"
              autoFocus
            />
            <Button
              size="icon-sm"
              className="absolute bottom-2 right-2 rounded-full"
              onClick={() => void handleSubmitReply()}
              disabled={!replyText.trim() || replySubmitting}
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      ) : (
        <div className={`flex px-3 pb-2 pt-1 ${onFix ? "justify-between" : "justify-end"}`}>
          {onFix ? (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-muted-foreground"
              title="Hand this comment to the chat assistant to fix"
              onClick={onFix}
            >
              <Sparkles className="h-3 w-3" />
              Fix with AI
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground"
            onClick={() => setShowReplyInput(true)}
          >
            <Reply className="h-3 w-3" />
            Reply
          </Button>
        </div>
      )}
    </div>
  )
}
