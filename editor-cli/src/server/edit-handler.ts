import { promises as fs } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import type { EditRequestBody } from "../../../src/editor/edit-service/validate-edit-request"
import type { ProjectKnowledgeConfig } from "../../../src/editor/edit-service/load-project-knowledge"
import type { OverwriteExtension } from "../../../src/editor/edit-service/validate-overwrite-source"
import type { FileLockManager } from "../../../src/editor/edit-service/file-lock-manager"
import { getSharedEditHistory } from "../../../src/editor/edit-service/edit-history.js"
import { ledgerFieldsForEdit } from "../../../src/editor/ledger/fields-from-edit"
import {
  appendLedgerEntry,
  hashContent,
  resolveBranchCached,
} from "../../../src/editor/ledger/edit-ledger"
import { normalizeLedgerPath } from "../../../src/editor/ledger/normalize-path"
import { desdePath } from "../../../src/editor/worktree/desde-dir.js"
import {
  resolvePrototypeRoot,
  resolveCandidateWithinRoot,
  resolveRealpathWithinRoot,
} from "./resolve-editable-path"
import { checkExtensionGate } from "./edit-extension-gate"
import { dormantLaneRefusal, type DormantLaneId } from "./enabled-lanes"
import { resolveLlmConfig } from "./llm-config.js"
import { resolveChatRuntime, type RunChatTurn } from "./chat-runtime-dispatch.js"
import type { ChatHandlerLoaders } from "./chat-handler.js"
import { getDescriptor } from "../../../src/editor/llm-providers/provider-registry.js"

export type { EditRequestBody } from "../../../src/editor/edit-service/validate-edit-request"

// Static `import { validateEditRequest } from ...` doesn't resolve at
// runtime under `npx tsx src/cli.ts` for cross-package paths — Node's
// ESM resolver runs before the tsx loader can intercept. Dynamic
// `await import(...)` inside the call site goes through tsx cleanly.
// Same pattern used for the applicator loaders below.
async function loadValidator(): Promise<
  (typeof import("../../../src/editor/edit-service/validate-edit-request"))["validateEditRequest"]
> {
  const mod = await import("../../../src/editor/edit-service/validate-edit-request")
  return mod.validateEditRequest
}

/**
 * Dynamic loader for the shared file-lock manager. Same rationale as
 * `loadValidator`: a STATIC `import { getSharedFileLockManager }` across this
 * cross-package path makes Node's ESM resolver fail named-export linking under
 * `npx tsx src/cli.ts` (Node 25: "does not provide an export named
 * 'getSharedFileLockManager'") because the resolver runs before the tsx loader
 * can transform the `.ts`. The dynamic `import()` goes through tsx cleanly and
 * unblocks booting the CLI directly. Returns the process-wide singleton.
 */
async function loadSharedFileLockManager(): Promise<FileLockManager> {
  const mod = await import("../../../src/editor/edit-service/file-lock-manager")
  return mod.getSharedFileLockManager()
}

/**
 * Dynamic loader for the shared write broker (audit Task 12) — the ONE
 * journal → locked write → invalidate → emit path, shared with the SDK's
 * structural write tools (`src/editor/agent-chat-sdk/fs-structural-tools.ts`).
 * Dynamic for the same tsx-resolver reason as `loadSharedFileLockManager`.
 */
async function loadBrokeredWrite(): Promise<
  Pick<
    typeof import("../../../src/editor/agent-chat-sdk/write-broker"),
    "brokeredWrite" | "rollbackWarning"
  >
> {
  const mod = await import("../../../src/editor/agent-chat-sdk/write-broker")
  return { brokeredWrite: mod.brokeredWrite, rollbackWarning: mod.rollbackWarning }
}

/**
 * The journal/broker-op key for a file whose ABSOLUTE path has already
 * been proven to resolve inside `rootReal` (an already-realpath'd root —
 * i.e. `absPath` came from `fs.realpath`/`resolveSafeCreatePath`, not a
 * raw request string). Every `brokeredWrite`/`writeBackupJournal` call
 * site in this file must build its journal + op keys from this, NEVER
 * from the raw request-supplied `file` path directly.
 *
 * Why: the root-containment guards elsewhere in this file check that
 * `path.resolve(rootReal, file)` stays inside `rootReal` — but a `file`
 * carrying leading `../` segments can satisfy that (by re-descending
 * back into the root under a different spelling) while still being
 * dangerous if used VERBATIM as a journal key, because
 * `writeBackupJournal` joins it against a DIFFERENTLY-nested directory
 * (`rootReal/.desde/backups/<ts>-<uuid>/`, three segments deeper)
 * — enough `../`s pop past that nesting (and potentially the repo root
 * itself) before re-descending. `path.relative(rootReal, absPath)` can
 * never produce a leading `..` when `absPath` is genuinely inside
 * `rootReal`, so it structurally can't carry that shape. Response
 * fields the client already keys by the raw request string (`file` in
 * `newHashes`/`conflicts`/etc.) are intentionally left alone — this is
 * a journal-key-only normalization; see `writeBackupJournal`'s own
 * `BackupJournalPathEscapeError` for the defense-in-depth backstop this
 * complements.
 *
 * `path.relative` is the platform-bound `node:path` — backslash
 * separators on Windows. Wrapped in `normalizeLedgerPath` (P1-2,
 * round-3 whole-branch review finding, 2026-08-19): this string becomes
 * the direct lane's `journal`/broker-op key AND, via `describe.files`,
 * the edit ledger's `files` entry — an unnormalized separator there
 * defeats `reconcileLedger`'s exact-string dirty comparison against
 * git's always-forward-slash porcelain output, silently marking a
 * still-dirty Windows edit "committed" forever (the ledger is
 * append-only). The chat lane's equivalent (`toRel` in
 * `src/editor/agent-chat-sdk/edit-ack.ts`) has done this same
 * normalization since the Task 14 review; this was the one producer
 * that hadn't caught up. See `normalizeLedgerPath`'s doc comment for
 * the full picture.
 */
function repoRelOf(rootReal: string, absPath: string): string {
  return normalizeLedgerPath(path.relative(rootReal, absPath))
}

/**
 * The external library a repo-relative path belongs to, for refusal copy.
 *
 * The designer recognises `@acme/design-system`; they have never opened
 * `node_modules` and cannot place a bare stylesheet basename. Naming the
 * package is what turns "this is refused" into "this belongs to something you
 * installed". Returns undefined when the layout yields no name, so the caller
 * falls back to the bare noun phrase rather than printing a fragment.
 *
 * Scoped packages take two segments, unscoped take one. Deliberately duplicated
 * from the shell's `packageNameFromPath` (`delete-scope-dialog.tsx`) rather
 * than shared: the two live on opposite sides of the CLI/shell boundary, and
 * six lines is a smaller cost than a new cross-boundary import for copy.
 */
function installedPackageName(segments: readonly string[]): string | undefined {
  const at = segments.lastIndexOf("node_modules")
  if (at === -1) return undefined
  const first = segments[at + 1]
  if (!first) return undefined
  // A package name must be a DIRECTORY, so something has to follow it. Without
  // this, `node_modules/stray.css` reports the package as "stray.css". An
  // extension check would not do instead: `lodash.merge` is a real package.
  const scoped = first.startsWith("@")
  const nameEnd = scoped ? at + 2 : at + 1
  if (segments.length <= nameEnd + 1) return undefined
  const second = segments[at + 2]
  if (!scoped) return first
  return second ? `${first}/${second}` : undefined
}

/**
 * Edit handler for the CLI's `POST /api/editor/edit` endpoint.
 * Shares the same validator (`validate-edit-request.ts`) and pure
 * applicators (`src/editor/edit-service/`) as the rest of the edit
 * pipeline. Path-traversal + applicator dispatch live here because
 * they're tied to the transport's notion of "where the prototype root
 * is" (constructor arg) and didn't extract cleanly alongside the
 * applicators.
 */

export interface EditResult {
  ok: boolean
  status: number
  reason?: string
  file?: string
  /** Post-write SHA-256 hashes per file (llm-patch only). */
  newHashes?: Record<string, string>
  /**
   * Populated on 409 (external-edit-conflict). Lists files whose
   * pre-write hash didn't match the client's `baseHashes` entry.
   */
  conflicts?: Array<{ file: string; expected: string; actual: string }>
  /**
   * Relative path (under repoRoot) of the .desde/backups/{ts}/
   * directory holding pre-write copies. Surfaced to the client so the
   * engineer can recover the previous state.
   */
  backupDir?: string
  /**
   * Set when the deterministic lane couldn't apply the edit AND the
   * request opted into `'chat'` fallback mode (`edit.llmFallback`): the
   * server skips the LLM patch lane and signals the client to hand the
   * edit to the chat agent instead.
   */
  needsChat?: boolean
  /**
   * Set when the deterministic lane refused a prop edit with a
   * `PropEditFallbackHint` and the source-aware LLM fallback was used
   * instead. Value is `'source-aware-llm'`.
   */
  fallbackUsed?: 'source-aware-llm' | 'agent-mini-turn'
  /** Notes from the source-aware LLM fallback (if `fallbackUsed` is set). */
  notes?: string
  /**
   * INTERNAL, never serialized to the client. Set when `miniTurnPolicy:
   * 'defer'` was requested and the deterministic lane refused in a way that
   * WOULD have engaged the agent mini-turn. The CLI route uses it to release
   * the per-file edit locks and re-enter under the EXCLUSIVE tree lock before
   * running the turn — the mini-turn verifies and rolls back via whole-repo
   * `git status` snapshot diffs, so a concurrent edit to any other file
   * during its (up to 90s) window would be misattributed to the agent, or
   * reverted by its cleanup. See `runEditWithMiniTurnEscalation` in
   * `http-server.ts`.
   */
  deferredMiniTurn?: boolean
  /**
   * Non-fatal advisories from a deterministic applicator that still
   * succeeded — e.g. an `insert` landed the element but could not
   * auto-add the component's import (no `<script setup>`, name already
   * bound, unparseable script). The write happened and is reported
   * `ok: true`; the client/agent should surface these so an unresolved
   * tag isn't mistaken for a clean edit.
   */
  warnings?: string[]
}

/**
 * What every deterministic applicator returns, normalized. `fallback` is the
 * typed refusal hint: a `PropEditFallbackHint` engages the agent mini-turn,
 * a `JsxStyleFallbackHint` (audit Task 23) routes to the "adjust it via chat"
 * refusal. Routing is by hint TYPE, never by a reason-string suffix.
 */
type ApplicatorResult =
  | { ok: true; source: string; warnings?: string[] }
  | {
      ok: false
      reason: string
      fallback?:
        | import("../../../src/editor/edit-service/apply-prop-edit").PropEditFallbackHint
        | import("../../../src/editor/edit-service/apply-jsx-style-edit").JsxStyleFallbackHint
    }

/**
 * Outcome of the DISPATCH step. Either the applicator ran and produced an
 * {@link ApplicatorResult} (`applied`), or the lane terminated early with an
 * {@link EditResult} the handler returns as-is (applicator loader not wired,
 * a lane-specific 4xx, the overwrite lane's external-edit 409, …).
 *
 * Discriminated by `"applied" in outcome` so the early returns inside the
 * dispatch chain keep their exact `{ ok, status, reason }` shape.
 */
type DispatchOutcome = { applied: ApplicatorResult } | EditResult

/**
 * Apply an edit to a file under `repoRoot`. Path-traversal and symlink
 * checks mirror the Next route exactly. The CLI's `repoRoot` argument
 * replaces the route's `EDITOR_PROTOTYPE_ROOT` env var — semantically
 * the same boundary, sourced differently.
 *
 * Applicators are dynamically imported from the in-tree
 * `src/editor/edit-service/` modules via the `applicatorLoaders`
 * argument. Tests inject stubs; production wires the real ones from
 * the parent repo (the CLI lives inside the desde monorepo, so it
 * can import them via path).
 */
export interface ApplyEditOpts {
  /**
   * Live token callback for the llm-patch path's underlying LLM call.
   * When set, the streaming branch in http-server.ts forwards each
   * delta to the shell over SSE so the save dialog can render the
   * model's response in real time. Ignored for non-llm-patch edit
   * kinds (the deterministic applicators don't call any LLM).
   */
  onTextDelta?: (delta: string) => void
  /**
   * Design-system grounding provider for the WS4 agent mini-turn fallback
   * (same object the chat route uses). Threaded from the route context;
   * absent in older callers/tests — the mini-turn then runs without the
   * grounding tools registered.
   */
  getGrounding?: import("../../../src/editor/agent-chat-sdk/edit-fix-mini-turn").EditFixMiniTurnInput["getGrounding"]
  /**
   * Factory for a headless review surface the mini-turn can verify against
   * (null when Playwright can't launch). The fallback creates it lazily
   * right before the turn and disposes it after — zero cost when the
   * deterministic lane succeeds.
   */
  createReviewSurface?: () => Promise<
    import("../../../src/editor/core/review-surface").ReviewSurface | null
  >
  /**
   * Whether this call may run the agent mini-turn fallback in place.
   *
   * `'run'` (default, and what every direct caller/test gets) — historical
   * behavior: a refusal with a `PropEditFallbackHint` engages the turn
   * immediately.
   *
   * `'defer'` — refuse instead, with `deferredMiniTurn: true`, and change
   * nothing on disk. The CLI route passes this on its FIRST pass, which runs
   * under per-file locks; the mini-turn's git-snapshot verification/rollback
   * needs whole-tree exclusivity, so the route re-enters under the exclusive
   * tree lock and calls again with `'run'`.
   */
  miniTurnPolicy?: "run" | "defer"
  /**
   * Dormant edit lanes this project has opted back in to
   * (`enabled-lanes.ts`; `{ "lanes": { "detach": true } }` in
   * `desde.config.json`). Absent — which is every direct caller
   * that predates the gate — means NOTHING is opted in, so a dormant kind is
   * refused. Fail-closed on purpose: the alternative is a forgotten thread
   * silently re-opening a lane the product decided not to offer.
   */
  enabledLanes?: ReadonlySet<DormantLaneId>
  /**
   * The provider the project's non-chat lanes run on, resolved once per
   * request by the route (`resolveLlmConfig`). Absent in older callers and
   * tests, which keeps the registry's own default.
   */
  getLlmProvider?: () => import("../../../src/editor/llm-providers/types").CompletionProvider
  /**
   * That provider's id, for the lane gates that must refuse rather than run.
   * Separate from the factory because the refusal must NOT construct a
   * provider (constructing one throws on a missing key, which is a different
   * failure with a different message).
   */
  llmProviderId?: string
  /**
   * Loaders `resolveChatRuntime` needs to dispatch the mini-turn to the
   * project's actual provider (Claude Agent SDK vs the neutral runtime).
   * Absent in older callers/tests, which keeps the mini-turn's own built-in
   * default (the Claude Agent SDK runtime) — the same behavior this project
   * had before per-provider dispatch existed.
   */
  chatLoaders?: ChatHandlerLoaders
}

