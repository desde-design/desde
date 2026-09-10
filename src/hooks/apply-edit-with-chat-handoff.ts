/**
 * Deterministic apply, then chat. Wraps `adapter.applyEdit` for the
 * structural edits (move / delete / detach / insert / swap / unwrap /
 * flatten-conditional). When the deterministic applicator refuses, the
 * refusal is handed to the chat agent as a new session, with the selector,
 * the source position and the refusal text, and the user watches it work.
 *
 * This replaced `applyEditWithLLMFallback` on 2026-09-08. That helper posted
 * a one-file repair intent to `/api/editor/llm-fallback` and wrote whatever
 * came back; the model saw one file and a line number, could not read the
 * usages, could not ask, and once deleted the wrong function. The agent has
 * the repo and `ask_user_question`.
 *
 * Pure module: no React, no status text. Callers read `handoff.started` and
 * write their own banner through `describeEditOutcome`.
 */
import type { EditResult, StructuralEdit } from "@/editor/core"
import type { BridgeFrameworkAdapter } from "@/editor/adapters/bridge"
import type { LaneSession, SessionRunContext } from "@/editor/session/lane-session"
import {
  buildStructuralEditHandoffPrompt,
  describeMoveDestination,
  type StructuralEditHandoff,
} from "@/editor/edit-service/build-edit-escalation-prompt"

export interface ChatHandoffOutcome {
  /** A hand-off was possible (the edit has a source position and a chat transport existed). */
  attempted: boolean
  /** The chat transport accepted the prompt. */
  started: boolean
  /** The deterministic refusal, kept for the status banner. */
  originalReason?: string
}

const KIND_LABELS: Record<string, string> = {
  move: "Move",
  delete: "Delete",
  detach: "Detach",
  insert: "Insert",
  swap: "Swap",
  unwrap: "Unwrap",
  "flatten-conditional": "Flatten conditional",
}

/**
 * Labels that read wrong in the prompt under their status name. An insert's
 * `target` is the destination PARENT, not the new content, so "Insert <Card>"
 * names the wrong element; "Insert into <Card>" is what happened. Status text
 * keeps the plain label, which is built at the call site, not here.
 */
const HANDOFF_LABELS: Record<string, string> = {
  insert: "Insert into",
}

/**
 * How much of an inserted snippet the prompt carries before it is cut.
 *
 * 2000, not the 200 this started at. The omitted tail exists nowhere else:
 * the deterministic applicator refused, so nothing was written, and the agent
 * has only this message to work from. At 200 characters it could not apply
 * any realistic insert faithfully. 2000 matches the cap the prompt builder
 * enforces on copied fields.
 */
const SNIPPET_LIMIT = 2000

/**
 * Refusals that are POLICY, not capability. The agent cannot fix these by
 * reading more source: a dormant lane is off by configuration, and library
 * source under `node_modules` is never an edit target. Handing one to an
 * agent told to make the edit happen invites it to work around the rule.
 *
 * Kept deliberately short. Each pattern pins a message that a colocated test
 * on the producing side already holds stable:
 *  - the dormant-lane sentence from `dormantLaneRefusal` in `editor-cli/src/server/enabled-lanes.ts`
 *  - "never rewrites node_modules" from `build-edit-request.ts`
 *  - "installed library" from the iteration and llm-fallback handlers
 *
 * The lane pattern is anchored on that message's fixed prefix AND on the two
 * ids that exist. `/\blanes\.[a-z-]+\b/` alone matched any sentence that
 * mentioned a path like `src/lanes.ts`, which would have turned an ordinary
 * capability refusal into a policy one and silently stopped the hand-off.
 */
const DORMANT_LANE_REFUSAL = /edit lane is dormant\b[\s\S]*\blanes\.(?:detach|swap)\b/

export function isPolicyRefusal(reason: string): boolean {
  return (
    DORMANT_LANE_REFUSAL.test(reason) ||
    /never rewrites node_modules/i.test(reason) ||
    /installed library/i.test(reason)
  )
}

/**
 * The payload of the edit, in the user's voice, for the kinds where the
 * element alone does not say what was asked. `delete`, `detach` and `unwrap`
 * return undefined: for those the element IS the whole request.
 */
