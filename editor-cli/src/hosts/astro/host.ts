import { createRequire } from "node:module"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { Plugin, ViteDevServer } from "vite"
import { hardenPlugin } from "../../supervisor/harden-plugin.js"
import { invalidateViteModules } from "../vite-invalidate.js"
import { listenOriginFor } from "../../server/host-guard.js"
import { anyStampedModuleHasDataPtSrc } from "../vite/module-graph-evidence.js"
import { createViteCapture } from "../vite-capture.js"
import { pickLoopbackPort } from "../loopback-port.js"
import type {
  BridgeTagStrategy,
  DevServerHost,
  HostBoot,
  HostContext,
  HostSeam,
  ProbeResult,
  SourceLanguage,
  StamperInjection,
} from "../types.js"

/**
 * The Astro host — the first host standing on a seam its own vendor marks
 * `@experimental`, and the first whose stamping coverage is honestly PARTIAL.
 *
 * **The experimental seam.** `astro/dist/core/dev/dev.d.ts` carries
 * `@experimental The JavaScript API is experimental` on `dev()` itself. That is
 * not a reason to avoid it — `astro dev` and `dev()` are the same code path, and
 * the alternative (spawning the user's dev command) is a process-lifecycle
 * surface we deliberately do not build (§ 7). It is a reason to gate it: `probe`
 * asserts `typeof mod.dev === "function"` before any boot work, the failure
 * names the seam and its stability, and attach mode — which needs none of our
 * seams — is one flag away.
 *
 * **Two islands, one page, and a hole in the middle.** An Astro page is `.astro`
 * template markup with framework components (`.tsx` / `.jsx` / `.vue`) mounted
 * inside it. The islands stamp through the ordinary Vite plugin channel; the
 * `.astro` markup has NO stamper in v1 and is not getting one here (§ 7 —
 * the mechanism is proven, but there is no `.astro` applicator and no `.astro`
 * case in `checkExtensionGate`, so a stamp would buy selection while every edit
 * 400s). So this host reports `stampExpectation: "partial"` and declares the
 * gap through `stampLanguages`, and a page that stamps nothing at all is a
 * WARNING naming the gap — never a boot failure.
 *
 * Everything MEASURED below was measured on astro 7.2.0 + `@astrojs/react` 5,
 * with the shipped `jsxSourceTagPlugin`, on a fixture rebuilt from scratch with
 * a hand-written config carrying no Desde wiring at all.
 */

/**
 * Island dialects an Astro page can mount that a Vite plugin can stamp.
 *
 * `"astro"` is deliberately NOT here: `stampLanguages` reports it
 * unconditionally *because* it has no provider — that is what turns the gap
 * into a printed line instead of a silence.
 */
const ASTRO_ISLAND_LANGUAGES: readonly SourceLanguage[] = ["jsx", "vue-sfc"]

/**
 * MEASURED: `transformIndexHtml` fires ZERO times on Astro (Q1 of the research
 * sweep, re-confirmed here — the served document is Astro's own render, not a
 * transformed index.html). The bridge tags come from the shipped proxy's
 * streaming injector, and this constant is what tells the plugin-assembly site
 * to install `bridgeAssetsPlugin` (serving only) rather than the composed
 * `bridgePlugin`. Referenced by both `DevServerHost.bridgeTags` and
 * `HostBoot.bridgeTags` so the pre-boot promise and the post-boot report cannot
 * drift.
 */
const BRIDGE_TAGS: BridgeTagStrategy = "proxy-response-injection"

const DEV_SEAM: HostSeam = {
  id: "astro/dev",
  stability: "experimental",
  expression: 'import("astro").dev({ root, server, vite: { plugins } })',
  buys: "the whole in-process boot: the dev server, and the Vite plugin pipeline the source stamper rides in on",
}

/**
 * The shape we use out of the PROTOTYPE's Astro install.
 *
 * Declared locally rather than importing Astro's types: editor-cli has no
 * `astro` dependency (and must not grow one — the host resolves the customer's
 * install, whose version is theirs to choose), so there is nothing to import
 * from. Naming only the members we call keeps the cast honest about how much it
 * is claiming, and `probe` verifies the one that matters before boot.
 */