export async function applyEdit(
  body: EditRequestBody,
  repoRoot: string,
  applicatorLoaders: ApplicatorLoaders,
  conventions?: ProjectKnowledgeConfig,
  opts: ApplyEditOpts = {},
): Promise<EditResult> {
  // ── Step 1: validate the request (shape + identifier names) ────────
  const validateEditRequest = await loadValidator()
  const validation = validateEditRequest(body)
  if (validation) {
    return { ok: false, status: 400, reason: validation }
  }

  // ── Step 1b: dormant-lane gate ─────────────────────────────────────
  // `detach` and `swap` are gated OFF by default (product decision 2026-08-11,
  // `tasks/dev-server-hosts.md` § 9e — Vue-only AND unused). This is the
  // DISPATCH half of that gate; the OFFERING half lives in the shell
  // (`editor-right-rail.tsx`). Both are needed: gating the UI alone leaves the
  // edit API reachable by a stale client or a direct caller, and gating
  // dispatch alone leaves controls that fail on click.
  //
  // It sits AFTER shape validation deliberately. A malformed body should still
  // get its specific shape error — "your dormant-lane request is also missing
  // componentFile" is more useful than either message alone, and putting
  // dormancy first would mask every validator message for these two kinds.
  // It sits BEFORE path resolution just as deliberately: a refused lane must
  // not touch the filesystem at all.
  const laneRefusal = dormantLaneRefusal(body.edit.kind, opts.enabledLanes)
  if (laneRefusal) {
    return { ok: false, status: 400, reason: laneRefusal }
  }

  // LLM-patch path is multi-file and shape-distinct (no file/line/column).
  if (body.edit.kind === "llm-patch") {
    return handleLLMPatch(
      body.edit.mutations,
      repoRoot,
      applicatorLoaders,
      body.edit.baseHashes,
      conventions,
      opts.onTextDelta,
      body.edit.llmFallback,
      opts.getGrounding,
      body.correlationId,
      opts.getLlmProvider,
    )
  }

  const file = body.edit.file

  // Identifier guards (propName / componentName / fromComponentName /
  // toComponentName regexes) moved into `validateEditRequest` in audit Task 23
  // — shape and identifier validation now share one call, so a new kind can't
  // pick up a shape check while missing its identifier check.
  //
  // This one stays: it's a CROSS-FIELD invariant of the handler's single-file
  // write contract, not an identifier shape. (The validator refuses the same
  // body first with its own message; kept as defense in depth for any caller
  // that reaches the handler with a hand-built body.)
  if (body.edit.kind === "move") {
    if (body.edit.destFile !== file) {
      return {
        ok: false,
        status: 400,
        reason: "Cross-file moves are not supported in V1: destFile must match file",
      }
    }
  }

  // ── Step 2: resolve the target path inside the prototype root ──────
  const rootResolution = await resolvePrototypeRoot(repoRoot)
  if (!rootResolution.ok) return rootResolution
  const { rootReal, rootWithSep } = rootResolution
  const candidateResolution = resolveCandidateWithinRoot(file, rootResolution)
  if (!candidateResolution.ok) return candidateResolution
  const candidate = candidateResolution.candidate

  // ── Step 3: extension gate (pre-symlink) ───────────────────────────
  // Which extensions this lane may touch. The truth table lives in ONE pure
  // function (`edit-extension-gate.ts`) that both this call and the
  // post-symlink call below share — before audit Task 23 it was hand-
  // duplicated, so a new edit kind could be added to one copy and silently
  // missed by the other.
  const candidateGate = checkExtensionGate(body.edit.kind, candidate, "candidate")
  if (!candidateGate.ok) {
    return { ok: false, status: 400, reason: candidateGate.reason }
  }
  const candidateExt: OverwriteExtension | null = candidateGate.ext

  // The allowCreate lane never reaches the realpath/read/dispatch steps below
  // (the file doesn't exist yet), so it terminates here.
  if (body.edit.kind === "overwrite" && body.edit.allowCreate === true) {
    return handleAllowCreate({
      edit: body.edit,
      file,
      repoRoot,
      rootReal,
      candidateExt,
      correlationId: body.correlationId,
    })
  }

  const realpathResolution = await resolveRealpathWithinRoot(candidate, rootResolution)
  if (!realpathResolution.ok) return realpathResolution
  const targetPath = realpathResolution.targetPath

  // ── Step 3b: extension gate (post-symlink) ─────────────────────────
  // Re-check the extension after symlink resolution — SAME truth table,
  // applied to the resolved bytes. Keeps a `foo.vue` symlink pointing at
  // `/etc/passwd` (or `foo.ts` → `bar.sh`) from sneaking through.
  const targetGate = checkExtensionGate(body.edit.kind, targetPath, "resolved")
  if (!targetGate.ok) {
    return { ok: false, status: 400, reason: targetGate.reason }
  }
  const targetIsJsx = targetGate.isJsx
  const targetExt: OverwriteExtension | null = targetGate.ext
  // Token edits can't write into an external library. Refuse when the RESOLVED path (post
  // symlink, so a symlink into node_modules is caught) sits under any
  // node_modules segment. Tokens shipped by a design-system package are
  // read-only; the user must fork them into the prototype to edit.
  //
  // `scoped-css-override` joins it for the same reason and one more: once the
  // lane can write a `.css` (the React destination), the set of writable
  // targets includes every library stylesheet the app loads. Writing there
  // breaks the promise that Editor never modifies library source, and the
  // change is destroyed by the next `npm install` — a silent revert the user
  // would have no way to explain.
  const targetRelSegments = path
    .relative(rootReal, targetPath)
    .split(path.sep)
  if (
    (body.edit.kind === "token-value" ||
      body.edit.kind === "scoped-css-override") &&
    targetRelSegments.includes("node_modules")
  ) {
    // These two strings reach the DESIGNER, so neither `node_modules` nor
    // "library source" belongs in them: one is a directory they have never
    // opened, the other is jargon whose two words both mislead (see
    // docs/design.md § "Installed packages"). "Fork it into your prototype"
    // went the same way, and it was worse than jargon: `fork` is engineer-only
    // AND it named a manual workaround as if it were a product action. Naming
    // the package is what makes this recognisable, so derive it when we can.
    const pkg = installedPackageName(targetRelSegments)
    const inPackage = pkg ? `\`${pkg}\`, an external library` : "an external library"
    return {
      ok: false,
      status: 400,
      reason:
        body.edit.kind === "token-value"
          ? `Can't edit this token: it's defined in ${inPackage}. Set your own value in one of your project's stylesheets instead.`
          : // The reinstall consequence appears HERE and nowhere else. This is
            // the only refusal where a write was attempted and would otherwise
            // have worked, so it is the only place the user needs to know the
            // change would not have survived. Elsewhere it is a hypothetical.
            `Can't save this style into ${inPackage}. An update to that library would wipe the change. Save the style in one of your project's stylesheets instead.`,
    }
  }

  let source: string
  try {
    source = await fs.readFile(targetPath, "utf8")
  } catch (err) {
    return {
      ok: false,
      status: 404,
      reason: `Could not read file: ${(err as Error).message}`,
    }
  }

  const staleRefusal = checkStaleTarget(body.edit, source, file)
  if (staleRefusal) return staleRefusal

  // ── Step 4: dispatch to the applicator for this kind ───────────────
  const outcome = await dispatchApplicator(body, {
    source,
    file,
    targetIsJsx,
    targetExt,
    rootReal,
    rootWithSep,
    applicatorLoaders,
  })
  if (!("applied" in outcome)) return outcome
  const result = outcome.applied

  if (!result.ok) {
    return await handleApplicatorRefusal({
      body,
      result,
      file,
      source,
      targetPath,
      rootReal,
      applicatorLoaders,
      opts,
    })
  }

  // Route through the write broker (audit Task 14) — this is the
  // highest-volume edit lane (every deterministic inspector/prop/move/
  // detach/… tweak), and before this it was the one write site with no
  // backup-journal entry. `source` is the pre-edit bytes already read
  // above; journaling it here is what makes `.desde/backups/` a
  // complete undo trail instead of covering only the llm-patch lanes.
  // No `invalidate`/`emit` passed — Vite invalidation for this path runs
  // at the route layer (`invalidateViteModules` in http-server.ts, gated
  // on `result.ok`), so passing one here would invalidate twice.
  //
  // The journal/op key is `repoRelOf(rootReal, targetPath)` — derived
  // from the already-resolved absolute target — NEVER the raw `file`
  // request string (see `repoRelOf`'s doc comment). `newHashes` below
  // still keys by the raw `file` (response shape unchanged).
  //
  // Deliberate contract note: a journal-write failure (`stage:
  // 'backup'`) now 500s an edit that, before this task, would have
  // succeeded (the write went straight through with no journal step to
  // fail). This matches every other lane (llm-patch, the SDK structural
  // tools) — an edit whose backup can't be written is refused rather
  // than landing un-recoverably.
  const { brokeredWrite, rollbackWarning } = await loadBrokeredWrite()
  const repoRel = repoRelOf(rootReal, targetPath)
  const broker = await brokeredWrite({
    canonicalRoot: rootReal,
    journal: [{ file: repoRel, content: source }],
    ops: [{ kind: "write", repoRel, absPath: targetPath, content: result.source }],
    record: { history: getSharedEditHistory(), label: `${body.edit.kind}: ${file}` },
    describe: {
      kind: body.edit.kind,
      lane: "direct",
      fields: ledgerFieldsForEdit(body.edit),
      correlationId: body.correlationId,
    },
  })
  if (!broker.ok) {
    // A protected-path refusal is a policy decision, not a server fault —
    // 403, not 500, so the client does not present it as a bug to retry.
    if (broker.stage === "refused") {
      return { ok: false, status: 403, reason: broker.reason }
    }
    return {
      ok: false,
      status: 500,
      reason:
        broker.stage === "backup"
          ? `${broker.reason}. Edit aborted; no source files modified.`
          : `Could not write file: ${broker.reason}${rollbackWarning(broker)}`,
    }
  }

  // Post-write hash for the client's per-file registry + buffered-edit
  // rebase (codex round-15): a follow-up edit re-fired from the buffer
  // must carry THIS write's hash, or the stale-target guard rejects it
  // for a change we made ourselves.
  const newHashes = { [file]: sha256Hex(result.source) }
  return result.warnings && result.warnings.length > 0
    ? { ok: true, status: 200, file, warnings: result.warnings, newHashes, backupDir: broker.backupDir }
    : { ok: true, status: 200, file, newHashes, backupDir: broker.backupDir }
}

/**
 * Phase 4: the `allowCreate` overwrite lane — an overwrite whose target file
 * doesn't exist yet. Terminal: it never reaches realpath / read / dispatch.
 *
 *   - Skip realpath (would fail with ENOENT).
 *   - Re-validate the candidate stays inside the prototype root, symlink-safely.
 *   - Validate the new source compiles.
 *   - Create parent dirs and write.
 *   - Refuse to overwrite an EXISTING file via this path (matches the
 *     tool-level guard in `propose_new_file`, defense in depth).
 */
async function handleAllowCreate(args: {
  edit: Extract<EditRequestBody["edit"], { kind: "overwrite" }>
  file: string
  /** Raw (un-realpath'd) root — `resolveSafeCreatePath` walks it itself. */
  repoRoot: string
  /** Realpath'd root, for the broker's containment check + journal keys. */
  rootReal: string
  /** Extension classification from the pre-symlink gate. */
  candidateExt: OverwriteExtension | null
  /** See `EditRequestBody.correlationId`. */
  correlationId?: string
}): Promise<EditResult> {
  const { edit: overwriteBody, file, repoRoot, rootReal, candidateExt } = args
  {
    // Overwrite admits .vue/.ts/.tsx/.jsx → candidateExt is non-null here (the
    // token lane is the only null-ext case and can't reach this branch).
    if (!candidateExt) {
      return {
        ok: false,
        status: 400,
        reason: "Overwrite requires a .vue, .ts, .tsx, or .jsx file",
      }
    }
    // Symlink-safe path resolution: refuses pre-staged symlinks in any
    // ancestor or the leaf itself. See safe-create-path.ts header for
    // the attack model.
    const { resolveSafeCreatePath } = await import(
      "../../../src/editor/edit-service/safe-create-path"
    )
    const safe = await resolveSafeCreatePath(repoRoot, file)
    if (!safe.ok) {
      // The "already exists" arm of resolveSafeCreatePath returns a
      // friendlier-shaped error here so the chat surface can tell the
      // user "use propose_overwrite instead."
      if (/already exists/.test(safe.reason)) {
        return {
          ok: false,
          status: 409,
          reason:
            "allowCreate refused: file already exists. Use propose_overwrite to modify an existing file.",
        }
      }
      return { ok: false, status: 400, reason: `allowCreate refused: ${safe.reason}` }
    }
    const { validateOverwriteSource } = await import(
      "../../../src/editor/edit-service/validate-overwrite-source"
    )
    const validation = await validateOverwriteSource(overwriteBody.newSource, {
      extension: candidateExt,
    })
    if (!validation.ok) {
      return { ok: false, status: 422, reason: `New file refused: ${validation.reason}` }
    }
    // Route through the write broker (audit Task 14) for consistency with
    // every other write lane — even though there's no PRIOR content to
    // snapshot (journal: [], so nothing lands under `.desde/backups/`
    // and the response omits `backupDir`, see below), a later failing op
    // in a bigger batch this op ever joins knows `isNew` means "rollback =
    // unlink", not "rollback = restore".
    //
    // `exclusive: true` preserves the check/write race fix `flag: 'wx'`
    // used to close directly: `resolveSafeCreatePath`'s non-existence
    // check above can't itself be locked, so two concurrent `allowCreate`
    // requests for the same path can both pass it. The broker's per-path
    // write lock serializes the two calls; `exclusive` makes the loser's
    // write fail atomically with EEXIST instead of clobbering the
    // winner's file (see the `exclusive` doc in write-broker.ts for why
    // the winner's content survives the loser's snapshot/restore).
    const { brokeredWrite, rollbackWarning } = await loadBrokeredWrite()
    const broker = await brokeredWrite({
      canonicalRoot: rootReal,
      journal: [],
      ops: [
        {
          kind: "write",
          repoRel: repoRelOf(rootReal, safe.absolute),
          absPath: safe.absolute,
          content: overwriteBody.newSource,
          ensureDir: true,
          isNew: true,
          exclusive: true,
        },
      ],
      // `edit.kind` is always `"overwrite"` on this lane (allowCreate is
      // only reachable via the overwrite branch above) — `create: <file>`
      // is the label that actually distinguishes this in the undo/redo
      // toolbar, matching the deterministic lane's `<kind>: <file>` shape.
      record: { history: getSharedEditHistory(), label: `create: ${file}` },
      describe: { kind: "overwrite", lane: "direct", correlationId: args.correlationId },
    })
    if (!broker.ok) {
      // Policy refusal, not a server fault — see the sibling handler above.
      if (broker.stage === "refused") {
        return { ok: false, status: 403, reason: broker.reason }
      }
      if (broker.stage === "backup") {
        return {
          ok: false,
          status: 500,
          reason: `${broker.reason}. Could not create file.`,
        }
      }
      if (broker.reason.startsWith("EEXIST")) {
        return {
          ok: false,
          status: 409,
          reason: `File already exists: ${file}. allowCreate refused after a concurrent create completed.`,
        }
      }
      return {
        ok: false,
        status: 500,
        reason: `Could not create file: ${broker.reason}${rollbackWarning(broker)}`,
      }
    }
    // No `backupDir` on the response: `journal: []` means
    // `writeBackupJournal` never created the directory it named (mkdir
    // only runs per journal entry — see its loop), so
    // `broker.backupDir` would point at a path that doesn't exist on
    // disk. Advertising it as a recovery location would be misleading;
    // recovery for a create is `rm`, which the working tree already
    // makes obvious.
    return { ok: true, status: 200, file }
  }
}

/**
 * Stale-target guard (WS1, tasks/edit-pipeline-rearchitecture.md; widened to
 * every coordinate-matched kind in audit Task 23).
 *
 * A coordinate-matched edit may carry the per-file `data-desde-v` hash captured
 * together with its coordinates from the same DOM snapshot. When the on-disk
 * file no longer matches, the coordinates provably predate the current bytes —
 * splicing could silently edit whatever now occupies that position (the
 * reproduced wrong-button case). Refuse loud; the client re-captures from a
 * fresh DOM. Prefix compare: the stamp is a SHA-256 prefix (12 hex chars).
 *
 * Applies to prop / move (original two) plus delete / unwrap /
 * detach / swap / flatten-conditional. It is CONDITIONAL ON PRESENCE: a kind
 * whose request carries no `baseHash` — because the shell had no `data-desde-v`
 * stamp to capture, or the kind isn't coordinate-matched at all (`text-branch`
 * and `token-value` locate by byte range / token name) — passes through
 * unchanged. That also means adding the field to a new kind is all it takes to
 * opt in; there is no per-kind list here to forget to update.
 *
 * `overwrite` is deliberately EXCLUDED: it carries its own `baseHash` with
 * different semantics (full 64-char SHA-256, exact compare, 409 carrying a
 * `conflicts` array) checked in its dispatch branch. `llm-patch` never reaches
 * here — `handleLLMPatch` runs its own per-mutation version check.
 */
function checkStaleTarget(
  edit: EditRequestBody["edit"],
  source: string,
  file: string,
): EditResult | null {
  if (edit.kind === "overwrite") return null
  const expectedHashes = [
    (edit as { baseHash?: unknown }).baseHash,
    // Only move carries a destination stamp; no other kind has a second
    // coordinate-bearing file.
    edit.kind === "move" ? edit.destBaseHash : undefined,
  ].filter((h): h is string => typeof h === "string" && h.length > 0)
  if (expectedHashes.length === 0) return null

  const actual = sha256Hex(source)
  const stale = expectedHashes.find((h) => !actual.startsWith(h.toLowerCase()))
  if (!stale) return null
  return {
    ok: false,
    status: 409,
    reason: `Stale target: ${file} changed since this element was captured (source version ${stale} no longer matches). The prototype has re-rendered from newer source. Re-select the element and retry.`,
  }
}

/** Everything the dispatch step needs beyond the request body itself. */
interface DispatchContext {
  /** Pre-edit bytes of the resolved target. */
  source: string
  /** The raw request path (response/journal keying + refusal messages). */
  file: string
  /** Whether the RESOLVED target is React JSX — selects the Babel applicators. */
  targetIsJsx: boolean
  /** Extension classification of the resolved target (overwrite validator). */
  targetExt: OverwriteExtension | null
  rootReal: string
  rootWithSep: string
  applicatorLoaders: ApplicatorLoaders
}

/**
 * The DISPATCH step: route a validated, path-resolved, extension-gated edit to
 * the applicator for its kind and return that applicator's result.
 *
 * Framework-aware throughout: branches key off `targetIsJsx` (the RESOLVED
 * target extension, post-realpath — not the lexical request path) so a `.vue`
 * symlink pointing at a `.tsx` target reaches the applicator that matches the
 * bytes actually being edited (codex P3).
 */
