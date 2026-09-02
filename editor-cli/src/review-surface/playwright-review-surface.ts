/**
 * PlaywrightReviewSurface — the CLI implementation of {@link ReviewSurface}.
 *
 * A headless Chromium sidecar, driven by Playwright, that the chat agent uses
 * for ALL its view+drive operations (navigate / interact / capture_screenshot /
 * verify_edit + verify_goal DOM reads). It points at the SAME Vite URL the
 * user's iframe loads — so it sees the agent's auto-committed edits via HMR —
 * but it's a SEPARATE browsing context the user never sees. The agent walking
 * and screenshotting its own work no longer disrupts the user's live page.
 *
 * The browser boots LAZILY on first use (most turns never screenshot, and a
 * Chromium launch is ~hundreds of ms) and, on that first boot, navigates to
 * `initialRoute` — the route the user was on — so flows that assume "the page
 * the user is viewing" keep working without an extra navigate. After that the
 * agent's own `navigate` calls move the surface; the user is unaffected.
 *
 * Launch strategy mirrors the smoke runner: prefer the user's installed Chrome
 * (`channel: "chrome"`, no Playwright download), fall back to bundled Chromium.
 *
 * Native Playwright capture (`page.screenshot()`) also sidesteps the html2canvas
 * fidelity quirks (e.g. oklch) the bridge path has to work around — the images
 * the agent reasons over are pixel-accurate.
 *
 * Host-neutral interface lives in [src/editor/core/review-surface.ts]; this is
 * the one concrete impl for the CLI. Electron/VS Code get their own later.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright"

import type {
  Measurements,
  RenderAccessor,
  ReviewCaptureInput,
  ReviewCaptureResult,
  ReviewInteractInput,
  ReviewInteractResult,
  ReviewPageInfo,
  ReviewResolveResult,
  ReviewSurface,
  ReviewTarget,
} from "../../../src/editor/core/review-surface.js"

export interface PlaywrightReviewSurfaceOptions {
  /** Origin-only Vite URL the prototype is served at (e.g. `http://127.0.0.1:5173`). */
  viteUrl: string
  /** Resolved Vite base (slash-wrapped, e.g. `/` or `/app/`). Defaults to `/`. */
  viteBase?: string
  /** Detected framework, reported by `getPageInfo` so the agent's mental model matches. */
  framework?: string
  /** Route to open on first boot (mirror the user's current page). Defaults to `/`. */
  initialRoute?: string
  /** Optional explicit Chrome binary; otherwise channel:chrome → bundled chromium. */
  chromeExecutablePath?: string
  /** Viewport width. Defaults to 1280. */
  viewportWidth?: number
  /** Viewport height. Defaults to 800. */
  viewportHeight?: number
  /**
   * The turn's abort signal. On abort the surface disposes (closes the context),
   * which makes any in-flight Playwright op reject immediately ("Target closed")
   * instead of hanging until its timeout — so cancelling a turn mid-navigate/
   * capture winds down promptly, matching the bridge path's signal handling.
   */
  signal?: AbortSignal
}

const NAV_TIMEOUT_MS = 20_000
const ACTION_TIMEOUT_MS = 10_000
/** Bounded post-nav settle. Never wait on `networkidle`: a Vite HMR socket /
 *  polling connection keeps it from settling, so it would burn the full nav
 *  timeout on every visit (Playwright discourages networkidle for this reason). */
const SETTLE_TIMEOUT_MS = 3_000

/** Join an origin + base + route into an absolute URL, always pinned to the Vite origin. */
function joinUrl(viteUrl: string, viteBase: string, route: string): string {
  const origin = viteUrl.replace(/\/+$/, "")
  const base = (viteBase || "/").replace(/\/+$/, "")
  // If an absolute URL is passed, keep ONLY its path+search+hash and re-pin to
  // the prototype origin — the surface must never navigate off the worktree app
  // (matches the bridge path, which strips the origin).
  let path = route
  if (/^https?:\/\//i.test(route)) {
    try {
      const u = new URL(route)
      path = `${u.pathname}${u.search}${u.hash}`
    } catch {
      path = "/"
    }
  }
  // Exactly one leading slash, so origin (no trailing /) + base (no trailing /)
  // + suffix never yields a double slash even for a `/`-base or a `//foo` route.
  const suffix = `/${path.replace(/^\/+/, "")}`
  // Avoid doubling the base when the route already includes it.
  if (base && suffix.startsWith(base + "/")) return `${origin}${suffix}`
  if (base && suffix === base) return `${origin}${suffix}`
  return `${origin}${base}${suffix}`
}

