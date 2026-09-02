/**
 * Navigate the top-level window to another origin, vouching for it to the
 * desktop shell first.
 *
 * In the desktop app every origin is a loopback port picked at runtime, and
 * the shell's `will-navigate` guard (`desktop/navigation-guard.ts`) trusts
 * only origins it has been told about. A hop it has not been told about is
 * not blocked, it is handed to the system browser, which is worse: the user
 * lands in a browser tab that looks like the app. `openPath` has always sent
 * `__trustOrigin` before navigating; `goToEditorHome` did not, and the
 * breadcrumb's Home button opened a browser tab from the packaged app
 * (MEASURED 2026-09-01). Every cross-origin top-level navigation goes through
 * this one function so the vouch cannot be forgotten a third time.
 *
 * The vouch is awaited, not fired and forgotten: the navigation must not
 * reach the guard before the IPC lands. A rejected vouch is swallowed, since
 * outside the desktop shell there is nothing to vouch to, and inside it the
 * navigation may still be refused but the caller must not crash.
 */
export async function navigateTopLevel(url: string): Promise<void> {
  await window.desdeDesktop?.__trustOrigin?.(url).catch(() => {})
  window.location.href = url
}
