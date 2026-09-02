/**
 * Neutral entry for substrate STYLE capability detection — sibling of
 * `detect-framework.ts`, called once at CLI boot.
 *
 * Composes the substrate-specific detectors behind the adapter seam and returns
 * the neutral {@link SubstrateStyleCapabilities} the UI consumes. Adding a
 * substrate means adding a detector + one `||` here, never touching core,
 * verification, or the scope-decision logic.
 *
 * **Fail safe, always.** Detection is a UX enhancement: knowing the substrate
 * lets the inspector steer away from a style scope that cannot win there. If any
 * probe throws, or the substrate is unrecognized, this returns
 * {@link NO_SUBSTRATE_STYLE_CAPABILITIES} — i.e. exactly the behavior that
 * existed before capability detection, with every scope fully available. A
 * detection failure must never remove a working affordance.
 */
import {
  NO_SUBSTRATE_STYLE_CAPABILITIES,
  type SubstrateStyleCapabilities,
} from '../core/substrate-style-capabilities'
import { detectTailwindImportantMode } from '../adapters/tailwind'

export interface DetectStyleCapabilitiesResult {
  capabilities: SubstrateStyleCapabilities
  /**
   * Short human-readable note on WHY a capability is set (which probe matched,
   * in which file) — for the CLI boot log and the report; never user-facing copy.
   * Absent when nothing matched.
   */
  note?: string
}

/**
 * Probe `prototypeRoot` for the style capabilities that change what the
 * inspector offers. Never throws.
 */
export async function detectSubstrateStyleCapabilities(
  prototypeRoot: string,
): Promise<DetectStyleCapabilitiesResult> {
  try {
    const tailwind = await detectTailwindImportantMode(prototypeRoot)
    if (!tailwind.detected) {
      return { capabilities: NO_SUBSTRATE_STYLE_CAPABILITIES }
    }
    return {
      capabilities: { importantUtilities: true },
      note: tailwind.evidence
        ? `important utilities: ${tailwind.evidence.signal} (${tailwind.evidence.file})`
        : 'important utilities detected',
    }
  } catch {
    // Fail safe — behave exactly as if capability detection didn't exist.
    return { capabilities: NO_SUBSTRATE_STYLE_CAPABILITIES }
  }
}
