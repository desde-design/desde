/**
 * Filesystem-structural write-tool handlers: `delete_file`, `rename_file`,
 * `insert_component`, `scaffold_route`, `insert_element`, `manage_package`.
 * Split out of `editor-tools.ts` (Phase 4 mechanical split, share-readiness)
 * — these six share the branch-mode contract documented on
 * {@link deleteFileHandler}: journal the original to `.desde/backups/`
 * BEFORE the mutation (a backup failure refuses the whole op), the mutation
 * lands as an ordinary uncommitted working-tree change (no per-op commit),
 * and `invalidateFiles` deterministically replays the write into Vite.
 *
 * `editor-tools.ts` keeps the `tool()` schema declarations and wires them
 * to the handlers exported here — same pattern as `save-screenshot-plan-tool.ts`
 * / `heal-plan-step-tool.ts`. Exported so tests can drive handlers directly
 * without the SDK MCP layer.
 *
 * The journal → locked write → invalidate → emit sequence itself is NOT
 * implemented here: all six handlers drive `brokeredWrite`
 * ({@link ./write-broker}), the one shared implementation (audit Task 12).
 * Each handler still owns its own refusal wording — the broker reports a
 * stage + a bare reason and the handler formats the message.
 */
import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants, existsSync } from 'node:fs'
import { access, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join as joinPath, relative, sep } from 'node:path'

import type { EditProposalPayload } from '../agent-tools/types'
import { resolveRepoPath } from '../agent-tools/read-tools'
import { locateRouterFile } from '../agent-tools/locate-router-file'
import type { PackageManagerAdapter } from '../core/package-manager-adapter'
import { applyInsertEdit } from '../edit-service/apply-insert-edit'
import { getSharedEditHistory } from '../edit-service/edit-history'
import { resolveSafeCreatePath } from '../edit-service/safe-create-path'
import { scaffoldVueRoute } from '../edit-service/scaffold-vue-route'
import { appendLedgerEntry, hashContent, resolveBranchCached } from '../ledger/edit-ledger'
import type { BackupEntry } from './backup-journal'
import { brokeredWrite, rollbackWarning, type AcquireTreeGate } from './write-broker'
import type { EmitEditResult, FileWriteToolResult } from './editor-tools'
import {
  ALLOWED_COMPONENT_EXTENSIONS,
  ALLOWED_NEW_FILE_EXTENSIONS,
  extensionOf,
  toRel as toRepoRel,
} from './edit-ack'
import { isSecretAgentPath, secretPathDenial } from './protected-paths'
import type { GetGrounding } from './grounding-tools'

interface DeleteFileHandlerOpts {
  worktreeRoot: string | undefined
  invalidateFiles?: (files: string[]) => void
  emitEdit: (payload: EditProposalPayload) => Promise<EmitEditResult>
  input: { path: string }
  /**
   * A2 (round-2 whole-branch review finding, 2026-08-19): orders this
   * handler's `brokeredWrite` call — including its edit-ledger append —
   * against a concurrent Commit/Publish/branch mutation. Optional; the
   * CLI supplies `acquireTreeGateShared` (`editor-cli/src/server/session-lock.ts`).
   * See `AcquireTreeGate`'s doc comment in `write-broker.ts` for why this
   * lives here rather than inside `brokeredWrite` unconditionally.
   */
  acquireTreeGate?: AcquireTreeGate
}

/**
 * Standalone handler for `mcp__editor__delete_file`. Pure-ish:
 * touches the filesystem and calls the orchestrator-supplied
 * `emitEdit` callback, otherwise has no global state. Exported so
 * tests can drive it directly without spinning up the SDK MCP layer.
 *
 * Branch-mode contract (shared by all structural write tools here):
 * the prior content is journaled to `.desde/backups/` BEFORE the
 * mutation (a backup failure refuses the whole op — nothing modified),
 * the mutation lands as an ordinary uncommitted working-tree change
 * (no per-op commit; the user commits via their own git / Publish),
 * and `invalidateFiles` deterministically replays the write into Vite.
 */
export async function deleteFileHandler(
  opts: DeleteFileHandlerOpts,
): Promise<FileWriteToolResult> {
  const { worktreeRoot, invalidateFiles, emitEdit, input, acquireTreeGate } = opts
  if (!worktreeRoot) {
    return {
      content: [
        {
          type: 'text',
          text: 'delete_file is not configured with an editable repo root for this run.',
        },
      ],
      isError: true,
    }
  }
  // resolveRepoPath realpaths the root internally; do the same here so
  // `toRepoRel` strips the canonical prefix correctly on macOS (where
  // /var → /private/var via realpath).
  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(worktreeRoot)
  } catch (err) {
    return {
      content: [
        { type: 'text', text: `delete_file: worktree root not accessible: ${(err as Error).message}` },
      ],
      isError: true,
    }
  }
  const safe = await resolveRepoPath(worktreeRoot, input.path)
  if (!safe.ok) {
    return {
      content: [{ type: 'text', text: `delete_file denied: ${safe.reason}` }],
      isError: true,
    }
  }
  if (!existsSync(safe.absolute)) {
    return {
      content: [{ type: 'text', text: `delete_file: '${input.path}' does not exist` }],
      isError: true,
    }
  }
  // Read raw bytes — delete takes arbitrary paths (possibly binary
  // assets), and the backup must restore the exact original.
  let priorContent: Buffer
  try {
    priorContent = await readFile(safe.absolute)
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `delete_file: cannot read '${input.path}' before delete: ${(err as Error).message}`,
        },
      ],
      isError: true,
    }
  }
  const baseHash = createHash('sha256').update(priorContent).digest('hex')
  const repoRel = toRepoRel(canonicalRoot, safe.absolute)
  // The broker journals the content BEFORE the unlink — with no per-op
  // commit, the backup is the ONLY recovery path for an uncommitted file.
  // A backup failure therefore refuses the delete outright.
  const broker = await brokeredWrite({
    canonicalRoot,
    journal: [{ file: repoRel, content: priorContent }],
    ops: [{ kind: 'delete', repoRel, absPath: safe.absolute }],
    invalidate: invalidateFiles,
    emit: () =>
      emitEdit({
        type: 'file_delete',
        file: repoRel,
        baseHash,
        appliedByAgent: true,
      }),
    record: { history: getSharedEditHistory(), label: `delete_file: ${repoRel}` },
    describe: { kind: 'delete_file', lane: 'chat' },
    acquireTreeGate,
  })
  if (!broker.ok) {
    // Protected-path refusal: surface the denial verbatim. The generic
    // branches below phrase failures as "write failed"/"unlink failed", which
    // reads as a transient problem and invites a retry — exactly the wrong
    // signal here, since the refusal text tells the model not to route around
    // the block.
    if (broker.stage === 'refused') return fwError(broker.reason)
    return broker.stage === 'backup'
      ? fwError(
          `delete_file: ${broker.reason}. Delete aborted; '${repoRel}' was not modified.`,
        )
      : fwError(`delete_file: unlink failed: ${broker.reason}${rollbackWarning(broker)}`)
  }
  const backup = broker
  const ack = broker.emitted
  if (!ack.ok) {
    // The fs op succeeded; only the chat-audit emit failed. The prior
    // content is recoverable from the backup journal — still report
    // isError so the agent doesn't claim a clean delete.
    return {
      content: [
        {
          type: 'text',
          text: `delete_file: '${repoRel}' deleted, but proposal emit failed: ${ack.reason}. The change IS on disk (backup at '${backup.backupDir}'). The chat audit log just won't show the proposal card.`,
        },
      ],
      isError: true,
    }
  }
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          editId: ack.editId,
          file: repoRel,
          baseHash,
          backupDir: backup.backupDir,
          summary: `Deleted ${repoRel}`,
        }),
      },
    ],
  }
}

