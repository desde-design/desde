"use client"

import { useCallback, useRef } from "react"
import { Textarea } from "@/components/ui/textarea"

interface MentionSelection {
  displayName: string
  email: string
  startIndex: number
}

interface MentionInputProps {
  value: string
  onChange: (value: string) => void
  onKeyDown?: (e: React.KeyboardEvent) => void
  onMentionsChange?: (mentions: MentionSelection[]) => void
  placeholder?: string
  className?: string
  autoFocus?: boolean
}

/**
 * Plain-text `@mention` textarea. There is no directory-search backend in
 * this build (the Google-directory lookup was viewer-only and was removed
 * — see `tasks/share-readiness-plan.md`), so this degrades gracefully to a
 * bare Textarea: users can still type "@Name" by hand, it just isn't
 * autocompleted or resolved to an email. `onMentionsChange` is accepted for
 * API compatibility with callers but is never invoked, since there is no
 * structured mention to report; `encodeBodyMentions` below is a no-op when
 * given an empty mentions list (which it always is in this build).
 */
export function MentionInput({
  value,
  onChange,
  onKeyDown,
  placeholder,
  className,
  autoFocus,
}: MentionInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value)
    },
    [onChange]
  )

  return (
    <Textarea
      ref={textareaRef}
      value={value}
      onChange={handleChange}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      className={className}
      autoFocus={autoFocus}
    />
  )
}

/**
 * Transform display-name mentions in body text to the structured storage format.
 * Converts "@Display Name" to "@[Display Name](email)" using tracked mentions.
 * With no directory search, `mentions` is always empty in this build, so this
 * is currently a no-op — kept so the storage format doesn't change out from
 * under callers if a mention source is reintroduced later.
 */
export function encodeBodyMentions(
  body: string,
  mentions: MentionSelection[]
): string {
  if (mentions.length === 0) return body

  // Sort mentions by startIndex descending so replacements don't shift indices
  const sorted = [...mentions].sort((a, b) => b.startIndex - a.startIndex)
  let result = body

  for (const mention of sorted) {
    const searchStr = `@${mention.displayName}`
    // Find the mention near the expected position (may have shifted slightly)
    const idx = result.indexOf(searchStr, Math.max(0, mention.startIndex - 5))
    if (idx !== -1) {
      result =
        result.slice(0, idx) +
        `@[${mention.displayName}](${mention.email})` +
        result.slice(idx + searchStr.length)
    }
  }

  return result
}
