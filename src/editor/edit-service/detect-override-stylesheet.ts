/**
 * Boot-time facts about where this prototype's style overrides go.
 *
 * Two of the four rungs in the destination ladder
 * (`src/components/editor/resolve-override-stylesheet.ts`) are filesystem
 * questions, and the shell has no filesystem — so the CLI answers them once at
 * boot and hands the answers over in the bootstrap:
 *
 *  - **configured** — `styling.overrideStylesheet` from
 *    `desde.config.json`, the trusted customer-authored config.
 *  - **sticky** — the app stylesheet that already contains the editor-managed
 *    marker block. This is what makes the destination *made once and read
 *    back*: without it, a change in import order between sessions would
 *    scatter a project's overrides across several files, and idempotence
 *    would only work within one session.
 *
 * The sticky scan reuses `walkAppCssFiles` — the ONE bounded `.css` walk the
 * codebase has (same SKIP_DIRS, same depth limit) — rather than adding a
 * parallel crawl. It deliberately does NOT reuse `buildDesignTokenSources`,
 * which § 9f pointed at: that filters to files DECLARING custom properties
 * (`css-custom-properties/discover.ts`), so routing a styling lane through it
 * would make "where do my style overrides live?" depend on whether the project
 * happens to use CSS variables.
 *
 * **Neither answer decides anything on its own.** Both are checked against the
 * stylesheets the page has actually LOADED before they are used, because a
 * rule in an unimported file is inert no matter who named the file. That check
 * is shell-side, where the document is.
 *
 * Paths in and out are **prototype-root-relative with forward slashes** — the
 * same paths `data-desde-src` uses and the same paths the edit handler resolves.
 */
import fs from 'node:fs'
import path from 'node:path'

import { walkAppCssFiles } from '../adapters/css-custom-properties/discover'
import { CONFIG_FILENAME } from '../core/read-roots'

/** Must match `apply-scoped-css-override-edit.ts`'s block marker exactly. */
const BLOCK_START = '/* @editor-scoped-overrides start */'

/** How many `.css` files the sticky scan will read. Boot must stay fast. */
const MAX_SCANNED = 200

export interface OverrideStylesheetFacts {
  /** Prototype-root-relative. Absent when not configured (or misconfigured). */
  configured?: string
  /** Prototype-root-relative. Absent when no file holds the managed block. */
  sticky?: string
}

export interface DetectOverrideStylesheetOptions {
  /**
   * Directory the `.css` walk starts from — the APP, which in a monorepo is a
   * subdirectory. Bounds the scan to files that could plausibly be the app's.
   */
  appRoot: string
  /**
   * Root the results are expressed relative to — the PROTOTYPE root, which is
   * what `data-desde-src` and the edit handler are anchored at. Defaults to
   * `appRoot` when they are the same directory.
   */
  prototypeRoot?: string
  /**
   * Directory holding `desde.config.json`. Defaults to `appRoot`,
   * matching where `loadReadRoots` / `loadEnabledLanes` read it from.
   */
  configRoot?: string
}

/**
 * The prototype-root-relative `.css` that already holds the managed override
 * block, if any. First match in walk order; a project with two is already
 * ambiguous, and picking the first is as defensible as picking the second
 * (the reachability check downstream is what makes the final answer
 * deterministic).
 */
export function findStickyOverrideStylesheet(
  options: DetectOverrideStylesheetOptions,
): string | undefined {
  const prototypeRoot = options.prototypeRoot ?? options.appRoot
  let files: string[]
  try {
    files = walkAppCssFiles(options.appRoot).slice(0, MAX_SCANNED)
  } catch {
    return undefined
  }
  for (const abs of files) {
    let text: string
    try {
      text = fs.readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    if (!text.includes(BLOCK_START)) continue
    const rel = toRelative(prototypeRoot, abs)
    if (rel) return rel
  }
  return undefined
}

/**
 * Validate a configured destination the same way the shell and the server
 * gates do — `.css`, root-relative, no `node_modules`, no `..`. A bad value is
 * DROPPED rather than thrown on: a typo in an optional config key should cost
 * the ladder one rung, not the boot. (Same posture as `lanes` / `hosts`: an
 * opt-in setting failing to turn something on must never fail a boot.)
 */
export function normalizeConfiguredOverrideStylesheet(
  value: unknown,
): string | undefined {
  if (typeof value !== 'string') return undefined
  if (path.isAbsolute(value.trim())) return undefined
  const rel = value.trim().replace(/^\.?\//, '')
  if (rel.length === 0 || !rel.endsWith('.css')) return undefined
  const segments = rel.split('/')
  if (segments.includes('node_modules') || segments.includes('..')) {
    return undefined
  }
  return rel
}

/** `styling.overrideStylesheet` out of the prototype's config, or undefined. */
export function readConfiguredOverrideStylesheet(
  configRoot: string,
): string | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(
      fs.readFileSync(path.join(configRoot, CONFIG_FILENAME), 'utf8'),
    )
  } catch {
    // Missing config is the unconfigured default; a malformed one is already
    // reported by the loaders that read the same file for `readRoots` /
    // `lanes` / `hosts`, so this one stays quiet rather than triple-warning.
    return undefined
  }
  const styling = (raw as { styling?: unknown } | null)?.styling
  if (typeof styling !== 'object' || styling === null) return undefined
  return normalizeConfiguredOverrideStylesheet(
    (styling as { overrideStylesheet?: unknown }).overrideStylesheet,
  )
}

export function detectOverrideStylesheetFacts(
  options: DetectOverrideStylesheetOptions,
): OverrideStylesheetFacts {
  const configured = readConfiguredOverrideStylesheet(
    options.configRoot ?? options.appRoot,
  )
  const sticky = findStickyOverrideStylesheet(options)
  return {
    ...(configured ? { configured } : {}),
    ...(sticky ? { sticky } : {}),
  }
}

function toRelative(root: string, abs: string): string | undefined {
  const rel = path.relative(root, abs).split(path.sep).join('/')
  if (rel.length === 0 || rel.startsWith('..') || path.isAbsolute(rel)) {
    return undefined
  }
  return rel
}
