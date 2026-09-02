import path from "node:path"
import { fileURLToPath } from "node:url"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

const galleryRoot = path.dirname(fileURLToPath(import.meta.url))
const viewerRoot = path.resolve(galleryRoot, "..")
const repoRoot = path.resolve(viewerRoot, "..")

/**
 * Viewer surface gallery — a plain Vite + React app that renders the REAL
 * viewer screens (`viewer/app/**`) with fixture data, so every screen, dialog
 * and error state can be looked at without a running server.
 *
 * The Editor has the same instrument (`editor-cli/self-host`, `npm run
 * gallery`). This is deliberately its sibling rather than its clone: the
 * Editor's harness boots ONE page (`EditorPage`) and overlays fixtures on it,
 * because the Editor is one screen. The viewer is several unrelated screens,
 * so here the picker IS the shell and each surface renders in place of the
 * others.
 *
 * Three seams make a Next.js app boot under plain Vite. Each is narrow and
 * each is here for a measured reason, not for convenience:
 *
 *  1. `next/link` -> `harness/shims/next-link.tsx`. Five viewer files import
 *     it, all for ordinary in-app navigation. The shim is an `<a>`.
 *  2. `viewer/server/config` -> `harness/shims/server-config.ts`. Three SERVER
 *     components (`app/page.tsx`, `app/review/[slug]/not-found.tsx`,
 *     `app/setup/page.tsx`) call `loadConfig()`. The real module imports
 *     `node:crypto`, which cannot be bundled for a browser. The shim serves
 *     a fixture `ViewerConfig` that a fixture can vary, which is what makes
 *     "serve domain configured", "GitHub sign-in configured" and "GitHub App
 *     configured" reviewable states rather than guesses.
 *  3. `window.fetch` is patched at boot (`harness/mock-backend.ts`), because
 *     every viewer panel loads itself from `/api/v1/*`.
 *
 * Both module shims are resolved by absolute path (below) rather than by
 * import specifier: the two importers spell the same module `../server/config`
 * and `../../../server/config`, so a `resolve.alias` string could not match
 * both without also matching unrelated paths.
 */
function viewerGalleryShims(): Plugin {
  const serverConfigTarget = path.join(viewerRoot, "server", "config")
  const shim = path.join(galleryRoot, "harness", "shims", "server-config.ts")

  return {
    name: "viewer-gallery-shims",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer || !source.startsWith(".")) return null
      const resolved = path.resolve(path.dirname(importer), source)
      if (resolved === serverConfigTarget) return shim
      return null
    },
  }
}

/**
 * Serve `public/p/<slug>/index.html` for a request to `/p/<slug>/`.
 *
 * The review screen frames the prototype at exactly that path, and there is a
 * stand-in page under `public/` for it to load. Without this the request falls
 * through to Vite's single-page fallback, which answers EVERY unmatched path
 * with the gallery's own `index.html` — so the gallery loaded a second copy of
 * itself inside the review screen's iframe, complete with a second picker
 * rail. MEASURED, not hypothetical.
 *
 * Registered in the plugin body rather than from a returned function, which
 * puts it ahead of Vite's own middleware stack — the rewrite has to happen
 * before the static handler looks at the URL, not after the fallback has
 * already answered.
 */
function fakePrototypeServing(): Plugin {
  return {
    name: "viewer-gallery-fake-prototype",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url) {
          req.url = req.url.replace(/^(\/p\/[^/?#]+)\/(?=$|[?#])/, "$1/index.html")
        }
        next()
      })
    },
  }
}

export default defineConfig({
  root: galleryRoot,
  resolve: {
    alias: [
      // The shared design system + the shared bridge/comment types live in
      // the repo-root `src/`, exactly as `viewer/tsconfig.json` maps them.
      { find: "@", replacement: path.join(repoRoot, "src") },
      { find: "next/link", replacement: path.join(galleryRoot, "harness", "shims", "next-link.tsx") },
    ],
  },
  plugins: [react(), viewerGalleryShims(), fakePrototypeServing()],
  // Tailwind v4 is wired in `postcss.config.mjs`, which Vite loads by
  // convention — see that file for why it is not inline here.
  // Viewer client code reads `process.env.NODE_ENV` transitively (React, and
  // `@/lib/*` helpers). Define the whole object rather than per key, so a
  // `process.env.ANYTHING` reference resolves to `undefined` instead of
  // throwing "process is not defined" and blanking the page.
  define: {
    "process.env": JSON.stringify({ NODE_ENV: "development" }),
  },
  server: {
    port: 5281,
    strictPort: true,
    fs: {
      /*
        The gallery's Vite root is this directory, so everything outside it is
        403 by default — including `src/styles/fonts/`, where the self-hosted
        wordmark face lives (see the `@font-face` in `src/styles/globals.css`).

        It failed as a font-face `status: "error"` with the file 403ing on
        Vite's `@fs/` path, which looks nothing like a permissions problem
        from the page. A production build never hits this: `url()` becomes a
        bundled asset. Dev only, and only because the font is deliberately
        shared by four surfaces rather than copied into each one's `public/`.
      */
      allow: [galleryRoot, repoRoot],
    },
  },
})
