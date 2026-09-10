/**
 * Pure style-edit builders for the direct-manipulation edit buffer in
 * `useEditorEditing` — extracted (share-readiness Phase 3 Batch B) from
 * three `useCallback`s that had stable (`[]`-rooted) deps but zero actual
 * React dependency: they only read module-level feature flags and call
 * other pure functions. Turning them into plain functions makes the
 * Tailwind-resolution + deep-selector logic unit-testable without mounting
 * the whole hook, and removes them from every consumer's dependency array
 * (a stable top-level import needs no entry).
 *
 * `buildScopedCssOverrideEdit` (Vue) and `buildJsxStyleEdit` (React) are
 * the two framework-specific builders; `buildStyleEdit` picks between them
 * per `EDITOR_FRAMEWORK`. The hook imports all three (plus the
 * `BuiltStyleEdit` shape and `isUnsupportedStyleBuild` guard) and calls
 * them directly in place of the old `useCallback`s.
 *
 * See tasks/share-readiness-plan.md.
 */

import type { Mutation, Selection, StructuralEdit } from "@/editor/core"
import {
  EDITOR_FRAMEWORK,
  EDITOR_STYLING_SYSTEM,
} from "@/lib/editor-feature-flags"
import {
  resolveTailwindClass,
  resolveTailwindClasses,
} from "@/components/editor/tailwind-declarations"
import { makeEditId } from "./make-edit-id"

/**
 * A style-edit build result. `null` = genuine no-op (skip). `{ unsupported }` =
 * the change can't be expressed on the current substrate (e.g. a non-Tailwind
 * React app where the inspector emits a utility — like `shadow-lg` — that has no
 * inline-CSS mapping). Surfacing it as a visible failure beats writing an inert
 * className or silently dropping the edit.
 */
export type BuiltStyleEdit = StructuralEdit | null | { unsupported: string }

export function isUnsupportedStyleBuild(
  e: BuiltStyleEdit,
): e is { unsupported: string } {
  return e !== null && "unsupported" in e
}

/**
 * Parse a `data-desde-src`-style location string (`file:line:column`)
 * into a SourceLocation. Returns null if the string is malformed.
 *
 * The format mirrors what `Mutation.sourceLoc` carries; we use this
 * shell-side to convert mutations into structural-edit targets.
 */
function parseSourceLoc(loc: string): {
  file: string
  line: number
  column: number
} | null {
  const lastColon = loc.lastIndexOf(":")
  if (lastColon < 0) return null
  const secondLast = loc.lastIndexOf(":", lastColon - 1)
  if (secondLast < 0) return null
  const file = loc.slice(0, secondLast)
  const lineStr = loc.slice(secondLast + 1, lastColon)
  const colStr = loc.slice(lastColon + 1)
  const line = parseInt(lineStr, 10)
  const column = parseInt(colStr, 10)
  if (!Number.isFinite(line) || !Number.isFinite(column) || file.length === 0) {
    return null
  }
  return { file, line, column }
}

/**
 * Pull added Tailwind classes out of a `class`-kind mutation by diffing
 * the after-list against the before-list.
 *
 * The DOM-edit-mode capture path attaches a structured `context` field;
 * shell-initiated edits (`SET_ELEMENT_CLASSES` from the inspector) flow
 * through `captureDirectMutation` without context — only the raw
 * `before`/`after` className strings. Without the fallback below, the
 * save dispatcher's scoped-css-override loop silently skipped every
 * mutation (`addedClassesFromMutation` returned `[]` whenever context
 * was missing), so the inspector's color/border/spacing edits looked
 * saved in the UI (thanks to the bridge's in-memory `!important`
 * styles) but never reached disk — the change reverted on refresh.
 */
function addedClassesFromMutation(m: Mutation): string[] {
  if (m.kind !== "class") return []
  const beforeList =
    m.context?.classListBefore ?? m.before.split(/\s+/).filter(Boolean)
  const afterList =
    m.context?.classListAfter ?? m.after.split(/\s+/).filter(Boolean)
  const beforeSet = new Set(beforeList)
  return afterList.filter((c) => !beforeSet.has(c))
}

/**
 * Classes the mutation REMOVED (before − after). The Vue scoped-css-override
 * lane is additive (its `!important` rule wins the cascade, so it ignores
 * removals), but the React `jsx-style` className lane EDITS the className string
 * in place — so it needs the removals to drop the old utility (e.g. clearing a
 * border). `tailwind-merge` also resolves the change-a-value case server-side,
 * but passing the precise removals keeps non-conflicting clears honest.
 */
