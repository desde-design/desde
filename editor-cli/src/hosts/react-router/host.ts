import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { InlineConfig, ViteDevServer } from "vite"
import { hardenPlugin } from "../../supervisor/harden-plugin.js"
import { invalidateViteModules } from "../vite-invalidate.js"
import { listenOriginFor } from "../../server/host-guard.js"
import { anyStampedModuleHasDataPtSrc } from "../vite/module-graph-evidence.js"
import { pickLoopbackPort } from "../loopback-port.js"
import { rootDefaultPlugin } from "../root-default-plugin.js"
import type {
  BridgeTagStrategy,
  DevServerHost,
  HostBoot,
  HostContext,
  HostFailure,
  ProbeResult,
  SourceLanguage,
  StampExpectation,
  StamperInjection,
} from "../types.js"

/**
 * The React Router (framework mode) host — the first host that is NOT the
 * shipped Vite path, and the one that forced the security refactor.
 *
 * **Why it cannot reuse `bootSupervisor`.** That function's boot is
 * `loadConfigFromFile` → `mergeConfig` → `createServer({ configFile: false })`,
 * and React Router refuses the last step outright:
 *
 * ```
 * Error: The React Router Vite plugin requires the use of a Vite config file
 *   at @react-router/dev/dist/vite.js:1562
 * ```
 *
 * So Vite must load the repo's config file itself, and our plugins ride in
 * through the INLINE config's `plugins` array — which Vite CONCATENATES onto
 * the file config's array rather than replacing it. MEASURED plugin order on
 * `fixture-ssr`: the repo's own (`@tailwindcss/vite:*`, `react-router:*`) at
 * indices 4-9, `@desde/editor-jsx-source-tag-plugin` at 11,
 * `@desde/editor-harden` at 46 of 50. Repo first, ours after — which is
 * exactly the ordering the hardening plugin needs to be able to win.
 *
 * That is also why `hardenServerConfig`'s pre-merge call has no equivalent
 * here: there is no merge WE perform to harden the result of. The hardening
 * plugin is the entire floor on this path, and it was verified over HTTP rather
 * than by inspecting config shape — see `boot()`.
 *
 * **Two more things are forbidden, both MEASURED in the spike:**
 * `middlewareMode` 404s the SSR route (`Cannot GET /`) regardless of `appType`,
 * and skipping `.listen()` 500s inside `vite:css-post`. Hence: a real listener
 * on loopback, fronted by the proxy.
 */

/** Languages a Vite plugin can stamp in a React Router app. */
const RR_STAMPABLE: readonly SourceLanguage[] = ["jsx"]

/**
 * MEASURED: `transformIndexHtml` fires ZERO times on React Router, in both
 * `ssr:true` and `ssr:false`. The tags come from the proxy's streaming
 * injector, and this constant is what tells the plugin-assembly site to install
 * `bridgeAssetsPlugin` (serving only) rather than the composed `bridgePlugin`.
 * Referenced by both `DevServerHost.bridgeTags` and `HostBoot.bridgeTags` so
 * the two cannot drift.
 */
const BRIDGE_TAGS: BridgeTagStrategy = "proxy-response-injection"

/** Vite's own default config filenames, in Vite's own resolution order. */
const VITE_CONFIG_NAMES = [
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.ts",
  "vite.config.cjs",
  "vite.config.mts",
  "vite.config.cts",
] as const

/**
 * The shape we use out of the PROTOTYPE's Vite install.
 *
 * Declared locally rather than reusing `typeof import("vite")` because the
 * module object comes from a different physical install than the one
 * editor-cli's types describe (MEASURED skew: fixture 8.2.1 / 8.0.8 vs
 * editor-cli 8.2.1 — and a customer's is whatever they installed). Naming only
 * the two members we call keeps the cast honest about how much we are claiming.
 */
interface PrototypeVite {
  createServer(config: InlineConfig): Promise<ViteDevServer>
}

