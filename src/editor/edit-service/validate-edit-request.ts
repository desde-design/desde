/**
 * Shared validator for editor edit requests. Used by the CLI edit
 * handler at `editor-cli/src/server/edit-handler.ts`.
 *
 * Single source of truth for edit request validation: returning the same
 * error string from the same malformed body keeps the client (the
 * framework adapter) seeing consistent failures regardless of transport.
 * Keep all edit validation here.
 *
 * Pure (no I/O); safe to import from server, CLI, and tests.
 */

export interface PropEditBody {
  kind: "prop"
  file: string
  line: number
  column: number
  propName: string
  value: string | number | boolean
  /**
   * Where to send the edit when the deterministic applicator refuses with
   * a `PropEditFallbackHint` (bound-binding / v-model / dynamic-vbind) AND
   * the in-process source-aware LLM lane also refuses. `'patch'` (or absent)
   * surfaces the combined refusal to the client. `'chat'` makes the server
   * additionally signal `needsChat` so the client hands the edit to the
   * chat agent (which has multi-file tool access).
   */
  llmFallback?: "patch" | "chat"
  /**
   * Stale-target guard (WS1, tasks/edit-pipeline-rearchitecture.md): the
   * per-file source-version hash (`data-desde-v` stamp) captured together
   * with the coordinates from the same DOM snapshot. When present, the
   * handler compares it against the current on-disk file and refuses 409
   * `stale-target` on mismatch — the coordinates provably predate the
   * file's current bytes, so splicing could hit the wrong element.
   */
  baseHash?: string
}

export interface MoveEditBody {
  kind: "move"
  file: string
  line: number
  column: number
  destFile: string
  destParentLine: number
  destParentColumn: number
  destIndex: number
  /** Stale-target guard for `file` — see {@link PropEditBody.baseHash}. */
  baseHash?: string
  /** Stale-target guard for `destFile` (cross-file moves refuse client-side
   *  today, but the field keeps the wire shape honest if that changes). */
  destBaseHash?: string
  /** Conditional-GROUP move — see ApplyMoveEditInput.moveGroup. Vue only. */
  moveGroup?: boolean
}

export interface DetachEditBody {
  kind: "detach"
  file: string
  line: number
  column: number
  componentFile: string
  componentName: string
  /**
   * Stale-target guard for the CONSUMER file (`file`, which carries the
   * call-site coordinates) — see {@link PropEditBody.baseHash}. The component
   * file is read wholesale rather than coordinate-matched, so it needs no
   * stamp.
   */
  baseHash?: string
}

export interface SwapEditBody {
  kind: "swap"
  file: string
  line: number
  column: number
  fromComponentName: string
  toComponentName: string
  propMapping?: Record<string, string | null>
  newComponentRequiredProps?: string[]
  toPackageName?: string
  toFile?: string
  removeFromImport?: boolean
  /** Stale-target guard for `file` — see {@link PropEditBody.baseHash}. */
  baseHash?: string
}

export interface DeleteEditBody {
  kind: "delete"
  file: string
  line: number
  column: number
  /** Stale-target guard for `file` — see {@link PropEditBody.baseHash}. */
  baseHash?: string
}

export interface InsertEditBody {
  kind: "insert"
  file: string
  /**
   * Line/column point at the DESTINATION PARENT element (the
   * container the new node becomes a child of). Reusing the
   * `line`/`column` field names matches the structural-edit body
   * shape used by Move/Reorder.
   */
  line: number
  column: number
  /** Final 0-based index in the parent's element children. -1 = append. */
  destIndex: number
  /**
   * The payload to insert. For `contentKind:'element'` (default) a single
   * Vue element; for `contentKind:'text'` a plain text node. The applicator
   * validates per kind.
   */
  snippet: string
  /**
   * Whether `snippet` is a single element (default) or a plain text node.
   * Text mode inserts bare text into the destination container.
   */
  contentKind?: "element" | "text"
  /**
   * Optional: ensure the inserted component's import exists in
   * `<script setup>`. Set when inserting a design-system component
   * whose tag would otherwise be unresolved. Ignored for text content.
   */
  componentImport?: {
    name: string
    importPath: string
    named?: boolean
  }
}

/**
 * Tier 2 "commit an LLM repair" body shape. Carries the proposed source
 * verbatim; the server compile-checks and writes. No line/column —
 * this isn't a structural splice, it's a full-file replacement.
 *
 * `baseHash` is the SHA-256 hex of the on-disk source AT THE TIME the
 * LLM proposal was generated. The save endpoint re-hashes current disk
 * contents and returns 409 on mismatch — Phase E external-edit guard
 * for the overwrite lane.
 */
