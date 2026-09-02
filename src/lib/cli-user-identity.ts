/**
 * CLI user identity — set by the bootstrap when running under the
 * editor-cli, read by hooks that need an author stamp (comments,
 * notes, future flows). Matches the `setActiveEditorSessionId`
 * module-level-setter pattern in `editor-fetch.ts`.
 *
 * Architecture-doc reference (tasks/cli-viewer-architecture.md
 * line 234): in local mode, stamp annotations with
 * `os.userInfo().username + machine name` as a placeholder. The
 * eventual viewer-side sync reconciles identity at the cloud
 * boundary.
 *
 * If nothing calls `setActiveCliUser` (tests, or any surface booted
 * without the CLI bootstrap), `getActiveCliUser()` stays null and
 * consumers fall back to their own hard-coded placeholder author.
 * There is no signed-in identity to fall back to any more — the web
 * routes were removed 2026-06-04 and the Firebase auth surface
 * 2026-08-08.
 */

import type { CommentAuthor } from "@/types/bridge"

let activeUser: CommentAuthor | null = null

export function setActiveCliUser(user: CommentAuthor | null): void {
  activeUser = user
}

export function getActiveCliUser(): CommentAuthor | null {
  return activeUser
}

/**
 * Build a CommentAuthor from the OS-level identity the CLI server
 * collected via `os.userInfo()` + `os.hostname()`. Format:
 * `{ uid: "cli:user@host", displayName: "user", email: "", photoURL: "" }`.
 */
export function cliBootstrapUserToAuthor(input: {
  username?: string
  hostname?: string
}): CommentAuthor {
  const username = input.username?.trim() || "local"
  const hostname = input.hostname?.trim() || "unknown-host"
  return {
    uid: `cli:${username}@${hostname}`,
    displayName: username,
    email: "",
    photoURL: "",
  }
}
