/**
 * An edit request -> the ledger `fields` payload.
 *
 * Deliberately narrow: it copies the few values that MEAN something to a
 * reader, not the whole request. Coordinates, base hashes and fallback
 * routing are mechanics — they would bloat every line of the log and say
 * nothing a person wants to read.
 *
 * `llm-patch` is summarised by count rather than content on the same
 * principle: a bundle's individual before/after strings can be large, and
 * the log is append-only.
 */

import type { EditRequestBody } from '../edit-service/validate-edit-request'

export function ledgerFieldsForEdit(
  edit: EditRequestBody['edit'],
): Record<string, unknown> | undefined {
  switch (edit.kind) {
    case 'prop':
      return { propName: edit.propName, value: edit.value }
    case 'token-value':
      return { tokenName: edit.tokenName, newValue: edit.newValue }
    case 'text-branch':
      return { newValue: edit.newValue }
    case 'swap':
      return {
        fromComponentName: edit.fromComponentName,
        toComponentName: edit.toComponentName,
      }
    case 'detach':
      return { componentName: edit.componentName }
    case 'flatten-conditional':
      return { branchToKeep: edit.branchToKeep }
    case 'jsx-style':
      return {
        mode: edit.mode,
        addClasses: edit.addClasses,
        removeClasses: edit.removeClasses,
        declarations: edit.declarations,
        removeDeclarations: edit.removeDeclarations,
      }
    case 'llm-patch':
      // Unreachable through the CLI dispatcher today: `applyEdit`
      // (editor-cli/src/server/edit-handler.ts) special-cases
      // `body.edit.kind === 'llm-patch'` and routes straight to
      // `handleLLMPatch`, which writes its own ledger `describe` call
      // (with its own `mutationCount`, taken from the mutation bundle
      // rather than the patched-file count — see the comment on
      // `writePatchedFilesThroughBroker`'s `mutationCount` arg) before
      // this function's single call site is ever reached. Kept for the
      // mapper's shape completeness — every `EditRequestBody['edit']`
      // kind should have a defined mapping here even if today's only
      // caller can't reach it with this one — and it stays covered by a
      // direct unit test below rather than a live route path.
      return { mutationCount: edit.mutations.length }
    case 'scoped-css-override':
      return { declarations: edit.declarations, applyClasses: edit.applyClasses }
    default:
      // move / delete / insert / unwrap / overwrite: the description is
      // carried by the kind and the file alone.
      return undefined
  }
}