/**
 * Pathname + search + hash of a URL — the "route" the agent reasons about.
 * Includes the query string so query-only navigations (`?q=old` → `?q=new`)
 * aren't collapsed to the same route (which would false-report `alreadyThere`
 * and skip the goto). Matches the bridge path's pathname+search+hash.
 */
function routeOf(url: string): string {
  try {
    const u = new URL(url)
    return `${u.pathname}${u.search}${u.hash}`
  } catch {
    return url
  }
}

/**
 * Launch a headless browser without forcing a Playwright download: explicit
 * binary → installed Chrome (`channel: "chrome"`) → bundled chromium. Throws if
 * none can launch (no system Chrome AND no installed Playwright browsers) — the
 * caller's launch probe turns that into a clean bridge fallback.
 */
/**
 * Navigate and wait with a bounded settle. Uses `domcontentloaded` (fast,
 * reliable) then a short, capped `load` wait for stylesheets/images and the
 * initial SPA render — deliberately NOT `networkidle`, which a Vite HMR socket
 * keeps from ever settling (→ 20s stalls on every nav).
 *
 * Exported (Phase 4 rendering-hints, Task 2) so `probe-page.ts`'s
 * `createProbePage()` can reuse the same bounded-settle navigation the
 * review surface uses, instead of re-deriving its own nav-wait policy.
 */
export async function gotoSettled(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS })
  await page.waitForLoadState("load", { timeout: SETTLE_TIMEOUT_MS }).catch(() => {})
}

export async function launchReviewBrowser(opts: {
  chromeExecutablePath?: string
}): Promise<Browser> {
  if (opts.chromeExecutablePath) {
    return chromium.launch({ executablePath: opts.chromeExecutablePath, headless: true })
  }
  try {
    return await chromium.launch({ channel: "chrome", headless: true })
  } catch {
    return chromium.launch({ headless: true })
  }
}

export class PlaywrightReviewSurface implements ReviewSurface {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page: Page | null = null
  private booting: Promise<Page> | null = null
  private route: string | undefined
  private disposed = false
  private readonly onAbort = (): void => {
    void this.dispose()
  }

  constructor(private readonly opts: PlaywrightReviewSurfaceOptions) {
    if (opts.signal) {
      if (opts.signal.aborted) this.disposed = true
      else opts.signal.addEventListener("abort", this.onAbort, { once: true })
    }
  }

  /** Lazily launch + navigate to the initial route. Concurrent callers share one boot. */
  private async ensurePage(): Promise<Page> {
    if (this.disposed) throw new Error("review surface has been disposed")
    if (this.page) return this.page
    if (this.booting) return this.booting
    this.booting = (async () => {
      const browser = await launchReviewBrowser({ chromeExecutablePath: this.opts.chromeExecutablePath })
      const context = await browser.newContext({
        viewport: {
          width: this.opts.viewportWidth ?? 1280,
          height: this.opts.viewportHeight ?? 800,
        },
        deviceScaleFactor: 1,
      })
      // The CLI runs this TS source under tsx (esbuild with keepNames), which
      // rewrites named inner declarations inside our `page.evaluate` bodies —
      // e.g. `const rectJson = …` in readMeasurements, `esc`/`uniq` in
      // buildSelectorFromHandle — into `__name(fn, "name")` calls. That helper
      // exists in the Node module scope but NOT in the browser page the closure
      // is serialized into, so those evaluates throw `ReferenceError: __name is
      // not defined`. Install an identity shim before any page script runs (on
      // every navigation). Passed as a raw string so tsx never transforms IT.
      await context.addInitScript(
        "globalThis.__name = globalThis.__name || function (f) { return f };",
      )
      const page = await context.newPage()
      this.browser = browser
      this.context = context
      // If the turn was aborted (dispose() called) while we were launching,
      // tear down what we just created instead of leaking a headless browser.
      // dispose() awaits this boot promise, so it won't double-close.
      if (this.disposed) {
        await context.close().catch(() => {})
        await browser.close().catch(() => {})
        this.browser = null
        this.context = null
        throw new Error("review surface disposed during boot")
      }
      this.page = page
      // Mirror the user's current page on first boot.
      const initial = this.opts.initialRoute ?? "/"
      const url = joinUrl(this.opts.viteUrl, this.opts.viteBase ?? "/", initial)
      await gotoSettled(page, url)
      this.route = routeOf(page.url())
      return page
    })()
    try {
      return await this.booting
    } finally {
      this.booting = null
    }
  }

