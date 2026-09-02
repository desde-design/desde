/**
 * The edit dispatcher's **extension gate** — which file extensions each edit
 * lane may touch, as a pure function of `(kind, filePath)`.
 *
 * `applyEdit` runs this gate TWICE: once on the lexically-resolved candidate
 * path (before symlink resolution) and once on the realpath'd target (so a
 * `foo.vue` symlink pointing at `/etc/passwd` — or `foo.ts` → `bar.sh` — can't
 * sneak through). Those two checks used to be hand-duplicated inline, which
 * meant a NEW edit kind could silently be added to one copy's truth table and
 * missed by the other — the two gates would then disagree and a lane would be
 * open post-symlink that was closed pre-symlink (or vice versa).
 *
 * Computing the table ONCE here removes that class of bug by construction:
 * both call sites go through {@link checkExtensionGate}, and the only thing
 * that differs between them is the `phase`, which selects the wording of the
 * refusal ("… require a .css file" vs "Resolved target is not a .css file").
 *
 * Pure — no I/O, no filesystem access. It only inspects the kind and the
 * path STRING (`endsWith`), never the bytes on disk.
 */

import type { OverwriteExtension } from "../../../src/editor/edit-service/validate-overwrite-source"
import type { EditRequestBody } from "../../../src/editor/edit-service/validate-edit-request"

/** Every wire-format edit kind the validator admits. */
export type EditKind = EditRequestBody["edit"]["kind"]

/**
 * The lane classification for an edit kind. These five booleans ARE the
 * truth table: everything else the gate decides is derived from them plus
 * the path's extension.
 */
export interface EditLaneFlags {
  /**
   * The overwrite lane accepts `.vue` (SFCs) and `.ts` (composables,
   * utilities) plus `.tsx`/`.jsx`; the Vue-primitive lanes (prop, move,
   * detach, swap, …) stay `.vue`-only because their applicators mutate SFC
   * AST.
   */
  isOverwriteLane: boolean
  /**
   * The token-value lane edits a first-party CSS token file — it admits
   * `.css` for THAT kind only (never on any other lane). `node_modules` is
   * refused separately, after symlink resolution, so library token files
   * stay read-only.
   */
  isTokenLane: boolean
  /**
   * Framework-aware lanes: Vue SFCs go to the `@vue/compiler` applicators,
   * React `.tsx`/`.jsx` to the Babel applicators. prop, the structural lanes
   * (move/delete/insert), unwrap, text-branch, and
   * flatten-conditional each have a JSX sibling applicator; detach and swap
   * are the lanes that stay Vue-only. scoped-css-override is neither — it is
   * cross-substrate but writes a stylesheet, not a component, so it has its
   * own flag below. (`llm-patch` is exempt from this gate entirely — the
   * handler dispatches it away before reaching here, see `edit-handler.ts`.)
   */
  isJsxCapableLane: boolean
  /**
   * The jsx-style lane is React-ONLY (it has no Vue analog — Vue inline
   * styling is the `scoped-css-override` lane). It admits `.tsx`/`.jsx` and
   * refuses `.vue`.
   */
  isJsxOnlyLane: boolean
  /**
   * The scoped-CSS-override lane writes a rule anchored on a rendered
   * `data-desde-src`. WHERE it writes depends on the substrate, not on the edit:
   * a Vue SFC has a `<style scoped>` block to carry it, and a React app has
   * no such thing, so the rule goes into a project stylesheet. So this lane
   * admits `.vue` OR `.css` — and nothing else, because those are the only
   * two files with a place to put a CSS rule.
   *
   * `node_modules` is refused separately (post-symlink, in the handler), so
   * widening to `.css` does not open library stylesheets.
   */
  isScopedCssLane: boolean
}

/**
 * Classify an edit kind into its lane flags. Single source of truth: adding a
 * new kind means adding it here once, and BOTH gate invocations pick it up.
 */
