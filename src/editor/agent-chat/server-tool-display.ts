/**
 * What the chat panel shows for a server tool's result.
 *
 * A server tool (the vendor-run web search and web fetch) returns its result
 * in the vendor's own shape, and that shape is persisted UNTOUCHED because it
 * is replayed to the same vendor on the next request. It is not what a person
 * wants to read, though: a search result carries an encrypted blob per hit,
 * and a fetch result carries the whole page. So the panel shows a short
 * summary instead, built here, from BOTH ends that render one: the live
 * `tool_result` stream event (`neutral-event-adapter.ts`) and the transcript
 * rebuilt from a saved session (`turnsToChatMessages` in `useEditorChat.ts`).
 * One function, so a reload never changes what a finished turn says.
 *
 * Reads plain fields only (`url`, `title`, `errorCode`) and knows no vendor.
 * Anything it does not recognise falls back to a capped JSON rendering.
 */

/** Longest fallback rendering, in characters. */
const MAX_FALLBACK_CHARS = 2000

/** Most search hits listed before the rest are counted. */
const MAX_LISTED_HITS = 10

export function describeServerToolOutput(output: unknown): string {
  if (Array.isArray(output)) {
    if (output.length === 0) return 'No results.'
    const hits = output.filter(isRecord).filter((h) => typeof h.url === 'string')
    if (hits.length > 0) {
      const lines = hits.slice(0, MAX_LISTED_HITS).map((h) => hitLine(h))
      const more = hits.length - MAX_LISTED_HITS
      if (more > 0) lines.push(`and ${more} more`)
      return lines.join('\n')
    }
  }
  if (isRecord(output)) {
    if (typeof output.errorCode === 'string') {
      return `The provider could not complete this: ${output.errorCode}.`
    }
    if (typeof output.url === 'string') {
      const content = isRecord(output.content) ? output.content : undefined
      const title = content && typeof content.title === 'string' ? content.title : undefined
      return title ? `Fetched ${output.url}: ${title}` : `Fetched ${output.url}`
    }
  }
  if (typeof output === 'string') return cap(output)
  return cap(safeStringify(output))
}

function hitLine(hit: Record<string, unknown>): string {
  const url = hit.url as string
  return typeof hit.title === 'string' && hit.title.length > 0 ? `${hit.title} (${url})` : url
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cap(text: string): string {
  return text.length > MAX_FALLBACK_CHARS ? `${text.slice(0, MAX_FALLBACK_CHARS)}…` : text
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
