"use client"

/**
 * Selects the active comment store + author for the editor.
 *
 * Comments sync with a linked Desde **viewer** (self-hostable, no GCP —
 * see CLAUDE.md) when this repo is linked to one (`platformBaseUrl` +
 * `projectId` in `.desde/config.json`) AND this machine holds an
 * access token for it AND the machine is online — routed through the CLI's
 * own proxy (`editor-cli/src/server/viewer-proxy.ts`) so the token never
 * enters this page. Otherwise comments fall back to the local HTTP store
 * (`.desde/comments.json`), stamped with the CLI's machine identity,
 * with a "local-only" badge.
 */

import { useMemo } from "react"
import { useViewerAuthStatus } from "./useViewerAuthStatus"
import {
  createHttpCommentStore,
  createViewerHttpCommentStore,
} from "@/services/artifact-stores"
import { getActiveCliUser } from "@/lib/cli-user-identity"
import { EDITOR_PROJECT } from "@/lib/editor-feature-flags"
import type { CommentStore } from "@/editor/core"
import type { CommentAuthor } from "@/types/bridge"

export type CommentSyncMode = "viewer" | "local"

/**
 * Pure sync-mode decision (extracted so the gating is unit-testable
 * without mounting React / Zustand). "viewer" requires ALL of: a viewer
 * configured for this repo, an access token held for it on this machine,
 * and being online; otherwise "local".
 */
export function resolveCommentSyncMode(params: {
  online: boolean
  /** A viewer is configured for this repo (`platformBaseUrl` + `projectId`). */
  viewerConfigured: boolean
  /** A viewer access token is stored on this machine for that viewer. */
  viewerHasToken: boolean
  /**
   * The viewer-auth status has not come back yet, so `viewerConfigured` and
   * `viewerHasToken` are "unknown", not "false". Distinguishing them matters:
   * treating unknown as false during the first render of a LINKED repo makes
   * the hook hand back the local store, and a comment written in that window
   * lands in `.desde/comments.json` instead of the viewer the repo is
   * configured to sync with. Local is the right READ default (harmless, and
   * something must render); it is the wrong thing to WRITE to.
   */
  resolving?: boolean
}): { mode: CommentSyncMode; needsViewerToken: boolean; resolving: boolean } {
  const viewer = Boolean(params.viewerConfigured && params.viewerHasToken && params.online)
  return {
    mode: viewer ? "viewer" : "local",
    resolving: Boolean(params.resolving),
    // "A viewer is configured but this machine has no token" is a distinct,
    // ACTIONABLE state — paste a token — and must not be shown as the plain
    // local-only badge, which reads as "nothing to do here".
    needsViewerToken: Boolean(params.viewerConfigured && !params.viewerHasToken),
  }
}

/** Author used when no cloud identity + no CLI identity is available. */
const FALLBACK_AUTHOR: CommentAuthor = {
  uid: "cli-local",
  displayName: "Local user",
  email: "",
  photoURL: "",
}

export interface EditorCommentStoreResult {
  store: CommentStore
  /** Viewer configured for this repo, but this machine holds no token. */
  needsViewerToken?: boolean
  /** `"viewer"` when writing to the linked viewer's shared project, else `"local"`. */
  mode: CommentSyncMode
  /** Author stamp for new comments/replies in the active mode. */
  author: CommentAuthor
  /**
   * True while the viewer-auth status is still outstanding, so `mode` is a
   * provisional "local" rather than a decided one. Callers must not accept a
   * NEW comment during this window — the write would go to the local file
   * even for a repo that syncs to a viewer. Reads are fine.
   */
  resolving: boolean
  /**
   * `resolving` is stuck because the status request FAILED, not because it is
   * still in flight — the difference the user needs, since one resolves on
   * its own and the other wants a retry.
   */
  resolveFailed: boolean
}

