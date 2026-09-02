/**
 * Resolve the html2canvas callable across UMD shapes.
 *
 * We vendor **html2canvas-pro** (not stock html2canvas) so captures of
 * Tailwind v4 DOM — which uses modern CSS color functions like `oklch()`,
 * `lab()`, `lch()`, `color()` — don't throw "Attempting to parse an
 * unsupported color function". Stock html2canvas 1.4.1 (2022) predates
 * those and hard-fails on them.
 *
 * The catch: the two UMD builds expose the global differently.
 *   - stock html2canvas: `window.html2canvas` IS the callable function.
 *   - html2canvas-pro:   `window.html2canvas` is a module namespace object
 *                        with the function at `.default`.
 *
 * Both the flow ScreenshotGenerator and the element/selector capture in
 * comment-bridge load the vendored script and read `window.html2canvas`,
 * so they share this resolver to stay tolerant of either shape (and any
 * future re-vendor).
 */
export type Html2CanvasFn = (
  el: HTMLElement,
  opts?: Record<string, unknown>,
) => Promise<HTMLCanvasElement>

export function resolveHtml2canvasGlobal(g: unknown): Html2CanvasFn | null {
  if (typeof g === "function") return g as Html2CanvasFn
  if (g && typeof g === "object") {
    const def = (g as { default?: unknown }).default
    if (typeof def === "function") return def as Html2CanvasFn
  }
  return null
}
