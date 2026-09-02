/**
 * The `DevServerHost` seam — every interface Editor's five in-process dev-server
 * hosts (plain Vite, Nuxt, Astro, React Router, Next) plus attach are built
 * against. See `tasks/dev-server-hosts.md` § 1 for the design of record; this
 * file is its transcription, and a deviation belongs there first.
 *
 * **Nothing in this file is wired yet.** It ships ahead of the hosts so the
 * implementations have a fixed target — in particular so `StampPolicy`'s
 * JSON-only constraint (see below) is enforced by the compiler from the first
 * commit rather than discovered by the Next lane, which is the one place it
 * cannot be worked around.
 *
 * The organising claim behind the shape of all of this: the dangerous failure
 * is not a crash, it is a **healthy 200-serving dev server that stamps
 * nothing** — the app looks fine, elements are inspectable, and only edits are
 * refused, minutes later, mid-click. So the types are built around three gates
 * in order — probe before boot / verify after boot / ladder on failure — and
 * make "we could not stamp this" a declared, typed state rather than a silence.
 */
import type { Plugin } from "vite"

/* ══════════════════════════════════════════════════════════════════════════
 * Identity
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * Every dev-server host Editor can drive.
 *
 * `attach` is a FIRST-CLASS HOST, not a mode. Its `boot()` is "connect to a URL
 * someone else is already serving"; everything downstream — stamping coverage,
 * verification, the ladder — is identical. Modelling it as a peer is what keeps
 * the escape hatch exercised instead of rotting as a branch in `core.ts`.
 *
 * `registry.ts` is the only file allowed to switch on this. Adding a member
 * should produce exactly two compile errors: the registry and the detection
 * signal table.
 *
 * Replaces BOTH the old `PrototypeHost` ("vite-supervised" | "vite-meta" |
 * "next", which named OUR boot path rather than the repo) and the identical
 * `AttachHost` in attach-preflight. The `vite-meta` tier existed only to say
 * "not bootable by us"; that is now a measurable boot failure plus
 * `HostSeam.stability`, not a name.
 */
export type HostId = "vite" | "nuxt" | "astro" | "react-router" | "next" | "attach"

/**
 * A source dialect a stamper knows how to annotate.
 *
 * NOT a framework, and NOT single-valued. MEASURED: one Astro server
 * hot-updates a `.tsx` island and full-reloads a `.astro` page in the same
 * process, and both are stampable surfaces. `framework: "vue3" | "react"`
 * cannot express that; this can.
 */
export type SourceLanguage = "vue-sfc" | "jsx" | "astro"

/** The shell / icon-scan / styling axis. Unchanged semantics, still single-valued. */
export type Framework = "vue3" | "react"

/* ══════════════════════════════════════════════════════════════════════════
 * Detection — evidence, not a verdict
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * One host this repo MIGHT be, and the facts that say so.
 *
 * The shape that replaced `PrototypeHost` / `MetaFramework`. Those named OUR
 * boot path (`vite-supervised` meant "we can boot it", `vite-meta` meant "we
 * cannot"), which is a fact about Editor rather than about the repo — and it
 * forced detection to answer a question it could not: a single verdict, first
 * marker wins, no way to say "two frameworks both look certain here".
 *
 * Evidence separates the observation from the decision. Detection lists what it
 * found; `hosts/resolve.ts` adjudicates.
 */
export interface HostEvidence {
  hostId: HostId
  /**
   * `certain` — the dependency AND the framework's own config file are both
   * present. `likely` — one of the two.
   *
   * The distinction is load-bearing in exactly one place: two `certain`
   * meta-framework candidates is an ambiguity refusal, while a `certain` one
   * next to a `likely` one is a ranking. A repo with `nuxt` declared and a
   * `nuxt.config.ts` on disk is not the same claim as a repo that merely has
   * `astro` in a devDependency for a docs sub-package.
   */
  confidence: "certain" | "likely"
  /**
   * The facts that produced this, quoted so the user can check them.
   * Rendered VERBATIM in an ambiguity refusal and by `--doctor`.
   */
  because: string[]
}

