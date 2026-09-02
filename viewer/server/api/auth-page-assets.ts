/**
 * The two files the server-rendered auth pages need to look like the rest of
 * the product: the portal illustration and the wordmark's typeface.
 *
 * Those pages are plain HTML served by Express, not Next (see
 * `auth-confirm-page.ts` for why they must stay inert), so they get no
 * bundler and cannot import a React component or a CSS `url()`. Both assets
 * are therefore read off disk at request time and served from their own
 * routes.
 *
 * **Read from the real source, never a copy.** The illustration is sliced out
 * of `CatAtPortal`'s own `.tsx` rather than duplicated into an `.svg` beside
 * this file. A duplicate is 137KB of drawing that nothing would ever tell us
 * had gone stale: the React surfaces would get a redrawn cat and these pages
 * would keep the old one, silently, for as long as nobody looked. The slice
 * is safe because that file's SVG uses exactly two JSX-only spellings,
 * `className={className}` and a bare `aria-hidden` (verified: those are the
 * only camelCase attribute and the only brace in the file). `viewBox` needs
 * no fixing at all, because the HTML parser's own SVG attribute table
 * corrects its case.
 *
 * Both assets are public and carry no credential, which is why they are
 * cacheable while the page that references them is `no-store`.
 *
 * A read that fails is not an error worth failing the page over: the route
 * 404s, the `<img>` renders as nothing and the `@font-face` falls back to the
 * sans stack. The page is still a readable, working sign-in.
 */

import { readFile } from "node:fs/promises"
import path from "node:path"
import type { Request, Response, Router } from "express"

/**
 * Where the repo root sits relative to this file, at runtime.
 *
 * `server/api/` → `viewer/` → the checkout. The viewer runs from source under
 * `tsx` (nothing is precompiled), so this is the same two levels up in
 * development and in the Docker image, whose `COPY . .` takes the whole
 * checkout including `src/`.
 */
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..")

const CAT_AT_PORTAL_TSX = path.join(REPO_ROOT, "src/components/blocks/cat-at-portal.tsx")
const CHILLAX_WOFF2 = path.join(REPO_ROOT, "src/styles/fonts/Chillax-Variable.woff2")

/**
 * The error-state drawing: two cats at a tablet (Mo, 2026-09-01).
 *
 * A plain `.svg` beside this file, unlike the portal, because no React
 * surface renders it — these two error pages are its only consumer. Making it
 * a component to match its sibling would be adding an export nothing imports,
 * which `knip` would rightly flag as dead. If a React surface ever needs it,
 * move it to `src/components/blocks/` as a component and slice it the way the
 * portal is sliced.
 */
const CATS_AT_TABLET_SVG = path.join(import.meta.dirname, "assets", "cats-at-tablet.svg")

/**
 * The absolute paths the pages reference. Absolute rather than relative
 * because the three pages sit at different depths (`/auth/invite/<token>`,
 * `/auth/signin/<token>`) and a relative URL would resolve differently from
 * each. `/api/v1` is where `createApiRouter` mounts.
 */
export const PORTAL_SVG_URL = "/api/v1/auth/page-asset/portal.svg"
export const CATS_SVG_URL = "/api/v1/auth/page-asset/cats.svg"
export const WORDMARK_FONT_URL = "/api/v1/auth/page-asset/wordmark.woff2"

/** Both assets are immutable for a given build; a year is the usual maximum. */
const IMMUTABLE = "public, max-age=31536000, immutable"

let portalSvgCache: string | null | undefined
let wordmarkFontCache: Buffer | null | undefined

/**
 * The illustration as a standalone SVG document.
 *
 * `undefined` means "not read yet", `null` means "read and failed" — kept
 * apart so a failure is remembered rather than retried on every request.
 */
async function readPortalSvg(): Promise<string | null> {
  if (portalSvgCache !== undefined) return portalSvgCache
  try {
    const source = await readFile(CAT_AT_PORTAL_TSX, "utf8")
    const start = source.indexOf("<svg")
    const end = source.lastIndexOf("</svg>")
    if (start === -1 || end === -1) {
      portalSvgCache = null
      return null
    }
    portalSvgCache = source
      .slice(start, end + "</svg>".length)
      // The two JSX-only spellings. `aria-hidden` becomes an explicit "true"
      // rather than being dropped: as a standalone document this is decoration
      // in an `<img>`, and an empty-valued `aria-hidden` is not valid ARIA.
      .replace(/\s*className=\{className\}/, "")
      .replace(/\s*aria-hidden(?![=-])/, ' aria-hidden="true"')
    return portalSvgCache
  } catch {
    portalSvgCache = null
    return null
  }
}

let catsSvgCache: string | null | undefined

async function readCatsSvg(): Promise<string | null> {
  if (catsSvgCache !== undefined) return catsSvgCache
  try {
    catsSvgCache = await readFile(CATS_AT_TABLET_SVG, "utf8")
    return catsSvgCache
  } catch {
    catsSvgCache = null
    return null
  }
}

async function readWordmarkFont(): Promise<Buffer | null> {
  if (wordmarkFontCache !== undefined) return wordmarkFontCache
  try {
    wordmarkFontCache = await readFile(CHILLAX_WOFF2)
    return wordmarkFontCache
  } catch {
    wordmarkFontCache = null
    return null
  }
}

/**
 * Mounts both asset routes. Called from `createAuthRoutes`, so they live
 * beside the pages that reference them and share their `/api/v1` prefix.
 */
export function registerAuthPageAssets(router: Router): void {
  router.get("/auth/page-asset/portal.svg", async (_req: Request, res: Response) => {
    const svg = await readPortalSvg()
    if (svg === null) {
      res.status(404).end()
      return
    }
    res.setHeader("Cache-Control", IMMUTABLE)
    res.type("image/svg+xml").send(svg)
  })

  router.get("/auth/page-asset/cats.svg", async (_req: Request, res: Response) => {
    const svg = await readCatsSvg()
    if (svg === null) {
      res.status(404).end()
      return
    }
    res.setHeader("Cache-Control", IMMUTABLE)
    res.type("image/svg+xml").send(svg)
  })

  router.get("/auth/page-asset/wordmark.woff2", async (_req: Request, res: Response) => {
    const font = await readWordmarkFont()
    if (font === null) {
      res.status(404).end()
      return
    }
    res.setHeader("Cache-Control", IMMUTABLE)
    res.type("font/woff2").send(font)
  })
}
