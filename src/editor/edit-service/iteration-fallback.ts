/**
 * Client-side wrapper for the iteration-data LLM lane.
 *
 * Posts an `IterationDataIntent` to `/api/editor/llm-fallback` and
 * returns the proposal payload (full-file source + baseHash + optional
 * explanation). The iteration lane buffers the result as an `OverwriteEdit`
 * that flows through the standard save lane.
 *
 * Lived in `src/hooks/` until the iteration lane moved under
 * `src/editor/edit-service/lanes/`; a lane importing a hook is the wrong
 * direction, and nothing here was ever a hook.
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

export interface RequestIterationProposalArgs {
  /** Which edit triggered this — for telemetry + description. */
  editKind: IterationEditKind
  /** v-for / .map template position. */
  templateLocation: SourceLocation
  /**
   * The CLICKED element's own position, when it is not the loop root.
   *
   * `templateLocation` is the loop, because the data resolver matches the
   * element carrying `v-for` / returning from `.map()` exactly. But the
   * text-field extractor asks a different question: which property of the row
   * produced the text on THIS element? It looks at the direct children of the
   * position it is given, so pointing it at the loop root answers for the
   * first field in the row, whatever the designer actually clicked.
   *
   * Measured shape: `<li><span>{item.name}</span><span>{item.email}</span></li>`.
   * Retyping the email patched `name`.
   *
   * Absent when the click IS the loop root, and absent from an older client,
   * where the server falls back to `templateLocation` as before.
   */
  fieldLocation?: SourceLocation
  iterationContext: IterationContext
  /** Page-level source file when known (from the current-page store). */
  pageSourceFile: string | null
  /** What to do with the matched entry. */
  payload: IterationDataPayload
  /** Free-form one-line description that ends up in the prompt header. */
  description: string
  /**
   * The caller's lifetime, when it has one.
   *
   * The client holds the bridge's draft across this whole round trip, which
   * can be two POSTs (the deterministic resolver, then the AI lane). If the
   * bridge session ends meanwhile, the proposal is a rewrite of source for a
   * page that is gone, and the caller drops it. Passing the signal through to
   * both fetches stops the work as well as the answer.
   */
  signal?: AbortSignal
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
  // Keep the deterministic reason: it names the actual obstacle ("the list's
  // data is imported from ../data, which does not export a plain array"),
  // and it is what the user sees if the AI lane cannot run at all.
  const staticReason = staticResult.reason

  // The LOOP file goes on the wire. The server assembles the bundle around
  // it — the page file from `pageSourceFile`, then the import chain — and
  // the model names which bundled file it rewrote. (This used to send the
  // page file INSTEAD of the loop file, so the model never saw the loop.)
  const file = args.templateLocation.file
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
      ...(args.signal ? { signal: args.signal } : {}),
    })
  } catch (err) {
    // The AI lane never ran, so the deterministic reason still leads.
    const reason = composeRefusalReason({
      staticReason,
      llmReason: `Network error: ${(err as Error).message}`,
      llmKind: "unavailable",
    })
    logTelemetry({ ...args, source: "llm", outcome: "network-error", reason })
    return { ok: false, reason }
  }

  let body: {
    ok?: boolean
    proposal?: IterationProposal
    reason?: string
    /** `unavailable` = the model never ran; `refused` = it ran and declined. */
    kind?: "unavailable" | "refused"
  }
  try {
    body = await response.json()
  } catch (err) {
    const reason = `Could not parse response: ${(err as Error).message}`
    logTelemetry({ ...args, source: "llm", outcome: "parse-error", reason })
    return { ok: false, reason }
  }

  if (!response.ok || !body.ok || !body.proposal) {
    const reason = composeRefusalReason({
      staticReason,
      llmReason: body.reason ?? `HTTP ${response.status}`,
      llmKind: body.kind,
    })
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
      // The file the model chose out of the bundle. Falls back to the loop
      // file only for a server that predates the bundle.
      file: body.proposal.file ?? file,
    },
  }
}

/**
 * The most specific reason wins, and a lane that never ran cannot supply it.
 *
 *   - The AI lane RAN and refused → its reason (it read the files).
 *   - The AI lane could not run (no API key, transport failure) → the
 *     deterministic resolver's reason, plus one sentence saying why the AI
 *     fallback did not get a turn. Before 2026-09-08 the user saw only the
 *     second lane's generic refusal and the real cause was thrown away.
 */
export function composeRefusalReason(args: {
  staticReason: string
  llmReason: string
  llmKind: "unavailable" | "refused" | undefined
}): string {
  if (args.llmKind === "unavailable") {
    const base = args.staticReason.replace(/[.\s]+$/, "")
    return `${base}. The AI fallback could not run: ${args.llmReason}`
  }
  return args.llmReason
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
        ...(args.fieldLocation ? { fieldLocation: args.fieldLocation } : {}),
        pageSourceFile: args.pageSourceFile,
        iterationContext: args.iterationContext,
        payload: args.payload,
      }),
      ...(args.signal ? { signal: args.signal } : {}),
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
    // 400/404/5xx: the server's own reason ("This file belongs to an installed
    // library…", "Could not read file…") is the one the user can act on;
    // "HTTP 404" is not (codex round 4).
    let failure: { reason?: string } = {}
    try {
      failure = await response.json()
    } catch { /* ignore */ }
    return { kind: "hard-error", reason: failure.reason ?? `HTTP ${response.status}` }
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