async function dispatchApplicator(
  body: EditRequestBody,
  ctx: DispatchContext,
): Promise<DispatchOutcome> {
/**
 * Try the Vue script-JSX family for a `.vue`, returning `null` when the
 * coordinate is not inside a `<script setup lang="tsx">` block.
 *
 * `null` is a ROUTING signal, deliberately distinct from a refusal: it means
 * "not mine", and the caller falls through to the Vue template applicator. A
 * refusal is this family's own answer and must NOT fall through, or a genuine
 * failure would be retried against a parser that cannot read the block and
 * would report a misleading reason.
 *
 * Centralised so every kind routes identically — the extension check, the
 * loader guard and the null contract live in one place rather than being
 * restated (and eventually diverging) per branch.
 */
async function tryVueScriptJsx(
  applicatorLoaders: ApplicatorLoaders,
  targetExt: OverwriteExtension | null,
  run: (
    m: typeof import("../../../src/editor/edit-service/apply-vue-script-jsx-edit"),
  ) => ApplicatorResult | null,
): Promise<ApplicatorResult | null> {
  if (targetExt !== "vue" || !applicatorLoaders.loadApplyVueScriptJsx) return null
  return run(await applicatorLoaders.loadApplyVueScriptJsx())
}

  const { source, file, targetIsJsx, targetExt, rootReal, rootWithSep, applicatorLoaders } = ctx

  let result: ApplicatorResult

  if (body.edit.kind === "prop") {
    // Framework-aware dispatch: React .tsx/.jsx → applyJsxPropEdit (Babel),
    // Vue .vue → applyPropEdit (@vue/compiler-dom). Both return the same
    // result/fallback shape so the LLM-fallback lane below is uniform.
    // Branch on the RESOLVED target extension (post-realpath), not the lexical
    // request path, so a .vue symlink → .tsx target (or the reverse) reaches
    // the applicator that matches the bytes actually being edited (codex P3).
    if (targetIsJsx) {
      if (!applicatorLoaders.loadApplyJsxPropEdit) {
        return { ok: false, status: 500, reason: "JSX prop applicator is not wired" }
      }
      const { applyJsxPropEdit } = await applicatorLoaders.loadApplyJsxPropEdit()
      result = applyJsxPropEdit({
        source,
        line: body.edit.line,
        column: body.edit.column,
        propName: body.edit.propName,
        value: body.edit.value as Parameters<typeof applyJsxPropEdit>[0]["value"],
      })
    } else {
      // A `.vue` is not one language. Its template block is Vue markup and its
      // `<script setup lang="tsx">` block is JSX, and since 2026-08-09 BOTH are
      // source-stamped — so a coordinate arriving for a `.vue` may belong to
      // either. Extension alone cannot tell them apart; only the coordinate
      // can. Ask the script-JSX applicator first: it returns null for anything
      // that is not inside a JSX script block, which is the fall-through to the
      // template applicator below.
      //
      // Column conventions differ BY DESIGN and are already correct on each
      // side — template stamps are 1-based (what `applyPropEdit` wants),
      // script-JSX stamps keep Babel's 0-based (what `applyJsxPropEdit` wants)
      // — so neither branch adjusts the column. Routing on extension instead
      // would feed a 0-based column to the 1-based applicator and be off by
      // one on every script-block edit.
      // `null` here means "not my coordinate" — distinct from a refusal, and
      // the signal to fall through to the template applicator.
      let scriptJsxResult: ApplicatorResult | null = null
      if (targetExt === "vue" && applicatorLoaders.loadApplyVueScriptJsx) {
        const { applyVueScriptJsxPropEdit } = await applicatorLoaders.loadApplyVueScriptJsx()
        scriptJsxResult = applyVueScriptJsxPropEdit({
          source,
          line: body.edit.line,
          column: body.edit.column,
          propName: body.edit.propName,
          value: body.edit.value as Parameters<typeof applyVueScriptJsxPropEdit>[0]["value"],
        })
      }
      if (scriptJsxResult !== null) {
        result = scriptJsxResult
      } else {
        const { applyPropEdit } = await applicatorLoaders.loadApplyPropEdit()
        result = applyPropEdit({
          source,
          line: body.edit.line,
          column: body.edit.column,
          propName: body.edit.propName,
          value: body.edit.value as Parameters<typeof applyPropEdit>[0]["value"],
        })
      }
    }
  } else if (body.edit.kind === "move") {
    // Framework-aware: React .tsx/.jsx → applyJsxMoveEdit (Babel), Vue → applyMoveEdit.
    if (targetIsJsx) {
      if (!applicatorLoaders.loadApplyJsxMoveEdit) {
        return { ok: false, status: 500, reason: "JSX move applicator is not wired" }
      }
      if ((body.edit as { moveGroup?: boolean }).moveGroup) {
        return {
          ok: false,
          status: 400,
          reason: "Group moves are not supported for React targets yet (Vue <template v-if> groups only)",
        }
      }
      const { applyJsxMoveEdit } = await applicatorLoaders.loadApplyJsxMoveEdit()
      result = applyJsxMoveEdit({
        source,
        sourceLine: body.edit.line,
        sourceColumn: body.edit.column,
        destParentLine: body.edit.destParentLine,
        destParentColumn: body.edit.destParentColumn,
        destIndex: body.edit.destIndex,
      })
    } else {
      // Move is the ONE kind the script-JSX family refuses rather than
      // implements, and the reason is structural, not linguistic: it is the
      // only kind with TWO coordinates, and they can land in different blocks.
      // A JSX element cannot become a child of a Vue template node — different
      // languages, different compilers — so doing "something" would relocate a
      // node somewhere the user never pointed at. Refuses when EITHER endpoint
      // is in a JSX block; returns null (falls through) when neither is, so
      // template-only moves are untouched.
      const moveEdit = body.edit
      const scriptJsx = await tryVueScriptJsx(applicatorLoaders, targetExt, (m) =>
        m.refuseVueScriptJsxMove({
          source,
          sourceLine: moveEdit.line,
          destParentLine: moveEdit.destParentLine,
        }),
      )
      if (scriptJsx !== null) {
        result = scriptJsx
      } else {
        const { applyMoveEdit } = await applicatorLoaders.loadApplyMoveEdit()
        result = applyMoveEdit({
          source,
          moveGroup: body.edit.moveGroup,
          sourceLine: body.edit.line,
          sourceColumn: body.edit.column,
          destParentLine: body.edit.destParentLine,
          destParentColumn: body.edit.destParentColumn,
          destIndex: body.edit.destIndex,
        })
      }
    }
  } else if (body.edit.kind === "detach") {
    const componentResolution = await resolveAndReadEditableFile(
      body.edit.componentFile,
      rootReal,
      rootWithSep,
    )
    if (!componentResolution.ok) {
      return {
        ok: false,
        status: componentResolution.status,
        reason: `Component file: ${componentResolution.reason}`,
      }
    }
    const { applyDetachEdit } = await applicatorLoaders.loadApplyDetachEdit()
    result = applyDetachEdit({
      consumerSource: source,
      componentSource: componentResolution.contents,
      componentFile: componentResolution.targetPath,
      componentName: body.edit.componentName,
      callSiteLine: body.edit.line,
      callSiteColumn: body.edit.column,
    })
  } else if (body.edit.kind === "delete") {
    if (targetIsJsx) {
      if (!applicatorLoaders.loadApplyJsxDeleteEdit) {
        return { ok: false, status: 500, reason: "JSX delete applicator is not wired" }
      }
      const { applyJsxDeleteEdit } = await applicatorLoaders.loadApplyJsxDeleteEdit()
      result = applyJsxDeleteEdit({
        source,
        line: body.edit.line,
        column: body.edit.column,
      })
    } else {
      // Block-aware routing, same as `prop` — see the note there. `null` means
      // "not a script-JSX coordinate" and falls through to the Vue applicator.
      // Captured before the closure: `body.edit`'s discriminated narrowing
      // does not survive into a callback.
      const { line: delLine, column: delColumn } = body.edit
      const scriptJsx = await tryVueScriptJsx(applicatorLoaders, targetExt, (m) =>
        m.applyVueScriptJsxDeleteEdit({ source, line: delLine, column: delColumn }),
      )
      if (scriptJsx !== null) {
        result = scriptJsx
      } else {
        if (!applicatorLoaders.loadApplyDeleteEdit) {
          return {
            ok: false,
            status: 503,
            reason: "delete applicator loader not configured",
          }
        }
        const { applyDeleteEdit } = await applicatorLoaders.loadApplyDeleteEdit()
        result = applyDeleteEdit({
          source,
          line: body.edit.line,
          column: body.edit.column,
        })
      }
    }
  } else if (body.edit.kind === "swap") {
    if (!applicatorLoaders.loadApplySwapEdit) {
      return {
        ok: false,
        status: 503,
        reason: "swap applicator loader not configured",
      }
    }
    const { applySwapEdit } = await applicatorLoaders.loadApplySwapEdit()
    const swapResult = applySwapEdit({
      consumerSource: source,
      callSiteLine: body.edit.line,
      callSiteColumn: body.edit.column,
      fromComponentName: body.edit.fromComponentName,
      toComponentName: body.edit.toComponentName,
      propMapping: body.edit.propMapping,
      newComponentRequiredProps: body.edit.newComponentRequiredProps,
      toPackageName: body.edit.toPackageName,
      toFile: body.edit.toFile,
      removeFromImport: body.edit.removeFromImport,
    })
    if (swapResult.ok) {
      result = { ok: true, source: swapResult.source, warnings: swapResult.warnings }
    } else {
      result = swapResult
    }
  } else if (body.edit.kind === "insert") {
    if (targetIsJsx) {
      if (!applicatorLoaders.loadApplyJsxInsertEdit) {
        return { ok: false, status: 500, reason: "JSX insert applicator is not wired" }
      }
      const { applyJsxInsertEdit } = await applicatorLoaders.loadApplyJsxInsertEdit()
      result = applyJsxInsertEdit({
        source,
        destParentLine: body.edit.line,
        destParentColumn: body.edit.column,
        destIndex: body.edit.destIndex,
        snippet: body.edit.snippet,
        contentKind: body.edit.contentKind,
        componentImport: body.edit.componentImport,
      })
    } else {
      const insertEdit = body.edit
      const scriptJsx = await tryVueScriptJsx(applicatorLoaders, targetExt, (m) =>
        m.applyVueScriptJsxInsertEdit({
          source,
          line: insertEdit.line,
          column: insertEdit.column,
          destIndex: insertEdit.destIndex,
          snippet: insertEdit.snippet,
          contentKind: insertEdit.contentKind,
          componentImport: insertEdit.componentImport,
        }),
      )
      if (scriptJsx !== null) {
        result = scriptJsx
      } else {
        if (!applicatorLoaders.loadApplyInsertEdit) {
          return {
            ok: false,
            status: 503,
            reason: "insert applicator loader not configured",
          }
        }
        const { applyInsertEdit } = await applicatorLoaders.loadApplyInsertEdit()
        result = applyInsertEdit({
          source,
          destParentLine: body.edit.line,
          destParentColumn: body.edit.column,
          destIndex: body.edit.destIndex,
          snippet: body.edit.snippet,
          contentKind: body.edit.contentKind,
          componentImport: body.edit.componentImport,
        })
      }
    }
  } else if (body.edit.kind === "overwrite") {
    // The overwrite lane admits .vue/.ts/.tsx/.jsx, so targetExt is non-null
    // here (the token lane — the only other null-ext case — can't reach this
    // branch). Narrow explicitly for the validator below.
    if (!targetExt) {
      return {
        ok: false,
        status: 400,
        reason: "Overwrite requires a .vue, .ts, .tsx, or .jsx file",
      }
    }
    // Tier 2 commit — shared validator AND Phase E baseHash check.
    // Codex review (May 2026) caught that the overwrite lane had no
    // external-edit guard, so an IDE-side edit between propose and
    // approve would be silently clobbered.
    const { validateOverwriteSource } = await import(
      "../../../src/editor/edit-service/validate-overwrite-source"
    )
    if (body.edit.baseHash) {
      const currentHash = createHash("sha256").update(source, "utf8").digest("hex")
      if (currentHash !== body.edit.baseHash) {
        return {
          ok: false,
          status: 409,
          reason:
            "Overwrite refused: file changed on disk since the LLM proposal was generated. Re-fetch the proposal or discard.",
          conflicts: [
            { file, expected: body.edit.baseHash, actual: currentHash },
          ],
        }
      }
    }
    const validation = await validateOverwriteSource(body.edit.newSource, {
      extension: targetExt,
    })
    if (!validation.ok) {
      result = { ok: false, reason: `Overwrite refused: ${validation.reason}` }
    } else {
      // Unlike prop/move/etc., there is no no-op check here: `newSource`
      // identical to `source` still returns `ok: true` and reaches the
      // broker below, so "no-op ⇒ no journal" is an applicator-lane
      // convention (prop/move/detach/… each refuse a same-value edit
      // upstream of the write site), not a property of the write site
      // itself — an identical-content overwrite still journals.
      result = { ok: true, source: body.edit.newSource }
    }
  } else if (body.edit.kind === "unwrap") {
    if (targetIsJsx) {
      if (!applicatorLoaders.loadApplyJsxUnwrapEdit) {
        return { ok: false, status: 500, reason: "JSX unwrap applicator is not wired" }
      }
      const { applyJsxUnwrapEdit } = await applicatorLoaders.loadApplyJsxUnwrapEdit()
      result = applyJsxUnwrapEdit({
        source,
        line: body.edit.line,
        column: body.edit.column,
      })
    } else {
      const { line: unwrapLine, column: unwrapColumn } = body.edit
      const scriptJsx = await tryVueScriptJsx(applicatorLoaders, targetExt, (m) =>
        m.applyVueScriptJsxUnwrapEdit({ source, line: unwrapLine, column: unwrapColumn }),
      )
      if (scriptJsx !== null) {
        result = scriptJsx
      } else {
        if (!applicatorLoaders.loadApplyUnwrapEdit) {
          return {
            ok: false,
            status: 503,
            reason: "unwrap applicator loader not configured",
          }
        }
        const { applyUnwrapEdit } = await applicatorLoaders.loadApplyUnwrapEdit()
        result = applyUnwrapEdit({
          source,
          line: body.edit.line,
          column: body.edit.column,
        })
      }
    }
  } else if (body.edit.kind === "flatten-conditional") {
    if (targetIsJsx) {
      if (!applicatorLoaders.loadApplyJsxFlattenConditionalEdit) {
        return { ok: false, status: 500, reason: "JSX flatten-conditional applicator is not wired" }
      }
      const { applyJsxFlattenConditionalEdit } =
        await applicatorLoaders.loadApplyJsxFlattenConditionalEdit()
      result = applyJsxFlattenConditionalEdit({
        source,
        line: body.edit.line,
        column: body.edit.column,
        branchToKeep: body.edit.branchToKeep,
      })
    } else {
      if (!applicatorLoaders.loadApplyFlattenConditionalEdit) {
        return {
          ok: false,
          status: 503,
          reason: "flatten-conditional applicator loader not configured",
        }
      }
      const { applyFlattenConditionalEdit } =
        await applicatorLoaders.loadApplyFlattenConditionalEdit()
      result = applyFlattenConditionalEdit({
        source,
        line: body.edit.line,
        column: body.edit.column,
        branchToKeep: body.edit.branchToKeep,
      })
    }
  } else if (body.edit.kind === "scoped-css-override") {
    if (!applicatorLoaders.loadApplyScopedCssOverrideEdit) {
      return {
        ok: false,
        status: 503,
        reason: "scoped-css-override applicator loader not configured",
      }
    }
    const { applyScopedCssOverrideEdit } =
      await applicatorLoaders.loadApplyScopedCssOverrideEdit()
    // The ANCHOR (the coordinate in the rule head) is not the DESTINATION
    // (`body.edit.file`, the only path this handler resolves and guards).
    // They coincide on a Vue SFC and diverge on React, where the rule is
    // written into a project `.css` and names a `.tsx` coordinate. Older
    // senders supply only the destination triple — for them the two ARE the
    // same, which is exactly the pre-split shape.
    const destinationIsCss = body.edit.file.endsWith(".css")
    result = applyScopedCssOverrideEdit({
      source,
      destination: destinationIsCss ? "css-file" : "vue-sfc",
      anchorFile: body.edit.anchorFile ?? body.edit.file,
      anchorLine: body.edit.anchorLine ?? body.edit.line,
      anchorColumn: body.edit.anchorColumn ?? body.edit.column,
      anchorVersion: body.edit.anchorVersion,
      deepSelector: body.edit.deepSelector,
      applyClasses: body.edit.applyClasses,
      declarations: body.edit.declarations,
    })
  } else if (body.edit.kind === "jsx-style") {
    // React/JSX inline styling — the .tsx/.jsx sibling of scoped-css-override.
    // JSX-only lane (the gate above already refused .vue).
    if (!applicatorLoaders.loadApplyJsxStyleEdit) {
      return {
        ok: false,
        status: 503,
        reason: "jsx-style applicator loader not configured",
      }
    }
    const { applyJsxStyleEdit } = await applicatorLoaders.loadApplyJsxStyleEdit()
    result = applyJsxStyleEdit({
      source,
      line: body.edit.line,
      column: body.edit.column,
      mode: body.edit.mode,
      addClasses: body.edit.addClasses,
      removeClasses: body.edit.removeClasses,
      declarations: body.edit.declarations,
      removeDeclarations: body.edit.removeDeclarations,
    })
  } else if (body.edit.kind === "text-branch") {
    if (targetIsJsx) {
      if (!applicatorLoaders.loadApplyJsxTextBranchEdit) {
        return { ok: false, status: 500, reason: "JSX text-branch applicator is not wired" }
      }
      const { applyJsxTextBranchEdit } =
        await applicatorLoaders.loadApplyJsxTextBranchEdit()
      result = applyJsxTextBranchEdit({
        source,
        byteStart: body.edit.byteStart,
        byteEnd: body.edit.byteEnd,
        valueKind: body.edit.valueKind,
        newValue: body.edit.newValue,
      })
    } else {
      if (!applicatorLoaders.loadApplyTextBranchEdit) {
        return {
          ok: false,
          status: 503,
          reason: "text-branch applicator loader not configured",
        }
      }
      const { applyTextBranchEdit } =
        await applicatorLoaders.loadApplyTextBranchEdit()
      result = applyTextBranchEdit({
        source,
        byteStart: body.edit.byteStart,
        byteEnd: body.edit.byteEnd,
        valueKind: body.edit.valueKind,
        newValue: body.edit.newValue,
      })
    }
  } else if (body.edit.kind === "token-value") {
    if (!applicatorLoaders.loadApplyTokenEdit) {
      return {
        ok: false,
        status: 503,
        reason: "token-value applicator loader not configured",
      }
    }
    const { applyTokenEdit } = await applicatorLoaders.loadApplyTokenEdit()
    result = applyTokenEdit({
      source,
      tokenName: body.edit.tokenName,
      newValue: body.edit.newValue,
      selector: body.edit.selector,
    })
  } else {
    return { ok: false, status: 422, reason: "Unsupported edit kind" }
  }

  return { applied: result }
}