interface RenameFileHandlerOpts {
  worktreeRoot: string | undefined
  invalidateFiles?: (files: string[]) => void
  emitEdit: (payload: EditProposalPayload) => Promise<EmitEditResult>
  input: { from: string; to: string }
  /** See `DeleteFileHandlerOpts.acquireTreeGate` (A2). */
  acquireTreeGate?: AcquireTreeGate
  /**
   * The project's secret-read policy, threaded from the chat dispatch.
   * Default OFF — no blocking — on the same `=== true` discipline as every
   * other opt-in gate. See the refusal in the handler for what it gates when
   * it IS on, and why a RENAME counts as a read.
   */
  blockSecretReads?: boolean
}

/**
 * Standalone handler for `mcp__editor__rename_file`. Exported for
 * the same reason as {@link deleteFileHandler}; same branch-mode
 * backup-before-mutation contract.
 */
export async function renameFileHandler(
  opts: RenameFileHandlerOpts,
): Promise<FileWriteToolResult> {
  const { worktreeRoot, invalidateFiles, emitEdit, input, acquireTreeGate } = opts
  if (!worktreeRoot) {
    return {
      content: [
        {
          type: 'text',
          text: 'rename_file is not configured with an editable repo root for this run.',
        },
      ],
      isError: true,
    }
  }
  // FX17 item 5. A rename is a READ when the source is a credential: `.env`
  // is not on the write-protected list (it is not an execution sink, which
  // is that list's rule) and `.txt`/`.md`/`.json` are all allowed rename
  // destinations, so `rename_file(from: '.env', to: 'notes.txt')` followed
  // by `Read('notes.txt')` returned the whole file — neither spelling is a
  // secret by name, so both lanes' Read guards allowed the second call.
  // Refused here as well as in the shared gate, which is the both-ends rule:
  // the gate is the policy, and this handler is the code that moves the
  // file.
  if (opts.blockSecretReads === true && isSecretAgentPath(input.from)) {
    return {
      content: [{ type: 'text', text: secretPathDenial(input.from) }],
      isError: true,
    }
  }
  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(worktreeRoot)
  } catch (err) {
    return {
      content: [
        { type: 'text', text: `rename_file: worktree root not accessible: ${(err as Error).message}` },
      ],
      isError: true,
    }
  }
  const safeFrom = await resolveRepoPath(worktreeRoot, input.from)
  if (!safeFrom.ok) {
    return {
      content: [{ type: 'text', text: `rename_file denied: ${safeFrom.reason}` }],
      isError: true,
    }
  }
  if (!existsSync(safeFrom.absolute)) {
    return {
      content: [{ type: 'text', text: `rename_file: source '${input.from}' does not exist` }],
      isError: true,
    }
  }
  const safeTo = await resolveSafeCreatePath(worktreeRoot, input.to)
  if (!safeTo.ok) {
    return {
      content: [{ type: 'text', text: `rename_file denied: ${safeTo.reason}` }],
      isError: true,
    }
  }
  if (existsSync(safeTo.absolute)) {
    return {
      content: [
        {
          type: 'text',
          text: `rename_file: destination '${input.to}' already exists; refusing to overwrite. Use delete_file first or pick a different name.`,
        },
      ],
      isError: true,
    }
  }
  const fromExt = extensionOf(input.from)
  const toExt = extensionOf(input.to)
  if (toExt !== fromExt && !ALLOWED_NEW_FILE_EXTENSIONS.has(toExt)) {
    return {
      content: [
        {
          type: 'text',
          text: `rename_file: destination extension '${toExt || '(none)'}' is not allowed. Either match the source extension '${fromExt}' or use one of: ${[...ALLOWED_NEW_FILE_EXTENSIONS].join(', ')}.`,
        },
      ],
      isError: true,
    }
  }
  // Raw bytes for the same reason as delete_file — the source may be
  // a binary asset and the backup must be byte-exact.
  let priorContent: Buffer
  try {
    priorContent = await readFile(safeFrom.absolute)
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `rename_file: cannot read '${input.from}' before rename: ${(err as Error).message}`,
        },
      ],
      isError: true,
    }
  }
  const baseHash = createHash('sha256').update(priorContent).digest('hex')
  const fromRel = toRepoRel(canonicalRoot, safeFrom.absolute)
  const toRel = toRepoRel(canonicalRoot, safeTo.absolute)
  // The broker journals the source content under its OLD path before the
  // move so an undo can restore the pre-rename layout.
  const broker = await brokeredWrite({
    canonicalRoot,
    journal: [{ file: fromRel, content: priorContent }],
    ops: [
      {
        kind: 'rename',
        repoRel: fromRel,
        absPath: safeFrom.absolute,
        toRepoRel: toRel,
        toAbsPath: safeTo.absolute,
        // Same race as scaffold_route's page create: the destination
        // `existsSync` guard above can't be held under the lock, and
        // POSIX rename REPLACES an existing destination — so without
        // this the loser of a two-rename race silently destroys the
        // winner's file. Re-checked inside the op's locks instead.
        failIfDestExists: true,
      },
    ],
    invalidate: invalidateFiles,
    emit: () =>
      emitEdit({
        type: 'file_rename',
        fromFile: fromRel,
        toFile: toRel,
        baseHash,
        appliedByAgent: true,
      }),
    record: {
      history: getSharedEditHistory(),
      label: `rename_file: ${fromRel} → ${toRel}`,
    },
    describe: { kind: 'rename_file', lane: 'chat', fields: { from: fromRel, to: toRel } },
    acquireTreeGate,
  })
  if (!broker.ok) {
    // See the note on the sibling handlers: a protected-path refusal must not
    // be phrased as a transient write failure.
    if (broker.stage === 'refused') return fwError(broker.reason)
    if (broker.stage === 'backup') {
      return fwError(
        `rename_file: ${broker.reason}. Rename aborted; '${fromRel}' was not modified.`,
      )
    }
    // Lost the race to a concurrent rename/create — same refusal as the
    // destination check above, which this re-check backstops.
    if (broker.reason.startsWith('EEXIST')) {
      return fwError(
        `rename_file: destination '${input.to}' already exists (created concurrently); refusing to overwrite. Use delete_file first or pick a different name.${rollbackWarning(broker)}`,
      )
    }
    return fwError(`rename_file: rename failed: ${broker.reason}${rollbackWarning(broker)}`)
  }
  const backup = broker
  const ack = broker.emitted
  if (!ack.ok) {
    return {
      content: [
        {
          type: 'text',
          text: `rename_file: '${fromRel}' → '${toRel}' completed, but proposal emit failed: ${ack.reason}. The change IS on disk. The chat audit log just won't show the proposal card.`,
        },
      ],
      isError: true,
    }
  }
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          editId: ack.editId,
          fromFile: fromRel,
          toFile: toRel,
          baseHash,
          backupDir: backup.backupDir,
          summary: `Renamed ${fromRel} → ${toRel}`,
        }),
      },
    ],
  }
}