/**
 * React Router's private state on the resolved Vite config.
 *
 * `reactRouterConfig.ssr` is the ONLY place the resolved SSR decision is
 * readable from our side: it is declared in `react-router.config.ts`, not in
 * the Vite config, and React Router normalises it (absent → `true`) before
 * stashing it here. MEASURED on all three fixtures — `fixture-ssr` `ssr:true`,
 * `fixture-hard` (no `ssr` key) `ssr:true`, `rrv7-fixture` `ssr:false`.
 */
interface ReactRouterPluginContext {
  reactRouterConfig?: { ssr?: unknown }
}

export function createReactRouterHost(): DevServerHost<"vite-plugin"> {
  return {
    id: "react-router",
    displayName: "React Router",

    seams: [
      {
        id: "vite/createServer(configFile)",
        stability: "public",
        expression: 'createServer({ configFile: "<repo>/vite.config.ts", plugins: [...] })',
        buys: "the plugin pipeline the source stamper rides in on, with the repo's own config loaded by Vite rather than by us",
      },
      {
        // PRIVATE, and deliberately not gated in `probe()`. The rule that a
        // private seam must carry a pre-boot causal assertion exists because a
        // private seam that silently no-ops yields a healthy-but-unstamped
        // server. This one cannot: it does not participate in stamping at all.
        // It only decides how strictly zero stamps are judged, and its failure
        // direction is LESS strict (`post-hydration`, which by the teardown
        // conjunction can never conclude). It is also unreadable before boot —
        // React Router writes it during `configResolved`. So the assertion is
        // made at the only moment it can be, in `stampExpectationFrom` below,
        // and a miss degrades with a notice instead of refusing.
        id: "ResolvedConfig.__reactRouterPluginContext.reactRouterConfig.ssr",
        stability: "private",
        expression: "server.config.__reactRouterPluginContext.reactRouterConfig.ssr",
        buys: "the conclusive zero-stamp verdict; without it verification degrades to inconclusive",
      },
    ],

    // No `stamperSeam`, even though this host CAN reach the verdict (an
    // `ssr: true` app reports `required-in-html`). Neither seam is the answer to
    // "what did not deliver": the stamper is a plugin in an array we hand to a
    // `createServer` we call ourselves, so there is no forwarding step to drop
    // it silently — unlike Nuxt, where `overrides.vite.plugins` is one. Naming
    // `vite/createServer` would send a user to look at Vite for a stamper that
    // Vite received. A seam-free failure still says the server is healthy, that
    // edits would be refused, and how to attach; that is the honest state.

    // The range MEASURED to work: @react-router/dev 8.0.0 (the reactrouter.com
    // repo) and 8.3.0 (a freshly scaffolded app). Outside it is a notice, not a
    // refusal — `verifyStamping` is the real gate.
    versionGate: { packageName: "@react-router/dev", tested: "^8.0.0" },

    accepts: "vite-plugin",
    devCommand: "npx react-router dev",
    bridgeTags: BRIDGE_TAGS,

    // `.react-router` is React Router's generated types/manifest directory. It
    // sits inside the repo, so root-containment admits it, and it is rewritten
    // on every boot — a stamp there is a stamp on a file that will not exist by
    // the time anyone edits it. `build/` is NOT denied: it is production output
    // the dev server never transforms, and denying it would silently unstamp a
    // repo that legitimately keeps source under that name (same reasoning as
    // the plain Vite host's empty `buildDirs`).
    buildDirs: [".react-router"],

    stampLanguages(ctx: HostContext): SourceLanguage[] {
      return ctx.languages.filter((language) => RR_STAMPABLE.includes(language))
    },

    async probe(ctx: HostContext): Promise<ProbeResult> {
      const require = createRequire(join(ctx.prototypeRoot, "package.json"))
      const notices: string[] = []

      // 1. React Router's Vite plugin package. Detection read `package.json`
      //    (fast, offline); this reads `node_modules`, which is the difference
      //    between "declared" and "installed".
      if (!canResolve(require, "@react-router/dev/vite")) {
        return {
          ok: false,
          failure: missingPackage(
            "@react-router/dev",
            "This project declares React Router but @react-router/dev is not installed.",
          ),
        }
      }

      // 2. The PROTOTYPE's own Vite. React Router's plugin closes over the Vite
      //    it resolves for itself, so booting with editor-cli's copy would put
      //    two Vite module instances in one process. Unlike the plain `vite`
      //    host — which can supply its own and does — this host has no such
      //    escape, so a missing install is a refusal rather than a fallback.
      if (!canResolve(require, "vite")) {
        return {
          ok: false,
          failure: missingPackage(
            "vite",
            "React Router runs on the project's own Vite, and this project has none installed.",
          ),
        }
      }

      // 3. A real Vite config FILE on disk. Not our requirement — React
      //    Router's, enforced by its own plugin. Checking it here turns a
      //    mid-boot throw into a pre-boot refusal that names the fix.
      if (locateViteConfig(ctx.prototypeRoot) === null) {
        return {
          ok: false,
          failure: {
            code: "boot-failed",
            summary: `No Vite config file in ${ctx.prototypeRoot}, and React Router requires one.`,
            cause:
              'The React Router Vite plugin refuses `configFile: false` ("The React Router Vite plugin requires the use of a Vite config file", @react-router/dev/dist/vite.js:1562), so Editor cannot supply the config in memory the way it does for a plain Vite project.',
            remediation: [
              `Add a vite.config.ts to ${ctx.prototypeRoot} that registers reactRouter() (this is what \`react-router dev\` needs too).`,
              "Or start the project's dev server yourself and re-run with --attach <url>.",
            ],
            attachCovers: true,
          },
        }
      }

      const version = readInstalledVersion(require, "@react-router/dev")
      if (version !== null && majorOf(version) !== "8") {
        const message =
          `This project has @react-router/dev ${version}; Editor's in-process boot is measured against 8.x. ` +
          "The seam is public Vite API, so it may well work. But if the dev server misbehaves, this is the first thing to suspect."
        if (ctx.strictVersions) {
          return {
            ok: false,
            failure: {
              code: "host-version-unsupported",
              summary: `@react-router/dev ${version} is outside the measured range, and --strict-versions was passed.`,
              detected: { package: "@react-router/dev", installed: version, tested: "^8.0.0" },
              remediation: [
                "Drop --strict-versions to boot anyway (stamping verification still gates the session).",
                "Or start the project's dev server yourself and re-run with --attach <url>.",
              ],
              attachCovers: true,
            },
          }
        }
        notices.push(message)
      }

      return { ok: true, version: version ?? "unknown", notices }
    },

    async boot(
      ctx: HostContext,
      injection: Extract<StamperInjection, { channel: "vite-plugin" }>,
    ): Promise<HostBoot> {
      const require = createRequire(join(ctx.prototypeRoot, "package.json"))
      const vite = (await import(
        pathToFileURL(require.resolve("vite")).href
      )) as unknown as PrototypeVite

      const configFile = locateViteConfig(ctx.prototypeRoot)
      if (configFile === null) {
        // Unreachable through `runHost` (probe refuses first); reachable if
        // someone calls `boot` directly, and a thrown TypeError from Vite would
        // be a worse answer than the sentence probe already wrote.
        throw new Error(
          `No Vite config file in ${ctx.prototypeRoot}, and React Router requires one.`,
        )
      }

      // Never the literal 0 — see `pickLoopbackPort` for the MEASURED Vite
      // 8.0.8 behaviour that turns it into 5173, i.e. into the front door's own
      // port.
      const port =
        ctx.internal.port === 0 ? await pickLoopbackPort(ctx.internal.host) : ctx.internal.port

      let overridden: string[] = []
      const server = await vite.createServer({
        // A REAL path. This is the line React Router's guard is about.
        configFile,
        // Load the repo's config through Vite's module runner rather than by
        // bundling it to `node_modules/.vite-temp/*.mjs` first: the temp-file
        // loader writes into the user's repo, which is the one thing the
        // plugins in this pipeline are forbidden to do. MEASURED in the spike:
        // `.vite-temp` stays empty and `git status` is clean after a boot.
        configLoader: "runner",
        server: {
          host: ctx.internal.host,
          port,
          // A lost port race must be a loud failure, not a silent bind
          // somewhere the proxy is not pointing.
          strictPort: true,
          // Editor's own bookkeeping under `.desde/` must not trigger HMR.
          // `mergeConfig` concatenates arrays, so a repo that also sets this
          // keeps both entries. (Watcher only — HTTP serving is `fs.deny`'s
          // job, and the two are unrelated mechanisms.)
          watch: { ignored: ["**/.desde/**"] },
        },
        plugins: [
          // `??=` on `root`, which an inline `root:` cannot express. MEASURED
          // load-bearing: without it React Router resolves `appDirectory`
          // against `process.cwd()` and dies before listen.
          rootDefaultPlugin(ctx.prototypeRoot),
          ...injection.plugins,
          // LAST in the array and `enforce: 'post'`, so it is last in the post
          // bucket by both orderings. This is the entire security floor on this
          // path — there is no pre-merge `hardenServerConfig` call here,
          // because there is no merge we perform.
          hardenPlugin({
            reportOverrides: true,
            onReport: (report) => {
              overridden = report.overridden
            },
          }),
        ],
        clearScreen: false,
        logLevel: "warn",
      })

      try {
        await server.listen()
      } catch (err) {
        await server.close().catch(() => undefined)
        throw err
      }

      if (overridden.length > 0) {
        console.warn(
          `[host:react-router] Narrowed ${overridden.join(", ")} from this repo's vite.config. ` +
            "Editor pins these so the dev server can't be turned into cross-origin read access to " +
            "your filesystem. To widen filesystem reach legitimately, add to server.fs.allow instead.",
        )
      }

      const address = server.httpServer?.address()
      if (address === null || address === undefined || typeof address === "string") {
        await server.close().catch(() => undefined)
        throw new Error(
          "React Router's Vite dev server did not report a bound TCP address after listen().",
        )
      }
      // Read BACK, never assumed — `strictPort` should make these equal, and
      // the origin is built from what the socket says regardless.
      const origin = listenOriginFor(ctx.internal.host, address.port)

      const expectation = stampExpectationFrom(server)

      return {
        transport: { kind: "http-upstream", origin },

        // The FRONT DOOR's base, which for every fronted host is `/` — the
        // proxy mirrors upstream's path space one-to-one. Reporting the inner
        // Vite's `base` here is the mistake that breaks the shell's
        // served-stylesheet → source-file mapping.
        base: "/",

        bridgeTags: BRIDGE_TAGS,

        hmr: {
          // ONE lane, unlike Nuxt. MEASURED: a single `watcher.emit('change')`
          // through `invalidateViteModules` moved the SERVER-RENDERED stamps
          // (`app/welcome/welcome.tsx:6:4` → `:7:4`) and the edit's marker
          // appeared in the SSR HTML — so the client and SSR lanes share the
          // watcher this reaches.
          lanes: ["client"],
          invalidate: (absFiles) => {
            invalidateViteModules(server, ctx.repoRoot, absFiles)
          },
          // MEASURED in the spike: a `.tsx` edit hot-updates (js-update, no
          // navigation) and every stamp below the insertion shifted by exactly
          // the lines added, with columns unchanged.
          reload: { hot: [".tsx", ".jsx", ".ts", ".js"], fullReload: [] },
        },

        security: {
          narrowedServerConfig: true,
          overridden,
          // Empty, and that is a claim rather than an omission: this host pins
          // the same four keys the shipped Vite path does (asserted over HTTP —
          // `Host: evil.test` → 403 on all three fixtures), AND it sits behind
          // the proxy, so `.desde/**` is refused twice over. The one thing
          // it cannot close is the framework's own listener, which is not a
          // missing protection but a disclosed second door — see
          // `sideDoorOrigins`.
          gaps: [],
        },

        stampExpectation: expectation,

        // React Router binds its own listener and offers no way not to
        // (`middlewareMode` 404s its SSR route). The proxy fronts it; this
        // origin stays reachable, on loopback, serving UN-INJECTED HTML.
        // Disclosed rather than pretended away.
        sideDoorOrigins: [origin],

        // No host can enumerate its own routes cheaply today.
        probeRoutes: [],

        // Points at the INNER origin: this walk fetches `/` to discover entry
        // modules, and the inner server is where the module graph lives.
        moduleGraphEvidence: () => anyStampedModuleHasDataPtSrc(server, origin),

        close: () => server.close(),
      }
    },
  }
}

