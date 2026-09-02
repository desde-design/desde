import { promises as fs } from "node:fs"
import { join } from "node:path"
import type { Framework, HostDetection, HostEvidence, SourceLanguage } from "../hosts/types.js"

/**
 * Read a repo and say what it IS, without booting anything.
 *
 * **Detection emits evidence, not a verdict** (rewritten 2026-08-11, milestone
 * 12 of `tasks/dev-server-hosts.md`). It used to answer with a single
 * `PrototypeHost` — `vite-supervised` | `vite-meta` | `next` — and those names
 * described OUR boot path rather than the repo: `vite-meta` meant nothing more
 * than "a framework we recognise and cannot supervise". Two consequences
 * followed from that shape, and both were bugs:
 *
 *  1. **First marker wins, silently.** `META_FRAMEWORK_MARKERS.find(...)`
 *     returned `nuxt` for a repo carrying both `nuxt` and `astro`, with no way
 *     to say the answer was a guess. A wrong host boots, serves 200s, and
 *     stamps nothing — the failure class this whole design is organised around.
 *  2. **Refusals about us, addressed to the user.** `missing-vite`,
 *     `no-vite-config` and `no-next-config` refused repos on the strength of
 *     what the OLD boot path needed. A Next app runs fine with no
 *     `next.config`, and the in-process Next host primes its config in memory —
 *     so refusing it was refusing a repo we can drive.
 *
 * Now the result carries {@link HostDetection}: ranked {@link HostEvidence}
 * candidates with the facts that produced each one, the multi-valued source
 * language set, and the single-valued shell framework. `hosts/resolve.ts`
 * adjudicates — ambiguity refusal, `--host` override, the `unknown` downgrade
 * to attach mode — and this file decides nothing.
 *
 * **What we check.**
 * 1. `package.json` exists + parses.
 * 2. Framework: Vue 3 or React (any of `dependencies`, `devDependencies`,
 *    `peerDependencies`) — this selects the source-tag stamper and is asked of
 *    every host.
 * 3. Host evidence: a `next` dependency, a meta-framework marker (`nuxt` /
 *    `astro` / `@react-router/dev`), a `vite` dependency, a root config file for
 *    any of them. A dependency alone is `likely`; a dependency plus its config
 *    file is `certain`.
 *
 * **What we DON'T check.**
 * - Whether the package is INSTALLED. Detection reads `package.json` — fast,
 *   offline, no `node_modules` walk. Each host's `probe()` reads `node_modules`
 *   and refuses with `host-package-missing` if a declared package is absent.
 *   That split is deliberate (`tasks/dev-server-hosts.md` § 1, rule 6).
 * - That the config is compatible with our plugin injection. (Each host's
 *   `probe`/`boot` owns that; attach mode's stamping preflight owns the
 *   equivalent for a config we never load.)
 * - Specific Vue/Vite versions. We trust >= the major.
 * - Whether a dev server is running at the `--attach` URL. Runtime condition,
 *   not repo shape.
 *
 * **The design system is deliberately not part of the check** — see the long
 * comment at the bottom of this file.
 */

export type FrameworkDetectionResult =
  | ({ ok: true } & HostDetection)
  | {
      ok: false
      /**
       * Four, and each is a statement about the REPO rather than about our boot
       * path. `missing-vite`, `no-vite-config` and `no-next-config` were deleted
       * at milestone 12: they described what `bootSupervisor` needed, and a repo
       * that fails them still has an attach path, so they became an absent or
       * lower-confidence candidate instead of a refusal.
       */
      reason:
        | "no-package-json"
        | "malformed-package-json"
        | "missing-framework"
        | "wrong-vue-major"
      message: string
    }

interface PackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

const VITE_CONFIG_NAMES = ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.cjs"]

/**
 * Next reads these in order and stops at the first hit. `.ts` is listed first
 * because that is what `create-next-app` writes today; the rest are Next's own
 * supported set.
 *
 * A Next app can legally run with NO config file at all, and since milestone 10
 * the in-process Next host can boot one — it materializes the Turbopack loader
 * itself and primes the resolved config in memory. So a missing `next.config` is
 * NOT a refusal any more; it only costs the candidate its `certain` confidence.
 * Attach mode still needs the file, and its stamping preflight generates one
 * with the exact block to write (exit 5), which is a better answer than the exit
 * 3 this file used to give.
 */
const NEXT_CONFIG_NAMES = [
  "next.config.ts",
  "next.config.js",
  "next.config.mjs",
  "next.config.cjs",
  "next.config.mts",
  "next.config.cts",
]

