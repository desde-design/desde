/**
 * Auto-LLM-fallback wrapper around `adapter.applyEdit` for structural
 * edits. When a deterministic applicator (move/delete/detach/
 * insert/swap/unwrap/flatten-conditional) refuses, this helper hits the
 * existing `/api/editor/llm-fallback` endpoint to get a full-file
 * rewrite proposal and dispatches it as an `OverwriteEdit` transparently
 * — same id as the original edit so the structural-edit-labels map and
 * any pending-buffer tracking carry over without special-casing.
 *
 * If BOTH lanes fail (deterministic refused AND the LLM lane either
 * threw, returned an unchanged source, or produced output that the
 * overwrite applicator rejected), the helper returns the ORIGINAL
 * deterministic failure. Callers fall through to their existing failure
 * handling (the `failedEdits` map that drives the manual "Retry with AI"
 * button in the pending-changes panel) — auto-fallback turns the manual
 * path into the last-resort lane rather than the only lane.
 *
 * Pure module: no React imports, no `setSaveStatus`. The helper does I/O
 * (fetch + adapter call) but does not touch UI state directly. Callers
 * read `fallback.applied` / `fallback.explanation` / `fallback.fallbackError`
 * and emit their own status messages so the per-handler "Move failed: …" /
 * "Insert applied via AI repair: …" framing stays close to where the
 * action was dispatched.
 */

import type { EditResult, StructuralEdit } from "@/editor/core"
import type { BridgeFrameworkAdapter } from "@/editor/adapters/bridge"
import { editorFetch } from "@/lib/editor-fetch"

/**
 * Outcome of the auto-LLM-fallback path inside `applyEditWithLLMFallback`.
 *
 * `attempted=false` means the deterministic apply succeeded OR the edit
 * kind has no repair-intent mapping (overwrite/prop/llm-patch — see
 * {@link describeIntentForRepair}). In neither case did the LLM run.
 *
 * `attempted=true, applied=true` means the deterministic lane refused
 * and the LLM rewrite was accepted by the overwrite applicator.
 *
 * `attempted=true, applied=false` means both lanes failed: the LLM call
 * threw, the endpoint returned `ok:false`, the LLM refused (returned
 * unchanged source — surfaced by the route as `ok:false`), or the
 * overwrite the LLM proposed failed compile-check at apply time.
 */
export interface StructuralFallbackOutcome {
  attempted: boolean
  applied: boolean
  /** Present when applied=true — surfaced to the user as "AI repaired: …". */
  explanation?: string
  /** Present when applied=false AND attempted=true — why the LLM lane gave up. */
  fallbackError?: string
  /** Deterministic applicator's original refusal, preserved for status framing. */
  originalReason?: string
}

/**
 * Translate a buffered {@link StructuralEdit} into the (file, intent)
 * tuple the Tier 2 repair service expects. Returns `null` for edit
 * kinds that don't have a repair lane (overwrite is already an LLM
 * result; llm-patch goes through its own LLM lane; prop has its own
 * source-aware fallback in `apply-prop-edit`).
 *
 * Mirrors the kinds whitelisted by the `/api/editor/llm-fallback`
 * route's `ALLOWED_REPAIR_INTENT_KINDS` set; keep the two in sync.
 */