/**
 * Everything detection can say about a repo, without booting anything.
 *
 * `candidates` MAY BE EMPTY, and that is not an error — it is the `unknown`
 * downgrade (`hosts/resolve.ts` rule 7): no in-process host matched, so the
 * session goes to attach mode rather than being refused.
 */
export interface HostDetection {
  /** Ranked, most specific first. May be empty. */
  candidates: HostEvidence[]
  /**
   * Source dialects this repo contains, MULTI-VALUED. An Astro repo with React
   * islands is `["astro", "jsx"]` — a shape `framework` cannot express, and the
   * reason `.astro`'s missing stamper can be reported as a declared gap instead
   * of discovered by clicking.
   */
  languages: SourceLanguage[]
  /** The shell / icon-scan / styling axis. Still single-valued; still required. */
  framework: Framework
  /** Soft warnings (version ranges we could not parse, majors below the floor). */
  warnings: string[]
}

/* ══════════════════════════════════════════════════════════════════════════
 * Stamping scope — PLAIN JSON, and that is load-bearing
 * ══════════════════════════════════════════════════════════════════════════ */

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonValue[] | { [k: string]: JsonValue }
/**
 * Fails the BUILD at the declaration below if a non-JSON field is ever added.
 *
 * MEASURED (`tasks/dev-server-hosts.md` § 0c): Turbopack runs loaders in a
 * FORKED WORKER, so only a file path plus structured-cloneable options survive
 * the boundary. A `filter: (id) => boolean` member would typecheck perfectly
 * and then make the Next lane unimplementable — discovered on first attempt,
 * after the type had already been adopted by four other hosts. The constraint
 * is invisible from every host except one, which is exactly the kind of
 * constraint that has to be held by the compiler rather than by a comment.
 *
 * VERIFIED, not assumed: adding `filter: (id: string) => boolean` to
 * `StampPolicy` fails `tsc` with TS2344 at the `_StampPolicyIsJson` declaration
 * below AND, transitively, at `_StamperLoaderOptionsIsJson` — which is the fork
 * boundary itself. The `type`-alias-not-`interface` detail is load-bearing: an
 * `interface` gets no implicit index signature, so the guard would compile
 * against anything and enforce nothing.
 */
type AssertJson<T extends Record<string, JsonValue>> = T

/**
 * Which files may be stamped.
 *
 * **Must stay structured-cloneable** — see `AssertJson` above. Declared as a
 * `type` alias and not an `interface` on purpose: only object-literal type
 * aliases get the implicit index signature that makes the `AssertJson` guard
 * below compile.
 *
 * The rule is root-containment + segment-exact denial, NOT the substring
 * blacklist the two stamper plugins carry today. MEASURED: today's
 * `id.includes("/node_modules/")` correctly skips 41 of 61 `.vue` ids on a real
 * Nuxt repo, but a linked / sibling first-party file with no `node_modules`
 * segment IS stamped, producing `../outside-lib/Card.tsx:6:4` — a stamp
 * `resolve-editable-path.ts` then 400s on ("File path escapes prototype root").
 * That is a selectable element whose every edit fails.
 *
 * Stamping a file is a PROMISE THAT AN EDIT WILL LAND. Leaving an element
 * unstamped is strictly better than stamping it and refusing: the bridge walks
 * up to the nearest stamped ancestor, which is an editable target that works.
 */
export type StampPolicy = {
  /**
   * Absolute paths. A file is stampable iff `path.relative(root, id)` is
   * non-empty, non-absolute and does not begin with `..` for SOME root here.
   *
   * `relative()`, never `startsWith()` — otherwise `/repo-backup` passes for
   * root `/repo`.
   *
   * Always contains `repoRoot`. Contains `repoRootReal` when the checkout is
   * reached through a symlink — `core.ts` computes this today and then DROPS IT
   * on the floor at the plugin construction site.
   */
  roots: string[]
  /**
   * Path SEGMENTS that disqualify a file, tested against the root-relative path
   * with `.split(path.sep).includes(seg)` — the same test `edit-handler.ts`
   * already uses for the token-value lane.
   *
   * Segment-exact, not substring: the substring form would silently skip every
   * file in a repo whose own path contains a `node_modules` segment, and it is a
   * security-relevant rule currently written twice and about to be written a
   * third time.
   */
  denySegments: string[]
  /**
   * Absolute directories to skip. The framework's build output — `.nuxt`,
   * `.astro`, `.react-router`, `.next` — sits INSIDE repoRoot, so
   * root-containment alone admits it, and its contents are regenerated, so a
   * stamp there is a dead stamp. Supplied from `DevServerHost.buildDirs`.
   */
  denyDirs: string[]
  /**
   * Which root `data-desde-src` is written relative to. MUST be an element of
   * `roots`. An explicit field rather than a `roots[0]` positional convention,
   * because positional conventions are what break silently.
   */
  stampRoot: string
}
type _StampPolicyIsJson = AssertJson<StampPolicy>

