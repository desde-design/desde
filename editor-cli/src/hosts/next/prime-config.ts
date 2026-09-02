import type { HostFailure, HostSeam, StamperLoaderOptions } from "../types.js"

/**
 * The private Next seam, quarantined to one file.
 *
 * **What the seam is.** Next has no Vite anywhere, so the source stamper cannot
 * be a plugin — it is a webpack-style loader registered through
 * `turbopack.rules`. The only in-memory way to add that rule to a dev server we
 * boot ourselves is to reach into Next's own config memo:
 * `next/dist/server/config` caches the resolved config in a `Map` keyed on
 * `{dir, phase, hasCustomConfig, …, pid}` (`config.js:1319` in 16.3.0) and
 * returns **the same object reference** on every hit. So loading first and
 * mutating the returned object in place means Next's own later load — the one
 * `next.js:220` performs inside `getServer()` — is a cache hit on our mutated
 * object.
 *
 * **Why not Next's documented `conf` option.** It is a SILENT NO-OP for this
 * purpose, and that is measured rather than argued: `next({dev, dir, conf})`
 * boots a healthy server that serves 200s on every route and stamps **zero**
 * elements (`inproc-proof/next/result.confopt.json` — 0 hits on `/`,
 * `/jsx-demo`, `/client-demo`, and the loader's own side-channel log was never
 * even created). The mechanism is visible in the cache key above:
 * `hasCustomConfig: Boolean(customConfig)` is part of it, so passing `conf`
 * lands on a DIFFERENT cache entry than the one the router server reads. Next's
 * `conf` is the canonical example of the failure this whole design exists to
 * catch, and it is the reason `verifyStamping` runs at all.
 *
 * **Why the identity assertion is not optional.** Everything above depends on
 * one property — that the memo hands back the same object twice — and that
 * property is not part of any API contract. If a future Next returns a fresh
 * object per call (a defensive copy, a structured clone, a getter), our mutation
 * silently stops reaching Next while every other signal stays green: the module
 * still resolves, `loadConfig` still returns a config, `app.prepare()` still
 * succeeds, and the dev server still serves 200s. That is the `conf` failure
 * again, arriving as a dependency upgrade. {@link probeConfigMemo} turns it into
 * a pre-boot refusal that names the seam.
 *
 * **And identity is only half of it.** "This is the object Next reads" does not
 * imply "this object accepts the write". A frozen config, a sealed one, or a
 * `turbopack` accessor all preserve identity perfectly and then refuse or
 * swallow the mutation — see {@link NEXT_CONFIG_MUTABILITY_SEAM} for the four
 * measured shapes. So `probeConfigMemo` asserts BOTH, by trial-writing the exact
 * property the injection writes and reading it back.
 */

/**
 * Where the config loader lives INSIDE the `next` package.
 *
 * Its own constant because `host.ts` does NOT load it by the bare specifier
 * below: it resolves this path under the installation `require("next")` binds,
 * so Node's `node_modules` walk-up cannot silently hand back a DIFFERENT
 * installation's copy (see `resolveNextInstall`). One constant, so the seam's
 * documented spelling and the path actually loaded cannot drift apart.
 */
export const NEXT_CONFIG_SUBPATH = "dist/server/config"

/**
 * `next/dist/server/config` — a deep import into Next's build output.
 *
 * The `expression` is deliberately the bare specifier even though the host
 * resolves an absolute path: it is what a maintainer greps for in Next's release
 * notes and in Next's own source, and naming the machinery instead would make
 * the seam harder to look up, not easier.
 */
export const NEXT_CONFIG_MODULE_SEAM: HostSeam = {
  id: `next/${NEXT_CONFIG_SUBPATH}`,
  stability: "private",
  expression: `require("next/${NEXT_CONFIG_SUBPATH}").default`,
  buys: "the only in-memory channel for the source-code stamper",
}

/**
 * The property the injection stands on, named as its own seam because it breaks
 * SEPARATELY from the module path and with a completely different signature: a
 * moved module throws at `require` time, while a lost memo throws nothing at all
 * and produces a healthy server that stamps nothing.
 */
