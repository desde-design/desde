"use client"

import type { ReactNode } from "react"

interface MentionTextProps {
  text: string
}

// Match @[Display Name](email@example.com) pattern
const MENTION_REGEX = /@\[([^\]]+)\]\(([^)]+)\)/g

/**
 * Renders comment body text with @mentions highlighted.
 * Mentions stored as @[Name](email) are rendered as styled spans.
 */
export function MentionText({ text }: MentionTextProps) {
  const parts: ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  const regex = new RegExp(MENTION_REGEX)

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