interface InsertComponentHandlerOpts {
  worktreeRoot: string | undefined
  invalidateFiles?: (files: string[]) => void
  emitEdit: (payload: EditProposalPayload) => Promise<EmitEditResult>
  /** Resolves the design-system component → tag + import path. */
  getGrounding: GetGrounding | undefined
  input: {
    componentName: string
    file: string
    line: number
    column: number
    destIndex?: number
    props?: Record<string, string | number | boolean>
    text?: string
  }
  /** See `DeleteFileHandlerOpts.acquireTreeGate` (A2). */
  acquireTreeGate?: AcquireTreeGate
}

function fwError(text: string): FileWriteToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

/** Escape a value for a double-quoted Vue attribute. */
function escapeAttrValue(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

/** Escape text destined for a component's default slot. */
function escapeSlotText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
}

/**
 * Build a single-element template snippet for a component instance.
 * String props render as literal attrs; number/boolean render as bound
 * attrs (`:prop="…"`). With no slot text the element is self-closing.
 * The applicator re-parses the spliced result, so a malformed snippet
 * (e.g. a bad prop name) is caught there and surfaced as a refusal.
 */
function buildComponentSnippet(
  tag: string,
  props: Record<string, string | number | boolean> | undefined,
  text: string | undefined,
): string {
  const attrParts: string[] = []
  for (const [k, v] of Object.entries(props ?? {})) {
    // String → literal attr; number/boolean → bound attr so the value
    // arrives as a real number/boolean, not the empty string a bare attr
    // would yield for a non-Boolean-typed prop (`:disabled="true"`, not
    // `disabled`).
    if (typeof v === 'string') attrParts.push(`${k}="${escapeAttrValue(v)}"`)
    else attrParts.push(`:${k}="${v}"`)
  }
  const attrs = attrParts.length > 0 ? ` ${attrParts.join(' ')}` : ''
  if (text === undefined || text === '') return `<${tag}${attrs} />`
  return `<${tag}${attrs}>${escapeSlotText(text)}</${tag}>`
}

/**
 * Standalone handler for `mcp__editor__insert_component`. Unlike
 * delete/rename (which mutate the tree directly), this routes the
 * change through the DETERMINISTIC insert applicator
 * ({@link applyInsertEdit}) — never a raw full-file Write — so it inherits
 * the applicator's structural splice + auto-import, then journals the
 * original + writes like the other file-write tools (branch mode: an
 * uncommitted working-tree change). The component's tag + import path
 * are resolved from the design-system manifest (grounding), so
 * insertion is grounded, not guessed.
 *
 * The audit carrier reuses the `overwrite` proposal shape with
 * `appliedByAgent: true` (the same contract SDK Write/Edit already use)
 * — no new proposal type / shell renderer needed.
 *
 * Exported so tests can drive it directly without the SDK MCP layer.
 */
export async function insertComponentHandler(
  opts: InsertComponentHandlerOpts,
): Promise<FileWriteToolResult> {
  const { worktreeRoot, invalidateFiles, emitEdit, getGrounding, input, acquireTreeGate } = opts
  if (!worktreeRoot) {
    return fwError(
      'insert_component is not configured with an editable repo root for this run.',
    )
  }
  if (!getGrounding) {
    return fwError(
      'insert_component requires design-system grounding, which is not configured for this prototype. Read the source and use the Edit tool instead.',
    )
  }

  // Resolve the component → tag + import path from the manifest.
  let manifest
  try {
    const source = await (await getGrounding()).getManifestSource()
    manifest = source ? await source.getComponent(input.componentName) : null
  } catch (err) {
    return fwError(`insert_component: grounding lookup failed: ${(err as Error).message}`)
  }
  if (!manifest) {
    return fwError(
      `insert_component: no component named "${input.componentName}" in the design system. Use list_components / search_components to find the exact name.`,
    )
  }
  const tag = manifest.name
  const importPath = manifest.importPath

  // We can only safely add an import when the manifest gives a
  // LOCATION-INDEPENDENT specifier (a bare package like `@acme/design-system`
  // or a build alias like `@/components/X.vue`). Refuse otherwise rather
  // than commit a broken/unresolved import:
  //  - absent → first-party / globally-registered component; the agent
  //    should add the import with Edit (or it needs no import).
  //  - source-RELATIVE (`./Foo.vue`, `../foo/Foo.vue`, absolute) → that
  //    specifier is valid from the component's own source (e.g. a Storybook
  //    story), NOT from an arbitrary destination SFC. Rebasing it is more
  //    than this deterministic tool should guess at — defer to Edit.
  if (!importPath) {
    return fwError(
      `insert_component: "${input.componentName}" has no import path in its manifest (often a first-party or globally-registered component). Insert it with Edit so you can add the correct import, or confirm it's globally registered.`,
    )
  }
  if (importPath.startsWith('.') || importPath.startsWith('/')) {
    return fwError(
      `insert_component: "${input.componentName}" has a source-relative import path ('${importPath}') that isn't valid from '${input.file}'. Insert it with Edit and write the correct relative import.`,
    )
  }

  // Guard the coordinates before they reach the applicator (which indexes
  // children by destIndex and matches elements by line/column). A
  // fractional value would index to `undefined` and throw; refuse cleanly
  // instead. (The schema also enforces .int() at the model boundary, but
  // the handler is called directly in tests/other callers.)
  if (
    !Number.isInteger(input.line) ||
    !Number.isInteger(input.column) ||
    (input.destIndex !== undefined && !Number.isInteger(input.destIndex))
  ) {
    return fwError('insert_component: line, column, and destIndex must be integers.')
  }

  // Vue parses `{{ … }}` in slot text as an interpolation, so literal text
  // carrying mustache delimiters can't be inserted verbatim. Refuse and
  // point the agent at Edit for interpolation/expression content.
  if (input.text && (input.text.includes('{{') || input.text.includes('}}'))) {
    return fwError(
      'insert_component: slot text contains Vue interpolation delimiters ({{ or }}). Insert the component without text, then use Edit to add interpolation/expression content.',
    )
  }

  const snippet = buildComponentSnippet(tag, input.props, input.text)

  // Resolve + read the destination SFC (path-traversal guarded).
  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(worktreeRoot)
  } catch (err) {
    return fwError(`insert_component: worktree root not accessible: ${(err as Error).message}`)
  }
  const safe = await resolveRepoPath(worktreeRoot, input.file)
  if (!safe.ok) {
    return fwError(`insert_component denied: ${safe.reason}`)
  }
  if (!existsSync(safe.absolute)) {
    return fwError(`insert_component: '${input.file}' does not exist`)
  }
  let priorContent: string
  try {
    priorContent = await readFile(safe.absolute, 'utf8')
  } catch (err) {
    return fwError(
      `insert_component: cannot read '${input.file}': ${(err as Error).message}`,
    )
  }
  const baseHash = createHash('sha256').update(priorContent, 'utf8').digest('hex')
  const repoRel = toRepoRel(canonicalRoot, safe.absolute)

  // Deterministic structural insert + auto-import.
  const result = applyInsertEdit({
    source: priorContent,
    destParentLine: input.line,
    destParentColumn: input.column,
    destIndex: input.destIndex ?? -1,
    snippet,
    componentImport: { name: tag, importPath },
  })
  if (!result.ok) {
    return fwError(`insert_component: ${result.reason}`)
  }
  if (result.source === priorContent) {
    return fwError('insert_component: produced no change (no-op).')
  }
  // All-or-nothing: if the applicator inserted the element but COULDN'T add
  // the import cleanly (no <script setup>, the name is already bound, the
  // script didn't parse, …), do NOT auto-commit an unresolved/wrong-bound
  // component. Refuse with the reason so the agent fixes the import (Edit)
  // or picks a different target. (The no-import-path case carries no
  // warning — it's handled with an advisory note below.)
  if (result.warnings && result.warnings.length > 0) {
    return fwError(
      `insert_component: did not insert <${tag}> because its import could not be added automatically: ${result.warnings.join('; ')} Add the import with Edit (or insert into an SFC with a <script setup> block), then retry.`,
    )
  }

  const broker = await brokeredWrite({
    canonicalRoot,
    journal: [{ file: repoRel, content: priorContent }],
    ops: [{ kind: 'write', repoRel, absPath: safe.absolute, content: result.source }],
    invalidate: invalidateFiles,
    emit: () =>
      emitEdit({
        type: 'overwrite',
        file: repoRel,
        newSource: result.source,
        baseHash,
        appliedByAgent: true,
        explanation: `Inserted <${tag}>`,
      }),
    record: { history: getSharedEditHistory(), label: `insert_component: ${repoRel}` },
    describe: { kind: 'insert_component', lane: 'chat', fields: { componentName: tag } },
    acquireTreeGate,
  })
  if (!broker.ok) {
    // Protected-path refusal: surface the denial verbatim. The generic
    // branches below phrase failures as "write failed"/"unlink failed", which
    // reads as a transient problem and invites a retry — exactly the wrong
    // signal here, since the refusal text tells the model not to route around
    // the block.
    if (broker.stage === 'refused') return fwError(broker.reason)
    return broker.stage === 'backup'
      ? fwError(
          `insert_component: ${broker.reason}. Insert aborted; '${repoRel}' was not modified.`,
        )
      : fwError(`insert_component: write failed: ${broker.reason}${rollbackWarning(broker)}`)
  }
  const backup = broker
  const ack = broker.emitted
  if (!ack.ok) {
    return fwError(
      `insert_component: <${tag}> inserted into '${repoRel}', but proposal emit failed: ${ack.reason}. The change IS on disk. The chat audit log just won't show the proposal card.`,
    )
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          editId: ack.editId,
          file: repoRel,
          backupDir: backup.backupDir,
          summary: `Inserted <${tag}> into ${repoRel}`,
        }),
      },
    ],
  }
}

