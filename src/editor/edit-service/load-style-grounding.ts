/**
 * Load `ProjectStyleContext` from the prototype root + the grounding seam's
 * tokens. Replaces the pre-2026-07-25 loader (deleted as part of
 * grounding-phase2-tokens task 4) — the LLM edit lane no longer scans the
 * filesystem for `tailwind.config.*` / `*.tokens.json` itself; the caller
 * (the CLI edit handler) resolves tokens from `GroundingService.tokens`
 * (a `DesignTokenSource` composed over package + app stylesheets + package
 * css) and injects them here.
 *
 * `classTaxonomy` and `preprocessor` have no grounding-seam equivalent, so
 * this loader keeps the old raw `.vue` file walk verbatim (`scanVueFiles`
 * below, unchanged from the deleted module).
 *
 * `rawStyleFallback` — the old loader's raw tailwind-config-text +
 * token-file-fragment behavior — is collected ONLY when `opts.tokens` is
 * empty: the escape hatch for substrates the token seam can't parse yet.
 * When tokens are present, the fallback is skipped entirely (no filesystem
 * scan for it) — the grounding seam is assumed to be the better signal.
 *
 * Cached once per editor session by the caller (the CLI edit handler
 * memoizes the built `ProjectStyleContext` per `prototypeRoot`, same
 * lifecycle the old loader had) — this function itself does no caching, so
 * it stays a pure-ish (filesystem-reading) function that's easy to test in
 * isolation.
 */

import * as fs from 'fs'
import * as path from 'path'
import type { DesignToken } from '../core/design-tokens'
import type { ProjectStyleContext } from './llm-patch-prompt'

export interface LoadStyleGroundingOptions {
  /** Absolute path to the prototype root (the dir containing `package.json`). */
  prototypeRoot: string
  /**
   * Injected from the grounding seam (`GroundingService.tokens.listTokens()`).
   * This loader never builds token sources itself — tokens must never block
   * an edit, so the caller is responsible for the try/catch → `[]` fallback
   * before calling in.
   */
  tokens: readonly DesignToken[]
  /** Maximum class names to include in the taxonomy (default 50). */
  taxonomyLimit?: number
  /** File scan depth limit (default 6). */
  scanDepthLimit?: number
}

const TAILWIND_CONFIG_NAMES = [
  'tailwind.config.ts',
  'tailwind.config.js',
  'tailwind.config.cjs',
  'tailwind.config.mjs',
]

const DESIGN_TOKEN_PATTERNS: RegExp[] = [
  /\.tokens\.(ts|json)$/,
  /^tokens\.(ts|json)$/,
]

const TOKEN_DIR_NAMES = ['tokens', 'design-tokens']

const CLASS_REGEX = /class="([^"]+)"/g
const STYLE_LANG_REGEX = /<style[^>]*\blang=["']([^"']+)["']/

export function loadStyleGrounding(opts: LoadStyleGroundingOptions): ProjectStyleContext {
  const { prototypeRoot, tokens, taxonomyLimit = 50, scanDepthLimit = 6 } = opts

  const { taxonomy, preprocessor } = scanVueFiles(prototypeRoot, scanDepthLimit, taxonomyLimit)

  if (tokens.length > 0) {
    return {
      tokens,
      classTaxonomy: taxonomy,
      preprocessor,
    }
  }

  // Escape hatch: the grounding seam produced no structured tokens (e.g. a
  // substrate it can't parse yet). Fall back to the old raw-file scan.
  const tailwindConfig = readFirstExisting(prototypeRoot, TAILWIND_CONFIG_NAMES)
  const designTokens = collectDesignTokens(prototypeRoot, scanDepthLimit)
  const rawStyleFallback = renderRawStyleFallback(tailwindConfig, designTokens)

  return {
    tokens: [],
    classTaxonomy: taxonomy,
    preprocessor,
    ...(rawStyleFallback !== undefined ? { rawStyleFallback } : {}),
  }
}