function detailForHandoff(edit: StructuralEdit): string | undefined {
  switch (edit.kind) {
    case "move":
      return describeMoveDestination(edit.destination.parentEditTarget, edit.destination.index)
    case "insert": {
      const snippet = edit.snippet.trim()
      const shown =
        snippet.length > SNIPPET_LIMIT
          ? `${snippet.slice(0, SNIPPET_LIMIT)}... (truncated)`
          : snippet
      const content = edit.contentKind === "text" ? `the text ${JSON.stringify(shown)}` : shown
      const where = edit.destIndex < 0 ? "at the end" : `at child index ${edit.destIndex}`
      return `insert ${content} ${where}`
    }
    case "swap":
      return `replace <${edit.fromComponentName}> with <${edit.toComponentName}>`
    case "flatten-conditional":
      return edit.branchToKeep === "else"
        ? "keep the else branch"
        : `keep branch ${edit.branchToKeep} of the conditional chain`
    default:
      return undefined
  }
}

/**
 * The hand-off description for a refused structural edit, or null when the
 * kind carries no source position (overwrite, llm-patch, prop, styles, text
 * ranges, tokens: each has its own path and none of them belongs here).
 */
export function describeStructuralEditForHandoff(
  edit: StructuralEdit,
  reason: string,
): StructuralEditHandoff | null {
  const kindLabel = KIND_LABELS[edit.kind]
  if (!kindLabel) return null
  const target = edit.target
  // The `!location` check below is the only position guard needed, and it is
  // broader than the `!target.editTarget` clause it replaces: a
  // definition-scope delete carrying an `authoredAt` but no `editTarget` has
  // a position to hand over, and used to be dropped here.
  if (!target) return null
  const scope = edit.kind === "delete" ? (edit.scope ?? "definition") : null
  // No `?? target.editTarget` fallback for definition scope. `editTarget` is
  // the CALLSITE, so the fallback labelled a callsite position "the
  // component's own file" and sent the agent to the wrong place. The adapter
  // refuses that edit anyway ("DeleteEdit requires target.authoredAt"), so a
  // plain failure status is the honest outcome.
  const location = scope === "definition" ? target.authoredAt : target.editTarget
  if (!location) return null
  return {
    kindLabel: HANDOFF_LABELS[edit.kind] ?? kindLabel,
    detail: detailForHandoff(edit),
    componentName: target.componentName ?? null,
    tagName: null,
    selector: target.selector,
    location: { file: location.file, line: location.line, column: location.column },
    scope,
    reason,
  }
}

export interface ApplyEditWithChatHandoffOptions {
  /**
   * The bridge session this edit belongs to.
   *
   * Given here rather than assembled by the caller out of a captured
   * generation and a captured signal. The helper enters the session BEFORE the
   * apply, so the lifetime it guards against is the one the edit was dispatched
   * under. A caller that captured it itself had to get two things right at
   * every call site, and eleven call sites is how one of them ends up reading
   * the session after the round trip instead of before it.
   *
   * The session does three jobs. Its generation says whether the page the edit
   * was made on is still the page on screen, which is what decides whether a
   * chat turn may be started at all. Its signal is handed to the APPLY, so a
   * write does not outlive the document it was for. And its signal is handed to
   * the HAND-OFF, so a submission already on its way is cancelled rather than
   * merely unwatched.
   *
   * Absent means "no session to speak of", which is how the pure tests and any
   * caller without a bridge session call it.
   */
  session?: LaneSession
}

/** A chat submission, as the shell offers it. */
type HandOff = (prompt: string, options?: { signal?: AbortSignal }) => Promise<boolean>

type ApplyOutcome = { result: EditResult; handoff: ChatHandoffOutcome }

/**
 * The answer for an edit whose page went away before the helper finished.
 *
 * `started: false` is the load-bearing half: whatever else happened, no chat
 * turn is running for a document nobody is looking at. The deterministic
 * result is still reported, because the caller is the one that decides whether
 * to say anything about it.
 */
function stopped(result: EditResult): ApplyOutcome {
  return {
    result,
    handoff:
      result.kind === "failed"
        ? { attempted: false, started: false, originalReason: result.reason }
        : { attempted: false, started: false },
  }
}

/**
 * The refusal reported when the apply threw INTO a departed session.
 *
 * `run` swallows that throw, for the same reason the status is dropped: the
 * surface that would have shown the error is describing another page. There is
 * then no deterministic result to report, and this stands in for one. Every
 * caller drops the answer, so this string is not shown to anyone; it exists so
 * the return type does not have to grow a null the pure callers would have to
 * narrow away.
 */