/* ══════════════════════════════════════════════════════════════════════════
 * Stampers — two channels, deliberately not unified
 * ══════════════════════════════════════════════════════════════════════════ */

export type StamperChannel = "vite-plugin" | "turbopack-loader"

/**
 * Options handed to the Turbopack loader. Crosses a process boundary; JSON only.
 */
export type StamperLoaderOptions = { repoRoot: string; policy: StampPolicy }
type _StamperLoaderOptionsIsJson = AssertJson<StamperLoaderOptions>

/**
 * A stamper in the form a given channel consumes.
 *
 * These are deliberately not made to look alike. One is a live object that
 * exists only in this process; the other is bytes on disk plus JSON that has to
 * survive a fork. Collapsing them behind an `inject(config)` façade would hide
 * the single hardest constraint in this design.
 */
export type StamperInjection =
  | { channel: "vite-plugin"; plugins: Plugin[] }
  | {
      channel: "turbopack-loader"
      /** Absolute path to a materialized, self-contained CJS loader. */
      loaderPath: string
      /** Globs to register it for, e.g. `["*.tsx", "*.jsx"]`. */
      globs: string[]
      options: StamperLoaderOptions
    }

export interface StamperContext {
  repoRoot: string
  policy: StampPolicy
  /** Where materialized artifacts may be written. NEVER inside the user's repo. */
  artifactDir: string
}

/** One per (language × channel). Registered in `hosts/stampers.ts`. */
export interface StamperProvider {
  readonly language: SourceLanguage
  readonly extensions: readonly string[]
  vitePlugin?(ctx: StamperContext): Plugin
  turbopackLoader?(ctx: StamperContext): Promise<{ loaderPath: string; globs: string[] }>
}

/**
 * What the pipeline could and could not stamp, this boot.
 *
 * A language with no provider for the host's channel is a DECLARED gap: logged
 * at boot, carried on the handle, named in the smoke report. Never a silent
 * nothing. This is what makes `.astro` markup and `.svelte` honest states
 * rather than mysteries.
 */
export interface StampingCoverage {
  covered: { language: SourceLanguage; via: StamperChannel }[]
  uncovered: { language: SourceLanguage; reason: string }[]
}

/**
 * What a stamper decided about ONE module, when the decision was not "stamped
 * cleanly".
 *
 * **The complement of {@link StampingCoverage}, and the reason both exist.**
 * Coverage is per-LANGUAGE and known BEFORE boot: it answers "does a stamper for
 * this dialect exist on this channel at all". This is per-MODULE and known only
 * once a stamper has run: a covered language whose stamper looked at one
 * specific file and could not honour the promise on it. `.astro` markup is the
 * first; `src/App.tsx` under `styled-jsx/babel` is the second, and no amount of
 * coverage declaration predicts it — it depends on the repo's own plugin list.
 *
 * The two must never be conflated in the boot report: a coverage gap is a
 * property of the build and is printed once, up front, by `hosts/run.ts`. A
 * module notice is a property of the user's project and names a file they can
 * open. `hosts/stamp-notices.ts` is where the join happens, and it DROPS any
 * notice for a language coverage already declared uncovered, so a future
 * `.astro` stamper cannot produce two contradicting explanations of the same
 * silence.
 */
export type ModuleStampOutcome =
  /**
   * The stamper refused: the file serves ZERO `data-desde-src`. Its elements are
   * still selectable (the bridge walks up to the nearest stamped ancestor) but
   * every edit aimed at them is refused.
   */
  | "inspect-only"
  /**
   * The file IS stamped, but from bytes that are not the ones on disk, so a
   * coordinate may name the wrong element. Strictly worse than `inspect-only`
   * in consequence and strictly quieter in symptom — which is why it is
   * reported rather than folded into the refusal case.
   */
  | "coordinates-suspect"

