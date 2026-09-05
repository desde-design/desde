/**
 * Desde's own `Write` and `Edit`.
 *
 * These are the reason three modules on the SDK lane do not exist on this one.
 * `sdk-write-guard.ts`, `write-invalidate-hook.ts` and `file-read-snapshot.ts`
 * all exist because the SDK owns the write syscall, so the only way to
 * journal, lock, invalidate and ledger around it is a hook bracket whose
 * ordering guarantees that module's doc describes as "verified against the
 * installed SDK" rather than contracted.
 *
 * Here the tool performs the write, so it simply calls `brokeredWrite`, which
 * is documented as being free of HTTP and CLI dependencies precisely so a
 * caller other than the CLI edit handler can. In one call it journals the
 * original, takes the whole batch's file locks in sorted order, checks the
 * precondition, writes, rolls back on failure, invalidates, records an undo
 * step, appends the ledger entry, and runs the `edit_proposed` emit.
 *
 * The refusal policy is NOT duplicated here. `reconstructWriteEdit` in
 * `edit-ack.ts` is the single implementation of containment, protected paths,
 * the extension allowlist, `old_string` uniqueness and the no-op guard, and
 * the permission gate the loop runs before this handler uses the same one.
 */

import { z } from 'zod'

import type { ToolHandlerContext } from '../agent-chat/tool-spec'
import type { OverwriteConflictDetected } from '../agent-chat-sdk/edit-ack'
import { reconstructWriteEdit, sha256 } from '../agent-chat-sdk/edit-ack'
import {
  brokeredWrite,
  rollbackWarning,
  type AcquireTreeGate,
} from '../agent-chat-sdk/write-broker'
import type { EditProposalPayload } from '../agent-tools/types'
import { getSharedEditHistory } from '../edit-service/edit-history'

/**
 * What a Write or Edit call answers with. A narrowing of `ToolHandlerResult`
 * to the one content shape these tools ever produce, for the same reason
 * `builtin-read.ts` leaves its own return type inferred: a caller reading
 * `.content[0].text` should not have to narrow away an `image` branch that
 * cannot occur here. Still structurally a `ToolSpec` handler result, which is
 * what `builtin-tools.ts` checks when it assembles these into `ToolSpec[]`.
 */
interface TextToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: true | undefined
}

export interface BuiltinWriteOpts {
  worktreeRoot: string
  /** Fires the `edit_proposed` event. Threaded from the turn's opts. */
  emitEdit: (
    payload: EditProposalPayload,
  ) => Promise<{ ok: true; editId: string } | { ok: false; reason: string }>
  /** Replays the write into the dev server. Threaded from the turn's opts. */
  invalidateFiles?: (files: string[]) => void
  /** Orders the write and its ledger append against Commit and Publish. */
  acquireTreeGate?: AcquireTreeGate
  /**
   * Advances the session's read baseline for a file this lane just wrote, so
   * the agent's next write to it without an intervening Read is not reported
   * as somebody else's change.
   *
   * FX11 item 2 (2026-09-05). This used to live in the permission gate, which
   * on this lane runs BEFORE the write: the gate's ack is a no-op stub here,
   * and the write happens down in this file, where the broker can still refuse
   * it. So a refused write left the baseline recording bytes nobody wrote, and
   * the next edit raised a conflict banner over a file nothing had touched.
   * Called only on the broker's success path, which is the earliest moment the
   * new bytes are actually on disk.
   */
  recordOwnWrite?: (absPath: string, nextHash: string) => void
  /** Whether to record an undo step. The edit-fix mini-turn passes false. */
  recordHistory?: boolean
  /**
   * The session's read baselines, by absolute path. Same getter the permission
   * gate takes, and on this lane it is passed HERE instead. See
   * `reportOverwriteConflict` below for why.
   */
  getFileReads?: () => Record<string, { hashAtRead: string }> | undefined
  /**
   * Raises the `edit_overwrite_warning` banner. Same callback shape the
   * permission gate takes, and on this lane it is passed HERE instead.
   */
  onConflictDetected?: (conflict: OverwriteConflictDetected) => void | Promise<void>
}