export interface OverwriteEditBody {
  kind: "overwrite"
  file: string
  newSource: string
  baseHash?: string
  /**
   * Phase 4 — create the file if it doesn't exist. Defaults to false
   * (the historical behavior: refuse with "file not found" for absent
   * paths). Only `propose_new_file` sets this to `true`.
   */
  allowCreate?: boolean
}

export interface UnwrapEditBody {
  kind: "unwrap"
  file: string
  /** Wrapper element location (1-based, SFC-absolute). */
  line: number
  column: number
  /** Stale-target guard for `file` — see {@link PropEditBody.baseHash}. */
  baseHash?: string
}

export interface FlattenConditionalEditBody {
  kind: "flatten-conditional"
  file: string
  /** Chain root (v-if element) location (1-based, SFC-absolute). */
  line: number
  column: number
  /** 0 = v-if; 1..n = Nth v-else-if; "else" = v-else. */
  branchToKeep: number | "else"
  /** Stale-target guard for `file` — see {@link PropEditBody.baseHash}. */
  baseHash?: string
}

export interface ScopedCssOverrideEditBody {
  kind: "scoped-css-override"
  /**
   * The DESTINATION file the rule is written into — a `.vue` (its
   * `<style scoped>` block) or a `.css` (a managed block at EOF). This is the
   * only path the handler resolves, so every traversal/symlink/root guard
   * applies to it unchanged.
   *
   * NOT the anchor. See `anchorFile` — they coincide on Vue and diverge on
   * React, and treating `file` as both is what shipped a dead-rule defect
   * (`tasks/dev-server-hosts.md` § 9g.8).
   */
  file: string
  /**
   * Legacy alias for the anchor position, kept because `file`/`line`/`column`
   * were one triple before the anchor and the destination were separated.
   * When `anchorFile` is absent these are the anchor (Vue's old shape).
   */
  line: number
  column: number
  /**
   * The rendered `data-desde-src` coordinate the rule head is built from. Comes
   * from the bridge's `resolveDomAnchor` — the only source that is guaranteed
   * to name a value some element in the document actually carries. Absent ⇒
   * fall back to `file`/`line`/`column` (pre-split senders).
   */
  anchorFile?: string
  anchorLine?: number
  anchorColumn?: number
  /** `data-desde-v` content version of the anchor's file, when stamped. */
  anchorVersion?: string
  /**
   * Selector for the styled element RELATIVE to the anchor. Optional: omit
   * for the *direct* case (the anchor IS the styled element). On a `.vue`
   * destination it is wrapped in `:deep()` to pierce the scope boundary; on a
   * `.css` destination it is a plain descendant combinator.
   */
  deepSelector?: string
  /** Tailwind utility classes for @apply (`.vue` destinations only). */
  applyClasses?: string[]
  /** Raw CSS declarations. */
  declarations?: Record<string, string>
}

/**
 * React/JSX inline styling edit — the `.tsx`/`.jsx` analog of
 * {@link ScopedCssOverrideEditBody}. `mode` selects the output shape (the shell
 * picks it from the detected styling system). Powered by `apply-jsx-style-edit.ts`.
 */
export interface JsxStyleEditBody {
  kind: "jsx-style"
  file: string
  /** Styled element location (Babel coords: 1-based line, 0-based column). */
  line: number
  column: number
  mode: "classname" | "inline"
  /** `classname` mode. */
  addClasses?: string[]
  removeClasses?: string[]
  /** `inline` mode (kebab-case property → value / property list). */
  declarations?: Record<string, string>
  removeDeclarations?: string[]
}

/**
 * Wire-format mutation. Mirrors `Mutation` in `src/editor/core/edit.ts`,
 * with all string-typed fields explicit so the validator can shape-check
 * without importing the editor types into the validation module
 * (validator is shared with `editor-cli`, which doesn't necessarily
 * link the editor package).
 */
export interface LLMPatchMutationBody {
  id: string
  kind: "text" | "attr" | "class" | "style"
  sourceLoc: string | null
  /**
   * Stale-target guard (WS1): per-file `data-desde-v` hash captured with
   * `sourceLoc`'s coordinates from the same DOM snapshot. The handler
   * compares it against the file's current content (prefix match — the
   * stamp is a SHA-256 prefix) and refuses 409 on mismatch.
   */
  sourceVersion?: string | null
  resolutionKind: "direct" | "ancestor" | "none"
  scope: "definition" | "callsite" | "unknown"
  callsiteLoc: string | null
  /** Stale-target guard for `callsiteLoc`'s file — see `sourceVersion`. */
  callsiteVersion?: string | null
  instancePath: string
  selector: string
  target?: string
  before: string
  after: string
  context?: unknown
  disambiguationChoice?: "this-instance" | "all-instances"
}