function removedClassesFromMutation(m: Mutation): string[] {
  if (m.kind !== "class") return []
  const beforeList =
    m.context?.classListBefore ?? m.before.split(/\s+/).filter(Boolean)
  const afterList =
    m.context?.classListAfter ?? m.after.split(/\s+/).filter(Boolean)
  const afterSet = new Set(afterList)
  return beforeList.filter((c) => !afterSet.has(c))
}

/**
 * Build a `:deep()` selector from a full bridge selector (e.g.,
 * `body > div.app > div.card > div.card-header`). V1 uses the LAST
 * combinator-segment as the deep target — `.card-header` for the
 * example above. This is a heuristic that works well when the inner
 * element has a recognizable class; cases where it doesn't (deeply
 * nested unnamed divs) fall back to the tag.nth-of-type fragment.
 *
 * Future enhancement: walk the selector relative to the ancestor's
 * bridge-resolved DOM node so the deep selector is more specific
 * when needed. V1 trades precision for designer-friendliness.
 */
function deepSelectorFromMutationSelector(selector: string): string {
  if (!selector) return "*"
  // Split on CSS combinators with surrounding whitespace.
  const parts = selector.split(/\s*[>+~]\s*|\s+/).filter(Boolean)
  return parts[parts.length - 1] ?? "*"
}

/**
 * THE dead-rule guard, shared by every lane that emits a
 * `[data-desde-src="…"]` CSS rule.
 *
 * A CSS override is the one edit kind that can be written perfectly, into
 * the right file, and still do nothing: the applicator splices a rule whose
 * head names a coordinate, and if no element in the document carries that
 * coordinate the rule is inert. Nothing downstream can notice — the write
 * succeeds, the file parses, the server returns `ok: true`, and the designer
 * watches their change not happen. That is exactly what shipped
 * (`tasks/dev-server-hosts.md` § 9g.8).
 *
 * The bridge is the only party that can answer "does this match?", because
 * it is the only one holding the live DOM. So it counts, and this refuses.
 * Module-private on purpose: every lane that emits such a rule lives in this
 * file (Vue's two today, React's `data-desde-src` styling under § 9g next), so
 * the guard is reachable by all of them without becoming an export nothing
 * outside can justify importing.
 *
 * `undefined` is NOT zero. A count is a fact the bridge supplies; absent one
 * there is nothing to verify, and refusing would brick the lane instead of
 * protecting it.
 */
function deadAnchorRefusal(
  anchorLoc: string,
  matchCount: number | undefined,
): string | null {
  if (matchCount === undefined || matchCount > 0) return null
  return (
    `Can't style this element here: a \`[data-desde-src="${anchorLoc}"]\` rule ` +
    `matches nothing on the page, so it would be written to source and never ` +
    `render. Reselect the element and try again.`
  )
}

/**
 * The blast radius of an override, when it is bigger than one element.
 *
 * A `[data-desde-src="…"]` rule matches every element carrying that coordinate,
 * and how many that is depends on the substrate in a way no designer can see
 * from the page. On Vue it is usually one (each callsite gets its own stamp).
 * On React it is one for a THIRD-PARTY component — the consumer's callsite
 * stamp reaches the library's root through `{...rest}` — but can be N for a
 * FIRST-PARTY one, because the stamper also stamps the component's internal
 * root and that stamp wins the later-key-wins merge. So "restyle this card"
 * can mean "restyle every card", and the tool knew the number all along.
 *
 * MEASURED, `tasks/dev-server-hosts.md` § 9g.2: a first-party React shape
 * rendered twice has `matchCount 2` and one rule restyles both.
 *
 * **A LOWER BOUND, and the copy says so.** The count is taken against the
 * rendered DOM; the rule also applies wherever else that coordinate renders,
 * including routes that are not mounted. "At least N on this page" is the
 * honest phrasing; "N" would not be.
 */
export function blastRadiusNotice(
  matchCount: number | undefined,
): string | null {
  if (matchCount === undefined || matchCount <= 1) return null
  return (
    `Styled at least ${matchCount} elements on this page. They share one ` +
    `source position, so one rule covers all of them.`
  )
}

/**
 * Where a scoped override is written on this substrate, or why it can't be.
 *
 * Vue has a per-component stylesheet (`<style scoped>`) and the destination is
 * therefore the anchor's own file. React has nothing of the kind, so the rule
 * goes into a project stylesheet the page actually loads — resolved by
 * `resolveOverrideStylesheet` and passed in, because picking it needs the
 * document and this module is pure.
 */