export function editLaneFlags(kind: EditKind): EditLaneFlags {
  return {
    isOverwriteLane: kind === "overwrite",
    isTokenLane: kind === "token-value",
    isJsxCapableLane:
      kind === "prop" ||
      kind === "move" ||
      kind === "delete" ||
      kind === "insert" ||
      kind === "unwrap" ||
      kind === "text-branch" ||
      kind === "flatten-conditional",
    isJsxOnlyLane: kind === "jsx-style",
    isScopedCssLane: kind === "scoped-css-override",
  }
}

/**
 * Which of the two gate invocations this is. Selects the refusal wording only
 * — the accept/reject decision is phase-independent by design (the whole point
 * of re-running the gate post-symlink is to apply the SAME rule to the
 * resolved bytes).
 */
export type ExtensionGatePhase = "candidate" | "resolved"

export type ExtensionGateResult =
  /**
   * `ext` is the {@link OverwriteExtension} classification of the path, or
   * null when the path isn't one of `.vue`/`.ts`/`.tsx`/`.jsx` (or is one of
   * the latter three on a lane that doesn't admit them). `isJsx` is a plain
   * path test, independent of lane.
   */
  | { ok: true; ext: OverwriteExtension | null; isJsx: boolean }
  | { ok: false; reason: string }

/**
 * Apply the extension gate for `kind` to `filePath`.
 *
 * Refusals are 400s at both call sites. On success the caller gets the same
 * two derived values the inline copies used to compute by hand (`ext` for the
 * overwrite-source validator, `isJsx` for framework-aware applicator
 * dispatch), so there's no second place where extension classification can
 * drift from the gate that admitted the file.
 */
export function checkExtensionGate(
  kind: EditKind,
  filePath: string,
  phase: ExtensionGatePhase,
): ExtensionGateResult {
  const {
    isOverwriteLane,
    isTokenLane,
    isJsxCapableLane,
    isJsxOnlyLane,
    isScopedCssLane,
  } = editLaneFlags(kind)

  const isJsx = filePath.endsWith(".tsx") || filePath.endsWith(".jsx")
  const ext: OverwriteExtension | null = filePath.endsWith(".vue")
    ? "vue"
    : isOverwriteLane && filePath.endsWith(".ts")
      ? "ts"
      : isOverwriteLane && filePath.endsWith(".tsx")
        ? "tsx"
        : isOverwriteLane && filePath.endsWith(".jsx")
          ? "jsx"
          : null

  // The token lane requires .css; the scoped-CSS lane admits .vue OR .css
  // (it writes a stylesheet, and which kind of file holds one is a fact about
  // the substrate); the JSX-capable lanes admit .vue + .tsx/.jsx; every other
  // lane requires `ext` (.vue, .ts, or .tsx/.jsx on overwrite). Otherwise
  // mutually exclusive — token edits can't touch SFCs, and component edits
  // can't touch .css.
  const extOk = isTokenLane
    ? filePath.endsWith(".css")
    : isScopedCssLane
      ? filePath.endsWith(".vue") || filePath.endsWith(".css")
      : isJsxOnlyLane
        ? isJsx
        : isJsxCapableLane
          ? ext !== null || isJsx
          : ext !== null

  if (extOk) return { ok: true, ext, isJsx }

  return {
    ok: false,
    reason:
      phase === "candidate"
        ? isTokenLane
          ? "Token edits require a .css file"
          : isScopedCssLane
            ? "Style overrides require a .vue or .css file"
            : isJsxOnlyLane
              ? "This edit kind requires a .tsx or .jsx file"
              : isJsxCapableLane
                ? "This edit kind requires a .vue, .tsx, or .jsx file"
                : isOverwriteLane
                  ? "Only .vue, .ts, .tsx, and .jsx files are supported"
                  : "Only .vue files are supported for this edit kind"
        : isTokenLane
          ? "Resolved target is not a .css file"
          : isScopedCssLane
            ? "Resolved target is not a .vue or .css file"
            : isJsxOnlyLane
              ? "Resolved target is not a .tsx or .jsx file"
              : isJsxCapableLane
                ? "Resolved target is not a .vue, .tsx, or .jsx file"
                : isOverwriteLane
                  ? "Resolved target is not a .vue, .ts, .tsx, or .jsx file"
                  : "Resolved target is not a .vue file",
  }
}