export const NEXT_CONFIG_MEMO_SEAM: HostSeam = {
  id: "next/dist/server/config memoized object identity",
  stability: "private",
  expression: "loadConfig(PHASE_DEVELOPMENT_SERVER, dir) === loadConfig(PHASE_DEVELOPMENT_SERVER, dir)",
  buys: "the in-place mutation that registers the stamper; without identity the mutation reaches nothing and the dev server boots healthy and stamps nothing",
}

/**
 * The OTHER half of the same mechanism: identity says the object is the one Next
 * reads, and this says the object accepts the write.
 *
 * Its own seam because it breaks separately from identity and with a different
 * signature. MEASURED against the shipped probe, four config shapes hold
 * identity, pass every pre-boot gate, and then fail at the injection:
 *
 * | shape                                   | identity | probe | at injection                         |
 * | --------------------------------------- | -------- | ----- | ------------------------------------ |
 * | `Object.freeze(conf)`                   | true     | PASS  | TypeError, "not extensible"          |
 * | `Object.seal(conf)`, no `turbopack` yet | true     | PASS  | TypeError, "not extensible"          |
 * | `turbopack` getter-only                 | true     | PASS  | TypeError, "only a getter"           |
 * | `turbopack` normalising accessor        | true     | PASS  | **ok:true, and Next reads no rules** |
 *
 * A `turbopack` ACCESSOR is not by itself a break — one that stores what it is
 * given passes, and is accepted. The question is only ever whether the write
 * lands, which is why the probe asks the object rather than reading descriptors.
 *
 * The last row is why this is a gate and not a `try`/`catch`: a getter/setter
 * pair that normalises — the shape a Next release would plausibly add to
 * validate `turbopack` — makes the merge report success while the config Next
 * reads carries nothing. That is the documented-`conf` failure exactly, arriving
 * as a dependency upgrade. The three TypeError rows are milder but still wrong:
 * a raw internal `TypeError` AFTER the loader has been bundled to disk, naming
 * nothing.
 */
export const NEXT_CONFIG_MUTABILITY_SEAM: HostSeam = {
  id: "next/dist/server/config memoized object mutability",
  stability: "private",
  expression: "conf.turbopack = { ...conf.turbopack, rules } on the object loadConfig memoized",
  buys: "the write that registers the stamper; a config that refuses or normalises it leaves the dev server booting healthy and stamping nothing",
}

/**
 * Globs the JSX stamper is registered for.
 *
 * **Both, and that is measured rather than defensive.** An earlier spike
 * registered `*.tsx` alone; the fixture's `app/jsx-demo/page.jsx` came back with
 * zero stamps while every `.tsx` route stamped fine — a page that renders
 * normally, is fully selectable, and refuses every edit. Turbopack rule keys are
 * matched per extension, so a `.jsx` file is simply not covered by a `*.tsx`
 * rule.
 */
export const STAMP_RULE_GLOBS: readonly string[] = ["*.tsx", "*.jsx"]

/** `loadConfig` as we call it. Injectable so the identity probe is testable. */
export type LoadNextConfig = (phase: string, dir: string) => Promise<unknown>

/**
 * The parts of Next's resolved config this file reads or writes.
 *
 * Deliberately not Next's own `NextConfigComplete`: editor-cli has no `next`
 * dependency and must not grow one (the host drives the CUSTOMER's install,
 * whose version is theirs). Naming only what we touch keeps the cast honest.
 */
export interface NextConfigObject {
  /** Present on every resolved config. Used as the shape assertion. */
  configFileName?: unknown
  turbopack?: unknown
  [key: string]: unknown
}

/** One `turbopack.rules` entry, in the shape Turbopack consumes. */
interface TurbopackStampRule {
  loaders: [{ loader: string; options: StamperLoaderOptions }]
}

export type ConfigMemoProbe =
  | { ok: true; conf: NextConfigObject }
  | { ok: false; failure: HostFailure }

