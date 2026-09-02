import { tmpdir } from "node:os"
import { join } from "node:path"
import { startAttachProxy } from "../attach/proxy.js"
import { stampingCoverage } from "./coverage.js"
import { buildStampPolicy } from "./stamp-policy.js"
import { getHostFactory, type AnyDevServerHost } from "./registry.js"
import { turbopackInjection } from "./stampers.js"
import { createViteCapture } from "./vite-capture.js"
import type { HostDescriptor } from "./ladder.js"
import type {
  BridgeTagStrategy,
  Framework,
  HostBoot,
  HostContext,
  HostFailure,
  HostId,
  HostSeam,
  MaterializedAssets,
  SourceLanguage,
  StamperInjection,
  StampingCoverage,
  StampPolicy,
} from "./types.js"
import type { PrototypeServerHandle } from "./handle.js"

/**
 * The boot pipeline `core.ts` dispatches through: resolve the host → probe →
 * materialize → build the stamper injection → boot → front door.
 *
 * `verify` and the failure `ladder` run one level up, in `core.ts`, because the
 * stamp gate needs the HTTP server to already be listening before it decides
 * whether to tear everything down.
 *
 * **Two front doors, decided by the host's transport.** A `direct` host (plain
 * Vite) binds the user-facing port itself and is handed straight back. Every
 * other transport is fronted by the SHIPPED attach proxy — the same file, the
 * same streaming injector, the same `.desde` refusal and `Host` guard that
 * attach mode has been using. That reuse is the point: a fronted in-process
 * host and an attached foreign server are the same topology, and giving them
 * two implementations is how their security floors would drift apart.
 *
 * **No Vite import.** The pipeline never names a Vite type (§ 4, S12): the
 * plugin list reaches it through {@link StamperInjection}, and the live server
 * reaches it through `vite-capture.ts`, which is one of the files allowed to
 * know what a `ViteDevServer` is.
 */

/** The Vite half of {@link StamperInjection}, named so `run.ts` needs no `vite` import. */
type VitePluginList = Extract<StamperInjection, { channel: "vite-plugin" }>["plugins"]

/**
 * What the plugin-assembly callback is allowed to branch on.
 *
 * Deliberately two fields and not the host object: the caller builds a plugin
 * array, and the only host facts a plugin array can legitimately depend on are
 * which framework it is stamping for and how its bridge tags will be delivered.
 * Handing over the whole `DevServerHost` would put `boot` and `probe` in reach
 * of a callback that runs mid-pipeline.
 */
export interface HostPluginFacts {
  id: HostId
  /** `vite-transform-index-html` → the composed `bridgePlugin`; anything else → assets only. */
  bridgeTags: BridgeTagStrategy
}