  async navigate(route: string): Promise<{ route: string; alreadyThere: boolean }> {
    const page = await this.ensurePage()
    // A query-only (`?tab=logs`) or hash-only (`#details`) route is relative to
    // the CURRENT page (matches the bridge) — resolve it against the current URL
    // rather than joining it to the Vite root (which would drop the pathname).
    let target: string
    if (route.startsWith("?") || route.startsWith("#")) {
      try {
        target = new URL(route, page.url()).toString()
      } catch {
        target = joinUrl(this.opts.viteUrl, this.opts.viteBase ?? "/", route)
      }
    } else {
      target = joinUrl(this.opts.viteUrl, this.opts.viteBase ?? "/", route)
    }
    const targetRoute = routeOf(target)
    if (routeOf(page.url()) === targetRoute) {
      this.route = targetRoute
      return { route: targetRoute, alreadyThere: true }
    }
    await gotoSettled(page, target)
    this.route = routeOf(page.url())
    return { route: this.route, alreadyThere: false }
  }

  async getPageInfo(): Promise<ReviewPageInfo> {
    const page = await this.ensurePage()
    const url = page.url()
    let title = ""
    try {
      title = await page.title()
    } catch {
      // best-effort
    }
    return {
      url,
      route: routeOf(url),
      framework: this.opts.framework ?? "vue3",
      title,
    }
  }

  async resolveTarget(target: ReviewTarget): Promise<ReviewResolveResult> {
    const page = await this.ensurePage()
    // Trust the replay-cache selector only when it UNIQUELY resolves to a
    // VISIBLE element that still matches the requested role AND name. A stale
    // cache that now points at a different unique node (e.g. a heading named
    // "Save" when the target role is `button`) must NOT be trusted — fall
    // through to semantic resolution instead of acting on the wrong element
    // (mirrors the bridge resolver's visible+role+name gate).
    if (target.selector) {
      try {
        const loc = page.locator(target.selector)
        if ((await loc.count()) === 1) {
          const meta = await readElementMeta(page, target.selector)
          const wantRole = target.role?.trim().toLowerCase()
          const wantName = (target.name ?? target.text)?.trim().toLowerCase()
          const roleOk = !wantRole || meta?.role === wantRole
          const gotName = meta?.name?.trim().toLowerCase()
          const nameOk = !wantName || (!!gotName && gotName.includes(wantName))
          if (meta && meta.visible && roleOk && nameOk) {
            return { found: true, selector: target.selector, role: meta.role, name: meta.name }
          }
        }
      } catch {
        // fall through to semantic resolution
      }
    }
    // Semantic (a11y-first) resolution via Playwright's native engine.
    let locator
    if (target.role) {
      locator = page.getByRole(target.role as Parameters<Page["getByRole"]>[0], {
        name: target.name ?? target.text,
        exact: false,
      })
    } else if (target.name || target.text) {
      locator = page.getByText((target.name ?? target.text) as string, { exact: false })
    } else {
      return { found: false }
    }
    try {
      if ((await locator.count()) === 0) return { found: false }
      const handle = await locator.first().elementHandle({ timeout: ACTION_TIMEOUT_MS })
      if (!handle) return { found: false }
      const selector = await buildSelectorFromHandle(page, handle)
      await handle.dispose()
      if (!selector) return { found: false }
      const meta = await readElementMeta(page, selector)
      return { found: true, selector, role: meta?.role ?? target.role, name: meta?.name ?? target.name }
    } catch {
      return { found: false }
    }
  }