/**
 * **The single most important check in this host.**
 *
 * Calls `loadConfig` twice for the same `(phase, dir)` and asserts the memo
 * hands back the same object, then that the object has the shape a resolved
 * Next config has. A failure here is a pre-boot refusal with `attachCovers:
 * true`, so the user lands on the shipped attach path rather than on an
 * inspect-only session discovered mid-click.
 *
 * Side-effect-free in the sense that matters: `loadConfig` reads and evaluates
 * the project's `next.config.*` (which is arbitrary customer code, exactly as
 * `next dev` would evaluate it), binds nothing, spawns nothing and writes
 * nothing. The second call is a cache hit, so the cost is one config load —
 * which the boot immediately reuses.
 */
export async function probeConfigMemo(
  loadConfig: LoadNextConfig,
  phase: string,
  dir: string,
): Promise<ConfigMemoProbe> {
  let first: unknown
  let second: unknown
  try {
    first = await loadConfig(phase, dir)
    // Deliberately sequential, not `Promise.all`. Concurrent calls could both
    // miss the cache and both compute, which would report a false identity
    // failure for a memo that works perfectly.
    second = await loadConfig(phase, dir)
  } catch (err) {
    return {
      ok: false,
      failure: {
        code: "seam-shape-changed",
        summary:
          "Editor could not load your Next.js config through the seam it uses to install the source-code stamper.",
        seam: NEXT_CONFIG_MODULE_SEAM,
        cause: (err as Error).message,
        remediation: [
          "Check that `next dev` itself starts. This loads the same next.config the CLI does.",
          "Otherwise start the project's dev server yourself and re-run with --attach <url>.",
        ],
        attachCovers: true,
      },
    }
  }

  if (!isObject(first)) {
    return {
      ok: false,
      failure: shapeChanged(
        NEXT_CONFIG_MODULE_SEAM,
        `loadConfig(PHASE_DEVELOPMENT_SERVER, dir) returned ${describe(first)} rather than a config object`,
      ),
    }
  }

  // THE assertion. Checked BEFORE the field-shape check below so the diagnosis
  // is the specific one: a fresh-object-per-call memo still returns a perfectly
  // well-shaped config, and reporting "configFileName is missing" for it would
  // send the reader somewhere useless.
  if (first !== second) {
    return {
      ok: false,
      failure: {
        code: "seam-shape-changed",
        summary:
          "Editor cannot boot your Next.js dev server in-process: Next no longer reuses one config object, so the source-code stamper cannot be installed.",
        seam: NEXT_CONFIG_MEMO_SEAM,
        cause:
          "Two loadConfig calls for the same phase and directory returned DIFFERENT objects. " +
          "Editor installs the stamper by mutating the memoized config in place, which only " +
          "reaches Next while that object is shared. Booting anyway would produce a dev server " +
          "that serves normally and stamps nothing, so every edit would be refused.",
        remediation: [
          "Start the project's dev server yourself and re-run with --attach <url>. Attach mode does not use this seam.",
          "Then report the Next.js version: this seam is private and is expected to move eventually.",
        ],
        attachCovers: true,
      },
    }
  }

  if (!("configFileName" in first)) {
    return {
      ok: false,
      failure: shapeChanged(
        NEXT_CONFIG_MODULE_SEAM,
        `the object loadConfig returned has no "configFileName" key (keys: ${Object.keys(first).slice(0, 12).join(", ")})`,
      ),
    }
  }

  // LAST of the three, because it is the only one that touches the object — and
  // it touches the very object Next is about to read, so it runs only once we
  // already believe this is Next's config.
  const mutable = probeConfigMutable(first)
  if (!mutable.ok) {
    return {
      ok: false,
      failure: {
        code: "seam-shape-changed",
        summary:
          "Editor cannot boot your Next.js dev server in-process: Next's resolved config no longer accepts the in-place edit that installs the source-code stamper.",
        seam: NEXT_CONFIG_MUTABILITY_SEAM,
        cause:
          `${mutable.cause} Editor registers the stamper by assigning conf.${INJECTED_KEY} on the ` +
          "config object Next memoized, which is the only in-memory channel Turbopack reads a " +
          "loader rule from. Booting anyway would produce a dev server that serves normally and " +
          "stamps nothing, so every edit would be refused.",
        remediation: [
          "Start the project's dev server yourself and re-run with --attach <url>. Attach mode writes the rule into your own config instead, so it does not use this seam.",
          "Then report the Next.js version: this seam is private and is expected to move eventually.",
        ],
        attachCovers: true,
      },
    }
  }

  return { ok: true, conf: first }
}

