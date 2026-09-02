/**
 * Serve-time CSS `url()` rewriting for hosted prototypes.
 *
 * This is a companion to `rewriteRootRelativeUrls` in `html-inject.ts`, but
 * it CANNOT be a runtime (in-browser) fix the way some other root-relative
 * gaps could be. `docs/superpowers/research/2026-08-24-prototype-origin-row5-runtime-shim.md`
 * measured this directly: a `fetch`/`XMLHttpRequest` patch and an import map
 * both work for JavaScript-issued requests, but neither one touches a CSS
 * `url()` fetch, because the browser's CSS engine issues that request
 * internally — there is no hook (`beforeload` or otherwise) that hands
 * JavaScript the URL before the network call fires. So this MUST be a
 * serve-time text rewrite, or it never happens at all.
 *
 * Why a text rewrite is safe here where a similar rewrite was rejected for
 * bundled JS (`docs/superpowers/research/2026-08-22-prototype-origin-bundler-landscape.md`,
 * Part 4): the objections there were about matching a bundler's exact
 * minified helper source, which is version- and minifier-specific and
 * changes silently. `url(...)` is not bundler output to guess at — it's a
 * single, well-specified CSS grammar construct that a minifier normalizes
 * (whitespace, quoting) but never restructures. Matching the grammar is
 * therefore stable across tool versions in a way matching a helper's source
 * text is not.
 *
 * NOT handled, on purpose, and left un-rewritten: a `url(...)`-shaped
 * substring sitting inside a CSS comment. A commented-out url() truly is
 * inert — the browser never parses comment contents at all, so leaving that
 * text untouched (rather than adding a masking pass, the way
 * `rewriteRootRelativeUrls` masks `<script>`/`<style>` blocks in HTML) costs
 * nothing observable.
 *
 * A `content: "url(...)"` string value is a DIFFERENT case, and it is NOT
 * inert — an earlier version of this function treated it the same as a
 * comment and got that wrong. `content`'s value is displayed text (rendered
 * via `::before`/`::after`), so rewriting the text inside that string would
 * change what the page visibly shows, not just what it fetches. This
 * function must never touch a standalone CSS string literal, and it
 * achieves that by matching strings and `url(...)` tokens in ONE
 * alternation (see the two-branch pattern below) rather than trying to
 * detect "am I inside a `content:` declaration" — the latter would need
 * real CSS parsing to do safely, the former does not.
 */
export function rewriteCssRootRelativeUrls(css: string, pathPrefix: string): string {
  const prefix = pathPrefix.endsWith("/") ? pathPrefix : `${pathPrefix}/`

  // Two top-level alternatives, scanned left to right by `.replace`:
  //
  //   1. A real `url(...)` TOKEN — `url(` + optional whitespace + a quoted
  //      or unquoted target + optional whitespace + `)`. Three explicit
  //      quote-handling branches inside it, not one shared character class:
  //      an earlier version used `([^"']*)` for "quoted", excluding BOTH
  //      quote characters instead of just the delimiting one, so a
  //      double-quoted target with an embedded single quote (a real, legal
  //      CSS string, e.g. `url("/fonts/o'clock.woff2")`) matched nothing.
  //      Each branch here stops only at its OWN delimiter:
  //        - double-quoted: url( "..." )  — content runs up to the next `"`.
  //        - single-quoted: url( '...' )  — content runs up to the next `'`.
  //        - unquoted:      url( ... )    — content runs up to whitespace,
  //          either quote, or `)` — exactly what CSS's own unquoted-url()
  //          grammar forbids unquoted (those characters need escaping to
  //          appear literally there).
  //   2. A STANDALONE CSS string literal — `"..."` or `'...'`, matched with
  //      no `url(` prefix required. This is what keeps `content:
  //      "url(/x)"` safe: `.replace` tries each starting position in the
  //      string left to right, and at the position of `content:`'s opening
  //      `"` neither the `u` of a `url(` token nor anything else can match
  //      alternative 1 (it requires the literal text `url(` right there,
  //      and the character at that position is a quote, not `u`).
  //      Alternative 2 matches instead, consuming the ENTIRE quoted string
  //      — including the `url(/x)` text inside it — as one unit, before the
  //      engine ever gets a chance to look for a `url(` token starting
  //      partway through that string. A real `url("/x")` token is
  //      unaffected: the scan reaches the `u` of `url(` first (nothing
  //      precedes it there), so alternative 1 matches there instead, and
  //      its own internal quoted-content branch handles the target exactly
  //      as before.
  //
  // Neither alternative filters for a root-absolute target — the callback
  // below does that, via `isRootAbsolute`, for url()-token matches only;
  // every standalone-string match is returned completely unchanged, whether
  // or not its content happens to look like a URL.
  //
  // Documented residual: `"[^"]*"` does not understand a backslash-escaped
  // quote (`content: "a \" mark"` — rare, but legal CSS). An escaped quote
  // would end the standalone-string match early, and text after it could in
  // principle be reached by the url()-token alternative. This fails the
  // same way the custom-property gap below does: a miss, not a corruption,
  // and it is not exercised by the test suite; treat it as an open edge
  // rather than a silently "handled" case.
  const pattern = /(?:(url)\(\s*(?:"([^"]*)"|'([^']*)'|([^\s"')]*))\s*\))|("[^"]*"|'[^']*')/gi

  return css.replace(
    pattern,
    (
      match: string,
      fn: string | undefined,
      doubleQuoted: string | undefined,
      singleQuoted: string | undefined,
      unquoted: string | undefined,
      standaloneString: string | undefined,
    ) => {
      // Alternative 2 matched: a bare string literal, not a url() token.
      // Always returned verbatim — see the doc comment above for why this
      // must never be touched, even when its content looks like a URL.
      if (standaloneString !== undefined) return match
      const quote = doubleQuoted !== undefined ? '"' : singleQuoted !== undefined ? "'" : ""
      const target = doubleQuoted ?? singleQuoted ?? unquoted ?? ""
      if (!isRootAbsolute(target)) return match
      // `fn` preserves the original casing (`url`, `URL`, `Url`, ...) — CSS
      // function names are ASCII case-insensitive, so a rewrite must not
      // silently normalize an author's casing. The target's own leading
      // `/` is stripped before the join — `prefix` already ends in `/`.
      return `${fn}(${quote}${prefix}${target.slice(1)}${quote})`
    },
  )
}

/**
 * A single leading `/` not followed by another `/` — root-absolute, and
 * specifically NOT protocol-relative (`//host/x`), absolute
 * (`https://...`), `data:`, a `#fragment`, or an ordinary relative
 * reference (`x`, `./x`, `../x`) — none of which start with a bare `/`.
 */
function isRootAbsolute(target: string): boolean {
  return target.startsWith("/") && !target.startsWith("//")
}

// KNOWN LIMIT, not closable by this function's approach: a CSS custom
// property that assembles a url() at compute time —
// `:root { --u: /x; } .bg { background: url(var(--u)); }` — is not
// rewritten. The literal text inside `url(...)` is `var(--u)`, not `/x`;
// the actual path only exists once the browser resolves the custom
// property, which happens after this text rewrite has already run. This is
// the CSS analogue of Reason 3 in the bundler-landscape research doc (values
// that never exist as one contiguous string in the source). It is a real
// gap, left open deliberately — see the css-rewrite test file for a pinned
// case proving this exact input passes through unchanged.