/**
 * LLM-patch request: a bundle of mutations spanning N files. Distinct
 * shape from the single-file edit kinds — `file`/`line`/`column` are
 * absent because the bundle's files are derived from the mutations'
 * sourceLocs.
 *
 * `baseHashes` is the optional Phase E external-edit guard: if the
 * shell saved this file before, it includes the post-write hash it
 * received last time. The route re-hashes the file pre-write; on
 * mismatch it returns a conflict error so we don't silently overwrite
 * an engineer's IDE-side edits made between the designer's saves.
 * Map key is the SFC path relative to the prototype root; value is a
 * SHA-256 hex string.
 */
export interface LLMPatchEditBody {
  kind: "llm-patch"
  mutations: LLMPatchMutationBody[]
  baseHashes?: Record<string, string>
  /**
   * Where to send the edit when the deterministic lane can't apply it.
   * `'patch'` (or absent) runs the in-request LLM patch lane (legacy
   * modal behavior). `'chat'` makes the server stop at the deterministic
   * boundary and return `needsChat` so the client hands it to the chat
   * agent.
   */
  llmFallback?: "patch" | "chat"
}

/**
 * Edit one branch of a `{{ test ? a : b }}` Vue interpolation. Powered
 * by {@link applyTextBranchEdit}. Shape-distinct from line/column-based
 * edits — the branch is identified by its SFC-absolute byte range
 * (computed once by the detector when the inspector loads the
 * conditional-text section).
 */
export interface TextBranchEditBody {
  kind: "text-branch"
  file: string
  byteStart: number
  byteEnd: number
  valueKind: "literal" | "bound"
  newValue: string
}

/**
 * Token-value edit ("The token" scope). Shape-distinct: a CSS token FILE
 * (`.css`, first-party), a custom-property name, the new value, and the winning
 * definition's selector. No line/column — the applicator locates by name.
 */
export interface TokenValueEditBody {
  kind: "token-value"
  file: string
  tokenName: string
  newValue: string
  selector?: string
}

export interface EditRequestBody {
  edit:
    | PropEditBody
    | MoveEditBody
    | DetachEditBody
    | SwapEditBody
    | DeleteEditBody
    | InsertEditBody
    | UnwrapEditBody
    | FlattenConditionalEditBody
    | OverwriteEditBody
    | ScopedCssOverrideEditBody
    | JsxStyleEditBody
    | LLMPatchEditBody
    | TextBranchEditBody
    | TokenValueEditBody
  /**
   * Opaque client-chosen join key (Task 4b, `docs/superpowers/plans/2026-08-19-activity-panel.md`).
   * The client's own edit id (`StructuralEditBase.id`, see
   * `build-edit-request.ts`) — carried through to this write's ledger
   * entry verbatim, so `GET /api/editor/ledger` can hand it back and the
   * Activity panel can join a row to the client's own verification record
   * by this value instead of the server-minted ledger row id (which the
   * client never sees and cannot know ahead of time).
   *
   * The server never reads or branches on this value — it is recorded,
   * not interpreted. Absent for any caller that doesn't send one (an
   * older client, the chat/SDK-tool write lanes) — that row simply has no
   * join key, same as if this field didn't exist.
   */
  correlationId?: string
}

/**
 * Prop / attribute name accepted by the Vue prop applicator. Splicing an
 * unvalidated name into an SFC start tag would let arbitrary markup in.
 * Moved here from the CLI edit handler (audit Task 23) so every shape AND
 * identifier check for a request lives behind one call — the handler no
 * longer runs a second, easily-forgotten validation pass of its own.
 */
const VUE_PROP_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/
/** Component name accepted by the detach / swap applicators (PascalCase tag). */
const VUE_COMPONENT_NAME_RE = /^[A-Z][A-Za-z0-9_]*$/

/**
 * The shared `baseHash` shape check. Every coordinate-matched kind may carry
 * the `data-desde-v` stamp captured with its coordinates; the handler's
 * stale-target guard compares it against the on-disk file (audit Task 23
 * widened that guard from prop/move to every such kind).
 */
function baseHashShapeError(
  value: unknown,
  field: "baseHash" | "destBaseHash",
): string | null {
  if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
    return `edit.${field} must be a non-empty string when provided`
  }
  return null
}

/**
 * Validate an edit request body: its SHAPE and its identifier names.
 *
 * Returns null if valid, or an error string suitable for the response
 * `reason` field. Each kind's checks run in a single branch below, so the
 * error a malformed body produces is stable and testable.
 *
 * NB: this does NOT check filesystem paths — path traversal, symlink
 * resolution, and the per-lane extension gate live in the caller because they
 * need the transport's notion of the prototype root.
 */
