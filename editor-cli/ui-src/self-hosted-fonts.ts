import { readFileSync, existsSync, readdirSync } from "node:fs"
import path from "node:path"
import type { Plugin } from "vite"

/**
 * Ship the self-hosted font files the built CSS actually asks for, and fail
 * the build when one is missing.
 *
 * ## Why this exists
 *
 * `src/styles/globals.css` declares the wordmark face with a relative URL:
 *
 * ```css
 * src: url("./fonts/Chillax-Variable.woff2") format("woff2");
 * ```
 *
 * That file lives at `src/styles/fonts/`, which is in the monorepo root and
 * therefore OUTSIDE this Vite root (`editor-cli/ui-src/`). `globals.css`
 * reaches the bundle through the `@` alias and through `@tailwindcss/postcss`,
 * which flattens `@import`s — and the flattening loses the importer path, so
 * Vite cannot rebase the URL. It says so and carries on:
 *
 * ```
 * ./fonts/Chillax-Variable.woff2 referenced in ./fonts/Chillax-Variable.woff2
 * didn't resolve at build time, it will remain unchanged to be resolved at runtime
 * ```
 *
 * "Resolved at runtime" means a 404. MEASURED before this plugin existed: the
 * built CSS carried both the `@font-face` and
 * `.font-display{font-family:Chillax,ui-sans-serif,…}`, and no `.woff2` shipped
 * anywhere in `dist/`. The wordmark rendered in `ui-sans-serif` — the same face
 * as the `h1` beside it, which `src/components/blocks/wordmark.tsx` explicitly
 * relies on being different. `font-display: swap` is why this was invisible:
 * the fallback paints immediately, so there is no flash and no error a user
 * would see. It simply was not the font.
 *
 * Dev never showed it either. Under `vite dev` the file is served through
 * `server.fs.allow`, so every machine anyone looked at had a correct wordmark.
 * Only the built bundle was wrong, and only the built bundle ships.
 *
 * ## What it does
 *
 * Reads the emitted CSS, finds every `url(…woff2|woff|ttf|otf)` reference,
 * resolves it against that stylesheet's OWN output path (a `url()` is relative
 * to the file it appears in, so `./fonts/x.woff2` inside `assets/index-a1b2.css`
 * means `assets/fonts/x.woff2`), and emits the source file there.
 *
 * ## Why it throws
 *
 * The previous behaviour was a warning on stdout during a build that exits 0,
 * which is indistinguishable from noise — that is exactly how this shipped. A
 * referenced font with no file behind it is a broken build, so it fails like
 * one. The same guard covers any face added later without anyone re-reading
 * this comment.
 *
 * ## Why not just move the font, or use `public/`
 *
 * `globals.css` is shared with the Viewer and the marketing site, both on
 * Next's font pipeline, which resolves that same relative URL correctly and
 * fingerprints the file. Rewriting the URL to an absolute `/fonts/…` to suit
 * Vite would break the two builds that currently work. Copying the `.woff2`
 * into `editor-cli/` would create a second copy of a binary asset that drifts
 * silently from the licensed original. This keeps one source file and one
 * declaration, and adapts the only build that cannot follow them.
 */
export function selfHostedFonts(fontSourceDir: string): Plugin {
  // Matches `url(x)`, `url('x')` and `url("x")`, capturing the path only.
  const FONT_URL = /url\(\s*['"]?([^'")]+\.(?:woff2|woff|ttf|otf))['"]?\s*\)/g

  return {
    name: "desde:self-hosted-fonts",
    // `post` so Tailwind and Vite's own CSS handling have finished rewriting
    // URLs; what is in the bundle at this point is what the browser will fetch.
    enforce: "post",
    generateBundle(_options, bundle) {
      const missing: string[] = []
      const placed: string[] = []

      for (const [cssPath, chunk] of Object.entries(bundle)) {
        if (chunk.type !== "asset" || !cssPath.endsWith(".css")) continue
        const css = typeof chunk.source === "string" ? chunk.source : chunk.source.toString()

        for (const [, ref] of css.matchAll(FONT_URL)) {
          // Absolute URLs and data: URIs are somebody else's problem — they are
          // not files we are meant to place.
          if (/^(?:[a-z]+:)?\/\//i.test(ref) || ref.startsWith("data:") || ref.startsWith("/")) {
            continue
          }

          // Where the browser will look, given the stylesheet's own location.
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(cssPath), ref))
          if (bundle[target]) continue

          const source = path.join(fontSourceDir, path.basename(ref))
          if (!existsSync(source)) {
            missing.push(`${ref} (referenced by ${cssPath}, looked in ${fontSourceDir})`)
            continue
          }

          this.emitFile({ type: "asset", fileName: target, source: readFileSync(source) })
          placed.push(target)
        }
      }

      // Say so on stdout, immediately after Vite's own
      //
      //   ./fonts/X.woff2 ... didn't resolve at build time, it will remain
      //   unchanged to be resolved at runtime
      //
      // which still prints: Vite's reporter runs before this `post` plugin, so
      // that warning describes a moment that is no longer the final state. It
      // is now MISLEADING rather than wrong, and an unanswered warning is what
      // let this ship in the first place. One line naming what was placed
      // gives the next reader the answer in the same scroll.
      if (placed.length > 0) {
        console.log(`[desde:self-hosted-fonts] placed ${placed.join(", ")}`)
      }

      if (missing.length === 0) return

      // Two different situations, and conflating them would either break a
      // fresh clone or hide a real build error.
      //
      // The font source directory is EMPTY: this is a public checkout where
      // the licensed font has not been fetched yet. Chillax ships under the
      // ITF Free Font License, which permits embedding it in applications and
      // self-hosting it, and forbids redistribution "through ... a repository"
      // — so the binary is not in git and each person fetches their own copy,
      // which is exactly what that licence requires of them. Warn, and build.
      // The wordmark falls back to the body sans until they do, which is
      // cosmetic.
      //
      // The directory has fonts but not THIS one: something is inconsistent,
      // and shipping it means a 404 at runtime. That is a build error.
      const haveAnyFont =
        existsSync(fontSourceDir) &&
        readdirSync(fontSourceDir).some((f) => /\.(woff2|woff|ttf|otf)$/.test(f))

      const detail = missing.map((m) => `  - ${m}`).join("\n")
      if (!haveAnyFont) {
        console.warn(
          `[desde:self-hosted-fonts] no fonts found in ${fontSourceDir}, so the wordmark will ` +
            `render in the fallback sans.\n` +
            `  Fetch Chillax from https://www.fontshare.com/fonts/chillax and put ` +
            `Chillax-Variable.woff2 there. See CONTRIBUTING.md.\n${detail}`,
        )
        return
      }

      throw new Error(
        "The built CSS references font files that do not exist, so they would 404 at runtime:\n" +
          detail,
      )
    },
  }
}
