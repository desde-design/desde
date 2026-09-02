import { createRequire } from "node:module"
import { join } from "node:path"
import { bootSupervisor } from "../../supervisor/vite-supervisor.js"
import { invalidateViteModules } from "../vite-invalidate.js"
import { anyStampedModuleHasDataPtSrc } from "./module-graph-evidence.js"
import type {
  BridgeTagStrategy,
  DevServerHost,
  HostBoot,
  HostContext,
  ProbeResult,
  SourceLanguage,
  StamperInjection,
} from "../types.js"

/**
 * The plain-Vite host — the boot path Editor has shipped since D-0, wrapped in
 * the `DevServerHost` seam.
 *
 * **It wraps `bootSupervisor`; it does not reimplement it.** The merge order
 * (`loadConfigFromFile` → `mergeConfig` → `hardenServerConfig` →
 * `createServer({ configFile: false })` → `listen()`) is load-bearing security
 * behaviour with its own test suite, and `tasks/dev-server-hosts.md` § 3 pins
 * this host's behaviour as "bit-for-bit what ships today". Everything below
 * either forwards a value or reports a fact about the server that came back.
 *
 * It is also the ONLY unfronted host, and that asymmetry is disclosed rather
 * than left as an accident of topology — see `security.gaps` in `boot()` (§ 4,
 * S7).
 */

/** Languages a Vite plugin can stamp today. `.astro` markup has no stamper. */
const VITE_STAMPABLE: readonly SourceLanguage[] = ["vue-sfc", "jsx"]

/**
 * MEASURED to fire on plain Vite ONLY — which is exactly this host, and is why
 * it is the one host that gets the composed `bridgePlugin`. Declared once and
 * referenced by both `DevServerHost.bridgeTags` and `HostBoot.bridgeTags` so
 * the pre-boot promise and the post-boot report cannot drift.
 */
const BRIDGE_TAGS: BridgeTagStrategy = "vite-transform-index-html"

