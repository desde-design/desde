import { createRequire } from "node:module"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { InlineConfig, Plugin, ViteDevServer } from "vite"
import { hardenPlugin } from "../../supervisor/harden-plugin.js"
import { invalidateViteModules } from "../vite-invalidate.js"
import { listenOriginFor } from "../../server/host-guard.js"
import { anyStampedModuleHasDataPtSrc } from "../vite/module-graph-evidence.js"
import { createViteCapture, type ViteServerCapture } from "../vite-capture.js"
import { pickLoopbackPort } from "../loopback-port.js"
import type {
  BridgeTagStrategy,
  DevServerHost,
  HostBoot,
  HostContext,
  HostFailure,
  HostSeam,
  ProbeResult,
  SourceLanguage,
  StampExpectation,
  StamperInjection,
} from "../types.js"

/**
 * The Nuxt host — the one where a naive design silently HALF-works.
 *
 * **The two-watcher case, and why it is the whole point.** Nuxt runs a client
 * Vite and an SSR Vite. MEASURED on nuxt 4.5.2 / @nuxt/cli 3.37.0: a
 * `configureServer` capture plugin fires TWICE, and the two servers are
 * genuinely distinct objects — `servers[0] !== servers[1]`, and their
 * `moduleGraph`, `watcher` and `config` are all `!==` too. Emitting a change on
 * the client lane alone leaves the SSR lane serving stale HTML:
 *
 * ```
 * both watchers blinded, file edited, 6s quiet   -> SSR HTML has EDITED: false
 * emit 'change' on the CLIENT lane only          -> SSR HTML has EDITED: false
 *                                                   stamps still 3:5 / 4:5
 * emit 'change' on the SSR lane as well          -> SSR HTML has EDITED: true
 *                                                   stamps moved to 4:5 / 5:5
 * ```
 *
 * That is what "the stamp moved but the edit did nothing" looks like from the
 * user's side, and it is why {@link HostBoot.hmr} carries `lanes` and
 * `invalidate` rather than a single `ViteDevServer`.
 *
 * **The same plurality decides the stamp verdict.** MEASURED, and this one is a
 * false-positive that would have torn down a working session: a globally-SSR
 * app with `routeRules: { "/": { ssr: false } }` serves `/` with ZERO stamps
 * while `/about` serves six. Walking only the client lane's module graph
 * reports `false` there, which — with `required-in-html` — completes § 6's
 * teardown conjunction and shuts the server down. Walking the SSR lane reports
 * `true`, and the session survives. So `moduleGraphEvidence` asks EVERY captured
 * lane.
 *
 * Everything MEASURED below was measured on nuxt 4.5.2 with the shipped
 * `sourceTagPlugin`, against fixtures rebuilt from tracked sources with
 * hand-written configs carrying no Desde wiring at all.
 */

/**
 * MEASURED: `transformIndexHtml` fires ZERO times on Nuxt — the served document
 * is Nitro's render, not a transformed index.html. The bridge tags come from
 * the shipped proxy's streaming injector, and this constant is what tells the
 * plugin-assembly site to install `bridgeAssetsPlugin` (serving only) rather
 * than the composed `bridgePlugin`. Referenced by both `DevServerHost.bridgeTags`
 * and `HostBoot.bridgeTags` so the pre-boot promise and the post-boot report
 * cannot drift.
 */
const BRIDGE_TAGS: BridgeTagStrategy = "proxy-response-injection"

const RUN_COMMAND_SEAM: HostSeam = {
  id: "@nuxt/cli/runCommand(dev, --no-fork)",
  stability: "private",
  expression: 'runCommand("dev", ["--no-fork", "--cwd", root], { overrides })',
  buys: "the whole in-process boot: the dev server, and the Vite plugin pipeline the source stamper rides in on",
}

const FORK_FLAG_SEAM: HostSeam = {
  id: "@nuxt/cli main.subCommands.dev().args.fork",
  stability: "private",
  expression: '(await main.subCommands.dev()).default.args.fork',
  buys: "the pre-boot proof that --no-fork is still a flag; without it the boot returns no listener at all",
}