export function useEditorCommentStore(): EditorCommentStoreResult {
  // navigator.onLine is a coarse, non-reactive gate (a reload re-evaluates
  // it) — there's no realtime connectivity signal to react to here, since
  // the viewer store is a poll, not a push subscription. Treat SSR as
  // online so the server-rendered pass doesn't guess "local".
  const online = typeof navigator === "undefined" ? true : navigator.onLine
  const { status: viewerAuth, loading: viewerAuthLoading } = useViewerAuthStatus()

  const { mode, needsViewerToken, resolving } = resolveCommentSyncMode({
    online,
    viewerConfigured: viewerAuth?.configured ?? false,
    viewerHasToken: viewerAuth?.hasToken ?? false,
    // "Unknown" is decided by whether the status ARRIVED, not by whether the
    // request is still in flight.
    //
    // Keying on `loading` alone was wrong (codex review): the status hook
    // deliberately preserves the last known value on failure, but on FIRST
    // load there is none — so a transient 500 or a dropped connection leaves
    // `status: null` while `loading` flips to false, and a linked repo
    // silently resumed writing comments into `.desde/comments.json`.
    // That is the exact outcome this flag exists to prevent, arriving through
    // the error path instead of the loading path.
    //
    // `EDITOR_PROJECT.platformBaseUrl` comes from the CLI bootstrap and is
    // known synchronously, so an UNLINKED repo never blocks: local is simply
    // correct there, immediately. Only a repo that IS linked waits — and if
    // the endpoint stays broken it keeps waiting, which is the right trade.
    // Refusing to place a comment is recoverable; filing it where the team
    // will never look is not.
    resolving: viewerAuth === null && Boolean(EDITOR_PROJECT?.platformBaseUrl),
  })

  // Hoisted out of the dep array: the React Compiler cannot reconcile an
  // optional-chained expression as a dependency and skips optimizing the
  // whole component.
  const viewerProjectId = viewerAuth?.projectId ?? null

  const store = useMemo<CommentStore>(() => {
    if (mode === "viewer" && viewerProjectId) {
      // `baseUrl` is the CLI's own PROXY, not the viewer directly, and no
      // `authToken` is passed. The viewer access token is a bearer secret
      // that can reach every project its owner can see; the CLI attaches it
      // server-side so it never enters this page, which also renders a live
      // prototype. See editor-cli/src/server/viewer-proxy.ts.
      return createViewerHttpCommentStore({
        baseUrl: "/api/editor/viewer",
        // The proxy is bearer-gated by the CLI, and an EventSource cannot
        // carry that header — so tell the store to poll rather than open a
        // stream it cannot authenticate.
        streamRequiresAuth: true,
        projectId: viewerProjectId,
      })
    }
    return createHttpCommentStore()
  }, [mode, viewerProjectId])

  const cliAuthor = getActiveCliUser() ?? FALLBACK_AUTHOR

  const author = useMemo<CommentAuthor>(
    () =>
      mode === "viewer"
        ? {
            // The viewer DISCARDS this and derives authorship server-side from
            // the access token (Phase 3b-2 made write authorship
            // server-authoritative, so a client cannot claim to be someone
            // else). It is still sent well-formed because the API validates
            // the shape before it decides authorship — `email` in particular
            // must be a string, and omitting it 400s with
            // "author.email is invalid", which reads as a bug in the Editor
            // rather than a contract detail.
            ...cliAuthor,
            email: cliAuthor.email ?? "",
          }
        : cliAuthor,
    [mode, cliAuthor],
  )

  // Memoized because the result is now lifted to `EditorSurface` and passed
  // down through a memoized `CommentsPanel`. A fresh object per render would
  // defeat that memo and re-render the whole Comments tab on every streamed
  // chat token. `getActiveCliUser()` returns a module-level reference, so
  // `cliAuthor` is already identity-stable.
  return useMemo(
    () => ({
      store,
      mode,
      author,
      needsViewerToken,
      resolving,
      resolveFailed: resolving && !viewerAuthLoading,
    }),
    [store, mode, author, needsViewerToken, resolving, viewerAuthLoading],
  )
}