export interface StyleEditDestinationOptions {
  /**
   * Prototype-root-relative `.css` the override block lives in. Required on a
   * substrate with no scoped-style block; ignored on Vue, where the
   * destination is dictated by the anchor.
   */
  overrideStylesheet?: string
}

interface OverrideDestination {
  file: string
  /**
   * Which dialect the applicator renders. `vue-sfc` is also the answer to
   * "is the destination derived from the selection?" — an SFC carries both
   * the callsite and the stylesheet, which is why several of this lane's
   * guards are Vue-shaped.
   */
  kind: "vue-sfc" | "css-file"
  /**
   * Whether `@apply` may appear in the rule body. Only inside a Vue SFC,
   * where the SFC's own style pipeline compiles it. A plain project `.css`
   * may or may not be Tailwind-processed, and an uncompiled `@apply` is a
   * rule that is present and inert — the failure this lane exists to end.
   */
  allowApply: boolean
}

function overrideDestination(
  anchorFile: string,
  opts: StyleEditDestinationOptions,
): OverrideDestination | { refused: string } {
  if (EDITOR_FRAMEWORK !== "react") {
    return { file: anchorFile, kind: "vue-sfc", allowApply: true }
  }
  if (!opts.overrideStylesheet) {
    return {
      refused:
        "No project stylesheet to write this override into. Create a CSS file (e.g. src/desde-overrides.css), import it from your entry module, and try again.",
    }
  }
  return { file: opts.overrideStylesheet, kind: "css-file", allowApply: false }
}

/**
 * The outcome of building the inspector's "This page" scoped override.
 *
 * Three-way rather than `StructuralEdit | null` because the lane has both
 * genuine no-ops (nothing resolved to a declaration) and *refusals* the
 * designer must be told about (no source position, reused component,
 * iterated element, clear-not-supported). Collapsing the two would put the
 * refusals back where they were before this extraction: inside the hook,
 * untestable, and — for a dead anchor — invisible.
 */
export type PageScopedCssBuild =
  | {
      kind: "edit"
      edit: StructuralEdit
      /**
       * Blast radius, when the anchor matches more than one element. Not a
       * failure — the edit is correct — but the number a designer needs to
       * see BEFORE "restyle this card" turns out to mean every card. See
       * {@link blastRadiusNotice}.
       */
      notice?: string
    }
  | { kind: "noop" }
  | { kind: "refused"; reason: string }

/**
 * The subset of a {@link Selection} the "This page" builder reads. Narrowed
 * so tests can construct an input without inventing the whole selection.
 */
export type PageScopedCssSelection = Pick<
  Selection,
  | "selector"
  | "classes"
  | "authoredAt"
  | "editTarget"
  | "iterationContext"
  | "domAnchor"
>

/**
 * Inspector "This page" scope — build the scoped-css-override for a style
 * change the designer chose to express as a `<style scoped>` rule instead of
 * a class splice on the consumer.
 *
 * Extracted out of `useEditorEditing.handleScopedStyleEdit` so the anchor +
 * guard decisions this lane makes are testable without mounting the hook —
 * the shipped lane now calls this and maps `refused` onto `setSaveStatus`.
 * See `tasks/dev-server-hosts.md` § 9g.8.
 *
 * **The anchor is `domAnchor`, never `authoredAt`.** The rule head has to be
 * an attribute value that exists in the document; `authoredAt` is where the
 * element's bytes live, which on a component root is the `data-desde-own`
 * rescue stamp — measured to match zero elements. Reading `authoredAt` here
 * is what made this lane write dead rules into real files and report
 * success. Both the anchor and its match count come from the SAME
 * `resolveDomAnchor` call in the bridge, which is the property the
 * dead-anchor guard actually depends on (§ 9g.9: the guard compares the
 * count the producer attached against the anchor the producer chose, so it
 * is blind to a producer that computes them from different places).
 *
 * **The destination is a separate question from the anchor**, and only Vue
 * makes them look like one. A Vue SFC contains both the callsite and a
 * `<style scoped>` block, so the rule goes in the anchor's own file. A React
 * component has no stylesheet of its own, so the rule goes into a project
 * `.css` the page loads — supplied via `opts.overrideStylesheet`.
 *
 * The guards, and why each:
 *   - No anchor / a dead anchor: refuse rather than write an inert rule.
 *   - Cross-file reused component (`editTarget.file !== authoredAt.file`):
 *     authoredAt is the component's own file → a `<style scoped>` override
 *     would apply on every page (or fail for node_modules). Vue-only: on a
 *     `.css` destination the rule is global by construction and the anchor
 *     is what bounds it, so there is nothing extra to refuse — and refusing
 *     would remove exactly the case the lane exists for (an element inside a
 *     component you do not own).
 *   - Iterated element: a v-for row INSIDE a reused child component has
 *     `editTarget === authoredAt` pointing at the child SFC, so the file
 *     check passes — yet writing there still leaks across pages. We can't
 *     distinguish that from a same-page v-for without a page-file signal,
 *     so conservatively refuse all iterated selections.
 *   - Removal-only: an additive override rule can't express a clear.
 */