const WRITE_DESCRIPTION =
  'Write a whole file. Use this to CREATE a file. To change an existing file use Edit instead: ' +
  'rewriting a whole file to change a few lines is how unrelated work gets reverted. New files ' +
  'are limited to the text formats this work needs; anything else is refused with a reason. The ' +
  'file lands as an uncommitted change in the working tree and the prototype reloads.'

const EDIT_DESCRIPTION =
  'Replace one exact string in one file. `old_string` must appear EXACTLY ONCE, so include enough ' +
  'surrounding lines that the match could only be the place you mean. If it is not unique the ' +
  'edit is refused: widen the match rather than guessing which occurrence was meant. Pass ' +
  '`replace_all` only when you genuinely want every occurrence. An edit that changes nothing is ' +
  'refused. The change lands as an uncommitted change in the working tree and the prototype reloads.'

export function buildWriteToolSpec(opts: BuiltinWriteOpts) {
  return {
    name: 'Write',
    description: WRITE_DESCRIPTION,
    kind: 'builtin' as const,
    inputShape: {
      file_path: z.string().describe('Repository-relative path of the file to write.'),
      content: z.string().describe('The complete new contents of the file.'),
    },
    handler: (input: Record<string, unknown>, ctx?: ToolHandlerContext): Promise<TextToolResult> =>
      applyWrite('Write', input, opts, ctx),
  }
}

export function buildEditToolSpec(opts: BuiltinWriteOpts) {
  return {
    name: 'Edit',
    description: EDIT_DESCRIPTION,
    kind: 'builtin' as const,
    inputShape: {
      file_path: z.string().describe('Repository-relative path of the file to change.'),
      old_string: z
        .string()
        .describe('The exact text to replace. Must appear exactly once unless replace_all is set.'),
      new_string: z.string().describe('The text to put in its place.'),
      replace_all: z
        .boolean()
        .optional()
        .describe('Replace every occurrence instead of requiring a unique match.'),
    },
    handler: (input: Record<string, unknown>, ctx?: ToolHandlerContext): Promise<TextToolResult> =>
      applyWrite('Edit', input, opts, ctx),
  }
}