/**
 * Route a REFUSED applicator result to its terminal `EditResult`.
 *
 * Three outcomes, chosen by the refusal's TYPED fallback hint (audit Task 23
 * — previously the jsx-style arm was selected by `body.edit.kind` and signaled
 * through a hardcoded reason-string suffix):
 *
 *  1. `PropEditFallbackHint` on a prop edit → the source-aware agent mini-turn
 *     (or a deferral / direct chat escalation, per `miniTurnPolicy` and the
 *     value type).
 *  2. `JsxStyleFallbackHint` → an actionable "adjust it via chat" refusal;
 *     there's no deterministic splice and the mini-turn's prompt is prop/text
 *     shaped, not a className composition.
 *  3. Anything else → the applicator's own reason as a plain 422.
 */
async function handleApplicatorRefusal(args: {
  body: EditRequestBody
  result: Extract<ApplicatorResult, { ok: false }>
  file: string
  source: string
  targetPath: string
  rootReal: string
  applicatorLoaders: ApplicatorLoaders
  opts: ApplyEditOpts
}): Promise<EditResult> {
  const { body, result, file, source, targetPath, rootReal, applicatorLoaders, opts } = args
  const { isJsxStyleFallbackHint } = await import(
    "../../../src/editor/edit-service/apply-jsx-style-edit"
  )
  const hint = result.fallback

  // jsx-style refusals carry a typed hint (bound className `{cn(...)}` /
  // `style={base}`, or a `{...spread}` that may override) — common in React.
  // There's no clean deterministic splice and the (prop/text-shaped)
  // source-aware lane doesn't fit a className composition, so explicitly
  // surface an actionable refusal (use chat) rather than letting the hint fall
  // through as a bare 422.
  if (isJsxStyleFallbackHint(hint)) {
    return {
      ok: false,
      status: 422,
      reason: `${result.reason} The class/style is dynamically composed, so adjust it via chat.`,
    }
  }

  {
    // Source-aware fallback. When `applyPropEdit` refuses with a
    // `fallback` hint (`bound-binding`, `v-model`, `dynamic-vbind`), the
    // deterministic applicator can't rewrite the attribute safely — but
    // a focused LLM pass that traces the binding within the same SFC
    // often can. The source-aware lane is text-only (the prompt is
    // shaped for string literals); numeric / boolean prop edits skip
    // it and, in `'chat'` mode, escalate directly to the chat agent
    // (which can handle any prop value type with its multi-file tools).
    if (body.edit.kind === "prop" && hint) {
      if (typeof body.edit.value === "string") {
        // Lock-scope escalation (Task 11 review, Critical). The mini-turn
        // verifies its own work by diffing whole-repo `git status` snapshots
        // and rolls back everything that turned dirty during its window — so
        // it MUST NOT run while another lane can legitimately write a
        // different file, or that write gets reverted (data loss), counted as
        // agent output, or reported as "the agent also modified X". The route
        // holds only per-file locks on its first pass, so we refuse here and
        // let it re-enter under the exclusive tree lock. Deferral is a pure
        // refusal: nothing has been written at this point (the deterministic
        // applicator refused), so the second pass re-runs the cheap
        // deterministic attempt against freshly-read bytes — which also
        // re-validates the file after the lock gap.
        if (opts.miniTurnPolicy === "defer" && applicatorLoaders.loadRunEditFixMiniTurn) {
          return {
            ok: false,
            status: 422,
            reason: result.reason,
            deferredMiniTurn: true,
          }
        }
        const fallbackResult = await tryPropEditLLMFallback({
          file,
          source,
          targetPath,
          rootReal,
          line: body.edit.line,
          column: body.edit.column,
          propName: body.edit.propName,
          newValue: body.edit.value,
          fallback: hint,
          deterministicReason: result.reason,
          llmFallbackMode: body.edit.llmFallback,
          applicatorLoaders,
          getGrounding: opts.getGrounding,
          createReviewSurface: opts.createReviewSurface,
          // P2-2 (codex review round 3, 2026-08-20) — see
          // `tryPropEditLLMFallback`'s own doc comment on this param.
          correlationId: body.correlationId,
          llmProviderId: opts.llmProviderId,
          chatLoaders: opts.chatLoaders,
        })
        if (fallbackResult !== null) return fallbackResult
      } else if (body.edit.llmFallback === "chat") {
        // Non-string value (number/boolean) on a bound prop in chat mode
        // — skip the (text-only) source-aware lane and escalate directly.
        return {
          ok: false,
          status: 422,
          reason: result.reason,
          needsChat: true,
        }
      }
    }
  }
  return { ok: false, status: 422, reason: result.reason }
}

/** Files the llm-patch / component-resolution lanes may read + edit: Vue SFCs
 *  and React JSX. (Edits route to the right applicator by extension downstream.) */
function isEditableComponentFile(p: string): boolean {
  return p.endsWith(".vue") || p.endsWith(".tsx") || p.endsWith(".jsx")
}

async function resolveAndReadEditableFile(
  requestedPath: string,
  rootReal: string,
  rootWithSep: string,
): Promise<
  | { ok: true; contents: string; targetPath: string }
  | { ok: false; reason: string; status: number }
> {
  const root = { rootReal, rootWithSep }
  const candidateResolution = resolveCandidateWithinRoot(requestedPath, root)
  if (!candidateResolution.ok) return candidateResolution
  const { candidate } = candidateResolution
  if (!isEditableComponentFile(candidate)) {
    return { ok: false, reason: "Only .vue / .tsx / .jsx files are supported", status: 400 }
  }
  const realpathResolution = await resolveRealpathWithinRoot(candidate, root)
  if (!realpathResolution.ok) return realpathResolution
  const { targetPath } = realpathResolution
  if (!isEditableComponentFile(targetPath)) {
    return { ok: false, reason: "Resolved target is not a .vue / .tsx / .jsx file", status: 400 }
  }
  let contents: string
  try {
    contents = await fs.readFile(targetPath, "utf8")
  } catch (err) {
    return { ok: false, reason: `Could not read file: ${(err as Error).message}`, status: 404 }
  }
  return { ok: true, contents, targetPath }
}

/**
 * Edit-applicator loaders. Production wires these to the in-tree
 * `src/editor/edit-service/` modules. Tests can inject stubs.
 */
export interface ApplicatorLoaders {
  loadApplyPropEdit: () => Promise<typeof import("../../../src/editor/edit-service/apply-prop-edit")>
  /** Optional (like the other framework-specific loaders) so partial test
   *  mocks don't have to provide it; production wires it via defaults. */
  loadApplyJsxPropEdit?: () => Promise<typeof import("../../../src/editor/edit-service/apply-jsx-prop-edit")>
  /** JSX inside a Vue SFC's `<script setup lang="tsx">` — see the dispatch note. */
  loadApplyVueScriptJsx?: () => Promise<
    typeof import("../../../src/editor/edit-service/apply-vue-script-jsx-edit")
  >
  loadApplyMoveEdit: () => Promise<typeof import("../../../src/editor/edit-service/apply-move-edit")>
  /** React/JSX structural applicators — optional like the other framework-specific
   *  loaders so partial test mocks needn't provide them; production wires them. */
  loadApplyJsxMoveEdit?: () => Promise<typeof import("../../../src/editor/edit-service/apply-jsx-move-edit")>
  loadApplyDetachEdit: () => Promise<typeof import("../../../src/editor/edit-service/apply-detach-edit")>
  loadApplyDeleteEdit?: () => Promise<typeof import("../../../src/editor/edit-service/apply-delete-edit")>
  loadApplyJsxDeleteEdit?: () => Promise<typeof import("../../../src/editor/edit-service/apply-jsx-delete-edit")>
  loadApplyInsertEdit?: () => Promise<typeof import("../../../src/editor/edit-service/apply-insert-edit")>
  loadApplyJsxInsertEdit?: () => Promise<typeof import("../../../src/editor/edit-service/apply-jsx-insert-edit")>
  loadApplyScopedCssOverrideEdit?: () => Promise<typeof import("../../../src/editor/edit-service/apply-scoped-css-override-edit")>
  loadApplyJsxStyleEdit?: () => Promise<typeof import("../../../src/editor/edit-service/apply-jsx-style-edit")>
  loadApplySwapEdit?: () => Promise<typeof import("../../../src/editor/edit-service/apply-swap-edit")>
  loadApplyUnwrapEdit?: () => Promise<typeof import("../../../src/editor/edit-service/apply-unwrap-edit")>
  loadApplyJsxUnwrapEdit?: () => Promise<typeof import("../../../src/editor/edit-service/apply-jsx-unwrap-edit")>
  loadApplyFlattenConditionalEdit?: () => Promise<typeof import("../../../src/editor/edit-service/apply-flatten-conditional-edit")>
  loadApplyJsxFlattenConditionalEdit?: () => Promise<typeof import("../../../src/editor/edit-service/apply-jsx-flatten-conditional-edit")>
  loadApplyTextBranchEdit?: () => Promise<typeof import("../../../src/editor/edit-service/apply-text-branch-edit")>
  loadApplyJsxTextBranchEdit?: () => Promise<typeof import("../../../src/editor/edit-service/apply-jsx-text-branch-edit")>
  loadApplyTokenEdit?: () => Promise<typeof import("../../../src/editor/edit-service/apply-token-edit")>
  loadApplySlotTextEdit?: () => Promise<typeof import("../../../src/editor/edit-service/apply-slot-text-edit")>
  /** React/JSX text-edit applicator — the fast-path's text lane for .tsx/.jsx. */
  loadApplyJsxSlotTextEdit?: () => Promise<typeof import("../../../src/editor/edit-service/apply-jsx-slot-text-edit")>
  loadInferAttrFromTextEdit?: () => Promise<typeof import("../../../src/editor/edit-service/infer-attr-from-text-edit")>
  loadInferAttrFromJsxTextEdit?: () => Promise<typeof import("../../../src/editor/edit-service/infer-attr-from-jsx-text-edit")>
  loadApplyLLMPatch?: () => Promise<typeof import("../../../src/editor/edit-service/apply-llm-patch")>
  loadStyleGrounding?: () => Promise<
    typeof import("../../../src/editor/edit-service/load-style-grounding")
  >
  loadProjectKnowledge?: () => Promise<
    typeof import("../../../src/editor/edit-service/load-project-knowledge")
  >
  /**
   * WS4 (tasks/edit-pipeline-rearchitecture.md): the headless SDK
   * mini-turn that replaced the one-shot source-aware LLM fallback for
   * refused prop edits. Optional so older test stubs skip gracefully
   * (skipping still escalates to chat in 'chat' mode).
   */
  loadRunEditFixMiniTurn?: () => Promise<
    typeof import("../../../src/editor/agent-chat-sdk/edit-fix-mini-turn")
  >
}

/**
 * Module-level cache for the project style context (`ProjectStyleContext`
 * v2 — tokens from the grounding seam + the raw `.vue` classTaxonomy/
 * preprocessor scan). Computed once per `(repoRoot, tokensFingerprint)` pair
 * for the process lifetime (rebuilt when either changes) — the raw `.vue`
 * classTaxonomy/preprocessor scan side stays process-lifetime-cached (that
 * bound is unchanged; matches the sibling `loadCachedProjectKnowledge`
 * staleness note), but the TOKEN-driven half now busts on a token-list
 * fingerprint change (Phase 2 carry-forward I1 — app-token mtime
 * invalidation feeds this key: `CssCustomPropertiesTokenSource.listTokens()`
 * now self-invalidates on the app stylesheet's mtime+size, so an edit to an
 * ALREADY-KNOWN css file changes the fetched token list, changes the
 * fingerprint, and busts this memo instead of serving a stale style context
 * until restart). A brand-new css FILE `discoverTokenStylesheets` hasn't
 * seen yet is still out of scope — that discovery walk stays
 * process-lifetime-cached upstream (`DeferredDesignTokenSource`), so it
 * still needs a restart.
 */
let cliCachedStyleContextKey: string | null = null
let cliCachedStyleContext:
  | import("../../../src/editor/edit-service/llm-patch-prompt").ProjectStyleContext
  | null = null

/**
 * Cheap fingerprint of a fetched token list, used to key the style-context
 * memo below. Chosen over a plain `length` (too coarse — editing a token's
 * VALUE in place wouldn't change the count) and over hashing full file
 * contents (unnecessary — the list is already in memory from the per-call
 * fetch) for an additive rolling hash over every token's name+value: O(total
 * chars) on data that's already resident, so it's effectively free relative
 * to the fetch that produced it, while still catching a value-only edit that
 * a length-or-first/last-name fingerprint would miss.
 */
function computeTokensFingerprint(
  tokens: readonly import("../../../src/editor/core/design-tokens").DesignToken[],
): string {
  let hash = 0
  for (const token of tokens) {
    for (let i = 0; i < token.name.length; i++) {
      hash = (hash * 31 + token.name.charCodeAt(i)) | 0
    }
    for (let i = 0; i < token.value.length; i++) {
      hash = (hash * 31 + token.value.charCodeAt(i)) | 0
    }
  }
  return `${tokens.length}:${hash}`
}

/**
 * Working-state snapshot for the mini-turn's side-effect accounting.
 * `entries` maps every currently-dirty path (tracked-modified AND
 * untracked, from `git status --porcelain`) to a content hash, so a file
 * that was ALREADY dirty before the turn and got FURTHER edits is still
 * detected (codex WS4 P2 — plain set-difference missed it and falsely
 * refused a correct cross-file fix). `untracked` remembers which paths
 * had no committed state (restore = delete, not `git checkout`).
 * Best-effort: null when git is unavailable — callers degrade to
 * target-file-only verification. Hashing is capped to keep pathological
 * trees bounded; over the cap we degrade to path-set semantics.
 */
interface WorkingStateSnapshot {
  entries: Map<string, string | null>
  untracked: Set<string>
}

const SNAPSHOT_HASH_CAP = 200