export function buildPageScopedCssOverrideEdit(
  selection: PageScopedCssSelection,
  nextClasses: string[],
  opts: StyleEditDestinationOptions = {},
): PageScopedCssBuild {
  const anchor = selection.domAnchor
  if (!anchor) {
    return {
      kind: "refused",
      reason:
        "Can't scope to this page: nothing in this element's ancestry carries a data-desde-src to anchor the rule on.",
    }
  }
  const anchorLoc = `${anchor.file}:${anchor.line}:${anchor.column}`
  const dead = deadAnchorRefusal(anchorLoc, anchor.matchCount)
  if (dead) return { kind: "refused", reason: dead }
  const destination = overrideDestination(anchor.file, opts)
  if ("refused" in destination) {
    return { kind: "refused", reason: destination.refused }
  }
  // The next three guards are about where the rule LANDS, so they apply only
  // where the destination is derived from the selection — i.e. Vue, whose
  // rule goes into an SFC's own `<style scoped>` block. On a `.css`
  // destination none of them describe a real hazard, and applying them anyway
  // would refuse exactly the case this lane exists for: an element inside a
  // component you do not own, which by construction has no `authoredAt` you
  // can write to (MEASURED on MUI, `tasks/dev-server-hosts.md` § 9g.2 —
  // clicking `.MuiAlert-message` yields `editTarget null, authoredAt null`,
  // and the ancestor anchor two levels up styles it correctly).
  //
  // The asymmetry is worth stating so nobody "fixes" it: an EDIT needs
  // attribution to be correct, because it mutates a file's bytes. This lane
  // never opens the anchor's file — it quotes the coordinate into a string —
  // so it needs the strictly weaker property that the selector resolves, and
  // resolves to the element the user clicked.
  if (destination.kind === "vue-sfc") {
    const editTarget = selection.authoredAt
    if (!editTarget) {
      return {
        kind: "refused",
        reason:
          "Can't scope to this page: the element has no source position (data-desde-src).",
      }
    }
    if (selection.editTarget && selection.editTarget.file !== editTarget.file) {
      return {
        kind: "refused",
        reason:
          "Can't scope to this page: this element comes from a reused component (Phase 3 follow-up).",
      }
    }
    // A v-for row INSIDE a reused child component has
    // `editTarget === authoredAt` pointing at the child SFC, so the file check
    // above passes while writing there still leaks across pages. On a `.css`
    // destination there is no per-component block to leak out of — the rule is
    // global either way and the anchor is what bounds it — so an iterated
    // selection is disclosed (`notice`, the match count) rather than refused.
    if (selection.iterationContext) {
      return {
        kind: "refused",
        reason:
          "Can't scope to this page: this element is one of several repeated instances (Phase 3 follow-up).",
      }
    }
  }
  // Only the NEW classes vs the current selection become the override rule.
  const before = new Set(selection.classes ?? [])
  const added = nextClasses.filter((c) => !before.has(c))
  if (added.length === 0) {
    return {
      kind: "refused",
      reason:
        "Clearing a page-scoped style isn't supported yet. Edit at the element scope to clear it.",
    }
  }
  const declarations = resolveTailwindClasses(added)
  const unresolved = added.filter((c) => resolveTailwindClass(c) === null)
  if (Object.keys(declarations).length === 0 && unresolved.length === 0) {
    return { kind: "noop" }
  }
  if (unresolved.length > 0 && !destination.allowApply) {
    // `@apply` is the only way this lane can express a utility it cannot
    // resolve to declarations, and it is inert in a plain stylesheet that
    // Tailwind may not process. Refuse visibly rather than write a rule that
    // is present and does nothing.
    return {
      kind: "refused",
      reason: `Can't apply ${unresolved.join(", ")} as a page-scoped rule on this substrate: it has no CSS-declaration mapping. Use chat to set it, or style at the element scope.`,
    }
  }
  // An ancestor anchor styles the ANCESTOR unless the clicked element is
  // named as a descendant — the same rule the mutation lane follows, via
  // the same helper so the two can't drift.
  const deepSelector =
    anchor.resolution === "ancestor"
      ? deepSelectorFromMutationSelector(selection.selector)
      : undefined
  return {
    kind: "edit",
    notice: blastRadiusNotice(anchor.matchCount) ?? undefined,
    edit: {
      kind: "scoped-css-override",
      id: makeEditId(),
      target: {
        targetId: selection.selector,
        selector: selection.selector,
        // The DESTINATION file — where the rule is written.
        editTarget: {
          file: destination.file,
          line: anchor.line,
          column: anchor.column,
        },
      },
      // The ANCHOR — what the rule head names. Same `resolveDomAnchor` call
      // that supplied `matchCount` above.
      anchor: { file: anchor.file, line: anchor.line, column: anchor.column },
      deepSelector,
      applyClasses: destination.allowApply ? unresolved : undefined,
      declarations,
    },
  }
}