export interface HostRunOptions {
  hostId: HostId
  /** Git root — what stamps are relative to and where `.desde/` lives. */
  repoRoot: string
  /** The same root with symlinks resolved, when it differs. */
  repoRootReal?: string | undefined
  /** Where the framework roots and finds its config: `repoRoot` or a subdir. */
  prototypeRoot: string
  framework: Framework
  /**
   * Source dialects present in the repo. Defaults from {@link framework},
   * which is all today's single-valued detection can say; the detection
   * rewrite supplies the real multi-valued answer (an Astro repo with React
   * islands is `["astro", "jsx"]`).
   */
  languages?: readonly SourceLanguage[]
  /** The address the BROWSER uses. A `direct` host binds this itself. */
  frontDoor: { host: string; port: number }
  /**
   * What the proxy front door serves of its own, for a host that turns out to
   * be fronted.
   *
   * REQUIRED rather than optional, deliberately. Whether a host is fronted is
   * only known AFTER `boot()` returns its transport — so an optional field
   * would put "we booted a dev server and then discovered we cannot front it"
   * on the reachable path, which is a teardown and a refusal for a fact the
   * caller already had. `core.ts` has all three values before it calls in.
   */
  bridge: {
    /** Absolute path to the built bridge bundle (`dist/bridge-bundle.js`). */
    bundlePath: string
    /** Absolute path to `html2canvas.min.js`. */
    html2canvasPath: string
    /** Origin the shell posts from. Rides on `data-shell-origin`. */
    shellOrigin: string
  }
  /**
   * The plugins to inject, given the policy this pipeline built.
   *
   * A CALLBACK because of an ordering fact: the stamp policy's build-directory
   * denials come from the host (`DevServerHost.buildDirs`), so the policy
   * cannot exist until the host is resolved — and the stamper plugins cannot be
   * constructed until the policy exists. Passing plugins in directly would force
   * the caller to build a policy the pipeline then has to second-guess, which is
   * how the two guards drifted apart in the first place.
   *
   * `hosts/stampers.ts` replaces this callback with a (language × channel)
   * provider registry once a host needs the Turbopack lane. Until then the
   * caller keeps ownership of what it injects — including the framework gates
   * that decide which of them are Vue-only.
   */
  plugins: (policy: StampPolicy, host: HostPluginFacts) => VitePluginList
  /**
   * Where a host may write generated assets. NEVER inside the user's repo.
   * Defaults to a temp directory and is not created here: no host materializes
   * anything yet, and the one that will (Next's Turbopack loader) owns a
   * version-keyed cache location of its own.
   */
  artifactDir?: string
  /** Escalate an out-of-range version from a notice to a refusal. */
  strictVersions?: boolean
  /** Cancels the boot. Forwarded to {@link HostContext.signal}. */
  signal?: AbortSignal
}

/**
 * What a booted host hands back: the framework-neutral
 * {@link PrototypeServerHandle} every consumer downstream of `core.ts` holds,
 * plus everything only a host can say about itself.
 *
 * The extension is one-directional on purpose. A consumer that needs the URL,
 * the base or the teardown takes the handle and cannot reach a dev server
 * through it; a consumer that needs a host fact (the HMR lanes, the stamp
 * expectation, the seam a failure should name) takes `HostRun` and gets it from
 * the host that produced it, not from a Vite object that only four of the six
 * hosts have.
 */
export interface HostRun extends PrototypeServerHandle {
  readonly hostId: HostId
  /** Everything the verify step and the boot-log security line will consume. */
  readonly boot: HostBoot
  /**
   * Which source dialects this session can stamp, and which it cannot.
   *
   * Carried on the run rather than logged and forgotten because it is a fact
   * about the SESSION, not about the boot: "this project's `.astro` pages are
   * inspect-only" stays true for as long as the server is up, and the
   * framework-neutral handle in `hosts/handle.ts` already declares it as a
   * member for the milestone where the two handles converge.
   */
  readonly coverage: StampingCoverage
  /**
   * The booted host's {@link DevServerHost.stamperSeam}, carried through so
   * `core.ts` can hand it to `verifyStamping` — the caller holds a
   * {@link HostDescriptor}, deliberately, and a descriptor cannot answer this.
   *
   * Copied rather than folded into {@link HostBoot} so the designation stays
   * readable WITHOUT booting: the invariant that binds it to the seam table
   * (`stamperSeam` must be one of `seams`) is then assertable over the whole
   * registry in a unit test, instead of only on whichever hosts a test is
   * willing to start a dev server for.
   *
   * `undefined` for a host that designates none, which is most of them — see
   * {@link DevServerHost.stamperSeam} for why that is the honest default.
   */
  readonly stamperSeam?: HostSeam
  /**
   * Who booted, in the three fields a failure message needs.
   *
   * A DESCRIPTOR, not the host object: the failure paths downstream (the stamp
   * gate, the ladder) must be able to name the host and print its dev command
   * without holding something they could boot a second time.
   */
  readonly host: HostDescriptor
}