/**
 * Public: `vite.plugins` is a documented `NuxtConfig` key. Listed separately
 * from `runCommand` because they break differently — the call moving is a hard
 * failure at boot, while `vite.plugins` quietly ceasing to be forwarded would be
 * the healthy-but-unstamped class, which `verifyStamping` is the gate for.
 *
 * Which is exactly why it is ALSO this host's {@link DevServerHost.stamperSeam}:
 * of Nuxt's three seams it is the only one whose failure is silent, so if the
 * server boots healthy and stamps nothing, the forwarding step is what did not
 * deliver. One constant, referenced by both members, so the seam table and the
 * failure message cannot name different things.
 */
const VITE_PLUGINS_SEAM: HostSeam = {
  id: "NuxtConfig.vite.plugins",
  stability: "public",
  expression: "overrides.vite.plugins = [...]",
  buys: "delivery of the source stamper and the bridge-asset routes into BOTH of Nuxt's Vite servers",
}

/** Nuxt renders `.vue`, and unlike Astro there is no island dialect to widen to. */
const NUXT_LANGUAGES: readonly SourceLanguage[] = ["vue-sfc"]

/**
 * The shape we use out of the PROTOTYPE's `@nuxt/cli`.
 *
 * Declared locally rather than importing Nuxt's types: editor-cli has no `nuxt`
 * dependency (and must not grow one — the host drives the customer's install,
 * whose version is theirs to choose). Naming only the members we call keeps the
 * cast honest about how much it is claiming, and `probe` verifies the two that
 * matter before boot.
 */
interface NuxtCli {
  runCommand(
    name: string,
    argv: string[],
    opts: { overrides?: NuxtOverrides },
  ): Promise<{ result?: NuxtDevResult }>
  /** The citty command tree. Used ONLY for the `--no-fork` assertion. */
  main?: { subCommands?: Record<string, unknown> }
}

/**
 * What `runCommand("dev", …)` resolves to. MEASURED keys: `listener`, `close`.
 * The listener is a listhen listener; MEASURED keys: `url`, `https`, `server`,
 * `address`, `open`, `showURL`, `getURLs`, `close`.
 */
interface NuxtDevResult {
  listener?: { address?: { port?: unknown } | null; url?: unknown }
  close?: () => Promise<void>
}

/**
 * The `overrides` we hand `runCommand`. `vite` and `devServer` are documented
 * `NuxtConfig` keys; passing them THROUGH `runCommand`'s `overrides` argument is
 * the private part, which is why the seam above names the call and not the keys.
 */
interface NuxtOverrides {
  devServer: { host: string; port: number }
  vite: { plugins: Plugin[]; server: { watch: { ignored: string[] } } }
}