export function createViteHost(): DevServerHost<"vite-plugin"> {
  return {
    id: "vite",
    displayName: "Vite",

    seams: [
      {
        id: "vite/createServer",
        stability: "public",
        expression: 'createServer(merged) from "vite"',
        buys: "the plugin pipeline the source stamper and the bridge tag are injected into",
      },
      {
        id: "vite/loadConfigFromFile",
        stability: "public",
        expression: 'loadConfigFromFile({ command: "serve" }, <vite.config.*>)',
        buys: "running the repo's own config in its own scope before we merge onto it",
      },
    ],

    // No `stamperSeam`, for both available reasons at once: this host reports
    // `module-graph`, so `injection-not-observed` is unreachable for it, and the
    // stamper is a plugin in an array passed straight to a `createServer` we
    // call ourselves — there is no forwarding step for either seam above to drop
    // it in.

    // Informational only, and deliberately so: `bootSupervisor` creates the
    // server with EDITOR-CLI's own Vite, so the version installed in the
    // prototype does not decide whether this host works. Whether it should
    // resolve the project's Vite instead (as `react-router` must) is
    // `tasks/dev-server-hosts.md` § 8 open question 4 — unresolved, and a
    // notice here is the honest interim.
    versionGate: { packageName: "vite", tested: "^8.0.0" },

    accepts: "vite-plugin",
    devCommand: "npx vite",
    bridgeTags: BRIDGE_TAGS,

    // Deliberately EMPTY, where `.nuxt` / `.astro` / `.next` will not be.
    // `denyDirs` exists to stop stamps landing in a directory the dev server
    // itself regenerates and serves from; plain Vite's `dist/` is build output
    // its dev server never transforms, so denying it buys no protection while
    // silently unstamping any repo that legitimately keeps source under that
    // name. A behaviour change with no measured benefit is not one to make on
    // the shipped path.
    buildDirs: [],

    stampLanguages(ctx: HostContext): SourceLanguage[] {
      return ctx.languages.filter((language) => VITE_STAMPABLE.includes(language))
    },

    /**
     * **Never fails, on purpose.** Both seams are public Vite APIs imported
     * statically by `vite-supervisor.ts`, so if they were missing this module
     * would not have loaded. More importantly, a prototype with no `vite`
     * dependency of its own still boots today — editor-cli supplies the Vite —
     * and `--force` (`skipFrameworkDetection`) exists precisely to drive such a
     * repo. A probe that demanded the prototype's own install would refuse a
     * session that works.
     */
    async probe(ctx: HostContext): Promise<ProbeResult> {
      const notices: string[] = []
      const ours = readViteVersion(createRequire(import.meta.url))
      const theirs = readViteVersion(createRequire(join(ctx.prototypeRoot, "package.json")))

      // Only a MAJOR difference is worth a line. Vite's plugin container is
      // stable within a major, and the config we merge onto came out of the
      // prototype's own config file either way — so a patch- or minor-level
      // difference is noise, and noise at boot is how a real notice gets
      // ignored.
      if (ours && theirs && majorOf(ours) !== majorOf(theirs)) {
        notices.push(
          `This project has vite ${theirs} installed, but Editor boots it with its own vite ${ours}. ` +
            "If a plugin in your vite.config misbehaves, that version skew is the first thing to suspect.",
        )
      }

      return { ok: true, version: ours ?? "unknown", notices }
    },

    async boot(
      ctx: HostContext,
      injection: Extract<StamperInjection, { channel: "vite-plugin" }>,
    ): Promise<HostBoot> {
      const handle = await bootSupervisor({
        repoRoot: ctx.repoRoot,
        prototypeRoot: ctx.prototypeRoot,
        // `direct`: the framework's own listener IS the front door, so it binds
        // the port the user asked for and bookmarks survive.
        host: ctx.frontDoor.host,
        port: ctx.frontDoor.port,
        plugins: injection.plugins,
      })
      const server = handle.vite.server

      return {
        transport: { kind: "direct", origin: handle.url },

        // The ONLY host that reports its inner Vite `base`, because here the
        // inner Vite IS the front door. Every fronted host reports "/" (§ 1,
        // `HostBoot.base`).
        base: handle.base,

        bridgeTags: BRIDGE_TAGS,

        hmr: {
          lanes: ["client"],
          invalidate: (absFiles) => {
            // `invalidateViteModules` resolves against the EDIT root, not
            // `server.config.root` (a repo may set `root: 'app'`), and it is
            // best-effort by contract — it must never throw into an edit
            // response.
            invalidateViteModules(server, ctx.repoRoot, absFiles)
          },
          // UNMEASURED for this host, and left empty rather than guessed. The
          // contract on `HmrProfile` is "extensions MEASURED to hot-update";
          // the only consumer is the shell's re-handshake decision, which does
          // not exist yet. A plausible-looking guess here would be the exact
          // silent-wrong this design is built to avoid.
          reload: { hot: [], fullReload: [] },
        },

        security: {
          narrowedServerConfig: true,
          overridden: handle.hardening.overridden,
          gaps: [
            // § 4, S7. Stated because the reader's mental model after the other
            // hosts land will be "the proxy refuses /.desde", and here it
            // does not exist to do so. Vite's own `fs.deny` covers that path
            // (`hardenServerConfig`), which is why this is a topology note and
            // not an open hole.
            "Not fronted by the Editor proxy: this dev server is reachable directly, so its own " +
              "server.fs.deny + allowedHosts pins are the whole floor.",
          ],
        },

        // The module graph is authoritative here; the served HTML of a
        // client-rendered app is noise.
        stampExpectation: "module-graph",

        // Nothing bound but the front door.
        sideDoorOrigins: [],

        // No host can enumerate its own routes cheaply today (§ 8, open
        // question 12).
        probeRoutes: [],

        moduleGraphEvidence: () => anyStampedModuleHasDataPtSrc(server, handle.url),

        close: () => handle.close(),
      }
    },
  }
}

/** Installed `vite` version as seen from `require`, or null if unresolvable. */
function readViteVersion(require: NodeJS.Require): string | null {
  try {
    const pkg = require("vite/package.json") as { version?: unknown }
    return typeof pkg.version === "string" ? pkg.version : null
  } catch {
    // No vite installed there, or its package.json is not an export. Both are
    // ordinary states — this is a diagnostic, not a gate.
    return null
  }
}

function majorOf(version: string): string {
  return version.split(".")[0] ?? version
}