async function snapshotWorkingState(rootReal: string): Promise<WorkingStateSnapshot | null> {
  try {
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    // `--no-optional-locks`: a plain `git status` may refresh (and therefore
    // LOCK) the index. The mini-turn now runs under the exclusive tree lock,
    // so no editor lane can be holding `.git/index.lock` — but the user's
    // own terminal git is outside our locks entirely, and a snapshot that
    // fails because of a transient index lock makes the mini-turn refuse
    // outright (or land files in `unrestorable`). Read-only status doesn't
    // need the refresh.
    const { stdout } = await promisify(execFile)(
      "git",
      ["--no-optional-locks", "status", "--porcelain"],
      { cwd: rootReal, maxBuffer: 10 * 1024 * 1024 },
    )
    const entries = new Map<string, string | null>()
    const untracked = new Set<string>()
    const lines = stdout.split("\n").filter((l) => l.trim().length > 0)
    for (const line of lines) {
      const status = line.slice(0, 2)
      const p = line.slice(3).trim()
      if (!p) continue
      // Tool-internal state (backups, chat-session sidecars, manifest
      // cache) is never a "change" the mini-turn made to the prototype —
      // excluding it also keeps the no-op guard honest in repos where
      // .desde/ isn't gitignored.
      if (p === ".desde" || p.startsWith(".desde/")) continue
      if (status === "??") untracked.add(p)
      if (entries.size >= SNAPSHOT_HASH_CAP) {
        entries.set(p, null) // over cap: presence-only
        continue
      }
      try {
        const content = await fs.readFile(path.join(rootReal, p), "utf8")
        entries.set(p, sha256Hex(content))
      } catch {
        entries.set(p, null) // deleted/binary/unreadable — presence-only
      }
    }
    return { entries, untracked }
  } catch {
    return null
  }
}

/**
 * Paths the mini-turn changed: newly-dirty paths plus previously-dirty
 * paths whose content hash moved.
 */
function diffWorkingState(
  before: WorkingStateSnapshot,
  after: WorkingStateSnapshot,
): { changed: string[]; newlyPresent: string[]; disappeared: string[] } {
  const changed: string[] = []
  const newlyPresent: string[] = []
  const disappeared: string[] = []
  for (const [p, hash] of after.entries) {
    const prior = before.entries.get(p)
    if (prior === undefined) {
      newlyPresent.push(p)
      changed.push(p)
    } else if (prior !== null && hash !== null && prior !== hash) {
      changed.push(p)
    }
  }
  // A pre-turn dirty path ABSENT from post-turn status means the agent
  // reverted it to HEAD (or deleted a pre-existing untracked file) —
  // i.e. it DISCARDED uncommitted user work (codex final-round P2).
  // Count it as changed so the no-op guard and reporting see it; there
  // is no recoverable original, so cleanup can only report it.
  for (const p of before.entries.keys()) {
    if (!after.entries.has(p)) {
      disappeared.push(p)
      changed.push(p)
    }
  }
  return { changed, newlyPresent, disappeared }
}

/**
 * Best-effort cleanup of mini-turn side effects after a REFUSED outcome
 * (codex WS4 P1 — a timed-out/refusing turn may have half-written files).
 * Newly-dirty tracked files were clean pre-turn, so `git checkout --`
 * restores exactly the pre-turn state; newly-untracked files are removed.
 * Previously-dirty files that changed have no recoverable original here —
 * they're returned for honest reporting instead.
 */
async function restoreMiniTurnSideEffects(
  rootReal: string,
  before: WorkingStateSnapshot,
  after: WorkingStateSnapshot,
): Promise<{ restored: string[]; unrestorable: string[] }> {
  const { changed, newlyPresent } = diffWorkingState(before, after)
  const restored: string[] = []
  const unrestorable: string[] = []
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const run = promisify(execFile)
  for (const p of changed) {
    const isNew = newlyPresent.includes(p)
    try {
      if (isNew && after.untracked.has(p)) {
        // Porcelain reports a NEW untracked directory as `?? dir/` — the
        // removal must be recursive or the rollback throws on the
        // directory and leaves the agent's files behind (codex round-14).
        await fs.rm(path.join(rootReal, p), { recursive: true, force: true })
        restored.push(p)
      } else if (isNew) {
        await run("git", ["checkout", "--", p], { cwd: rootReal })
        restored.push(p)
      } else {
        unrestorable.push(p)
      }
    } catch {
      unrestorable.push(p)
    }
  }
  return { restored, unrestorable }
}

/**
 * Attempt the agent mini-turn fallback for a refused prop edit (WS4,
 * tasks/edit-pipeline-rearchitecture.md — replaced the one-shot
 * source-aware LLM lane 2026-07-24). Returns an `EditResult` on terminal
 * outcomes (success, or agent-side refusal we want to surface), or `null`
 * to fall through to the deterministic refusal response.
 *
 * The mini-turn runs the SAME SDK runtime chat uses (Read/Grep for
 * cross-file binding traces, manifest/token grounding, Edit/Write),
 * headless and budget-bounded. This handler owns write safety around it: the
 * SDK's built-in Write/Edit execute inside the SDK runtime and so never reach
 * FileLockManager, so we snapshot the target pre-turn, refuse agent "success"
 * that changed nothing, parse-validate a changed target, and journal the
 * original to .desde/backups/. (Since audit Task 13 the SDK runtime ALSO
 * journals each built-in write from a PreToolUse hook — see
 * `src/editor/agent-chat-sdk/sdk-write-guard.ts`. That guard's per-file
 * lock is intentionally NOT wired for this lane: we already run under the
 * EXCLUSIVE tree gate, and its shared acquisition would self-deadlock.)
 *
 * CALLER CONTRACT (Task 11): this runs whole-repo `git status` snapshot
 * diffing and `git checkout --` rollback, so it assumes NOTHING else in the
 * process is writing the working tree or the git index for its duration. The
 * CLI route guarantees that by re-entering under `withTreeLock` (EXCLUSIVE)
 * before calling with `miniTurnPolicy: 'run'` — which also excludes the
 * discard lane's `git reset`/`checkout`/`clean`, so no `withGitIndexLock`
 * acquisition is needed here. Any new caller must hold the same exclusivity.
 *
 * RESIDUAL (I1, audit-fixes wave, documented not fixed): "nothing else is
 * writing the working tree" is a policy the CLI enforces for its OWN write
 * paths, not a hard guarantee against every writer. A concurrent chat turn's
 * built-in `Write`/`Edit` (a DIFFERENT session, going through
 * `sdk-write-guard.ts`'s `PreToolUse` hook) tries to take the same per-file
 * lock this mini-turn's EXCLUSIVE tree gate is blocking; if that acquisition
 * doesn't land within the guard's `acquireBudgetMs` (10s default — well
 * under this mini-turn's up-to-90s exclusive window), the guard gives up and
 * lets the SDK execute the write anyway, JOURNAL-ONLY and unserialized (see
 * `noteJournalOnlyMode`/`acquirePathBounded` there). That write lands on disk
 * DURING this function's exclusive window, so `snapshotWorkingState`'s
 * before/after diff can't tell it apart from a side effect the mini-turn's
 * own agent produced: `cleanupAllWrites`'s whole-repo rollback can revert
 * that other turn's legitimate change, and the "the agent also modified …"
 * note can misattribute it to this mini-turn. Full fix is scoping the
 * rollback/attribution to paths `sdk-write-guard.ts` actually journaled for
 * THIS mini-turn's tool-use ids — tracked as follow-up, not implemented here.
 */
