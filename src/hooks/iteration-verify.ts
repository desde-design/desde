/**
 * Client half of `POST /api/editor/iteration/verify` (see
 * `editor-cli/src/server/iteration-verify-handler.ts`). Called before the
 * iteration-scope dialog opens; a `no-loop` answer sends the edit to chat.
 */
import { editorFetch } from "@/lib/editor-fetch"

export type IterationVerifyOutcome =
  | { kind: "loop"; expression: string }
  | { kind: "no-loop"; reason: string }
  | { kind: "error"; reason: string }

export async function verifyIterationLoop(
  args: {
    file: string
    line: number
    column: number
    /**
     * Aborted when the editing hook is disposed or disabled. Without it a
     * verify outlives the surface that authorized it, and its `no-loop`
     * answer starts an agent turn after the UI is gone.
     */
    signal?: AbortSignal
  },
  fetchImpl: typeof editorFetch = editorFetch,
): Promise<IterationVerifyOutcome> {
  let response: Response
  try {
    response = await fetchImpl("/api/editor/iteration/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file: args.file,
        templateLocation: { line: args.line, column: args.column },
      }),
      ...(args.signal ? { signal: args.signal } : {}),
    })
  } catch (err) {
    return { kind: "error", reason: (err as Error).message }
  }
  let body: { ok: boolean; loop?: { expression: string } | null; reason?: string }
  try {
    body = (await response.json()) as typeof body
  } catch {
    return { kind: "error", reason: `HTTP ${response.status}` }
  }
  if (!response.ok || !body.ok) {
    return { kind: "error", reason: body.reason ?? `HTTP ${response.status}` }
  }
  if (body.loop) return { kind: "loop", expression: body.loop.expression }
  return { kind: "no-loop", reason: body.reason ?? "No loop at that position" }
}