export function validateEditRequest(body: unknown): string | null {
  if (!body || typeof body !== "object") return "Body must be an object"
  // Shape-checked once, up front, for every edit kind — `correlationId` is
  // a sibling of `edit`, not part of it, so it must not be validated
  // inside any of the per-kind branches below (which all return early on
  // `edit`'s own shape errors before ever reaching a shared check).
  const correlationId = (body as { correlationId?: unknown }).correlationId
  if (
    correlationId !== undefined &&
    (typeof correlationId !== "string" ||
      correlationId.length === 0 ||
      correlationId.length > 200)
  ) {
    return "correlationId must be a non-empty string of at most 200 characters when provided"
  }
  const edit = (body as { edit?: unknown }).edit
  if (!edit || typeof edit !== "object") return "Body.edit must be an object"
  const e = edit as Record<string, unknown>
  const kind = e.kind
  if (
    kind !== "prop" &&
    kind !== "move" &&
    kind !== "detach" &&
    kind !== "swap" &&
    kind !== "delete" &&
    kind !== "insert" &&
    kind !== "unwrap" &&
    kind !== "flatten-conditional" &&
    kind !== "overwrite" &&
    kind !== "scoped-css-override" &&
    kind !== "jsx-style" &&
    kind !== "llm-patch" &&
    kind !== "text-branch" &&
    kind !== "token-value"
  ) {
    return 'edit.kind must be "prop" | "move" | "detach" | "swap" | "delete" | "insert" | "unwrap" | "flatten-conditional" | "overwrite" | "scoped-css-override" | "jsx-style" | "llm-patch" | "text-branch" | "token-value"'
  }

  // llm-patch is shape-distinct: no file/line/column, just `mutations[]`.
  if (kind === "llm-patch") {
    return validateLLMPatchBody(e)
  }

  // text-branch is shape-distinct: file + byteStart/byteEnd + value
  // metadata; no line/column.
  if (kind === "text-branch") {
    if (typeof e.file !== "string" || e.file.length === 0) return "edit.file required"
    if (
      typeof e.byteStart !== "number" ||
      !Number.isInteger(e.byteStart) ||
      e.byteStart < 0
    ) {
      return "edit.byteStart must be a non-negative integer"
    }
    if (
      typeof e.byteEnd !== "number" ||
      !Number.isInteger(e.byteEnd) ||
      e.byteEnd < e.byteStart
    ) {
      return "edit.byteEnd must be an integer ≥ byteStart"
    }
    if (e.valueKind !== "literal" && e.valueKind !== "bound") {
      return 'edit.valueKind must be "literal" or "bound"'
    }
    if (typeof e.newValue !== "string") {
      return "edit.newValue must be a string"
    }
    return null
  }

  // token-value is shape-distinct: file + tokenName + newValue (+ selector).
  if (kind === "token-value") {
    if (typeof e.file !== "string" || e.file.length === 0) return "edit.file required"
    if (
      typeof e.tokenName !== "string" ||
      !e.tokenName.startsWith("--")
    ) {
      return "edit.tokenName must be a custom property (starting with --)"
    }
    if (typeof e.newValue !== "string" || e.newValue.length === 0) {
      return "edit.newValue must be a non-empty string"
    }
    if (e.selector !== undefined && typeof e.selector !== "string") {
      return "edit.selector must be a string when provided"
    }
    return null
  }

  // overwrite is shape-distinct: file + newSource, no line/column.
  if (kind === "overwrite") {
    if (typeof e.file !== "string" || e.file.length === 0) return "edit.file required"
    if (typeof e.newSource !== "string" || e.newSource.length === 0) {
      return "edit.newSource required (and must be non-empty)"
    }
    if (e.baseHash !== undefined && (typeof e.baseHash !== "string" || e.baseHash.length === 0)) {
      return "edit.baseHash must be a non-empty string when provided"
    }
    if (e.allowCreate !== undefined && typeof e.allowCreate !== "boolean") {
      return "edit.allowCreate must be a boolean when provided"
    }
    if (e.allowCreate === true && e.baseHash !== undefined) {
      // Defense in depth: an allowCreate must not also carry a
      // baseHash (the file is new — there's nothing to compare).
      return "edit.allowCreate and edit.baseHash are mutually exclusive"
    }
    return null
  }

  if (typeof e.file !== "string" || e.file.length === 0) return "edit.file required"
  if (typeof e.line !== "number" || !Number.isInteger(e.line) || e.line < 1) {
    return "edit.line must be a positive integer"
  }
  // Column 0 is valid for React/JSX: Babel reports 0-based columns, which the
  // JSX source-tag plugin stamps and apply-jsx-prop-edit matches. Vue's columns
  // are 1-based so a 0 never legitimately occurs there (and a stray 0 would just
  // no-match in the applicator). Lines are 1-based in both. (codex P2)
  if (typeof e.column !== "number" || !Number.isInteger(e.column) || e.column < 0) {
    return "edit.column must be a non-negative integer"
  }
  if (kind === "prop") {
    if (typeof e.propName !== "string" || e.propName.length === 0) {
      return "edit.propName required"
    }
    const v = e.value
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
      return "edit.value must be string | number | boolean (V1.3)"
    }
    if (
      e.llmFallback !== undefined &&
      e.llmFallback !== "patch" &&
      e.llmFallback !== "chat"
    ) {
      return 'edit.llmFallback must be "patch" or "chat" when provided'
    }
    const hashErr = baseHashShapeError(e.baseHash, "baseHash")
    if (hashErr) return hashErr
    // Identifier guard (moved from the CLI edit handler, audit Task 23). Runs
    // LAST in this branch so the error a body failing several prop checks
    // produces is unchanged from when the handler ran it after the whole
    // validator.
    if (!VUE_PROP_NAME_RE.test(e.propName)) {
      return "propName must match /^[A-Za-z_][A-Za-z0-9_-]*$/"
    }
  } else if (kind === "detach") {
    if (typeof e.componentFile !== "string" || e.componentFile.length === 0) {
      return "edit.componentFile required for detach"
    }
    if (typeof e.componentName !== "string" || e.componentName.length === 0) {
      return "edit.componentName required for detach"
    }
    const hashErr = baseHashShapeError(e.baseHash, "baseHash")
    if (hashErr) return hashErr
    if (!VUE_COMPONENT_NAME_RE.test(e.componentName)) {
      return "componentName must match /^[A-Z][A-Za-z0-9_]*$/"
    }
  } else if (kind === "swap") {
    if (
      typeof e.fromComponentName !== "string" ||
      e.fromComponentName.length === 0
    ) {
      return "edit.fromComponentName required for swap"
    }
    if (
      typeof e.toComponentName !== "string" ||
      e.toComponentName.length === 0
    ) {
      return "edit.toComponentName required for swap"
    }
    if (e.propMapping !== undefined) {
      if (
        e.propMapping === null ||
        typeof e.propMapping !== "object" ||
        Array.isArray(e.propMapping)
      ) {
        return "edit.propMapping must be an object when provided"
      }
      for (const [k, v] of Object.entries(
        e.propMapping as Record<string, unknown>,
      )) {
        if (typeof k !== "string" || k.length === 0) {
          return "edit.propMapping keys must be non-empty strings"
        }
        if (v !== null && typeof v !== "string") {
          return `edit.propMapping['${k}'] must be string | null`
        }
      }
    }
    if (e.newComponentRequiredProps !== undefined) {
      if (!Array.isArray(e.newComponentRequiredProps)) {
        return "edit.newComponentRequiredProps must be an array"
      }
      for (const v of e.newComponentRequiredProps as unknown[]) {
        if (typeof v !== "string") {
          return "edit.newComponentRequiredProps must contain strings only"
        }
      }
    }
    if (
      e.toPackageName !== undefined &&
      (typeof e.toPackageName !== "string" || e.toPackageName.length === 0)
    ) {
      return "edit.toPackageName must be a non-empty string when provided"
    }
    if (
      e.toFile !== undefined &&
      (typeof e.toFile !== "string" || e.toFile.length === 0)
    ) {
      return "edit.toFile must be a non-empty string when provided"
    }
    if (e.toPackageName && e.toFile) {
      return "edit.toPackageName and edit.toFile are mutually exclusive"
    }
    if (
      e.removeFromImport !== undefined &&
      typeof e.removeFromImport !== "boolean"
    ) {
      return "edit.removeFromImport must be a boolean when provided"
    }
    const hashErr = baseHashShapeError(e.baseHash, "baseHash")
    if (hashErr) return hashErr
    if (!VUE_COMPONENT_NAME_RE.test(e.fromComponentName)) {
      return "fromComponentName must match /^[A-Z][A-Za-z0-9_]*$/"
    }
    if (!VUE_COMPONENT_NAME_RE.test(e.toComponentName)) {
      return "toComponentName must match /^[A-Z][A-Za-z0-9_]*$/"
    }
  } else if (kind === "delete") {
    // No additional fields beyond file/line/column + the stale-target stamp.
    const hashErr = baseHashShapeError(e.baseHash, "baseHash")
    if (hashErr) return hashErr
  } else if (kind === "insert") {
    if (typeof e.snippet !== "string" || e.snippet.length === 0) {
      return "edit.snippet required for insert"
    }
    if (typeof e.destIndex !== "number" || !Number.isInteger(e.destIndex)) {
      return "edit.destIndex must be an integer"
    }
    if (
      e.contentKind !== undefined &&
      e.contentKind !== "element" &&
      e.contentKind !== "text"
    ) {
      return 'edit.contentKind must be "element" or "text" when provided'
    }
    if (e.componentImport !== undefined) {
      const ci = e.componentImport
      if (typeof ci !== "object" || ci === null) {
        return "edit.componentImport must be an object when provided"
      }
      const c = ci as Record<string, unknown>
      if (typeof c.name !== "string" || c.name.length === 0) {
        return "edit.componentImport.name required"
      }
      // name is interpolated into an `import` clause — must be a bare JS
      // identifier or the applicator would write invalid <script setup>.
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(c.name)) {
        return "edit.componentImport.name must be a valid JS identifier"
      }
      if (typeof c.importPath !== "string" || c.importPath.length === 0) {
        return "edit.componentImport.importPath required"
      }
      // importPath sits inside a single-quoted string literal — reject
      // quotes / backslashes / line terminators that would break it.
      if (/['"\\\n\r\u2028\u2029\0]/.test(c.importPath)) {
        return "edit.componentImport.importPath contains characters that are not allowed in a module specifier"
      }
      if (c.named !== undefined && typeof c.named !== "boolean") {
        return "edit.componentImport.named must be a boolean when provided"
      }
    }
  } else if (kind === "unwrap") {
    // No additional fields beyond file/line/column + the stale-target stamp.
    const hashErr = baseHashShapeError(e.baseHash, "baseHash")
    if (hashErr) return hashErr
  } else if (kind === "flatten-conditional") {
    const b = e.branchToKeep
    const isValidIndex = typeof b === "number" && Number.isInteger(b) && b >= 0
    const isElse = b === "else"
    if (!isValidIndex && !isElse) {
      return 'edit.branchToKeep must be a non-negative integer or "else"'
    }
    const hashErr = baseHashShapeError(e.baseHash, "baseHash")
    if (hashErr) return hashErr
  } else if (kind === "scoped-css-override") {
    // deepSelector is OPTIONAL: present for ancestor overrides (the
    // rule needs `:deep()` to pierce a library scope and reach an inner
    // element), absent for direct overrides (the call-site itself is
    // the styled element — the rule applies on `.scopeClass` alone).
    if (
      e.deepSelector !== undefined &&
      e.deepSelector !== null &&
      typeof e.deepSelector !== "string"
    ) {
      return "edit.deepSelector must be a string when provided"
    }
    // The anchor is separate from the destination (§ 9g.8 item 1). It is
    // all-or-nothing: a partial triple would silently mix the anchor's file
    // with the destination's line, which is the class of confusion the split
    // exists to end.
    const anchorParts = [e.anchorFile, e.anchorLine, e.anchorColumn]
    const anchorPresent = anchorParts.filter((v) => v !== undefined).length
    if (anchorPresent !== 0 && anchorPresent !== 3) {
      return "edit.anchorFile, edit.anchorLine and edit.anchorColumn must be provided together"
    }
    if (anchorPresent === 3) {
      if (typeof e.anchorFile !== "string" || e.anchorFile.length === 0) {
        return "edit.anchorFile must be a non-empty string"
      }
      if (!Number.isInteger(e.anchorLine) || (e.anchorLine as number) < 1) {
        return "edit.anchorLine must be a positive integer"
      }
      if (!Number.isInteger(e.anchorColumn) || (e.anchorColumn as number) < 1) {
        return "edit.anchorColumn must be a positive integer"
      }
    }
    if (e.anchorVersion !== undefined && typeof e.anchorVersion !== "string") {
      return "edit.anchorVersion must be a string when provided"
    }
    // A `.css` DESTINATION MUST CARRY ITS OWN ANCHOR.
    //
    // The absent-anchor fallback (`anchorFile ?? file`) exists for pre-split
    // senders, where the destination IS the anchor — true of a Vue SFC, which
    // holds both the callsite and the `<style scoped>` block. It is never true
    // of a `.css` destination: a stylesheet has no `data-desde-src` of its own, so
    // the fallback would emit `[data-desde-src="src/index.css:27:6"]` — a rule head
    // that CANNOT match anything, written to source and returned `ok: true`.
    //
    // That is the precise failure this whole split was made to end (§ 9g.8), so
    // it is closed by construction here rather than by the convention that every
    // shipped builder happens to set the anchor. Both do today; a third caller,
    // or an agent tool, would not have to.
    if (typeof e.file === "string" && e.file.endsWith(".css") && anchorPresent !== 3) {
      return (
        "edit.anchorFile, edit.anchorLine and edit.anchorColumn are required for a .css " +
        "destination: a stylesheet has no source position of its own to anchor the rule on"
      )
    }
    const hasApply =
      Array.isArray(e.applyClasses) && (e.applyClasses as unknown[]).length > 0
    const hasDeclarations =
      e.declarations !== undefined &&
      e.declarations !== null &&
      typeof e.declarations === "object" &&
      Object.keys(e.declarations as object).length > 0
    if (!hasApply && !hasDeclarations) {
      return "edit.applyClasses or edit.declarations required for scoped-css-override"
    }
  } else if (kind === "jsx-style") {
    if (e.mode !== "classname" && e.mode !== "inline") {
      return 'edit.mode must be "classname" or "inline" for jsx-style'
    }
    const strArray = (v: unknown): boolean =>
      Array.isArray(v) && v.every((x) => typeof x === "string")
    if (e.addClasses !== undefined && !strArray(e.addClasses)) {
      return "edit.addClasses must be a string[] when provided"
    }
    if (e.removeClasses !== undefined && !strArray(e.removeClasses)) {
      return "edit.removeClasses must be a string[] when provided"
    }
    if (e.removeDeclarations !== undefined && !strArray(e.removeDeclarations)) {
      return "edit.removeDeclarations must be a string[] when provided"
    }
    const declsOk =
      e.declarations === undefined ||
      (e.declarations !== null &&
        typeof e.declarations === "object" &&
        Object.values(e.declarations as object).every((v) => typeof v === "string"))
    if (!declsOk) {
      return "edit.declarations must be a Record<string,string> when provided"
    }
    if (e.mode === "classname") {
      const hasAdd = Array.isArray(e.addClasses) && (e.addClasses as unknown[]).length > 0
      const hasRemove =
        Array.isArray(e.removeClasses) && (e.removeClasses as unknown[]).length > 0
      if (!hasAdd && !hasRemove) {
        return "edit.addClasses or edit.removeClasses required for jsx-style classname mode"
      }
    } else {
      const hasSet =
        e.declarations !== undefined &&
        e.declarations !== null &&
        Object.keys(e.declarations as object).length > 0
      const hasRemove =
        Array.isArray(e.removeDeclarations) &&
        (e.removeDeclarations as unknown[]).length > 0
      if (!hasSet && !hasRemove) {
        return "edit.declarations or edit.removeDeclarations required for jsx-style inline mode"
      }
    }
  } else {
    if (typeof e.destFile !== "string" || e.destFile.length === 0) {
      return "edit.destFile required for move"
    }
    if (e.destFile !== e.file) {
      return "edit.destFile must equal edit.file (cross-file moves are V2)"
    }
    if (
      typeof e.destParentLine !== "number" ||
      !Number.isInteger(e.destParentLine) ||
      e.destParentLine < 1
    ) {
      return "edit.destParentLine must be a positive integer"
    }
    // Column 0 is valid for React/JSX (Babel reports 0-based columns); Vue is
    // 1-based so a 0 never legitimately occurs there. Mirrors the `e.column`
    // relaxation above. (React move dest parent.)
    if (
      typeof e.destParentColumn !== "number" ||
      !Number.isInteger(e.destParentColumn) ||
      e.destParentColumn < 0
    ) {
      return "edit.destParentColumn must be a non-negative integer"
    }
    if (typeof e.destIndex !== "number" || !Number.isInteger(e.destIndex)) {
      return "edit.destIndex must be an integer"
    }
    const hashErr = baseHashShapeError(e.baseHash, "baseHash")
    if (hashErr) return hashErr
    const destHashErr = baseHashShapeError(e.destBaseHash, "destBaseHash")
    if (destHashErr) return destHashErr
    if (e.moveGroup !== undefined && typeof e.moveGroup !== "boolean") {
      return "edit.moveGroup must be a boolean when provided"
    }
  }
  return null
}