interface ScaffoldRouteHandlerOpts {
  worktreeRoot: string | undefined
  invalidateFiles?: (files: string[]) => void
  emitEdit: (payload: EditProposalPayload) => Promise<EmitEditResult>
  input: {
    path: string
    name?: string
    heading?: string
    /** Optional explicit router file (repo-relative). Auto-detected when omitted. */
    routerFile?: string
  }
  /** See `DeleteFileHandlerOpts.acquireTreeGate` (A2). */
  acquireTreeGate?: AcquireTreeGate
}

/**
 * Standalone handler for `mcp__editor__scaffold_route` (editor-creation-navigation.md
 * Phase 4). Creates a new page SFC AND registers its route — the two-step thing
 * the agent otherwise has to do by hand-reading + rewriting the router config.
 *
 * Framework-specific work lives in the pure {@link scaffoldVueRoute} planner
 * (Vue 3 + Vue Router); this handler does only I/O: locate + read the router,
 * run the planner, journal the router's original, then write BOTH files
 * (modified router + new SFC) and emit two audit proposals — mirroring
 * {@link insertComponentHandler}'s backup→write→emit contract. A lazy
 * `component: () => import(...)` is used so no separate import edit is needed.
 *
 * Exported so tests can drive it directly without the SDK MCP layer.
 */
