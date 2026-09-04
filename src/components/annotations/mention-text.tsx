"use client"

import type { ReactNode } from "react"
import { MENTION_PATTERN } from "@/components/annotations/mention-encoding"

interface MentionTextProps {
  text: string
}

/**
 * Renders comment body text with @mentions highlighted.
 *
 * Reads the SAME pattern the composer writes (`mention-encoding.ts`) rather
 * than a private copy of the regex: a renderer that disagrees with the
 * encoder shows a mention as raw `@[Name](id)` punctuation, which is how a
 * body ends up looking like a bug in the middle of somebody's sentence.
 */
export function MentionText({ text }: MentionTextProps) {
  const parts: ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  // A fresh instance per render: the shared pattern is global (`/g`), so
  // sharing it would carry `lastIndex` between two bodies.
  const regex = new RegExp(MENTION_PATTERN)

  while ((match = regex.exec(text)) !== null) {
    // Text before the mention
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }

    const displayName = match[1]
    // Colour alone, no pill. A filled chip made every mention the loudest
    // thing in a thread, and inside a selected row (`bg-primary/10`, the same
    // value) it turned into a tint on a tint. The aqua is `--primary`, the
    // same colour the composer shows while the mention is being written, so a
    // mention looks the same before and after it is sent.
    //
    // No `title` either: it carried the participant id, which is opaque, so
    // hovering a name produced a bare UUID. It read as an email address back
    // when the format anchored on one.
    parts.push(
      <span key={match.index} className="text-primary">
        @{displayName}
      </span>
    )

    lastIndex = match.index + match[0].length
  }

  // Remaining text
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  // If no mentions found, return plain text
  if (parts.length === 0) {
    return <>{text}</>
  }

  return <>{parts}</>
}