export interface ModuleStampNotice {
  /** Repo-relative, exactly as the stamp would have carried it. */
  file: string
  outcome: ModuleStampOutcome
  /** One clause, lower-case, no trailing stop — rendered inside parentheses. */
  detail: string
}

/* ══════════════════════════════════════════════════════════════════════════
 * Seams and version gating — the risk surface, made declarative
 * ══════════════════════════════════════════════════════════════════════════ */

export interface HostSeam {
  /** Named verbatim in the failure message and in `--doctor`. */
  id: string
  /**
   * - `public`       — documented, semver-covered API.
   * - `experimental` — the vendor marks it `@experimental` in its own types.
   * - `private`      — a deep import or internal object we are not supposed to
   *                    touch; a minor release may move it with no notice.
   *
   * A `private` seam MUST carry a causal assertion in `probe()` — not merely
   * "the module resolves". See `hosts/next/prime-config.ts`.
   */
  stability: "public" | "experimental" | "private"
  /** The literal expression, quoted so the fix is greppable. */
  expression: string
  /** What we lose if it breaks. One clause. */
  buys: string
}

export interface HostVersionGate {
  /** Package whose installed version we read, resolved FROM THE PROTOTYPE. */
  packageName: string
  /** Semver range MEASURED to work. Outside → notice, not refusal. */
  tested: string
}

/* ══════════════════════════════════════════════════════════════════════════
 * Failure — the product-facing artifact, designed before the happy path
 * ══════════════════════════════════════════════════════════════════════════ */

export type HostFailureCode =
  /** Declared in package.json, not installed. → `npm install`. */
  | "host-package-missing"
  /** Deep import path gone, or a required export renamed. */
  | "seam-missing"
  /** Present and callable, but returns the wrong shape or loses identity. */
  | "seam-shape-changed"
  /** Outside the tested range AND a shape probe failed, under `--strict-versions`. */
  | "host-version-unsupported"
  /** The host's own boot threw. `cause` carries it verbatim. */
  | "boot-failed"
  /** The framework refused to hand over or bind what we need. */
  | "listener-refused"
  /**
   * THE `conf`-no-op class: server healthy, injection inert. Only reachable
   * from `verifyStamping`, and only when `StampExpectation` makes zero stamps
   * conclusive.
   */
  | "injection-not-observed"
  /** Two meta-framework markers, both `certain`. Refuse; name `--host`. */
  | "ambiguous-host"
  /** No in-process host matched. A DOWNGRADE to attach, not a refusal to serve. */
  | "no-in-process-host"

export interface HostFailure {
  code: HostFailureCode
  /** One sentence, in the user's terms. */
  summary: string
  /** The seam that broke, when one did. Rendered so the user can search for it. */
  seam?: HostSeam
  detected?: { package: string; installed: string; tested: string }
  /** Underlying error, verbatim and untruncated. */
  cause?: string
  /** Ordered, imperative. Rendered as a numbered list. */
  remediation: string[]
  /**
   * Can `--attach` cover this? TRUE for every seam / boot / verify failure
   * (attach needs none of our seams). FALSE only when the repo is not a shape
   * we can serve at all, which is `FrameworkUnsupportedError`'s job, not ours.
   */
  attachCovers: boolean
}

export type ProbeResult =
  | { ok: true; version: string; notices: string[] }
  | { ok: false; failure: HostFailure }

/* ══════════════════════════════════════════════════════════════════════════
 * Stamp evidence — three-valued on purpose
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * What zero stamps in the initial HTML MEANS for this host — computed at boot
 * from the RESOLVED config (Nuxt's `ssr`, React Router's `ssr`), never guessed
 * from the host name.
 */
export type StampExpectation =
  /** Plain Vite supervised: the module graph is authoritative; HTML is noise. */
  | "module-graph"
  /** Server-rendered document: zero stamps is PROOF the stamper is not running. */
  | "required-in-html"
  /** Client-rendered: stamps appear post-hydration. HTML is inconclusive. */
  | "post-hydration"
  /**
   * Astro: `.astro` markup has no stamper in v1 and islands may be absent, so
   * zero stamps is a warning naming that gap, not a failure.
   */
  | "partial"

