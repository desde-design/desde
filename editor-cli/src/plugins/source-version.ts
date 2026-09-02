import { createHash } from "node:crypto"

/**
 * Per-file source-version stamp (`data-desde-v`): a SHA-256 prefix of the exact
 * transform input the coordinates were computed from. The bridge captures it
 * together with `data-desde-src` coordinates; the edit server compares it
 * against current on-disk content and refuses stale-target edits whose
 * coordinates provably predate the file's current bytes (WS1,
 * tasks/edit-pipeline-rearchitecture.md). 12 hex chars is ample for a
 * same-file version check (this is drift detection, not security).
 *
 * A SEPARATE attribute, deliberately NOT appended to `data-desde-src`:
 * scoped-CSS overrides persist `[data-desde-src="…"]` attribute selectors into
 * source files — a version suffix there would break those selectors on
 * every edit.
 *
 * WHY ITS OWN MODULE (and not a shared helper inside `source-tag-plugin.ts`,
 * where it used to live): both stampers need it, but `source-tag-plugin.ts` is
 * the VUE stamper and carries a module-scope `import … from "@vue/compiler-sfc"`.
 * Importing this two-line helper from there made the REACT stamper
 * (`jsx-source-tag-plugin.ts`) hard-require the Vue compiler at load time —
 * measured 2026-08-09: bundling the JSX plugin and requiring it from a
 * React-only project threw `Cannot find module '@vue/compiler-sfc'`, and
 * installing the Vue compiler into a React app was the only way past it. This
 * module depends on nothing but `node:crypto`, so the React lane stays
 * Vue-free. Keep it that way — do not add framework imports here.
 */
export function sourceVersionOf(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex").slice(0, 12)
}