const LLM_PATCH_MUTATION_KINDS = ["text", "attr", "class", "style"]
const LLM_PATCH_RESOLUTION_KINDS = ["direct", "ancestor", "none"]
const LLM_PATCH_SCOPES = ["definition", "callsite", "unknown"]
const LLM_PATCH_DISAMBIGUATION = ["this-instance", "all-instances"]

function validateLLMPatchBody(e: Record<string, unknown>): string | null {
  const mutations = e.mutations
  if (!Array.isArray(mutations)) return "edit.mutations must be an array"
  if (mutations.length === 0) return "edit.mutations must be non-empty"
  if (
    e.llmFallback !== undefined &&
    e.llmFallback !== "patch" &&
    e.llmFallback !== "chat"
  ) {
    return 'edit.llmFallback must be "patch" or "chat" when provided'
  }
  if (e.baseHashes !== undefined) {
    if (
      e.baseHashes === null ||
      typeof e.baseHashes !== "object" ||
      Array.isArray(e.baseHashes)
    ) {
      return "edit.baseHashes must be a string-valued object when provided"
    }
    for (const [k, v] of Object.entries(e.baseHashes as Record<string, unknown>)) {
      if (typeof k !== "string" || k.length === 0) {
        return "edit.baseHashes keys must be non-empty strings"
      }
      if (typeof v !== "string" || !/^[a-f0-9]{64}$/i.test(v)) {
        return `edit.baseHashes['${k}'] must be a 64-char hex SHA-256 hash`
      }
    }
  }
  for (let i = 0; i < mutations.length; i++) {
    const m = mutations[i]
    if (!m || typeof m !== "object") {
      return `edit.mutations[${i}] must be an object`
    }
    const mu = m as Record<string, unknown>
    if (typeof mu.id !== "string" || mu.id.length === 0) {
      return `edit.mutations[${i}].id required`
    }
    if (typeof mu.kind !== "string" || !LLM_PATCH_MUTATION_KINDS.includes(mu.kind)) {
      return `edit.mutations[${i}].kind must be one of ${LLM_PATCH_MUTATION_KINDS.join(" | ")}`
    }
    if (mu.sourceLoc !== null && typeof mu.sourceLoc !== "string") {
      return `edit.mutations[${i}].sourceLoc must be string | null`
    }
    if (
      mu.sourceVersion !== undefined &&
      mu.sourceVersion !== null &&
      typeof mu.sourceVersion !== "string"
    ) {
      return `edit.mutations[${i}].sourceVersion must be string | null when provided`
    }
    if (
      mu.callsiteVersion !== undefined &&
      mu.callsiteVersion !== null &&
      typeof mu.callsiteVersion !== "string"
    ) {
      return `edit.mutations[${i}].callsiteVersion must be string | null when provided`
    }
    if (
      typeof mu.resolutionKind !== "string" ||
      !LLM_PATCH_RESOLUTION_KINDS.includes(mu.resolutionKind)
    ) {
      return `edit.mutations[${i}].resolutionKind must be one of ${LLM_PATCH_RESOLUTION_KINDS.join(" | ")}`
    }
    if (typeof mu.scope !== "string" || !LLM_PATCH_SCOPES.includes(mu.scope)) {
      return `edit.mutations[${i}].scope must be one of ${LLM_PATCH_SCOPES.join(" | ")}`
    }
    if (mu.callsiteLoc !== null && typeof mu.callsiteLoc !== "string") {
      return `edit.mutations[${i}].callsiteLoc must be string | null`
    }
    if (typeof mu.instancePath !== "string") {
      return `edit.mutations[${i}].instancePath required`
    }
    if (typeof mu.selector !== "string") {
      return `edit.mutations[${i}].selector required`
    }
    if (mu.target !== undefined && typeof mu.target !== "string") {
      return `edit.mutations[${i}].target must be a string when present`
    }
    if (typeof mu.before !== "string") {
      return `edit.mutations[${i}].before must be a string`
    }
    if (typeof mu.after !== "string") {
      return `edit.mutations[${i}].after must be a string`
    }
    if (
      mu.disambiguationChoice !== undefined &&
      (typeof mu.disambiguationChoice !== "string" ||
        !LLM_PATCH_DISAMBIGUATION.includes(mu.disambiguationChoice))
    ) {
      return `edit.mutations[${i}].disambiguationChoice must be one of ${LLM_PATCH_DISAMBIGUATION.join(" | ")}`
    }
    if (mu.context !== undefined) {
      const ctxErr = validateMutationContext(mu.context, i)
      if (ctxErr) return ctxErr
    }
  }
  return null
}