/**
 * A typed host failure, carried so a caller can render it rather than re-parse a
 * string.
 *
 * It carries the {@link HostDescriptor} too, because the useful thing to do with
 * one of these is run it through the ladder — and the ladder's message is
 * "here is the dev command for YOUR framework, then pass --attach". Without the
 * descriptor a probe refusal degrades to a generic boot error, which is the one
 * outcome the whole failure design exists to avoid.
 */
export class HostBootError extends Error {
  constructor(
    readonly failure: HostFailure,
    readonly host: HostDescriptor,
  ) {
    super(formatHostFailure(failure))
    this.name = "HostBootError"
  }
}

/**
 * Provisional rendering — the `ladder` owns the real message (the one that
 * names the seam, quotes the expression, and prints the two attach commands).
 * This keeps the same facts in the same order so the upgrade is a swap.
 *
 * Not exported: the failure travels as data on {@link HostBootError.failure},
 * and a second renderer reachable from elsewhere is how two differently-worded
 * versions of the same failure end up in front of users.
 */
function formatHostFailure(failure: HostFailure): string {
  const lines = [failure.summary]
  if (failure.seam) {
    lines.push(`  Seam:       ${failure.seam.id}  (${failure.seam.stability})`)
    lines.push(`  Expression: ${failure.seam.expression}`)
    lines.push(`  Buys:       ${failure.seam.buys}`)
  }
  if (failure.detected) {
    lines.push(
      `  Detected:   ${failure.detected.package} ${failure.detected.installed}   (measured working: ${failure.detected.tested})`,
    )
  }
  if (failure.cause) lines.push(`  Cause:      ${failure.cause}`)
  for (const [i, step] of failure.remediation.entries()) lines.push(`  ${i + 1}. ${step}`)
  return lines.join("\n")
}

export async function runHost(opts: HostRunOptions): Promise<HostRun> {
  const factory = getHostFactory(opts.hostId)
  if (factory === null) {
    // Defensive: `resolveHost` refuses an unbuilt id before anything calls in
    // here, so there is no host object to describe. The id is the only honest
    // display name, and naming a dev command we do not know would be a guess in
    // a message whose whole value is being copy-pastable.
    throw new HostBootError(
      {
        code: "no-in-process-host",
        summary: `No in-process host implementation for "${opts.hostId}".`,
        remediation: ["Start the project's dev server yourself and re-run with --attach <url>."],
        attachCovers: true,
      },
      { id: opts.hostId, displayName: opts.hostId, devCommand: "<your project's dev command>" },
    )
  }
  return runResolvedHost(factory(), opts)
}

/**
 * The pipeline itself, with the host already chosen.
 *
 * Separate from {@link runHost} so it can be driven with a host that is not in
 * the registry — which is how the pipeline's own behaviour (policy
 * construction, probe refusal, transport handling) is tested without booting a
 * real dev server.
 */