export type StampEvidence =
  | { verdict: "stamped"; how: string; sample: string; count: number }
  | { verdict: "unstamped"; how: string; failure: HostFailure }
  | { verdict: "indeterminate"; reason: string }

/* ══════════════════════════════════════════════════════════════════════════
 * HMR — plural invalidation, per-EXTENSION reload profile
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * Deterministic replay of our own writes into the dev pipeline, because macOS
 * fsevents can coalesce or drop the watcher event.
 *
 * **A method, and plural inside.** MEASURED on Nuxt: `configureServer` fires
 * TWICE, with two different watchers AND two different module graphs
 * (`build.ssr=false` / `true`); emitting on the client one alone leaves the SSR
 * lane serving stale HTML (`SSR HTML contains "EDITED": false` after a
 * client-only emit, `true` after both). A single `ViteDevServer` field — which
 * is what ships today — silently half-works on Nuxt. That is the single most
 * load-bearing finding in this design, and hiding the plurality behind a method
 * is what keeps `ViteDevServer` out of every neutral type.
 *
 * MEASURED elsewhere: React Router's boot result IS the ViteDevServer and ONE
 * `watcher.emit('change')` refreshes both client and SSR lanes; Astro's
 * `DevServer.watcher === ViteDevServer.watcher` (`true`). Next and attach have
 * no lane at all — the upstream's own watcher already sees our writes.
 */
export interface HostHmr {
  /** Lanes we can push into, for diagnostics. `[]` = the host owns its watcher. */
  readonly lanes: readonly string[]
  /** Absolute paths. Best-effort; must NEVER throw into an edit response. */
  invalidate(absFiles: readonly string[]): void
  /**
   * Per-LANGUAGE HMR mode, not per-host. MEASURED: the same Astro server
   * hot-updates `.tsx` (js-update, sentinel survives, 0 navigations) and
   * FULL-RELOADS `.astro` (`{"type":"full-reload"}`, sentinel wiped, 1
   * navigation). Anything the shell holds in browser memory across an edit —
   * bridge connection, selection overlay, inspector state, scroll, open dialog
   * — dies on the reload path and must re-establish from `BRIDGE_READY`.
   */
  readonly reload: HmrProfile
}

export interface HmrProfile {
  /** Extensions MEASURED to hot-update in place. */
  hot: readonly string[]
  /** Extensions MEASURED to trigger a full reload. Re-handshake required. */
  fullReload: readonly string[]
}

/* ══════════════════════════════════════════════════════════════════════════
 * Transport, bridge, security
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * Who owns the listener. Decides fronting, shutdown order, and side doors.
 *
 *  - `direct`             — the framework's own listener IS the front door.
 *                           Plain Vite only. Not proxied.
 *  - `in-process-handler` — WE bound the only listener (Next's
 *                           `getRequestHandler()` on our `http.Server`).
 *                           Fronted by the proxy; NO side door.
 *  - `http-upstream`      — the FRAMEWORK bound a port we cannot prevent.
 *                           Nuxt / Astro / React Router / attach. Fronted by
 *                           the proxy; the framework's port is a side door.
 */
export type HostTransport =
  | { kind: "direct"; origin: string }
  | { kind: "in-process-handler"; origin: string }
  | { kind: "http-upstream"; origin: string }

/** How the bridge `<script>` tags reach the served HTML. */
export type BridgeTagStrategy =
  /** `bridgePlugin.transformIndexHtml`. MEASURED to fire on plain Vite ONLY. */
  | "vite-transform-index-html"
  /** The shipped attach proxy's streaming injector. Everything else. */
  | "proxy-response-injection"
  /**
   * A native framework config API (Nuxt `overrides.app.head.script`). MEASURED
   * working with `data-shell-origin` preserved verbatim. NOT USED in v1 — see
   * `tasks/dev-server-hosts.md` § 7. Typed so enabling it is a flag flip, not a
   * redesign.
   */
  | "framework-head-config"