export async function scaffoldRouteHandler(
  opts: ScaffoldRouteHandlerOpts,
): Promise<FileWriteToolResult> {
  const { worktreeRoot, invalidateFiles, emitEdit, input, acquireTreeGate } = opts
  if (!worktreeRoot) {
    return fwError(
      'scaffold_route is not configured with an editable repo root for this run.',
    )
  }

  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(worktreeRoot)
  } catch (err) {
    return fwError(`scaffold_route: worktree root not accessible: ${(err as Error).message}`)
  }

  // ── Locate + read the router file ─────────────────────────────────────────
  // Explicit `routerFile` wins; otherwise probe conventional locations and
  // require exactly one that actually calls createRouter (refuse on 0 / >1 so
  // we never guess-rewrite the wrong file). Shared with route-enumeration.
  const located = await locateRouterFile(worktreeRoot, input.routerFile)
  if (!located.ok) {
    return fwError(`scaffold_route: ${located.reason}`)
  }
  const router = { abs: located.absolute, repoRel: located.repoRel, source: located.source }

  // ── Plan the route (pure) ─────────────────────────────────────────────────
  const plan = scaffoldVueRoute(
    { routerSource: router.source, routerFile: router.repoRel },
    { path: input.path, name: input.name, heading: input.heading },
  )
  if (!plan.ok) {
    return fwError(`scaffold_route: ${plan.reason}`)
  }
  if (plan.routerSource === router.source) {
    return fwError('scaffold_route: produced no change to the router (no-op).')
  }

  // ── Resolve + guard the new SFC's create path (symlink-safe) ──────────────
  const create = await resolveSafeCreatePath(worktreeRoot, plan.sfcPath)
  if (!create.ok) {
    return fwError(`scaffold_route denied: ${create.reason}`)
  }
  const ext = extensionOf(plan.sfcPath)
  if (!ALLOWED_COMPONENT_EXTENSIONS.has(ext)) {
    return fwError(
      `scaffold_route: new page '${plan.sfcPath}' has extension '${ext || '(none)'}'; a route page must be a renderable component: only ${[...ALLOWED_COMPONENT_EXTENSIONS].join('/')} can be created.`,
    )
  }
  if (existsSync(create.absolute)) {
    return fwError(
      `scaffold_route: page file '${plan.sfcPath}' already exists. Pick a different path/name or edit the existing page.`,
    )
  }
  const sfcRepoRel = toRepoRel(canonicalRoot, create.absolute)
  const routerBaseHash = createHash('sha256').update(router.source, 'utf8').digest('hex')

  // ── Journal the router's original, then write BOTH files ──────────────────
  // (The new SFC has no prior content — undo for it is deleting the
  // untracked file; only the router needs a backup. The broker knows that
  // convention: a `write` op with no journal entry rolls back by unlink.)
  const broker = await brokeredWrite({
    canonicalRoot,
    journal: [{ file: router.repoRel, content: router.source }],
    ops: [
      {
        kind: 'write',
        repoRel: sfcRepoRel,
        absPath: create.absolute,
        content: plan.sfcContent,
        ensureDir: true,
        // Creates the page file — nothing to journal, so rollback is
        // unlink. Declared, not inferred (see BrokerOp.isNew).
        isNew: true,
        // The `existsSync` guard above can't be held under the write
        // lock, so two concurrent scaffold_route calls for the same page
        // can both pass it. `exclusive` makes the loser's write fail
        // atomically with EEXIST rather than silently overwriting the
        // winner's freshly-created page — and stops the loser's `isNew`
        // rollback from unlinking a file it didn't create.
        exclusive: true,
      },
      { kind: 'write', repoRel: router.repoRel, absPath: router.abs, content: plan.routerSource },
    ],
    // Caller order (SFC then router), not write order — pinned by tests.
    invalidatePaths: [sfcRepoRel, router.repoRel],
    invalidate: invalidateFiles,
    // ── Emit audit proposals: new SFC (allowCreate) + router overwrite ────
    emit: async () => ({
      sfcAck: await emitEdit({
        type: 'overwrite',
        file: sfcRepoRel,
        newSource: plan.sfcContent,
        allowCreate: true,
        appliedByAgent: true,
        explanation: `Created page ${plan.componentName}`,
      }),
      routerAck: await emitEdit({
        type: 'overwrite',
        file: router.repoRel,
        newSource: plan.routerSource,
        baseHash: routerBaseHash,
        appliedByAgent: true,
        explanation: `Registered route ${plan.routePath}`,
      }),
    }),
    record: { history: getSharedEditHistory(), label: `scaffold_route: ${sfcRepoRel}` },
    describe: { kind: 'scaffold_route', lane: 'chat', fields: { routePath: plan.routePath } },
    acquireTreeGate,
  })
  if (!broker.ok) {
    // See the note on the sibling handlers: a protected-path refusal must not
    // be phrased as a transient write failure.
    if (broker.stage === 'refused') return fwError(broker.reason)
    if (broker.stage === 'backup') {
      return fwError(`scaffold_route: ${broker.reason}. Scaffold aborted; nothing was written.`)
    }
    // EEXIST on the page write means a concurrent scaffold_route won the
    // race after our existence check passed. Same refusal the check
    // itself produces — the agent should pick a different path, not
    // retry into an overwrite.
    if (broker.reason.startsWith('EEXIST')) {
      return fwError(
        `scaffold_route: page file '${plan.sfcPath}' already exists (a concurrent scaffold created it first). Pick a different path/name or edit the existing page.${rollbackWarning(broker)}`,
      )
    }
    return fwError(`scaffold_route: write failed: ${broker.reason}${rollbackWarning(broker)}`)
  }
  const backup = broker
  const { sfcAck, routerAck } = broker.emitted
  if (!sfcAck.ok || !routerAck.ok) {
    return fwError(
      `scaffold_route: route ${plan.routePath} created, but a proposal emit failed (${[!sfcAck.ok && sfcAck.reason, !routerAck.ok && routerAck.reason].filter(Boolean).join('; ')}). The change IS on disk. The chat audit log just won't show both cards.`,
    )
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          editId: routerAck.editId,
          routePath: plan.routePath,
          routeName: plan.routeName,
          component: plan.componentName,
          pageFile: sfcRepoRel,
          routerFile: router.repoRel,
          backupDir: backup.backupDir,
          summary: `Scaffolded ${plan.routePath} → ${sfcRepoRel} (registered in ${router.repoRel}). Navigate to ${plan.routePath} to see it; refine the page with Edit / insert tools.`,
        }),
      },
    ],
  }
}

interface InsertElementHandlerOpts {
  worktreeRoot: string | undefined
  invalidateFiles?: (files: string[]) => void
  emitEdit: (payload: EditProposalPayload) => Promise<EmitEditResult>
  input: {
    file: string
    line: number
    column: number
    /** A single template element (contentKind 'element') or plain text ('text'). */
    snippet: string
    destIndex?: number
    contentKind?: 'element' | 'text'
  }
  /** See `DeleteFileHandlerOpts.acquireTreeGate` (A2). */
  acquireTreeGate?: AcquireTreeGate
}

/**
 * Standalone handler for `mcp__editor__insert_element`. The plain/primitive
 * sibling of {@link insertComponentHandler}: inserts an arbitrary single
 * template element (`<div>`, `<p>`, `<img>`, `<ul>…`) OR bare text into a
 * destination parent, through the SAME deterministic {@link applyInsertEdit}
 * pipeline (never a raw Write) — then journals + writes + emits the audit
 * proposal exactly like the component path. Unlike `insert_component`, it is
 * NOT grounding-gated and does NOT auto-add an import: primitives need none,
 * and a catalog component should go through `insert_component` (which resolves
 * the tag + import from the manifest).
 *
 * Exported so tests can drive it directly without the SDK MCP layer.
 */
