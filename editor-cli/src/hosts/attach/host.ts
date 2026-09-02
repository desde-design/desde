import type {
  BridgeTagStrategy,
  DevServerHost,
  HostBoot,
  HostContext,
  HostSeam,
  ProbeResult,
  SourceLanguage,
} from "../types.js"

/**
 * The dev server Editor did NOT start.
 *
 * `attach` is a first-class host, not a mode. Modelling it as a peer of the five
 * in-process hosts is what keeps the escape hatch exercised instead of rotting
 * as a branch in `core.ts`: it declares the same facts every other host declares
 * — what it can stamp, what security it cannot provide, what its bridge tags
 * ride on, what zero stamps in the HTML mean — so `--doctor` can describe it and
 * so those facts live next to the hosts they are compared against.
 *
 * **Its defining property is the empty {@link seams} array.** Every other host's
 * failure message ends with "attach mode does not use this seam and covers your
 * framework fully". That sentence is only true because there is nothing here to
 * break: no private import, no experimental API, no memoised config object. It
 * is the floor under every rung of the ladder, and an empty seam table is the
 * declaration of that.
 *
 * ## What this object is wired into today, and what it is not
 *
 * WIRED: the registry (so `resolveHost` can return `attach` when `--attach` is
 * passed, and `--doctor` can print it), the boot-time disclosure of the security
 * gaps and side-door origin below, and `stampVerifyFor`'s attach branch, which
 * reads {@link STAMP_EXPECTATION} and {@link DISPLAY_NAME} from here rather than
 * hardcoding them a second time.
 *
 * NOT WIRED: `core.ts` still calls `startAttachProxy` directly rather than
 * dispatching the attach lane through `runHost`. Three consumers downstream read
 * `hostRun === null` as "this session is attached" — `stampVerifyFor`,
 * `runSmokeCheck`, and `invalidateFiles` — and the third is the one milestone 11
 * deliberately left UNDEFINED rather than stub, because the honest attach answer
 * to "replay this write into your watcher" is "we do not own your watcher, and
 * it is already watching". Routing the lane through `runHost` gives it a
 * `HostHmr` with a no-op `invalidate()`, which is a stub on the exact path whose
 * design note says "not a stub". Folding the lane is a separate change whose
 * whole risk sits in those three call sites; see `tasks/dev-server-hosts.md`
 * § 5, milestone 12.
 *
 * `boot()` below is therefore real and thin — it declares the upstream as the
 * transport and owns nothing else — and `attach-host.test.ts` asserts what it
 * declares matches what `core.ts`'s attach branch actually does, so the two
 * cannot drift while they are separate.
 */

/** Read by `core.ts`'s `stampVerifyFor`, so the string lives in one place. */
export const DISPLAY_NAME = "attached"

/**
 * What zero `data-desde-src` attributes in the served HTML MEAN for an attached
 * server: nothing conclusive.
 *
 * Every in-process host computes this from its own RESOLVED config. Attach
 * cannot — we never loaded the user's config and have no idea whether their app
 * server-renders. `post-hydration` is the value that makes zero stamps
 * `indeterminate` rather than `unstamped`, which is the only safe answer here:
 * the `unstamped` verdict tears the server down and tells the user to switch to
 * attach mode, and they are already in it.
 *
 * The real gate for this lane is `runAttachStampingGate`, which proves the
 * user's own config references our stamper BEFORE the proxy starts (exit 5, with
 * the exact block to paste). A post-boot HTML probe is a second, weaker check on
 * a question already answered.
 */
export const STAMP_EXPECTATION = "post-hydration" as const

/**
 * The bridge reaches an attached app through the proxy's streaming injector.
 * `transformIndexHtml` is not available: we never load the user's Vite config,
 * and on the fronted in-process hosts that hook was MEASURED to fire zero times
 * anyway.
 */
const BRIDGE_TAGS: BridgeTagStrategy = "proxy-response-injection"

/**
 * S11 (`tasks/dev-server-hosts.md` § 4): a host that cannot narrow the dev
 * server's own config must say so at boot.
 *
 * Attach narrows nothing — the server is the user's, started by their own
 * command, configured by their own file. Every protection the Vite-family hosts
 * get by pinning `server.fs.deny` / `server.fs.strict` / `server.allowedHosts` is
 * simply absent, and the proxy's own floor (`Host` guard, `.desde` refusal)
 * is what remains. Silence here would be a lie.
 */
