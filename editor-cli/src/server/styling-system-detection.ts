import { promises as fs } from "node:fs"
import { join } from "node:path"

/**
 * Detect which styling system a supervised prototype uses, so the shell can
 * emit React inline-style edits in the substrate's own idiom (the design-system-
 * aware principle: don't impose one styling convention — match what's there).
 *
 * This is the add-on seam for styling, sibling to {@link detectFramework}. It is
 * intentionally small and best-effort: it never throws and never blocks boot —
 * an undetectable substrate falls back to `"inline"`, which works on ANY React
 * app (a JSX `style={{}}` object is universal).
 *
 * **What each value means for the edit pipeline:**
 *   - `"tailwind"` — the `jsx-style` lane splices Tailwind utility classes into
 *     the element's `className` (clean, no style bloat — the Onlook approach).
 *   - `"css-modules"` — recognized but NOT yet wired to an applicator; the shell
 *     treats it as `"inline"` until the CSS-modules styling applicator lands
 *     (see tasks/editor-react-support.md). Returned so detection is
 *     forward-compatible.
 *   - `"inline"` — universal fallback: merge a JSX `style={{}}` object.
 *
 * **Detection signals (Tailwind):**
 *   1. `tailwindcss` in any dep set (`dependencies` / `devDependencies` /
 *      `peerDependencies`), OR
 *   2. a `tailwind.config.{js,cjs,mjs,ts}` at the repo root, OR
 *   3. a Tailwind v4 `@import "tailwindcss"` / `@tailwind` directive in a
 *      root-level CSS entry (Tailwind v4 is config-less, so the dep is the
 *      primary signal; the CSS scan is a cheap belt-and-suspenders).
 *
 * Vue prototypes also flow through here harmlessly — the result is simply
 * unused on the Vue path (Vue always uses the `scoped-css-override` lane).
 */
export type StylingSystem = "tailwind" | "css-modules" | "inline"

interface PackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

const TAILWIND_CONFIG_NAMES = [
  "tailwind.config.js",
  "tailwind.config.cjs",
  "tailwind.config.mjs",
  "tailwind.config.ts",
]

// Root-level CSS entries to scan for a Tailwind v4 import directive. Kept short
// and shallow — this is a best-effort signal, not an exhaustive search.
const CSS_ENTRY_CANDIDATES = [
  "src/index.css",
  "src/main.css",
  "src/styles.css",
  "src/app.css",
  "src/App.css",
  "src/global.css",
  "src/globals.css",
  "index.css",
  "styles.css",
]

const TAILWIND_CSS_DIRECTIVE = /@import\s+["']tailwindcss["']|@tailwind\b/

export async function detectStylingSystem(repoRoot: string): Promise<StylingSystem> {
  // 1. package.json dependency signal (covers Tailwind v3 + v4).
  try {
    const pkgRaw = await fs.readFile(join(repoRoot, "package.json"), "utf-8")
    const pkg = JSON.parse(pkgRaw) as PackageJson
    const allDeps: Record<string, string> = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
      ...(pkg.peerDependencies ?? {}),
    }
    if (allDeps["tailwindcss"]) return "tailwind"
  } catch {
    // No/unreadable package.json — fall through to file signals.
  }

  // 2. tailwind.config.* at the repo root (Tailwind v3).
  for (const name of TAILWIND_CONFIG_NAMES) {
    if (await fileExists(join(repoRoot, name))) return "tailwind"
  }

  // 3. Tailwind v4 import directive in a root-level CSS entry.
  for (const rel of CSS_ENTRY_CANDIDATES) {
    try {
      const css = await fs.readFile(join(repoRoot, rel), "utf-8")
      if (TAILWIND_CSS_DIRECTIVE.test(css)) return "tailwind"
    } catch {
      // Missing/unreadable candidate — try the next.
    }
  }

  // Default: universal inline styles. (css-modules detection is deferred until
  // its applicator exists — see module header.)
  return "inline"
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}