/**
 * Build the scoped-css-override edit for a `class` mutation, or null when
 * there's nothing to write (no sourceLoc / no added classes). Single source
 * of truth shared by the branch-mode dispatch lane and the commit-time
 * flush (`handleSaveAll`) so the Tailwind-resolution + deep-selector logic
 * can't drift between the two.
 *
 * Returns `{ unsupported }` — not null — for a dead anchor, so both callers
 * surface it (they already branch on `isUnsupportedStyleBuild`). A silent
 * null here would be the same failure this guard exists to end: a change the
 * designer made, and nothing at all to show for it.
 *
 * **Framework-neutral.** `m.sourceLoc` is the rendered `data-desde-src` the
 * bridge read off the DOM with `resolveDomAnchor`, and `m.anchorMatchCount`
 * is that same call's count — on either substrate. The only per-substrate
 * part is the destination (`overrideDestination`): a Vue SFC's own
 * `<style scoped>`, or a project `.css` on React.
 */
export function buildScopedCssOverrideEdit(
  m: Mutation,
  opts: StyleEditDestinationOptions = {},
): BuiltStyleEdit {
  if (!m.sourceLoc) return null
  const sourceLoc = parseSourceLoc(m.sourceLoc)
  if (!sourceLoc) return null
  const added = addedClassesFromMutation(m)
  if (added.length === 0) return null
  const dead = deadAnchorRefusal(
    `${sourceLoc.file}:${sourceLoc.line}:${sourceLoc.column}`,
    m.anchorMatchCount,
  )
  if (dead) return { unsupported: dead }
  const destination = overrideDestination(sourceLoc.file, opts)
  if ("refused" in destination) return { unsupported: destination.refused }
  // Split added classes: resolvable → raw CSS `declarations` (substrate-
  // agnostic); the rest → `@apply` fallback (renders only if Tailwind is
  // wired). The applicator merges both into one rule body.
  const declarations = resolveTailwindClasses(added)
  const unresolvedClasses = added.filter(
    (c) => resolveTailwindClass(c) === null,
  )
  if (unresolvedClasses.length > 0 && !destination.allowApply) {
    return {
      unsupported: `Can't apply ${unresolvedClasses.join(", ")} as a CSS override on this substrate: it has no CSS-declaration mapping, and \`@apply\` in a plain stylesheet would be inert. Use chat to set it.`,
    }
  }
  // Direct: the anchor IS the styled element. Ancestor: an inner element of a
  // component we don't own — Vue needs `:deep()` to pierce the scope
  // boundary, React needs nothing because it has no scoping.
  const deepSelector =
    m.resolutionKind === "ancestor"
      ? deepSelectorFromMutationSelector(m.selector)
      : undefined
  return {
    kind: "scoped-css-override",
    id: makeEditId(),
    target: {
      targetId: m.selector,
      selector: m.selector,
      // DESTINATION, not anchor: on React these are different files.
      editTarget: { ...sourceLoc, file: destination.file },
    },
    anchor: sourceLoc,
    deepSelector,
    applyClasses: destination.allowApply ? unresolvedClasses : undefined,
    declarations,
  }
}

