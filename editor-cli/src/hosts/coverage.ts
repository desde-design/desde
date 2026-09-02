import type { SourceLanguage, StamperChannel, StampingCoverage } from "./types.js"

/**
 * Which source dialects this build can actually stamp, and — the part that
 * matters — which it cannot.
 *
 * **Why an explicit table instead of "whatever the plugins happen to do".**
 * Until this module existed, a language with no stamper was a silent nothing:
 * the server booted, the pages rendered, elements were selectable, and the user
 * found out which files were editable by clicking one that was not. `.astro` is
 * the first host where that is the NORMAL state rather than a bug — Astro's
 * template markup has no stamper in v1 (`tasks/dev-server-hosts.md` § 7) while
 * its islands stamp fine — so the gap has to be a declared, printed fact.
 *
 * The rule this encodes is the one on `StampPolicy`: **stamping a file is a
 * promise that an edit will land.** The inverse is what makes an uncovered
 * language safe rather than broken — an unstamped element is not an element
 * with a broken edit, it is an element the bridge walks past on its way up to
 * the nearest stamped ancestor. Declaring the gap costs a sentence at boot;
 * NOT declaring it costs a debugging session.
 */

/**
 * Language → the channels a stamper exists for in this build.
 *
 * `astro` is deliberately EMPTY rather than absent from the map, so adding a
 * `SourceLanguage` member is a compile error here and cannot default to
 * "covered". See {@link NO_PROVIDER_REASON} for why `.astro` has none.
 */
const PROVIDERS: Record<SourceLanguage, readonly StamperChannel[]> = {
  // `source-tag-plugin.ts` — @vue/compiler-sfc over the SFC <template>. No
  // Turbopack lane: there is no Next-and-Vue host, so a provider for it would be
  // a claim with nothing behind it.
  "vue-sfc": ["vite-plugin"],
  // BOTH channels, and it is the SAME implementation on each: the Turbopack
  // loader (`attach/stampers/next-loader.entry.ts`) wraps the unmodified
  // `jsxSourceTagPlugin(...).transform`, which is a pure `(code, id) => …` with
  // no dependency on Vite's plugin context. Two channels, one stamper, one set
  // of coordinate conventions the applicators re-read.
  jsx: ["vite-plugin", "turbopack-loader"],
  // NONE. Not an oversight — see below.
  astro: [],
}

/**
 * What to tell the user, per language, when nothing covers it.
 *
 * Phrased as the CONSEQUENCE first ("inspect-only"), because that is the thing
 * the user will otherwise discover by clicking.
 */
const NO_PROVIDER_REASON: Record<SourceLanguage, string> = {
  "vue-sfc": "no Vue SFC stamper is available on this host's stamper channel.",
  jsx: "no JSX stamper is available on this host's stamper channel.",
  // The mechanism is proven (a Vite `load` hook parsing with Astro's own
  // compiler stamps 10/10 elements; a `transform` hook provably cannot — Astro's
  // enforce:'pre' astro:build plugin hands it compiled JS, not template source).
  // It is not SHIPPABLE, and the decisive reason is downstream of stamping:
  // there is no `.astro` applicator in `src/editor/edit-service/` and no
  // `.astro` case in `checkExtensionGate` (`server/edit-extension-gate.ts`), so
  // a stamp would buy selection while every edit 400s — the exact
  // promise-an-edit-cannot-land failure the policy exists to prevent.
  astro:
    ".astro template markup has no stamper, so .astro files are inspect-only this session: " +
    "their elements are selectable but edits to them are refused. Components rendered inside " +
    "the page as islands (.tsx / .jsx / .vue) stamp normally and stay editable.",
}

/**
 * Split the languages a host wants stamped into covered and uncovered.
 *
 * **No refusal here, deliberately.** `tasks/dev-server-hosts.md` § 1 resolution
 * rule 8 says zero covered languages is the one stamping condition that refuses
 * — but that rule belongs with the detection rewrite, which is what produces a
 * MEASURED multi-valued language set. Today `HostContext.languages` is
 * defaulted from single-valued detection, so refusing on it would be refusing a
 * project on the strength of a default. The gate that catches a host stamping
 * nothing at all is `verifyStamping`, which observes the served output instead
 * of predicting it.
 */
export function stampingCoverage(
  languages: readonly SourceLanguage[],
  channel: StamperChannel,
): StampingCoverage {
  const covered: StampingCoverage["covered"] = []
  const uncovered: StampingCoverage["uncovered"] = []
  const seen = new Set<SourceLanguage>()

  for (const language of languages) {
    if (seen.has(language)) continue
    seen.add(language)
    if (PROVIDERS[language].includes(channel)) covered.push({ language, via: channel })
    else uncovered.push({ language, reason: NO_PROVIDER_REASON[language] })
  }

  return { covered, uncovered }
}

/**
 * Extension → the {@link SourceLanguage} whose stamper owns that file.
 *
 * The inverse of the table above, and it exists for exactly one caller: joining
 * a per-module notice back to the coverage declaration, so a file whose language
 * was already declared uncovered is not reported a second time under a different
 * name (`hosts/stamp-notices.ts`).
 *
 * `null` for anything unrecognised, and that is NOT a filter. An unknown
 * extension means "no declaration applies", so the notice survives — the
 * alternative is that a stamper we add tomorrow silently loses its notices to a
 * table nobody remembered to extend.
 */
export function languageOfStampPath(file: string): SourceLanguage | null {
  const lower = file.toLowerCase()
  // `.vue` first: a `<script setup lang="tsx">` block is stamped by the JSX
  // collector but lives in a `.vue`, and the file's language is what the
  // coverage declaration is about.
  if (lower.endsWith(".vue")) return "vue-sfc"
  if (lower.endsWith(".tsx") || lower.endsWith(".jsx")) return "jsx"
  if (lower.endsWith(".astro")) return "astro"
  return null
}