export async function runResolvedHost(
  host: AnyDevServerHost,
  opts: HostRunOptions,
): Promise<HostRun> {
  const controller = new AbortController()
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort()
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true })
  }

  // ONE stamping policy for this boot, and the host is what completes it: the
  // roots come from the checkout (including `repoRootReal`, without which every
  // stamp on a symlinked checkout escapes with `../`), the build-directory
  // denials come from the framework.
  const policy = buildStampPolicy({
    repoRoot: opts.repoRoot,
    repoRootReal: opts.repoRootReal,
    prototypeRoot: opts.prototypeRoot,
    buildDirs: host.buildDirs,
  })

  const ctx: HostContext = {
    repoRoot: opts.repoRoot,
    repoRootReal: opts.repoRootReal,
    prototypeRoot: opts.prototypeRoot,
    framework: opts.framework,
    languages: opts.languages ?? defaultLanguages(opts.framework),
    policy,
    frontDoor: opts.frontDoor,
    // Read back from `server.address()` by every host that uses it; `0` here is
    // "OS-picked", never an assumption about what got bound.
    internal: { host: "127.0.0.1", port: 0 },
    artifactDir: opts.artifactDir ?? join(tmpdir(), "desde-artifacts"),
    strictVersions: opts.strictVersions ?? false,
    signal: controller.signal,
  }

  // Cheap and side-effect-free, and it runs BEFORE any boot work so a broken
  // seam costs a second rather than a half-booted server.
  const probe = await host.probe(ctx)
  if (!probe.ok) throw new HostBootError(probe.failure, descriptorOf(host))
  for (const notice of probe.notices) {
    console.warn(`[host:${host.id}] ${notice}`)
  }

  // What this host can and cannot stamp, decided BEFORE boot because it is a
  // property of (host × languages × channel) and not of the running server.
  //
  // The empty `installed` set is not a placeholder to be filled in later by
  // accident: `HostDetection.installed` arrives with the detection rewrite
  // (§ 1, `resolve.ts`), and until it does, every host's `stampLanguages` has to
  // be correct without it — which is why the astro host derives its island
  // dialects from `ctx.languages` and treats `installed` as a widening source
  // rather than the source.
  const coverage = stampingCoverage(host.stampLanguages(ctx, NO_INSTALLED_PACKAGES), host.accepts)

  let assets: MaterializedAssets | null
  try {
    assets = host.materialize ? await host.materialize(ctx) : null
  } catch (err) {
    // MEASURED, and available today with no framework change: an unwritable
    // cache home (`XDG_CACHE_HOME` on a read-only mount, a locked-down
    // container) makes `materializeNextLoader` throw EACCES here. Unwrapped it
    // reached `core.ts` as a plain `Error`, so the `instanceof HostBootError`
    // gate there was false and the ladder never ran — a bare "Failed to start
    // editor" on exit 1, with no dev command and no `--attach` fallback, for a
    // condition attach mode covers completely.
    throw bootStepFailure(
      host,
      `${host.displayName} could not prepare the stamper Editor needs, so in-process boot was ` +
        "abandoned before any server was started.",
      err,
    )
  }

  // The capture plugin is how the pipeline reaches the live server(s) without
  // naming a Vite type. It goes LAST so a repo plugin cannot pre-empt it; the
  // hook it uses (`configureServer`) has no ordering interaction with anything
  // the caller injected.
  //
  // Constructed unconditionally, consumed only on the Vite lane: a
  // `turbopack-loader` host has no Vite server to capture, and `capture.servers`
  // staying empty there is what the branch below reads to decide whether an
  // empty capture is a bug or a fact.
  const capture = createViteCapture()

  // TWO CHANNELS, narrowed on the host's own `accepts` discriminant so the
  // compiler checks each injection against the host that will receive it. They
  // are deliberately not made to look alike (§ 1, `StamperInjection`): one is a
  // live plugin array that exists only in this process, the other is a file path
  // plus JSON that has to survive Turbopack's forked loader worker.
  //
  // Wrapped for the same reason `materialize` is: everything from here to the
  // front door is post-probe, and a post-probe throw that is not a
  // `HostBootError` bypasses the ladder in `core.ts` entirely. MEASURED with a
  // host whose `boot()` threw `listen EADDRINUSE …`: `isHostBootError: false`,
  // and the user saw that sentence alone. The register in
  // `tasks/dev-server-hosts.md` § 6 lists attach as the fallback for every row
  // in this range (`getRequestHandler()`, `astro.dev()`, React Router's
  // `configFile`, `@nuxt/cli`'s `runCommand`) — which is only true if the
  // ladder gets to say so.
  let boot: HostBoot
  try {
    boot =
      host.accepts === "turbopack-loader"
        ? await host.boot(ctx, turbopackInjection(policy, assets), assets)
        : await host.boot(
            ctx,
            {
              channel: "vite-plugin",
              plugins: [
                ...opts.plugins(policy, { id: host.id, bridgeTags: host.bridgeTags }),
                capture.plugin(),
              ],
            },
            assets,
          )
  } catch (err) {
    throw bootStepFailure(
      host,
      `${host.displayName} could not be started in Editor's own process.`,
      err,
    )
  }

  // `direct` is the plain Vite path: the framework's own listener IS the front
  // door, on the port the user asked for, so bookmarks survive. Everything else
  // gets the proxy, which is what puts the bridge tags into HTML no
  // `transformIndexHtml` ever sees.
  //
  // DELIBERATELY NOT wrapped in a `HostBootError`, unlike every step above it.
  // The front door is the one part of this pipeline attach mode does NOT
  // route around: attach binds the same port with the same `startAttachProxy`
  // and reads the same bridge bundle, so the two things that fail here — the
  // port being taken, the bundle being unreadable — fail identically under
  // `--attach`. A failure claiming `attachCovers` would print two commands that
  // cannot work, and claiming the opposite would take the ladder's
  // `!attachCovers` rung, which § 1 marks unreachable. The raw error names the
  // port or the path, which is the actionable fact.
  const front =
    boot.transport.kind === "direct"
      ? { url: boot.transport.origin, close: () => boot.close() }
      : await frontWithProxy(boot, opts, controller)

  if (boot.sideDoorOrigins.length > 0) {
    // Disclosed, not hidden. These frameworks bind their own listener and offer
    // no way not to; the mitigation is loopback + an ephemeral port, and the
    // honest report of what that leaves reachable is this line.
    console.warn(
      `[host:${host.id}] ${boot.sideDoorOrigins.join(", ")} is this framework's own listener. ` +
        "Editor serves the prototype through its proxy instead; that origin stays reachable on " +
        "loopback and serves pages with no bridge injected.",
    )
  }
  for (const gap of boot.security.gaps) {
    console.warn(`[host:${host.id}] ${gap}`)
  }
  for (const gap of coverage.uncovered) {
    // A DECLARED gap, printed once at boot. The alternative — which is what
    // shipped before this line existed — is that the user discovers which files
    // are editable by clicking one that is not.
    console.warn(`[host:${host.id}] ${gap.reason}`)
  }

  // The capture's ONLY remaining consumer in this file. It used to also supply
  // the handle's `vite` member; that member is gone (see `hosts/handle.ts`), and
  // with it the bug where downstream read `servers[0]` — the client lane on a
  // two-lane host — and called it "the" dev server.
  if (capture.servers.length === 0 && host.accepts === "vite-plugin") {
    // Not fatal: HMR falls back to the OS watcher and the smoke check falls back
    // to reading the served HTML. But it means a plugin hook we rely on did not
    // run, which is worth saying out loud rather than discovering as a weaker
    // check three files away.
    //
    // Gated on the CHANNEL, not on the host id: a `turbopack-loader` host has no
    // Vite anywhere, so an empty capture there is the expected state and warning
    // about it would be noise printed on every Next boot — which is how a
    // warning that does mean something stops being read.
    console.warn(
      `[host:${host.id}] no Vite server was captured at boot. HMR invalidation and the ` +
        "module-graph stamp check will both degrade. This is a bug, not a configuration.",
    )
  }

  return {
    url: front.url,
    // The host's own answer, always — `HostBoot.base` is defined as what the
    // FRONT DOOR serves at, so a fronted host has already reported `/` and the
    // proxy's identical `/` would only be a second place for it to come from.
    base: boot.base,
    hostId: host.id,
    boot,
    coverage,
    // Undefined stays undefined: `verifyStamping` renders the seam only when
    // one was supplied, so a host that designates none produces the same
    // seam-free failure it produced before this member existed.
    stamperSeam: host.stamperSeam,
    host: descriptorOf(host),
    close: async () => {
      try {
        // ONE close. For a fronted host this is the proxy's, which shuts the
        // front door and then runs `boot.close()` through its `onClose` — so
        // the two listeners cannot be torn down in the wrong order, and cannot
        // be closed twice by a caller that knows about both.
        await front.close()
      } finally {
        controller.abort()
      }
    },
  }
}

