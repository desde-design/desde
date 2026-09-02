/**
 * Source-inference hint lane — Phase 4 "rendering hints at scale" (Task 4).
 *
 * Probing (Task 3, `derive-hints.ts` / `probe-driver.ts`) needs a component
 * mountable behind a bare-specifier import from the prototype's own Vite
 * server — which an `installed` (node_modules) package satisfies, but a
 * `repo`-ingested one does NOT: its clone lives under
 * `.desde/ingested/<slug>/repo[/subdir]` (see
 * `src/editor/ingest/git-repo.ts`), outside `node_modules`, so Vite can't
 * resolve it (V1 bound — see `editor-cli/src/server/design-systems-handler.ts`'s
 * `generate-hints` route doc comment). But a `repo`-kind ingest is the ONE
 * source kind that keeps the CLONE around after extraction (an `npm`-scratch
 * ingest only needs the shipped `.d.ts`, not the component source) — so for
 * THAT kind alone, there's a source tree to read hints from directly.
 *
 * This module is the read side: given a component's manifest and a
 * already-resolved, already-containment-checked source directory (the
 * caller's job — see `design-systems-handler.ts`'s `resolveIngestedSourceRoot`),
 * find the ONE `.vue`/`.tsx` file whose basename (extension stripped) exactly
 * matches the component's name, and hand it to the EXISTING pure
 * `inferRenderingHints` (Vue)/`inferJsxRenderingHints` (React) inferrers —
 * the SAME ones `LocalVueManifestSource`/first-party React extraction use for
 * the prototype's own components. `propNames` comes from the component's
 * MANIFEST props (not a fresh `defineProps`/destructure parse of the file) —
 * decoupling the inferrers from their original callers' prop-extraction step
 * was confirmed viable in Task 4's design pass: the inferrers only ever
 * needed a `Set`/array of names, never anything else about how those names
 * were discovered.
 *
 * ── Why `provenance: 'inferred', verified: false` here, but NOT in
 * `local-vue/index.ts` ──
 *
 * `LocalVueManifestSource` infers hints for the PROTOTYPE'S OWN first-party
 * components and leaves them with no `provenance` field at all — trusted
 * unconditionally (`isTrustedHint`'s legacy default), because the analyzed
 * source IS what's actually rendered in the live app; there's no
 * build/version/fork skew between "what we parsed" and "what runs". A
 * repo-ingested THIRD-PARTY design system carries no such guarantee (the
 * cloned ref may differ from the runtime bundle other consumers built from,
 * a subdir/build step may transform the template, etc.) — so hints this
 * module produces are stamped `provenance: 'inferred', verified: false` and
 * only become deterministic-lane-eligible once a probe pass independently
 * confirms them (`generate-hints-run.ts`'s merge step). The inferrer
 * functions themselves (`inferRenderingHints`/`inferJsxRenderingHints`) are
 * NOT modified to add these fields — they're shared with the trusted
 * first-party caller, which must keep getting hints with no provenance at
 * all. This module maps over their output instead.
 *
 * ── Matching / ambiguity policy ──
 *
 * Exact basename match only (`KButton.vue` ⟷ manifest name `KButton`),
 * case-sensitive. Two-plus files sharing a basename (same or different
 * extension, anywhere under the walked tree) are AMBIGUOUS — we refuse
 * rather than guess, exactly like `derive-hints.ts`'s `resolveMatch` refuses
 * a genuinely ambiguous DOM match.
 */

import { readdirSync, readFileSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { parse as parseSfc } from '@vue/compiler-sfc'
import type { ComponentManifest, RenderingHint } from '../core/manifest'
import { inferRenderingHints } from '../adapters/local-vue/infer-rendering-hints'
import { inferJsxRenderingHints } from '../adapters/local-react/infer-jsx-rendering-hints'

/** Bounds the source-tree walk — mirrors the depth-6 convention
 * `css-custom-properties/discover.ts` uses for its own bounded app-CSS walk. */
const DEPTH_LIMIT = 6

/** Directories never worth descending into for component source — mirrors
 * the same convention (`css-custom-properties/discover.ts`'s `SKIP_DIRS`). */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'out',
  '.turbo',
  '.cache',
  '__tests__',
  'tests',
  '.desde',
])