/**
 * `required-in-html` for an SSR app, `post-hydration` for a SPA — read from the
 * resolved config, never guessed from the host name.
 *
 * Getting this wrong in the `required-in-html` direction refuses to boot a
 * working SPA; in the other direction it silently loses the gate. So an
 * unreadable seam resolves to `post-hydration`, the direction that can only
 * cost a warning.
 *
 * MEASURED: even the `ssr:false` fixture serves 7 stamps in its initial HTML
 * (React Router renders the root shell server-side in SPA mode too). That does
 * not make `required-in-html` safe there — the conjunction only fires on ZERO
 * stamps, and a SPA whose root shell happens to contain no stampable element
 * would be torn down for a stamper that is running fine.
 */
function stampExpectationFrom(server: ViteDevServer): StampExpectation {
  const context = (server.config as { __reactRouterPluginContext?: ReactRouterPluginContext })
    .__reactRouterPluginContext
  const ssr = context?.reactRouterConfig?.ssr
  if (typeof ssr !== "boolean") {
    console.warn(
      "[host:react-router] Could not read this project's `ssr` setting from React Router's " +
        "resolved Vite config (server.config.__reactRouterPluginContext.reactRouterConfig.ssr). " +
        "Stamping verification will treat an un-stamped page as inconclusive rather than as a " +
        "failure. Everything else is unaffected.",
    )
    return "post-hydration"
  }
  return ssr ? "required-in-html" : "post-hydration"
}

