/**
 * Resolve a prototype's tsconfig path — the convention the vue-dts-meta /
 * react-dts-meta TS-checker extractors anchor to. Shared (audit Task 20
 * dedup) by every layer that needs to find "the" tsconfig for a prototype
 * root: `edit-service/build-manifest-source.ts` (serving), `onboarding/
 * orchestrator.ts` (the `installed` onboarding source), and
 * `drift/repair-component.ts` (single-component re-extraction).
 *
 * Precedence:
 *   1. `EDITOR_PROTOTYPE_TSCONFIG` env override — for prototypes whose
 *      config isn't one of the root candidates below (e.g. a nested
 *      `apps/web/tsconfig.json`). An override that doesn't resolve is a
 *      hard stop, NOT a fall-through: an explicit pointer that is wrong
 *      should surface, not be silently replaced by a guess.
 *   2. Each of {@link TSCONFIG_CANDIDATE_FILENAMES} under `<root>`, in order.
 *   3. `null` — no candidate exists; callers degrade to a checker-less path.
 *
 * **Why `jsconfig.json` is in the list.** It was missing until 2026-08-10, and
 * that made grounding all-or-nothing on a file a whole class of prototype
 * never ships: a JavaScript Vue app carries `jsconfig.json` and no tsconfig
 * at all. Because `build-manifest-source` skips `vue-component-meta`,
 * `library-dts-auto-scan` AND `react-dts-auto-scan` on a null result, the
 * miss cost every manifest, first-party ones included. Measured on a real
 * Vue 3 + Vite JS prototype (46 SFCs, 37 of them plain `<script setup>`, zero
 * `.ts` files, `jsconfig.json` only): grounding built **0** components before,
 * **46** after. `jsconfig.json` is the same JSON schema — TypeScript reads it
 * through the same `readConfigFile` — so no consumer had to change to accept one.
 *
 * **`allowJs` is deliberately NOT synthesized on top of a discovered config.**
 * That prototype's `jsconfig.json` sets only `paths` and `exclude`; it has no
 * `allowJs`, and `vue-component-meta` still extracted all 46 JS SFCs from it.
 * The `.d.ts` extractors don't need it either — `ts-program.ts` roots their
 * `ts.Program` at explicit declaration files, and a program rooted at `.d.ts`
 * resolves imports to `.d.ts`, so it never reads a `.js` file. Wrapping the
 * user's config in a synthesized `extends` shim to add the flag would buy
 * nothing measurable and would cost cache correctness: `fingerprintFile(tsconfigPath)`
 * is the manifest cache's context key, so fingerprinting a static shim instead
 * of the user's real config means edits to the real config stop invalidating
 * the cache.
 *
 * **Synthesizing a config when NONE exists is deliberately not done here**,
 * though it was measured to work (a default config dropped into `.desde/`
 * took a config-less React prototype from 0 to 5474 components). It is a file
 * WRITE, and this resolver is called by three layers plus every test that
 * builds a manifest source — turning "resolve a path" into "materialize a file
 * in the user's repo" needs its own review of placement, gitignore,
 * concurrent writes, read-only filesystems, and the cache-context key. All
 * five prototypes in the current test matrix ship a config, so it fixes
 * nothing measured today.
 *
 * Candidate order is "most specific first": `tsconfig.app.json` is Vite's
 * split-config convention where the root `tsconfig.json` is a bare
 * `references` stub with no usable `compilerOptions`, so it must win. A
 * project carrying both a `tsconfig.json` and a `jsconfig.json` (common —
 * the jsconfig is often an editor-only path-hints file) is a TypeScript
 * project; tsconfig wins.
 *
 * Each candidate is realpath'd (not just existence-checked) so the caller
 * gets a canonical, symlink-resolved path to hand the TS checker. Only
 * `node:fs`/`node:path` — deliberately dependency-free so any layer can
 * import it without pulling in the adapter set (this is exactly why the
 * logic was hand-copied three times before this extraction rather than
 * imported from `build-manifest-source.ts`, whose module also carries
 * heavier top-level imports).
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * Root-relative config filenames probed in order, after the
 * `EDITOR_PROTOTYPE_TSCONFIG` override. Exported so a caller reporting a
 * refusal can name what was actually looked for instead of hardcoding a
 * list that drifts (the diagnostic scripts in `tasks/scripts/` print it).
 */
export const TSCONFIG_CANDIDATE_FILENAMES = [
  'tsconfig.app.json',
  'tsconfig.json',
  'jsconfig.json',
] as const

export async function resolveTsconfig(root: string): Promise<string | null> {
  const override = process.env.EDITOR_PROTOTYPE_TSCONFIG
  if (override) {
    try {
      return await fs.realpath(override)
    } catch {
      return null
    }
  }
  for (const candidate of TSCONFIG_CANDIDATE_FILENAMES) {
    const full = path.join(root, candidate)
    try {
      return await fs.realpath(full)
    } catch {
      // not found, try the next candidate
    }
  }
  return null
}