async function tryPropEditLLMFallback(args: {
  file: string
  source: string
  targetPath: string
  rootReal: string
  line: number
  column: number
  propName: string
  newValue: string
  fallback: import("../../../src/editor/edit-service/apply-prop-edit").PropEditFallbackHint
  deterministicReason: string
  /**
   * Where to send the edit when BOTH the deterministic applicator AND the
   * mini-turn refuse. `'chat'` returns `needsChat: true` so the client
   * escalates to the (visible) chat agent. `'patch'` or absent: legacy
   * behavior — the combined refusal is surfaced as a plain 422.
   */
  llmFallbackMode?: "patch" | "chat"
  applicatorLoaders: ApplicatorLoaders
  /** Design-system grounding provider, threaded from the route context. */
  getGrounding?: import("../../../src/editor/agent-chat-sdk/edit-fix-mini-turn").EditFixMiniTurnInput["getGrounding"]
  createReviewSurface?: ApplyEditOpts["createReviewSurface"]
  /**
   * P2-2 (codex review round 3, 2026-08-20). See `EditRequestBody.correlationId`.
   * The deterministic applicator's OWN ledger append (`applyEdit`'s
   * `brokeredWrite` call, above in this file) already threads this
   * through — this lane's manual `appendLedgerEntry` below used to be
   * the one place that didn't, so a request whose deterministic
   * applicator refused and whose mini-turn then succeeded produced a
   * ledger row with no `correlationId` at all. The client had already
   * created a verification record keyed on the original edit id before
   * it knew which lane would end up writing, so that row could never
   * join to its own verification pill (`verificationForLedgerRow`,
   * `activity-verification-join.ts`).
   */
  correlationId?: string
  /** See `ApplyEditOpts.llmProviderId`. */
  llmProviderId?: string
  /** See `ApplyEditOpts.chatLoaders`. */
  chatLoaders?: ChatHandlerLoaders
}): Promise<EditResult | null> {
  const escalateToChatOnRefusal = (reason: string): EditResult => ({
    ok: false,
    status: 422,
    reason,
    ...(args.llmFallbackMode === "chat" ? { needsChat: true as const } : {}),
  })

  if (!args.applicatorLoaders.loadRunEditFixMiniTurn) {
    // Loader not configured (e.g. older test stubs) — skip gracefully.
    // In `'chat'` mode this still escalates so the user isn't left with a
    // silent failure — the mini-turn is the fast path, not the gate on
    // chat handoff.
    if (args.llmFallbackMode === "chat") {
      return escalateToChatOnRefusal(args.deterministicReason)
    }
    return null
  }

  const { runEditFixMiniTurn } = await args.applicatorLoaders.loadRunEditFixMiniTurn()

  let projectKnowledge:
    | import("../../../src/editor/core/project-knowledge").ProjectKnowledge
    | undefined
  if (args.applicatorLoaders.loadProjectKnowledge) {
    const { loadCachedProjectKnowledge } = await args.applicatorLoaders.loadProjectKnowledge()
    projectKnowledge = loadCachedProjectKnowledge({ prototypeRoot: args.rootReal })
  }

  const stateBefore = await snapshotWorkingState(args.rootReal)
  if (!stateBefore) {
    // Branch mode is git-native (Commit/Publish are git operations), so a
    // failed snapshot means git itself is unhealthy — and without it the
    // mini-turn's cross-file writes could be neither verified nor rolled
    // back (codex round-13). Don't run the agent at all; escalate.
    return escalateToChatOnRefusal(
      `${args.deterministicReason} (agent fallback unavailable: could not snapshot git state to verify agent changes)`,
    )
  }

  // Optional genuine verification: a process-local headless surface the
  // agent's verify_edit can read the rendered DOM through. Best-effort —
  // absent Playwright the turn still runs with source-level guards only.
  let reviewSurface: import("../../../src/editor/core/review-surface").ReviewSurface | null = null
  if (args.createReviewSurface) {
    reviewSurface = await args.createReviewSurface().catch(() => null)
  }

  // The mini-turn now runs on the SAME provider chat does for this project,
  // instead of being refused for anything but Anthropic. `args.llmProviderId`
  // is the id the route already resolved (`resolveLlmConfig` at the CLI
  // route) — trust it when present rather than re-resolving from scratch.
  const providerId = args.llmProviderId ?? resolveLlmConfig(undefined, process.env).provider
  // `claude_code` is `resolveLlmConfig`'s synthetic id for the Claude
  // subscription lane (opted in via EDITOR_USE_CLAUDE_SUBSCRIPTION, no
  // ANTHROPIC_API_KEY set) — it has no entry in the provider-registry
  // descriptor table, because it has always meant "the Anthropic runtime,
  // reached through the subscription" rather than a distinct provider.
  // `getDescriptor` and `resolveChatRuntime` only know real descriptor ids,
  // so map it onto 'anthropic' for those two lookups. `providerId` itself
  // stays the raw id passed to the mini-turn, since that is what
  // `args.llmProviderId` already carries for other callers.
  const runtimeProviderId = providerId === "claude_code" ? "anthropic" : providerId
  const descriptor = getDescriptor(runtimeProviderId)
  // The default model of the provider that will actually run, not the SDK's.
  // `undefined` when a descriptor somehow has no default: the runtime then
  // picks, which is better than pinning a model id from another vendor.
  const model = descriptor?.staticCatalog.models.find((m) => m.isDefault)?.id
  // `chatLoaders` is absent for older callers/tests — they keep getting the
  // mini-turn's own built-in default (the Claude Agent SDK runtime), same as
  // before this change.
  //
  // `resolveChatRuntime` can throw (an unknown provider id, or a neutral
  // runtime refused by `EDITOR_NEUTRAL_CHAT=0`). Before this task that exact
  // configuration returned a clean 422 with an actionable reason; an uncaught
  // throw here would turn it into a 500 raised deep inside a save flow, which
  // is the one thing this fallback exists to avoid. Route it back through the
  // same `escalateToChatOnRefusal` every other refusal in this function uses.
  let runTurn: RunChatTurn | undefined
  if (args.chatLoaders) {
    try {
      runTurn = await resolveChatRuntime(runtimeProviderId, args.chatLoaders)
    } catch (err) {
      return escalateToChatOnRefusal(
        `${args.deterministicReason} (agent fallback unavailable: ${(err as Error).message})`,
      )
    }
  }

  let miniResult: Awaited<ReturnType<typeof runEditFixMiniTurn>>
  try {
    miniResult = await runEditFixMiniTurn(
      {
        repoRoot: args.rootReal,
        file: args.file,
        line: args.line,
        column: args.column,
        propName: args.propName,
        newValue: args.newValue,
        fallback: args.fallback,
        deterministicReason: args.deterministicReason,
        projectKnowledge,
        getGrounding: args.getGrounding,
        model,
        providerId,
        ...(reviewSurface ? { reviewSurface } : {}),
      },
      { runTurn },
    )
  } finally {
    await reviewSurface?.dispose().catch(() => {})
  }

  // Read the target's post-turn state once — both branches need it.
  let targetNow: string | null = null
  try {
    targetNow = await fs.readFile(args.targetPath, "utf8")
  } catch {
    targetNow = null
  }
  // A missing/unreadable target IS a change — the agent deleted or broke
  // it. Treating it as unchanged let the no-op/refusal paths skip
  // cleanupAllWrites and leave the target deleted while reporting that no
  // edit was applied (codex follow-up round-3).
  const targetChanged = targetNow === null || targetNow !== args.source

  // Full rollback of everything the turn wrote (codex WS4 P1 + final-round
  // P1: ANY failure exit — agent refusal, timeout, OR post-hoc validation
  // failure — must not leave partial multi-file edits on disk while the
  // HTTP result reports failure). The target restores from the pre-turn
  // source; newly-dirty tracked files were clean pre-turn so
  // `git checkout --` restores them; newly-untracked files are removed.
  // Previously-dirty files that moved (or were reverted/deleted by the
  // agent — `disappeared`) have no recoverable original — reported
  // honestly instead.
  const cleanupAllWrites = async (): Promise<string> => {
    let note = ""
    if (targetChanged) {
      try {
        await (await loadSharedFileLockManager()).withWriteLock(args.targetPath, async () => {
          await fs.writeFile(args.targetPath, args.source, "utf8")
        })
        note += ` Reverted partial changes to ${args.file}.`
      } catch {
        note += ` WARNING: ${args.file} was partially modified and could not be restored.`
      }
    }
    if (stateBefore) {
      const stateAfter = await snapshotWorkingState(args.rootReal)
      if (stateAfter) {
        const { restored, unrestorable } = await restoreMiniTurnSideEffects(
          args.rootReal,
          stateBefore,
          stateAfter,
        )
        const disappeared = diffWorkingState(stateBefore, stateAfter).disappeared
        const otherRestored = restored.filter((p) => p !== args.file)
        const otherUnrestorable = [
          ...unrestorable,
          ...disappeared.map((p) => `${p} (uncommitted changes discarded by the agent)`),
        ].filter((p) => !p.startsWith(args.file))
        if (otherRestored.length > 0) {
          note += ` Reverted partial changes to: ${otherRestored.join(", ")}.`
        }
        if (otherUnrestorable.length > 0) {
          note += ` WARNING: the agent also modified ${otherUnrestorable.join(", ")}; review or git-restore those files.`
        }
      }
    }
    return note
  }

  // Explicit refusal (or error/timeout) → roll back. 'no-verdict' falls
  // through to the diff/no-op/validation path below, which is the
  // authority: real validated changes are accepted regardless of the
  // agent's final-line formatting (codex round-12).
  if (miniResult.outcome === "refused") {
    const cleanupNote = await cleanupAllWrites()
    // Combine the two reasons so the designer sees what went wrong at
    // both levels. In `'chat'` mode, also signal `needsChat` so the client
    // hands the edit to the visible chat agent.
    return escalateToChatOnRefusal(
      `${args.deterministicReason} ${miniResult.notes}${cleanupNote}`,
    )
  }

  // The agent's EDIT_APPLIED claim is not trusted on its own — verify the
  // working tree actually changed (the handler-level no-op guard). The
  // hash-based snapshot catches edits to files that were ALREADY dirty
  // pre-turn (codex WS4 P2 — a plain path set-difference missed those and
  // falsely refused correct cross-file fixes).
  let otherChanged: string[] = []
  let otherNewlyPresent = new Set<string>()
  let otherUntracked = new Set<string>()
  if (stateBefore) {
    const stateAfter = await snapshotWorkingState(args.rootReal)
    if (stateAfter) {
      const delta = diffWorkingState(stateBefore, stateAfter)
      otherChanged = delta.changed.filter((p) => p !== args.file)
      otherNewlyPresent = new Set(delta.newlyPresent)
      otherUntracked = stateAfter.untracked
    }
  }
  if (!targetChanged && otherChanged.length === 0) {
    return escalateToChatOnRefusal(
      `${args.deterministicReason} Agent reported success but no file changed on disk.`,
    )
  }

  if (targetNow === null) {
    // The agent deleted the target while claiming success — pathological;
    // restore everything and escalate.
    const cleanupNote = await cleanupAllWrites()
    return escalateToChatOnRefusal(
      `${args.deterministicReason} Agent removed ${args.file} instead of editing it.${cleanupNote}`,
    )
  }

  // Cross-file edits are the mini-turn's MAIN case — validate them like
  // the target (codex WS4 round-3 P2): a broken .vue landing in another
  // file must not ride out on an ok:true. Restore what git can (files
  // clean pre-turn); refuse honestly when it can't.
  {
    for (const p of otherChanged) {
      if (!/\.(vue|tsx|jsx)$/.test(p)) continue
      let content: string
      try {
        content = await fs.readFile(path.join(args.rootReal, p), "utf8")
      } catch {
        continue // deleted/unreadable — nothing to validate
      }
      const parseError = await miniTurnParseError(p, content)
      if (!parseError) continue
      // ONE broken file fails the WHOLE edit — roll back everything the
      // turn wrote, not just the broken file (codex final-round P1: a
      // failure response must not leave the other files silently edited).
      const cleanupNote = await cleanupAllWrites()
      return escalateToChatOnRefusal(
        `${args.deterministicReason} Agent edit left ${p} unparseable.${cleanupNote}`,
      )
    }
  }

  if (targetChanged && /\.(vue|tsx|jsx)$/.test(args.targetPath)) {
    // Parse-validate the changed target; a broken file gets restored to
    // the pre-turn source rather than written through to HMR.
    const parseError = await miniTurnParseError(args.targetPath, targetNow as string)
    if (parseError) {
      const cleanupNote = await cleanupAllWrites()
      return escalateToChatOnRefusal(
        `${args.deterministicReason} Agent edit left ${args.file} unparseable.${cleanupNote}`,
      )
    }
  }

  // Journal pre-turn originals — the SDK's built-in Write/Edit doesn't.
  // Target: from the in-memory pre-turn source. Other changed files that
  // were CLEAN pre-turn: from git HEAD (== their pre-turn content).
  // Previously-dirty files have no recoverable original — skipped.
  //
  // `miniTurnBackupDir`/`miniTurnBackedUpAny` are hoisted above the try
  // (same reason `historyFiles` is, per its own comment below) so the
  // edit-ledger block further down can report a `backupDir` — C3
  // (round-2 whole-branch review finding, 2026-08-19): before this fix
  // the directory computed here was scoped to this try block alone, so
  // the consolidated ledger entry always omitted `backupDir` even though
  // this loop had just written real originals under it.
  //
  // `miniTurnBackedUpAny` matters because not every run of this loop
  // actually writes a file into `backupDir`: `targetChanged` may be
  // false, and an `otherChanged` path is skipped entirely when it's not
  // newly-present or is untracked (nothing recoverable to back up for
  // it — same bound `historyFiles` below documents). If neither branch
  // ever wrote a file, `fs.mkdir` never ran and the directory was never
  // created — advertising it anyway would be the same phantom-path
  // defect C1 fixed for `brokeredWrite`'s own allowCreate lane.
  let miniTurnBackupDir: string | undefined
  let miniTurnBackedUpAny = false
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    // `desdePath` throws when `.desde`, or `backups` under it, is a
    // symlink out of the worktree.
    // That throw lands in the catch below (best-effort — the landed edit
    // must never fail over a backup), so `miniTurnBackupDir` is left
    // unset and nothing is written under the hostile target.
    const backupDir = desdePath(args.rootReal, "backups", `${stamp}-mini-turn`)
    miniTurnBackupDir = backupDir
    if (targetChanged) {
      const backupPath = path.join(backupDir, args.file)
      await fs.mkdir(path.dirname(backupPath), { recursive: true })
      await fs.writeFile(backupPath, args.source, "utf8")
      miniTurnBackedUpAny = true
    }
    for (const p of otherChanged) {
      if (!otherNewlyPresent.has(p) || otherUntracked.has(p)) continue
      try {
        const { execFile } = await import("node:child_process")
        const { promisify } = await import("node:util")
        const { stdout } = await promisify(execFile)("git", ["show", `HEAD:${p}`], {
          cwd: args.rootReal,
          maxBuffer: 10 * 1024 * 1024,
        })
        const backupPath = path.join(backupDir, p)
        await fs.mkdir(path.dirname(backupPath), { recursive: true })
        await fs.writeFile(backupPath, stdout, "utf8")
        miniTurnBackedUpAny = true
      } catch {
        // Best-effort per file.
      }
    }
  } catch {
    // Backup is best-effort — never fail a landed edit over it.
  }

  // Toolbar undo/redo (Task 5 review fix). The mini-turn's OWN write guard
  // never records history for this lane (`recordHistory: false` on the
  // `runChatTurnSdk` call inside `runEditFixMiniTurn`): its writes are
  // PROVISIONAL until every gate above (no-op guard, parse validation)
  // passes, and a refused/unparseable outcome rolls them back via
  // `cleanupAllWrites` — a guard-recorded step would have captured the
  // now-reverted bytes as its "after", jamming `undo` forever (`applyTop`
  // only pops a step once the expected on-disk state matches). Now that
  // every gate has passed, record ONE consolidated step for everything the
  // turn durably changed.
  //
  // Before-states cover exactly what the backup loop above could recover,
  // for the same reason: the target from its in-memory pre-turn source, and
  // other changed files that were CLEAN pre-turn via `git show HEAD:<path>`
  // (a brand-new untracked file → `{exists:false}`). A file that was
  // ALREADY dirty pre-turn and the agent further modified has no
  // recoverable original — same documented bound as the backup loop — so it
  // is left out of this step entirely; undoing the step will not touch it.
  // Hoisted above the try below so the edit-ledger block that follows it
  // (P1-1 follow-up) can read the same list independently — a
  // `history.record` failure inside that try must not also suppress the
  // ledger append, and vice versa; they are two separate best-effort
  // affordances, not one.
  const historyFiles: import("../../../src/editor/agent-chat-sdk/write-broker").RecordedFile[] = []
  try {
    if (targetChanged) {
      historyFiles.push({
        repoRel: args.file,
        absPath: args.targetPath,
        before: { exists: true, content: Buffer.from(args.source, "utf8") },
        after: { exists: true, content: Buffer.from(targetNow as string, "utf8") },
      })
    }
    for (const p of otherChanged) {
      // `git status --porcelain` collapses a brand-new UNTRACKED directory
      // to a single `?? newdir/` entry (see `restoreMiniTurnSideEffects`'s
      // doc comment above) — `p` here can be a directory path, not a file.
      // `fs.readFile` on a directory throws EISDIR, which `edit-history.ts`'s
      // `readState` does NOT tolerate (only ENOENT degrades to
      // `{exists:false}`) — recording a directory entry would make a later
      // `undo` THROW instead of refusing, and `applyTop` never pops a step
      // it throws out of, jamming everything under it on the stack. Skip it
      // entirely; the files git rolled up under that directory aren't
      // individually recoverable here anyway (no recursive listing), so
      // there's nothing safe to record for the directory as a unit.
      if (p.endsWith("/")) continue
      if (!otherNewlyPresent.has(p)) continue // previously-dirty — no recoverable original
      const absPath = path.join(args.rootReal, p)
      let before: { exists: boolean; content: Buffer | null } | null = null
      if (otherUntracked.has(p)) {
        before = { exists: false, content: null }
      } else {
        try {
          const { execFile } = await import("node:child_process")
          const { promisify } = await import("node:util")
          const { stdout } = await promisify(execFile)("git", ["show", `HEAD:${p}`], {
            cwd: args.rootReal,
            maxBuffer: 10 * 1024 * 1024,
          })
          before = { exists: true, content: Buffer.from(stdout, "utf8") }
        } catch {
          before = null // couldn't recover HEAD content — exclude, same bound as above
        }
      }
      if (!before) continue
      let afterContent: Buffer | null
      try {
        afterContent = await fs.readFile(absPath)
      } catch {
        afterContent = null
      }
      historyFiles.push({
        repoRel: p,
        absPath,
        before,
        after:
          afterContent !== null
            ? { exists: true, content: afterContent }
            : { exists: false, content: null },
      })
    }
    if (historyFiles.length > 0) {
      await getSharedEditHistory().record({ label: `AI edit: ${args.file}`, files: historyFiles })
    }
  } catch (err) {
    // Non-fatal — undo/redo coverage is an affordance layered on top of an
    // already-durable, already-validated write, same contract
    // `brokeredWrite` uses for its own `history.record` call.
    console.warn(`[editor] mini-turn history.record failed for '${args.file}':`, err)
  }

  // The edit ledger (P1-1 follow-up, whole-branch review finding
  // 2026-08-18). The mini-turn's OWN `sdk-write-guard.ts` instance never
  // records a ledger entry per write — it runs with no `history` injected
  // (`recordHistory: false` on the `runChatTurnSdk` call inside
  // `runEditFixMiniTurn`), for the SAME reason it records no undo/redo
  // step there: its writes are PROVISIONAL until every gate above (no-op
  // guard, parse validation) passes, and `cleanupAllWrites` rolls them
  // back on refusal. Recording per-write here would durably log an edit
  // that never survived — the ledger is append-only, so that could never
  // be corrected. Instead, mirror the consolidated undo/redo step just
  // above: ONE ledger entry for everything the turn durably changed, once
  // every gate has passed. `kind: 'prop'` because this fallback only ever
  // engages for a prop-edit refusal (see this function's own `propName`/
  // `newValue` args) — the SAME kind the deterministic applicator would
  // have recorded had it not refused; `lane: 'chat'` since the agent
  // (not the deterministic applicator) produced the write.
  //
  // Its own try/catch, deliberately separate from the history one above:
  // a `history.record` failure must not also suppress the ledger entry,
  // and a ledger-append failure must not touch undo/redo coverage. Both
  // are best-effort bookkeeping over an already-durable write — neither
  // may ever fail the edit itself.
  //
  // `files`/`afterHashes` are built from `targetChanged`/`otherChanged`
  // DIRECTLY, NOT from `historyFiles` (P2-2, round-3 whole-branch review
  // finding, 2026-08-19). `historyFiles` is the UNDO-eligible subset — it
  // deliberately excludes an `otherChanged` file that was already dirty
  // BEFORE the turn, because there is no recoverable "before" snapshot to
  // push onto the undo stack for it (see its own comment above). The
  // ledger has no such requirement: it records WHAT HAPPENED, not what
  // can be rolled back, and an already-dirty file the mini-turn ALSO
  // wrote to is still a real, durable mutation. Sharing one list meant
  // two silent gaps: if the ONLY thing the turn changed was an
  // already-dirty cross-file fix, `historyFiles` stayed empty and this
  // block was skipped entirely — NO ledger entry at all for a real edit.
  // If the target ALSO changed, `historyFiles` was non-empty but still
  // missing the already-dirty file — an entry was written, but it
  // silently under-reported what changed. `ledgerFiles` below is the
  // undo-history exclusion (a directory `git status` collapsed a whole
  // untracked folder into — not a real single filename — is skipped
  // here too, same reason `historyFiles` skips it: nothing sensible to
  // hash for `p.endsWith('/')`) — nothing else.
  //
  // The target's own key is `repoRelOf(args.rootReal, args.targetPath)`,
  // NOT `args.file` (P2, round-7 whole-branch review finding,
  // 2026-08-19). `args.file` is the RAW REQUEST spelling — see
  // `repoRelOf`'s doc comment above for why an accepted non-canonical
  // path (e.g. `../<repo>/App.vue`, which still resolves inside the
  // root under a different spelling) is not safe to use as a path KEY.
  // `otherChanged` is always canonical (it comes from `diffWorkingState`,
  // a git-status-based diff), so for a non-canonical `args.file` the two
  // never string-match: the same physical file was recorded TWICE, once
  // under a spelling that isn't a valid repo-relative path at all —
  // violating the ledger's own schema (`LedgerEditEntry.files` is
  // documented as "repo-relative paths") and defeating
  // `reconcileLedger`'s exact-string dirty comparison for that entry.
  // `otherChanged` is filtered against the SAME canonical key so the
  // target is excluded regardless of which spelling flagged it.
  const targetRepoRel = repoRelOf(args.rootReal, args.targetPath)
  const ledgerFiles = [
    ...(targetChanged ? [targetRepoRel] : []),
    ...otherChanged.filter((p) => !p.endsWith("/") && p !== targetRepoRel),
  ]
  if (ledgerFiles.length > 0) {
    try {
      const afterHashes: Record<string, string> = {}
      for (const p of ledgerFiles) {
        try {
          const content = await fs.readFile(path.join(args.rootReal, p))
          afterHashes[p] = hashContent(content)
        } catch {
          // Deleted/unreadable since the change landed — no entry, same
          // convention every other lane follows: `afterHashes` never
          // claims a hash for a file that isn't there to check against.
        }
      }
      await appendLedgerEntry(args.rootReal, {
        type: "edit",
        id: randomUUID(),
        at: new Date().toISOString(),
        branch: await resolveBranchCached(args.rootReal),
        kind: "prop",
        lane: "chat",
        files: ledgerFiles,
        // C3 (round-2 whole-branch review finding, 2026-08-19): the backup
        // block above (`miniTurnBackupDir`) really did write originals for
        // this turn — carry the directory through, repo-relative like
        // every other lane's `backupDir`, but only when at least one file
        // actually landed there (`miniTurnBackedUpAny`); an empty
        // directory that `fs.mkdir` never created must not be advertised
        // as a recovery location, same rule C1 applies to `brokeredWrite`.
        // Deliberately still keyed to the undo-recoverable subset, NOT
        // widened to `ledgerFiles` — `backupDir` promises "you can
        // restore what's in here," and an already-dirty file was never
        // written into it (see the loop above); the ledger's `files`
        // list is allowed to name more than `backupDir` can restore.
        ...(miniTurnBackedUpAny && miniTurnBackupDir !== undefined
          ? { backupDir: repoRelOf(args.rootReal, miniTurnBackupDir) }
          : {}),
        // P2-1 (codex review round 6, 2026-08-20): `historyFiles` above
        // already recorded, per file, whether it existed before this
        // turn (`before.exists`) — a brand-new untracked file gets
        // `{exists: false}` there (see that block's own comment). Reused
        // here rather than re-derived: a `ledgerFiles` entry with a
        // matching `historyFiles` row whose `before.exists` is false was
        // genuinely created by this turn, so Plan B's Undo can prove
        // "delete it" is safe instead of refusing as `unbacked`. Target
        // is never in this set — `historyFiles`' target row always
        // records `before.exists: true` (this lane only runs against an
        // element the deterministic applicator already found, i.e. an
        // existing file).
        ...(() => {
          const createdFiles = ledgerFiles.filter((p) =>
            historyFiles.some((f) => f.repoRel === p && !f.before.exists),
          )
          return createdFiles.length > 0 ? { createdFiles } : {}
        })(),
        afterHashes,
        fields: { propName: args.propName, value: args.newValue },
        // P2-2 (codex review round 3, 2026-08-20) — see this function's
        // `correlationId` param doc comment. Without this, a prop edit
        // that fell back to the mini-turn produced a ledger row with no
        // join key back to the client's verification record.
        correlationId: args.correlationId,
      })
    } catch (err) {
      console.warn(`[editor] mini-turn edit-ledger append failed for '${args.file}':`, err)
    }
  }

  // Machine-readable change set (codex WS4 round-4 P2): http-server derives
  // Vite invalidation from newHashes keys and the client folds them into
  // its per-file hash registry — cross-file fixes must invalidate the file
  // that ACTUALLY changed, not just args.file.
  const newHashes: Record<string, string> = {}
  const changedFiles = [...(targetChanged ? [args.file] : []), ...otherChanged]
  for (const p of changedFiles) {
    try {
      newHashes[p] = sha256Hex(await fs.readFile(path.join(args.rootReal, p), "utf8"))
    } catch {
      // Deleted/unreadable — skip; invalidation falls back to args.file.
    }
  }

  const changedNote =
    otherChanged.length > 0 ? ` (changed files: ${otherChanged.join(", ")})` : ""
  const verdictNote =
    miniResult.outcome === "no-verdict"
      ? " (agent gave no explicit verdict; changes were validated by the handler)"
      : ""
  return {
    ok: true,
    status: 200,
    file: args.file,
    ...(Object.keys(newHashes).length > 0 ? { newHashes } : {}),
    fallbackUsed: "agent-mini-turn",
    notes: `${miniResult.notes}${changedNote}${verdictNote}`,
  }
}