const PAGE_CHANGED_REASON = "The page changed before this edit finished."

/**
 * Everything after the deterministic apply: decide whether a hand-off is
 * possible, and if so make it.
 *
 * `ctx` is absent for a caller without a session, and then there is no
 * lifetime to consult and no signal to hand over.
 */
async function handOffRefusal(
  edit: StructuralEdit,
  initial: EditResult,
  handOff: HandOff | undefined,
  ctx: SessionRunContext | undefined,
): Promise<ApplyOutcome> {
  // No staleness check of its own. This is only reached through a `ctx.step`
  // that has already said the page is the same one, which is the window the
  // caller's own guard could not cover: the caller runs on the RESULT, so by
  // the time it says "stale" the chat turn has already been started.
  if (initial.kind !== "failed") {
    return { result: initial, handoff: { attempted: false, started: false } }
  }
  // A policy refusal is not something the agent can read its way out of, and
  // the hand-off tells the agent to make the edit happen. Report it as a
  // plain failure instead.
  if (isPolicyRefusal(initial.reason)) return stopped(initial)
  const described = describeStructuralEditForHandoff(edit, initial.reason)
  if (!described || !handOff) return stopped(initial)
  const prompt = buildStructuralEditHandoffPrompt(described)
  // The signal goes WITH the submission, not just around the wait for it. A
  // session that ends while the POST is in flight must cancel the turn, not
  // leave it to start and edit files for the page that has gone.
  const submission = handOff(prompt, ctx ? { signal: ctx.signal } : undefined)
  if (!ctx) {
    return { result: initial, handoff: { attempted: true, started: await submission, originalReason: initial.reason } }
  }
  const submitted = await ctx.step(submission)
  // The session ended while the POST was out. The signal aborted it, so no turn
  // is running, and this is the SAME answer a page change gives at any other
  // await: one shape, so a caller cannot have to tell them apart.
  //
  // No test can witness this line on its own, and that is worth saying rather
  // than hiding: the run's own final check produces the identical answer for a
  // session that ended here, because the apply's result is what both report. It
  // stays because every await inside a `session.run` body goes through
  // `ctx.step` in this codebase, and work added after the hand-off would
  // otherwise be the one await without a guard.
  if (submitted.stale) return stopped(initial)
  return {
    result: initial,
    handoff: { attempted: true, started: submitted.value, originalReason: initial.reason },
  }
}

export async function applyEditWithChatHandoff(
  edit: StructuralEdit,
  adapter: Pick<BridgeFrameworkAdapter, "applyEdit">,
  // Asynchronous, and awaited below. The hand-off is an HTTP POST that starts
  // a chat turn, and the server can refuse it after the client-side guard has
  // already said yes. A synchronous `true` here was a promise the transport
  // had not made, and every caller cleared its buffer on it.
  handOff: HandOff | undefined,
  options: ApplyEditWithChatHandoffOptions = {},
): Promise<ApplyOutcome> {
  const session = options.session
  if (!session) {
    return handOffRefusal(edit, await adapter.applyEdit(edit), handOff, undefined)
  }
  /**
   * The apply's own answer, kept off the step's.
   *
   * `ctx.step` withholds a value once the page has gone, and the caller still
   * has to be told what the write did. Taking it off the promise rather than
   * off the step means the order cannot be got wrong by a later edit.
   */
  let written: EditResult | null = null
  const run = await session.run(async (ctx): Promise<ApplyOutcome | null> => {
    // The signal goes to the APPLY as well as to the hand-off. The apply is the
    // write, and a write that outlives its session is the one that can collide
    // with the new document's write for the same element: the shell's in-flight
    // markers were emptied when the session ended, so nothing else is holding
    // that door. Aborting settles it as `failed`, which is the outcome the
    // callers already treat as "nothing landed".
    const applying = adapter.applyEdit(edit, { signal: ctx.signal }).then((result) => {
      written = result
      return result
    })
    const applied = await ctx.step(applying)
    if (applied.stale) return null
    return handOffRefusal(edit, applied.value, handOff, ctx)
  })
  if (!run.stale && run.value !== null) return run.value
  // ONE report for the page change, whichever await it landed in.
  return stopped(written ?? { kind: "failed", reason: PAGE_CHANGED_REASON })
}
