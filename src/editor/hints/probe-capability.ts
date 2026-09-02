/**
 * Answers one question: can this framework produce PROBE-derived rendering
 * hints (Phase 4 Task 3 — mount a real component in a headless browser,
 * feed it sentinel props/slot content, and observe where they land in the
 * DOM)? Today the answer is yes for Vue, no for everything else, including
 * React.
 *
 * This is the single place both the "Generate hints" client control
 * (`src/components/editor/design-systems-panel.tsx`) and the CLI's
 * `POST /api/editor/design-systems/:id/generate-hints` route
 * (`editor-cli/src/server/design-systems-handler.ts`) read the answer from —
 * the same both-ends-gate shape as the dormant `detach`/`swap` edit lanes in
 * `editor-cli/src/server/enabled-lanes.ts` (see CLAUDE.md, "Environment
 * variables and feature switches"). Gating only the button would leave the
 * route open to a stale client or a hand-built request; gating only the
 * route would leave a button that fails on click. Importing one predicate
 * from one place is what keeps the two answers from drifting apart.
 *
 * ── Why React is `false` today ──
 *
 * Probing needs a page to mount the component INTO, and neither half of
 * that page exists for React:
 *
 *   1. `editor-cli/src/core.ts` only wires up `composeIsolationPlugin` — the
 *      Vite plugin that serves the isolation route each probed component
 *      mounts into — when `framework !== "react"`. For a React host the
 *      route is never served at all.
 *   2. Even if it were served, the isolation page's own mount script
 *      hardcodes `import { createApp, h } from 'vue'`
 *      (`src/editor/substrate-plugins/vite-plugin-compose-isolation.ts`) —
 *      it has no React owner-resolver and cannot mount a React tree.
 *
 * Before this predicate existed, nothing checked either of those facts:
 * the "Generate hints" control was offered for every registered design
 * system regardless of framework, and a React user's click silently
 * produced `probed: 0, hinted: 0, verified: 0` (or, with the opt-in LLM
 * lane on, a hint file stamped `verified: false` that the attribution
 * trust gate — `isTrustedHint` in `src/editor/attribution/attribute.ts` —
 * always rejects). A dead control reporting a misleading success number.
 *
 * ── When to flip this ──
 *
 * Once a React mount script for the isolation page AND a React
 * owner-resolver (the runtime piece that tells the probe driver which DOM
 * subtree the mounted component actually rendered) both exist, this
 * function is the one place to change — flip `react` to `true` here and
 * both the button and the route pick it up with no other change needed.
 */

import type { FrameworkId } from '../core/manifest'

export function supportsProbeHints(framework: FrameworkId): boolean {
  return framework === 'vue3'
}
