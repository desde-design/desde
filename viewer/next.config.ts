import type { NextConfig } from "next"
import { fileURLToPath } from "node:url"

/**
 * The viewer shares the repo-root design system (src/components/ui,
 * src/components/blocks). Those files live outside this app directory,
 * so tracing must root at the repo, and the `@/*` tsconfig path (which
 * Next reads automatically) resolves them.
 */
const nextConfig: NextConfig = {
  outputFileTracingRoot: fileURLToPath(new URL("..", import.meta.url)),
}

export default nextConfig
