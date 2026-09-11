import { NEXT_ADAPTER } from "./next"
import { NUXT_ADAPTER } from "./nuxt"
import { REACT_ROUTER_ADAPTER } from "./react-router"
import type { BuildShape, FrameworkAdapter } from "./types"

export type { BuildShape, FrameworkAdapter } from "./types"

/** In order asked. */
export const ADAPTERS: FrameworkAdapter[] = [NEXT_ADAPTER, NUXT_ADAPTER, REACT_ROUTER_ADAPTER]

export async function inspectBuild(
  checkoutRoot: string,
  fallbackOutputDir: string,
  adapters: FrameworkAdapter[] = ADAPTERS,
): Promise<BuildShape> {
  for (const adapter of adapters) {
    const shape = await adapter.inspectBuild(checkoutRoot)
    if (shape) return shape
  }
  return {
    kind: "static",
    outputDir: fallbackOutputDir,
    reason: "No framework recognised; using the configured output dir",
  }
}
