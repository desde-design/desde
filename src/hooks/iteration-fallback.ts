/**
 * Client-side wrapper for the iteration-data LLM lane.
 *
 * Posts an `IterationDataIntent` to `/api/editor/llm-fallback` and
 * returns the proposal payload (full-file source + baseHash + optional
 * explanation). Consumers (`useEditorEditing`) buffer the result as
 * an `OverwriteEdit` that flows through the standard save lane.
 *
 * Pure UI-layer code — no Zustand, no React. Centralized so each
 * iteration-aware edit kind (delete / prop / duplicate / move / insert)
 * shares one request shape and one error path.
 *
 * Telemetry hook: every call records the resolved scope + operation +
 * source (`'llm'`) + outcome to `console.info` keyed by tag
 * `[editor:iteration]`. Persisting to the session record is a
 * follow-up (`tasks/_archive/one-shot-tasks/iteration-aware-edits.md` Phase 1, deferred since
 * a console log gets us the ratio data without touching the session
 * writer).
 */

import type { IterationContext } from "@/editor/core"
import type { SourceLocation } from "@/editor/core"
import type {
  IterationDataIntent,
  IterationDataPayload,
} from "@/editor/edit-service/iteration-data-prompt"
import { editorFetch } from "@/lib/editor-fetch"

export type IterationEditKind =
  | "delete"
  | "prop"
  | "duplicate"
  | "move"
  | "insert"
  | "dom-text"

export interface IterationProposal {
  /** Full file source the LLM produced. */
  newSource: string
  /** Optional one-line explanation surfaced to the user. */
  explanation?: string
  /** SHA-256 of the input source at LLM-call time — OverwriteEdit.baseHash. */
  baseHash?: string
  /** Which file the rewrite targets (the same `file` we sent to the route). */
  file: string
}

export type IterationProposalResult =
  | { ok: true; proposal: IterationProposal }
  | { ok: false; reason: string }

/**
 * Pick the file to rewrite. Heuristic: if a page source file was
 * resolved and it differs from the template file, the data array is
 * probably defined in the page file (cross-component case — typical
 * for v-for'd row components fed from a page-level computed). Else
 * fall back to the template file (single-file case).
 */
export function pickIterationTargetFile(args: {
  templateLocation: SourceLocation
  pageSourceFile: string | null
}): string {
  if (
    args.pageSourceFile &&
    args.pageSourceFile !== args.templateLocation.file
  ) {
    return args.pageSourceFile
  }
  return args.templateLocation.file
}

export interface RequestIterationProposalArgs {
  /** Which edit triggered this — for telemetry + description. */
  editKind: IterationEditKind
  /** v-for / .map template position. */
  templateLocation: SourceLocation
  iterationContext: IterationContext
  /** Page-level source file when known (from the current-page store). */
  pageSourceFile: string | null
  /** What to do with the matched entry. */
  payload: IterationDataPayload
  /** Free-form one-line description that ends up in the prompt header. */
  description: string
}

export async function requestIterationProposal(
  args: RequestIterationProposalArgs,
): Promise<IterationProposalResult> {
  // Phase 3+: try the deterministic resolver first via the static
  // endpoint. The template file is where the v-for lives — Phase 3's
  // single-file resolver assumes the array literal is in that same
  // SFC; Phase 4's cross-component resolver falls back to the page
  // file when same-file fails. A 422 (unresolved) drops through to
  // the LLM lane below.
  const staticResult = await tryStaticEndpoint(args)
  if (staticResult.kind === "ok") {
    logTelemetry({ ...args, source: "static", outcome: "ok" })
    return {
      ok: true,
      proposal: {
        newSource: staticResult.proposal.newSource,
        explanation: staticResult.proposal.explanation,
        baseHash: staticResult.proposal.baseHash,
        // Phase 4: the resolver may have decided to rewrite the page
        // file rather than the component. Prefer the proposal's
        // declared file; fall back to the template file when absent.
        file: staticResult.proposal.file ?? args.templateLocation.file,
      },
    }
  }
  // If the static endpoint hard-errored (network, 500), surface it
  // rather than silently retrying through the LLM — the user's
  // backend is broken and the LLM call will fail too.
  if (staticResult.kind === "hard-error") {
    logTelemetry({
      ...args,
      source: "static",
      outcome: "network-error",
      reason: staticResult.reason,
    })
    return { ok: false, reason: staticResult.reason }
  }
  // Soft refusal (422 = unresolved or apply-failed) → fall through to LLM.

  const file = pickIterationTargetFile({
    templateLocation: args.templateLocation,
    pageSourceFile: args.pageSourceFile,
  })
  const intent: IterationDataIntent = {
    kind: "iteration-data",
    description: args.description,
    templateLocation: args.templateLocation,
    iterationContext: args.iterationContext,
    pageSourceFile: args.pageSourceFile,
    payload: args.payload,
  }

  let response: Response
  try {
    response = await editorFetch("/api/editor/llm-fallback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file, intent }),
    })
  } catch (err) {
    const reason = (err as Error).message
    logTelemetry({ ...args, source: "llm", outcome: "network-error", reason })
    return { ok: false, reason: `Network error: ${reason}` }
  }

  let body: { ok?: boolean; proposal?: IterationProposal; reason?: string }
  try {
    body = await response.json()
  } catch (err) {
    const reason = `Could not parse response: ${(err as Error).message}`
    logTelemetry({ ...args, source: "llm", outcome: "parse-error", reason })
    return { ok: false, reason }
  }

  if (!response.ok || !body.ok || !body.proposal) {
    const reason = body.reason ?? `HTTP ${response.status}`
    logTelemetry({ ...args, source: "llm", outcome: "refused", reason })
    return { ok: false, reason }
  }

  logTelemetry({ ...args, source: "llm", outcome: "ok" })
  return {
    ok: true,
    proposal: {
      newSource: body.proposal.newSource,
      explanation: body.proposal.explanation,
      baseHash: body.proposal.baseHash,
      file,
    },
  }
}

