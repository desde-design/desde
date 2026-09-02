/**
 * Tailwind v4 runs as a PostCSS plugin for this harness.
 *
 * It lives in its own file rather than inline in `vite.config.ts` because both
 * `postcss` and `vite` resolve to two different copies from here — the repo
 * root's and `viewer/node_modules`' (vitest brings its own). Declared inline,
 * the plugin's type came from one copy and the config's expected type from the
 * other, and `tsc -p viewer/tsconfig.json` reported a wall of
 * structurally-identical-but-not-assignable errors. Vite loads this file by
 * convention, so nothing is lost.
 */
import tailwindcss from "@tailwindcss/postcss"

const config = {
  plugins: [tailwindcss()],
}

export default config