/** The one property {@link mergeStampRules} writes. */
const INJECTED_KEY = "turbopack"

type MutabilityProbe = { ok: true } | { ok: false; cause: string }

/**
 * Trial-write the exact property the injection writes, read it back, and put the
 * original back.
 *
 * **Why a trial write and not `Object.isFrozen` plus a descriptor check.** Those
 * two catch the frozen and getter-only shapes and MISS the one that matters: a
 * `turbopack` accessor with a normalising setter has a perfectly ordinary
 * descriptor, is not frozen, and silently discards what it is given. Asking the
 * object is the only question whose answer covers every shape — including ones
 * nobody has thought of, such as a Proxy.
 *
 * **Why the read-back is an identity comparison.** A setter that stores a
 * normalised COPY would pass deep equality and still leave Next reading an
 * object our later `rules` never reach. A fresh sentinel makes "did the write
 * land" answerable with `===`.
 *
 * **Side-effect-free by restoration, and that is asserted.** The sentinel is
 * removed before returning, via the original property descriptor so an accessor
 * or a non-enumerable slot comes back exactly as it was; the success path then
 * re-reads to prove the restore happened, because a leaked sentinel would
 * register a `turbopack` block with no rules — the clobber bug reintroduced by
 * the check written to prevent a subtler version of it. The write and its
 * restore are synchronous with no `await` between them, so no other code in the
 * process can observe the sentinel even though the object is shared.
 */
function probeConfigMutable(conf: NextConfigObject): MutabilityProbe {
  const original = Object.getOwnPropertyDescriptor(conf, INJECTED_KEY)
  // Read BEFORE the write, and kept even for a data property: an accessor's
  // backing store is not in its descriptor, so this is the only handle on the
  // value a working setter has to be given back.
  const priorValue = conf[INJECTED_KEY]
  const sentinel: Record<string, unknown> = {}

  let observed: unknown
  try {
    conf[INJECTED_KEY] = sentinel
    observed = conf[INJECTED_KEY]
  } catch (err) {
    // Strict mode — every module here is one — THROWS on a refused assignment
    // rather than failing silently. MEASURED: frozen and sealed configs give
    // "Cannot add property turbopack, object is not extensible"; a getter-only
    // one gives "…which has only a getter". Quoted verbatim, because that
    // sentence is what tells a maintainer which shape they are looking at.
    return {
      ok: false,
      cause: `Assigning conf.${INJECTED_KEY} threw: ${(err as Error).message}.`,
    }
  } finally {
    restoreProperty(conf, INJECTED_KEY, original, priorValue)
  }

  if (observed !== sentinel) {
    return {
      ok: false,
      cause:
        `conf.${INJECTED_KEY} accepted the assignment and then read back ${describe(observed)} ` +
        "instead of the value written, which is an accessor that normalises or discards what it is given.",
    }
  }

  if (conf[INJECTED_KEY] === sentinel) {
    return {
      ok: false,
      cause: `Editor's trial write to conf.${INJECTED_KEY} could not be undone, so the config can be written but not restored.`,
    }
  }

  return { ok: true }
}

/**
 * Undo the trial write, by whichever route the property actually has.
 *
 * The accessor branch is not defensive padding — MEASURED, without it a config
 * whose `turbopack` is a faithful pass-through accessor (an alias onto another
 * field, which is how a deprecation shim looks) was REFUSED: the write lands, the
 * read-back matches, and then re-defining an unchanged descriptor leaves the
 * setter's backing store holding the sentinel, which the caller reads as a
 * failed restore. Such a config is one the injection works on perfectly, so
 * refusing it would be a false negative introduced by the restore rather than by
 * the seam.
 */
