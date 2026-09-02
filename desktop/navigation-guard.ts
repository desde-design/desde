/**
 * Decides whether a URL is one of THIS app's own served origins — the
 * launcher, or a per-project editor it spawned — and therefore safe to load
 * in the app's window. Pulled into its own pure, `electron`-free module —
 * like `payload-resolve.ts` — specifically so it is unit-testable: `main.ts`
 * imports `electron`, and `require("electron")` outside an actual Electron
 * process returns a bare path string rather than the API surface, which
 * makes anything importing it impractical to test in plain Node/vitest.
 *
 * Used by `main.ts`'s `will-navigate` (and `will-redirect`) guards: a
 * same-window top-level navigation to anything OTHER than an allowlisted
 * origin must never load in this window — it would rerun the preload script
 * and hand the untrusted page the same `window.desdeDesktop` bridge
 * (`pickFolder`, settings writes) the launcher/editor pages get.
 * `setWindowOpenHandler` alone does not cover this: it only fires for NEW
 * window/tab requests, not a plain link or `window.location = …` navigating
 * the SAME window.
 *
 * **Membership, not just shape.** Every origin this app ever legitimately
 * navigates to is `http://127.0.0.1:<port>` — but that shape alone is not a
 * sufficient check: nothing stops SOME OTHER local process from also
 * listening on a loopback port, and a bug (or a markdown-rendered link
 * inside, say, a chat message) that navigated there would otherwise hand it
 * the SAME bridge. `trustedOrigins` is the explicit allowlist — seeded with
 * the launcher's own origin at boot, extended only when the UI itself vouches
 * for a newly-spawned editor's origin via `DesktopBridge.__trustOrigin`
 * (`desktop:trust-origin` IPC, called from `useLauncherApi`'s `openPath`
 * right before it navigates there). A URL must be BOTH loopback-http-shaped
 * AND a member of this set — shape alone is necessary, never sufficient.
 */
export function isTrustedNavigationTarget(url: string, trustedOrigins: ReadonlySet<string>): boolean {
  const origin = loopbackHttpOrigin(url)
  return origin !== null && trustedOrigins.has(origin)
}

/**
 * The normalized `origin` (`http://127.0.0.1:<port>`) of `url`, or `null` if
 * `url` doesn't parse or isn't loopback-http-shaped.
 *
 * Shared by two call sites that must apply the SAME shape check for
 * different reasons: {@link isTrustedNavigationTarget} uses it to check a
 * navigation TARGET; `main.ts`'s `desktop:trust-origin` IPC handler uses it
 * to validate what it's about to ADD to the trusted set. That second use is
 * load-bearing, not incidental — the IPC channel is reachable from the
 * renderer, so a handler that added whatever string arrived over it
 * unchecked would let a compromised renderer pre-poison the allowlist with a
 * non-loopback origin. Requiring the SAME shape on the way in as on the way
 * out closes that.
 */
export function loopbackHttpOrigin(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") return null
    return parsed.origin
  } catch {
    return null
  }
}