/**
 * Strict parse check for a mini-turn-written file. Vue via
 * @vue/compiler-sfc; .tsx/.jsx via strict Babel (errorRecovery off, same
 * plugin convention as the JSX source-tag plugin: .tsx gets typescript,
 * .jsx must not). Returns a short error string, or null when parseable.
 */
async function miniTurnParseError(filePath: string, content: string): Promise<string | null> {
  try {
    if (filePath.endsWith(".vue")) {
      const { parse: parseSfc } = await import("@vue/compiler-sfc")
      const { errors, descriptor } = parseSfc(content, { filename: filePath })
      if (errors.length > 0) return String(errors[0])
      // Parse alone misses codegen-only failures (empty v-bind expression,
      // orphaned v-else, …) — run the full template compile, same backstop
      // the deterministic applicators use (codex round-9 P2).
      if (descriptor.template) {
        const { compile } = await import("@vue/compiler-dom")
        compile(descriptor.template.content)
      }
      return null
    }
    if (filePath.endsWith(".tsx") || filePath.endsWith(".jsx")) {
      const { parse } = await import("@babel/parser")
      parse(content, {
        sourceType: "module",
        plugins: filePath.endsWith(".tsx") ? ["jsx", "typescript"] : ["jsx"],
      })
      return null
    }
    return null
  } catch (err) {
    return (err as Error).message
  }
}

/**
 * Handle an `llm-patch` bundle. Mirrors the Next route's `handleLLMPatch`
 * with CLI-specific I/O (no NextResponse). Uses the shared
 * `cliCachedStyleContext` / `cliCachedStyleContextKey` module-level cache
 * declared above.
 */
async function handleLLMPatch(
  mutations: import("../../../src/editor/edit-service/validate-edit-request").LLMPatchMutationBody[],
  repoRoot: string,
  applicatorLoaders: ApplicatorLoaders,
  baseHashes?: Record<string, string>,
  conventions?: ProjectKnowledgeConfig,
  onTextDelta?: (delta: string) => void,
  /**
   * Fallback routing when the deterministic lane can't apply the bundle.
   * `'chat'` short-circuits with `needsChat`; absent/`'patch'` runs the
   * LLM patch lane.
   */
  llmFallback?: "patch" | "chat",
  /**
   * Design-system grounding provider (same object the mini-turn fallback
   * and the chat route get) — used ONLY to resolve
   * `grounding.tokens.listTokens()` for the style-context block. Absent in
   * older callers/tests; tokens then default to `[]` (the style block
   * falls back to the raw tailwind/token-file scan). Tokens must NEVER
   * block or fail an edit — every call site is wrapped in try/catch.
   */
  getGrounding?: ApplyEditOpts["getGrounding"],
  /** See `EditRequestBody.correlationId`. */
  correlationId?: string,
  /** See `ApplyEditOpts.getLlmProvider`. */
  getLlmProvider?: ApplyEditOpts["getLlmProvider"],
): Promise<EditResult> {
  if (!applicatorLoaders.loadApplyLLMPatch || !applicatorLoaders.loadStyleGrounding) {
    return {
      ok: false,
      status: 503,
      reason: "llm-patch applicator loaders not configured",
    }
  }

  let rootReal: string
  try {
    rootReal = await fs.realpath(path.resolve(repoRoot))
  } catch (err) {
    return {
      ok: false,
      status: 503,
      reason: `Prototype root unreadable: ${(err as Error).message}`,
    }
  }
  const rootWithSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep

  // Collect distinct files. For 'callsite + this-instance' (cross-file
  // edit), the patch lands in `callsiteLoc`'s file, not `sourceLoc`'s.
  const fileSet = new Set<string>()
  for (const m of mutations) {
    if (!m.sourceLoc) {
      return {
        ok: false,
        status: 400,
        reason: `Mutation ${m.id} has no sourceLoc; llm-patch refuses.`,
      }
    }
    const isCrossFile =
      m.scope === "callsite" &&
      m.disambiguationChoice === "this-instance" &&
      m.callsiteLoc !== null
    const targetLoc = isCrossFile ? m.callsiteLoc! : m.sourceLoc
    const fileFromLoc = parseSourceLocFile(targetLoc)
    if (!fileFromLoc) {
      return {
        ok: false,
        status: 400,
        reason: `Mutation ${m.id} has malformed ${isCrossFile ? "callsiteLoc" : "sourceLoc"}='${targetLoc}'.`,
      }
    }
    fileSet.add(fileFromLoc)
    // The consumer-callsite fallback rung (see the deterministic block below)
    // may splice into `callsiteLoc`'s file instead. Read it here so it goes
    // through the SAME path-traversal check, the same external-edit conflict
    // guard, the same `data-desde-v` stale-target guard and the same backup
    // journal as any other target. Reading it opportunistically costs one file
    // read; reading it later, off the happy path, would route a real write
    // around four guards.
    if (m.kind === "text" && m.callsiteLoc) {
      const callsiteFile = parseSourceLocFile(m.callsiteLoc)
      if (callsiteFile) fileSet.add(callsiteFile)
    }
  }

  const filesMap = new Map<string, string>()
  const targetPaths = new Map<string, string>()
  const currentHashes = new Map<string, string>()
  for (const file of fileSet) {
    const resolved = await resolveAndReadEditableFile(file, rootReal, rootWithSep)
    if (!resolved.ok) {
      return {
        ok: false,
        status: resolved.status,
        reason: `File '${file}': ${resolved.reason}`,
      }
    }
    filesMap.set(file, resolved.contents)
    targetPaths.set(file, resolved.targetPath)
    currentHashes.set(file, sha256Hex(resolved.contents))
  }

  // External-edit conflict guard. Same semantics as the Next route.
  if (baseHashes) {
    const conflicts: Array<{ file: string; expected: string; actual: string }> = []
    for (const [file, expected] of Object.entries(baseHashes)) {
      const actual = currentHashes.get(file)
      if (actual === undefined) continue
      if (expected !== actual) {
        conflicts.push({ file, expected, actual })
      }
    }
    if (conflicts.length > 0) {
      return {
        ok: false,
        status: 409,
        reason: "external-edit-conflict",
        conflicts,
      }
    }
  }

  // Stale-target guard (WS1, tasks/edit-pipeline-rearchitecture.md): each
  // mutation may carry per-file `data-desde-v` hashes captured WITH its
  // coordinates — `sourceVersion` pairs with `sourceLoc`'s file and
  // `callsiteVersion` with `callsiteLoc`'s file (the one a cross-file
  // mutation actually splices — codex WS1 P2). Unlike `baseHashes` (fed by
  // prior save responses), these pair the coordinates with the exact file
  // version the DOM was rendered from — a mismatch means the coordinates
  // provably predate the file's current bytes. Refuse the batch loud
  // rather than splice at drifted positions. A version whose file wasn't
  // read for this batch has nothing to compare against — skip it.
  {
    const stale: Array<{ file: string; expected: string; actual: string }> = []
    const check = (loc: string | null | undefined, version: string | null | undefined) => {
      if (!version || !loc) return
      const versionFile = parseSourceLocFile(loc)
      if (!versionFile) return
      const actual = currentHashes.get(versionFile)
      if (actual === undefined) return
      if (!actual.startsWith(version.toLowerCase())) {
        stale.push({ file: versionFile, expected: version, actual })
      }
    }
    for (const m of mutations) {
      check(m.sourceLoc, m.sourceVersion)
      check(m.callsiteLoc, m.callsiteVersion)
    }
    if (stale.length > 0) {
      return {
        ok: false,
        status: 409,
        reason:
          "Stale target: the prototype re-rendered from newer source than these edits were captured against. Re-apply the edit against the current view.",
        conflicts: stale,
      }
    }
  }

  // Deterministic fast-path: if EVERY mutation can be applied by
  // `applySlotTextEdit` (text) or `applyPropEdit` (attr), write the
  // patched files directly and skip the 5–95s LLM call. All-or-
  // nothing: any miss falls through to the LLM path so source state
  // stays consistent across writers.
  const deterministicPatched = new Map<string, string>()
  let allDeterministic = mutations.length > 0
  if (allDeterministic && applicatorLoaders.loadApplySlotTextEdit) {
    const { applySlotTextEdit } = await applicatorLoaders.loadApplySlotTextEdit()
    const { applyPropEdit } = await applicatorLoaders.loadApplyPropEdit()
    // React/JSX applicators for .tsx/.jsx files in this batch (optional loaders;
    // when absent the JSX branch below bails to the LLM lane).
    const applyJsxSlotTextEdit = applicatorLoaders.loadApplyJsxSlotTextEdit
      ? (await applicatorLoaders.loadApplyJsxSlotTextEdit()).applyJsxSlotTextEdit
      : null
    const applyJsxPropEdit = applicatorLoaders.loadApplyJsxPropEdit
      ? (await applicatorLoaders.loadApplyJsxPropEdit()).applyJsxPropEdit
      : null
    // Text→attr fallback: rewrites a refusing `kind: "text"` mutation
    // into an applyPropEdit when exactly one static attribute at
    // sourceLoc carries the captured `before`. The loaders are optional
    // to preserve backward compat with any ApplicatorLoaders consumer
    // that hasn't been updated yet. Vue + React (JSX) siblings.
    const inferAttrModule = applicatorLoaders.loadInferAttrFromTextEdit
      ? await applicatorLoaders.loadInferAttrFromTextEdit()
      : null
    const inferAttrJsxModule = applicatorLoaders.loadInferAttrFromJsxTextEdit
      ? await applicatorLoaders.loadInferAttrFromJsxTextEdit()
      : null
    // Working copies keyed by file, seeded lazily from `filesMap`. This used to
    // be one `source` string per file inside a group-by-file loop, which was
    // enough while every mutation spliced into the file its own coordinate
    // named. The consumer-callsite fallback below breaks that assumption — it
    // can splice a mutation into a DIFFERENT file — and two mutations falling
    // back into the same file would each start from the pristine text and
    // silently clobber one another. One shared store removes the possibility.
    const working = new Map<string, string>()
    const sourceFor = (file: string): string | null => {
      const cur = working.get(file)
      if (typeof cur === "string") return cur
      const initial = filesMap.get(file)
      return typeof initial === "string" ? initial : null
    }

    /**
     * One attempt of the full deterministic text ladder at one coordinate:
     * slot text first, then the prop-rendered-text recovery (`<Button
     * label="…">` has no slot-text child, so infer the static attribute
     * carrying `before` and re-route to the prop applicator).
     *
     * Pure with respect to `working` — returns the patched source or null so
     * the caller decides whether a rung is allowed to commit.
     */
    const tryTextAt = (
      file: string,
      loc: { line: number; column: number },
      m: import("../../../src/editor/edit-service/validate-edit-request").LLMPatchMutationBody,
    ): string | null => {
      const source = sourceFor(file)
      if (source === null) return null
      const isJsx = file.endsWith(".tsx") || file.endsWith(".jsx")
      if (isJsx && (!applyJsxSlotTextEdit || !applyJsxPropEdit)) return null
      const slot = isJsx
        ? applyJsxSlotTextEdit!({ source, line: loc.line, column: loc.column, before: m.before, after: m.after })
        : applySlotTextEdit({ source, line: loc.line, column: loc.column, before: m.before, after: m.after })
      if (slot.ok) return slot.source
      const inferModule = isJsx ? inferAttrJsxModule : inferAttrModule
      if (!inferModule) return null
      const inferred = isJsx
        ? inferAttrJsxModule!.inferAttrFromJsxTextEdit({ source, line: loc.line, column: loc.column, before: m.before })
        : inferAttrModule!.inferAttrFromTextEdit({ source, line: loc.line, column: loc.column, before: m.before })
      if (!inferred.ok) return null
      const propResult = isJsx
        ? applyJsxPropEdit!({ source, line: loc.line, column: loc.column, propName: inferred.propName, value: m.after })
        : applyPropEdit({ source, line: loc.line, column: loc.column, propName: inferred.propName, value: m.after })
      return propResult.ok ? propResult.source : null
    }

    for (const m of mutations) {
      if (m.kind !== "text" && m.kind !== "attr") {
        allDeterministic = false
        break
      }
      const isCrossFile =
        m.scope === "callsite" &&
        m.disambiguationChoice === "this-instance" &&
        m.callsiteLoc !== null
      const targetLoc = isCrossFile ? m.callsiteLoc! : m.sourceLoc!
      const file = parseSourceLocFile(targetLoc)
      const loc = parseSourceLocFull(targetLoc)
      if (!file || !loc) {
        allDeterministic = false
        break
      }
      // React/JSX files use the Babel applicators; a .vue file uses the Vue
      // ones. If the JSX applicators aren't wired (partial test mocks), bail
      // this batch to the LLM lane rather than mis-applying.
      const fileIsJsx = file.endsWith(".tsx") || file.endsWith(".jsx")
      if (fileIsJsx && (!applyJsxSlotTextEdit || !applyJsxPropEdit)) {
        allDeterministic = false
        break
      }
      if (sourceFor(file) === null) {
        allDeterministic = false
        break
      }

      if (m.kind === "text") {
        const direct = tryTextAt(file, loc, m)
        if (direct !== null) {
          working.set(file, direct)
          continue
        }
        // ── Consumer-callsite fallback ──────────────────────────────────
        //
        // The anchor named a real element, and that element's own JSX/template
        // node holds no editable text. On React that is the COMMON case rather
        // than an edge: a first-party wrapper (`components/ui/button.tsx`)
        // stamps its own `<Comp {...props} />`, and the stamper deliberately
        // writes its attribute last so the stamp survives the spread — see
        // `jsx-source-tag-plugin.ts`. So the anchor answers "which element drew
        // this", which is what the scoped-CSS lane needs, while the text lane
        // wants "where are these bytes". On Vue the two coincide, because
        // attribute fallthrough puts the PARENT's stamp on a component root.
        //
        // MEASURED 2026-08-16 (`tasks/react-hint-generation-phase0.md` § 7.8.1)
        // on a canonical shadcn app: 4 of 61 text edits landed without this
        // rung, 19 of 61 with it, and all 15 recovered ones landed via the
        // plain slot applicator at the user's own callsite.
        //
        // It is a FALLBACK and must stay one. `sourceLoc` remains correct for
        // plain authored elements and for every library that never stamps its
        // own internals (MEASURED: all 12 MUI surfaces), and a replacement
        // would break those. Safety rests on the applicators re-checking the
        // captured `before` at the new position, so a wrong callsite refuses
        // rather than editing the wrong bytes — which is also why the empty-
        // `before` guard is here: an empty needle matches too easily.
        if (m.callsiteLoc && m.before.trim().length > 0) {
          const cFile = parseSourceLocFile(m.callsiteLoc)
          const cLoc = parseSourceLocFull(m.callsiteLoc)
          if (cFile && cLoc && cFile !== file && sourceFor(cFile) !== null) {
            const viaCallsite = tryTextAt(cFile, cLoc, m)
            if (viaCallsite !== null) {
              working.set(cFile, viaCallsite)
              continue
            }
          }
        }
        allDeterministic = false
        break
      }

      // kind === "attr"
      if (!m.target) {
        allDeterministic = false
        break
      }
      const source = sourceFor(file)!
      const result = fileIsJsx
        ? applyJsxPropEdit!({ source, line: loc.line, column: loc.column, propName: m.target, value: m.after })
        : applyPropEdit({ source, line: loc.line, column: loc.column, propName: m.target, value: m.after })
      if (!result.ok) {
        allDeterministic = false
        break
      }
      working.set(file, result.source)
    }
    if (allDeterministic) {
      for (const [file, patched] of working) {
        if (patched !== filesMap.get(file)) deterministicPatched.set(file, patched)
      }
    }
  } else {
    allDeterministic = false
  }
  if (allDeterministic && deterministicPatched.size > 0) {
    // No-op guard. Deterministic applicators refuse no-ops upstream,
    // so this branch should never fire in practice; defense-in-depth
    // keeps a future applicator widening from silently green-lighting
    // empty patches.
    const noopReason = noopReasonFor(deterministicPatched, filesMap)
    if (noopReason) return { ok: false, status: 422, reason: noopReason }

    // Parse-validate every patched source before writing any of them —
    // mirrors the LLM-path validator below for all-or-nothing FS safety.
    // JSX (.tsx/.jsx) is skipped: @vue/compiler-sfc would wrongly reject valid
    // JSX as a malformed SFC. Vite surfaces real JSX syntax errors via the HMR
    // overlay (same as the .ts overwrite lane, which also writes-as-is).
    const { parse: parseSfc } = await import("@vue/compiler-sfc")
    for (const [file, newSource] of deterministicPatched) {
      if (file.endsWith(".tsx") || file.endsWith(".jsx")) continue
      try {
        const { errors } = parseSfc(newSource)
        if (errors.length > 0) {
          return {
            ok: false,
            status: 422,
            reason: `Patched source for '${file}' failed SFC parse: ${errors.map((e) => e.message).join("; ")}`,
          }
        }
      } catch (err) {
        return {
          ok: false,
          status: 422,
          reason: `Patched source for '${file}' threw on SFC parse: ${(err as Error).message}`,
        }
      }
    }
    const newHashes: Record<string, string> = {}
    for (const [file, hash] of currentHashes) {
      newHashes[file] = hash
    }
    const written = await writePatchedFilesThroughBroker({
      rootReal,
      filesMap,
      patchedFiles: deterministicPatched,
      targetPaths,
      // Deterministic fast-path — no LLM call happened, so the undo/redo
      // label must say so (distinct from the genuine LLM lane below).
      label: `edit: ${[...deterministicPatched.keys()].join(", ")}`,
      mutationCount: mutations.length,
      correlationId,
    })
    if (!written.ok) return written.error
    for (const [file, newSource] of deterministicPatched) {
      newHashes[file] = sha256Hex(newSource)
    }
    return {
      ok: true,
      status: 200,
      newHashes,
      backupDir: written.backupDir,
    }
  }

  // Escalate-to-chat boundary. When the client opted into `'chat'`
  // fallback mode and the deterministic lane couldn't apply the bundle,
  // stop here instead of running the LLM patch lane. The client hands
  // the edit to the chat agent. Additive: absent/`'patch'` keeps the
  // legacy LLM-patch behavior below.
  if (llmFallback === "chat") {
    return {
      ok: false,
      status: 422,
      needsChat: true,
      reason: "This edit needs interpretation, so it is going to the chat agent.",
    }
  }

  // Tokens are fetched BEFORE the style-context memo check (not just on a
  // memo miss) so their fingerprint can key the memo below — the fetch
  // itself is memoized upstream by the source layers (`DeferredDesignTokenSource`
  // keeps the discovery walk process-lifetime-cached; `CssCustomPropertiesTokenSource`
  // now self-invalidates per-call off a cheap statSync fingerprint), so
  // re-fetching every call is cheap. Tokens must NEVER block or fail an edit
  // — the grounding seam's listTokens() does a filesystem/stylesheet scan
  // that could throw on an exotic substrate; degrade to `[]` (the loader's
  // raw-fallback escape hatch) rather than let that abort the save.
  let tokens: import("../../../src/editor/core/design-tokens").DesignToken[] = []
  if (getGrounding) {
    try {
      tokens = [...(await (await getGrounding()).tokens.listTokens())]
    } catch {
      tokens = []
    }
  }
  const styleContextKey = `${rootReal}::${computeTokensFingerprint(tokens)}`

  // Cached projectStyleContext.
  let projectStyleContext: import("../../../src/editor/edit-service/llm-patch-prompt").ProjectStyleContext
  if (cliCachedStyleContextKey === styleContextKey && cliCachedStyleContext) {
    projectStyleContext = cliCachedStyleContext
  } else {
    const { loadStyleGrounding } = await applicatorLoaders.loadStyleGrounding()
    projectStyleContext = loadStyleGrounding({ prototypeRoot: rootReal, tokens })
    cliCachedStyleContextKey = styleContextKey
    cliCachedStyleContext = projectStyleContext
  }

  // Project-knowledge digest — the prototype repo's documented conventions.
  // Skipped entirely when the project config turns conventions off; when on,
  // `excludeFiles` drops specific files from discovery. Optional loader: when
  // unconfigured (older callers, tests) the patch service runs ungrounded.
  let projectKnowledge:
    | import("../../../src/editor/core/project-knowledge").ProjectKnowledge
    | undefined
  if (
    applicatorLoaders.loadProjectKnowledge &&
    conventions?.useRepoConventions !== false
  ) {
    const { loadCachedProjectKnowledge } = await applicatorLoaders.loadProjectKnowledge()
    projectKnowledge = loadCachedProjectKnowledge({
      prototypeRoot: rootReal,
      excludeFiles: conventions?.excludeFiles,
    })
  }

  const { applyLLMPatch } = await applicatorLoaders.loadApplyLLMPatch()
  const result = await applyLLMPatch({
    files: filesMap,
    mutations: mutations as unknown as Parameters<typeof applyLLMPatch>[0]["mutations"],
    projectStyleContext,
    projectKnowledge,
    // Wired only when the HTTP server detected `Accept: text/event-stream`
    // and opened an SSE response. apply-llm-patch dispatches through
    // `streamComplete` when this is set so the SDK's partial-message
    // stream surfaces token-by-token in the save dialog instead of
    // blanking for 5–95s.
    ...(onTextDelta ? { onTextDelta } : {}),
    ...(getLlmProvider ? { resolveProvider: getLlmProvider } : {}),
  })

  if (!result.ok) {
    return { ok: false, status: 422, reason: result.reason }
  }

  // No-op guard. The LLM lane can return a `patchedFiles` map whose
  // entries match the originals byte-for-byte (model refuses
  // internally, captured `before` matches no literal in source, model
  // rewrites then "reverts"). Without this, the shell toasts "Saved 1
  // DOM mutation(s)" while nothing changed on disk and the iframe
  // doesn't re-render — the bug the user reported on the KEmptyState
  // case.
  {
    const noopReason = noopReasonFor(result.patchedFiles, filesMap)
    if (noopReason) return { ok: false, status: 422, reason: noopReason }
  }

  // This CLI handler is the single dispatcher for all editor edits (the
  // web `src/app/api/editor/edit/route.ts` this used to mirror was
  // deleted 2026-06-04 with the rest of the web editor surface — see
  // tasks/web-editor-removal.md). Parse every patched source with
  // @vue/compiler-sfc before writing ANY of them. Pre-write
  // parse-validation keeps the all-or-nothing semantics at the
  // filesystem boundary.
  const { parse: parseSfc } = await import("@vue/compiler-sfc")
  for (const [file, newSource] of result.patchedFiles) {
    try {
      const { errors } = parseSfc(newSource)
      if (errors.length > 0) {
        return {
          ok: false,
          status: 422,
          reason: `Patched source for '${file}' failed SFC parse: ${errors.map((e) => e.message).join("; ")}`,
        }
      }
    } catch (err) {
      return {
        ok: false,
        status: 422,
        reason: `Patched source for '${file}' threw on SFC parse: ${(err as Error).message}`,
      }
    }
  }

  const newHashes: Record<string, string> = {}
  for (const [file, hash] of currentHashes) {
    newHashes[file] = hash
  }
  // Same broker as the deterministic lane above, so a concurrent
  // deterministic edit on the same file serializes against the LLM write
  // and both lanes get the identical timestamp+uuid backup directory.
  const written = await writePatchedFilesThroughBroker({
    rootReal,
    filesMap,
    patchedFiles: result.patchedFiles,
    targetPaths,
    label: `AI edit: ${[...result.patchedFiles.keys()].join(", ")}`,
    mutationCount: mutations.length,
    correlationId,
  })
  if (!written.ok) return written.error
  for (const [file, newSource] of result.patchedFiles) {
    newHashes[file] = sha256Hex(newSource)
  }

  return {
    ok: true,
    status: 200,
    newHashes,
    // Surface as repo-relative — the shell parses it as such.
    backupDir: written.backupDir,
  }
}

