import { execSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, posix, resolve as resolvePath } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"

/**
 * Regression guard: the fonts the built CSS asks for must actually ship.
 *
 * ## The bug this exists for
 *
 * `src/styles/globals.css` declares the wordmark face with a relative URL
 * (`url("./fonts/Chillax-Variable.woff2")`). That file lives in the monorepo
 * root, outside this Vite root, and `@tailwindcss/postcss` flattens the
 * `@import` chain that reaches it — so Vite could not rebase the URL, said so,
 * and exited 0:
 *
 *     ./fonts/Chillax-Variable.woff2 referenced in ./fonts/Chillax-Variable.woff2
 *     didn't resolve at build time, it will remain unchanged to be resolved at runtime
 *
 * At runtime there was nothing to resolve. MEASURED against the payload of a
 * real signed build: that exact URL returned 404, while the built CSS carried
 * both the `@font-face` and `.font-display{font-family:Chillax,…}`. Every
 * Editor surface rendered the wordmark in `ui-sans-serif`, the same face as
 * the `h1` beside it — which `src/components/blocks/wordmark.tsx` documents as
 * one of only two things telling them apart.
 *
 * Nothing caught it. `font-display: swap` means the fallback paints at once,
 * so there is no flash, no console error and no layout shift; and under
 * `vite dev` the file resolves through `server.fs.allow`, so the wordmark was
 * correct on every machine anyone actually looked at. Only the built bundle
 * was wrong, and only the built bundle ships.
 *
 * ## What is asserted
 *
 * The shipped property, not the mechanism: for every font URL in every built
 * stylesheet, a file exists where the browser will look for it. The
 * `selfHostedFonts` plugin is today's implementation; this test survives it
 * being replaced.
 */

const UI_SRC = resolvePath(__dirname, "..")
const DIST = resolvePath(UI_SRC, "dist")
const FONT_SOURCE_DIR = resolvePath(UI_SRC, "..", "..", "src", "styles", "fonts")

/** `url(x)`, `url('x')`, `url("x")` — captures the path of any font file. */
const FONT_URL = /url\(\s*['"]?([^'")]+\.(?:woff2|woff|ttf|otf))['"]?\s*\)/g

interface FontRef {
  /** The URL exactly as written in the built CSS. */
  url: string
  /** The stylesheet it appears in, relative to `dist/`. */
  from: string
  /** Where a browser fetching `from` would look, relative to `dist/`. */
  resolvesTo: string
}

let refs: FontRef[]

beforeAll(() => {
  // Build fresh rather than trusting whatever is on disk: a stale dist from a
  // previous good build would let a broken current one pass.
  //
  // `NODE_ENV=production` is NOT decoration, and this test is worthless
  // without it. MEASURED — same command, same config, four values:
  //
  //   NODE_ENV=production   url(./fonts/Chillax-Variable.woff2)          BROKEN
  //   NODE_ENV=<unset>      url(./fonts/Chillax-Variable.woff2)          BROKEN
  //   NODE_ENV=test         url(/assets/Chillax-Variable-3OGwrkmm.woff2) fine
  //   NODE_ENV=development  url(/assets/Chillax-Variable-3OGwrkmm.woff2) fine
  //
  // Vite rebases and fingerprints the font correctly in two of the four, and
  // production — the only one that ships — is not among them. Vitest sets
  // `NODE_ENV=test` for its children, so a `beforeAll` that simply shells out
  // builds the exact mode where the bug does not exist. This test was written
  // that way first and passed against the broken build.
  //
  // Same lesson as the jsdom accessible-name finding earlier in this run: a
  // test is only evidence about the environment it actually ran in, and the
  // default environment is rarely the shipping one.
  try {
    execSync("npx vite build --config ui-src/vite.config.ts", {
      cwd: resolvePath(UI_SRC, ".."),
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, NODE_ENV: "production" },
    })
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? ""
    throw new Error(`vite build failed, so there is nothing to assert against.\nstderr:\n${stderr}`)
  }

  refs = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith(".css")) continue
      const rel = posix.normalize(full.slice(DIST.length + 1).split(/[\\/]/).join("/"))
      for (const [, url] of readFileSync(full, "utf8").matchAll(FONT_URL)) {
        if (/^(?:[a-z]+:)?\/\//i.test(url) || url.startsWith("data:")) continue
        // A `url()` is relative to the stylesheet it sits in — NOT to the
        // output root. Getting this wrong is how the original fix attempt
        // would have placed the file one directory too high.
        const resolvesTo = url.startsWith("/")
          ? url.slice(1)
          : posix.normalize(posix.join(posix.dirname(rel), url))
        refs.push({ url, from: rel, resolvesTo })
      }
    }
  }
  walk(DIST)
})

