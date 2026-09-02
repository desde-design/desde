import { readFileSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { createRequire } from "node:module"
import { dirname, isAbsolute, join, relative } from "node:path"
import { listenOriginFor } from "../../server/host-guard.js"
import { pickLoopbackPort } from "../loopback-port.js"
import { materializeNextLoader } from "./loader-cache.js"
import {
  developmentPhaseFrom,
  mergeStampRules,
  probeConfigMemo,
  NEXT_CONFIG_MEMO_SEAM,
  NEXT_CONFIG_MODULE_SEAM,
  NEXT_CONFIG_MUTABILITY_SEAM,
  NEXT_CONFIG_SUBPATH,
  STAMP_RULE_GLOBS,
  type LoadNextConfig,
  type NextConfigObject,
} from "./prime-config.js"
import type {
  BridgeTagStrategy,
  DevServerHost,
  HostBoot,
  HostContext,
  HostSecurityReport,
  MaterializedAssets,
  ProbeResult,
  SourceLanguage,
  StamperInjection,
} from "../types.js"

/**
 * The Next.js host — the only one of the five that genuinely could not be built
 * any other way, and therefore the most gated.
 *
 * **What makes it different from the other four.** Nuxt, Astro and React Router
 * are Vite underneath, so the stamper is a plugin object we hand over in
 * memory. Next has no Vite at all: the stamper is a webpack-style loader
 * registered in `turbopack.rules`, Turbopack runs loaders in a FORKED WORKER,
 * and the only things that cross that boundary are a file path and
 * JSON-serialisable options. Hence a materialized loader on disk
 * (`loader-cache.ts`, never inside the customer's repo) and a `StampPolicy` the
 * compiler holds to plain JSON.
 *
 * **What makes it the most dangerous.** The channel that installs the loader is
 * a private, unversioned seam — mutating Next's memoized config object in place
 * — and its failure mode is silent: the server boots, `app.prepare()` resolves,
 * every route returns 200, and nothing is stamped. Next's own documented `conf`
 * option is exactly that failure (MEASURED: 0 stamps on all three fixture
 * routes, loader never invoked), which is why it is used here as a negative test
 * fixture rather than as the mechanism. So this host is gated three times over:
 * a causal identity assertion in `probe()` BEFORE any boot work, `verifyStamping`
 * against the served HTML AFTER boot, and the ladder's fall back to attach mode —
 * which needs none of these seams — on either.
 *
 * **Containment is better here than anywhere else, which is the opposite of the
 * intuition.** We mount Next's own request handler on OUR `http.Server`, so we
 * bound the only listener: `sideDoorOrigins` is empty, unlike every other
 * fronted host. What Next cannot give us is a dev-server config to narrow — no
 * `fs.deny`, no `allowedHosts`, no `fs.strict` — so the attach proxy in front is
 * this host's entire security floor, and {@link NEXT_SECURITY} says so in the
 * type rather than leaving it to be inferred.
 */

/**
 * MEASURED across Astro, Nuxt and React Router: `transformIndexHtml` fires ZERO
 * times on a server-rendering host. Next does not even have the hook — there is
 * no Vite — so the bridge tags come from the shipped proxy's streaming injector.
 * Referenced by both `DevServerHost.bridgeTags` and `HostBoot.bridgeTags` so the
 * pre-boot promise and the post-boot report cannot drift.
 */
const BRIDGE_TAGS: BridgeTagStrategy = "proxy-response-injection"

/** Next renders JSX by construction; there is no second dialect to widen to. */
const NEXT_LANGUAGES: readonly SourceLanguage[] = ["jsx"]

/**
 * The Next version this host has been MEASURED against, as one fact.
 *
 * **Declared and enforced from the same constant, which they were not.** The
 * gate advertised `tested: "^16.3.0"` and then refused only on a non-16 MAJOR,
 * so `--strict-versions` — a flag whose entire purpose is "refuse anything
 * outside the measured range" — accepted 16.0, 16.1 and 16.2 without a word.
 * Two literals, one of them wrong, and nothing to make them agree.
 *
 * **Why this host and not a shared helper.** Next is the only host whose
 * measured range has a non-zero MINOR. For `^4.0.0` / `^7.0.0` / `^8.0.0` the
 * major-only check and the caret are the same predicate on every release
 * version, so the other four have nothing to fix; generalising this would change
 * their behaviour on prereleases alone, for no measured benefit. It belongs here
 * until a second host needs it.
 */
const MEASURED_NEXT = { major: 16, minor: 3, patch: 0 } as const

/** The declared range, DERIVED. `^16.3.0`. */
const NEXT_TESTED_RANGE = `^${MEASURED_NEXT.major}.${MEASURED_NEXT.minor}.${MEASURED_NEXT.patch}`

/**
 * The security report, as a module constant so § 4's S11 ("`security.gaps` is
 * non-empty for `next` and `attach`") is assertable without booting Next.
 *
 * Non-empty **by construction**, not by omission. Vite gives the other four
 * hosts `server.fs.deny`, `server.allowedHosts` and `server.fs.strict` to pin;
 * Next has no equivalent of any of them. Every one of those protections on this
 * host comes from the attach proxy in front — `checkHost` on both the request
 * and the websocket-upgrade lane, and a segment-wise, percent-decoding
 * `/.desde/**` refusal on both — and a host that cannot narrow the dev
 * server's own config has to say so at boot rather than let a reader assume a
 * shared helper was applied.
 */
export const NEXT_SECURITY: HostSecurityReport = {
  narrowedServerConfig: false,
  overridden: [],
  gaps: [
    "Next.js has no dev-server config for Editor to narrow: no fs.deny, no allowedHosts, no " +
      "fs.strict. Everything Editor serves goes through its proxy, which refuses cross-origin " +
      "Host headers and any /.desde/** path on both the request and websocket lanes; Next's " +
      "own handler is mounted on a listener only that proxy talks to. Anything Next itself serves " +
      "(its /_next/** filesystem routes in particular) is bounded by Next, not by Editor.",
  ],
}

/** Just the two members we call on the module Next's package entry exports. */
interface NextApp {
  prepare(): Promise<void>
  getRequestHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<void>
  /** Attaches Next's HMR upgrade handler to a server we own. Present since 12.x. */
  setupWebSocketHandler?(server: Server): void
  close?(): Promise<void>
}

interface NextOptions {
  dev: boolean
  dir: string
  hostname: string
  port: number
  quiet: boolean
}

type NextFactory = (options: NextOptions) => NextApp

export function createNextHost(): DevServerHost<"turbopack-loader"> {
  return {
    id: "next",
    displayName: "Next.js",

    // Three, and each breaks with a different signature: the module MOVES (throws
    // at require time), the memo stops SHARING (mutation reaches a copy), and the
    // shared object stops ACCEPTING the write (throws mid-boot, or — the
    // dangerous one — swallows it). Only the first is loud on its own.
    seams: [NEXT_CONFIG_MODULE_SEAM, NEXT_CONFIG_MEMO_SEAM, NEXT_CONFIG_MUTABILITY_SEAM],

    // The one to NAME when the server boots healthy and stamps nothing.
    //
    // All three above describe the same channel, so picking one is a question of
    // which spelling a customer can act on: this is the only one that is a
    // module path, so it is what they grep in Next's release notes and in their
    // own `node_modules`, and its `buys` states the fact that makes zero stamps
    // mean what the failure says — it is the ONLY in-memory route a Turbopack
    // loader has. The other two are properties OF this module's memo, and by the
    // time this verdict is reachable `probe()` has already asserted both, so
    // naming either would point at a gate that passed.
    //
    // The claim is also true independently of which one broke: whatever went
    // wrong, `next/dist/server/config` is where the channel lives.
    stamperSeam: NEXT_CONFIG_MODULE_SEAM,

    // MEASURED working: next 16.3.0. Outside the range is a NOTICE rather than a
    // refusal — both seams are asserted causally in `probe` and the served
    // output is verified after boot, so a version number is the weakest of the
    // three signals and should not be the one that refuses. What it declares and
    // what `probeNext` enforces are the same constant; see MEASURED_NEXT.
    versionGate: { packageName: "next", tested: NEXT_TESTED_RANGE },

    accepts: "turbopack-loader",
    devCommand: "npx next dev",
    bridgeTags: BRIDGE_TAGS,

    // `.next` is Next's build/cache output. It sits inside the repo so
    // root-containment admits it, and it is regenerated — a stamp there is a
    // stamp on a file that will not exist by the time anyone edits it.
    buildDirs: [".next"],

    /**
     * Always `jsx`, whatever detection said — the same reasoning as the Nuxt
     * host's unconditional `vue-sfc`. Filtering `ctx.languages` would let a
     * mis-detected framework produce an EMPTY language set, and an empty set
     * makes `stampingCoverage` report neither a covered dialect nor a gap: the
     * one shape where the boot log says nothing at all about stamping.
     */
    stampLanguages(): SourceLanguage[] {
      return [...NEXT_LANGUAGES]
    },

    async probe(ctx: HostContext): Promise<ProbeResult> {
      // MUST come before any Next work in this process — see
      // `markNextDevServer` for the measurement. Restored on refusal so a
      // project that falls back to attach mode does not leave a Next-internal
      // dev flag set in a long-lived CLI whose agent may later shell out to
      // `next build`.
      const restoreDevFlag = markNextDevServer()
      const result = await probeNext(ctx)
      if (!result.ok) restoreDevFlag()
      return result
    },

    /**
     * Bundle the Turbopack loader into the per-user cache dir.
     *
     * The ONLY host that implements this step, which is why it is optional on
     * the interface: the four Vite-family hosts pass a live plugin object and
     * need nothing on disk.
     */
    async materialize(): Promise<MaterializedAssets> {
      const materialized = await materializeNextLoader()
      return { files: { [materialized.loaderPath]: "turbopack-loader" } }
    },

    async boot(
      ctx: HostContext,
      injection: Extract<StamperInjection, { channel: "turbopack-loader" }>,
    ): Promise<HostBoot> {
      // FIRST, before `loadConfig` and before `require("next")` — see
      // `markNextDevServer`. Idempotent with the call in `probe()`; repeated
      // here because `boot()` is independently callable and the ordering is
      // load-bearing, not incidental.
      markNextDevServer()

      const require = createRequire(join(ctx.prototypeRoot, "package.json"))
      const install = resolveNextInstall(require)
      const loadConfig = requireLoadConfig(require, install)
      const phase = developmentPhaseIn(require, install)
      if (!phase.ok) {
        // Unreachable through `runHost` (probe refuses first); reachable if
        // someone calls `boot` directly, and a `TypeError` from deep inside
        // Next would be a worse answer than the sentence probe already wrote.
        throw new Error(`${phase.cause} Re-run with --attach <url>.`)
      }

      // PRIME. A cache hit on the object `probe` already loaded — same process,
      // same phase, same dir, no `customConfig`, so the same key. This is the
      // seam: what comes back is the very object Next's own later load
      // (`next.js:220`) will receive.
      const memo = await probeConfigMemo(loadConfig, phase.phase, ctx.prototypeRoot)
      if (!memo.ok) throw new Error(memo.failure.cause ?? memo.failure.summary)

      // INJECT, in place. `conf.turbopack` is replaced; `conf` itself keeps the
      // identity the memo holds, which is the whole mechanism.
      const merged = mergeStampRules(memo.conf, {
        loaderPath: injection.loaderPath,
        options: injection.options,
        globs: injection.globs,
      })
      if (!merged.ok) throw new Error(merged.failure.cause ?? merged.failure.summary)
      if (merged.preserved.length > 0) {
        console.log(
          `[host:next] Kept this project's own Turbopack rules for ${merged.preserved.join(", ")} ` +
            `alongside Editor's ${injection.globs.join(" / ")} stamper.`,
        )
      }

      // NODE_ENV is deliberately NOT touched: `router-server.js:108` sets it to
      // "development" itself when unset, and overwriting a value the user's
      // shell set would change the behaviour of everything else in this
      // long-lived CLI process, not just Next.
      const nextFactory = require("next") as NextFactory
      // Never the literal 0. `pickLoopbackPort` records the MEASURED Vite 8.0.8
      // behaviour that reads `0` as UNSET and binds 5173 — the front door's own
      // port. Next is not Vite, but "ask for a concrete port and believe only
      // `address()`" is the rule four hosts have now each broken differently.
      const port =
        ctx.internal.port === 0 ? await pickLoopbackPort(ctx.internal.host) : ctx.internal.port

      const app = nextFactory({
        dev: true,
        dir: ctx.prototypeRoot,
        hostname: ctx.internal.host,
        port,
        quiet: true,
      })
      await app.prepare()

      const handler = app.getRequestHandler()
      const server = createServer((req, res) => {
        handler(req, res).catch((err: unknown) => {
          // Next's handler rejecting is not something the proxy in front can
          // interpret; without this the socket hangs until the client times
          // out. 500 with the message keeps a broken route debuggable.
          if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" })
          res.end(`Next.js request handler failed: ${(err as Error).stack ?? String(err)}`)
        })
      })
      // Next's own HMR websocket. It attaches to a server we own rather than one
      // it bound, which is what makes this host `in-process-handler` and not
      // `http-upstream`. The proxy's upgrade tunnel carries it to the browser.
      app.setupWebSocketHandler?.(server)

      try {
        await new Promise<void>((done, fail) => {
          server.once("error", fail)
          server.listen(port, ctx.internal.host, () => {
            server.removeListener("error", fail)
            done()
          })
        })
      } catch (err) {
        await app.close?.().catch(() => undefined)
        throw err
      }

      const address = server.address()
      if (address === null || typeof address === "string") {
        server.closeAllConnections()
        server.close()
        await app.close?.().catch(() => undefined)
        throw new Error("Editor's Next.js listener did not report a bound TCP address.")
      }
      // Read BACK, never assumed.
      const origin = listenOriginFor(ctx.internal.host, address.port)

      return {
        // WE bound the only listener. Next never binds one of its own in this
        // mode, which makes this the easiest host to contain despite being the
        // one with no config to narrow.
        transport: { kind: "in-process-handler", origin },

        // The FRONT DOOR's base. The proxy mirrors upstream's path space
        // one-to-one, and Next serves at the root.
        base: "/",

        bridgeTags: BRIDGE_TAGS,

        hmr: {
          // NONE, and that is a statement rather than a gap: Turbopack owns its
          // own watcher and there is no Vite module graph to replay a write
          // into. MEASURED end-to-end in attach mode (the same Turbopack, the
          // same loader): an edit hot-updates with the stamp intact and the line
          // numbers shifted by the edit, with no help from us.
          lanes: [],
          invalidate: () => undefined,
          // MEASURED in the research proof's `--hmr` run: prepending two lines
          // to `app/client-demo/page.tsx` re-ran the loader and every stamp in
          // that file shifted by two, with no navigation.
          reload: { hot: [".tsx", ".jsx", ".ts", ".js"], fullReload: [] },
        },

        security: NEXT_SECURITY,

        // HARDCODED, unlike every other host — and it is the one host where that
        // is honest rather than lazy. Next's App Router server-renders the
        // document, so zero `data-desde-src` in the response is conclusive: there
        // is no post-hydration lane for the stamps to be hiding in. That is
        // exactly what makes § 6's teardown conjunction reachable here, which is
        // what catches the `conf`-class failure this host is gated against.
        stampExpectation: "required-in-html",

        // EMPTY, and unique among the fronted hosts. Nuxt, Astro and React
        // Router each bind a listener we cannot prevent; Next hands over a
        // request handler instead, so there is no second door to disclose.
        sideDoorOrigins: [],

        // No host can enumerate its own routes cheaply today.
        probeRoutes: [],

        // No `moduleGraphEvidence`: there is no Vite module graph on this host.
        // Its absence is why `verifyStamping` can reach a conclusive verdict
        // here from the HTML alone (conjunction condition 5 is "absent or
        // false"), and it is deliberate rather than missing.

        close: async () => {
          // Destroy sockets first: the proxy in front holds a keep-alive
          // connection and Next holds HMR websockets, so a bare `close()` waits
          // for both and the CLI appears to hang on exit.
          server.closeAllConnections()
          try {
            await new Promise<void>((done, fail) => {
              server.close((err) => (err ? fail(err) : done()))
            })
          } finally {
            // `finally`, so a listener that failed to close still takes Next's
            // own compiler/watcher processes down with it.
            await app.close?.()
          }
        },
      }
    },
  }
}

/**
 * Latch Next's own dev-server flag BEFORE any Next module is loaded, and hand
 * back a restorer.
 *
 * `RouteModule`'s constructor reads it exactly once (`route-module.js:50`,
 * `this.isDev = !!process.env.__NEXT_DEV_SERVER`), and whatever that chunk
 * latches is what the process serves for the rest of its life. When it latches
 * `false`, every request 500s trying to read the production-only
 * `.next/dev/required-server-files.json`.
 *
 * `NextCustomServer.prepare()` sets the same value as its first statement, so
 * the obvious reading is that this call is redundant. It is not — MEASURED, by
 * bisection, on a fixture whose `next.config.ts` declares a `turbopack` block:
 *
 * | flag set                                   | `/` | `/svg-demo` |
 * | ------------------------------------------ | --- | ----------- |
 * | before anything                            | 200 | 200         |
 * | after `require("next/dist/server/config")` | 200 | 200         |
 * | after the first `loadConfig(...)` call     | 500 | 500         |
 *
 * So the poisoning is `loadConfig` evaluating the project's own config, not the
 * deep import — which puts it inside `probe()`, one step before the `boot()`
 * that used to set the flag. On a config of `{}` the late set happened to work,
 * which is exactly what made this look like an intermittent race in the
 * research phase rather than the deterministic ordering bug it is.
 *
 * The restorer exists for the refusal path: a project that ends up on attach
 * mode should not leave a Next-internal dev flag set in a long-lived CLI whose
 * agent may later shell out to `next build`.
 */
function markNextDevServer(): () => void {
  const previous = process.env["__NEXT_DEV_SERVER"]
  process.env["__NEXT_DEV_SERVER"] = "1"
  return () => {
    if (previous === undefined) delete process.env["__NEXT_DEV_SERVER"]
    else process.env["__NEXT_DEV_SERVER"] = previous
  }
}

/**
 * The pre-boot gates, in cost order: installed → version → deep import → phase
 * constant → memo identity → rule collision.
 *
 * A free function rather than the object member so `probe()` can wrap it with
 * the dev-flag latch above and restore on every refusal path without threading
 * a `finally` through six early returns.
 */
async function probeNext(ctx: HostContext): Promise<ProbeResult> {
  const require = createRequire(join(ctx.prototypeRoot, "package.json"))
  const notices: string[] = []

  // 1. Installed, not merely declared. Detection read `package.json` (fast,
  //    offline); this reads `node_modules`.
  if (!canResolve(require, "next")) {
    return {
      ok: false,
      failure: {
        code: "host-package-missing",
        summary: "This project declares Next.js but next is not installed.",
        remediation: [
          "Run `npm install` (or your package manager's equivalent) so next is present in node_modules.",
          "Or start the project's dev server yourself and re-run with --attach <url>.",
        ],
        attachCovers: true,
      },
    }
  }

  // 2. Version, against the SAME range the host declares. A notice by default;
  //    a refusal only under --strict-versions.
  const version = readInstalledVersion(require, "next")
  if (version !== null && !satisfiesTestedRange(version)) {
    const message =
      `This project has next ${version}; Editor's in-process boot is measured against ` +
      `${NEXT_TESTED_RANGE}. Both seams it stands on are private, and a version bump is exactly ` +
      "when they move. But they are asserted causally below and the served output is verified " +
      "after boot, so this is a heads-up rather than a blocker."
    if (ctx.strictVersions) {
      return {
        ok: false,
        failure: {
          code: "host-version-unsupported",
          summary: `next ${version} is outside ${NEXT_TESTED_RANGE}, the range Editor's in-process boot is measured against, and --strict-versions was passed.`,
          seam: NEXT_CONFIG_MODULE_SEAM,
          detected: { package: "next", installed: version, tested: NEXT_TESTED_RANGE },
          remediation: [
            "Drop --strict-versions to boot anyway (both seam assertions and stamping verification still gate the session).",
            "Or start the project's dev server yourself and re-run with --attach <url>.",
          ],
          attachCovers: true,
        },
      }
    }
    notices.push(message)
  }

  // 3. The deep import, taken from the installation `require("next")` binds —
  //    THE single most likely break on a Next upgrade, and it is caught here
  //    rather than mid-boot. See `resolveNextInstall` for why "the same
  //    createRequire base" is not the same thing as "the same install".
  let install: NextInstall
  let loadConfig: LoadNextConfig
  try {
    install = resolveNextInstall(require)
    loadConfig = requireLoadConfig(require, install)
  } catch (err) {
    return {
      ok: false,
      failure: {
        code: "seam-missing",
        summary:
          "Editor could not load Next's internal config loader, which is the only in-memory way to install the source-code stamper.",
        seam: NEXT_CONFIG_MODULE_SEAM,
        cause: (err as Error).message,
        remediation: [
          "Start the project's dev server yourself and re-run with --attach <url>. Attach mode does not use this seam.",
          "Then report the Next.js version: this seam is private and Next may move it in any release.",
        ],
        attachCovers: true,
      },
    }
  }

  // 4. The phase constant, read from Next's own `next/constants` — and from the
  //    SAME installation as everything else. See `developmentPhaseFrom` for why
  //    the phase, not NODE_ENV, is what keeps the stamper out of `next build`.
  const phase = developmentPhaseIn(require, install)
  if (!phase.ok) {
    return {
      ok: false,
      failure: {
        code: "seam-missing",
        summary:
          "Editor could not read PHASE_DEVELOPMENT_SERVER from your project's next/constants.",
        seam: NEXT_CONFIG_MODULE_SEAM,
        cause:
          `${phase.cause} Editor keys its config injection on that exact phase so it can never ` +
          "reach a `next build`; keying it on the wrong value primes a cache entry nothing " +
          "reads, which boots a healthy server that stamps nothing.",
        remediation: [
          "Start the project's dev server yourself and re-run with --attach <url>.",
          "Then report the Next.js version.",
        ],
        attachCovers: true,
      },
    }
  }

  // 5. THE CAUSAL ASSERTION a private seam owes. Everything above proves the
  //    seam is REACHABLE; only this proves it still WORKS.
  const memo = await probeConfigMemo(loadConfig, phase.phase, ctx.prototypeRoot)
  if (!memo.ok) return { ok: false, failure: memo.failure }

  // 6. A rule collision on one of our own globs. Checked pre-boot, against
  //    the config Next actually resolved, so a project that cannot be
  //    stamped safely is told so before anything is bundled or bound.
  const collision = mergeStampRules(cloneForCollisionCheck(memo.conf), {
    loaderPath: "<probe>",
    options: { repoRoot: ctx.policy.stampRoot, policy: ctx.policy },
    globs: STAMP_RULE_GLOBS,
  })
  if (!collision.ok) return { ok: false, failure: collision.failure }

  return { ok: true, version: version ?? "unknown", notices }
}

/**
 * Next's internal config loader, taken from **the installation `boot()` will
 * actually run** rather than from wherever the bare specifier happens to land.
 *
 * Always the customer's own install — editor-cli has no `next` dependency and
 * must not grow one. Two copies of Next in one process each have their own
 * `configCache` module instance, so priming one and booting the other is a
 * mutation that reaches nothing: the healthy-but-unstamped failure, manufactured
 * by us instead of by an upgrade.
 *
 * **Which is exactly what `require("next/dist/server/config")` did.** The old
 * comment claimed one `createRequire` base made the split impossible. It does
 * not: Node resolves a bare specifier and a subpath specifier INDEPENDENTLY, and
 * for the subpath it keeps walking `node_modules` upward until it finds a
 * directory holding THAT FILE. MEASURED, on a fixture whose own `next` is
 * missing `dist/server/config.js` while an ancestor directory has a complete
 * install:
 *
 *     require.resolve("next")                    → <proto>/node_modules/next/dist/server/next.js
 *     require.resolve("next/dist/server/config") → <ancestor>/node_modules/next/dist/server/config.js
 *     probe()                                    → { ok: true, notices: [] }
 *
 * A silent accept, one step before a dev server that boots healthy and stamps
 * nothing. So the resolution is anchored: find the package directory that owns
 * the entry `require("next")` binds, and resolve the seam module as an absolute
 * path inside it — a form Node cannot walk up out of.
 */
function requireLoadConfig(require: NodeJS.Require, install: NextInstall): LoadNextConfig {
  const mod = require(install.configModulePath) as { default?: unknown }
  if (typeof mod.default !== "function") {
    throw new Error(
      `${install.configModulePath} resolved, but its default export is ${typeof mod.default}, not a function.`,
    )
  }
  return mod.default as LoadNextConfig
}

/**
 * The `next` installation this host will boot, and the internals proven to come
 * from it.
 *
 * Threaded through every later lookup rather than each one resolving for itself,
 * because "same installation" is a property of the SET of them, and a property
 * of a set cannot be enforced one call site at a time.
 */
interface NextInstall {
  /** Package directory owning the entry `require("next")` binds. */
  root: string
  /** `<root>/dist/server/config`, as Node resolved it. */
  configModulePath: string
}

/**
 * Resolve that installation. Throws — with the whole sentence — otherwise.
 *
 * Two assertions, because anchoring alone is necessary and not sufficient:
 *
 * 1. **Anchor.** The package root comes from `require.resolve("next")`, the
 *    exact specifier `boot()` binds, and the seam module is resolved as an
 *    absolute path under it. Node's walk-up is not in play for an absolute
 *    specifier, so a neighbouring installation cannot answer for this one.
 * 2. **Containment.** The path Node RETURNED must still be inside that root.
 *    Anchoring fixes the base; it does not fix where the base leads. MEASURED: a
 *    `dist/server/config/package.json` whose `main` is `../../../../elsewhere.js`
 *    resolves back out of the package entirely — and lands on a perfectly
 *    working loader, so nothing downstream would notice. Where a config loader
 *    lives is not evidence about whose module state it holds.
 *
 * A failure of either is `seam-missing` at the caller, which is accurate: the
 * seam is missing FROM THE INSTALLATION WE WOULD BOOT, whatever some other copy
 * on the machine provides.
 */
function resolveNextInstall(require: NodeJS.Require): NextInstall {
  const entryPath = require.resolve("next")
  const root = nextPackageRootOf(entryPath)
  if (root === null) {
    throw new Error(
      `require("next") resolved to ${entryPath}, but no directory above it holds a package.json ` +
        'naming "next", so Editor cannot tell which installation that file belongs to.',
    )
  }

  const anchored = join(root, NEXT_CONFIG_SUBPATH)
  let configModulePath: string
  try {
    configModulePath = require.resolve(anchored)
  } catch (err) {
    throw new Error(`${(err as Error).message}${strayInstallNote(require, root)}`)
  }

  if (!contains(root, configModulePath)) {
    throw new Error(
      `${anchored} resolved to ${configModulePath}, which is outside the next installation at ` +
        `${root}. Editor will not prime a config cache it cannot prove belongs to the install it ` +
        "is booting: each copy of Next holds its own, so priming the wrong one leaves the dev " +
        "server serving normally and stamping nothing.",
    )
  }
  return { root, configModulePath }
}

/**
 * The `next` package directory that owns a file, or `null`.
 *
 * Walks up looking for a package.json whose `name` is `next` specifically —
 * **not** merely the nearest package.json. Packages ship bare `{"type":"module"}`
 * marker manifests inside `dist/`, and stopping at one of those would anchor
 * every later resolution one or two directories too deep, turning a working
 * install into a refusal that names a path nobody recognises.
 */
function nextPackageRootOf(entryPath: string): string | null {
  let dir = dirname(entryPath)
  for (;;) {
    if (packageNameAt(dir) === "next") return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function packageNameAt(dir: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown }
    return typeof parsed.name === "string" ? parsed.name : null
  } catch {
    // Absent, unreadable or malformed — all mean "not the package root", and the
    // walk continues. A parse error here is not worth its own message: the
    // caller's is about which installation we are in, not about JSON.
    return null
  }
}

/**
 * When the anchored resolution fails, say whether ANOTHER installation on this
 * machine would have answered — because that is the difference between "your
 * Next upgrade moved the seam" and "you have two Next installs", and the two
 * have completely different fixes.
 *
 * This is the case the old bare specifier resolved silently, so naming it is the
 * whole product value of the fix.
 */
function strayInstallNote(require: NodeJS.Require, root: string): string {
  let stray: string
  try {
    stray = require.resolve(`next/${NEXT_CONFIG_SUBPATH}`)
  } catch {
    return ""
  }
  if (contains(root, stray)) return ""
  // On its OWN line: Node's "cannot find module" message already carries a
  // multi-line require stack, and appending to it produced a sentence that began
  // mid-path.
  return (
    `\nA DIFFERENT next installation does provide it, at ${stray}. But require("next") binds the ` +
    `one at ${root}, and each copy keeps its own config cache, so priming that one would reach ` +
    "nothing: the dev server would boot healthy and stamp nothing. Editor refuses rather than " +
    "pick one."
  )
}

/**
 * `relative()`, never `startsWith()` — the same rule `StampPolicy` states, for
 * the same reason: `/repo-backup` starts with `/repo`.
 */
function contains(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

type PhaseLookup = { ok: true; phase: string } | { ok: false; cause: string }

/**
 * `PHASE_DEVELOPMENT_SERVER`, out of the SAME installation as everything else.
 *
 * `next/constants` is a third bare specifier, and it splits exactly as the deep
 * import did — MEASURED, on a fixture whose own `next` ships no `constants.js`
 * while an ancestor's does:
 *
 *     require.resolve("next")           → <proto>/node_modules/next/dist/server/next.js
 *     require.resolve("next/constants") → <ancestor>/node_modules/next/constants.js
 *
 * and the phase string came back from the ancestor. That value is the memo's
 * cache KEY, so reading it from a copy that disagrees with the one we boot
 * primes an entry Next never asks for: healthy server, zero stamps, and every
 * pre-boot gate green because the identity assertion happily proves identity of
 * the wrong entry. A false proof is worse than a missing one.
 *
 * **Containment, not anchoring, and the asymmetry is deliberate.** `constants`
 * is a published entry point, so a future `exports` map may legitimately point
 * it at a different file inside the package — an anchored `<root>/constants`
 * would then refuse a working install. Asserting only that whatever Node
 * resolved lives inside the install we boot honours any remap while still
 * refusing the other copy, so it carries no false-refusal risk. The private deep
 * import has the opposite profile: an `exports` map would make the bare
 * specifier throw, so anchoring is what keeps it reachable.
 */
function developmentPhaseIn(require: NodeJS.Require, install: NextInstall): PhaseLookup {
  let constantsPath: string
  try {
    constantsPath = require.resolve("next/constants")
  } catch (err) {
    return { ok: false, cause: `require("next/constants") failed: ${(err as Error).message}.` }
  }
  if (!contains(install.root, constantsPath)) {
    return {
      ok: false,
      cause:
        `next/constants resolved to ${constantsPath}, which belongs to a different next ` +
        `installation than the one require("next") binds at ${install.root}.`,
    }
  }

  let phase: string | null
  try {
    phase = developmentPhaseFrom(require(constantsPath))
  } catch (err) {
    return { ok: false, cause: `Loading ${constantsPath} threw: ${(err as Error).message}.` }
  }
  return phase === null
    ? {
        ok: false,
        cause: `require("next/constants").PHASE_DEVELOPMENT_SERVER is missing or not a string.`,
      }
    : { ok: true, phase }
}

/**
 * A shallow copy for the pre-boot collision check.
 *
 * `mergeStampRules` mutates by design — that IS the injection — so running it
 * for its verdict alone must not leave a `<probe>` loader path on the object
 * Next is about to read. Shallow is enough: the only key it writes is
 * `turbopack`, and it replaces rather than mutates that sub-object.
 */
function cloneForCollisionCheck(conf: NextConfigObject): NextConfigObject {
  return { ...conf }
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
 * already established by resolving the entry point.
 */
function readInstalledVersion(require: NodeJS.Require, packageName: string): string | null {
  try {
    const pkg = require(`${packageName}/package.json`) as { version?: unknown }
    return typeof pkg.version === "string" ? pkg.version : null
  } catch {
    return null
  }
}

/**
 * `major.minor.patch`, with any prerelease and build metadata captured
 * separately. Anchored at both ends: a partial match would read `16.3` out of
 * something that is not a version at all.
 */
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * Is this installed version inside {@link NEXT_TESTED_RANGE}?
 *
 * Standard caret semantics, spelled out because the range string is what the
 * user is shown and it must mean what they read: `^16.3.0` desugars to
 * `>=16.3.0 <17.0.0-0`, so 16.2.9 is OUTSIDE — which is the whole finding — and
 * so is any prerelease, since the comparator carries none. A canary of the
 * measured version is by construction not the build that was measured.
 *
 * **Unparseable is `false`, and that direction is chosen.** A version this
 * cannot read is one we cannot place inside the range, and the consequence of
 * the strict answer is a notice (or, under a flag the user passed on purpose, a
 * refusal that names attach mode). The permissive answer's consequence is the
 * failure this host exists to catch, discovered mid-click.
 */
function satisfiesTestedRange(version: string): boolean {
  const parsed = SEMVER.exec(version.trim())
  if (parsed === null) return false
  if (parsed[4] !== undefined) return false
  const [major, minor, patch] = [Number(parsed[1]), Number(parsed[2]), Number(parsed[3])]
  if (major !== MEASURED_NEXT.major) return false
  if (minor !== MEASURED_NEXT.minor) return minor > MEASURED_NEXT.minor
  return patch >= MEASURED_NEXT.patch
}