export async function insertElementHandler(
  opts: InsertElementHandlerOpts,
): Promise<FileWriteToolResult> {
  const { worktreeRoot, invalidateFiles, emitEdit, input, acquireTreeGate } = opts
  if (!worktreeRoot) {
    return fwError(
      'insert_element is not configured with an editable repo root for this run.',
    )
  }
  const contentKind = input.contentKind ?? 'element'
  if (
    !Number.isInteger(input.line) ||
    !Number.isInteger(input.column) ||
    (input.destIndex !== undefined && !Number.isInteger(input.destIndex))
  ) {
    return fwError('insert_element: line, column, and destIndex must be integers.')
  }
  if (!input.snippet || input.snippet.trim().length === 0) {
    return fwError('insert_element: snippet (element markup or text) must be non-empty.')
  }

  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(worktreeRoot)
  } catch (err) {
    return fwError(`insert_element: worktree root not accessible: ${(err as Error).message}`)
  }
  const safe = await resolveRepoPath(worktreeRoot, input.file)
  if (!safe.ok) {
    return fwError(`insert_element denied: ${safe.reason}`)
  }
  if (!existsSync(safe.absolute)) {
    return fwError(`insert_element: '${input.file}' does not exist`)
  }
  let priorContent: string
  try {
    priorContent = await readFile(safe.absolute, 'utf8')
  } catch (err) {
    return fwError(`insert_element: cannot read '${input.file}': ${(err as Error).message}`)
  }
  const baseHash = createHash('sha256').update(priorContent, 'utf8').digest('hex')
  const repoRel = toRepoRel(canonicalRoot, safe.absolute)

  const result = applyInsertEdit({
    source: priorContent,
    destParentLine: input.line,
    destParentColumn: input.column,
    destIndex: input.destIndex ?? -1,
    snippet: input.snippet,
    contentKind,
    // No componentImport — primitives/text need none; catalog components
    // go through insert_component.
  })
  if (!result.ok) {
    return fwError(`insert_element: ${result.reason}`)
  }
  if (result.source === priorContent) {
    return fwError('insert_element: produced no change (no-op).')
  }
  if (result.warnings && result.warnings.length > 0) {
    return fwError(`insert_element: ${result.warnings.join('; ')}`)
  }

  // Label for the commit message + audit card.
  const tag =
    contentKind === 'text'
      ? null
      : (input.snippet.trim().match(/^<\s*([A-Za-z][\w-]*)/)?.[1] ?? 'element')
  const what = tag ? `<${tag}>` : 'text'

  const broker = await brokeredWrite({
    canonicalRoot,
    journal: [{ file: repoRel, content: priorContent }],
    ops: [{ kind: 'write', repoRel, absPath: safe.absolute, content: result.source }],
    invalidate: invalidateFiles,
    emit: () =>
      emitEdit({
        type: 'overwrite',
        file: repoRel,
        newSource: result.source,
        baseHash,
        appliedByAgent: true,
        explanation: tag ? `Inserted ${what}` : 'Inserted text',
      }),
    record: { history: getSharedEditHistory(), label: `insert_element: ${repoRel}` },
    describe: { kind: 'insert_element', lane: 'chat' },
    acquireTreeGate,
  })
  if (!broker.ok) {
    // Protected-path refusal: surface the denial verbatim. The generic
    // branches below phrase failures as "write failed"/"unlink failed", which
    // reads as a transient problem and invites a retry — exactly the wrong
    // signal here, since the refusal text tells the model not to route around
    // the block.
    if (broker.stage === 'refused') return fwError(broker.reason)
    return broker.stage === 'backup'
      ? fwError(
          `insert_element: ${broker.reason}. Insert aborted; '${repoRel}' was not modified.`,
        )
      : fwError(`insert_element: write failed: ${broker.reason}${rollbackWarning(broker)}`)
  }
  const backup = broker
  const ack = broker.emitted
  if (!ack.ok) {
    return fwError(
      `insert_element: ${what} inserted into '${repoRel}', but proposal emit failed: ${ack.reason}. The change IS on disk. The chat audit log just won't show the proposal card.`,
    )
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          editId: ack.editId,
          file: repoRel,
          backupDir: backup.backupDir,
          summary: `Inserted ${what} into ${repoRel}`,
        }),
      },
    ],
  }
}

interface ManagePackageHandlerOpts {
  worktreeRoot: string | undefined
  invalidateFiles?: (files: string[]) => void
  emitEdit: (payload: EditProposalPayload) => Promise<EmitEditResult>
  packageManagerAdapter: PackageManagerAdapter | undefined
  /**
   * Turn-level abort signal. Forwarded to the install subprocess so
   * aborting the turn (client disconnect, Stop button) kills `npm
   * install` instead of leaking a long-running child after the turn
   * record is gone.
   */
  signal?: AbortSignal
  input: {
    operation: 'add' | 'remove'
    packageName: string
    versionSpec?: string
    dev?: boolean
  }
  /** See `DeleteFileHandlerOpts.acquireTreeGate` (A2). */
  acquireTreeGate?: AcquireTreeGate
}

/** The three lockfiles `manage_package` knows how to journal/track. */
const MANAGE_PACKAGE_LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'] as const

/**
 * Standalone handler for `mcp__editor__manage_package`. Two-step:
 * 1. mutate package.json via the substrate adapter's pure
 *    `applyManifestOp`, journal the original, write
 * 2. run the substrate's install command so node_modules + lockfile
 *    catch up
 *
 * Both the manifest edit and the lockfile change land as ordinary
 * uncommitted working-tree changes (branch mode — the user commits
 * them). Failure modes are encoded in the return value; nothing
 * throws.
 *
 * **The tree gate spans BOTH steps (P1-1, round-3 whole-branch review
 * finding, 2026-08-19).** `brokeredWrite`'s own `acquireTreeGate` (A2,
 * round 2) holds the gate only across ITS OWN call — correct for every
 * other structural tool, which does exactly one mutation, but wrong
 * here: step 2 (`install()`) mutates the lockfile AFTER `brokeredWrite`
 * would already have released it. A commit could then run between the
 * two steps — git commits `package.json` and appends its `commit`
 * marker while `install()` is still writing the lockfile, so the
 * ledger's `manage_package` entry reads `committed: true` while the
 * lockfile is still an uncommitted change.
 *
 * So this handler acquires the gate itself, BEFORE calling
 * `brokeredWrite`, and does NOT also pass it to `brokeredWrite` (the
 * gate is shared-reentrant, so passing it to both would not deadlock,
 * but it would be a pointless second acquisition of a gate this
 * function already holds — the same "don't double-acquire" rule
 * `AcquireTreeGate`'s own doc comment states for the CLI edit route).
 * The gate is released in a `finally` only after `install()` has fully
 * settled (ok or not) AND the lockfile follow-up below has been
 * recorded.
 */
