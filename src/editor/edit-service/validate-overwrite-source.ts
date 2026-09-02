/**
 * Shared validator for the `overwrite` edit kind. Used by both
 * `/api/editor/edit` (web) and `editor-cli/src/server/edit-handler.ts`
 * (CLI) so the safety invariants stay in sync across transports.
 *
 * The validator dispatches on file extension. The `.vue` branch is the
 * historical full-SFC check (the LLM's output is treated as a fresh
 * component file); the `.ts` branch is the lighter check used for
 * composables and utility modules, where there is no template AST to
 * verify and Vite will surface real syntax errors via the HMR overlay
 * once the file is written.
 *
 * Vue-SFC defense-in-depth (kept verbatim from the original):
 *
 *   1. SFC parse must succeed AND `descriptor.errors` must be empty.
 *      The original `route.ts` only checked that `parse()` didn't throw —
 *      `@vue/compiler-sfc.parse()` actually buffers SFC-level errors
 *      into `descriptor.errors` rather than throwing, so a malformed
 *      block boundary could slip through. Codex review caught this.
 *
 *   2. The SFC must have a `<template>` block. Without this guard,
 *      plain text "newSource" (no template) silently passes because
 *      `compile()` is only invoked when `descriptor.template` exists.
 *      Vue components ARE allowed to have only `<script setup>` and
 *      render via JSX/render fns, but the editor's edit pipeline
 *      assumes template editing — accepting templateless output here
 *      would be a covert escape route.
 *
 *   3. Template body must compile cleanly under `@vue/compiler-dom`.
 *      Catches every shape the template-only `parse()` would miss:
 *      orphan v-else, malformed v-slot, etc. Same guard
 *      `apply-move-edit` and `apply-unwrap-edit` use post-splice.
 *
 *   4. No `data-desde-src` or `data-prototype-flow` attributes in source.
 *      These are injected by the substrate's Vite source-tag plugin
 *      at build/serve time on a per-element basis — they should NEVER
 *      appear in checked-in source. If the LLM produces them in
 *      `newSource`, it's almost certainly hallucinating from the
 *      rendered DOM it never saw. Writing them to disk poisons the
 *      next build's tagging.
 *
 * Pure (no I/O). The caller does the filesystem work.
 *
 * WHY THIS FUNCTION IS ASYNC (and why the Vue compilers are imported lazily
 * INSIDE the `.vue` branch): this module dispatches on file extension, and the
 * `.tsx`/`.jsx` branch needs nothing but `@babel/parser`. Module-scope
 * `import … from '@vue/compiler-{sfc,dom}'` made every consumer — including a
 * React-only one that will only ever validate `.tsx` — hard-require the Vue
 * compiler at LOAD time, before any branch runs.
 *
 * Measured 2026-08-09, the same defect and the same proof as the React stamper
 * in `d98606ed`: bundling this module with esbuild
 * (`--bundle --platform=node --format=cjs --packages=external`) and requiring it
 * from a project where `@vue/compiler-sfc` does not resolve threw
 * `Cannot find module '@vue/compiler-sfc'` on the `.tsx` path. That blocks
 * running the edit pipeline inside a user's React project (the Next.js
 * attach-mode work).
 *
 * Splitting the Vue branch into a separate module does NOT fix this and was
 * rejected on measurement, not taste: esbuild inlines a statically-imported
 * local module and hoists its external `require()` calls to the top of the
 * bundle, so the Vue compilers still load eagerly. Only a dynamic `import()`
 * of the *packages* defers them under every bundler. Keep it that way — the
 * cost of a static Vue import here is not a slower path, it is a module that
 * cannot be loaded at all outside a Vue project.
 */

import { parse as parseBabel } from '@babel/parser'

export type ValidateOverwriteResult =
  | { ok: true }
  | { ok: false; reason: string }

export type OverwriteExtension = 'vue' | 'ts' | 'tsx' | 'jsx'

export interface ValidateOverwriteOptions {
  extension: OverwriteExtension
}

/** Match `data-desde-src` as a real HTML attribute, ignoring incidental
 *  occurrences inside comments or string literals. Conservative regex:
 *  matches `data-desde-src=` preceded by whitespace, `<`, or `"`. */