function renderRawStyleFallback(
  tailwindConfig: string | undefined,
  designTokens: string | undefined,
): string | undefined {
  if (!tailwindConfig && !designTokens) return undefined
  const parts: string[] = []
  if (tailwindConfig) {
    parts.push('## Tailwind config\n')
    parts.push('```ts\n' + truncate(tailwindConfig, 8_000) + '\n```\n')
  }
  if (designTokens) {
    parts.push('## Design tokens (raw)\n')
    parts.push('```\n' + truncate(designTokens, 8_000) + '\n```\n')
  }
  return parts.join('\n')
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `\n... [truncated ${s.length - max} chars]`
}

function readFirstExisting(root: string, names: string[]): string | undefined {
  for (const name of names) {
    const p = path.join(root, name)
    try {
      const stat = fs.statSync(p)
      if (stat.isFile()) {
        return fs.readFileSync(p, 'utf-8')
      }
    } catch {
      /* not found — try next */
    }
  }
  return undefined
}

function collectDesignTokens(root: string, depth: number): string | undefined {
  const fragments: string[] = []
  walk(root, depth, (absPath, relPath) => {
    const base = path.basename(absPath)
    const inTokenDir = relPath
      .split(path.sep)
      .some((seg) => TOKEN_DIR_NAMES.includes(seg))
    const matchesPattern = DESIGN_TOKEN_PATTERNS.some((re) => re.test(base))
    if (!inTokenDir && !matchesPattern) return
    try {
      const text = fs.readFileSync(absPath, 'utf-8')
      fragments.push(`// ${relPath}\n${text}`)
    } catch {
      /* unreadable; skip */
    }
  })
  if (fragments.length === 0) return undefined
  return fragments.join('\n\n').slice(0, 32_000)
}

function scanVueFiles(
  root: string,
  depth: number,
  taxonomyLimit: number,
): { taxonomy: string[]; preprocessor: ProjectStyleContext['preprocessor'] } {
  const classCounts = new Map<string, number>()
  const langCounts = new Map<string, number>()
  walk(root, depth, (absPath) => {
    if (!absPath.endsWith('.vue')) return
    let content: string
    try {
      content = fs.readFileSync(absPath, 'utf-8')
    } catch {
      return
    }

    // Class name harvesting from static `class="..."` attributes only.
    // Skips dynamic `:class` bindings (which may be expressions, not literals).
    let match: RegExpExecArray | null
    while ((match = CLASS_REGEX.exec(content)) !== null) {
      const classes = match[1].split(/\s+/).filter(Boolean)
      for (const c of classes) {
        classCounts.set(c, (classCounts.get(c) ?? 0) + 1)
      }
    }

    // Detect <style lang="...">.
    const styleMatch = STYLE_LANG_REGEX.exec(content)
    if (styleMatch) {
      const lang = styleMatch[1].toLowerCase()
      langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1)
    }
  })

  const taxonomy = Array.from(classCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, taxonomyLimit)
    .map(([name]) => name)

  // Most-frequent preprocessor wins. Default 'css' if no <style lang> found.
  let preprocessor: ProjectStyleContext['preprocessor'] = 'css'
  if (langCounts.size > 0) {
    const top = Array.from(langCounts.entries()).sort((a, b) => b[1] - a[1])[0][0]
    if (top === 'scss' || top === 'sass' || top === 'less' || top === 'stylus') {
      preprocessor = top
    } else {
      preprocessor = 'unknown'
    }
  }

  return { taxonomy, preprocessor }
}

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

function walk(
  root: string,
  depth: number,
  visit: (absPath: string, relPath: string) => void,
): void {
  function inner(dir: string, currentDepth: number): void {
    if (currentDepth > depth) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      const rel = path.relative(root, abs)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        if (entry.name.startsWith('.')) continue
        inner(abs, currentDepth + 1)
      } else if (entry.isFile()) {
        visit(abs, rel)
      }
    }
  }
  inner(root, 0)
}