export async function managePackageHandler(
  opts: ManagePackageHandlerOpts,
): Promise<FileWriteToolResult> {
  const {
    worktreeRoot,
    invalidateFiles,
    emitEdit,
    packageManagerAdapter,
    signal,
    input,
    acquireTreeGate,
  } = opts
  if (!worktreeRoot || !packageManagerAdapter) {
    return {
      content: [
        {
          type: 'text',
          text: 'manage_package is not configured with an editable repo root and a package-manager adapter for this run.',
        },
      ],
      isError: true,
    }
  }
  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(worktreeRoot)
  } catch (err) {
    return {
      content: [
        { type: 'text', text: `manage_package: worktree root not accessible: ${(err as Error).message}` },
      ],
      isError: true,
    }
  }
  const manifestAbs = joinPath(canonicalRoot, 'package.json')
  if (!existsSync(manifestAbs)) {
    return {
      content: [
        { type: 'text', text: 'manage_package: package.json not found at the worktree root' },
      ],
      isError: true,
    }
  }
  let priorSrc: string
  try {
    priorSrc = await readFile(manifestAbs, 'utf8')
  } catch (err) {
    return {
      content: [
        { type: 'text', text: `manage_package: cannot read package.json: ${(err as Error).message}` },
      ],
      isError: true,
    }
  }
  const apply = packageManagerAdapter.applyManifestOp(priorSrc, {
    kind: input.operation,
    packageName: input.packageName,
    versionSpec: input.versionSpec,
    dev: input.dev,
  })
  if (!apply.ok) {
    return {
      content: [{ type: 'text', text: `manage_package: ${apply.reason}` }],
      isError: true,
    }
  }
  const baseHash = createHash('sha256').update(priorSrc, 'utf8').digest('hex')
  // Journal the manifest AND any existing lockfile — the install step
  // below mutates the lockfile too, and with no per-op commit the
  // journal is the only way to roll the whole operation back.
  const backupEntries: BackupEntry[] = [
    { file: 'package.json', content: priorSrc },
  ]
  for (const lf of MANAGE_PACKAGE_LOCKFILES) {
    const lfAbs = joinPath(canonicalRoot, lf)
    if (!existsSync(lfAbs)) continue
    try {
      backupEntries.push({ file: lf, content: await readFile(lfAbs) })
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `manage_package: cannot read '${lf}' for backup: ${(err as Error).message}. Operation aborted; nothing was modified.`,
          },
        ],
        isError: true,
      }
    }
  }
  // Baseline lockfile hashes, taken from the SAME reads `backupEntries`
  // just did — reused rather than re-read, and it's the pre-install
  // truth the post-install comparison below needs. A lockfile absent
  // from this map did not exist before install ran.
  const baselineLockHashes = new Map<string, string>()
  for (const entry of backupEntries) {
    if (entry.file === 'package.json') continue
    baselineLockHashes.set(entry.file, hashContent(entry.content))
  }

  // Hold the gate ourselves across BOTH steps — see the function's own
  // doc comment for why `brokeredWrite`'s `acquireTreeGate` (scoped to
  // just its own call) is not enough here.
  const releaseTreeGate = acquireTreeGate ? await acquireTreeGate() : undefined
  try {
    const broker = await brokeredWrite({
      canonicalRoot,
      journal: backupEntries,
      ops: [
        { kind: 'write', repoRel: 'package.json', absPath: manifestAbs, content: apply.newSrc },
      ],
      invalidate: invalidateFiles,
      emit: () =>
        emitEdit({
          type: 'overwrite',
          file: 'package.json',
          newSource: apply.newSrc,
          baseHash,
          explanation: `${input.operation === 'add' ? 'Added' : 'Removed'} ${input.packageName}${input.versionSpec ? `@${input.versionSpec}` : ''}`,
          appliedByAgent: true,
        }),
      // No record: — npm's node_modules side effects aren't restorable;
      // restoring only manifests would leave an inconsistent install.
      // Excluded from toolbar undo (spec 2026-08-05).
      describe: {
        kind: 'manage_package',
        lane: 'chat',
        fields: { action: input.operation, packageName: input.packageName },
      },
      // Deliberately NOT `acquireTreeGate` here — this handler already
      // holds the gate (see above). Passing it to `brokeredWrite` too
      // would just be a second, pointless acquisition of a gate that's
      // reentrant-safe but adds nothing.
    })
    if (!broker.ok) {
      // Protected-path refusal: surface the denial verbatim. The generic
      // branches below phrase failures as "write failed"/"unlink failed", which
      // reads as a transient problem and invites a retry — exactly the wrong
      // signal here, since the refusal text tells the model not to route around
      // the block.
      if (broker.stage === 'refused') return fwError(broker.reason)
      return broker.stage === 'backup'
        ? fwError(
            `manage_package: ${broker.reason}. Operation aborted; package.json was not modified.`,
          )
        : fwError(`manage_package: writing package.json failed: ${broker.reason}${rollbackWarning(broker)}`)
    }
    const backup = broker
    const ack = broker.emitted
    if (!ack.ok) {
      // Manifest is on disk (with a backup); only the chat audit failed.
      // Soft enough to continue with install — the change is durable
      // on disk either way. Log but do not stop.
      console.warn(
        `[editor-sdk] manage_package: manifest written but proposal emit failed: ${ack.reason}`,
      )
    }

    // ── step 2: run install ───────────────────────────────────────
    const install = await packageManagerAdapter.install({ signal })

    // Record the completed set of changed files BEFORE releasing the
    // gate (P1-1, round-3 whole-branch review finding). `brokeredWrite`'s
    // own ledger entry above describes only what IT wrote — package.json
    // — because it was appended before `install()` ran and genuinely
    // could not know the lockfile's outcome yet. The lockfile mutation
    // is real and durable (git sees it, `reconcileLedger`'s per-file
    // dirty check would too), so it gets its OWN ledger entry here,
    // appended while still holding the gate: this closes the same
    // ordering gap this fix exists for, this time for the follow-up
    // append rather than the write itself. Best-effort like every other
    // ledger append (`appendLedgerEntry` swallows its own errors) and
    // checked regardless of `install.ok` — a failed install can still
    // have partially rewritten a lockfile before erroring.
    for (const lf of MANAGE_PACKAGE_LOCKFILES) {
      const lfAbs = joinPath(canonicalRoot, lf)
      let afterContent: Buffer | undefined
      try {
        afterContent = existsSync(lfAbs) ? await readFile(lfAbs) : undefined
      } catch {
        continue
      }
      const afterHash = afterContent ? hashContent(afterContent) : undefined
      if (afterHash === undefined || afterHash === baselineLockHashes.get(lf)) continue
      await appendLedgerEntry(canonicalRoot, {
        type: 'edit',
        id: randomUUID(),
        at: new Date().toISOString(),
        branch: await resolveBranchCached(canonicalRoot),
        kind: 'manage_package',
        lane: 'chat',
        files: [lf],
        afterHashes: { [lf]: afterHash },
        // P2-1 (codex review round 6, 2026-08-20): `baselineLockHashes`
        // above is built ONLY from lockfiles that existed before install
        // ran (see its own comment: "A lockfile absent from this map did
        // not exist before install ran") — so `!baselineLockHashes.has(lf)`
        // is this handler's own proof the install step just created `lf`.
        // This entry carries no `backupDir` (unchanged — see
        // `undo-entry.ts`'s module doc comment for why that's a SEPARATE,
        // still-open gap this fix does not touch), so without
        // `createdFiles` the planner could not distinguish this from an
        // unbacked overwrite of a pre-existing lockfile and had to refuse
        // Undo for a case that is provably a creation.
        ...(!baselineLockHashes.has(lf) ? { createdFiles: [lf] } : {}),
        fields: { action: input.operation, packageName: input.packageName, step: 'install' },
      })
    }

    // Summary text reflects ACTUAL state — "Added foo@1.0.0" on install
    // failure would mislead the agent into coding against a dep that's
    // in package.json but not on disk. Make the partial-success state
    // explicit so the agent surfaces it to the user.
    const verbPast = input.operation === 'add' ? 'Added' : 'Removed'
    const spec = `${input.packageName}${input.versionSpec ? `@${input.versionSpec}` : ''}`
    const summary = install.ok
      ? `${verbPast} ${spec}`
      : `${verbPast} ${spec} in package.json BUT install failed: the dependency is in the manifest, but node_modules / lockfile were NOT updated. Tell the user the install error needs to be resolved (e.g. invalid version, network failure, registry auth) before they can use the dep. If they want to roll back, restore package.json from the backup journal.`
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            editId: ack.ok ? ack.editId : null,
            file: 'package.json',
            operation: input.operation,
            packageName: input.packageName,
            backupDir: backup.backupDir,
            install: {
              ok: install.ok,
              exitCode: install.exitCode,
              command: install.command,
              durationMs: install.durationMs,
              // Only surface stderr when install failed — successful
              // installs are typically very chatty (deprecation warnings,
              // etc.) and that noise distracts from the agent's reasoning.
              stderr: install.ok ? undefined : install.stderr,
            },
            summary,
          }),
        },
      ],
      isError: !install.ok || undefined,
    }
  } finally {
    releaseTreeGate?.()
  }
}