/**
 * Put the shipped attach proxy in front of a host that bound its own port.
 *
 * The upstream is already listening by the time this runs, so every failure
 * path here has to take it down: a boot that ends in a throw must not leave a
 * dev server running on a loopback port with nothing pointing at it.
 */
async function frontWithProxy(
  boot: HostBoot,
  opts: HostRunOptions,
  controller: AbortController,
): Promise<{ url: string; close: () => Promise<void> }> {
  try {
    const proxy = await startAttachProxy({
      upstreamUrl: boot.transport.origin,
      host: opts.frontDoor.host,
      port: opts.frontDoor.port,
      bridgeBundlePath: opts.bridge.bundlePath,
      html2canvasPath: opts.bridge.html2canvasPath,
      shellOrigin: opts.bridge.shellOrigin,
      // The proxy owns the composed teardown from here.
      onClose: () => boot.close(),
    })
    return { url: proxy.url, close: () => proxy.close() }
  } catch (err) {
    await boot.close().catch(() => undefined)
    controller.abort()
    throw err
  }
}

/**
 * Turn anything a post-probe pipeline step threw into a {@link HostBootError},
 * so `core.ts`'s catch recognises it and the ladder renders it.
 *
 * **Why every one of these is `attachCovers: true`.** Attach mode shares none
 * of the machinery in this range: the user's own dev server does the booting,
 * and its stamper is registered from their own config rather than from anything
 * we materialize. `tasks/dev-server-hosts.md` § 6 already names attach as the
 * fallback for every seam in here, and this is the wiring that lets the ladder
 * say so instead of a bare error escaping.
 *
 * **Why `boot-failed` and not a new code.** The code list in `types.ts` is a
 * transcription of § 1, where "a deviation belongs there first"; `boot-failed`
 * is defined as "the host's own boot threw", and § 5's pipeline row spells the
 * boot out as "probe → materialize → resolve stampers → boot → front door" —
 * so a materialization throw is a boot throw, one step earlier. The step is
 * distinguished by `summary`, which is what the user reads, rather than by a
 * code nothing branches on.
 *
 * The cause is carried VERBATIM and untruncated (`HostFailure.cause`): the
 * materializer's own message already names the directory it could not write and
 * the `XDG_CACHE_HOME` fix, and rewording a framework's boot error is how the
 * one searchable string in the output gets lost.
 */