export function describeIntentForRepair(edit: StructuralEdit): {
  file: string
  intent: {
    kind:
      | "move"
      | "delete"
      | "detach"
      | "insert"
      | "swap"
      | "unwrap"
      | "flatten-conditional"
    description: string
    sourceLine?: number
    sourceColumn?: number
    destParentLine?: number
    destParentColumn?: number
    destIndex?: number
  }
} | null {
  if (
    edit.kind === "overwrite" ||
    edit.kind === "llm-patch" ||
    edit.kind === "prop" ||
    edit.kind === "scoped-css-override" ||
    // jsx-style is deterministic-only (a Babel className/style splice); on
    // refusal the bound-binding/spread fallback surfaces to the user, no LLM
    // repair — same as its Vue sibling scoped-css-override.
    edit.kind === "jsx-style" ||
    edit.kind === "variant" ||
    edit.kind === "token" ||
    edit.kind === "duplicate" ||
    edit.kind === "copy" ||
    edit.kind === "paste" ||
    edit.kind === "wrap" ||
    edit.kind === "off-system-override" ||
    edit.kind === "intent" ||
    edit.kind === "data-binding" ||
    // text-branch is deterministic-only: the inspector hands the
    // applicator an exact byte range; if validation fails (invalid JS
    // in a bound branch, out-of-bounds range) there's no useful LLM
    // repair — the user just needs to fix their input.
    edit.kind === "text-branch" ||
    // token-value is deterministic-only too (a postcss by-name patch of a CSS
    // custom-property declaration) — no LLM repair path.
    edit.kind === "token-value"
  ) {
    return null
  }
  const target = edit.target
  if (!target || !("editTarget" in target) || !target.editTarget) {
    return null
  }
  const componentName = ("componentName" in target ? target.componentName : null) ?? "element"
  const description: Record<string, string> = {
    move: `Move <${componentName}>`,
    delete: `Delete <${componentName}>`,
    detach: `Detach <${componentName}>`,
    insert: `Insert into <${componentName}>`,
    swap: `Swap <${componentName}>`,
    unwrap: `Unwrap <${componentName}>`,
    "flatten-conditional": `Flatten conditional at <${componentName}>`,
  }
  // Destination for the LLM repair prompt. Without this anchor the
  // model invents a destination (typically hoisting the node out to an
  // ancestor). Three shapes the repair-eligible edits use:
  //   - move:           `destination: InsertionTarget` (parentEditTarget + index)
  //   - insert:         no `destination`; `target` IS the parent and
  //                     `destIndex` lives at the top level.
  //   - delete / detach / swap / unwrap / flatten-conditional: no destination.
  //
  // We only forward the destination when the parent lives in the SAME
  // FILE as the source — otherwise the prompt shows only the source
  // file and the parent coordinates reference an unrelated SFC, which
  // would mislead the LLM. The repair lane is currently single-file
  // anyway, so dropping the anchor here is the safer behavior.
  let destParentLine: number | undefined
  let destParentColumn: number | undefined
  let destIndex: number | undefined
  if (edit.kind === "insert") {
    // Insert reuses target as its destination parent.
    destParentLine = target.editTarget.line
    destParentColumn = target.editTarget.column
    destIndex = (edit as { destIndex?: number }).destIndex
  } else if ("destination" in edit && edit.destination) {
    const destination = edit.destination
    const parentET = destination.parentEditTarget
    if (parentET && parentET.file === target.editTarget.file) {
      destParentLine = parentET.line
      destParentColumn = parentET.column
    }
    if (typeof destination.index === "number") {
      destIndex = destination.index
    }
  }
  return {
    file: target.editTarget.file,
    intent: {
      kind: edit.kind,
      description: description[edit.kind] ?? `Edit <${componentName}>`,
      sourceLine: target.editTarget.line,
      sourceColumn: target.editTarget.column,
      ...(destParentLine !== undefined && destParentColumn !== undefined
        ? { destParentLine, destParentColumn }
        : {}),
      ...(destIndex !== undefined ? { destIndex } : {}),
    },
  }
}

/**
 * Wrap a structural-edit dispatch with automatic LLM repair on refusal.
 * See module docstring for behavior; this signature is the entry point.
 *
 * `fetchImpl` defaults to `editorFetch`; tests inject a mock so they
 * can assert request payloads and shape responses without spinning up
 * the Next.js route.
 */
export async function applyEditWithLLMFallback(
  edit: StructuralEdit,
  adapter: Pick<BridgeFrameworkAdapter, "applyEdit">,
  fetchImpl: typeof editorFetch = editorFetch,
): Promise<{ result: EditResult; fallback: StructuralFallbackOutcome }> {
  const initial = await adapter.applyEdit(edit)
  if (initial.kind !== "failed") {
    return { result: initial, fallback: { attempted: false, applied: false } }
  }
  const intentInfo = describeIntentForRepair(edit)
  if (!intentInfo) {
    return {
      result: initial,
      fallback: { attempted: false, applied: false, originalReason: initial.reason },
    }
  }
  type FallbackResponse =
    | { ok: true; proposal: { newSource: string; explanation?: string; baseHash?: string } }
    | { ok: false; reason: string }
  let json: FallbackResponse | null = null
  try {
    const response = await fetchImpl("/api/editor/llm-fallback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file: intentInfo.file,
        intent: intentInfo.intent,
        errorReason: initial.reason,
      }),
    })
    json = (await response.json()) as FallbackResponse
  } catch (err) {
    return {
      result: initial,
      fallback: {
        attempted: true,
        applied: false,
        originalReason: initial.reason,
        fallbackError: `LLM fallback threw: ${(err as Error).message}`,
      },
    }
  }
  if (!json || !json.ok) {
    return {
      result: initial,
      fallback: {
        attempted: true,
        applied: false,
        originalReason: initial.reason,
        fallbackError:
          json && !json.ok ? json.reason : "LLM fallback returned empty response",
      },
    }
  }
  const proposal = json.proposal
  const overwrite: StructuralEdit = {
    kind: "overwrite",
    id: edit.id,
    target: {
      targetId: intentInfo.file,
      selector: intentInfo.file,
    },
    file: intentInfo.file,
    newSource: proposal.newSource,
    ...(proposal.baseHash ? { baseHash: proposal.baseHash } : {}),
  }
  const overwriteResult = await adapter.applyEdit(overwrite)
  if (overwriteResult.kind === "failed") {
    // Surface the ORIGINAL deterministic failure so the caller's failedEdits
    // map captures the right errorReason for the manual retry path. The
    // overwrite failure (usually a compile error in the LLM's output)
    // rides along in fallbackError so status messages can name both.
    return {
      result: initial,
      fallback: {
        attempted: true,
        applied: false,
        originalReason: initial.reason,
        fallbackError: `AI rewrite refused at apply: ${overwriteResult.reason}`,
      },
    }
  }
  return {
    result: overwriteResult,
    fallback: {
      attempted: true,
      applied: true,
      originalReason: initial.reason,
      explanation: proposal.explanation,
    },
  }
}
