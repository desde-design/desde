import { NEXT_ADAPTER } from "./next"
import { NUXT_ADAPTER } from "./nuxt"
import { REACT_ROUTER_ADAPTER } from "./react-router"
import { owningPackageDir } from "./fs-probe"
import type { BuildShape, BuildTarget, FrameworkAdapter } from "./types"

export type { BuildShape, BuildTarget, FrameworkAdapter } from "./types"

/** In order asked. */
export const ADAPTERS: FrameworkAdapter[] = [NEXT_ADAPTER, NUXT_ADAPTER, REACT_ROUTER_ADAPTER]

export async function inspectBuild(
  checkoutRoot: string,
  fallbackOutputDir: string,
  adapters: FrameworkAdapter[] = ADAPTERS,
): Promise<BuildShape> {
  // The configured output dir says which app the prototype is: its owning
  // package is where every adapter looks first (codex round 34).
  const target: BuildTarget = { within: await owningPackageDir(checkoutRoot, fallbackOutputDir) }
  for (const adapter of adapters) {
    const shape = await adapter.inspectBuild(checkoutRoot, target)
    if (shape) return shape
  }
  return {
    kind: "static",
    outputDir: fallbackOutputDir,
    reason: "No framework recognised; using the configured output dir",
  }
}
