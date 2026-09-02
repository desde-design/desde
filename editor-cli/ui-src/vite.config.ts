import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/postcss"
import path from "node:path"
import { selfHostedFonts } from "./self-hosted-fonts.js"

const cliRoot = import.meta.dirname
const repoRoot = path.resolve(cliRoot, "..", "..")

/**
 * D-0.5 UI bundle config.
 *
 * Tailwind v4 + shadcn theme CSS are wired here so the editor panels
 * (which use Tailwind utility classes throughout) actually render
 * correctly under the CLI bundle. The shared `globals.css` lives in the
 * parent at `src/styles/globals.css` and is imported via the `@/` alias
 * — the file's `@import "tailwindcss"` + `@import "shadcn/tailwind.css"`
 * pull the same theme tokens the rest of the monorepo uses.
 *
 * @ alias points at the parent monorepo's `src/` so the build pulls
 * React, zustand, lucide, radix-ui, the shadcn primitives, AND the
 * globals.css directly from there. editor-cli has its own minimal
 * node_modules for vite + the Vue compiler + the React plugin +
 * @tailwindcss/postcss; everything else flows up through node's
 * natural module resolution.
 */
export default defineConfig(({ mode }) => {
  // The shared `src/` tree reads
  // values via `process.env.NEXT_PUBLIC_*` so Next.js can inline them at
  // build time. Vite doesn't substitute bare `process.env.X` references
  // by default — and even with `envPrefix` set, it only exposes them via
  // `import.meta.env`. Load `.env*` from the repo root (where the
  // canonical `.env.local` lives) and `define` each NEXT_PUBLIC_* key
  // explicitly so the CLI bundle ends up byte-identical to the Next
  // build for those references.
  const env = loadEnv(mode, repoRoot, ["NEXT_PUBLIC_"])
  const envDefines: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    envDefines[`process.env.${key}`] = JSON.stringify(value)
  }

  return {
    root: cliRoot,
    server: {
      /*
        The Vite root is this directory, so `src/styles/fonts/` — where the
        self-hosted wordmark face lives — is 403 by default. It surfaces as a
        font-face `status: "error"`, which looks nothing like a permissions
        problem from the page. See `src/styles/globals.css`.

        This line used to end "Production builds never hit it: `url()` becomes
        a bundled asset." That was FALSE, and being written down is why nobody
        checked: the URL never resolved in a build, no `.woff2` shipped, and
        the wordmark rendered in the fallback sans for as long as the built UI
        has existed. `selfHostedFonts` below is what makes the production claim
        true, and it throws rather than warns when it cannot.
      */
      fs: { allow: [cliRoot, repoRoot] },
    },
    resolve: {
      alias: {
        "@": path.resolve(repoRoot, "src"),
      },
    },
    plugins: [react(), selfHostedFonts(path.resolve(repoRoot, "src", "styles", "fonts"))],
    css: {
      postcss: {
        plugins: [tailwindcss()],
      },
    },
    define: envDefines,
    build: {
      outDir: path.resolve(cliRoot, "dist"),
      emptyOutDir: true,
      sourcemap: true,
    },
  }
})