/**
 * The shared write step for BOTH `handleLLMPatch` lanes (deterministic
 * fast-path + LLM result). Journals every file the batch read — not just
 * the patched subset, so an undo restores the whole batch's starting state
 * — then writes the patched files through `brokeredWrite`: per-file
 * `FileLockManager` write locks in sorted absolute-path order, and rollback
 * of the already-written files if a later write fails (before the broker,
 * a mid-batch failure left the earlier files patched on disk).
 *
 * Error strings are byte-identical to the two hand-rolled copies this
 * replaced; the one deliberate behavior change is that the LLM lane's
 * backup directory now carries the uuid suffix the deterministic lane
 * always had (two patches in the same millisecond could otherwise clobber
 * each other's originals).
 */
async function writePatchedFilesThroughBroker(args: {
  rootReal: string
  filesMap: Map<string, string>
  patchedFiles: Map<string, string>
  targetPaths: Map<string, string>
  /**
   * Undo/redo history label. This function serves BOTH the deterministic
   * llm-patch fast-path (no LLM call — attr mutations routed straight
   * through an applicator) and the genuine LLM-result lane, so the label
   * is caller-supplied rather than hardcoded — "AI edit: …" would
   * misattribute the fast-path's steps to the model.
   */
  label: string
  /**
   * The ledger's `mutationCount` field — the number of DOM mutations the
   * request bundled, i.e. `mutations.length` from the caller's request
   * body. NOT derivable from `patchedFiles`/`ops` here: those are keyed
   * one entry per FILE, so a bundle of several mutations landing in one
   * file would otherwise report a count of 1 (caught in whole-branch
   * review — see the "Important" finding on the llm-patch ledger entry).
   */
  mutationCount: number
  /** See `EditRequestBody.correlationId`. */
  correlationId?: string
}): Promise<
  { ok: true; backupDir?: string } | { ok: false; error: EditResult }
> {
  // Journal + op keys use `repoRelOf` (derived from each file's already-
  // resolved absolute target path), NEVER the raw sourceLoc-derived
  // `file` string directly — see `repoRelOf`'s doc comment for why a
  // `..`-laden key that still resolves inside the root can otherwise
  // escape `backupDir` when joined against it (audit Task 14 fix). The
  // caller's response fields (`newHashes`/`conflicts`, keyed by the same
  // raw `file` strings the client sent) are intentionally untouched —
  // this is a journal-key-only normalization.
  const journal: Array<{ file: string; content: string }> = []
  for (const [file, content] of args.filesMap) {
    const target = args.targetPaths.get(file)
    if (!target) {
      return {
        ok: false,
        error: {
          ok: false,
          status: 500,
          reason: `Internal: journaled file '${file}' has no resolved target path.`,
        },
      }
    }
    journal.push({ file: repoRelOf(args.rootReal, target), content })
  }

  const ops: import("../../../src/editor/agent-chat-sdk/write-broker").BrokerOp[] = []
  for (const [file, newSource] of args.patchedFiles) {
    const target = args.targetPaths.get(file)
    if (!target) {
      return {
        ok: false,
        error: {
          ok: false,
          status: 500,
          reason: `Internal: patched file '${file}' has no resolved target path.`,
        },
      }
    }
    ops.push({
      kind: "write",
      repoRel: repoRelOf(args.rootReal, target),
      absPath: target,
      content: newSource,
    })
  }
  const { brokeredWrite, rollbackWarning } = await loadBrokeredWrite()
  const broker = await brokeredWrite({
    canonicalRoot: args.rootReal,
    journal,
    ops,
    record: { history: getSharedEditHistory(), label: args.label },
    describe: {
      kind: "llm-patch",
      lane: "direct",
      fields: { mutationCount: args.mutationCount },
      correlationId: args.correlationId,
    },
  })
  if (!broker.ok) {
    // Policy refusal, not a server fault — see the sibling handlers above.
    if (broker.stage === "refused") {
      return { ok: false, error: { ok: false, status: 403, reason: broker.reason } }
    }
    return {
      ok: false,
      error: {
        ok: false,
        status: 500,
        reason:
          broker.stage === "backup"
            ? `${broker.reason}. Patch aborted; no source files modified.`
            : // `rollbackWarning` is empty unless a rollback ALSO failed —
              // in which case a file still holds the patched content while
              // this call reports failure, and the user needs to know
              // which one (their next save on it would 409 as an
              // external-edit-conflict with no visible cause).
              `Could not write file '${broker.repoRel}': ${broker.reason}${rollbackWarning(broker)}`,
      },
    }
  }
  return { ok: true, backupDir: broker.backupDir }
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex")
}

/**
 * Returns null when at least one patched file's contents differ from
 * its original; otherwise returns a human-readable reason string
 * suitable for surfacing in the save dialog. Used by both the
 * deterministic fast-path and the LLM lane in `handleLLMPatch` to
 * prevent "Saved 1 DOM mutation(s)" from firing when the patch was a
 * full no-op.
 */
function noopReasonFor(
  patchedFiles: Map<string, string>,
  filesMap: Map<string, string>,
): string | null {
  for (const [file, newSource] of patchedFiles) {
    if (filesMap.get(file) !== newSource) return null
  }
  return "Patch produced no source changes. The edit may not map to a literal in source: for example, text rendered by a library component prop with no static-attr match, or a bound binding the deterministic path can't safely rewrite. Try editing the named prop directly via the inspector panel."
}

function parseSourceLocFull(
  sourceLoc: string,
): { file: string; line: number; column: number } | null {
  const lastColon = sourceLoc.lastIndexOf(":")
  if (lastColon < 0) return null
  const secondLast = sourceLoc.lastIndexOf(":", lastColon - 1)
  if (secondLast < 0) return null
  const file = sourceLoc.slice(0, secondLast)
  const line = Number(sourceLoc.slice(secondLast + 1, lastColon))
  const column = Number(sourceLoc.slice(lastColon + 1))
  if (!file || !Number.isFinite(line) || !Number.isFinite(column)) return null
  return { file, line, column }
}

function parseSourceLocFile(sourceLoc: string): string | null {
  const lastColon = sourceLoc.lastIndexOf(":")
  if (lastColon < 0) return null
  const secondLast = sourceLoc.lastIndexOf(":", lastColon - 1)
  if (secondLast < 0) return null
  return sourceLoc.slice(0, secondLast) || null
}

/**
 * Default applicator loaders that pull from the parent monorepo's
 * `src/editor/edit-service/`. This works because the CLI ships
 * inside the same repo for D-0; when the CLI graduates to its own
 * package in V1.4+, edit-service will be vendored in or extracted to
 * a shared package.
 */
export const defaultApplicatorLoaders: ApplicatorLoaders = {
  loadApplyPropEdit: () => import("../../../src/editor/edit-service/apply-prop-edit"),
  loadApplyJsxPropEdit: () => import("../../../src/editor/edit-service/apply-jsx-prop-edit"),
  loadApplyVueScriptJsx: () =>
    import("../../../src/editor/edit-service/apply-vue-script-jsx-edit"),
  loadApplyMoveEdit: () => import("../../../src/editor/edit-service/apply-move-edit"),
  loadApplyJsxMoveEdit: () => import("../../../src/editor/edit-service/apply-jsx-move-edit"),
  loadApplyDetachEdit: () => import("../../../src/editor/edit-service/apply-detach-edit"),
  loadApplyDeleteEdit: () => import("../../../src/editor/edit-service/apply-delete-edit"),
  loadApplyJsxDeleteEdit: () => import("../../../src/editor/edit-service/apply-jsx-delete-edit"),
  loadApplyInsertEdit: () => import("../../../src/editor/edit-service/apply-insert-edit"),
  loadApplyJsxInsertEdit: () => import("../../../src/editor/edit-service/apply-jsx-insert-edit"),
  loadApplyScopedCssOverrideEdit: () =>
    import("../../../src/editor/edit-service/apply-scoped-css-override-edit"),
  loadApplyJsxStyleEdit: () =>
    import("../../../src/editor/edit-service/apply-jsx-style-edit"),
  loadApplySwapEdit: () =>
    import("../../../src/editor/edit-service/apply-swap-edit"),
  loadApplyUnwrapEdit: () =>
    import("../../../src/editor/edit-service/apply-unwrap-edit"),
  loadApplyJsxUnwrapEdit: () =>
    import("../../../src/editor/edit-service/apply-jsx-unwrap-edit"),
  loadApplyFlattenConditionalEdit: () =>
    import("../../../src/editor/edit-service/apply-flatten-conditional-edit"),
  loadApplyJsxFlattenConditionalEdit: () =>
    import("../../../src/editor/edit-service/apply-jsx-flatten-conditional-edit"),
  loadApplyTextBranchEdit: () =>
    import("../../../src/editor/edit-service/apply-text-branch-edit"),
  loadApplyJsxTextBranchEdit: () =>
    import("../../../src/editor/edit-service/apply-jsx-text-branch-edit"),
  loadApplyTokenEdit: () =>
    import("../../../src/editor/edit-service/apply-token-edit"),
  loadApplySlotTextEdit: () =>
    import("../../../src/editor/edit-service/apply-slot-text-edit"),
  loadApplyJsxSlotTextEdit: () =>
    import("../../../src/editor/edit-service/apply-jsx-slot-text-edit"),
  loadInferAttrFromTextEdit: () =>
    import("../../../src/editor/edit-service/infer-attr-from-text-edit"),
  loadInferAttrFromJsxTextEdit: () =>
    import("../../../src/editor/edit-service/infer-attr-from-jsx-text-edit"),
  loadApplyLLMPatch: () => import("../../../src/editor/edit-service/apply-llm-patch"),
  loadStyleGrounding: () =>
    import("../../../src/editor/edit-service/load-style-grounding"),
  loadProjectKnowledge: () =>
    import("../../../src/editor/edit-service/load-project-knowledge"),
  loadRunEditFixMiniTurn: () =>
    import("../../../src/editor/agent-chat-sdk/edit-fix-mini-turn"),
}