/**
 * POST to the static iteration endpoint. Returns:
 *   - { kind: 'ok', proposal } on success
 *   - { kind: 'unresolved', reason } when the resolver couldn't trace
 *     the data array (422) — caller falls through to LLM
 *   - { kind: 'hard-error', reason } for network errors / 5xx — caller
 *     surfaces the error rather than retrying through LLM
 */
async function tryStaticEndpoint(
  args: RequestIterationProposalArgs,
): Promise<
  | {
      kind: "ok"
      proposal: {
        newSource: string
        explanation?: string
        baseHash?: string
        /** Phase 4: cross-component static path returns the page file. */
        file?: string
      }
    }
  | { kind: "unresolved"; reason: string }
  | { kind: "hard-error"; reason: string }
> {
  let response: Response
  try {
    response = await editorFetch("/api/editor/edit-iteration", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file: args.templateLocation.file,
        templateLocation: args.templateLocation,
        pageSourceFile: args.pageSourceFile,
        iterationContext: args.iterationContext,
        payload: args.payload,
      }),
    })
  } catch (err) {
    return { kind: "hard-error", reason: (err as Error).message }
  }
  if (response.status === 422) {
    let body: { reason?: string } = {}
    try {
      body = await response.json()
    } catch { /* ignore */ }
    return { kind: "unresolved", reason: body.reason ?? "unresolved" }
  }
  if (!response.ok) {
    return { kind: "hard-error", reason: `HTTP ${response.status}` }
  }
  let body: {
    ok?: boolean
    proposal?: {
      newSource: string
      explanation?: string
      baseHash?: string
      file?: string
    }
    reason?: string
  } = {}
  try {
    body = await response.json()
  } catch (err) {
    return {
      kind: "hard-error",
      reason: `Could not parse response: ${(err as Error).message}`,
    }
  }
  if (!body.ok || !body.proposal) {
    return {
      kind: "hard-error",
      reason: body.reason ?? "Static endpoint returned ok=false",
    }
  }
  return { kind: "ok", proposal: body.proposal }
}

interface TelemetryEvent extends RequestIterationProposalArgs {
  source: "llm" | "static"
  outcome: "ok" | "refused" | "network-error" | "parse-error" | "user-cancelled"
  reason?: string
}

function logTelemetry(event: TelemetryEvent): void {
  // Console-only for v1; the session-record writer comes in a follow-up.
  // Keep the shape stable so we can grep ratios later.
  try {
    console.info("[editor:iteration]", {
      editKind: event.editKind,
      operation: event.payload.operation,
      source: event.source,
      outcome: event.outcome,
      key: event.iterationContext.key,
      index: event.iterationContext.index,
      siblingCount: event.iterationContext.siblingCount,
      reason: event.reason,
    })
  } catch {
    /* never throw from telemetry */
  }
}

/** Exposed for callers that want to log scope choices without firing the LLM. */
export function logIterationScopeChoice(args: {
  editKind: IterationEditKind
  scope: "this-row" | "all-rows"
  iterationContext: IterationContext
  remembered: boolean
}): void {
  try {
    console.info("[editor:iteration:scope]", {
      editKind: args.editKind,
      scope: args.scope,
      key: args.iterationContext.key,
      index: args.iterationContext.index,
      siblingCount: args.iterationContext.siblingCount,
      remembered: args.remembered,
    })
  } catch {
    /* never throw from telemetry */
  }
}
