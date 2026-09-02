/**
 * ReviewSurface — the agent's own, isolated "look & walk" surface.
 *
 * THE PROBLEM. When the chat agent reviews its own work it must navigate,
 * click, and screenshot the prototype. Historically all of that drove the
 * SINGLE live iframe the user is watching (via the bridge → postMessage →
 * the user's `<iframe>`), so the agent and the user fought over one mutable
 * surface: an agent auto-navigate yanked the user's page out from under them,
 * an agent click mutated shared app state, and the html2canvas capture
 * flickered the user's view.
 *
 * THE FIX. Give the agent a SEPARATE surface for its view+drive operations.
 * `ReviewSurface` is the host-neutral interface for that surface; the agent's
 * `navigate` / `interact` / `capture_screenshot` / `verify_edit` /
 * `verify_goal` handlers target it instead of the bridge. The user-context
 * reads (`get_selection` / `get_page_info` / `pin_selections`) stay on the
 * bridge — they're about the user's actual session, not the agent's.
 *
 * HOST-SWAPPABLE (the generalized-product rule). One interface, one impl per
 * host — exactly like {@link import('./framework-adapter').FrameworkAdapter}:
 *   - CLI today  → a headless Playwright Chromium sidecar
 *     ([editor-cli/src/review-surface/playwright-review-surface.ts]).
 *   - Electron   → a hidden offscreen `BrowserWindow` + `webContents.capturePage()`.
 *   - VS Code    → the same Playwright sidecar, spawned from the extension host.
 * Nothing here imports Playwright/Electron — keep it that way so core stays
 * framework- and host-neutral. See [tasks/editor-review-surface.md].
 *
 * The method shapes deliberately MIRROR the bridge reply contracts the
 * handlers already parse (`chat:navigate`, `chat:capture_screenshot`,
 * `chat:resolve_target`, `chat:perform_interact`, `chat:read_rendered_value`,
 * `chat:read_measurements`) so a handler can swap bridge↔surface with no
 * change to its downstream logic.
 */

import type { Measurements } from '../../types/bridge'
import type { RenderAccessor } from '../verification/types'

export type { Measurements, RenderAccessor }

/** A semantic (a11y-first) target description, mirroring `chat:resolve_target`. */
export interface ReviewTarget {
  /** ARIA role, e.g. 'button' | 'link' | 'textbox'. */
  role?: string
  /** Accessible name / visible label, e.g. 'Create model'. */
  name?: string
  /** Visible-text fallback when there's no accessible name. */
  text?: string
  /** Last-known-good selector to try first (replay cache). */
  selector?: string
}

/** Result of resolving a {@link ReviewTarget} (mirrors `chat:resolve_target`). */
export interface ReviewResolveResult {
  found: boolean
  selector?: string
  role?: string
  name?: string
}

export type ReviewInteractAction = 'click' | 'fill' | 'select'

/** A resolved interaction to perform (mirrors `chat:perform_interact`). */
export interface ReviewInteractInput {
  selector: string
  action: ReviewInteractAction
  /** Value to type (fill) / option to choose (select). */
  value?: string
}

/** Outcome of a {@link ReviewInteractInput} (mirrors `chat:perform_interact`). */
export interface ReviewInteractResult {
  ok: boolean
  error?: string
}

export type ReviewCaptureScope = 'viewport' | 'element' | 'selector'

export interface ReviewCaptureInput {
  scope: ReviewCaptureScope
  /** Required for scope:'selector'; for scope:'element' the caller resolves the
   * user's selection to a selector (via the bridge) and passes it here. */
  selector?: string
}

/**
 * Capture result (mirrors `chat:capture_screenshot`). `dataUrl` present on
 * success. On failure, `reason` carries the same machine-token the bridge path
 * uses (`no-match` | `no-image` | `unusable` | …) so the capture handler's
 * auto-navigate recovery keeps working unchanged.
 */
export interface ReviewCaptureResult {
  dataUrl?: string
  width?: number
  height?: number
  reason?: string
  /** Clean error message (no `[capture:…]` token) when `dataUrl` is absent. */
  error?: string
}

/** Page-context reply (mirrors `chat:get_page_info`), reported for the surface. */
export interface ReviewPageInfo {
  url: string
  route: string
  framework: string
  title?: string
}

/**
 * The agent's isolated review surface. All methods act on a surface the user
 * never sees. Implementations boot lazily and are reused across turns; see the
 * per-host registry. `dispose()` tears the surface down (close the
 * window/context/process) — called on session end / host shutdown.
 */
export interface ReviewSurface {
  /**
   * Navigate the surface to `route` (a pathname + optional hash, relative to
   * the prototype base URL). Resolves once the page has loaded.
   */
  navigate(route: string): Promise<{ route: string; alreadyThere: boolean }>

  /** Current page context of the surface (route the agent is actually on). */
  getPageInfo(): Promise<ReviewPageInfo>

  /** Resolve a semantic target to a stable selector on the current page. */
  resolveTarget(target: ReviewTarget): Promise<ReviewResolveResult>

  /** Perform a resolved interaction (click / fill / select). */
  performInteract(input: ReviewInteractInput): Promise<ReviewInteractResult>

  /** Capture a screenshot of the surface. */
  capture(input: ReviewCaptureInput): Promise<ReviewCaptureResult>

  /**
   * Read the rendered value off an element (text or attribute), for
   * `verify_edit`. `supported` is always true for a real surface (the gate the
   * bridge needed for old-bridge detection doesn't apply here).
   */
  readRenderedValue(
    selector: string,
    accessor: RenderAccessor,
  ): Promise<{ value: string | null; supported: true }>

  /** Read layout/contrast measurements off an element, for `verify_goal`. */
  readMeasurements(
    selector: string,
  ): Promise<{ measurements: Measurements | null; supported: true }>

  /** Last route the surface navigated to (sync, cached); undefined before first nav. */
  currentRoute(): string | undefined

  /** Tear down the surface (close browser/context). Idempotent. */
  dispose(): Promise<void>
}
