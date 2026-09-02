/**
 * Tailwind-specific detector for the neutral `importantUtilities` substrate
 * capability (`src/editor/core/substrate-style-capabilities.ts`).
 *
 * Lives in the ADAPTER layer on purpose: "Tailwind compiles utilities with
 * `!important` when you ask it to" is substrate knowledge, and core /
 * verification must never learn it (CLAUDE.md § "Product positioning"). The
 * neutral composition entry that calls this is
 * `src/editor/onboarding/detect-style-capabilities.ts`; a React + Material UI
 * team would add a sibling detector there, not fork this file.
 *
 * **Two shapes, one meaning.**
 *  - **Tailwind v4** — global important mode is a modifier on the import:
 *    `@import "tailwindcss" important;` (also with a subpath, `url()`, single
 *    quotes, or alongside other options: `@import "tailwindcss" source(none)
 *    important;`). Every generated utility then carries `!important` INSIDE the
 *    `utilities` cascade layer, which strictly outranks Editor's unlayered
 *    `!important` element override — that scope cannot win, ever.
 *  - **Tailwind v3** — `important: true` in `tailwind.config.{js,cjs,mjs,ts}`.
 *    v3 emits no real `@layer`, so its important utilities sit in the SAME
 *    unlayered-important tier as Editor's override and source order decides:
 *    the element scope is unreliable rather than impossible. Reported under the
 *    same capability because the user-visible consequence is the same ("my edit
 *    sometimes/always doesn't take effect"), and the UI only ever
 *    DEPRIORITISES the scope — it never removes it. Note `important: '#app'`
 *    (v3's selector strategy) is a different mechanism (extra specificity, no
 *    `!important`) and is deliberately NOT matched.
 *
 * **Conservative by construction.** A false positive here needlessly steers the
 * user away from a scope that works, so every probe fails CLOSED: CSS comments
 * are stripped before matching, the `important` option must be its own
 * whitespace-delimited token (never a substring), the v3 value must be the
 * literal `true`, and any read/parse failure contributes nothing.
 */
import { promises as fs } from 'fs'
import * as path from 'path'
import { walkAppCssFiles } from '../css-custom-properties/discover'

/** Which probe fired, for logs and the CLI report — never user-facing copy. */
export type TailwindImportantSignal = 'v4-import-important' | 'v3-config-important'

export interface TailwindImportantDetection {
  /** True only when a probe positively matched. "Can't tell" is `false`. */
  detected: boolean
  /** Which probe matched, and in which file. Absent when `detected` is false. */
  evidence?: { signal: TailwindImportantSignal; file: string }
}

const NOT_DETECTED: TailwindImportantDetection = { detected: false }

/**
 * Cap on CSS files read by the v4 probe. The shared walk is already bounded
 * (depth 6, no `node_modules`), but this runs at CLI boot — a pathological tree
 * shouldn't turn a best-effort signal into a startup stall.
 */
const MAX_CSS_FILES = 200

const TAILWIND_CONFIG_NAMES = [
  'tailwind.config.js',
  'tailwind.config.cjs',
  'tailwind.config.mjs',
  'tailwind.config.ts',
]

/** `/* … *\/` block comments — stripped so a commented-out directive can't match. */
const CSS_BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g

/**
 * A `@import` of the `tailwindcss` package (optionally a subpath, optionally
 * `url(…)`-wrapped), capturing everything between the specifier and the `;` as
 * the option list. The options are then tokenized rather than regex-scanned, so
 * `important` must appear as its own word.
 */
const TAILWIND_IMPORT_RE =
  /@import\s+(?:url\(\s*)?(["'])tailwindcss(?:\/[A-Za-z0-9_./-]*)?\1\s*\)?([^;]*);/g

/** JS line + block comments, for the v3 config probe. */
const JS_COMMENT_RE = /\/\*[\s\S]*?\*\/|\/\/[^\n\r]*/g

/**
 * `important: true` as a real object key — anchored to a preceding `{`, `,`, `;`
 * or line start so `notImportant: true` (or any longer identifier ending in
 * `important`) can't match, and requiring the literal `true` so v3's
 * `important: '#app'` selector strategy is excluded. Quoted keys
 * (`"important": true`, JSON-ish configs) are accepted.
 */
const V3_IMPORTANT_TRUE_RE =
  /(?:^|[{,;])\s*(?:important|"important"|'important')\s*:\s*true\b/m

/**
 * Whether this CSS text enables Tailwind v4 global important mode.
 * Pure — exported for direct unit testing of the spelling matrix.
 */
export function cssEnablesTailwindImportantMode(css: string): boolean {
  const withoutComments = css.replace(CSS_BLOCK_COMMENT_RE, '')
  // `matchAll` on a /g regex — a fresh iterator per call, so no lastIndex leak.
  for (const match of withoutComments.matchAll(TAILWIND_IMPORT_RE)) {
    const options = match[2] ?? ''
    const tokens = options.trim().split(/\s+/)
    if (tokens.includes('important')) return true
  }
  return false
}

/**
 * Whether this `tailwind.config.*` source enables Tailwind v3 global important
 * mode (`important: true`). Pure — exported for direct unit testing.
 *
 * String-matched rather than evaluated: importing a config would EXECUTE
 * customer code at boot, which the onboarding layer keeps behind explicit
 * user-initiated actions (see `docs/grounding-pipeline.md` § Phase 3). A config
 * that computes `important` dynamically therefore reads as "can't tell" →
 * `false`, which is the safe direction.
 */
export function configEnablesTailwindImportantMode(source: string): boolean {
  const withoutComments = source.replace(JS_COMMENT_RE, '')
  return V3_IMPORTANT_TRUE_RE.test(withoutComments)
}

/**
 * Probe `prototypeRoot` for Tailwind global important mode. Never throws;
 * "can't tell" is reported as not-detected.
 */
export async function detectTailwindImportantMode(
  prototypeRoot: string,
): Promise<TailwindImportantDetection> {
  // v4 — the import modifier, in any of the prototype's own CSS files.
  let cssFiles: string[] = []
  try {
    cssFiles = walkAppCssFiles(prototypeRoot).slice(0, MAX_CSS_FILES)
  } catch {
    cssFiles = []
  }
  for (const file of cssFiles) {
    let css: string
    try {
      css = await fs.readFile(file, 'utf8')
    } catch {
      continue // unreadable — contributes nothing
    }
    if (cssEnablesTailwindImportantMode(css)) {
      return { detected: true, evidence: { signal: 'v4-import-important', file } }
    }
  }

  // v3 — `important: true` in a root-level tailwind config.
  for (const name of TAILWIND_CONFIG_NAMES) {
    const file = path.join(prototypeRoot, name)
    let source: string
    try {
      source = await fs.readFile(file, 'utf8')
    } catch {
      continue // absent/unreadable — try the next name
    }
    if (configEnablesTailwindImportantMode(source)) {
      return { detected: true, evidence: { signal: 'v3-config-important', file } }
    }
  }

  return NOT_DETECTED
}