function validateMutationContext(ctx: unknown, idx: number): string | null {
  if (!ctx || typeof ctx !== "object") {
    return `edit.mutations[${idx}].context must be an object when present`
  }
  const c = ctx as Record<string, unknown>
  for (const key of [
    "classListBefore",
    "classListAfter",
    "siblingClasses",
  ] as const) {
    if (!Array.isArray(c[key])) {
      return `edit.mutations[${idx}].context.${key} must be an array of strings`
    }
    for (const v of c[key] as unknown[]) {
      if (typeof v !== "string") {
        return `edit.mutations[${idx}].context.${key} must contain only strings`
      }
    }
  }
  for (const key of [
    "inlineStyleBefore",
    "inlineStyleAfter",
    "computedStyleDelta",
  ] as const) {
    if (!c[key] || typeof c[key] !== "object" || Array.isArray(c[key])) {
      return `edit.mutations[${idx}].context.${key} must be a string-valued object`
    }
    for (const v of Object.values(c[key] as Record<string, unknown>)) {
      if (typeof v !== "string") {
        return `edit.mutations[${idx}].context.${key} must have string values`
      }
    }
  }
  if (typeof c.domSnippet !== "string") {
    return `edit.mutations[${idx}].context.domSnippet must be a string`
  }
  return null
}
