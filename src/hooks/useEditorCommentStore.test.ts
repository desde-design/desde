/**
 * `resolveCommentSyncMode` is the pure gating decision behind the editor's
 * comment store; `useEditorCommentStore` is a thin wrapper over it, so
 * testing the function covers the behaviour without mounting React/Zustand.
 *
 * The legacy client-direct Firestore path was removed — there is no `cloud`
 * mode and no Firebase involvement in comment sync at all. Comments either
 * sync with a configured viewer over its HTTP API, or stay local.
 */
import { describe, expect, it } from "vitest"
import { resolveCommentSyncMode } from "./useEditorCommentStore"

describe("resolveCommentSyncMode", () => {
  const linked = { online: true, viewerConfigured: true, viewerHasToken: true }

  it("syncs with the viewer when configured, credentialed, and online", () => {
    expect(resolveCommentSyncMode(linked)).toEqual({ mode: "viewer", needsViewerToken: false, resolving: false })
  })

  it("stays local when no viewer is configured for the repo", () => {
    expect(
      resolveCommentSyncMode({ online: true, viewerConfigured: false, viewerHasToken: false }).mode,
    ).toBe("local")
  })

  /**
   * Configured-but-no-token is a DISTINCT, actionable state ("paste a
   * token"), not the plain local-only badge — which reads as "nothing to do
   * here" and would leave someone wondering why their comments never reach
   * the viewer.
   */
  it("flags needsViewerToken when a viewer is configured but this machine has no token", () => {
    const r = resolveCommentSyncMode({ ...linked, viewerHasToken: false })
    expect(r.mode).toBe("local")
    expect(r.needsViewerToken).toBe(true)
  })

  it("does not claim viewer sync while offline", () => {
    const r = resolveCommentSyncMode({ ...linked, online: false })
    expect(r.mode).toBe("local")
    // Still not a token problem — saying so would send the user to fix
    // something that isn't broken.
    expect(r.needsViewerToken).toBe(false)
  })

})

/**
 * The loading window.
 *
 * `useViewerAuthStatus` starts at `status: null, loading: true`, so on the
 * first render of a LINKED repo `viewerConfigured` and `viewerHasToken` are
 * unknown — not false. Reading them as false hands back the local store, and
 * a comment placed in that window is written to `.desde/comments.json`
 * for a repo configured to sync to a viewer: silently misfiled, into a file
 * the team never reads. Found by codex review 2026-08-09.
 *
 * `mode` deliberately stays "local" while resolving — something has to render
 * and local reads are harmless. It is WRITING that must wait, which is what
 * the separate `resolving` flag is for.
 */
describe("resolveCommentSyncMode — the unknown window", () => {
  it("reports resolving while the viewer-auth status is outstanding", () => {
    expect(
      resolveCommentSyncMode({
        online: true,
        viewerConfigured: false,
        viewerHasToken: false,
        resolving: true,
      }),
    ).toEqual({ mode: "local", needsViewerToken: false, resolving: true })
  })

  it("does not report resolving once the status has landed", () => {
    expect(
      resolveCommentSyncMode({
        online: true,
        viewerConfigured: true,
        viewerHasToken: true,
        resolving: false,
      }),
    ).toEqual({ mode: "viewer", needsViewerToken: false, resolving: false })
  })

  it("defaults to not-resolving when the caller omits it", () => {
    // Back-compat for callers written before the flag existed; they must not
    // silently start blocking writes.
    expect(
      resolveCommentSyncMode({ online: true, viewerConfigured: false, viewerHasToken: false }).resolving,
    ).toBe(false)
  })
})

/**
 * The FAILURE window, distinct from the loading window.
 *
 * `useViewerAuthStatus` keeps the last known status when a refresh fails —
 * but on first load there is none, so `status` stays null while `loading`
 * flips false. Keying "unknown" on `loading` therefore let a transient 500
 * or a dropped connection unblock local writes on a LINKED repo: the same
 * misfiled comment this flag exists to prevent, arriving by the error path.
 * Found by codex review 2026-08-09.
 *
 * The real question is "did the status arrive?", and for an UNLINKED repo it
 * does not matter at all — local is simply correct there.
 */
describe("resolveCommentSyncMode — unknown after a FAILED status request", () => {
  it("stays unresolved for a linked repo whose status never arrived", () => {
    expect(
      resolveCommentSyncMode({
        online: true,
        viewerConfigured: false,
        viewerHasToken: false,
        resolving: true, // caller passes `status === null && repo is linked`
      }).resolving,
    ).toBe(true)
  })

  it("does not block an unlinked repo, which needs no status at all", () => {
    expect(
      resolveCommentSyncMode({
        online: true,
        viewerConfigured: false,
        viewerHasToken: false,
        resolving: false, // not linked → nothing to wait for
      }),
    ).toEqual({ mode: "local", needsViewerToken: false, resolving: false })
  })
})