const NUXT_CONFIG_NAMES = ["nuxt.config.ts", "nuxt.config.js", "nuxt.config.mjs"]
const ASTRO_CONFIG_NAMES = ["astro.config.mjs", "astro.config.ts", "astro.config.js"]

/**
 * The four Vite meta-frameworks, in ranking order, each with the dependency
 * that marks it and the config files that corroborate.
 *
 * These generate their own HTML in their own dev server, which is why a plain
 * Vite server serves them 404 (MEASURED, both SSR and SPA mode) and why each has
 * its own in-process host rather than riding the supervisor.
 *
 * SvelteKit is deliberately absent — architecturally it belongs here, but no
 * Svelte source-tag stamper exists, so accepting it would promise an edit
 * round-trip we cannot deliver. It keeps falling through to `missing-framework`.
 * See the note in `tasks/dev-server-hosts.md` § 5, milestone 12.
 */
const META_HOSTS: ReadonlyArray<{
  hostId: "nuxt" | "astro" | "react-router"
  dependency: string
  /** React Router's config is a plain root `vite.config.*`. */
  configNames: readonly string[]
}> = [
  { hostId: "nuxt", dependency: "nuxt", configNames: NUXT_CONFIG_NAMES },
  { hostId: "astro", dependency: "astro", configNames: ASTRO_CONFIG_NAMES },
  { hostId: "react-router", dependency: "@react-router/dev", configNames: VITE_CONFIG_NAMES },
]

export async function detectFramework(repoRoot: string): Promise<FrameworkDetectionResult> {
  const warnings: string[] = []

  // 1. package.json
  const pkgPath = join(repoRoot, "package.json")
  let pkgRaw: string
  try {
    pkgRaw = await fs.readFile(pkgPath, "utf-8")
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      return {
        ok: false,
        reason: "no-package-json",
        message: `No package.json at ${pkgPath}. Editor needs a Node project with Vue 3 or React. See https://desde.design/docs/quickstart/editor#the-repository-gate.`,
      }
    }
    return {
      ok: false,
      reason: "malformed-package-json",
      message: `Could not read ${pkgPath}: ${(err as Error).message}`,
    }
  }
  let pkg: PackageJson
  try {
    pkg = JSON.parse(pkgRaw) as PackageJson
  } catch (err) {
    return {
      ok: false,
      reason: "malformed-package-json",
      message: `Failed to parse ${pkgPath}: ${(err as Error).message}`,
    }
  }

  const allDeps: Record<string, string> = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
  }

  // 2. Framework FIRST, because every host needs the answer and because a Vue 2
  //    repo is out of scope no matter which dev server it runs.
  const probe = probeFramework(allDeps, pkgPath)
  if (!probe.ok) return probe
  warnings.push(...probe.warnings)
  const framework = probe.framework

  // 3. Host evidence, ranked. Nothing here refuses; an empty list is the
  //    `unknown` downgrade and `resolve.ts` owns what that means.
  const candidates = await collectHostEvidence(repoRoot, allDeps)

  // NO DESIGN-SYSTEM WARNING IS EMITTED HERE, deliberately.
  //
  // There used to be one, naming a specific vendor's package and claiming
  // the component-manifest pipeline targeted it. Removed 2026-08-09 because
  // it had become false, and it was the only place the product told a user
  // it was shaped around one design system.
  //
  // It stopped being true on 2026-06-01, when `scanInstalledVueLibraries`
  // (src/editor/adapters/vue-dts-meta/auto-scan.ts) began walking
  // node_modules and building a full-fidelity manifest for ANY installed Vue
  // library shipping per-component `.vue.d.ts` — no per-library code and no
  // per-vendor knowledge. A Naive UI or PrimeVue project gets the same
  // treatment as any other.
  //
  // It also cannot be answered from here. This function reads package.json
  // dependency NAMES; whether a manifest can actually be extracted depends on
  // what is installed on disk and what dts layout it ships. Guessing from a
  // name would keep warning the one substrate that works while staying silent
  // for a library that genuinely yields nothing.
  //
  // The accurate signal already exists downstream: `GroundingHealth`
  // (src/editor/core/grounding-health.ts) records each source's real coverage as
  // the bundle is built, and `useDesignSystems` surfaces it. That is measured
  // rather than inferred, so it is where a "no design system found" message
  // belongs if one is ever wanted.

  return {
    ok: true,
    candidates,
    languages: languagesFor(framework, candidates),
    framework,
    warnings,
  }
}

