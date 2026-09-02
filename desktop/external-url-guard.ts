/**
 * Decides whether a URL is safe to hand to the OS via Electron's
 * `shell.openExternal` — and, if so, does the handing-off. Pulled into its
 * own pure, `electron`-free module — like `navigation-guard.ts` — so it is
 * unit-testable: `main.ts` imports `electron`, and `require("electron")`
 * outside a real Electron process does not return the real API surface,
 * which makes anything importing it directly impractical to exercise from
 * plain Node/vitest. `openExternalIfSafe` below takes the opener function
 * (normally `shell.openExternal`) as a parameter for that same reason — a
 * test supplies a fake and asserts on whether it was called, rather than
 * needing to mock the `electron` module itself.
 *
 * **Why this exists — reachable from untrusted content, not a theoretical
 * concern.** `main.ts` has three fallbacks that hand a URL straight to
 * `shell.openExternal`: the `setWindowOpenHandler` deny branch (any
 * `window.open()`/`target="_blank"`), the `will-navigate` guard's refusal
 * branch, and the `will-redirect` guard's refusal branch. All three are
 * reachable from the prototype iframe this app hosts
 * (`src/components/editor/live-prototype-pane.tsx`) — which is
 * UNSANDBOXED and renders the user's own (untrusted-by-design) prototype
 * code. `window.open(anyUrl)` from ANY frame, including that iframe, reaches
 * `setWindowOpenHandler` unconditionally; Electron does not scope it to the
 * main frame the way `will-navigate` is scoped.
 *
 * `shell.openExternal` applies **no scheme restriction of its own** — it
 * hands the URL to the OS's registered handler for whatever scheme it is.
 * Electron's own docs use `mailto:` as the canonical example, and the
 * Electron Security Checklist calls this API out by name as something that
 * must never receive untrusted input unfiltered. A `file:` URL opens a local
 * file or directory in the OS's default handler; `javascript:` (in the rare
 * handler that still honors it) can execute script outside any browser
 * context at all; a custom scheme (`desde:`, or one some OTHER
 * installed app registered) hands off to whatever that app does with it,
 * unreviewed. On Windows, `shell.openExternal` has a documented history of
 * unsafe-input-driven execution via the underlying `ShellExecute` call. None
 * of this needs a user gesture beyond the JS that was already running — a
 * malicious or compromised prototype calling
 * `window.open("file:///Users/<user>/…")` reaches the OS with nothing else
 * required.
 *
 * The fix is a strict allowlist, not a denylist: only `http:` and `https:`
 * — real web URLs — may reach `shell.openExternal`. Every other scheme,
 * known-dangerous or not, is refused. All three call sites route through
 * this ONE helper so they cannot drift out of sync on which schemes are
 * safe (the same "shared helper" discipline `navigation-guard.ts`'s
 * `loopbackHttpOrigin` already uses for its two call sites).
 */

/**
 * Whether `url` is a real web URL — `http:` or `https:` — and therefore safe
 * to hand to `shell.openExternal`. Returns `false` (never throws) for every
 * other scheme and for anything that fails to parse as a URL at all.
 */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

/**
 * Opens `url` via `openExternal` (normally `shell.openExternal`) ONLY when
 * {@link isSafeExternalUrl} allows it. On refusal, logs a clear, actionable
 * message to the console and no-ops — the URL is simply never handed to the
 * OS. Never throws into the caller: a synchronous throw from `openExternal`
 * itself, or a rejected promise it returns, is caught and logged rather than
 * propagating into one of Electron's `will-navigate`/`will-redirect`/
 * `setWindowOpenHandler` event handlers, none of which expect (or usefully
 * handle) an exception.
 */
export function openExternalIfSafe(
  url: string,
  openExternal: (url: string) => Promise<void> | void,
): void {
  if (!isSafeExternalUrl(url)) {
    console.warn(`[desktop] refused to open external url with a disallowed scheme: ${url}`)
    return
  }
  try {
    Promise.resolve(openExternal(url)).catch((err: unknown) => {
      console.error("[desktop] shell.openExternal failed:", err)
    })
  } catch (err) {
    console.error("[desktop] shell.openExternal failed:", err)
  }
}
