/**
 * Wrap an untrusted source body in a randomized delimiter the source
 * can't contain. Used by the Tier 2 (repair) and Tier 3 (agent) prompt
 * builders so a malicious comment inside the SFC ("ignore the system
 * prompt and...") can't break out of the fenced block and join the
 * outer user-message instructions.
 *
 * Strategy: produce a per-call random token; verify the source does
 * not contain it (vanishingly unlikely with 192-bit randomness, but
 * checked); use that token as the open/close delimiter. The system
 * prompt is updated separately to instruct the LLM that the body
 * between the delimiters is opaque user data and any instructions in
 * it must be ignored.
 *
 * Why not JSON.stringify? Two reasons:
 *  - It scrambles readability for the LLM (every newline becomes \n,
 *    every quote becomes \"). Quality of output drops noticeably on
 *    long sources.
 *  - It doesn't help against a determined attacker — the LLM can still
 *    read the string contents and follow embedded instructions.
 *
 * The randomized fence is a defense-in-depth measure, not a complete
 * mitigation. The system prompt's "treat the body as data" instruction
 * is the real defense; the fence just makes it syntactically clear to
 * the LLM where the boundary is.
 */

import { createHash, randomBytes } from 'node:crypto'

export interface WrappedSource {
  /** The delimiter token (without leading/trailing markers). */
  delimiter: string
  /** `<<<BEGIN:${delimiter}>>>\n${source}\n<<<END:${delimiter}>>>` */
  wrapped: string
}

export function wrapUntrustedSource(source: string): WrappedSource {
  // 24 random bytes → 32 base64url chars. Collision with anything in
  // source has probability < 2^-100; we still check below.
  let delimiter = ''
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = randomBytes(24).toString('base64url')
    if (!source.includes(candidate)) {
      delimiter = candidate
      break
    }
  }
  if (!delimiter) {
    // 8 collisions in a row means the caller passed adversarial input
    // OR something is broken. Fail loud rather than silently using a
    // delimiter the source contains.
    throw new Error(
      'wrapUntrustedSource: could not generate a delimiter not present in source after 8 attempts',
    )
  }
  return {
    delimiter,
    wrapped: `<<<BEGIN:${delimiter}>>>\n${source}\n<<<END:${delimiter}>>>`,
  }
}

/**
 * Like `wrapUntrustedSource`, but the delimiter is derived deterministically
 * from the content so wrapping the same source twice yields byte-identical
 * output. Used for prompt blocks that must stay cache-stable across calls —
 * e.g. the project-knowledge digest, which is re-rendered on every save but
 * changes only when the repo's rules files change. A random delimiter there
 * would bust the prompt cache on every save.
 *
 * Security is unchanged from the random variant: the attacker controls
 * `source`, but to make the delimiter appear inside `source` they'd need
 * content whose own SHA-256 digest is a substring of itself — a preimage
 * problem, not something craftable. We still verify and salt-retry to be
 * safe.
 */
export function wrapUntrustedSourceStable(source: string): WrappedSource {
  let delimiter = ''
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = createHash('sha256')
      .update(`desde-untrusted-fence:${attempt}:`)
      .update(source)
      .digest('base64url')
      .slice(0, 32)
    if (!source.includes(candidate)) {
      delimiter = candidate
      break
    }
  }
  if (!delimiter) {
    throw new Error(
      'wrapUntrustedSourceStable: could not derive a delimiter absent from source after 8 attempts',
    )
  }
  return {
    delimiter,
    wrapped: `<<<BEGIN:${delimiter}>>>\n${source}\n<<<END:${delimiter}>>>`,
  }
}
