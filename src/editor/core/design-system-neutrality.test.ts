/**
 * CLAUDE.md states a hard rule: "Core types in `src/editor/core/` must remain
 * framework- and design-system-neutral." Until 2026-08-09 nothing enforced it,
 * and it had quietly drifted — `DesignSystemId` was written
 * `'acme-ds' | (string & {})`, naming one vendor in a core type.
 *
 * A rule with no test is a preference. This is the test.
 *
 * WHAT IT CHECKS, and why each bound is where it is:
 *
 *  - **Executable code only.** Comments are stripped first. A doc example
 *    ("e.g. `.acme-empty-state`") explains the shape of a real problem and
 *    costs nothing; a string literal or identifier changes behaviour. Auditing
 *    the whole repo on 2026-08-09 found 77 comment references against 28 code
 *    references, so a test that failed on prose would be almost pure noise and
 *    would be deleted rather than obeyed.
 *
 *  - **`src/editor/core/` only.** NOT the adapters, which exist precisely to
 *    hold vendor specifics, and not `edit-service/build-manifest-source.ts`,
 *    whose job is composing concrete sources. Widening this would flag the
 *    architecture working as designed.
 *
 *  - **No importing from `../adapters/`.** The dependency direction is the
 *    real invariant: adapters know about core, never the reverse. A core
 *    module reaching into a concrete adapter is coupling even when it manages
 *    to avoid saying a vendor's name.
 *
 * `FrameworkId` deliberately keeps its `'vue3' | 'react'` union and is not in
 * scope here: adapters branch on those literals, so they are load-bearing.
 * Nothing branches on a design-system id.
 */
// @vitest-environment node
//
// Filesystem test: the default jsdom environment rewrites `import.meta.url` to
// a non-file scheme, so path resolution from it throws at collection time.
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Vitest runs from the repo root (vitest.config.ts lives there).
const CORE_DIR = resolve(process.cwd(), 'src/editor/core')

/**
 * Concrete design systems. Matched case-insensitively as whole-ish words, so
 * `kong` does not fire on `kongregate` and `mui` does not fire on `muistate`.
 */
const VENDOR_MARKERS = [
  // `kong`/`kongponents` stay listed deliberately. The Kongponents adapter,
  // token preset and overrides were deleted repo-wide; this guard is what
  // stops them creeping back into neutral core code. A hit here is a bug.
  'kong',
  'kongponents',
  'material-ui',
  'vuetify',
  'primevue',
  'naive-ui',
  'chakra',
  'antd',
  'ant-design',
]

/** Strips block and line comments so only executable text is examined. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function coreFiles(dir = CORE_DIR, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      coreFiles(full, acc)
      continue
    }
    if (!/\.ts$/.test(entry)) continue
    if (/\.test\.ts$/.test(entry)) continue
    acc.push(full)
  }
  return acc
}

describe('src/editor/core stays design-system-neutral', () => {
  const files = existsSync(CORE_DIR) ? coreFiles() : []

  it('finds core modules to check (guards against a vacuous pass)', () => {
    // Without this, a refactor that moves or renames the directory turns every
    // assertion below into a loop over zero files that reports success.
    expect(files.length).toBeGreaterThan(5)
  })

  it('names no concrete design system in executable code', () => {
    const offenders: string[] = []
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'))
      code.split('\n').forEach((line, i) => {
        for (const marker of VENDOR_MARKERS) {
          if (new RegExp(`\\b${marker}\\b`, 'i').test(line)) {
            offenders.push(`${file.replace(CORE_DIR + '/', 'src/editor/core/')}:${i + 1} → ${line.trim()}`)
          }
        }
      })
    }
    expect(offenders, `core must not name a design system:\n${offenders.join('\n')}`).toEqual([])
  })

  it('never imports from the adapters layer', () => {
    const offenders: string[] = []
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'))
      if (/from\s+['"][^'"]*adapters\//.test(code)) {
        offenders.push(file.replace(CORE_DIR + '/', 'src/editor/core/'))
      }
    }
    expect(offenders, `core must not import adapters:\n${offenders.join('\n')}`).toEqual([])
  })
})
