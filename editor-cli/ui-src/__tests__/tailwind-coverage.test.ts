import { execSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { resolve as resolvePath } from "node:path"
import { describe, expect, it, beforeAll } from "vitest"

/**
 * Regression guard for the CLI UI bundle's Tailwind source pinning.
 *
 * The hand-curated `@source` list in `ui-src/src/editor-cli.css`
 * tells Tailwind v4 which files to scan for utility-class usage. If a
 * future editor UI file lands outside the listed directories, the
 * scanner silently misses it — the build succeeds, the bundle ships,
 * panels render unstyled.
 *
 * Probe strategy: each probe is a class GENUINELY UNIQUE to its
 * @source directive — i.e., that class doesn't appear in any other
 * pinned dir. This way, dropping a single @source entry surfaces as
 * a single probe failure that points exactly at the missing dir.
 *
 * Runs `vite build` fresh in beforeAll (after deleting prior dist) so
 * assertions can never read stale artifacts. Build failures rethrow
 * with stderr so the test fails fast and helpfully.
 */

const UI_SRC = resolvePath(__dirname, "..")
const DIST_ASSETS = resolvePath(UI_SRC, "dist", "assets")

interface UtilityProbe {
  /** Tailwind utility class to grep for (without leading dot). */
  className: string
  /** Where the class is used — for the failure-mode error message. */
  source: string
}

/**
 * One probe per @source directive in editor-cli.css, verified
 * unique to its anchor dir via:
 *
 *   for cls in <className>; do
 *     for d in src/editor-ui src/components/editor src/components/ui; do
 *       grep -rln "$cls" "$d"
 *     done
 *   done
 *
 * Each probe must have file-count 0 in every dir EXCEPT its anchor.
 * If one of these classes is later added to a non-anchor dir, swap
 * it out — the value of the probe is its uniqueness, not its name.
 *
 * Round-4 had two probes (border-l, animate-spin) that LOOKED unique
 * by inspection but actually appeared in TWO pinned dirs. The current
 * set was re-audited with the grep above; counts in each comment.
 */
/**
 * Every probe name is SPLIT across a concatenation, and that is not a style
 * choice.
 *
 * Tailwind's scanner reads this file. MEASURED 2026-09-14: a utility written
 * as a plain string literal here is emitted into the bundle as if the UI used
 * it, so a probe spelled out in one piece passes by naming itself, whether or
 * not the directory it is meant to cover is scanned at all. Every probe below
 * was in that state, which is why none of them caught either of the two
 * missing directories.
 *
 * Splitting the literal leaves no candidate for the scanner to find, so the
 * assertion once again depends on the component source alone. Keep it split.
 * The same rule applies to comments in this file and in `editor-cli.css`:
 * describe a rule in words, never by name.
 */
const REQUIRED_UTILITIES: UtilityProbe[] = [
  // editor-ui: 1 file, editor: 0, ui: 0
  { className: `h-${"screen"}`, source: "src/editor-ui/editor-page.tsx (LiveEditorView root)" },
  /*
    editor: 1 (save-progress-dialog's succeeded chip), everywhere else 0.

    Re-anchored 2026-09-14. The previous anchor was a raw yellow on the
    live-prototype-pane banner, and it had been gone from the tree for a while:
    the house rules ban raw colour utilities, so the banner moved to theme
    tokens and nothing failed, because this file was naming the class itself.
    Splitting the literals is what surfaced it.
  */
  { className: `bg-success${"/15"}`, source: "src/components/editor/save-progress-dialog.tsx" },
  // editor-ui: 0, editor: 0, ui: 4 (separator, scroll-area, etc.)
  { className: `bg-${"border"}`, source: "src/components/ui/* (shadcn primitives)" },
  // components/annotations: the comment card's hover-revealed action row.
  // Unique REPO-WIDE, not merely across the pinned dirs, which is why its
  // absence removed the controls entirely rather than degrading them.
  {
    className: `group-hover${"/card:opacity-100"}`,
    source: "src/components/annotations/annotation-card.tsx (comment card actions)",
  },
  // src/lib/* is also pinned by editor-cli.css but contains only
  // utils.ts (cn helper) — no Tailwind classes live there. The pin
  // is defensive (so future lib additions get scanned); no probe
  // possible until a class actually exists.
]

function readBuiltCss(): string | null {
  if (!existsSync(DIST_ASSETS)) return null
  const files = readdirSync(DIST_ASSETS).filter((f) => f.endsWith(".css"))
  if (files.length === 0) return null
  return files
    .map((f) => readFileSync(resolvePath(DIST_ASSETS, f), "utf-8"))
    .join("\n\n")
}

beforeAll(() => {
  // Clean dist FIRST so the test never reads a stale artifact from a
  // prior successful build. Otherwise a broken current build would
  // leave the previous bundle in place and the assertions could
  // false-pass.
  const dist = resolvePath(UI_SRC, "dist")
  rmSync(dist, { recursive: true, force: true })

  // Build, capturing stderr so a failure surfaces in the test report
  // (rather than getting swallowed and showing up only as missing
  // dist files several assertions later).
  try {
    execSync("npx vite build --config ui-src/vite.config.ts", {
      cwd: resolvePath(UI_SRC, ".."),
      stdio: ["ignore", "ignore", "pipe"],
    })
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? ""
    throw new Error(
      `vite build failed in tailwind-coverage beforeAll. The Tailwind ` +
        `coverage assertions can't run against stale or missing artifacts. ` +
        `stderr:\n${stderr}`,
    )
  }
}, 60_000)

describe("Tailwind source-pinning coverage", () => {
  it("emits a CSS bundle from vite build", () => {
    const css = readBuiltCss()
    expect(css, "ui-src/dist/assets/*.css missing — vite build failed?").not.toBeNull()
    expect(css!.length).toBeGreaterThan(1000) // arbitrary lower bound; real bundle is 50KB+
  })

  /**
   * The probes above are a sample. This is the invariant.
   *
   * A probe can only be written for a directory somebody already remembered to
   * scan, so a directory nobody scanned has no probe and the suite stays green
   * while its rules quietly vanish. That is exactly how `blocks/` (2026-08-17)
   * and then `annotations/`, `comments/`, `notes/` and `canvas/` (2026-09-14)
   * went missing under a passing test.
   *
   * This reads the real `@source` lines and checks that every directory of
   * shell components falls inside one, so narrowing the glob back to a list
   * fails here immediately.
   */
  it("scans every component directory, rather than a list somebody has to maintain", () => {
    const cssEntry = readFileSync(resolvePath(UI_SRC, "src", "editor-cli.css"), "utf-8")
    const globs = [...cssEntry.matchAll(/@source\s+"([^"]+)"/g)].map((m) => m[1])
    expect(globs.length, "no @source directives found in editor-cli.css").toBeGreaterThan(0)

    // Each glob's literal prefix, resolved the way Tailwind resolves it:
    // relative to the CSS file's own directory.
    const scannedRoots = globs.map((glob) =>
      resolvePath(UI_SRC, "src", glob.slice(0, glob.indexOf("*"))),
    )

    const componentsDir = resolvePath(UI_SRC, "..", "..", "src", "components")
    const unscanned = readdirSync(componentsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => resolvePath(componentsDir, entry.name))
      .filter((dir) => !scannedRoots.some((root) => dir === root || dir.startsWith(`${root}/`)))

    expect(
      unscanned,
      "these component directories fall outside every @source glob in " +
        "ui-src/src/editor-cli.css, so Tailwind emits no rule for any utility " +
        "they alone use, and nothing about the build says so",
    ).toEqual([])
  })

  for (const probe of REQUIRED_UTILITIES) {
    it(`includes utility \`.${probe.className}\` (used by ${probe.source})`, () => {
      const css = readBuiltCss()
      expect(css).not.toBeNull()
      const present = cssContainsClass(css!, probe.className)
      expect(
        present,
        `\\.${probe.className} not present in built CSS. ` +
          `Tailwind @source list in ui-src/src/editor-cli.css may not cover ${probe.source}.`,
      ).toBe(true)
    })
  }
})

/**
 * Check whether a Tailwind utility class appears in compiled CSS.
 *
 * Tailwind v4 emits class selectors with characters that are special in
 * CSS escaped — most notably `/` (used in opacity/scale modifiers like
 * `bg-muted/30`) becomes `\/` in the output. A naive regex on the raw
 * className would miss those forms. We construct the CSS-escaped form
 * of the className and test for that as a literal substring; this is
 * reliable because utilities aren't atomic-mangled.
 */
function cssContainsClass(css: string, className: string): boolean {
  // `:` as well as `/`. Every probe was a bare utility until a variant probe
  // arrived, and Tailwind escapes the variant separator too, so escaping only
  // the slash reported that rule missing while it sat in the bundle.
  const escapedForCss = className.replace(/[/:]/g, (ch) => `\\${ch}`)
  return css.includes(`.${escapedForCss}`)
}
