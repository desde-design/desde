/**
 * Maps a `StructuralEdit` (editor-core's neutral edit-intent union) to the
 * wire-shape request body POSTed to `/api/editor/edit`, or refuses with
 * the `EditResult` failure the caller should return as-is. Extracted from
 * `BridgeFrameworkAdapter.applyEdit` (`index.ts`, share-readiness Phase 2) —
 * no behavior change, just a module boundary. `applyEdit` calls this first;
 * on refusal it returns the result immediately, otherwise it POSTs the
 * request body and parses the JSON/SSE response.
 */

import { deleteScopeAvailability } from '../../core'
import type { ApplyEditOpts, EditResult, StructuralEdit } from '../../core'

export type BuildEditRequestResult =
  | { ok: true; requestBody: Record<string, unknown> }
  | { ok: false; result: EditResult }

/**
 * `opts` is accepted for signature symmetry with `applyEdit` (which passes
 * it straight through) but the deterministic request-body mapping below
 * doesn't currently branch on it — `opts` only affects the streaming
 * decision made after this function returns.
 */
export function buildEditRequest(
  edit: StructuralEdit,
  opts?: ApplyEditOpts,
): BuildEditRequestResult {
  void opts
  let requestBody: Record<string, unknown> | null = null

  if (edit.kind === 'prop') {
    const editTarget = edit.target.editTarget
    if (!editTarget) {
      return {
        ok: false,
        result: {
          kind: 'failed',
          reason:
            'PropEdit requires target.editTarget; substrate must ship vite-plugin-source-tag and the selected element must carry data-desde-src',
        },
      }
    }
    const value = edit.value
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      return {
        ok: false,
        result: {
          kind: 'failed',
          reason: `PropEdit value must be string | number | boolean (V1.3); got ${typeof value}`,
        },
      }
    }
    requestBody = {
      edit: {
        kind: 'prop',
        file: editTarget.file,
        line: editTarget.line,
        column: editTarget.column,
        propName: edit.propName,
        value,
        // Where the server sends a PropEditFallbackHint (bound-binding /
        // v-model / dynamic-vbind) refusal when the source-aware lane
        // also refuses. `'chat'` makes the server signal `needsChat` so
        // the client hands the edit to the chat agent — same routing as
        // `llm-patch` bundles. Always `'chat'` (PropEdit carries no
        // per-edit override).
        llmFallback: 'chat',
        // Stale-target guard: the file-version hash captured WITH the
        // coordinates (data-desde-v). Server refuses (409) when the on-disk
        // file no longer matches — the coordinates provably predate it.
        ...(editTarget.fileHash ? { baseHash: editTarget.fileHash } : {}),
      },
    }
  } else if (edit.kind === 'move') {
    const editTarget = edit.target.editTarget
    if (!editTarget) {
      return {
        ok: false,
        result: {
          kind: 'failed',
          reason: `${edit.kind} requires target.editTarget; the source element must carry data-desde-src`,
        },
      }
    }
    const destination = edit.destination
    if (!destination?.parentEditTarget) {
      return {
        ok: false,
        result: {
          kind: 'failed',
          reason: `${edit.kind} requires destination.parentEditTarget (the dest parent's data-desde-src)`,
        },
      }
    }
    if (destination.parentEditTarget.file !== editTarget.file) {
      return {
        ok: false,
        result: {
          kind: 'failed',
          reason:
            'Cross-file moves are not supported in V1: source and destination must be in the same source file',
        },
      }
    }
    requestBody = {
      edit: {
        kind: edit.kind,
        file: editTarget.file,
        line: editTarget.line,
        column: editTarget.column,
        destFile: destination.parentEditTarget.file,
        destParentLine: destination.parentEditTarget.line,
        destParentColumn: destination.parentEditTarget.column,
        destIndex: destination.index,
        // Stale-target guard (source + dest coordinates were captured
        // from the same DOM snapshot; same-file moves share one hash).
        ...(editTarget.fileHash ? { baseHash: editTarget.fileHash } : {}),
        ...(destination.parentEditTarget.fileHash
          ? { destBaseHash: destination.parentEditTarget.fileHash }
          : {}),
        // Conditional-GROUP move (see `apply-move-edit.ts`'s `moveGroup`) —
        // set only when the target is a synthetic layers-panel group row.
        ...(edit.moveGroup ? { moveGroup: true } : {}),
      },
    }
  } else if (edit.kind === 'llm-patch') {
    requestBody = {
      edit: {
        kind: 'llm-patch',
        // Where the server sends this bundle when the deterministic
        // lane can't apply it: `'chat'` makes it stop and signal
        // `needsChat` (the shell hands it to the chat agent) instead of
        // running the in-request LLM patch lane + modal. Per-edit field
        // (`edit.llmFallback`) drives the routing: typing-time dispatches
        // pass 'chat' (→ queue), commit/flush dispatches pass 'patch'
        // (→ apply). Defaults to 'chat' when absent.
        llmFallback: edit.llmFallback ?? 'chat',
        // Cross-file external-edit guard. Carries per-file hashes the
        // shell received in a prior save's `newHashes`. The route
        // refuses (409) if any of these no longer match the on-disk
        // file — preventing silent overwrites of an engineer's IDE
        // edits made between the designer's saves.
        ...(edit.baseHashes ? { baseHashes: { ...edit.baseHashes } } : {}),
        mutations: edit.mutations.map((m) => ({
          id: m.id,
          kind: m.kind,
          sourceLoc: m.sourceLoc,
          sourceVersion: m.sourceVersion ?? null,
          resolutionKind: m.resolutionKind,
          scope: m.scope,
          callsiteLoc: m.callsiteLoc,
          callsiteVersion: m.callsiteVersion ?? null,
          instancePath: m.instancePath,
          selector: m.selector,
          target: m.target,
          before: m.before,
          after: m.after,
          // Preserve context end-to-end for class/style edits
          // (codex round-1 P2 #1). Cloned via destructure so the
          // adapter doesn't share references with the bridge log.
          context: m.context
            ? {
                classListBefore: m.context.classListBefore.slice(),
                classListAfter: m.context.classListAfter.slice(),
                inlineStyleBefore: { ...m.context.inlineStyleBefore },
                inlineStyleAfter: { ...m.context.inlineStyleAfter },
                computedStyleDelta: { ...m.context.computedStyleDelta },
                domSnippet: m.context.domSnippet,
                siblingClasses: m.context.siblingClasses.slice(),
              }
            : undefined,
          disambiguationChoice: m.disambiguationChoice,
        })),
      },
    }
  } else if (edit.kind === 'detach') {
    const editTarget = edit.target.editTarget
    if (!editTarget) {
      return {
        ok: false,
        result: {
          kind: 'failed',
          reason:
            'DetachEdit requires target.editTarget; the call-site element must carry data-desde-src',
        },
      }
    }
    if (!edit.target.componentName) {
      return {
        ok: false,
        result: { kind: 'failed', reason: 'DetachEdit requires target.componentName' },
      }
    }
    requestBody = {
      edit: {
        kind: 'detach',
        file: editTarget.file,
        line: editTarget.line,
        column: editTarget.column,
        componentFile: edit.componentFile,
        componentName: edit.target.componentName,
        // Stale-target guard — same capture as PropEdit above. Guards the
        // CONSUMER file (which carries the call-site coordinates); the
        // component file is read wholesale, not coordinate-matched.
        ...(editTarget.fileHash ? { baseHash: editTarget.fileHash } : {}),
      },
    }
  } else if (edit.kind === 'swap') {
    const editTarget = edit.target.editTarget
    if (!editTarget) {
      return {
        ok: false,
        result: {
          kind: 'failed',
          reason:
            'SwapEdit requires target.editTarget; the call-site element must carry data-desde-src',
        },
      }
    }
    requestBody = {
      edit: {
        kind: 'swap',
        file: editTarget.file,
        line: editTarget.line,
        column: editTarget.column,
        fromComponentName: edit.fromComponentName,
        toComponentName: edit.toComponentName,
        ...(edit.propMapping ? { propMapping: { ...edit.propMapping } } : {}),
        ...(edit.newComponentRequiredProps
          ? {
              newComponentRequiredProps: edit.newComponentRequiredProps.slice(),
            }
          : {}),
        ...(edit.toPackageName ? { toPackageName: edit.toPackageName } : {}),
        ...(edit.toFile ? { toFile: edit.toFile } : {}),
        ...(edit.removeFromImport ? { removeFromImport: true } : {}),
        // Stale-target guard — see PropEdit above.
        ...(editTarget.fileHash ? { baseHash: editTarget.fileHash } : {}),
      },
    }
  } else if (edit.kind === 'delete') {
    // 'definition' (default) rewrites the element's own SFC at its
    // `authoredAt` — affects every instance. 'callsite' rewrites the
    // parent template at its `editTarget`, deleting just the
    // enclosing component usage. Same single-file applicator either
    // way; we only choose which file/line/column to send.
    const scope = edit.scope ?? 'definition'
    const location =
      scope === 'callsite'
        ? edit.target.editTarget
        : edit.target.authoredAt
    if (!location) {
      return {
        ok: false,
        result: {
          kind: 'failed',
          reason:
            scope === 'callsite'
              ? "callsite-scoped DeleteEdit requires target.editTarget; the element isn't inside a reused component"
              : 'DeleteEdit requires target.authoredAt; the element must carry data-desde-src',
        },
      }
    }
    // Defense in depth — the modal and the panel toggle both gate on this,
    // but refuse here too so an agent-generated edit can't splice
    // node_modules.
    if (!deleteScopeAvailability(edit.target)[scope]) {
      return {
        ok: false,
        result: {
          kind: 'failed',
          reason: `Refusing a ${scope}-scoped delete in library source (${location.file}); editor never rewrites node_modules`,
        },
      }
    }
    requestBody = {
      edit: {
        kind: 'delete',
        file: location.file,
        line: location.line,
        column: location.column,
        // Stale-target guard — the stamp must come from the SAME location the
        // coordinates did (editTarget for 'callsite', authoredAt for
        // 'definition'), never a fixed one. Note the bridge stamps `fileHash`
        // on `editTarget` only, so a definition-scoped delete carries no hash
        // today and the server guard stays inert for it (conditional-on-
        // present) rather than guarding the wrong file.
        ...(location.fileHash ? { baseHash: location.fileHash } : {}),
      },
    }
  } else if (edit.kind === 'insert') {
    // For Insert, target IS the destination parent. Same convention
    // as Detach (target carries the call site) — saves having to
    // teach the wire format about an InsertionTarget shape.
    const editTarget = edit.target.editTarget
    if (!editTarget) {
      return {
        ok: false,
        result: {
          kind: 'failed',
          reason:
            'InsertEdit requires target.editTarget; the destination parent must carry data-desde-src',
        },
      }
    }
    requestBody = {
      edit: {
        kind: 'insert',
        file: editTarget.file,
        line: editTarget.line,
        column: editTarget.column,
        destIndex: edit.destIndex,
        snippet: edit.snippet,
        ...(edit.contentKind ? { contentKind: edit.contentKind } : {}),
      },
    }
  } else if (edit.kind === 'overwrite') {
    // Tier 2 commit shape — carries the full file body verbatim. The
    // server compile-checks AND verifies edit.baseHash matches the
    // current on-disk hash before writing (Phase E external-edit
    // guard for the overwrite lane). No editTarget needed.
    requestBody = {
      edit: {
        kind: 'overwrite',
        file: edit.file,
        newSource: edit.newSource,
        ...(edit.baseHash ? { baseHash: edit.baseHash } : {}),
        ...(edit.allowCreate ? { allowCreate: true } : {}),
      },
    }
  } else if (edit.kind === 'unwrap') {
    const editTarget = edit.target.editTarget
    if (!editTarget) {
      return {
        ok: false,
        result: {
          kind: 'failed',
          reason:
            'UnwrapEdit requires target.editTarget; the wrapper element must carry data-desde-src',
        },
      }
    }
    requestBody = {
      edit: {
        kind: 'unwrap',
        file: editTarget.file,
        line: editTarget.line,
        column: editTarget.column,
        // Stale-target guard — see PropEdit above.
        ...(editTarget.fileHash ? { baseHash: editTarget.fileHash } : {}),
      },
    }
  } else if (edit.kind === 'flatten-conditional') {
    const editTarget = edit.target.editTarget
    if (!editTarget) {
      return {
        ok: false,
        result: {
          kind: 'failed',
          reason:
            'FlattenConditionalEdit requires target.editTarget; the v-if chain root must carry data-desde-src',
        },
      }
    }
    requestBody = {
      edit: {
        kind: 'flatten-conditional',
        file: editTarget.file,
        line: editTarget.line,
        column: editTarget.column,
        branchToKeep: edit.branchToKeep,
        // Stale-target guard — see PropEdit above.
        ...(editTarget.fileHash ? { baseHash: editTarget.fileHash } : {}),
      },
    }
  } else if (edit.kind === 'scoped-css-override') {
    // TWO coordinates, deliberately not one (`tasks/dev-server-hosts.md`
    // § 9g.8): `target.editTarget` is the DESTINATION file the rule is
    // written into (a `.vue`'s `<style scoped>`, or a project `.css`);
    // `edit.anchor` is the rendered `data-desde-src` the rule HEAD names. They
    // coincide on Vue and diverge on React.
    const editTarget = edit.target.editTarget
    if (!editTarget) {
      return {
        ok: false,
        result: {
          kind: 'failed',
          reason:
            'ScopedCssOverrideEdit requires target.editTarget; it names the file the override rule is written into',
        },
      }
    }
    if (!edit.anchor || !edit.anchor.file) {
      return {
        ok: false,
        result: {
          kind: 'failed',
          reason:
            'ScopedCssOverrideEdit requires an anchor read off the rendered DOM (data-desde-src); without one the rule would match nothing',
        },
      }
    }
    requestBody = {
      edit: {
        kind: 'scoped-css-override',
        file: editTarget.file,
        line: editTarget.line,
        column: editTarget.column,
        anchorFile: edit.anchor.file,
        anchorLine: edit.anchor.line,
        anchorColumn: edit.anchor.column,
        ...(edit.anchor.version ? { anchorVersion: edit.anchor.version } : {}),
        deepSelector: edit.deepSelector,
        applyClasses: edit.applyClasses,
        declarations: edit.declarations,
      },
    }
  } else if (edit.kind === 'jsx-style') {
    // React/JSX inline styling. target = the styled element itself (carries
    // its own data-desde-src — JSX stamps every element, unlike the Vue
    // scoped-override case where only the call-site ancestor is tagged). The
    // applicator edits the element's className / style attribute in place.
    const editTarget = edit.target.editTarget
    if (!editTarget) {
      return {
        ok: false,
        result: {
          kind: 'failed',
          reason:
            'JsxStyleEdit requires target.editTarget; the styled element must carry data-desde-src',
        },
      }
    }
    requestBody = {
      edit: {
        kind: 'jsx-style',
        file: editTarget.file,
        line: editTarget.line,
        column: editTarget.column,
        mode: edit.mode,
        ...(edit.addClasses ? { addClasses: edit.addClasses } : {}),
        ...(edit.removeClasses ? { removeClasses: edit.removeClasses } : {}),
        ...(edit.declarations ? { declarations: edit.declarations } : {}),
        ...(edit.removeDeclarations
          ? { removeDeclarations: edit.removeDeclarations }
          : {}),
      },
    }
  } else if (edit.kind === 'text-branch') {
    // text-branch is byte-range based — the inspector's detector hands
    // us (file, byteStart, byteEnd) already; no need to derive from
    // editTarget. Wire-shape matches `TextBranchEditBody` in
    // validate-edit-request.ts.
    requestBody = {
      edit: {
        kind: 'text-branch',
        file: edit.file,
        byteStart: edit.byteStart,
        byteEnd: edit.byteEnd,
        valueKind: edit.valueKind,
        newValue: edit.newValue,
      },
    }
  } else if (edit.kind === 'token-value') {
    // token-value carries its own file (the token CSS file) + the
    // declaration to patch — no editTarget derivation. Wire-shape matches
    // `TokenValueEditBody` in validate-edit-request.ts.
    requestBody = {
      edit: {
        kind: 'token-value',
        file: edit.file,
        tokenName: edit.tokenName,
        newValue: edit.newValue,
        ...(edit.selector ? { selector: edit.selector } : {}),
      },
    }
  } else {
    return {
      ok: false,
      result: {
        kind: 'failed',
        reason: `BridgeFrameworkAdapter.applyEdit: edit kind "${edit.kind}" not implemented yet`,
      },
    }
  }

  // Task 4b: carry the client's own edit id as the wire-level
  // `correlationId`, on EVERY kind, from this one choke point rather than
  // repeating it at each `useEditorEditing.ts` dispatch site. `edit.id`
  // (`StructuralEditBase.id`) is already common to every `StructuralEdit`
  // variant — it's what the shell's undo/redo history stack correlates on
  // — so it's also the natural join key back from a ledger row to the
  // in-flight verification record the shell keeps under this same id (see
  // `useEditorEditing.ts`'s `verifyEditRef.current({ editId: edit.id, ... })`
  // call sites). The server records it verbatim and never interprets it.
  return {
    ok: true,
    requestBody: { ...requestBody, correlationId: edit.id } as Record<string, unknown>,
  }
}