interface AstroDevServer {
  /** `AddressInfo` from the listener Astro bound. MEASURED accurate — see `boot`. */
  address: { address: string; port: number }
  stop(): Promise<void>
}

interface AstroInlineConfigShape {
  root: string
  logLevel: "warn"
  server: { host: string; port: number }
  vite: {
    plugins: Plugin[]
    server: { watch: { ignored: string[] } }
  }
}

interface PrototypeAstro {
  dev(config: AstroInlineConfigShape): Promise<AstroDevServer>
}

export function createAstroHost(): DevServerHost<"vite-plugin"> {
  return {
    id: "astro",
    displayName: "Astro",

    seams: [
      DEV_SEAM,
      {
        // Public: `vite` is a documented `AstroUserConfig` key and
        // `AstroInlineConfig` extends it. It is listed separately from `dev`
        // because they break differently — `dev` moving is a hard failure at
        // boot, while `vite.plugins` quietly ceasing to be forwarded would be
        // the healthy-but-unstamped class, which `verifyStamping` is the gate
        // for.
        id: "AstroInlineConfig.vite.plugins",
        stability: "public",
        expression: "dev({ vite: { plugins: [...] } })",
        buys: "delivery of the source stamper and the bridge-asset routes into Astro's own Vite server",
      },
    ],

    // No `stamperSeam` — and not for want of a candidate: the seam above is
    // Nuxt's designation shape exactly, a forwarding step whose silent failure
    // would be precisely the healthy-but-unstamped class. The reason is that
    // this host reports `partial` unconditionally, so `injection-not-observed`
    // is unreachable for it and the designation would be a member nothing could
    // ever render. Designate it the day `.astro` markup gets a stamper and this
    // flips to `required-in-html`.

    // MEASURED working: astro 7.2.0. Outside the range is a notice rather than
    // a refusal — `verifyStamping` is the real gate, and an experimental seam
    // that still answers `typeof dev === "function"` is more likely to work than
    // not.
    versionGate: { packageName: "astro", tested: "^7.0.0" },

    accepts: "vite-plugin",
    devCommand: "npx astro dev",
    bridgeTags: BRIDGE_TAGS,

    // `.astro` is Astro's generated content-collection types + settings
    // directory. It sits inside the repo, so root-containment admits it, and it
    // is rewritten on every boot — a stamp there is a stamp on a file that will
    // not exist by the time anyone edits it. `dist/` is NOT denied, for the same
    // reason the plain Vite host denies nothing: it is production output the dev
    // server never transforms, and denying it would silently unstamp a repo that
    // legitimately keeps source under that name.
    buildDirs: [".astro"],

    /**
     * `.astro` ALWAYS, plus whichever island dialects this project has.
     *
     * The unconditional `"astro"` is the whole point: it has no provider, so it
     * lands in `StampingCoverage.uncovered` and gets printed at boot. Omitting
     * it would make the coverage report say "everything is covered" about a
     * host where the page markup demonstrably is not.
     *
     * `installed` is the package-name set from detection. It is EMPTY today —
     * `HostDetection.installed` arrives with the detection rewrite — so this
     * must be, and is, correct without it: the island languages come from
     * `ctx.languages`, which today is single-valued detection's answer
     * (`["jsx"]` for a React-island project). When the set does arrive it widens
     * the answer to the genuinely dual-island case, which single-valued
     * detection cannot express.
     */
    stampLanguages(ctx: HostContext, installed: ReadonlySet<string>): SourceLanguage[] {
      const languages: SourceLanguage[] = ["astro"]
      const add = (language: SourceLanguage): void => {
        if (!languages.includes(language)) languages.push(language)
      }
      for (const language of ctx.languages) {
        if (ASTRO_ISLAND_LANGUAGES.includes(language)) add(language)
      }
      // The renderer integrations are what actually decide which island
      // dialects a page can mount, which is why they outrank a framework guess
      // when they are known.
      if (installed.has("@astrojs/react") || installed.has("@astrojs/preact")) add("jsx")
      if (installed.has("@astrojs/vue")) add("vue-sfc")
      return languages
    },

    async probe(ctx: HostContext): Promise<ProbeResult> {
      const require = createRequire(join(ctx.prototypeRoot, "package.json"))
      const notices: string[] = []

      // 1. Installed, not merely declared. Detection read `package.json`; this
      //    reads `node_modules`.
      let entry: string
      try {
        entry = require.resolve("astro")
      } catch {
        return {
          ok: false,
          failure: {
            code: "host-package-missing",
            summary: "This project declares Astro but astro is not installed.",
            remediation: [
              "Run `npm install` (or your package manager's equivalent) so astro is present in node_modules.",
              "Or start the project's dev server yourself and re-run with --attach <url>.",
            ],
            attachCovers: true,
          },
        }
      }

      // 2. The seam itself, exercised rather than assumed. This IMPORTS Astro,
      //    which is the one expensive thing in this probe — but it is the only
      //    way to answer "is `dev` still a function", the import is cached for
      //    `boot`, and it is still side-effect-free: nothing is bound, spawned
      //    or written. Paying it here converts an experimental-API break from a
      //    half-booted server into a pre-boot refusal that names the seam.
      let astro: PrototypeAstro
      try {
        astro = (await import(pathToFileURL(entry).href)) as unknown as PrototypeAstro
      } catch (err) {
        return {
          ok: false,
          failure: {
            code: "seam-missing",
            summary: "Editor could not load your project's Astro installation.",
            seam: DEV_SEAM,
            cause: (err as Error).message,
            remediation: [
              "Reinstall dependencies (`rm -rf node_modules && npm install`) and try again.",
              "Or start the project's dev server yourself and re-run with --attach <url>.",
            ],
            attachCovers: true,
          },
        }
      }

      if (typeof astro.dev !== "function") {
        return {
          ok: false,
          failure: {
            code: "seam-shape-changed",
            summary:
              "Your Astro installation no longer exports a `dev` function, so Editor cannot boot it in-process.",
            seam: DEV_SEAM,
            cause: `typeof require("astro").dev === "${typeof astro.dev}"`,
            remediation: [
              "Start the project's dev server yourself and re-run with --attach <url>.",
              "Then report the Astro version. This seam is marked experimental by Astro and is expected to move eventually.",
            ],
            attachCovers: true,
          },
        }
      }

      const version = readInstalledVersion(require, "astro")
      if (version !== null && majorOf(version) !== "7") {
        const message =
          `This project has astro ${version}; Editor's in-process boot is measured against 7.x. ` +
          "The `dev()` entry point is marked experimental by Astro, so a major bump is exactly when it may change shape."
        if (ctx.strictVersions) {
          return {
            ok: false,
            failure: {
              code: "host-version-unsupported",
              summary: `astro ${version} is outside the measured range, and --strict-versions was passed.`,
              seam: DEV_SEAM,
              detected: { package: "astro", installed: version, tested: "^7.0.0" },
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

      // Said once, at boot, whatever the version — the customer is entitled to
      // know that the API under their session is one the vendor reserves the
      // right to change, and to know that the fallback needs none of it.
      notices.push(
        "Astro's programmatic dev() API is marked @experimental by Astro itself. Editor gates it " +
          "(this check) and falls back to attach mode if it ever changes shape, so a break is a " +
          "message with two commands rather than a broken session.",
      )

      return { ok: true, version: version ?? "unknown", notices }
    },

    async boot(
      ctx: HostContext,
      injection: Extract<StamperInjection, { channel: "vite-plugin" }>,
    ): Promise<HostBoot> {
      const require = createRequire(join(ctx.prototypeRoot, "package.json"))
      // Cached from `probe`, which already proved this resolves and exports
      // `dev`. Re-resolving rather than threading the module through keeps
      // `boot` independently callable (which is how it is unit-tested).
      const astro = (await import(
        pathToFileURL(require.resolve("astro")).href
      )) as unknown as PrototypeAstro

      // Never the literal 0 — `pickLoopbackPort` records the MEASURED Vite
      // 8.0.8 behaviour that reads `0` as UNSET and binds 5173, i.e. the front
      // door's own port. Astro takes its port through its own `server.port`
      // rather than Vite's, and was not re-measured for that specific
      // falsiness; asking for a concrete port makes the question moot.
      const port =
        ctx.internal.port === 0 ? await pickLoopbackPort(ctx.internal.host) : ctx.internal.port

      // Our OWN capture, separate from the pipeline's (which is already inside
      // `injection.plugins` and feeds `HostRun.vite`). The host needs a
      // `ViteDevServer` of its own for HMR invalidation and the module-graph
      // walk, and unlike React Router — whose boot call RETURNS the server —
      // Astro returns a `DevServer` that exposes a watcher and a handle but not
      // the Vite server. `configureServer` is the seam that does.
      const capture = createViteCapture()
      /** The live Vite server, re-read per call — see the auto-restart note below. */
      const currentVite = (): ViteDevServer | null =>
        capture.servers[capture.servers.length - 1] ?? null

      let overridden: string[] = []
      const server = await astro.dev({
        root: ctx.prototypeRoot,
        logLevel: "warn",
        server: { host: ctx.internal.host, port },
        vite: {
          plugins: [
            ...injection.plugins,
            capture.plugin(),
            // LAST in the array and `enforce: 'post'` internally, so it is last
            // in the post bucket by both orderings. MEASURED over HTTP on this
            // host, which is the only assertion that means anything (§ 4, S3):
            // `Host: evil.test` → 403 while the correct Host → 200; `/.env` and
            // `/.desde/chat-sessions/s1.json` → 403 through BOTH the plain
            // path and `/@fs<abs>`; no `access-control-allow-origin` for
            // `Origin: http://evil.test`. Resolved `fs.deny` carried
            // `.desde` and `**/.desde/**`, `fs.strict` true,
            // `allowedHosts` `[]`.
            hardenPlugin({
              reportOverrides: true,
              onReport: (report) => {
                overridden = report.overridden
              },
            }),
          ],
          server: {
            // Editor's own bookkeeping under `.desde/` must not trigger
            // HMR — or, on this host, an Astro container restart. MEASURED: the
            // resolved config carried exactly this ignore list, so Astro
            // forwards `vite.server.watch` rather than replacing it. (Watcher
            // only; refusing to SERVE those paths is `fs.deny`'s job above, and
            // the two are unrelated mechanisms.)
            watch: { ignored: ["**/.desde/**"] },
          },
        },
      })

      if (overridden.length > 0) {
        console.warn(
          `[host:astro] Narrowed ${overridden.join(", ")} from this repo's Vite config. ` +
            "Editor pins these so the dev server can't be turned into cross-origin read access to " +
            "your filesystem. To widen filesystem reach legitimately, add to server.fs.allow instead.",
        )
      }

      // The shape check an EXPERIMENTAL seam earns: everything below reads
      // `address.port` and `stop`, so if a future Astro returns something else,
      // the honest outcome is one sentence naming the seam rather than a
      // TypeError from three frames deeper — and the listener we just created
      // has to come down with it, or a failed boot leaves a dev server bound to
      // a port nothing is pointing at.
      const address = server.address as { port?: unknown } | null | undefined
      if (address == null || typeof address.port !== "number" || typeof server.stop !== "function") {
        await Promise.resolve(server.stop?.()).catch(() => undefined)
        throw new Error(
          "Astro's dev() returned a server without a bound TCP address and a stop() function " +
            `(got address=${JSON.stringify(server.address)}, typeof stop=${typeof server.stop}). ` +
            "This is the experimental JS API changing shape; re-run with --attach <url>, which does not use it.",
        )
      }

      // Read BACK, never assumed, and here that is load-bearing rather than
      // ceremonial. MEASURED: with a squatter holding the requested port, Astro
      // does NOT fail — it binds the next one (asked 45520, bound 45521) and
      // reports the real port on `DevServer.address`. So the proxy points at
      // what was actually bound, and there is no `strictPort` to fight Astro's
      // own port logic with.
      const origin = listenOriginFor(ctx.internal.host, address.port)

      // MEASURED: exactly ONE, on every boot of every Astro fixture. This is the
      // React Router shape, not the Nuxt one (where `configureServer` fires
      // TWICE with a client and an SSR lane, and emitting into one leaves the
      // other serving stale HTML). Asserted rather than assumed because the
      // failure it guards is silent: a second lane we never invalidate looks
      // exactly like an edit that did not take.
      if (capture.servers.length !== 1) {
        console.warn(
          `[host:astro] Expected exactly one Vite server at boot and captured ${capture.servers.length}. ` +
            "HMR invalidation targets the most recently captured one; if edits stop refreshing, this is why.",
        )
      }

      return {
        transport: { kind: "http-upstream", origin },

        // The FRONT DOOR's base, which for every fronted host is `/` — the proxy
        // mirrors upstream's path space one-to-one. Reporting an inner Vite
        // `base` here is the mistake that breaks the shell's served-stylesheet →
        // source-file mapping.
        base: "/",

        bridgeTags: BRIDGE_TAGS,

        hmr: {
          lanes: ["client"],
          invalidate: (absFiles) => {
            // Re-read rather than closed over, because Astro RESTARTS its whole
            // container when the user edits `astro.config.*`. MEASURED: after a
            // config edit the capture list grows to 2 with distinct server
            // objects, the injected plugins are re-applied (stamps survive), and
            // the port is unchanged. Holding `servers[0]` would silently stop
            // invalidating at the moment the user touched their config.
            const vite = currentVite()
            if (vite === null) return
            invalidateViteModules(vite, ctx.repoRoot, absFiles)
          },
          // MEASURED on ONE Astro server, by reading the HMR websocket frames
          // rather than watching a browser: editing `src/components/Counter.tsx`
          // produced `{"type":"update","updates":[{"type":"js-update",…}]}`,
          // and editing `src/pages/index.astro` produced
          // `{"type":"full-reload"}`. **This is the one place the Editor's
          // "client state survives an edit" assumption breaks** — anything the
          // shell holds in browser memory across a `.astro` edit (bridge
          // connection, selection overlay, inspector state, scroll, open dialog)
          // dies and must re-establish from `BRIDGE_READY`.
          //
          // `.vue` is deliberately ABSENT: no Vue-island Astro project was
          // measured, and `HmrProfile.hot` means "MEASURED to hot-update", not
          // "probably works". Astro full-reloads `.astro` regardless of which
          // island renderer is installed, so `fullReload` is complete.
          reload: { hot: [".tsx", ".jsx"], fullReload: [".astro"] },
        },

        security: {
          narrowedServerConfig: true,
          overridden,
          // Empty as a CLAIM, not an omission: every pin was verified over HTTP
          // on this host (see the `hardenPlugin` comment above), and it sits
          // behind the proxy as well, so `.desde/**` is refused twice over.
          // The one thing this host cannot close is Astro's own listener, which
          // is not a missing protection but a disclosed second door — see
          // `sideDoorOrigins`.
          gaps: [],
        },

        // PARTIAL, and hardcoded rather than read from config — unlike React
        // Router's `ssr` flag, this is not a per-project setting. Astro
        // server-renders its document, so on the face of it zero stamps would be
        // conclusive; it is not, because the half of an Astro page that has no
        // stamper is exactly the half that is always present. MEASURED on a
        // no-island fixture: a valid, fully-working Astro page serves ZERO
        // stamps. `partial` is what makes that a warning naming the gap instead
        // of a teardown (§ 6's conjunction requires `required-in-html`, so this
        // value can never reach `unstamped`).
        stampExpectation: "partial",

        // Astro binds its own listener and offers no way not to. The proxy
        // fronts it; this origin stays reachable, on loopback, serving
        // UN-INJECTED HTML. Disclosed rather than pretended away.
        sideDoorOrigins: [origin],

        // No host can enumerate its own routes cheaply today (§ 8, open
        // question 12).
        probeRoutes: [],

        // Points at the INNER origin: the walk fetches `/` to discover entry
        // modules, and the inner server is where the module graph lives.
        // MEASURED true on the island fixture — `/src/components/Counter.tsx`
        // was in the graph with `data-desde-src` in its compiled output — which is
        // what promotes a zero-stamp `.astro`-only document to `stamped` when an
        // island exists anywhere.
        moduleGraphEvidence: async () => {
          const vite = currentVite()
          if (vite === null) return false
          return anyStampedModuleHasDataPtSrc(vite, origin)
        },

        // MEASURED: `stop()` settles and releases the port; the fixture is
        // byte-identical afterwards.
        close: () => server.stop(),
      }
    },
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

function majorOf(version: string): string {
  return version.split(".")[0] ?? version
}
