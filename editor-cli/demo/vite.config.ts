import tailwindcss from "@tailwindcss/postcss"
import path from "node:path"

/**
 * The bundled demo prototype.
 *
 * NO `import { defineConfig } from "vite"`, and that is load-bearing rather
 * than a style choice. `vite` is a devDependency here, because the Editor
 * supplies its own Vite when it supervises a prototype (see
 * `editor-cli/src/hosts/vite/host.ts`). But a `defineConfig` import has to
 * RESOLVE from this directory's own node_modules when Vite loads the config,
 * which a production install does not have. MEASURED: importing it made the
 * materialized demo fail to boot with "Cannot find package 'vite'", while
 * every unit test still passed. `defineConfig` is only a type helper; a plain
 * exported object is identical at runtime.
 *
 * No `@vitejs/plugin-react` either: Vite transforms `.tsx` natively, and the
 * Editor injects its own JSX source-tag plugin at serve time. The only cost is
 * Fast Refresh, which a demo does not need.
 */
const config = {
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  css: { postcss: { plugins: [tailwindcss()] } },
}

export default config