export interface HostSecurityReport {
  /** True when this host narrowed the dev server's OWN config (Vite family). */
  narrowedServerConfig: boolean
  /** Dotted `server.*` keys taken back from the repo's config. */
  overridden: string[]
  /**
   * Protections this host CANNOT provide, in prose. Printed at boot.
   * Non-empty by construction for `next` (no `fs.deny`, no `allowedHosts`, no
   * `fs.strict`) and for `attach`. Silence here would be a lie, and a typed
   * array is harder to forget than a paragraph.
   */
  gaps: string[]
}

/* ══════════════════════════════════════════════════════════════════════════
 * Context and boot result
 * ══════════════════════════════════════════════════════════════════════════ */

export interface HostContext {
  /** Git root. Where `.desde/` lives and what stamps are relative to. */
  repoRoot: string
  /** Same, symlinks resolved, when different. */
  repoRootReal?: string
  /** Where the framework roots and finds its config: `repoRoot` or a subdir. */
  prototypeRoot: string
  framework: Framework
  /** Source languages detection found. Multi-valued for Astro. */
  languages: readonly SourceLanguage[]
  policy: StampPolicy
  /**
   * The address the BROWSER uses. A `direct` host binds this itself; every
   * fronted host leaves it to the proxy.
   */
  frontDoor: { host: string; port: number }
  /**
   * Loopback address a fronted host binds. `port: 0` — always OS-picked, and
   * always read back from `server.address()`, never assumed.
   */
  internal: { host: string; port: number }
  /** Where a host may write generated assets. NEVER inside the user's repo. */
  artifactDir: string
  /** Escalate an out-of-range version from a notice to a refusal. */
  strictVersions: boolean
  /**
   * The already-normalised `--attach` origin, for the ONE host whose boot is
   * "connect to a server someone else started".
   *
   * Optional because it is meaningless to the other five: they are given a port
   * to bind (`frontDoor` / `internal`), not a server to find. The attach host
   * throws if it is absent, and `resolveHost` refuses `--host attach` without a
   * URL so that throw is unreachable through the CLI.
   */
  attachUrl?: string
  signal: AbortSignal
}

export interface MaterializedAssets {
  /** Absolute path → what it is. Next: the Turbopack loader. */
  files: Record<string, string>
}

export interface HostBoot {
  transport: HostTransport
  /**
   * Served path prefix, always trailing-slashed.
   *
   * **This is what the FRONT DOOR serves at, never what the inner Vite thinks.**
   * The shell maps a served stylesheet href back to a source file with it.
   * Nuxt's inner Vite `base` is `/_nuxt/`; reporting that would break the
   * mapping. Every fronted host reports `/`; only the `direct` Vite host
   * reports `server.config.base`.
   */
  base: string
  /** Always the host's own {@link DevServerHost.bridgeTags} constant. */
  bridgeTags: BridgeTagStrategy
  hmr: HostHmr
  security: HostSecurityReport
  stampExpectation: StampExpectation
  /**
   * Origins the framework bound that we do NOT front — reachable UN-INJECTED.
   * Non-empty for every `http-upstream` host. Disclosed at boot rather than
   * pretended away; mitigated by loopback + ephemeral binding.
   */
  sideDoorOrigins: string[]
  /**
   * Extra document routes worth probing in `verifyStamping`, beyond `/`.
   * Default `[]` — a host fills it only when it can enumerate cheaply.
   */
  probeRoutes: string[]
  /**
   * OPTIONAL deepest evidence: walk this host's Vite module graph for a stamped
   * module. Present on every Vite-family host (via the capture plugin), absent
   * for Next and attach.
   *
   * **It may only PROMOTE a verdict to `stamped`. It may never on its own
   * produce `unstamped`** — a cold or base-shifted graph legitimately contains
   * nothing, and an SSR host's entry discovery runs against the proxy origin.
   */
  moduleGraphEvidence?(): Promise<boolean>
  close(): Promise<void>
}

/* ══════════════════════════════════════════════════════════════════════════
 * THE adapter
 * ══════════════════════════════════════════════════════════════════════════ */

export interface DevServerHost<K extends StamperChannel = StamperChannel> {
  readonly id: HostId
  readonly displayName: string

  /** Every seam this host stands on. Rendered in `--doctor` and in failures. */
  readonly seams: readonly HostSeam[]