export function createNuxtHost(): DevServerHost<"vite-plugin"> {
  return {
    id: "nuxt",
    displayName: "Nuxt",

    seams: [RUN_COMMAND_SEAM, FORK_FLAG_SEAM, VITE_PLUGINS_SEAM],

    // Reachable here, unlike on the other Vite-family hosts: a globally-SSR Nuxt
    // app reports `required-in-html`, which is the expectation zero stamps can
    // conclude from. See the constant for why this seam and not the other two.
    stamperSeam: VITE_PLUGINS_SEAM,

    // MEASURED working: nuxt 4.5.2 (with @nuxt/cli 3.37.0). Outside the range is
    // a notice rather than a refusal — `verifyStamping` is the real gate.
    versionGate: { packageName: "nuxt", tested: "^4.0.0" },

    accepts: "vite-plugin",
    devCommand: "npx nuxt dev",
    bridgeTags: BRIDGE_TAGS,

    // `.nuxt` is Nuxt's generated app/template directory. It sits inside the
    // repo, so root-containment admits it, and it is rewritten on every boot —
    // a stamp there is a stamp on a file that will not exist by the time anyone
    // edits it. `.output` is NOT denied, for the same reason astro does not deny
    // `dist/`: it is production output the dev server never transforms, and
    // denying it would silently unstamp a repo that legitimately keeps source
    // under that name.
    buildDirs: [".nuxt"],

    /**
     * Always `vue-sfc`, whatever detection said.
     *
     * Unlike React Router — which filters `ctx.languages` because a repo could
     * plausibly carry more than JSX — a Nuxt app's templates are `.vue` by
     * construction. Filtering here would let a mis-detected `framework: "react"`
     * produce an EMPTY language set, and an empty set means `stampingCoverage`
     * reports neither a covered dialect nor a gap: the one shape where the boot
     * log says nothing at all about stamping.
     */
    stampLanguages(): SourceLanguage[] {
      return [...NUXT_LANGUAGES]
    },

    async probe(ctx: HostContext): Promise<ProbeResult> {
      const require = createRequire(join(ctx.prototypeRoot, "package.json"))
      const notices: string[] = []

      // 1. Installed, not merely declared. Detection read `package.json`; this
      //    reads `node_modules`.
      let nuxtPkgPath: string
      try {
        nuxtPkgPath = require.resolve("nuxt/package.json")
      } catch {
        return {
          ok: false,
          failure: {
            code: "host-package-missing",
            summary: "This project declares Nuxt but nuxt is not installed.",
            remediation: [
              "Run `npm install` (or your package manager's equivalent) so nuxt is present in node_modules.",
              "Or start the project's dev server yourself and re-run with --attach <url>.",
            ],
            attachCovers: true,
          },
        }
      }

      // 2. `@nuxt/cli`, resolved FROM NUXT rather than from the app. It is a
      //    dependency of `nuxt`, not of the project — a pnpm layout in
      //    particular will not have it reachable from the app root.
      const requireFromNuxt = createRequire(nuxtPkgPath)
      let cliEntry: string
      try {
        cliEntry = requireFromNuxt.resolve("@nuxt/cli")
      } catch (err) {
        return { ok: false, failure: seamMissing((err as Error).message) }
      }

      let cli: NuxtCli
      try {
        cli = (await import(pathToFileURL(cliEntry).href)) as unknown as NuxtCli
      } catch (err) {
        return { ok: false, failure: seamMissing((err as Error).message) }
      }

      if (typeof cli.runCommand !== "function") {
        return {
          ok: false,
          failure: {
            code: "seam-shape-changed",
            summary:
              "Your project's @nuxt/cli no longer exports a `runCommand` function, so Editor cannot boot Nuxt in-process.",
            seam: RUN_COMMAND_SEAM,
            cause: `typeof require("@nuxt/cli").runCommand === "${typeof cli.runCommand}"`,
            remediation: [
              "Start the project's dev server yourself and re-run with --attach <url>.",
              "Then report the Nuxt version. This seam is private and is expected to move eventually.",
            ],
            attachCovers: true,
          },
        }
      }

      // 3. THE CAUSAL ASSERTION a private seam owes (§ 1, `HostSeam.stability`).
      //
      //    `--no-fork` is not a preference. MEASURED: with fork on, the pool
      //    children die MODULE_NOT_FOUND and the caller loses `result.listener`
      //    entirely — a boot that "succeeds" and hands back nothing to serve. So
      //    the property we depend on is that `dev` still DECLARES a `fork` flag,
      //    and that is readable before any boot work:
      //    `main.subCommands.dev` is a lazy loader returning `{ meta, args, run }`,
      //    and MEASURED `args.fork === { type: "boolean", default: true, alias: ["f"] }`.
      //
      //    Three outcomes, deliberately not two. A flag table we can read and
      //    that has no `fork` is a refusal; a table we cannot read at all is a
      //    NOTICE, because the assertion is a check and not a dependency — the
      //    boot's own listener guard still catches the failure, one step later
      //    and with a worse message.
      //
      //    Cost: `subCommands.dev` is a lazy loader, so this IMPORTS the dev
      //    command module — the one expensive step in an otherwise cheap probe,
      //    on top of importing `@nuxt/cli` itself two steps above. It is still
      //    side-effect-free: nothing is bound, spawned or written, and citty
      //    command modules are declarations.
      const fork = await readForkArg(cli)
      if (fork.kind === "absent") {
        return {
          ok: false,
          failure: {
            code: "seam-shape-changed",
            summary:
              "Your project's Nuxt CLI no longer has a `--fork` flag, so Editor cannot ask it for an un-forked dev server.",
            seam: FORK_FLAG_SEAM,
            cause: `the "dev" command declares args [${fork.args.join(", ")}] with no "fork" among them`,
            remediation: [
              "Start the project's dev server yourself and re-run with --attach <url>.",
              "Then report the Nuxt version. Forked mode gives Editor no listener to serve, so this is a refusal rather than a degraded boot.",
            ],
            attachCovers: true,
          },
        }
      }
      if (fork.kind === "unreadable") {
        notices.push(
          "Could not read the Nuxt CLI's flag table to confirm `--no-fork` still exists " +
            `(${fork.reason}). Booting anyway; if Nuxt has dropped the flag, the boot fails with ` +
            "no listener rather than silently, and attach mode covers it.",
        )
      }

      const version = readInstalledVersion(require, "nuxt")
      if (version !== null && majorOf(version) !== "4") {
        const message =
          `This project has nuxt ${version}; Editor's in-process boot is measured against 4.x. ` +
          "The boot seam is @nuxt/cli's `runCommand`, which is private. A major bump is exactly when it may change shape."
        if (ctx.strictVersions) {
          return {
            ok: false,
            failure: {
              code: "host-version-unsupported",
              summary: `nuxt ${version} is outside the measured range, and --strict-versions was passed.`,
              seam: RUN_COMMAND_SEAM,
              detected: { package: "nuxt", installed: version, tested: "^4.0.0" },
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
      const requireFromNuxt = createRequire(require.resolve("nuxt/package.json"))
      // Cached from `probe`, which already proved this resolves and exports
      // `runCommand`. Re-resolving rather than threading the module through
      // keeps `boot` independently callable (which is how it is unit-tested).
      const cli = (await import(
        pathToFileURL(requireFromNuxt.resolve("@nuxt/cli")).href
      )) as unknown as NuxtCli

      // Never the literal 0 — `pickLoopbackPort` records the MEASURED Vite
      // 8.0.8 behaviour that reads `0` as UNSET. Nuxt takes its port through
      // `devServer.port` and behaves a FOURTH way again (see the read-back note
      // below), so asking for a concrete port keeps the question moot here too.
      const port =
        ctx.internal.port === 0 ? await pickLoopbackPort(ctx.internal.host) : ctx.internal.port

      const capture = createViteCapture()
      const allowedHosts = { value: undefined as unknown }

      let overridden: string[] = []
      const { result } = await cli.runCommand(
        "dev",
        [
          // MANDATORY. See the causal assertion in `probe` — with fork on there
          // is no `result.listener` to serve.
          "--no-fork",
          // Independent of `process.cwd()`, which `core.ts` happens to have
          // already set to the same place. A boot argument that depends on
          // ambient process state is a boot argument that breaks when someone
          // calls this from a test.
          "--cwd",
          ctx.prototypeRoot,
        ],
        {
          overrides: {
            // MEASURED: this alone binds the port, with no `--port` argv.
            devServer: { host: ctx.internal.host, port },
            vite: {
              plugins: [
                ...injection.plugins,
                capture.plugin(),
                allowedHostsSnoop(allowedHosts),
                // LAST in the array and `enforce: 'post'` internally, so it is
                // last in the post bucket by both orderings. MEASURED over HTTP
                // on this host, which is the only assertion that means anything
                // (§ 4, S3): `Host: evil.test` → 403 while the correct Host →
                // 200; `/_nuxt/@fs<abs>/.env` → 403; no
                // `access-control-allow-origin` for `Origin: http://evil.test`.
                // Resolved `fs.deny` carried `.desde` and
                // `**/.desde/**`, `fs.strict` true, `allowedHosts` `[]`.
                hardenPlugin({
                  reportOverrides: true,
                  onReport: (report) => {
                    overridden = report.overridden
                  },
                }),
              ],
              server: {
                // Editor's own bookkeeping under `.desde/` must not trigger
                // HMR. MEASURED: the resolved list was
                // `[null, {}, "**/.desde/**"]` — Nuxt PREPENDS its own
                // entries rather than replacing ours. (Watcher only; refusing to
                // SERVE those paths is `fs.deny`'s job above, and the two are
                // unrelated mechanisms.)
                watch: { ignored: ["**/.desde/**"] },
              },
            },
          },
        },
      )

      const listener = result?.listener
      const addressPort = listener?.address?.port
      const close = result?.close
      if (typeof addressPort !== "number" || typeof close !== "function") {
        // The failure a PRIVATE seam earns. This is also the exact shape a
        // forked boot produces (`result.listener` undefined), so the message
        // names the flag — and whatever half-bound listener exists has to come
        // down with it, or a failed boot leaves a dev server on a port nothing
        // is pointing at.
        await Promise.resolve(result?.close?.()).catch(() => undefined)
        throw new Error(
          "Nuxt's dev command returned no listener with a bound TCP port " +
            `(typeof listener=${typeof listener}, address=${JSON.stringify(listener?.address)}, ` +
            `typeof close=${typeof result?.close}). This is what forked mode produces, and what a ` +
            "change to @nuxt/cli's private runCommand seam would produce; re-run with --attach <url>, " +
            "which does not use it.",
        )
      }

      // Read BACK, never assumed, and on this host that is load-bearing in a way
      // it is not elsewhere. MEASURED with a squatter on the requested port:
      // Nuxt neither fails (React Router's `strictPort`) nor increments
      // (Astro) — `get-port` logs one line and falls back to **3000**, Nuxt's
      // own default. There is no `strictPort` equivalent to ask for, so the only
      // defence is to believe the socket rather than the request.
      const origin = listenOriginFor(ctx.internal.host, addressPort)

      // The report, minus one measured false positive. MEASURED: Nuxt itself
      // sets `server.allowedHosts` to the host it was told to bind
      // (`["127.0.0.1"]`), so `hardenServerConfig`'s "a non-empty array means
      // someone widened it" heuristic fires on EVERY boot of EVERY Nuxt project,
      // for something the repo did not do and that takes nothing away (Vite's
      // defaults already accept loopback). A warning that is always present is a
      // warning nobody reads, so it is dropped — but ONLY for that exact value.
      // A repo's `true`, or any real hostname list, still reports.
      if (isJustTheBindHost(allowedHosts.value, ctx.internal.host)) {
        overridden = overridden.filter((key) => key !== "server.allowedHosts")
      }
      if (overridden.length > 0) {
        console.warn(
          `[host:nuxt] Narrowed ${overridden.join(", ")} from the Vite config this project resolved. ` +
            "Editor pins these so the dev server can't be turned into cross-origin read access to " +
            "your filesystem. To widen filesystem reach legitimately, add to server.fs.allow instead.",
        )
      }

      // THE assertion this host exists for. MEASURED: an SSR Nuxt app hands
      // `configureServer` two servers (`build.ssr` false then true) with
      // distinct module graphs and distinct watchers. One lane is the SPA shape
      // (`ssr: false` in nuxt.config), which is legitimate. Anything else means
      // a lane we would never invalidate — and a lane we never invalidate looks
      // exactly like an edit that did not take.
      const lanes = capture.servers.map(laneNameOf)
      if (capture.servers.length !== 2 && capture.servers.length !== 1) {
        console.warn(
          `[host:nuxt] Expected Nuxt to hand over 1 (SPA) or 2 (SSR) Vite servers and captured ` +
            `${capture.servers.length}. Edits are replayed into every lane Editor can see; if an ` +
            "edit stops taking effect on the rendered page, this is why.",
        )
      }

      return {
        transport: { kind: "http-upstream", origin },

        // The FRONT DOOR's base, which for every fronted host is `/` — the proxy
        // mirrors upstream's path space one-to-one. MEASURED, and this host is
        // the reason the field is defined that way at all: Nuxt's inner Vite
        // resolves `base` to `/_nuxt/`, and reporting THAT is what breaks the
        // shell's served-stylesheet → source-file mapping.
        base: "/",

        bridgeTags: BRIDGE_TAGS,

        hmr: {
          // TWO on an SSR app, and the plurality is the point. Named from each
          // captured server's own `build.ssr`, so the report describes what was
          // captured rather than what was expected.
          lanes,
          invalidate: (absFiles) => {
            // EVERY lane. Emitting on the client lane alone is MEASURED to leave
            // the SSR lane serving stale HTML with stale stamps, which presents
            // as "the stamp moved but the edit did nothing".
            for (const server of capture.servers) {
              invalidateViteModules(server, ctx.repoRoot, absFiles)
            }
          },
          // MEASURED by reading the HMR websocket frames with a browser
          // attached: a `.vue` edit produces `update(js-update)` with the
          // page's client state intact and zero navigations, for a component
          // AND for a page file. Nothing on this host was measured to force a
          // reload, so `fullReload` is empty rather than speculative.
          reload: { hot: [".vue"], fullReload: [] },
        },

        security: {
          narrowedServerConfig: true,
          overridden,
          // Empty as a CLAIM, not an omission: every pin was verified over HTTP
          // on this host (see the `hardenPlugin` comment above), and it sits
          // behind the proxy as well, so `.desde/**` is refused twice over.
          // The one thing this host cannot close is Nuxt's own listener, which
          // is not a missing protection but a disclosed second door — see
          // `sideDoorOrigins`.
          gaps: [],
        },

        // Computed from what Nuxt actually built, never guessed from the host
        // name. MEASURED both directions on the same fixture: `ssr: true` (the
        // default) captures TWO lanes and server-renders `/` with 7 stamps;
        // `ssr: false` captures ONE lane and serves `/` with ZERO stamps. So the
        // lane count IS the SSR signal, and it is the same fact `lanes` reports.
        //
        // Direction matters more than precision here: `required-in-html` on a
        // SPA refuses to boot a working project, while `post-hydration` only
        // costs a warning. So anything other than the measured 2-lane SSR shape
        // resolves to `post-hydration`, which by § 6's conjunction can never
        // conclude.
        stampExpectation: stampExpectationFor(capture),

        // Nuxt binds its own listener and offers no way not to. The proxy fronts
        // it; this origin stays reachable, on loopback, serving UN-INJECTED
        // HTML. Disclosed rather than pretended away.
        sideDoorOrigins: [origin],

        // No host can enumerate its own routes cheaply today (§ 8, open
        // question 12).
        probeRoutes: [],

        // EVERY lane, and this is the measured rescue rather than thoroughness.
        // On the `routeRules: { "/": { ssr: false } }` fixture the client lane
        // reports `false` and the SSR lane reports `true`; a client-only walk
        // would complete § 6's teardown conjunction and shut down a session
        // whose stamper is running perfectly.
        moduleGraphEvidence: async () => {
          for (const server of capture.servers) {
            const said = await anyStampedModuleHasDataPtSrc(server, origin).catch(() => false)
            if (said) return true
          }
          return false
        },

        // MEASURED: settles in ~22ms and releases the port; the fixture is
        // byte-identical afterwards.
        close: () => close(),
      }
    },
  }
}

/**
 * `required-in-html` only for the MEASURED two-lane SSR shape.
 *
 * See the call site for the measurement. The safe direction is the lenient one,
 * so every other shape — the one-lane SPA, and a lane count nothing measured —
 * lands on `post-hydration`.
 */
function stampExpectationFor(capture: ViteServerCapture): StampExpectation {
  const ssrLane = capture.servers.some((server) => server.config.build?.ssr === true)
  return capture.servers.length === 2 && ssrLane ? "required-in-html" : "post-hydration"
}

/** `"ssr"` or `"client"`, from the lane's own resolved config. */
function laneNameOf(server: ViteDevServer): string {
  return server.config.build?.ssr === true ? "ssr" : "client"
}

/**
 * Capture `server.allowedHosts` as it stands BEFORE the hardening plugin's
 * post-order `config` hook pins it.
 *
 * `hardenServerConfig` reports the key as overridden whenever it finds a
 * non-empty array, which cannot distinguish "the repo widened this" from "Nuxt
 * echoed the host we asked it to bind". The value itself can, and this is the
 * only place it is readable.
 */
function allowedHostsSnoop(sink: { value: unknown }): Plugin {
  return {
    name: "@desde/editor-nuxt-allowed-hosts-snoop",
    config: {
      // `pre`, so it reads the value before `@desde/editor-harden`'s
      // `post` hook replaces it.
      order: "pre",
      handler(config: InlineConfig) {
        // Fires once per lane; the lanes agree, and the first read is the one
        // that has not been through any of our own mutation.
        if (sink.value === undefined) sink.value = config.server?.allowedHosts
        return undefined
      },
    },
  }
}

/** True only for the exact shape Nuxt produces on its own: `[<the bind host>]`. */
function isJustTheBindHost(value: unknown, bindHost: string): boolean {
  return Array.isArray(value) && value.length === 1 && value[0] === bindHost
}

type ForkArg =
  | { kind: "present" }
  | { kind: "absent"; args: string[] }
  | { kind: "unreadable"; reason: string }

/**
 * Read the `dev` command's `fork` flag out of the CLI's own command tree.
 *
 * MEASURED shape on @nuxt/cli 3.37.0: `main.subCommands` is a record of LAZY
 * loaders, `subCommands.dev()` resolves to a module whose `default` is the
 * citty command `{ meta, args, run }`, and
 * `args.fork === { type: "boolean", default: true, alias: ["f"] }`.
 *
 * Every step is defensive because this is a private surface being used to
 * check another private surface: an unreadable table is a notice, not a
 * refusal.
 */
async function readForkArg(cli: NuxtCli): Promise<ForkArg> {
  const loader = cli.main?.subCommands?.dev
  if (typeof loader !== "function") {
    return { kind: "unreadable", reason: "@nuxt/cli exposes no main.subCommands.dev loader" }
  }
  let resolved: unknown
  try {
    resolved = await (loader as () => Promise<unknown>)()
  } catch (err) {
    return { kind: "unreadable", reason: (err as Error).message }
  }
  const command = (resolved as { default?: unknown })?.default ?? resolved
  const args = (command as { args?: unknown })?.args
  if (typeof args !== "object" || args === null) {
    return { kind: "unreadable", reason: "the resolved dev command declares no args table" }
  }
  const names = Object.keys(args as Record<string, unknown>)
  return names.includes("fork") ? { kind: "present" } : { kind: "absent", args: names }
}

function seamMissing(cause: string): HostFailure {
  return {
    code: "seam-missing",
    summary: "Editor could not load @nuxt/cli from your project's Nuxt installation.",
    seam: RUN_COMMAND_SEAM,
    cause,
    remediation: [
      "Reinstall dependencies (`rm -rf node_modules && npm install`) and try again.",
      "Or start the project's dev server yourself and re-run with --attach <url>.",
    ],
    attachCovers: true,
  }
}

/**
 * Installed version of a package, as seen from the prototype.
 *
 * `<pkg>/package.json` is not guaranteed to be an export — MEASURED, `@nuxt/cli`
 * does not export it at all (`ERR_PACKAGE_PATH_NOT_EXPORTED`), which is why the
 * version gate reads `nuxt` and not the CLI. A failure here is an ordinary
 * "cannot tell" rather than a missing package.
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