/** Vite's own default config filenames, first match wins. `null` when none. */
function locateViteConfig(prototypeRoot: string): string | null {
  for (const name of VITE_CONFIG_NAMES) {
    const candidate = join(prototypeRoot, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function canResolve(require: NodeJS.Require, specifier: string): boolean {
  try {
    require.resolve(specifier)
    return true
  } catch {
    return false
  }
}

/**
 * Installed version of a package, as seen from the prototype.
 *
 * `<pkg>/package.json` is not guaranteed to be an export, so a failure here is
 * an ordinary "cannot tell" rather than a missing package — existence was
 * already established by resolving the entry point the config imports.
 */
function readInstalledVersion(require: NodeJS.Require, packageName: string): string | null {
  try {
    const pkg = require(`${packageName}/package.json`) as { version?: unknown }
    return typeof pkg.version === "string" ? pkg.version : null
  } catch {
    return null
  }
}

function majorOf(version: string): string {
  return version.split(".")[0] ?? version
}

function missingPackage(packageName: string, summary: string): HostFailure {
  return {
    code: "host-package-missing",
    summary,
    remediation: [
      `Run \`npm install\` (or your package manager's equivalent) so ${packageName} is present in node_modules.`,
      "Or start the project's dev server yourself and re-run with --attach <url>.",
    ],
    attachCovers: true,
  }
}