function bootStepFailure(host: AnyDevServerHost, summary: string, err: unknown): HostBootError {
  return new HostBootError(
    {
      code: "boot-failed",
      summary,
      cause: err instanceof Error ? err.message : String(err),
      // The ladder renders its own two commands and ignores this list; it is
      // what the provisional `formatHostFailure` prints for a failure that
      // somehow escapes without being adjudicated, so it says the same thing.
      remediation: ["Start the project's dev server yourself and re-run with --attach <url>."],
      attachCovers: true,
    },
    descriptorOf(host),
  )
}

/**
 * The three fields a failure message needs, copied out of the host.
 *
 * Copied rather than passed by reference so a failure carries FACTS and not a
 * live host — nothing downstream of a refusal should be able to boot it a
 * second time. `DevServerHost` satisfies `HostDescriptor` structurally, which is
 * why this is three property reads and not an adapter.
 */
function descriptorOf(host: AnyDevServerHost): HostDescriptor {
  return { id: host.id, displayName: host.displayName, devCommand: host.devCommand }
}

/** Today's single-valued detection, expressed as the languages it implies. */
function defaultLanguages(framework: Framework): readonly SourceLanguage[] {
  return framework === "react" ? ["jsx"] : ["vue-sfc"]
}

/**
 * The installed-package set `stampLanguages` receives until detection produces
 * one.
 *
 * Frozen and named rather than an inline `new Set()` so the emptiness is a
 * stated fact with one place to change, not an accident repeated at a call
 * site. See `HostDetection.installed` in `tasks/dev-server-hosts.md` § 1.
 */
const NO_INSTALLED_PACKAGES: ReadonlySet<string> = new Set<string>()