  /**
   * The ONE seam that carries the source stamper into this host — supplied only
   * when the host genuinely has one, and consumed by exactly one failure:
   * `injection-not-observed` (healthy server, zero stamps), which
   * `verifyStamping` produces without anything having thrown.
   *
   * **Why it is opt-in rather than derived.** That failure has no exception to
   * read a seam off, so `verify.ts` deliberately fabricates none: a seam we
   * merely suspect would be a made-up fact printed in the one place a customer
   * is told what to go and look at. Naming it is therefore a claim only the
   * host can make.
   *
   * **The claim it makes.** "If this host boots healthy and stamps nothing, THIS
   * is the channel that did not deliver." Which is true for Next (the config
   * memo is the only in-memory route a Turbopack loader has) and for Nuxt
   * (`overrides.vite.plugins` is the forwarding step, and its two other seams
   * both fail loudly at boot) — and false for the hosts that hand their plugin
   * array straight to a `createServer` they call themselves, where there is no
   * forwarding step to silently drop it. Those designate nothing, on purpose.
   *
   * **MUST be one of {@link seams}, by object identity** — a
   * `stamper-seam.test.ts` case asserts it for every registered host. Declaring
   * one module-level constant and referencing it twice is the same drift-free
   * shape {@link bridgeTags} uses; a second literal here could disagree with the
   * seam table shown next to it.
   */
  readonly stamperSeam?: HostSeam

  /**
   * ABSENT only for a host that resolves no package from the prototype at all.
   * `attach` is the one: the dev server is the user's, started by their own
   * tooling, and there is no package whose installed version we read or gate on.
   * Giving it a placeholder (`packageName: ""`) would put a lie in `--doctor`'s
   * seam table; omitting it prints "—", which is the truth.
   *
   * Every in-process host declares one, and `resolve.test.ts` asserts that over
   * the whole registry so the optionality cannot quietly spread.
   */
  readonly versionGate?: HostVersionGate

  /** Which payload shape this host can accept. The pipeline builds that shape. */
  readonly accepts: K

  /** What to run when in-process boot fails, e.g. `npx nuxt dev`. */
  readonly devCommand: string

  /** Build output dirs, relative to `prototypeRoot`. Fed into `denyDirs`. */
  readonly buildDirs: readonly string[]

  /**
   * How the bridge `<script>` tags will reach served HTML — declared BEFORE
   * boot, because the caller assembling the plugin array has to know it then.
   *
   * `HostBoot.bridgeTags` reports the same fact after the fact. The duplication
   * is deliberate and drift-free by construction: each host declares one
   * module-level constant and both members reference it. The alternative was a
   * switch on `HostId` at the plugin construction site, which is exactly the
   * branching `registry.ts` exists to prevent.
   *
   * What reads it: a host that gets its tags from the proxy must be given
   * `bridgeAssetsPlugin` (serving only), never the composed `bridgePlugin`. If
   * a future Vite made `transformIndexHtml` fire on a fronted host — it fires
   * ZERO times today, MEASURED on Astro, Nuxt and React Router — the composed
   * plugin would inject a SECOND pair of tags alongside the proxy's and load
   * the bridge twice.
   */
  readonly bridgeTags: BridgeTagStrategy

  /**
   * Which source languages to stamp, given what is installed. Kept on the host
   * so "Astro with both React and Vue islands gets both stampers" is expressible
   * without making detection's single-valued `framework` multi-valued.
   */
  stampLanguages(ctx: HostContext, installed: ReadonlySet<string>): SourceLanguage[]

  /**
   * Cheap, side-effect-free, runs BEFORE any boot work. A `private` seam MUST
   * include a causal assertion here.
   */
  probe(ctx: HostContext): Promise<ProbeResult>

  /**
   * OPTIONAL on-disk materialization, implemented ONLY by `next`. The four
   * Vite-family hosts and attach pass a live plugin object and need nothing on
   * disk. Deliberately not a required step: it would be dead weight on five of
   * six hosts.
   */
  materialize?(ctx: HostContext): Promise<MaterializedAssets>

  boot(
    ctx: HostContext,
    injection: Extract<StamperInjection, { channel: K }>,
    assets: MaterializedAssets | null,
  ): Promise<HostBoot>
}
