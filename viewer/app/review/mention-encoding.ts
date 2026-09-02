/** Body mention format: @[displayName](participantId) — the id is OPAQUE (never an email). */
export const MENTION_PATTERN = /@\[([^\]]+)\]\(([^)]+)\)/g

export function encodeMention(displayName: string, participantId: string): string {
  return `@[${displayName}](${participantId})`
}

export function extractMentionIds(body: string): string[] {
  const ids: string[] = []
  for (const match of body.matchAll(MENTION_PATTERN)) {
    if (!ids.includes(match[2])) ids.push(match[2])
  }
  return ids
}