function restoreProperty(
  target: NextConfigObject,
  key: string,
  original: PropertyDescriptor | undefined,
  priorValue: unknown,
): void {
  try {
    if (original === undefined) delete target[key]
    else if (original.set !== undefined) target[key] = priorValue
    else Object.defineProperty(target, key, original)
  } catch {
    // Deliberately swallowed: the caller re-reads the property and reports a
    // failed restore in its own words, which is a better message for the user
    // than whatever `delete` or `defineProperty` threw about descriptors.
  }
}

export type RuleMergeResult =
  | { ok: true; preserved: string[] }
  | { ok: false; failure: HostFailure }

/**
 * Add our loader rule to `conf.turbopack.rules`, **merging and never clobbering**.
 *
 * MEASURED regression this closes: `conf.turbopack = { ...conf.turbopack, rules: OURS }`
 * replaces the entire rules map, so a project declaring its own rule (an SVGR
 * `*.svg` loader is the common one) silently lost it — the dev server booted
 * fine and that project's SVG imports stopped working, with Editor as the only
 * difference and nothing in the logs.
 *
 * **Mutates `conf` in place**, which is the seam: `conf.turbopack` is replaced
 * with a new object but `conf` itself keeps the identity Next's memo holds. A
 * caller that reassigned `conf` instead would mutate a copy and reach nothing.
 *
 * **A rule we cannot prove disjoint from ours is a refusal, not a compose.**
 * Composing two loaders on the same file requires knowing which one Turbopack
 * applies first, and we have not measured that. Getting it wrong is not a
 * harmless ordering detail: if the other loader runs first and shifts lines (an
 * injected import is enough), our stamp coordinates point at the wrong line and
 * edits land in the wrong place — the one failure class `stamp-policy.ts` calls
 * worse than a dead stamp. Attach mode covers this case exactly, and there the
 * user writes the rule themselves and controls the order.
 *
 * **Which is why the test is `overlapWith`, not `Object.hasOwn`.** Rule keys are
 * arbitrary globs (`rules?: Record<string, TurbopackRuleConfigCollection>`), so
 * exact string equality against `"*.tsx"` / `"*.jsx"` sees only one spelling of
 * a rule. MEASURED against that earlier check, every one of these was ACCEPTED
 * and both loaders were registered on the same files:
 *
 *     "*.{tsx,jsx}"  →  rules ["*.{tsx,jsx}", "*.tsx", "*.jsx"]
 *     "**\/*.tsx"     →  rules ["**\/*.tsx", "*.tsx", "*.jsx"]
 *     "*.[jt]sx"     →  rules ["*.[jt]sx", "*.tsx", "*.jsx"]
 *     "*"            →  rules ["*", "*.tsx", "*.jsx"]
 *
 * i.e. the exact outcome the refusal exists to prevent, reached by spelling the
 * same glob differently — and reached SILENTLY, which puts it on the wrong side
 * of the line this host is organised around.
 *
 * **Refuse what cannot be proven disjoint, rather than detect overlap
 * properly.** Deciding real glob intersection means owning a glob engine's
 * semantics — brace expansion, ranges, extglobs, character classes — and being
 * wrong in the permissive direction is silent and unrecoverable, while being
 * wrong in the strict direction is a message with two workarounds in it. So the
 * test is a soundness one ({@link literalExtensionOf}): a rule is admitted only
 * when its literal extension PROVES it can never touch a `.tsx` or `.jsx` file.
 *
 * **The cost of that, stated plainly rather than discovered.** A project whose
 * image loader is keyed `*.{png,jpg}` is now refused even though it could never
 * collide, because the brace makes the extension non-literal. That is a real
 * regression for that project, and it is chosen: the remediation tells them to
 * spell it as two literal keys, which takes a minute, and the alternative
 * failure takes an afternoon and starts with edits landing on the wrong line.
 * The measured, shipped case this host was built against — SVGR's `*.svg` — and
 * every other single-extension rule still compose exactly as before.
 */