/**
 * Which source dialects this repo contains.
 *
 * `astro` rides along when the Astro candidate RANKS FIRST, because `.astro`
 * template markup has NO stamper in v1 and that gap has to be a declared,
 * printed fact rather than a silence the user discovers by clicking. Gated on
 * the ranking rather than on mere presence: a Next repo carrying `astro` for a
 * docs sub-package is served by the Next host, which never sees an `.astro`
 * file, and reporting the gap there would be a warning about nothing. The island
 * dialect comes from `framework`, as it always has.
 *
 * **Deliberately not widened past the framework.** A repo declaring both `vue`
 * and `react` gets ONE island language, not two: `core.ts` injects a single
 * framework-gated stamper, so listing both would make `StampingCoverage` claim a
 * dialect nothing stamps — a coverage claim with nothing behind it, which is the
 * exact failure the coverage module exists to prevent. Genuine dual-island
 * support needs the (language × channel) provider table in `hosts/stampers.ts`;
 * see `tasks/dev-server-hosts.md` § 5, milestone 12.
 */
function languagesFor(framework: Framework, candidates: readonly HostEvidence[]): SourceLanguage[] {
  const island: SourceLanguage = framework === "react" ? "jsx" : "vue-sfc"
  return candidates[0]?.hostId === "astro" ? ["astro", island] : [island]
}

/**
 * Every in-process host this repo could be, most specific first.
 *
 * **Ranking is a rule, not a heuristic** (`tasks/dev-server-hosts.md` § 1):
 *
 *  - `next` beats everything. Next projects legitimately carry `vite` for tests,
 *    and a stray `astro` for a docs sub-package; the host that owns the dev
 *    server wins.
 *  - a meta-host subsumes `vite`. Nuxt / Astro / React Router all declare or
 *    imply Vite, so the bare `vite` candidate is dropped when one matched — the
 *    regression that motivated the tier was React Router passing the old
 *    vite+react+vite.config gate and then serving HTTP 404.
 *  - the `vite` candidate survives on EITHER signal. `vite` in dependencies OR a
 *    root `vite.config.*` is enough for `likely`; both make it `certain`. The
 *    old gate demanded the dependency and refused without it, which refuses a
 *    perfectly drivable monorepo package whose `vite` is hoisted to the
 *    workspace root and not re-declared.
 */
async function collectHostEvidence(
  repoRoot: string,
  allDeps: Record<string, string>,
): Promise<HostEvidence[]> {
  const candidates: HostEvidence[] = []

  if (allDeps["next"]) {
    const config = await firstExisting(repoRoot, NEXT_CONFIG_NAMES)
    candidates.push({
      hostId: "next",
      confidence: config ? "certain" : "likely",
      because: config
        ? [`"next" is a dependency`, `${config} is present`]
        : [`"next" is a dependency`, "no next.config.* at the root"],
    })
  }

  for (const meta of META_HOSTS) {
    if (!allDeps[meta.dependency]) continue
    const config = await firstExisting(repoRoot, meta.configNames)
    candidates.push({
      hostId: meta.hostId,
      confidence: config ? "certain" : "likely",
      because: config
        ? [`"${meta.dependency}" is a dependency`, `${config} is present`]
        : [
            `"${meta.dependency}" is a dependency`,
            `none of ${meta.configNames.join(", ")} is at the root`,
          ],
    })
  }

  // The bare `vite` candidate, kept only when nothing more specific claimed the
  // repo. A Next app's `vite` is for its unit tests and a meta-framework's is
  // its own engine; in both cases a plain Vite server is the host that boots,
  // serves 200s and stamps nothing.
  if (candidates.length === 0) {
    const viteDep = allDeps["vite"]
    const viteConfig = await firstExisting(repoRoot, VITE_CONFIG_NAMES)
    if (viteDep || viteConfig) {
      const because: string[] = []
      if (viteDep) because.push(`"vite" is a dependency`)
      if (viteConfig) because.push(`${viteConfig} is present`)
      candidates.push({
        hostId: "vite",
        confidence: viteDep && viteConfig ? "certain" : "likely",
        because,
      })
    }
  }

  return candidates
}

/** First of `names` that exists under `dir`, or null. */
async function firstExisting(dir: string, names: ReadonlyArray<string>): Promise<string | null> {
  for (const name of names) {
    try {
      await fs.access(join(dir, name))
      return name
    } catch {
      /* not present — try next */
    }
  }
  return null
}