  async performInteract(input: ReviewInteractInput): Promise<ReviewInteractResult> {
    const page = await this.ensurePage()
    try {
      const loc = page.locator(input.selector).first()
      if (input.action === "click") {
        await loc.click({ timeout: ACTION_TIMEOUT_MS })
      } else if (input.action === "fill") {
        // Checkbox/radio: a "fill" is a checked-state set — the bridge maps
        // value "true"/"false" to checked. Text inputs get a value fill.
        // (selectOption/fill both fire real events, so framework reactivity
        // registers the change like the bridge's native-setter path.)
        const type = (await loc.getAttribute("type"))?.toLowerCase()
        if (type === "checkbox" || type === "radio") {
          await loc.setChecked(input.value === "true", { timeout: ACTION_TIMEOUT_MS })
        } else {
          await loc.fill(input.value ?? "", { timeout: ACTION_TIMEOUT_MS })
        }
      } else {
        // select: match by option VALUE first, then visible LABEL — the bridge
        // accepts either, but selectOption(string) alone only matches by value
        // (so a `<option value="us-east-1">US East</option>` selected by the
        // label "US East" would otherwise fail).
        const want = input.value ?? ""
        try {
          await loc.selectOption({ value: want }, { timeout: ACTION_TIMEOUT_MS })
        } catch {
          await loc.selectOption({ label: want }, { timeout: ACTION_TIMEOUT_MS })
        }
      }
      // Brief settle for app reactivity / client-side route change before the
      // agent reads/screenshots. Deliberately a short fixed wait, not
      // networkidle (a Vite HMR socket keeps that from settling → it would
      // always burn the full cap after every interaction).
      await page.waitForTimeout(350)
      this.route = routeOf(page.url())
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async capture(input: ReviewCaptureInput): Promise<ReviewCaptureResult> {
    const page = await this.ensurePage()
    try {
      if (input.scope === "viewport") {
        // 'viewport' scope is the WHOLE rendered page (matches the bridge path,
        // whose own handler notes "this is the rendered page, not strictly the
        // visible viewport"). Use fullPage so content below the fold is captured
        // — otherwise the agent can't see it and may misjudge a change. Large
        // pages may exceed the media size cap and be refused with a hint (same
        // contract as the tool description).
        const buf = await page.screenshot({ type: "png", fullPage: true })
        const dims = await page
          .evaluate(() => ({
            width: document.documentElement.scrollWidth,
            height: document.documentElement.scrollHeight,
          }))
          .catch(() => null)
        return {
          dataUrl: `data:image/png;base64,${buf.toString("base64")}`,
          width: dims?.width,
          height: dims?.height,
        }
      }
      // 'selector' (and 'element', which the handler translated to a selector).
      const selector = input.selector
      if (!selector) {
        return { reason: "no-image", error: "a selector is required for this scope" }
      }
      const loc = page.locator(selector).first()
      if ((await loc.count()) === 0) {
        return { reason: "no-match", error: `no element matched "${selector}" on the current page` }
      }
      const box = await loc.boundingBox()
      const buf = await loc.screenshot({ type: "png", timeout: ACTION_TIMEOUT_MS })
      return {
        dataUrl: `data:image/png;base64,${buf.toString("base64")}`,
        width: box ? Math.round(box.width) : undefined,
        height: box ? Math.round(box.height) : undefined,
      }
    } catch (err) {
      return { reason: "capture-error", error: err instanceof Error ? err.message : String(err) }
    }
  }

  async readRenderedValue(
    selector: string,
    accessor: RenderAccessor,
  ): Promise<{ value: string | null; supported: true }> {
    const page = await this.ensurePage()
    // Mirror the bridge's READ_RENDERED_VALUE semantics EXACTLY (comment-bridge.ts):
    //   text → textContent (plain);
    //   attr 'checked' on <input> → String(el.checked) (live property);
    //   attr 'value' on input/textarea/select → String(el.value) (live property,
    //     not the often-stale HTML attribute);
    //   attr other → getAttribute; style → getComputedStyle.
    const value = await page.evaluate(
      ({ sel, acc }): string | null => {
        const el = document.querySelector(sel)
        if (!el) return null
        if (acc.kind === "text") return el.textContent
        if (acc.kind === "style") {
          return getComputedStyle(el as Element).getPropertyValue(acc.name ?? "") || null
        }
        // attr
        if (!acc.name) return null
        if (acc.name === "checked" && el instanceof HTMLInputElement) {
          return String(el.checked)
        }
        if (
          acc.name === "value" &&
          (el instanceof HTMLInputElement ||
            el instanceof HTMLTextAreaElement ||
            el instanceof HTMLSelectElement)
        ) {
          return String(el.value)
        }
        return el.getAttribute(acc.name)
      },
      { sel: selector, acc: accessor },
    )
    return { value: value ?? null, supported: true }
  }

  async readMeasurements(
    selector: string,
  ): Promise<{ measurements: Measurements | null; supported: true }> {
    const page = await this.ensurePage()
    const measurements = await page.evaluate((sel): Measurements | null => {
      const el = document.querySelector(sel)
      if (!el) return null
      const rectJson = (r: DOMRect) => ({
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        left: r.left,
      })
      const cs = getComputedStyle(el as Element)
      const parent = el.parentElement
      const he = el as HTMLElement
      const tag = he.tagName.toLowerCase()
      // Mirror the bridge's measurements textContent special-case: form controls
      // have empty textContent, so read .value / selected-option .text.
      let textContent = el.textContent ?? ""
      if (tag === "input" || tag === "textarea") textContent = String((el as HTMLInputElement).value)
      else if (tag === "select") {
        const s = el as HTMLSelectElement
        textContent = String(s.selectedOptions?.[0]?.text ?? s.value)
      }
      return {
        bbox: rectJson(el.getBoundingClientRect()),
        scrollWidth: he.scrollWidth,
        clientWidth: he.clientWidth,
        scrollHeight: he.scrollHeight,
        clientHeight: he.clientHeight,
        parentBbox: parent ? rectJson(parent.getBoundingClientRect()) : null,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        computedStyle: {
          color: cs.color,
          backgroundColor: cs.backgroundColor,
          fontSize: cs.fontSize,
          display: cs.display,
          visibility: cs.visibility,
          opacity: cs.opacity,
          textTransform: cs.textTransform,
        },
        textContent,
      }
    }, selector)
    return { measurements: measurements ?? null, supported: true }
  }

  currentRoute(): string | undefined {
    return this.route
  }

  async dispose(): Promise<void> {
    this.opts.signal?.removeEventListener("abort", this.onAbort)
    if (this.disposed) return
    this.disposed = true
    this.page = null
    // Close whatever handles exist NOW — this interrupts an in-flight first-boot
    // page.goto immediately (it rejects with "Target closed") instead of waiting
    // for the 20s nav timeout. If the boot hasn't created the context yet, its
    // own post-newPage `disposed` check tears down whatever it creates, so there
    // is no leak even though we don't await the boot here.
    const ctx = this.context
    const br = this.browser
    this.context = null
    this.browser = null
    try {
      await ctx?.close()
    } catch {
      // ignore
    }
    try {
      await br?.close()
    } catch {
      // ignore
    }
  }
}

/**
 * Read implicit role + accessible name + visibility off an element pinned by
 * selector. Role inference mirrors the bridge resolver's (explicit role →
 * a[href] → button → input-type → textarea → select → heading), so a cached
 * selector can be role-gated before it's trusted.
 */
async function readElementMeta(
  page: Page,
  selector: string,
): Promise<{ role?: string; name?: string; visible: boolean } | null> {
  try {
    return await page.evaluate((sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const tag = el.tagName.toLowerCase()
      let role = el.getAttribute("role") ?? undefined
      if (!role) {
        if (tag === "a" && el.hasAttribute("href")) role = "link"
        else if (tag === "button") role = "button"
        else if (tag === "textarea") role = "textbox"
        else if (tag === "select") role = (el as HTMLSelectElement).multiple ? "listbox" : "combobox"
        else if (/^h[1-6]$/.test(tag)) role = "heading"
        else if (tag === "input") {
          const t = ((el as HTMLInputElement).type || "text").toLowerCase()
          role =
            t === "checkbox"
              ? "checkbox"
              : t === "radio"
                ? "radio"
                : t === "button" || t === "submit" || t === "reset" || t === "image"
                  ? "button"
                  : t === "search"
                    ? "searchbox"
                    : t === "number"
                      ? "spinbutton"
                      : t === "range"
                        ? "slider"
                        : t === "hidden"
                          ? undefined
                          : "textbox"
        }
      }
      const name =
        el.getAttribute("aria-label") ??
        (el.textContent ? el.textContent.trim().slice(0, 120) : undefined)
      const he = el as HTMLElement
      // Visible ≈ has layout boxes (covers display:none / detached / 0-size).
      const visible = he.getClientRects().length > 0
      return { role: role ?? undefined, name: name || undefined, visible }
    }, selector)
  } catch {
    return null
  }
}

/**
 * Build a stable-ish CSS selector for a resolved element, mirroring the bridge
 * selector-engine priority: id (non-dynamic) → data-testid → aria-label →
 * nth-of-type path. Runs in page context against the live element.
 */
async function buildSelectorFromHandle(
  page: Page,
  handle: import("playwright").ElementHandle<Node>,
): Promise<string | null> {
  return page.evaluate((node) => {
    const el = node as Element
    if (!el || el.nodeType !== 1) return null
    const DYNAMIC = /[0-9a-f]{8,}|^[a-z]{1,2}-?\d+$/i
    const esc = (s: string) =>
      (window as unknown as { CSS?: { escape?: (v: string) => string } }).CSS?.escape
        ? (window as unknown as { CSS: { escape: (v: string) => string } }).CSS.escape(s)
        : s.replace(/[^a-zA-Z0-9_-]/g, "\\$&")
    // Only trust a short candidate if it UNIQUELY identifies the element — a
    // repeated data-testid / aria-label (list rows, cards) would otherwise
    // resolve to the wrong node via locator(...).first(). Fall through to the
    // nth-of-type path when not unique (mirrors the bridge selector engine).
    const uniq = (sel: string): boolean => {
      try {
        return document.querySelectorAll(sel).length === 1
      } catch {
        return false
      }
    }
    if (el.id && !DYNAMIC.test(el.id)) {
      const s = `#${esc(el.id)}`
      if (uniq(s)) return s
    }
    const testid = el.getAttribute("data-testid")
    if (testid) {
      const s = `[data-testid="${testid}"]`
      if (uniq(s)) return s
    }
    const aria = el.getAttribute("aria-label")
    if (aria) {
      const s = `${el.tagName.toLowerCase()}[aria-label="${aria}"]`
      if (uniq(s)) return s
    }
    // nth-of-type path up to <body>.
    const parts: string[] = []
    let cur: Element | null = el
    while (cur && cur.nodeType === 1 && cur.tagName.toLowerCase() !== "html") {
      const tag = cur.tagName.toLowerCase()
      if (cur.id && !DYNAMIC.test(cur.id)) {
        parts.unshift(`#${esc(cur.id)}`)
        break
      }
      const parent: Element | null = cur.parentElement
      if (!parent) {
        parts.unshift(tag)
        break
      }
      const sameTag = Array.from(parent.children).filter(
        (c) => c.tagName === cur!.tagName,
      )
      const idx = sameTag.indexOf(cur) + 1
      parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${idx})` : tag)
      cur = parent
    }
    return parts.join(" > ")
  }, handle)
}