export function mergeStampRules(
  conf: NextConfigObject,
  rule: { loaderPath: string; options: StamperLoaderOptions; globs: readonly string[] },
): RuleMergeResult {
  const turbopack = isObject(conf.turbopack) ? conf.turbopack : {}
  const existingRules = isObject(turbopack.rules) ? turbopack.rules : {}

  const unsafe = Object.keys(existingRules)
    .map((glob) => ({ glob, overlap: overlapWith(glob, rule.globs) }))
    .filter((entry) => entry.overlap !== "disjoint")

  if (unsafe.length > 0) {
    const listed = unsafe.map((entry) => `"${entry.glob}"`).join(", ")
    // Two different problems with two different fixes — "this rule collides with
    // ours" is removable, "Editor cannot decide about this rule" may just need a
    // narrower spelling — so the user is told which one they have, per glob.
    const perGlob = unsafe.map((entry) =>
      entry.overlap === "overlaps"
        ? `"${entry.glob}" reaches the same .tsx/.jsx files Editor's stamper must transform.`
        : `"${entry.glob}" does not end in a literal extension, so Editor cannot prove it does not also match .tsx or .jsx files.`,
    )
    return {
      ok: false,
      failure: {
        code: "boot-failed",
        summary: unsafe.every((entry) => entry.overlap === "overlaps")
          ? `This project's Next config already declares a Turbopack rule for ${listed}, which Editor's source-code stamper also needs.`
          : `This project's Next config declares a Turbopack rule for ${listed} that Editor cannot prove excludes the .tsx/.jsx files its source-code stamper must transform.`,
        cause:
          `${perGlob.join(" ")} Editor will not add a second loader onto files another loader may ` +
          "already be transforming: Turbopack's loader application order is not something Editor " +
          "has measured, and if the other loader ran first and shifted any lines, every source " +
          "coordinate Editor stamped would point at the wrong line and edits would land in the " +
          "wrong place.",
        remediation: [
          "Start the project's dev server yourself and re-run with --attach <url>. Attach mode prints a config block you add to your own turbopack.rules, so you control the loader order.",
          unsafe.some((entry) => entry.overlap === "unprovable")
            ? `Or spell the ${unsafe.map((entry) => entry.glob).join(" / ")} rule as one key per literal extension ("*.png" and "*.jpg" rather than "*.{png,jpg}"). Editor composes with any rule whose extension is literal and is not .tsx or .jsx.`
            : `Or remove the ${unsafe.map((entry) => entry.glob).join(" / ")} rule from next.config if it is no longer needed.`,
        ],
        attachCovers: true,
      },
    }
  }

  const stampRule: TurbopackStampRule = {
    loaders: [{ loader: rule.loaderPath, options: rule.options }],
  }
  const rules: Record<string, unknown> = { ...existingRules }
  for (const glob of rule.globs) rules[glob] = stampRule

  // Every other `turbopack` key — `root`, `resolveAlias`, `resolveExtensions` —
  // is spread through untouched. `turbopack.root` in particular is deliberately
  // NOT set: MEASURED, a loader at an absolute path entirely outside the project
  // works with `root` left at its default, so widening it would be a filesystem
  // boundary change bought for nothing.
  conf.turbopack = { ...turbopack, rules }
  return { ok: true, preserved: Object.keys(existingRules) }
}

/**
 * What a rule the project already declares can be PROVEN about, relative to the
 * globs our stamper needs.
 *
 * Three-valued on purpose. Two would force "unprovable" to be folded into one of
 * the others, and both foldings are wrong: into `disjoint` is the silent
 * mis-stamp above, and into `overlaps` would tell a user their `*` rule
 * "collides with *.tsx", which is a claim we have not made.
 */
type GlobOverlap = "disjoint" | "overlaps" | "unprovable"

/**
 * Characters that make the rest of a glob mean something other than itself.
 *
 * Deliberately a superset — `!`, `+`, `@` are only special before `(`, and `^`
 * and `$` are not glob syntax at all. Every false positive costs a refusal the
 * user can work around; a false negative costs stamps on the wrong line, which
 * they cannot. Non-global so `.test` has no `lastIndex` to carry between calls.
 */
