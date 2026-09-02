/**
 * Framework detection for an ingested design-system package (spec §6). Cheap,
 * deterministic, no TS checker, no LLM — the two heuristics are the inverse of
 * what the two extractors key on:
 *
 *   1. Any `*.vue.d.ts` under the package's standard dts roots → vue3.
 *   2. Else a resolvable React `.d.ts` types entry → react (with its entry
 *      files). The PRECISE "is any export a React component" test is the
 *      extractor's job — a non-component lib that ships `.d.ts` will simply
 *      extract 0 components and read as empty coverage, which is honest.
 *   3. Else unknown → the caller surfaces "couldn't detect a supported framework."
 */

import { readdirSync } from 'node:fs'
import path from 'node:path'
import { discoverReactDtsEntries } from '@/editor/adapters/react-dts-meta/presets'

/** Standard dts roots (mirrors the auto-scan's convergent Vue layout). */
const VUE_DTS_PROBE_ROOTS = ['dist/types/components', 'dist/types', 'dist']
const VUE_DTS_RE = /\.vue\.d\.ts$/i
/** Bound the recursive probe so a huge package can't blow the call stack/time. */
const MAX_PROBE_DEPTH = 6

export type FrameworkDetection =
  | { framework: 'vue3'; via: 'vue-dts'; dtsRoot: string }
  | { framework: 'react'; entryFiles: string[] }
  | { framework: 'unknown' }

export function detectFramework(packageRoot: string): FrameworkDetection {
  const dtsRoot = findVueDtsRoot(packageRoot)
  if (dtsRoot) return { framework: 'vue3', via: 'vue-dts', dtsRoot }
  let entryFiles: string[] = []
  try {
    entryFiles = discoverReactDtsEntries(packageRoot)
  } catch {
    entryFiles = []
  }
  if (entryFiles.length > 0) return { framework: 'react', entryFiles }
  return { framework: 'unknown' }
}

/**
 * The first standard dts root (package-root-relative) containing any
 * `*.vue.d.ts`, or null. Pass it as the source's `dtsRoots` so discovery
 * targets the right subtree (works for both node_modules and scratch packages).
 */
export function findVueDtsRoot(packageRoot: string): string | null {
  for (const root of VUE_DTS_PROBE_ROOTS) {
    if (walkForVueDts(path.join(packageRoot, root), 0)) return root
  }
  return null
}

function walkForVueDts(dir: string, depth: number): boolean {
  if (depth > MAX_PROBE_DEPTH) return false
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  // Files first (cheap short-circuit), then descend.
  for (const e of entries) {
    if (e.isFile() && VUE_DTS_RE.test(e.name)) return true
  }
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.')) {
      if (walkForVueDts(path.join(dir, e.name), depth + 1)) return true
    }
  }
  return false
}