describe("fonts referenced by the built CSS", () => {
  it("references none, because the product self-hosts no font any more", () => {
    // Inverted on 2026-09-02, when the wordmark became outlines and Chillax
    // was deleted (see `src/components/blocks/wordmark.tsx` and the note at
    // the top of `src/styles/globals.css`). It used to assert the opposite —
    // "finds at least one, so the assertions below are not vacuous" — which
    // was the right guard while a face was shipped.
    //
    // It is kept rather than deleted, and kept as an EQUALITY rather than a
    // deletion, because the tests below are generic: with zero refs they all
    // pass trivially. This line is what stops that from being silent. If a
    // self-hosted face is ever added, this fails first and points at the
    // three checks below that then start doing real work.
    expect(refs.map((r) => r.url)).toEqual([])
  })

  it("ship at the path the stylesheet points at", () => {
    // Vacuous today, and deliberately retained: this is the assertion that
    // caught the original bug, and it is the one that has to survive a face
    // being reintroduced.
    const missing = refs
      .filter((r) => !existsSync(join(DIST, r.resolvesTo)))
      .map((r) => `${r.url} in ${r.from} -> ${r.resolvesTo} (404)`)
    expect(missing).toEqual([])
  })

  it("are the real font files, byte for byte", () => {
    // A zero-length or placeholder file would satisfy the existence check
    // above while still rendering as the fallback face.
    //
    // Matched by CONTENT, not by name: depending on which code path placed
    // the file it is either `fonts/x.woff2` or Vite's fingerprinted
    // `x-3OGwrkmm.woff2`, and a name-based lookup silently skips the second.
    //
    // The source directory holds only a licence file now, so this loop has
    // nothing to iterate. The `sources.length` guard that used to sit here
    // was removed with the fonts: asserting a font source exists would fail
    // for the correct reason, which is not what a guard is for.
    if (refs.length === 0) return
    const sources = readdirSync(FONT_SOURCE_DIR)
      .filter((f) => /\.(woff2|woff|ttf|otf)$/.test(f))
      .map((f) => readFileSync(join(FONT_SOURCE_DIR, f)))

    for (const ref of refs) {
      const shipped = readFileSync(join(DIST, ref.resolvesTo))
      expect(
        sources.some((s) => s.equals(shipped)),
        `${ref.resolvesTo} does not match any font in ${FONT_SOURCE_DIR}`,
      ).toBe(true)
    }
  })
})

describe("the wordmark", () => {
  it("carries no Chillax reference into the built bundle", () => {
    // The licence reason, not just tidiness. The ITF Free Font License forbids
    // providing the Font Software to third parties, and a packaged desktop app
    // is exactly that. Nothing in a shipped build should name it.
    const files = readdirSync(join(DIST, "assets"))
    const bundled = files
      .filter((f) => f.endsWith(".css") || f.endsWith(".js"))
      .map((f) => readFileSync(join(DIST, "assets", f), "utf8"))
      .join("\n")
    expect(bundled).not.toContain("Chillax")
    expect(bundled).not.toMatch(/\.woff2?\b/)
  })

  it("ships as geometry instead", () => {
    // The replacement has to actually be in the bundle. Without this, deleting
    // the wordmark altogether would pass every assertion in this file.
    const js = readdirSync(join(DIST, "assets"))
      .filter((f) => f.endsWith(".js"))
      .map((f) => readFileSync(join(DIST, "assets", f), "utf8"))
      .join("\n")
    expect(js).toContain('aria-label')
    // The first moveTo of the extracted outline. Enough to prove the real path
    // shipped, short enough not to break on a regenerate that shifts later
    // coordinates.
    expect(js).toContain("Desde")
  })
})
