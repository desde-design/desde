/**
 * CLI HTTP handler for `GET /api/editor/design-tokens` →
 * DesignToken[]. Returns the structured token list for the
 * prototype's installed design-system package(s). Drives token-aware
 * swatches in the inspector (color picker first; spacing/typography
 * to follow).
 *
 * The token source comes from the shared {@link GroundingService} (one source
 * of truth, also consumed by the agent's grounding tools), so the inspector
 * and the agent never diverge on token sourcing.
 *
 * Returns an empty array (not an error) when no recognized design-token
 * package is installed — token support is opt-in. The GroundingService token
 * source (`DeferredDesignTokenSource` over `buildDesignTokenSources` —
 * `src/editor/edit-service/design-tokens-source.ts`) itself degrades
 * gracefully: a single bad stylesheet source is warned + skipped, not fatal
 * to the rest of the composed token set (Phase 2 Task 3 — the earlier
 * fail-loud composite override was removed once there were multiple
 * independently-discovered sources instead of one fixed vendor source). This
 * handler's own 500 branch below is a generic safety net for the case where
 * the exposed `tokens.listTokens()` call rejects outright (or grounding
 * construction itself fails) — not a claim that any one source's failure
 * propagates here.
 */

import type { DesignToken, GroundingService } from "../../../src/editor/core"

/**
 * Result envelope. On the failure branch we keep `error` and `detail`
 * separate so the http-server can emit the SAME 500 JSON the web route
 * did (`{ error: 'failed-to-load-tokens', detail: '<message>' }`).
 * 503 cases set `error` only (no detail).
 */
export type DesignTokensResult =
  | { ok: true; status: 200; tokens: DesignToken[] }
  | { ok: false; status: number; error: string; detail?: string }

/**
 * Load design tokens via the GroundingService. `getGrounding` is null only when
 * no canonical root is configured (the server always has one, so this is the
 * defensive 503 path that preserves the original contract). It's resolved
 * INSIDE the try so a grounding-construction failure produces this endpoint's
 * JSON 500 (`failed-to-load-tokens`), not the server's generic 500.
 */
export async function getDesignTokens(
  getGrounding: (() => Promise<GroundingService>) | null,
): Promise<DesignTokensResult> {
  if (!getGrounding) {
    return {
      ok: false,
      status: 503,
      error: "EDITOR_PROTOTYPE_ROOT not configured",
    }
  }
  try {
    const grounding = await getGrounding()
    const tokens = await grounding.tokens.listTokens()
    return { ok: true, status: 200, tokens }
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: "failed-to-load-tokens",
      detail: (err as Error).message,
    }
  }
}