async function applyWrite(
  toolName: 'Write' | 'Edit',
  input: Record<string, unknown>,
  opts: BuiltinWriteOpts,
  ctx?: ToolHandlerContext,
): Promise<TextToolResult> {
  // FX16 item 1 (2026-09-05). This context used to be named `_ctx` and
  // dropped, which is how a write landed after an explicit Stop: the loop
  // checks the signal before the call, but `brokeredWrite` below then waits
  // for the repo's tree gate, and a Commit or a Publish holds that for
  // seconds. The handler is the only code left inside that window, so it
  // reads the signal too.
  if (isStopped(ctx)) return err(stoppedRefusal(toolName))
  const built = await reconstructWriteEdit(toolName, input, opts.worktreeRoot)
  if (!built.ok) return err(prefixRefusal(toolName, built.reason))
  // Read a second time, after the reconstruction's own filesystem work: that
  // is a `resolveRepoPath`, an `existsSync` and a whole-file read, all of
  // which yield to the event loop, so Stop can arrive during them.
  if (isStopped(ctx)) return err(stoppedRefusal(toolName))

  // The LAST place a Stop can still be honoured, and the widest window of the
  // three. `brokeredWrite` asks for the repo's tree gate before it touches
  // anything, and a Commit, a Publish or another chat session holds that for
  // as long as its own operation takes — seconds, not microseconds. Refusing
  // the moment the gate is handed over leaves nothing on disk: the journal,
  // the file locks and the write all happen after this point.
  //
  // Throwing is how the batch is stopped, because `brokeredWrite` awaits this
  // callback OUTSIDE its own try: the throw reaches `applyWrite` before any
  // broker work has begun. The gate is released first, so a stopped turn does
  // not park Commit behind it.
  const acquireTreeGate = opts.acquireTreeGate
  const gatedByStop: AcquireTreeGate | undefined = acquireTreeGate
    ? async () => {
        const release = await acquireTreeGate()
        if (isStopped(ctx)) {
          release()
          throw new TurnStopped()
        }
        return release
      }
    : undefined

  let result: Awaited<ReturnType<typeof brokeredWrite<{ ok: true; editId: string } | { ok: false; reason: string }>>>
  try {
    result = await brokeredWrite({
      canonicalRoot: opts.worktreeRoot,
      // The RAW bytes, not `priorContent`'s UTF-8 decode, for both the journal
      // and the precondition below — see `priorBytes` on `WriteReconstruction`.
      // A file holding invalid UTF-8 re-encodes to different bytes than the ones
      // on disk, so the precondition could never match and every edit to such a
      // file was refused as "changed on disk".
      journal: built.priorBytes === null ? [] : [{ file: built.repoRel, content: built.priorBytes }],
      ops: [
        {
          kind: 'write',
          repoRel: built.repoRel,
          absPath: built.absPath,
          content: built.newSource,
          ...(built.isNew ? { ensureDir: true, isNew: true as const } : {}),
        },
      ],
      // Closes the window between reconstruction (which read the file outside
      // any lock) and the batch's own locks. A file that changed in between
      // refuses the batch rather than clobbering whoever wrote it.
      preconditions: [
        {
          repoRel: built.repoRel,
          absPath: built.absPath,
          expect: {
            exists: !built.isNew,
            content: built.priorBytes,
          },
        },
      ],
      ...(opts.invalidateFiles ? { invalidate: opts.invalidateFiles } : {}),
      // The ack is awaited AFTER the bytes are on disk, and that is deliberate.
      // It differs from the SDK lane's BUILT-IN Write/Edit, where a failed ack
      // is a `deny` in the permission gate and the write never happens — but
      // that lane has no other option: the SDK owns the write syscall, so the
      // gate is the only place it can intervene. Every tool that performs its
      // OWN write through `brokeredWrite` acks afterwards, including all six of
      // the SDK lane's structural tools (`fs-structural-tools.ts`, which report
      // the same "the change IS on disk" on a failed ack). Acking first here
      // would make Write and Edit the odd pair on their own lane, and would
      // record an edit proposal and persist its blob for a write the broker's
      // precondition check may then refuse. Raised as P3-2 in the 2026-09-04
      // adversarial review and kept as it stands for those reasons.
      emit: () =>
        opts.emitEdit({
          type: 'overwrite',
          file: built.repoRel,
          newSource: built.newSource,
          ...(built.baseHash ? { baseHash: built.baseHash } : {}),
          ...(built.isNew ? { allowCreate: true } : {}),
          appliedByAgent: true,
        }),
      ...(opts.recordHistory !== false
        ? { record: { history: getSharedEditHistory(), label: `${toolName}: ${built.repoRel}` } }
        : {}),
      // 'write' / 'edit' are the kinds the ledger already knows (LEDGER_KINDS in
      // ledger/describe-entry.ts), and the same ones the SDK lane records for the
      // same tool call. Inventing a spelling here would make every row of this
      // lane read as the humanised fallback in the Activity panel, and the log is
      // append-only, so those rows could never be repaired.
      describe: { kind: toolName === 'Write' ? 'write' : 'edit', lane: 'chat' as const },
        ...(gatedByStop ? { acquireTreeGate: gatedByStop } : {}),
    })
  } catch (e) {
    if (e instanceof TurnStopped) return err(stoppedRefusal(toolName))
    throw e
  }

  if (!result.ok) {
    // A protected-path refusal is phrased as itself. The generic branches read
    // as transient and invite a retry, which is exactly the wrong signal.
    if (result.stage === 'refused') return err(result.reason)
    if (result.stage === 'backup') {
      return err(`${toolName} aborted: ${result.reason}. '${built.repoRel}' was not modified.`)
    }
    if (result.stage === 'precondition') {
      return err(
        `${toolName} refused: '${built.repoRel}' changed on disk after you read it. Read it again and redo the change against the current contents.`,
      )
    }
    return err(`${toolName} failed: ${result.reason}${rollbackWarning(result)}`)
  }
  // Ordered before `recordOwnWrite`, which is about to move the baseline this
  // reads.
  await reportOverwriteConflict(built, opts)
  // The bytes are on disk now, so this is the first honest moment to move the
  // session's read baseline. Wrapped, like the conflict callback it pairs
  // with, so a telemetry failure cannot turn a landed write into an error.
  if (opts.recordOwnWrite) {
    try {
      opts.recordOwnWrite(built.absPath, sha256(built.newSource))
    } catch {
      // Deliberately swallowed: see above.
    }
  }
  const ack = result.emitted
  if (ack && ack.ok === false) {
    const backupClause = result.backupDir ? ` (backup at '${result.backupDir}')` : ''
    return {
      content: [
        {
          type: 'text',
          text: `${toolName}: '${built.repoRel}' was written, but the chat record of it failed: ${ack.reason}. The change IS on disk${backupClause}.`,
        },
      ],
      isError: true,
    }
  }
  return {
    content: [
      {
        type: 'text',
        text: `${toolName}: '${built.repoRel}' ${built.isNew ? 'created' : 'updated'}. The change is uncommitted in the working tree.`,
      },
    ],
  }
}