/** The two component-file shapes this lane understands — see module doc comment. */
const COMPONENT_EXTENSIONS = ['.vue', '.tsx'] as const

/**
 * Depth-bounded walk of a repo-ingested package's source tree, collecting
 * every `.vue`/`.tsx` file's absolute path, keyed by its basename with the
 * extension stripped (`KButton.vue` → `KButton`). Call ONCE per run (not per
 * component) — {@link inferRenderingHintsFromSource} takes the built index
 * as a plain argument so a whole design system's worth of components share
 * one walk.
 *
 * A basename mapping to more than one path is left in the index AS-IS (not
 * filtered here) — {@link inferRenderingHintsFromSource} is what decides
 * "ambiguous ⇒ refuse", so the index itself stays a faithful, un-opinionated
 * record of what the walk found (useful for a caller that wants to report
 * every ambiguity found across a whole run, not just per lookup).
 */
export function buildComponentFileIndex(sourceRoot: string): Map<string, string[]> {
  const index = new Map<string, string[]>()

  const walk = (dir: string, depth: number): void => {
    if (depth > DEPTH_LIMIT) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        walk(abs, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const ext = COMPONENT_EXTENSIONS.find((candidate) => entry.name.endsWith(candidate))
      if (!ext) continue
      const base = entry.name.slice(0, entry.name.length - ext.length)
      const existing = index.get(base)
      if (existing) existing.push(abs)
      else index.set(base, [abs])
    }
  }
  walk(sourceRoot, 0)

  return index
}

/** Result of attempting source inference for ONE component. */
export interface InferFromSourceOutcome {
  /** `false` when no safe, unambiguous source file could be resolved, or it failed to parse. */
  ok: boolean
  /** Set when `ok` is false. */
  reason?: string
  /** Inferred hints — empty when a file was found but nothing was inferable (not an error). */
  hints: RenderingHint[]
}

/**
 * Infer rendering hints for ONE component from its resolved source file
 * (looked up in `fileIndex` by exact basename match against
 * `manifest.name`). Never throws — a missing file, an ambiguous match, or a
 * parse failure all resolve to `{ ok: false, reason, hints: [] }`, mirroring
 * `deriveHintsForComponent`'s never-throws contract so
 * `generate-hints-run.ts` can treat both lanes uniformly.
 */
export async function inferRenderingHintsFromSource(
  manifest: ComponentManifest,
  fileIndex: ReadonlyMap<string, string[]>,
): Promise<InferFromSourceOutcome> {
  const candidates = fileIndex.get(manifest.name) ?? []
  if (candidates.length === 0) {
    return { ok: false, reason: `no source file named '${manifest.name}' found`, hints: [] }
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      reason: `ambiguous: ${candidates.length} source files named '${manifest.name}' (${candidates.join(', ')})`,
      hints: [],
    }
  }

  const file = candidates[0]
  const propNames = manifest.props.map((p) => p.name)

  let raw: RenderingHint[] | undefined
  try {
    if (file.endsWith('.vue')) {
      const source = readFileSync(file, 'utf8')
      const templateSource = parseSfc(source).descriptor.template?.content
      raw = templateSource ? inferRenderingHints({ templateSource, propNames }) : undefined
    } else {
      const source = readFileSync(file, 'utf8')
      raw = inferJsxRenderingHints({ source, propNames })
    }
  } catch (err) {
    return { ok: false, reason: `failed to read/parse ${file}: ${errMessage(err)}`, hints: [] }
  }

  const hints: RenderingHint[] = (raw ?? []).map((hint) => ({
    ...hint,
    provenance: 'inferred',
    verified: false,
  }))
  return { ok: true, hints }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
