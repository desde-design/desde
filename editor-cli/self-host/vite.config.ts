import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/postcss"
import path from "node:path"

const cliRoot = __dirname
const repoRoot = path.resolve(cliRoot, "..", "..")

/**
 * Editor self-host harness — a plain Vite + React app that renders the
 * REAL editor chrome (`src/components/editor/*`, `src/editor-ui/*`)
 * with mock data, so Editor can supervise + edit its own UI.
 *
 * This config is a deliberate mirror of `editor-cli/ui-src/vite.config.ts`:
 *   - `@` alias → the parent monorepo's `src/`, so the harness imports the
 *     real component source (edits land in real files — no clone, no
 *     port-back).
 *   - NEXT_PUBLIC_* `define`s match the Next build so any shared module
 *     that reads `process.env.NEXT_PUBLIC_*` resolves identically.
 *
 * Run it as a supervised prototype:
 *   desde editor-cli/self-host
 * The supervisor locates THIS vite.config, merges the bridge +
 * source-tag plugins, and serves the harness. See README.md.
 */
export default defineConfig(({ mode }) => {
  // Define the WHOLE `process.env` as a literal object — NOT per-key.
  //
  // Shared app code reads `process.env.NEXT_PUBLIC_*` at module load.
  // Under CLI supervision the harness is served from a git worktree
  // where `.env.local` (gitignored) is ABSENT, so `loadEnv` returns
  // nothing and per-key defines would be empty — leaving bare
  // `process.env.X` refs in the bundle, which throw "process is not
  // defined" in the browser and blank the page. Defining the whole
  // object makes every `process.env.X` resolve to a value (when
  // `.env.local` is present, e.g. standalone) or `undefined` (worktree).
  const env = loadEnv(mode, repoRoot, ["NEXT_PUBLIC_"])
  const processEnv = {
    NODE_ENV: mode === "production" ? "production" : "development",
    ...env,
  }

  return {
    root: cliRoot,
    server: {
      /*
        The Vite root is this directory, so `src/styles/fonts/` — where the
        self-hosted wordmark face lives — is 403 by default. It surfaces as a
        font-face `status: "error"`, which looks nothing like a permissions
        problem from the page. Production builds never hit it: `url()` becomes
        a bundled asset. See `src/styles/globals.css`.
      */
      fs: { allow: [cliRoot, repoRoot] },
    },
    resolve: {
      alias: {
        "@": path.resolve(repoRoot, "src"),
      },
    },
    plugins: [react()],
    css: {
      postcss: {
        plugins: [tailwindcss()],
      },
    },
    define: {
      "process.env": JSON.stringify(processEnv),
    },
  }
})