/**
 * Warns when this write replaced bytes the model had not read.
 *
 * FX14 item 2 (2026-09-05). A whole-file `Write` over a file that changed
 * replaces it, and that is the documented contract of the tool; the banner
 * this raises is the only thing between the user and a SILENT loss. It used to
 * be raised in the permission gate, which on this lane runs before the write
 * and reads the file a second time to decide. So the sequence was: gate reads
 * the file, gate compares it to the model's baseline, gate allows, THEN this
 * handler reads the file again and writes it. A concurrent writer landing
 * between those two reads made both checks agree with each other and disagree
 * with what the model had actually read, so nothing warned. The verifier
 * measured the window at 0.197 ms and reproduced the loss with `warnings=0`.
 *
 * It is raised here instead, against `built.baseHash` — the hash of the bytes
 * this handler read, which the broker's precondition has since pinned under
 * the file's own lock. Those ARE the bytes that were replaced, so there is no
 * window left between the comparison and the write.
 *
 * Two consequences worth stating. A write the broker refuses no longer raises
 * a banner, which is right: nothing was overwritten. And `Edit` was never
 * exposed to this in the first place, because it re-applies `old_string` to
 * whatever it read, so the other writer's content survives.
 */
async function reportOverwriteConflict(
  built: { repoRel: string; absPath: string; isNew: boolean; baseHash?: string | undefined },
  opts: BuiltinWriteOpts,
): Promise<void> {
  if (!opts.onConflictDetected) return
  const prior = opts.getFileReads?.()?.[built.absPath]
  // No baseline means the model wrote a file it never read, and conflict
  // semantics need one. Same rule the gate applied.
  if (!prior) return
  // `isNew` with a recorded read means the file was deleted between the
  // model's Read and this write. The gate spelled that state as the hash of
  // empty content, and the resolver reads it back the same way.
  const hashAtWrite = built.isNew ? sha256('') : (built.baseHash ?? sha256(''))
  if (prior.hashAtRead === hashAtWrite) return
  try {
    await opts.onConflictDetected({
      file: built.repoRel,
      absolutePath: built.absPath,
      hashAtRead: prior.hashAtRead,
      hashAtWrite,
    })
  } catch {
    // Telemetry must never turn a landed write into a failure.
  }
}

/**
 * Read through a function rather than inline, so the compiler cannot narrow
 * one check's result onto the next: the whole point of the later checks is
 * that the signal may have changed while an await was in flight.
 */
function isStopped(ctx: ToolHandlerContext | undefined): boolean {
  return ctx?.signal?.aborted === true
}

/**
 * Thrown out of the tree-gate callback to stop a batch the user cancelled.
 * Never escapes `applyWrite`.
 */
class TurnStopped extends Error {}

/**
 * One wording for every refusal point, because they are one fact: the user
 * pressed Stop and this write did not happen. Naming which internal await the
 * signal arrived during would tell the model nothing it can act on.
 */
function stoppedRefusal(toolName: 'Write' | 'Edit'): string {
  return `${toolName} was not run: the turn was stopped before anything was written.`
}

function err(text: string): TextToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

/**
 * `reconstructWriteEdit`'s reason sometimes already reads as a refusal
 * itself (e.g. `Write denied: path '../x' escapes repo root`), because
 * `edit-ack.ts` is the single implementation shared with the SDK lane's
 * own refusal wrapper. Prefixing `${toolName} refused: ` onto that
 * unconditionally produced `Write refused: Write denied: ...` — the same
 * fact stated twice. Add the prefix only when the reason doesn't already
 * read as one.
 */
function prefixRefusal(toolName: 'Write' | 'Edit', reason: string): string {
  if (/^(Write|Edit) (refused|denied):/.test(reason)) return reason
  return `${toolName} refused: ${reason}`
}
