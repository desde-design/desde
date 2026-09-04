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

import { reconstructWriteEdit } from '../agent-chat-sdk/edit-ack'
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
  /** Whether to record an undo step. The edit-fix mini-turn passes false. */
  recordHistory?: boolean
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
    handler: (input: Record<string, unknown>, _ctx?: unknown): Promise<TextToolResult> =>
      applyWrite('Write', input, opts),
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
    handler: (input: Record<string, unknown>, _ctx?: unknown): Promise<TextToolResult> =>
      applyWrite('Edit', input, opts),
  }
}

async function applyWrite(
  toolName: 'Write' | 'Edit',
  input: Record<string, unknown>,
  opts: BuiltinWriteOpts,
): Promise<TextToolResult> {
  const built = await reconstructWriteEdit(toolName, input, opts.worktreeRoot)
  if (!built.ok) return err(prefixRefusal(toolName, built.reason))

  const result = await brokeredWrite({
    canonicalRoot: opts.worktreeRoot,
    journal:
      built.priorContent === null ? [] : [{ file: built.repoRel, content: built.priorContent }],
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
          content: built.priorContent === null ? null : Buffer.from(built.priorContent, 'utf8'),
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
    ...(opts.acquireTreeGate ? { acquireTreeGate: opts.acquireTreeGate } : {}),
  })

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
