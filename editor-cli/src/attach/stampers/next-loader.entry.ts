import { resolve } from "node:path"
import { isStampPolicy, type StampScope } from "../../hosts/stamp-policy.js"
import { jsxSourceTagPlugin } from "../../plugins/jsx-source-tag-plugin.js"

/**
 * Bundle entry for the Next.js lane's stamper — a webpack-style loader that
 * Turbopack registers through `turbopack.rules`.
 *
 * Next has no Vite seam at all, so the stamper cannot be a Vite plugin. It
 * wraps the UNMODIFIED `jsxSourceTagPlugin(...).transform`, which is a pure
 * `(code, id) => …` with no dependency on Vite's plugin context — the two lanes
 * therefore stamp byte-identically, and there is only one implementation to
 * keep correct.
 *
 * **It must never throw.** A stamping failure returns the source unchanged: an
 * unstamped file leaves the Editor inspect-only for that file, while a throwing
 * loader breaks the user's dev server outright. The first is recoverable, the
 * second is not.
 *
 * Production gating is NOT here. In attach mode this loader is referenced from
 * the user's committed `next.config`, so it also runs during `next build`; the
 * generated config block gates on Next's own PHASE argument, which nothing in
 * the environment can forge. See `generate-block.ts`.
 *
 * ## Two callers, one file
 *
 * | caller | where the file sits | how it learns its scope |
 * | --- | --- | --- |
 * | attach mode | `<repo>/.desde/stamp/next-loader.cjs` | `__dirname`, two up |
 * | the in-process Next host | a per-user cache dir, OUTSIDE the repo | loader `options` |
 *
 * The `__dirname` derivation is not a legacy path to remove once the in-process
 * host lands: attach mode's config block is written into the customer's
 * repository and imports this file by relative path, so a user who committed
 * that block keeps running it. It is the fallback, and it stays.
 *
 * It is also **only correct from inside the repo**, which is the whole reason
 * the options channel exists. Run from a cache dir it derives a root that has
 * nothing to do with the project, and what follows depends on where the OS put
 * that dir: if the derived root happens to contain the repo, every stamp
 * carries a wrong prefix and every edit resolves onto the wrong tree; if it
 * does not, root containment refuses everything and the dev server serves 200s
 * while stamping nothing. MEASURED, the second — 0 stamps on all three routes
 * (`tasks/dev-server-hosts.md` § 2). Both are failures, so the in-process host
 * passes the policy explicitly rather than letting a file's location stand in
 * for it.
 */

// `__dirname` is supplied by the CommonJS wrapper the bundler emits for this
// entry. Declaring it keeps the TypeScript source honest without pulling in
// `@types/node`'s global CJS augmentation, which an ESM-only tsconfig hides.
declare const __dirname: string

interface LoaderContext {
  /** Absolute path of the module being transformed. Webpack + Turbopack both set it. */
  resourcePath?: string
  /**
   * The `options` declared beside this loader in `turbopack.rules`.
   *
   * MEASURED on Next 16.3.0 (`tasks/dev-server-hosts.md` § 2, "Where the
   * in-process Next loader file lives"): Turbopack calls this and delivers the
   * declared options to a loader living at an absolute path entirely outside
   * the project, across the forked worker it runs loaders in — 15 / 5 / 9
   * repo-relative stamps on three routes, against zero for the same file
   * registered without options. Optional because the attach-mode registration
   * is the bare string form, which has no options at all.
   */
  getOptions?: () => unknown
}

/** Exactly what the plugin's `transform` is, minus Vite's `ObjectHook` wrapper. */
type StampTransform = (code: string, id: string) => { code: string } | null

interface LoaderOptions {
  repoRoot?: unknown
  policy?: unknown
}

/**
 * One transform per distinct scope.
 *
 * Constructing the plugin is cheap but not free (it resolves the policy), and
 * `transform` is called once per module per compile. Keyed on the serialized
 * scope rather than object identity because the options object is re-created
 * per call by the loader runtime. Bounded in practice by the number of rules
 * registered — two, `*.tsx` and `*.jsx`, both carrying the same options.
 */
const transforms = new Map<string, StampTransform>()

function transformFor(scope: StampScope): StampTransform {
  const key = JSON.stringify(scope)
  const cached = transforms.get(key)
  if (cached) return cached
  // The plugin declares a plain function `transform`; Vite's `Plugin` type
  // widens it to an ObjectHook, which this file never produces or consumes.
  const created = jsxSourceTagPlugin(scope).transform as unknown as StampTransform
  transforms.set(key, created)
  return created
}

function readOptions(ctx: LoaderContext): LoaderOptions | null {
  try {
    const options = typeof ctx?.getOptions === "function" ? ctx.getOptions() : null
    return typeof options === "object" && options !== null ? (options as LoaderOptions) : null
  } catch {
    // A loader runtime that validates options against a schema can throw here.
    // Treated as "no options", which lands on the `__dirname` fallback — the
    // behaviour every attach-mode installation already depends on.
    return null
  }
}

/**
 * What may this invocation stamp — or `null` for "refuse to stamp at all".
 *
 * `null` is a deliberate third answer, not an error case. A caller that
 * declared options and got them wrong must not be silently downgraded to the
 * `__dirname` guess, because that guess is anchored two levels above this file
 * and can land on a directory that contains the repo — which stamps every
 * element with a wrong prefix, the failure `stamp-policy.ts` names as worse
 * than a dead stamp (a silent write to a different existing file). Refusing
 * routes it into `verifyStamping` instead, which sees zero stamps on a
 * server-rendered host and tears the boot down with the reason.
 *
 * The empty-object case is NOT that. Webpack hands `{}` to a loader registered
 * with no options at all, which is exactly attach mode's bare-string
 * registration — an absent scope, not a broken one, so it takes the fallback.
 */
function scopeFrom(options: LoaderOptions | null): StampScope | null {
  if (options && "policy" in options) {
    return isStampPolicy(options.policy) ? { policy: options.policy } : null
  }
  if (options && "repoRoot" in options) {
    const repoRoot = options.repoRoot
    return typeof repoRoot === "string" && repoRoot.length > 0 ? { repoRoot } : null
  }
  // `<root>/.desde/stamp/next-loader.cjs` → `<root>`. Same derivation as
  // the ESM entries, spelled the way CommonJS spells it.
  return { repoRoot: resolve(__dirname, "..", "..") }
}

export default function desdeStampLoader(this: LoaderContext, source: string): string {
  try {
    const id = this?.resourcePath
    if (typeof id !== "string" || id.length === 0) return source
    const scope = scopeFrom(readOptions(this))
    if (scope === null) return source
    return transformFor(scope)(source, id)?.code ?? source
  } catch {
    return source
  }
}
