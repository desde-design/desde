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
    // Render the mention with styling
    parts.push(
      <span
        key={match.index}
        className="rounded bg-primary/10 px-0.5 font-normal text-primary"
        title={match[2]}
      >
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