/**
 * Which source-tag stamper this repo needs — Vue SFC template vs JSX — from its
 * dependency names alone. Host-independent: the stamp is build-time and
 * framework-specific, and every host has to answer this question. Only WHERE the
 * stamper gets injected differs (our supervised Vite config, the user's own Vite
 * config, or a Turbopack loader).
 *
 * Vue takes precedence if both are present (a Vue app may pull React in
 * transitively; the primary substrate is what has the SFCs).
 *
 * **Next is React by construction**, and `react` may be resolved through the
 * `next` package rather than declared — so a Next app with an undeclared `react`
 * is still a React app and must not fall through to `missing-framework`.
 */
function probeFramework(
  allDeps: Record<string, string>,
  pkgPath: string,
):
  | { ok: true; framework: Framework; warnings: string[] }
  | Extract<FrameworkDetectionResult, { ok: false }> {
  const warnings: string[] = []
  const vueRange = allDeps["vue"]
  const reactRange = allDeps["react"]

  if (vueRange) {
    const vueMajor = inferMajor(vueRange)
    if (vueMajor !== null && vueMajor !== 3) {
      return {
        ok: false,
        reason: "wrong-vue-major",
        message: `${pkgPath}: 'vue' is at major ${vueMajor}; Editor supports only Vue 3. Vue 2 support is not on the roadmap. See https://desde.design/docs/quickstart/editor#the-repository-gate.`,
      }
    }
    // If we couldn't parse the major (e.g., a tag like "latest" or
    // "workspace:*"), we trust the user — surface as a warning rather
    // than blocking. The host's own boot will bail on actually-broken setups.
    if (vueMajor === null) {
      warnings.push(
        `Could not infer Vue major version from '${vueRange}'. Editor requires Vue 3; runtime errors at boot indicate an incompatible version.`,
      )
    }
    return { ok: true, framework: "vue3", warnings }
  }

  if (reactRange || allDeps["next"]) {
    // No hard refusal on React major: the source-tag stamp is a build-time
    // DOM attribute (not fiber._debugSource), so it's React-version-
    // independent. We only soft-warn below the tested floor.
    const reactMajor = reactRange ? inferMajor(reactRange) : null
    if (reactMajor !== null && reactMajor < 18) {
      warnings.push(
        `React ${reactMajor}.x detected; Editor targets React 18/19. Source-tagging is build-time so older React may work, but it's untested.`,
      )
    }
    return { ok: true, framework: "react", warnings }
  }

  return {
    ok: false,
    reason: "missing-framework",
    message: `${pkgPath} has neither a 'vue' nor a 'react' dependency. Editor's source stamper ships for Vue SFC templates and JSX only, so a project written in another dialect (Svelte, Solid, plain .astro markup) would be selectable but not editable. See https://desde.design/docs/quickstart/editor#the-repository-gate.`,
  }
}

/**
 * Infer the major version from a typical npm range string when the
 * range pins a single major. Returns null in two cases:
 *
 * 1. **Unparseable.** `*`, `latest`, `workspace:*`, `file:./local`,
 *    `git+https://…`, etc. — upstream surfaces a soft warning.
 *
 * 2. **Compound / multi-major.** `>=2.7.0 <4.0.0`, `^2 || ^3`,
 *    `>=3.0.0`, etc. — these COULD allow Vue 3 even when the leading
 *    numeric token isn't 3. Returning null treats them as ambiguous;
 *    upstream warns rather than hard-refusing. Refusing here would
 *    block valid monorepo / shared-package shapes (codex P2 round 2).
 *
 * Hard-refusal cases (non-null + clearly not 3) are limited to
 * single-major shapes: `^N`, `^N.x.x`, `~N.x.x`, `N`, `N.x`, `N.x.x`.
 * Anything that hints at multi-major (spaces, `||`, `>=`/`<` after
 * the first token, `-` prerelease tags) is ambiguous → null.
 */
function inferMajor(range: string): number | null {
  const trimmed = range.trim()
  // Multi-range expressions: contain `||`, `&&`, or spaces between
  // version tokens. Treat as ambiguous.
  if (/\|\||\s+/.test(trimmed)) return null
  // Range comparators (`>=`, `>`, `<`, `<=`) without a clear single-
  // major bound. `^` and `~` ARE single-major-bounded; `>=` is not.
  if (/^[<>]=?/.test(trimmed)) return null
  // Strip the `^` / `~` prefix (single-major).
  const stripped = trimmed.replace(/^[\^~]+/, "")
  // Match a leading `<digits>` followed by `.`, `-`, or end of string.
  const m = /^(\d+)(?:[.-]|$)/.exec(stripped)
  if (!m) return null
  const major = parseInt(m[1], 10)
  return Number.isFinite(major) ? major : null
}