export const ATTACH_SECURITY_GAPS: readonly string[] = [
  "Editor did not start or configure this dev server, so it could not pin server.fs.deny, server.fs.strict or server.allowedHosts. Whatever your own config allows, it still allows.",
  // The upstream being reachable un-injected is NOT listed here, deliberately.
  // It is a `sideDoorOrigins` fact, and that channel names the actual origin
  // while this one cannot. Live boot log before this comment existed: the two
  // lines printed back to back, one of them with a URL and one without, saying
  // the same thing — and a disclosure a reader skims is worth less than one
  // fewer disclosure they read.
]

/** No stamper of ours runs in this process; the user's config registers theirs. */
const ATTACH_LANGUAGES: readonly SourceLanguage[] = ["vue-sfc", "jsx"]

export function createAttachHost(): DevServerHost<"vite-plugin"> {
  return {
    id: "attach",
    displayName: DISPLAY_NAME,

    // EMPTY, and that is the whole point — see the file header.
    seams: [] as readonly HostSeam[],

    // No `versionGate`: there is no package of ours to resolve from the
    // prototype, so there is no installed version to read or range to gate on.

    /**
     * A shape only, never consumed. Attach receives no injection at all: the
     * stamper is registered from the user's own config by `runAttachStampingGate`,
     * which writes the files that config imports. `vite-plugin` is the shape
     * `boot` declares it will ignore, stated rather than left to a cast.
     */
    accepts: "vite-plugin",

    devCommand: "<your project's own dev command>",

    /** We build nothing, so there is no output directory of ours to deny. */
    buildDirs: [],

    bridgeTags: BRIDGE_TAGS,

    /**
     * Both stampable dialects, unconditionally.
     *
     * NOT filtered by `ctx.languages`, unlike the Vite-family hosts. Those know
     * exactly which stampers they injected; attach injected none, and what the
     * user's own config wires is theirs to decide — a Vue app whose config
     * registers the JSX stamper for a few `.tsx` files is legitimate and we
     * cannot see it from here. Claiming both is the honest ceiling, and the gate
     * that actually establishes coverage is the stamping preflight, which reads
     * the config rather than guessing at it.
     */
    stampLanguages(): SourceLanguage[] {
      return [...ATTACH_LANGUAGES]
    },

    /**
     * Nothing to probe.
     *
     * Deliberately NOT the stamping preflight, even though this is where the
     * design sketch put it. That preflight's refusal is a RENDERED artifact — the
     * exact block to paste and the file to paste it into — carried by
     * `StampingRequiredError` with its own exit code (5), and it has to run
     * before `core.ts` chdirs into the prototype. Squeezing it into a
     * `ProbeResult` would turn it into a `HostFailure` on the ladder, i.e. exit
     * 4 with "start your dev server" advice for a user whose dev server is
     * already running.
     */
    async probe(): Promise<ProbeResult> {
      return {
        ok: true,
        version: "n/a",
        notices: [],
      }
    },

    /**
     * "The server already exists, at this URL."
     *
     * The only fact `boot` contributes is the transport, and it comes from
     * `ctx.attachUrl`. `close()` is a genuine no-op: we did not start this
     * server and must not stop it. The front door is the proxy, which the
     * pipeline (or, today, `core.ts`) puts in front of the transport origin.
     */
    async boot(ctx: HostContext): Promise<HostBoot> {
      const origin = ctx.attachUrl
      if (!origin) {
        // Unreachable through `resolveHost`, which refuses `--host attach`
        // without a URL. Kept as a loud failure rather than a cast: an attach
        // boot with no upstream would front an origin of `undefined`.
        throw new Error("The attach host was booted with no --attach URL.")
      }
      return {
        transport: { kind: "http-upstream", origin },
        // The proxy serves at the root; the upstream's own base, whatever it is,
        // is invisible from out here and the shell maps hrefs against ours.
        base: "/",
        bridgeTags: BRIDGE_TAGS,
        hmr: {
          // EMPTY, meaning "the host owns its watcher". MEASURED end to end on
          // Next (`tasks/next-attach-mode-spike.md` § "HMR works"): an edit
          // Editor wrote hot-updated the running page with the `data-desde-src`
          // stamp intact, because the user's own dev server was already
          // watching the file. There is no event of ours to replay.
          lanes: [],
          invalidate: () => {},
          reload: { hot: [], fullReload: [] },
        },
        security: {
          narrowedServerConfig: false,
          overridden: [],
          // ONE constant, read twice: here and by `core.ts`'s attach branch,
          // which prints these at boot. A second literal there could disagree
          // with what `--doctor` shows for the same session.
          gaps: [...ATTACH_SECURITY_GAPS],
        },
        stampExpectation: STAMP_EXPECTATION,
        // The upstream is reachable un-injected by definition — the user started
        // it and knows its URL. Disclosed rather than pretended away.
        sideDoorOrigins: [origin],
        probeRoutes: [],
        close: async () => {},
      }
    },
  }
}
