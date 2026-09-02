import { STAMP_RULE_GLOBS } from "./next/prime-config.js"
import type { MaterializedAssets, StamperInjection, StampPolicy } from "./types.js"

/**
 * Turning a stamp policy into the payload a host's CHANNEL can accept.
 *
 * **This is the narrow half of the designed module** (`tasks/dev-server-hosts.md`
 * § 2, `hosts/stampers.ts`). The full version is a `StamperProvider` registry
 * keyed on (language × channel) that returns both the injection and the
 * `StampingCoverage`; it arrives with the detection rewrite, which is what
 * produces a MEASURED multi-valued language set for it to key on. What exists
 * here is the one thing the pipeline needs the moment a second channel is
 * real: the `turbopack-loader` shape, built from what the host materialized.
 *
 * The Vite lane deliberately does NOT go through here yet. Its plugins are
 * still assembled by `core.ts`'s callback, because that callback also owns the
 * framework gates deciding which plugins are Vue-only (the tracer, the
 * isolation plugin) — facts about the shell, not about stamping. Pulling the
 * plugin list in here before those gates have a home would move code without
 * moving a decision.
 */

/**
 * The value a host writes in {@link MaterializedAssets.files} for its stamper
 * loader.
 *
 * A named constant on the PIPELINE side rather than a string the Next host and
 * `run.ts` each spell out: the map is `absolute path → what it is`, and two
 * independent spellings of "what it is" is how the lookup silently starts
 * finding nothing and the host boots with no stamper registered — the exact
 * failure class this whole design is organised around.
 */
export const TURBOPACK_LOADER_ASSET = "turbopack-loader"

/**
 * Build the Turbopack injection from what `materialize()` produced.
 *
 * Throws rather than returning a partial injection. A host that declares
 * `accepts: "turbopack-loader"` and then hands back no loader has nothing to
 * stamp with, and booting it would produce a healthy dev server that stamps
 * nothing — which `verifyStamping` would eventually catch, minutes and one dev
 * server later, with a much worse message. Refusing here is refusing before
 * anything is bound.
 */
export function turbopackInjection(
  policy: StampPolicy,
  assets: MaterializedAssets | null,
): Extract<StamperInjection, { channel: "turbopack-loader" }> {
  const loaderPaths = Object.entries(assets?.files ?? {})
    .filter(([, role]) => role === TURBOPACK_LOADER_ASSET)
    .map(([path]) => path)

  const loaderPath = loaderPaths[0]
  if (loaderPath === undefined) {
    throw new Error(
      `A turbopack-loader host materialized no "${TURBOPACK_LOADER_ASSET}" asset, so there is ` +
        "nothing to register as a stamper. Booting would serve a working dev server that stamps " +
        "nothing and refuses every edit.",
    )
  }
  if (loaderPaths.length > 1) {
    // One rule, one loader. Silently picking the first would make which file
    // stamps depend on object key order.
    throw new Error(
      `A turbopack-loader host materialized ${loaderPaths.length} "${TURBOPACK_LOADER_ASSET}" ` +
        `assets (${loaderPaths.join(", ")}); exactly one is expected.`,
    )
  }

  return {
    channel: "turbopack-loader",
    loaderPath,
    // BOTH extensions. MEASURED: a `*.tsx` rule alone leaves every `.jsx` file
    // unstamped — a page that renders fine, is fully selectable, and refuses
    // every edit.
    globs: [...STAMP_RULE_GLOBS],
    options: {
      // The policy is the real answer; the loader prefers it and refuses
      // outright if it arrives malformed (`isStampPolicy`). `repoRoot` is the
      // shorthand form the same loader accepts from attach mode's bare-string
      // registration, carried here so the two channels cannot anchor on
      // different trees: `stampRoot` is the canonical root the policy itself
      // relativises against.
      repoRoot: policy.stampRoot,
      policy,
    },
  }
}
