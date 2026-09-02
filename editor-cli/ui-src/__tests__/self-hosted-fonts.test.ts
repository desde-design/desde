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
  it("finds at least one, so the assertions below are not vacuous", () => {
    // Without this, deleting the @font-face entirely would make every other
    // test in this file pass.
    expect(refs.length).toBeGreaterThan(0)
  })

  it("ship at the path the stylesheet points at", () => {
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
    // the file it is either `fonts/Chillax-Variable.woff2` or Vite's
    // fingerprinted `Chillax-Variable-3OGwrkmm.woff2`, and a name-based lookup
    // silently skips the second one instead of checking it.
    const sources = readdirSync(FONT_SOURCE_DIR)
      .filter((f) => /\.(woff2|woff|ttf|otf)$/.test(f))
      .map((f) => readFileSync(join(FONT_SOURCE_DIR, f)))
    expect(sources.length).toBeGreaterThan(0)

    for (const ref of refs) {
      const shipped = readFileSync(join(DIST, ref.resolvesTo))
      expect(
        sources.some((s) => s.equals(shipped)),
        `${ref.resolvesTo} does not match any font in ${FONT_SOURCE_DIR}`,
      ).toBe(true)
    }
  })

  it("includes the wordmark face, which is the one the product actually needs", () => {
    // Named explicitly: the checks above are generic and would still pass if
    // Chillax were dropped and some other face added.
    expect(refs.map((r) => r.url).join(" ")).toContain("Chillax-Variable.woff2")
  })
})

describe("the CSS that consumes them", () => {
  it("still declares the utility, so the font is not shipped for nothing", () => {
    const css = readdirSync(join(DIST, "assets"))
      .filter((f) => f.endsWith(".css"))
      .map((f) => readFileSync(join(DIST, "assets", f), "utf8"))
      .join("\n")
    expect(css).toMatch(/\.font-display\{font-family:Chillax/)
  })
})
