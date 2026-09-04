/**
 * Resolved URLs for the two cat illustrations.
 *
 * `new URL("./name.webp", import.meta.url).href` is the ONE asset-import form
 * both bundlers agree on, and this file is the only place it is written.
 * MEASURED 2026-09-04 against a real Vite build and a real `next build` on
 * Next 16.3.4 under both Turbopack and `--webpack`:
 *
 * |                            | `import art from "./x.webp"` | `new URL(...)` |
 * | -------------------------- | ---------------------------- | -------------- |
 * | Vite (Editor UI, both galleries, both vitest runs) | a string  | a string |
 * | Next 16 / Turbopack (Viewer)                       | an OBJECT | a string |
 *
 * Next returns `StaticImageData` — `{src, width, height, blurWidth,
 * blurHeight}` — at every size, and never inlines. So `<img src={imported}>`
 * renders `src="[object Object]"` in the Viewer, and `<img src={imported.src}>`
 * is `undefined` under Vite. There is no static-import spelling that works in
 * both, which matters because `src/components/blocks/` is compiled by six
 * passes: five Vite (the shipped Editor UI, the two galleries, the two vitest
 * runs) and one Next.
 *
 * `new URL` is a string in all six. It also needs no ambient `*.webp`
 * declaration — the root project has none today, and the Viewer's
 * `next-env.d.ts` would type the same shared file differently. And it is
 * hydration-safe: Turbopack substitutes a shim whose `toString` returns the
 * bare `/_next/static/media/...` path, so the server HTML and the browser
 * agree byte for byte.
 *
 * Do NOT set a Vite `base`, or move the Editor UI under a path prefix, without
 * rechecking this. The Vite output resolves against the chunk's own URL, and a
 * break here is a missing image at runtime, not a build error.
 *
 * Under vitest both resolve to a `file://` href. That is harmless, but it is
 * why no test asserts on the literal `src` value.
 */

/** The cat in a box, animated. Shown while something is being opened or built. */
export const LOADING_CAT_SRC = new URL("./loading-cat.webp", import.meta.url).href

/** The sleeping cat, a still image. `EmptyState`'s `tone="failure"` picture. */
export const SLEEPING_CAT_SRC = new URL("./sleeping-cat.webp", import.meta.url).href
