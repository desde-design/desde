/**
 * The `@mention` wire format, shared by both surfaces.
 *
 * Body mention format: `@[displayName](participantId)` — the id is OPAQUE
 * (never an email). `MentionText` renders it; the Viewer's comment routes
 * resolve the submitted `mentions` array against the project's real
 * participant directory before storing it, so a hand-typed id notifies
 * nobody.
 *
 * This module lives under `src/components/annotations/` rather than in the
 * Viewer because the composer that produces the format is now shared: the
 * Editor's comment popup and the Viewer's review shell both mount the same
 * `MentionInput`, and a second copy of this encoding is exactly how the two
 * surfaces would drift into writing bodies the other cannot read.
 */

/**
 * The name group excludes `[` as well as `]`.
 *
 * With `[^\]]+` a literal `@[` anywhere earlier in the body started a match
 * that ran straight through the next real mention, swallowing its `@[Name` as
 * part of its own name and stealing its id. Typing `@[design review ` and then
 * picking Bo produced one token whose name was `design review @[Bo`, which
 * rewrote text the writer never typed and moved their caret. Excluding `[`
 * makes that match fail at the stray bracket and pick up the real token
 * instead.
 *
 * This costs nothing: `encodeMention` strips `[` and `]` from the name, so no
 * token this product writes can carry one.
 */
export const MENTION_PATTERN = /@\[([^[\]]+)\]\(([^)]+)\)/g

/**
 * One entry in the @-mention directory.
 *
 * `email` is OPTIONAL and may be absent rather than empty: the Viewer's
 * `GET /projects/:id/participants` omits the field entirely for callers who
 * are not project insiders, so an anonymous reviewer on a public-link
 * prototype cannot harvest verified addresses (security audit S3). Code that
 * reads it must guard — an unguarded `.toLowerCase()` here once took the
 * whole picker down for those callers.
 */
export interface MentionParticipant {
  id: string
  displayName: string
  email?: string
}

/**
 * Writes the token, with the display name made safe to put inside it.
 *
 * A `]` in the name closes the name early and the pattern then matches
 * NOTHING at all: the mention silently becomes literal text, the raw
 * `@[Ana [Design] Whitfield](id)` markup is what gets sent, and nobody is
 * notified. Display names are free text from the invite and reviewer-identity
 * forms, so this is reachable rather than theoretical. Newlines are dropped
 * for a plainer reason: they would put a line break in the middle of the
 * sentence being written.
 *
 * Stripping is deliberate over escaping. An escape would be a wire-format
 * change that `MentionText` and the viewer's `stripMentionSyntax` would both
 * have to learn, for a name shape almost nobody has. `[` goes with `]` only
 * so the result reads as a name: half a bracket pair looks like a bug.
 *
 * The ID is passed through UNTOUCHED, on purpose. It is opaque and
 * server-generated, so it cannot carry the `)` that would break it, and
 * sanitizing it would trade a shape that cannot happen for one that can: an
 * altered id still looks like a mention, and the server's `resolveMentionIds`
 * would quietly drop it as a non-participant. Better to write the id we were
 * given.
 */
export function encodeMention(displayName: string, participantId: string): string {
  const name = displayName.replace(/[[\]\r\n]/g, "").trim()
  // A name made only of the characters above sanitizes to nothing, and the
  // pattern's name group needs at least one character: `@[](id)` matches
  // nothing at all, so it would ship as raw markup and notify nobody. That is
  // the exact failure the sanitizing exists to prevent, so it cannot be
  // allowed to cause it. Unreachable in practice (it takes a display name made
  // entirely of brackets and whitespace) but silent if it ever happened.
  return `@[${name || "someone"}](${participantId})`
}

export function extractMentionIds(body: string): string[] {
  const ids: string[] = []
  for (const match of body.matchAll(MENTION_PATTERN)) {
    if (!ids.includes(match[2])) ids.push(match[2])
  }
  return ids
}

/**
 * Finds the `@token` the cursor is currently inside, scanning back from
 * `cursor` to the nearest `@` with no whitespace in between. Returns `null`
 * when the cursor isn't inside a live mention token (no `@` on the line, or
 * whitespace already closed it) — that `null` is what hides the picker.
 *
 * A cursor sitting inside an ALREADY-ENCODED mention returns `null` too.
 * Without that check, clicking into `@[Mo Chang](p_1)` to edit the text
 * after it reopened the picker on the encoded token, and choosing a name
 * spliced a second mention into the middle of the first one.
 */
export function findActiveMentionToken(
  text: string,
  cursor: number,
): { start: number; query: string } | null {
  const upToCursor = text.slice(0, cursor)
  const at = upToCursor.lastIndexOf("@")
  if (at === -1) return null
  const query = upToCursor.slice(at + 1)
  if (/\s/.test(query)) return null
  // Inside an encoded mention that starts at this `@`? Its own `[` opens
  // immediately after it.
  //
  // Read that bracket from the FULL text, not from `upToCursor`. With the
  // caret parked directly after the `@` of `@[Mo](p_1)` the query is empty,
  // so a check against the substring before the caret sees nothing bracketed
  // and opens the picker on a mention that already exists — and choosing a
  // name then spliced a second one into the middle of it.
  if (text[at + 1] === "[") return null
  return { start: at, query }
}