/**
 * React/JSX styling builder — the `.tsx`/`.jsx` analog of
 * `buildScopedCssOverrideEdit`. React has no `<style scoped>`; the styled
 * element carries its own `data-desde-src`, and we edit its `className` / `style`
 * attribute in place. `mode` follows the CLI-detected styling system
 * (`EDITOR_STYLING_SYSTEM`):
 *   - `tailwind` → splice the added/removed Tailwind class NAMES into
 *     `className` (clean, no style bloat).
 *   - else → resolve the added classes to CSS declarations and merge a
 *     `style={{}}` object (universal; works on any React substrate).
 */
export function buildJsxStyleEdit(
  m: Mutation,
  opts: StyleEditDestinationOptions = {},
): BuiltStyleEdit {
  if (!m.sourceLoc) return null
  const sourceLoc = parseSourceLoc(m.sourceLoc)
  if (!sourceLoc) return null
  const added = addedClassesFromMutation(m)
  const removed = removedClassesFromMutation(m)
  if (added.length === 0 && removed.length === 0) return null

  // Only DIRECT resolution can be an in-place attribute edit. When the
  // clicked element has no own `data-desde-src` but a stamped ancestor does,
  // patching the ancestor's className/style would style the WRONG node — it
  // is a different element. That used to be a flat refusal, which left React
  // with no way at all to restyle inside a component the user does not own;
  // it now routes to `scoped-css-override`, whose rule head names the
  // ancestor's coordinate and whose descendant selector names the element
  // that was actually clicked. The same split Vue has always had: own it and
  // the element is edited, don't and a rule is written.
  if (m.resolutionKind !== "direct") {
    return buildScopedCssOverrideEdit(m, opts)
  }

  const target = {
    targetId: m.selector,
    selector: m.selector,
    editTarget: sourceLoc,
  }
  const classNameEdit = (): StructuralEdit => ({
    kind: "jsx-style",
    id: makeEditId(),
    target,
    mode: "classname",
    addClasses: added,
    removeClasses: removed,
  })

  if (EDITOR_STYLING_SYSTEM === "tailwind") {
    return classNameEdit()
  }

  // Inline mode (non-Tailwind substrate): express the change as a
  // `style={{}}` object. This only works if EVERY add/remove class resolves
  // to a CSS declaration — `resolveTailwindClass` covers the inspector's
  // border/color/spacing/typography utilities, but not everything (e.g.
  // `shadow-lg`, variant utilities). Splicing such a class into `className`
  // would be inert here (no Tailwind to compile it) and a silent drop hides
  // the edit — so surface a visible "unsupported" instead. (On a Tailwind
  // substrate the className splice above IS correct; this branch is the
  // non-Tailwind path only.)
  const unresolved = [...added, ...removed].filter(
    (c) => resolveTailwindClass(c) === null,
  )
  if (unresolved.length > 0) {
    return {
      unsupported: `Can't apply ${unresolved.join(", ")} on this substrate: it has no inline-CSS mapping. Use chat to set it, or add Tailwind to the project.`,
    }
  }

  const declarations = resolveTailwindClasses(added)
  const removeDeclarations = Array.from(
    new Set(
      removed.flatMap((c) => Object.keys(resolveTailwindClass(c) ?? {})),
    ),
  )
  if (
    Object.keys(declarations).length === 0 &&
    removeDeclarations.length === 0
  ) {
    // No added/removed classes resolved to anything (and none were
    // unresolved either → both lists empty). Genuine no-op.
    return null
  }
  return {
    kind: "jsx-style",
    id: makeEditId(),
    target,
    mode: "inline",
    declarations,
    removeDeclarations,
  }
}

/**
 * Pick the styling edit for the current substrate.
 *
 * The full 2x2, which only fell into place once React got the page lane
 * (`tasks/dev-server-hosts.md` § 9g.0, correction 2):
 *
 * | scope | Vue | React |
 * | --- | --- | --- |
 * | element (you own it) | class splice into the SFC template | `jsx-style` |
 * | page (you do not) | `scoped-css-override` (`<style scoped>`) | `scoped-css-override` (project `.css`) |
 *
 * So `jsx-style` is the dual of Vue's class splice, NOT of
 * `scoped-css-override` — and this function's job is only to pick the
 * element-scope idiom per substrate, then let both fall through to the same
 * override lane when the element isn't ours to edit.
 */
export function buildStyleEdit(
  m: Mutation,
  opts: StyleEditDestinationOptions = {},
): BuiltStyleEdit {
  return EDITOR_FRAMEWORK === "react"
    ? buildJsxStyleEdit(m, opts)
    : buildScopedCssOverrideEdit(m, opts)
}