const GLOB_META = /[*?[\]{}()!+@|\\^$]/

/**
 * Everything after the LAST `.` in a glob, when every character of it is
 * literal — otherwise `null`.
 *
 * **The soundness argument, which is the whole reason this can be a string
 * operation and not a glob engine.** If the tail is literal then so is the `.`
 * before it, so every path the pattern matches ends with exactly `.<tail>`,
 * whatever the rest of the pattern does. `{app,src}/**\/*.svg` can therefore be
 * proven never to match a `.tsx` file without expanding a single brace. When the
 * tail is not literal — `*.{tsx,jsx}`, `*.[jt]sx`, `*` — nothing is proven, and
 * the caller refuses.
 */
function literalExtensionOf(glob: string): string | null {
  const dot = glob.lastIndexOf(".")
  if (dot < 0) return null
  const tail = glob.slice(dot + 1)
  return tail.length > 0 && !GLOB_META.test(tail) ? tail : null
}

function overlapWith(existing: string, ours: readonly string[]): GlobOverlap {
  const theirs = literalExtensionOf(existing)
  if (theirs === null) return "unprovable"
  for (const glob of ours) {
    const mine = literalExtensionOf(glob)
    // Our OWN glob failing to be literal-tailed would make every comparison
    // below meaningless, so it is "cannot prove", never "no match". Unreachable
    // while STAMP_RULE_GLOBS is what it is; the point is that widening that
    // constant can only ever cost refusals, not correctness.
    if (mine === null) return "unprovable"
    // Case-insensitively: macOS and Windows filesystems are case-insensitive, so
    // a `*.TSX` rule reaches the same files ours does.
    if (mine.toLowerCase() === theirs.toLowerCase()) return "overlaps"
  }
  return "disjoint"
}

/**
 * `PHASE_DEVELOPMENT_SERVER`, read out of the PROJECT's own `next/constants`.
 *
 * **The phase is the gate, and reading it rather than hardcoding it is the
 * point.** The memo's cache key includes the phase, so priming the
 * development-server entry cannot touch the production-build entry: a
 * `next build` — in this process or any other — resolves a different cache entry
 * and never sees our loader. That is what keeps `data-desde-src` out of prerendered
 * output (MEASURED in attach mode, where the same loader is referenced from the
 * user's committed config: without a phase gate, 34 stamps shipped in the
 * prerendered HTML of a production build).
 *
 * **`process.env.NODE_ENV` cannot do this job.** It is ambient — any parent
 * process, shell profile or CI runner can set it, and a runner that exports
 * `NODE_ENV=development` before `next build` would re-enable the leak. The phase
 * is an ARGUMENT Next passes at its own call site (`next.js:220`,
 * `router-server.js:115`), so nothing outside Next can forge it.
 *
 * Returns `null` when the constant is absent, which the caller turns into a
 * pre-boot refusal rather than falling back to a hardcoded string: a hardcoded
 * value that no longer matches Next's own would prime a cache entry nobody
 * reads, i.e. the healthy-but-unstamped failure again.
 */
export function developmentPhaseFrom(constants: unknown): string | null {
  if (!isObject(constants)) return null
  const phase = constants.PHASE_DEVELOPMENT_SERVER
  return typeof phase === "string" && phase.length > 0 ? phase : null
}

function shapeChanged(seam: HostSeam, cause: string): HostFailure {
  return {
    code: "seam-shape-changed",
    summary:
      "Editor cannot boot your Next.js dev server in-process: Next's internal config loader no longer has the shape the source-code stamper is installed through.",
    seam,
    cause,
    remediation: [
      "Start the project's dev server yourself and re-run with --attach <url>. Attach mode does not use this seam.",
      "Then report the Next.js version: this seam is private and is expected to move eventually.",
    ],
    attachCovers: true,
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function describe(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  // Only reachable from the mutability probe: the other call site is guarded by
  // `!isObject`, and null and arrays are already handled above. There it is the
  // load-bearing distinction — a normalising setter that stored a COPY reads
  // back as an object, and "an object" is what says so.
  if (typeof value === "object") return "an object"
  return typeof value
}