const DATA_PT_SRC_ATTR_RE = /(?:^|[\s<"\'])data-desde-src\s*=/i
const DATA_PROTOTYPE_FLOW_ATTR_RE = /(?:^|[\s<"\'])data-prototype-flow\s*=/i

export async function validateOverwriteSource(
  newSource: string,
  opts: ValidateOverwriteOptions = { extension: 'vue' },
): Promise<ValidateOverwriteResult> {
  // The non-Vue branches stay synchronous internally and are reached without
  // touching the Vue compilers at all — that is the whole point of the shape.
  if (opts.extension === 'ts') {
    return validateTsOverwriteSource(newSource)
  }
  if (opts.extension === 'tsx' || opts.extension === 'jsx') {
    return validateJsxOverwriteSource(newSource, opts.extension)
  }
  return validateVueOverwriteSource(newSource)
}

/**
 * Validate a React `.tsx`/`.jsx` overwrite. Unlike Vue SFCs (whose parse errors
 * are silent — buffered into `descriptor.errors`), a JSX syntax error throws
 * from `@babel/parser`, AND Vite surfaces it loudly via the HMR overlay seconds
 * after we write. We still parse here so the LLM repair lane can't commit
 * unparseable JSX to disk, and we keep the same `data-desde-src` /
 * `data-prototype-flow` hallucination guards as the Vue path.
 *
 * The TypeScript plugin is enabled ONLY for `.tsx` — esbuild/Vite treat `.jsx`
 * as plain JavaScript, so accepting TS-only syntax (type annotations, generic
 * params) for a `.jsx` file would pass here but break at transform time. This
 * mirrors jsx-source-tag-plugin's per-extension parser config exactly.
 */
function validateJsxOverwriteSource(
  newSource: string,
  extension: 'tsx' | 'jsx',
): ValidateOverwriteResult {
  if (!newSource || newSource.length === 0) {
    return { ok: false, reason: 'newSource is empty' }
  }
  try {
    // Match the JSX applicators' / source-tag plugin's parser config. No
    // errorRecovery: a clean parse is the bar for committing a full rewrite.
    parseBabel(newSource, {
      sourceType: 'module',
      plugins: extension === 'tsx' ? ['jsx', 'typescript'] : ['jsx'],
    })
  } catch (err) {
    return { ok: false, reason: `JSX parse failed: ${(err as Error).message}` }
  }
  if (DATA_PT_SRC_ATTR_RE.test(newSource)) {
    return {
      ok: false,
      reason:
        'newSource contains data-desde-src attributes: these are injected at build time and must not appear in committed source. The LLM proposal is hallucinating from rendered DOM.',
    }
  }
  if (DATA_PROTOTYPE_FLOW_ATTR_RE.test(newSource)) {
    return {
      ok: false,
      reason:
        'newSource contains data-prototype-flow attributes: these are bridge-injected and must not appear in committed source.',
    }
  }
  return { ok: true }
}

function validateTsOverwriteSource(newSource: string): ValidateOverwriteResult {
  if (!newSource || newSource.length === 0) {
    return { ok: false, reason: 'newSource is empty' }
  }
  // No TS parse here: a parser would bring `typescript` into the route's
  // hot path, and Vite reports real syntax errors to the iframe via its
  // HMR overlay seconds after we write the file. The .vue checks below
  // exist because Vue SFC errors are silent at write time.
  return { ok: true }
}

async function validateVueOverwriteSource(
  newSource: string,
): Promise<ValidateOverwriteResult> {
  if (!newSource || newSource.length === 0) {
    return { ok: false, reason: 'newSource is empty' }
  }

  // Deferred to here, not module scope — see the header comment. This is the
  // only place in the module allowed to reach for the Vue compilers, and it is
  // reached only when the target really is a `.vue` file.
  const [{ parse: parseSfc }, { compile: compileTemplate }] = await Promise.all([
    import('@vue/compiler-sfc'),
    import('@vue/compiler-dom'),
  ])

  let descriptor
  try {
    descriptor = parseSfc(newSource).descriptor
  } catch (err) {
    return {
      ok: false,
      reason: `SFC parse failed: ${(err as Error).message}`,
    }
  }
  // parseSfc buffers errors into descriptor.errors rather than throwing.
  // Empty source, mismatched block tags, etc. land here.
  const errors = (descriptor as { errors?: Array<{ message?: string }> }).errors
  if (Array.isArray(errors) && errors.length > 0) {
    return {
      ok: false,
      reason: `SFC parse produced errors: ${errors
        .map((e) => e.message ?? String(e))
        .join('; ')}`,
    }
  }
  if (!descriptor.template) {
    return {
      ok: false,
      reason:
        'newSource has no <template> block: overwrite path only supports template-bearing SFCs',
    }
  }
  try {
    compileTemplate(descriptor.template.content)
  } catch (err) {
    return {
      ok: false,
      reason: `Template compile failed: ${(err as Error).message}`,
    }
  }

  if (DATA_PT_SRC_ATTR_RE.test(newSource)) {
    return {
      ok: false,
      reason:
        'newSource contains data-desde-src attributes: these are injected at build time and must not appear in committed source. The LLM proposal is hallucinating from rendered DOM.',
    }
  }
  if (DATA_PROTOTYPE_FLOW_ATTR_RE.test(newSource)) {
    return {
      ok: false,
      reason:
        'newSource contains data-prototype-flow attributes: these are bridge-injected and must not appear in committed source.',
    }
  }

  return { ok: true }
}
