/**
 * Centralized fetch wrapper for the editor's HTTP surface.
 *
 * Branch mode edits the checked-out working tree in place, so requests no
 * longer need to carry a worktree session header — `editorFetch` is a thin
 * passthrough to `fetch` today. It's kept as the single call-site seam (used
 * by the bridge adapter, useEditorEditing's agent/llm-fallback calls, and
 * useEditorChat's chat/bridge-reply/edit-ack) so any future cross-cutting
 * request concern has one place to live instead of threading through layers.
 */

/**
 * Drop-in replacement for `fetch` for editor API calls.
 */
export async function editorFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return fetch(input, init)
}