/**
 * `download_asset` — fetch an image and write it into the repo.
 *
 * The only path by which a binary reaches the working tree. Policy lives in
 * `download-asset.ts` (host allowlist, private-address refusal, size cap,
 * content-type agreement); this function owns placement and the write.
 */
export async function downloadAssetHandler(opts: {
  worktreeRoot?: string
  invalidateFiles?: (files: string[]) => void
  emitEdit: (payload: EditProposalPayload) => Promise<EmitEditResult>
  webPolicy?: import('../core/web-policy').WebPolicy
  input: { url: string; destPath: string }
  fetchImpl?: typeof fetch
  /** See `DeleteFileHandlerOpts.acquireTreeGate` (A2). */
  acquireTreeGate?: AcquireTreeGate
}): Promise<FileWriteToolResult> {
  const { worktreeRoot, invalidateFiles, emitEdit, input, acquireTreeGate } = opts
  if (!worktreeRoot) {
    return fwError('download_asset is not configured with an editable repo root for this run.')
  }

  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(worktreeRoot)
  } catch (err) {
    return fwError(`download_asset: worktree root not accessible: ${(err as Error).message}`)
  }

  const safe = await resolveRepoPath(worktreeRoot, input.destPath)
  if (!safe.ok) return fwError(`download_asset denied: ${safe.reason}`)

  // `resolveRepoPath` falls back to the LEXICAL path when the leaf does not
  // exist (nothing to realpath yet), so a symlinked ANCESTOR is invisible to
  // it: with `public/out -> /tmp`, `public/out/pwn.png` passes every check and
  // the write follows the link out of the repo. Resolve the parent — which
  // does exist, or will be created inside the repo — and re-check containment.
  // Walk UP to the nearest ancestor that actually exists and canonicalise
  // THAT. Checking only the immediate parent was not enough: if the parent is
  // itself missing, `ensureDir` happily creates it through a symlinked
  // grandparent — `public/out -> /tmp` plus `public/out/new/pwn.png` writes to
  // /tmp/new. The first real directory on the path is the only thing whose
  // canonical location we can verify before creating anything under it.
  let ancestor = dirname(safe.absolute)
  let realAncestor: string | null = null
  for (;;) {
    try {
      realAncestor = await realpath(ancestor)
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        return fwError(`download_asset: destination not accessible: ${(err as Error).message}`)
      }
      const parent = dirname(ancestor)
      // Reached the filesystem root without finding anything real — that can
      // only mean the path left the repo, since the repo root exists.
      if (parent === ancestor) break
      ancestor = parent
    }
  }
  if (realAncestor === null) {
    return fwError(`download_asset denied: cannot resolve a real parent for '${input.destPath}'.`)
  }
  const ancestorRel = relative(canonicalRoot, realAncestor)
  if (ancestorRel === '..' || ancestorRel.startsWith('..' + sep) || ancestorRel.startsWith('../')) {
    return fwError(
      `download_asset denied: '${input.destPath}' resolves outside the repo through a symlinked directory.`,
    )
  }

  // Creation only. Overwriting a binary through a network fetch is a much
  // worse failure than refusing: the prior bytes are not something the agent
  // can reconstruct, and the user rarely means "replace that image".
  if (existsSync(safe.absolute)) {
    return fwError(
      `download_asset: '${input.destPath}' already exists. Choose a new path, or delete it first if you mean to replace it.`,
    )
  }


  // Prove the destination is WRITABLE too, not merely legal. A read-only
  // parent would otherwise fail at mkdir/writeFile after the download had
  // already happened — traffic spent on a write that was never possible.
  try {
    // Must be a DIRECTORY, not merely an existing writable path: with
    // `public/favicon.ico/logo.png` the ancestor resolves to a regular file,
    // W_OK succeeds, and the failure would surface as ENOTDIR only after the
    // download had already run.
    const ancestorStat = await stat(realAncestor)
    if (!ancestorStat.isDirectory()) {
      return fwError(
        `download_asset: '${relative(canonicalRoot, realAncestor) || '.'}' is a file, not a directory.`,
      )
    }
    await access(realAncestor, fsConstants.W_OK)
  } catch {
    return fwError(
      `download_asset: cannot write into '${relative(canonicalRoot, realAncestor) || '.'}': permission denied.`,
    )
  }

  // Everything local is settled BEFORE any network call: a destination we
  // cannot write must not still contact the host and pull down bytes.
  const { downloadAsset } = await import('../core/download-asset.js')
  const fetched = await downloadAsset({
    url: input.url,
    destPath: input.destPath,
    policy: opts.webPolicy,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  })
  if (!fetched.ok) return fwError(`download_asset denied: ${fetched.reason}`)
  // Host only — never the full URL, which can carry a signed-token query.
  const pre_host = (() => {
    try {
      return new URL(input.url).host
    } catch {
      return 'the network'
    }
  })()

  const repoRel = toRepoRel(canonicalRoot, safe.absolute)
  const broker = await brokeredWrite({
    canonicalRoot,
    // No journal entry: `isNew` declares there is nothing to recover, which
    // is true for a file that did not exist a moment ago.
    journal: [],
    ops: [
      {
        kind: 'write',
        repoRel,
        absPath: safe.absolute,
        content: fetched.bytes,
        ensureDir: true,
        isNew: true,
        // The existsSync above is a nicer error, not the guarantee: it is not
        // held across the write. `exclusive` makes the kernel enforce
        // creation-only, so a racing download or a user-created file fails
        // with EEXIST instead of being clobbered.
        exclusive: true,
      },
    ],
    invalidate: invalidateFiles,
    emit: () =>
      emitEdit({
        type: 'overwrite',
        file: repoRel,
        // A binary has no diff to show, so this carries a DESCRIPTION rather
        // than file content. Safe because `appliedByAgent: true` is the
        // "display only, never re-apply" contract — the shell will not write
        // this string anywhere. The real bytes are already on disk, and undo
        // comes from the broker's history entry below.
        newSource: `[binary asset: ${fetched.bytes.byteLength} bytes, ${fetched.contentType}]`,
        allowCreate: true,
        appliedByAgent: true,
        explanation: `Downloaded from ${pre_host}`,
      }),
    record: { history: getSharedEditHistory(), label: `download_asset: ${repoRel}` },
    describe: { kind: 'download_asset', lane: 'chat' },
    acquireTreeGate,
  })
  if (!broker.ok) {
    return fwError(`download_asset: write failed: ${broker.reason}${rollbackWarning(broker)}`)
  }

  return {
    content: [
      {
        type: 'text',
        text: `Downloaded ${fetched.bytes.byteLength} bytes (${fetched.contentType}) to ${repoRel}.`,
      },
    ],
  }
}
