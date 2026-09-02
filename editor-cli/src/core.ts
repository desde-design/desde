import { resolve as resolvePath, isAbsolute } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { realpath as fsRealpath } from "node:fs/promises"
import { createServer as createNetServer } from "node:net"
import { HostBootError, runHost, type HostRun } from "./hosts/run.js"
import { attachConfigHostFor, resolveHost } from "./hosts/resolve.js"
import { loadEnabledHosts } from "./hosts/enabled-hosts.js"
import { loadEnabledLanes } from "./server/enabled-lanes.js"
import {
  ATTACH_SECURITY_GAPS,
  DISPLAY_NAME as ATTACH_DISPLAY_NAME,
  STAMP_EXPECTATION as ATTACH_STAMP_EXPECTATION,
} from "./hosts/attach/host.js"
import { applyStampGate, decide, HostLadderError, type HostMode } from "./hosts/ladder.js"
import { verifyStamping, type StampVerification } from "./hosts/verify.js"
import { visibleStampNotices } from "./hosts/stamp-notices.js"
import { readModuleStampNotices } from "./plugins/transform-input.js"
import type {
  HostDetection,
  HostFailure,
  HostId,
  ModuleStampNotice,
  StampExpectation,
  StampingCoverage,
} from "./hosts/types.js"
import type { PrototypeServerHandle } from "./hosts/handle.js"
import { startAttachProxy } from "./attach/proxy.js"
import {
  nextLoaderFiles,
  runStampingPreflight,
  vitePluginFiles,
  type AttachHost,
  type StamperFramework,
  type StampingPreflightResult,
} from "./attach-preflight/index.js"
import { writeStamperFiles } from "./attach/write-stampers.js"
import { bridgeAssetsPlugin, bridgePlugin, readBridgeVersion } from "./plugins/bridge-plugin.js"
import { sourceTagPlugin } from "./plugins/source-tag-plugin.js"
import { jsxSourceTagPlugin } from "./plugins/jsx-source-tag-plugin.js"
import { tracerPlugins } from "./plugins/tracer-plugin.js"
import { composeIsolationPlugin } from "./plugins/compose-isolation.js"
import { startHttpServer, type HttpServerHandle } from "./server/http-server.js"
import { resolveUiBundleRoot } from "./server/static-assets.js"
import {
  resolveBridgeBundlePath as resolvePayloadBridgeBundlePath,
  resolveHtml2canvasPath as resolvePayloadHtml2canvasPath,
} from "./payload-paths.js"
import { newSecurityContext } from "./server/auth.js"
import {
  writeSessionInfo,
  removeSessionInfo,
  registerSessionInfoCleanup,
} from "./server/session-info.js"
import { MCP_PROXY_TOOL_NAMES } from "./server/mcp-tool-handler.js"
import type { ProjectIdentity } from "../../src/core/project-identity.js"
import { readProjectConfig } from "./server/project-config.js"
import { upsertProjectRegistryEntry } from "./server/projects-registry.js"
import {
  detectFramework,
  type FrameworkDetectionResult,
} from "./server/framework-detection.js"
import { detectStylingSystem } from "./server/styling-system-detection.js"
import {
  detectOverrideStylesheetFacts,
  type OverrideStylesheetFacts,
} from "../../src/editor/edit-service/detect-override-stylesheet.js"
import type { ProjectKnowledgeConfig } from "../../src/editor/edit-service/load-project-knowledge.js"
import { loadReadRoots, type ReadRootRegistry } from "../../src/editor/core/read-roots.js"
import { InMemoryIconSetRegistry } from "../../src/editor/icon-sets/registry.js"
import { autoDetectIconSets } from "../../src/editor/icon-sets/auto-detect.js"
import { ensureLocallyIgnored } from "../../src/editor/worktree/ensure-locally-ignored.js"
import { applyExtensionSecretsAtBoot } from "./server/apply-extension-secrets.js"
import { applyLlmCredentialsAtBoot } from "./server/apply-llm-credentials.js"
import { preflightCanonicalRoot } from "./server/canonical-preflight.js"
import { resolvePrototypeLocation } from "./server/prototype-location.js"
import { isBranchMode } from "./server/edit-mode.js"
import { loadDesignSystemDeclarations } from "../../src/editor/core/design-system-declarations.js"
import {
  reconcileDesignSystems,
  onboardDesignSystem,
  createDefaultOnboardDeps,
  createLocalRegistryStore,
  checkDesignSystemStaleness,
  detectSubstrateStyleCapabilities,
  type ReconciliationStatusHolder,
  type StalenessResult,
} from "../../src/editor/onboarding/index.js"
import type { StalenessCacheHolder } from "./server/design-systems-handler.js"
import { resetGroundingCache } from "./server/grounding-context.js"
import { runRetentionGc } from "../../src/editor/agent-chat-sdk/retention-gc.js"

/**
 * CSS side-effect imports the compose-isolation route (`composeIsolationPlugin`,
 * Phase 4 rendering-hints) splices into its isolation page, so a probed/edited
 * component renders with its real styles instead of bare unstyled markup.
 *
 * **Discovered, not listed.** This used to be a hardcoded map with a single
 * row for one vendor's package, which meant exactly one design system got styled
 * isolation and every other customer got unstyled markup. It is now derived
 * from the prototype's own dependencies, with two gates:
 *
 *   1. The package must declare `vue` or `react` in its dependencies or
 *      peerDependencies — i.e. it is a COMPONENT library, not a build tool or
 *      a font. Without this gate, `tailwindcss` and `@fontsource-variable/*`
 *      (both of which publish CSS exports) get injected into the isolation
 *      page, which is actively wrong. MEASURED across four real repos: this
 *      gate yields exactly the component libraries and nothing else.
 *   2. The package must NAME a concrete CSS entry — a `style` field, or an
 *      `exports` key ending in `.css`. Wildcard keys (`./*.css`) are rejected:
 *      they are not importable specifiers and would break the isolation page.
 *
 * At most ONE stylesheet is taken per package, preferring a `style`-field
 * entry, then a `style.css`/`styles.css` export, then the first remaining
 * candidate. Packages that ship a theme matrix (25 palette files) therefore
 * contribute one import, not 25.
 *
 * Missing CSS here is NOT a correctness bug: the Phase 4 probe driver
 * (`src/editor/hints/probe-driver.ts`) reads DOM text/attribute VALUES to
 * find where sentinel props/slots render — it never looks at layout or
 * paint, so an unstyled (or wrongly styled) mount still produces correct
 * rendering hints. This only affects visual fidelity for a human looking at
 * the isolation page directly (the "Edit component" flow), not hint generation.
 */
export function resolveProbeCssImports(prototypeRoot: string): string[] {
  let rootPkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  try {
    rootPkg = JSON.parse(
      readFileSync(resolvePath(prototypeRoot, "package.json"), "utf8"),
    )
  } catch {
    return []
  }

  const imports: string[] = []
  for (const pkgName of Object.keys({ ...rootPkg.dependencies, ...rootPkg.devDependencies })) {
    const spec = probePackageStylesheet(prototypeRoot, pkgName)
    if (spec) imports.push(spec)
  }
  return imports
}

/**
 * The one importable stylesheet specifier for `pkgName`, or null. See
 * {@link resolveProbeCssImports} for the two gates and the ordering rule.
 */
function probePackageStylesheet(prototypeRoot: string, pkgName: string): string | null {
  let pkg: {
    style?: unknown
    exports?: unknown
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
  }
  try {
    pkg = JSON.parse(
      readFileSync(
        resolvePath(prototypeRoot, "node_modules", ...pkgName.split("/"), "package.json"),
        "utf8",
      ),
    )
  } catch {
    return null // not installed / unreadable — nothing to import
  }

  // Gate 1 — is this a component library?
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ])
  if (!declared.has("vue") && !declared.has("react")) return null

  // Gate 2 — does it name a concrete, non-wildcard CSS entry?
  const isUsableCss = (v: unknown): v is string =>
    typeof v === "string" && v.toLowerCase().endsWith(".css") && !v.includes("*")

  const pkgDir = resolvePath(prototypeRoot, "node_modules", ...pkgName.split("/"))

  if (isUsableCss(pkg.style) && existsSync(resolvePath(pkgDir, pkg.style))) {
    return `${pkgName}/${pkg.style.replace(/^\.\//, "")}`
  }

  if (!pkg.exports || typeof pkg.exports !== "object") return null
  const exportMap = pkg.exports as Record<string, unknown>
  const cssKeys = Object.keys(exportMap).filter(
    (k) =>
      k.toLowerCase().endsWith(".css") &&
      !k.includes("*") &&
      // Gate 3 — the named entry must RESOLVE, not merely be named.
      // MEASURED on `@kong/icons@1.48.0`: its export map declares
      // `"./dist/style.css": "./dist/kong-icons.css"` while the file it
      // actually ships is `dist/icons.css`, so the specifier passed gates 1
      // and 2 and then failed to resolve in Vite. That is a packaging bug in
      // a third-party library, and it is not ours to fix — but turning it
      // into a 500 on the isolation page IS ours, and it took the entire
      // hint-generation lane down: all 68 components skipped with "mount
      // container not found", every run, silently, because ONE unrelated
      // dependency named a stylesheet it does not ship.
      //
      // This function's own contract already says missing CSS is not a
      // correctness bug, since the probe reads text and attribute values and
      // never looks at paint. That reasoning covers a package with no
      // stylesheet; it did not cover a package whose stylesheet is a dangling
      // pointer, which is strictly worse than having none. Now it does.
      existsSync(resolvePath(pkgDir, exportTargetPath(exportMap[k]) ?? k)),
  )
  if (cssKeys.length === 0) return null

  // Prefer the conventional entry name; otherwise take the first, sorted for
  // determinism (export-map key order is not guaranteed stable across installs).
  const preferred =
    cssKeys.find((k) => /(^|\/)styles?\.css$/i.test(k)) ?? [...cssKeys].sort()[0]
  return `${pkgName}${preferred.replace(/^\./, "")}`
}

/**
 * The file path an export-map target names, following condition objects
 * (`{ import: …, default: … }`) down to their first string leaf. Returns null
 * for a target that names no file at all (`null` targets, used by packages to
 * BLOCK a subpath, are the case that matters — treating one as a path would
 * resurrect exactly the dangling specifier gate 3 exists to reject).
 */
function exportTargetPath(target: unknown): string | null {
  if (typeof target === "string") return target
  if (target && typeof target === "object") {
    for (const value of Object.values(target as Record<string, unknown>)) {
      const found = exportTargetPath(value)
      if (found) return found
    }
  }
  return null
}

export interface CoreOptions {
  /** Repo to open. Resolved against process.cwd() if relative. */
  repoPath: string
  /** Optional: where the bridge bundle lives. Defaults to repo's `dist/bridge-bundle.js`. */
  bridgeBundlePath?: string
  /** Optional: where the UI bundle lives. Defaults to `<editor-cli>/ui-src/dist`. */
  uiBundleRoot?: string
  /** Optional: shell host (editor UI). Defaults to 127.0.0.1. */
  shellHost?: string
  /** Optional: shell port (editor UI). Defaults to 4321. */
  shellPort?: number
  /** Optional: Vite host. Defaults to 127.0.0.1. In attach mode, the proxy's host. */
  viteHost?: string
  /** Optional: Vite port. Defaults to 5173. In attach mode, the proxy's port. */
  vitePort?: number
  /**
   * Attach mode (`--attach <url>`): the origin of a dev server the USER
   * started, which Editor proxies instead of booting one of its own. Required
   * for the `next` and `vite-meta` hosts, which Editor cannot supervise;
   * accepted for `vite-supervised` too, for a developer who wants to keep
   * running their own `vite dev`.
   *
   * Editor deliberately does NOT spawn the user's dev command — process
   * lifecycle, port discovery and log multiplexing are their own surface
   * (tasks/attach-mode.md § Scope).
   */
  attachUrl?: string
  /**
   * `--host <id>`. Names the dev-server host explicitly, overriding detection.
   *
   * Two uses, and only two: telling Editor which framework owns an ambiguous
   * repo (the one thing that clears an `ambiguous-host` refusal), and forcing a
   * host when detection's evidence is right but its ranking is not. It does NOT
   * skip the host's own `probe()` — an override at a host whose seam has moved
   * still refuses, rather than producing a session that boots and never stamps.
   */
  host?: HostId
  /**
   * Optional: skip framework detection. Useful for the in-tree spike
   * test-app and similar throwaway repos where the user knows the
   * framework matches. Production users should NOT pass this.
   */
  skipFrameworkDetection?: boolean
  /**
   * `--host-mode`. Decides what happens when in-process boot cannot be
   * trusted: `auto` routes the user to attach mode (exit 4), `in-process`
   * refuses loudly instead (exit 6). Defaults to `auto` — today's behaviour.
   */
  hostMode?: HostMode
  /**
   * `--skip-stamp-verify`. Downgrades a conclusive stamping failure from a
   * teardown to a warning. Exists so a false positive can never brick a
   * session; it is never applied silently.
   */
  skipStampVerify?: boolean
  /**
   * Optional: asset/port overrides to forward to editors spawned from
   * the breadcrumb "home" launcher (`GET /api/editor/home`). Built by
   * the CLI from the same flags `runLauncher` forwards; defaults to `[]`.
   */
  launcherForwardArgs?: string[]
}

export interface CoreHandle {
  shellUrl: string
  /**
   * Where the prototype is served. Named for the supervised case, which is
   * still the common one; in attach mode it is the PROXY's origin (the
   * upstream is `attach.upstreamUrl`).
   */
  viteUrl: string
  /**
   * Set only in attach mode — Editor is proxying a dev server it did not
   * start. Absent means the Vite supervisor booted the prototype.
   */
  attach?: {
    upstreamUrl: string
    /**
     * What the stamping gate found and wrote. Only ever present with
     * `status: "already-wired"` — the other two statuses refuse the boot, so
     * `startCore` never returns with them.
     */
    stamping: AttachStampingSummary
  }
  bridgeVersion: string
  smokeReport: SmokeReport
  /**
   * Project association status surfaced to the CLI entry so it can log
   * the relevant warnings to the user. Editor is fully functional in
   * degraded modes (missing slug) — this surface just tells the user
   * what's NOT working (deployment lookup, MCP drift signal).
   */
  projectAssociation: ProjectAssociationStatus
  /**
   * Soft warnings from `detectFramework()` (e.g., "design system not
   * detected"). Empty when the support matrix matches cleanly.
   */
  frameworkWarnings: string[]
  /**
   * Read-roots loaded from `desde.config.json`. Always
   * includes the implicit `worktree`. Soft warnings (e.g., duplicate
   * paths) are surfaced here for the CLI entry to log. A bad config
   * fails `startCore` outright; a missing config is fine — registry
   * just contains the worktree.
   */
  readRoots: ReadRootRegistry
  readRootsWarnings: string[]
  close: () => Promise<void>
}

/**
 * Thrown when the repo doesn't match the V1 support matrix per
 * `detectFramework`. The CLI entry catches this specifically and
 * exits with the structured message + non-zero exit code so wrapping
 * tools can react to the discriminator.
 */
export class FrameworkUnsupportedError extends Error {
  constructor(public readonly detection: Extract<FrameworkDetectionResult, { ok: false }>) {
    super(detection.message)
    this.name = "FrameworkUnsupportedError"
  }
}

/**
 * Thrown when the repo is supported but Editor cannot boot its dev server —
 * a Next.js app, or a Vite meta-framework (Nuxt / Astro / React Router). The
 * user has to start the dev server themselves and pass `--attach <url>`.
 *
 * Separate from {@link FrameworkUnsupportedError} because the two are opposite
 * messages: that one says "this repo is out of scope", this one says "this
 * repo works, here are the two commands". Conflating them would send a Next
 * user to the support matrix to read that Next is unsupported, which is no
 * longer true.
 */
export class AttachRequiredError extends Error {
  constructor(
    /**
     * The host that WOULD serve this repo, or null when detection found no
     * in-process candidate at all (the `unknown` downgrade). Carried so a
     * wrapping tool can branch without parsing prose.
     */
    public readonly host: HostId | null,
    public readonly repoPath: string,
  ) {
    super(buildAttachRequiredMessage(host, repoPath))
    this.name = "AttachRequiredError"
  }
}

/**
 * Thrown when two frameworks both look like the owner of this repo's dev
 * server, each corroborated by its own config file on disk.
 *
 * Its own class and its own exit code (7) because its remedy matches none of the
 * others. Collapsing it into {@link FrameworkUnsupportedError} (3) would send a
 * fully supported project to the support matrix; into {@link AttachRequiredError}
 * (4) would tell the user to start a dev server, when attach mode is equally
 * unable to guess which config to wire and would hit the same fork one step
 * later. The remedy is one flag — `--host <id>` — and it is the same flag in
 * both lanes, so the failure names it and nothing else.
 *
 * What it replaces is not another error: it is `META_FRAMEWORK_MARKERS.find(...)`
 * silently returning the first match. A wrong host boots, serves 200s, and
 * stamps nothing.
 */
export class HostAmbiguousError extends Error {
  constructor(public readonly failure: HostFailure) {
    super(renderHostFailure(failure))
    this.name = "HostAmbiguousError"
  }
}

/** Summary, cause, then the numbered remedies. The shape `ladder.render` uses. */
function renderHostFailure(failure: HostFailure): string {
  const lines = [failure.summary, ""]
  if (failure.cause) lines.push(`  Evidence:   ${failure.cause}`, "")
  for (const [i, step] of failure.remediation.entries()) lines.push(`  ${i + 1}. ${step}`)
  return lines.join("\n")
}

/**
 * Thrown when attach mode cannot prove the prototype's own config stamps
 * source. Carries the fully rendered message — the exact block to paste and the
 * file to paste it into — so the CLI entry prints one string and exits.
 *
 * **Why a refusal and not a warning.** A prototype that boots without
 * `data-desde-src` is inspect-only: it looks completely healthy, and the failure
 * surfaces as "every edit is refused" some minutes later, mid-click. That is
 * the worst thing this product can make someone discover interactively, and it
 * is precisely why `runStampingPreflight` was written. A late smoke-check
 * warning — which is all that existed while the preflight sat unimported — is
 * not a substitute: it fires after the browser is already open.
 *
 * Distinct from {@link AttachRequiredError} (exit 4) and
 * {@link FrameworkUnsupportedError} (exit 3), and given its own exit code (5)
 * in `cli.ts`, because a wrapper's correct reaction differs in each case:
 * 3 means "different tool", 4 means "start your dev server", 5 means "edit your
 * config, then re-run the same command".
 */
export class StampingRequiredError extends Error {
  constructor(
    message: string,
    public readonly result: StampingPreflightResult,
  ) {
    super(message)
    this.name = "StampingRequiredError"
  }
}

/** What the attach-mode stamping gate did, for the handle and for tests. */
export interface AttachStampingSummary {
  status: StampingPreflightResult["status"]
  /** Host config file the decision was made against, relative to the prototype. */
  configFile: string
  /** Stamper files written into `.desde/stamp/`, relative to the prototype. */
  stamperFiles: string[]
  /** False when every stamper was already current and nothing was re-bundled. */
  rebuilt: boolean
  warnings: string[]
}

/**
 * One label per host id. `attach` is absent by construction — this message is
 * what you get INSTEAD of booting, so "attach mode is required for an attached
 * dev server" could never be printed.
 */
const HOST_LABEL: Record<Exclude<HostId, "attach">, string> = {
  next: "a Next.js app",
  nuxt: "a Nuxt app",
  astro: "an Astro app",
  "react-router": "a React Router app",
  vite: "a Vite app",
}

/**
 * The exact text a user needs to get unstuck. Two numbered commands and the
 * one-line reason, because "attach mode is required" without the commands is
 * the failure this message exists to prevent.
 *
 * `host` is null for the `unknown` downgrade — detection matched no in-process
 * host at all. That case gets a different second sentence, because there is no
 * framework to name and the honest caveat is a different one: `--attach` will
 * give you a session, and whether that session can EDIT depends on a second,
 * independent fact (does a stamper of ours cover your source dialect).
 *
 * Exported for tests and so any embedder (IDE extension, launcher) renders the
 * same words the CLI does.
 */
export function buildAttachRequiredMessage(host: HostId | null, repoPath: string): string {
  const opening =
    host === null || host === "attach"
      ? [
          "Editor found no dev server it can boot for this project. It attaches to one you start instead.",
          "",
        ]
      : [
          `This is ${HOST_LABEL[host]}, and ${WHY_NOT_SUPERVISED[host]}. Editor attaches to a dev server you start instead of booting one.`,
          "",
        ]
  const closing =
    host === null || host === "attach"
      ? [
          "",
          "Pass the URL from step 1 (origin only, no path). Editor does not start your dev server for you.",
          "Note: Editor's source stamper ships as a Vite plugin and a Next Turbopack loader. On anything",
          "else the prototype can be inspected but not edited.",
        ]
      : [
          "",
          "Pass the URL from step 1 (origin only, no path). Editor does not start your dev server for you.",
        ]
  return [
    ...opening,
    `  1. npm run dev            # in ${repoPath}, note the URL it prints`,
    `  2. desde ${repoPath} --attach http://localhost:3000`,
    ...closing,
  ].join("\n")
}

/**
 * Why each host is not supervised by the plain Vite path.
 *
 * `vite` is in here for the case that used to be impossible and now is not: an
 * in-process host can be BUILT and still be off by default (`enabled-hosts.ts`),
 * so a plain Vite repo whose config turned `hosts.vite` off lands here too.
 */
const WHY_NOT_SUPERVISED: Record<Exclude<HostId, "attach">, string> = {
  next: "Next.js has no Vite dev server for Editor to wrap",
  nuxt: "the framework generates its own HTML in its own dev server, so a plain Vite server serves 404",
  astro:
    "the framework generates its own HTML in its own dev server, so a plain Vite server serves 404",
  "react-router":
    "the framework generates its own HTML in its own dev server, so a plain Vite server serves 404",
  vite: "in-process boot is turned off for this project",
}

/**
 * Validate + normalise an `--attach` URL to a bare origin.
 *
 * Strict on purpose. The proxy's contract is an upstream ORIGIN
 * (`AttachProxyOptions.upstreamUrl`), and every request it forwards is built
 * by joining the incoming path onto it — so a URL carrying a path would either
 * be silently dropped (confusing) or double-joined (broken). Refusing here,
 * with the corrected value spelled out, is the only version of this that
 * cannot mislead.
 */
export function parseAttachUrl(raw: string): string {
  const trimmed = raw.trim()
  // Scheme check FIRST, and by string. `new URL("localhost:3000")` SUCCEEDS —
  // it reads `localhost:` as the protocol and `3000` as the path — so leaving
  // this to the protocol branch below produced "only supports http:// and
  // https:// (got 'localhost://')", which invents a `//` the user never typed
  // and never names the fix. `localhost:3000` is the single most likely thing
  // to be pasted here, so it gets the exact corrected command.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    throw new Error(
      `--attach needs a full URL including the scheme, e.g. http://localhost:3000 (got '${raw}'${
        trimmed ? `; did you mean 'http://${trimmed}'?` : ""
      }).`,
    )
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(
      `--attach needs a full URL, e.g. http://localhost:3000 (got '${raw}').`,
    )
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `--attach only supports http:// and https:// (got '${url.protocol}//' in '${raw}').`,
    )
  }
  if (!url.hostname) {
    throw new Error(`--attach URL has no host: '${raw}'.`)
  }
  if ((url.pathname !== "" && url.pathname !== "/") || url.search || url.hash) {
    throw new Error(
      `--attach takes the dev server's origin only. Pass '${url.origin}' instead of '${raw}'.`,
    )
  }
  return url.origin
}

/**
 * Attach mode requires the prototype to BE its git repo root.
 *
 * `data-desde-src` paths are written relative to a root and resolved against the
 * same root, so the two have to agree. In supervised mode Editor passes the git
 * root into the plugin explicitly. In attach mode it cannot: the stamper runs
 * inside the user's dev server and derives the root from its own location —
 * `<dir>/.desde/stamp/x.mjs` → `<dir>` — where `<dir>` is fixed by where
 * the host's config file lives. For a prototype in a monorepo subdirectory
 * those two roots differ, and the result is not a crash but every stamp
 * pointing at a path that does not exist. Refuse instead.
 */
export function assertStampableLayout(subdirOffset: string, repoPath: string): void {
  if (!subdirOffset) return
  throw new Error(
    [
      `Attach mode does not support a prototype in a repository subdirectory (${subdirOffset}).`,
      "",
      "The source stamper derives the repo root from its own location inside the prototype,",
      "so in a monorepo it would stamp paths relative to the package instead of the repo and",
      "every edit would resolve to a file that does not exist.",
      "",
      `Run Editor against the repository root instead, or move ${repoPath} to its own checkout.`,
    ].join("\n"),
  )
}

/**
 * The attach-mode stamping gate: prove the user's own config stamps source,
 * write the stampers that config imports, and refuse the boot if it does not.
 *
 * Runs BEFORE anything expensive (the chdir, the chat-session sweep, the port
 * allocation, the proxy) for the same reason `AttachRequiredError` is thrown
 * early: a refusal a user is going to hit should cost them a second, not
 * thirty. Nothing downstream of it depends on ordering here — the preflight
 * only reads the config, and the stamper write only touches `.desde/`.
 *
 * The stampers are written on the refusal path TOO. The printed steps tell the
 * user to paste the block and restart their dev server, and that restart
 * happens before they re-run this CLI — so the imported file has to already be
 * on disk or the restart fails on an unresolvable import.
 *
 * Exported so its three outcomes can be tested without a running dev server;
 * `startCore`'s own success path needs one and belongs in the live harness.
 */
export async function runAttachStampingGate(opts: {
  /** Directory holding the host config file — where `.desde/stamp/` goes. */
  prototypeRoot: string
  /**
   * Whose config file to read and generate a block for.
   *
   * ONE parameter now, where there were two. `attachHostFor(host, metaFramework)`
   * existed to translate a boot-path tier (`vite-meta`) back into a framework
   * name; detection names the host id directly, so there is nothing left to
   * translate — the caller passes `attachConfigHostFor(detection)`.
   */
  host: AttachHost
  framework: StamperFramework
  /** Hostname the browser will use for the proxy; only Next consumes it. */
  proxyOrigin: string
}): Promise<AttachStampingSummary> {
  const result = await runStampingPreflight({
    prototypeRoot: opts.prototypeRoot,
    host: opts.host,
    framework: opts.framework,
    proxyOrigin: opts.proxyOrigin,
  })

  if (result.status === "no-config-file") {
    // Nothing to import our stamper from, so nothing is written: the files
    // would be dead weight in a repo we are about to refuse.
    throw new StampingRequiredError(formatStampingRefusal(result), result)
  }

  const files =
    opts.host === "next" ? nextLoaderFiles() : vitePluginFiles(opts.framework)
  // Attach mode's destination IS the prototype root: the generated config block
  // the user commits imports the stamper by a path relative to their config
  // file. The in-process Next host is the caller that picks a different one.
  const write = await writeStamperFiles({ destDir: opts.prototypeRoot, files })

  if (result.status === "needs-config") {
    // Carry the stamper WRITE warnings into the refusal, not just the
    // preflight's. This path tells the user to paste the block and restart
    // their dev server, and writeStamperFiles is where a reason that restart
    // might fail shows up — e.g. an external the generated plugin needs that
    // a pnpm/non-hoisted layout will not resolve from the prototype root.
    // Dropping them sends the user into a retry that cannot succeed, with the
    // explanation already computed and thrown away.
    throw new StampingRequiredError(
      formatStampingRefusal(result, write.warnings),
      result,
    )
  }

  return {
    status: result.status,
    configFile: result.configFileRelative,
    stamperFiles: write.written,
    rebuilt: write.rebuilt,
    // The preflight's own warnings describe a config wired the WRONG way (a
    // `*.tsx`-only Turbopack rule, an `NODE_ENV` gate) — both invisible until
    // either `.jsx` files refuse to edit or a production build ships source
    // paths. They belong next to the stamper write's own warnings.
    warnings: [...result.warnings, ...write.warnings],
  }
}

/**
 * Render a refusal: why, then the exact file, then the exact text.
 *
 * Exported so an embedder (IDE extension, launcher) shows the same words the
 * CLI does, and so a test can assert the block is present without spawning a
 * process.
 */
export function formatStampingRefusal(
  result: Extract<StampingPreflightResult, { status: "needs-config" | "no-config-file" }>,
  /**
   * Warnings from writing the stamper files. Surfaced HERE and not only on the
   * success path because this refusal's own instructions are "paste the block,
   * restart your dev server, run again" — and a stamper-write warning is
   * exactly the reason that retry might fail (e.g. an external the generated
   * plugin needs that a pnpm/non-hoisted layout cannot resolve from the
   * prototype root). Computing the explanation and then dropping it sends the
   * user into a loop they cannot get out of.
   */
  writeWarnings: readonly string[] = [],
): string {
  const warningBlock =
    writeWarnings.length === 0
      ? []
      : ["", "Also note:", ...writeWarnings.map((w) => `  - ${w}`)]
  if (result.status === "no-config-file") {
    return [
      "Attach mode needs a config file to add the source stamper to, and there is none.",
      "",
      result.message,
      "",
      "Looked for:",
      ...result.searched.map((p) => `  ${p}`),
      ...warningBlock,
    ].join("\n")
  }

  return [
    `Attach mode needs the source stamper in ${result.configFileRelative}, and it is not there.`,
    "",
    "Without it the prototype is inspect-only: it boots, elements are selectable, and every",
    "edit is refused. That is a failure you would otherwise only find by clicking something.",
    "",
    ...result.steps.map((step, i) => `  ${i + 1}. ${step}`),
    "",
    `── ${result.configFileRelative} ${"─".repeat(Math.max(3, 60 - result.configFileRelative.length))}`,
    result.block,
    "─".repeat(64),
    "",
    "Then run the same command again.",
    ...warningBlock,
  ].join("\n")
}

export interface ProjectAssociationStatus {
  /** Project slug from `.desde/config.json`, or null if absent/invalid. */
  projectSlug: string | null
  /**
   * Cloud project id from `.desde/config.json`, or null if the
   * repo isn't linked. Forwarded to the client bootstrap as
   * `window.__DESDE_CLI__.project.projectId` — the seam the
   * shell uses to resolve the shared cloud project (comments,
   * membership) when the user is signed in.
   */
  projectId: string | null
  /**
   * Embedded project identity from `.desde/config.json` (schema v2), or
   * null on an un-migrated repo. This is what the breadcrumb renders, so it
   * must survive being signed out, unlinked and offline — none of which the
   * cloud `projectId` above does.
   */
  identity: ProjectIdentity | null
  /** Platform base URL override from project config, or null. */
  platformBaseUrl: string | null
  /**
   * Phase 5 — chat quotas/cost ceiling from project config. Undefined
   * means "use orchestrator defaults". The HTTP server passes this
   * through as `chatQuotas` so the chat handler can hand it to
   * `runChatTurnSdk`.
   */
  chatQuotas?: {
    maxModelCallsPerTurn?: number
    maxToolCallsPerTurn?: number
    /** Raw config value — `undefined`/`null` resolved downstream by `resolveCostCeilingUsd`. */
    costCeilingUsd?: number | null
    /**
     * Phase 5 of tasks/editor-detached-sessions.md — UI-level
     * opt-out for the detached chat sessions picker + toasts. The
     * bootstrap script forwards this to the client.
     */
    detachedSessions?: boolean
  }
  /**
   * Audit Task 15 — on-disk retention tunables from `.desde/config.json`'s
   * `retention` block. `backups`/`bases` (read-snapshot) sweeps run at
   * boot (below) and after each Commit (`http-server.ts`); `chatSessionTurns`
   * is forwarded to the chat handler for `saveSession`'s turns cap.
   */
  retention?: {
    backups?: { keepNewest?: number; maxAgeDays?: number }
    chatSessionTurns?: { maxTurns?: number }
  }
  /**
   * Phase 3 — "Use repo conventions" config from project config. Undefined
   * means "conventions on, nothing excluded". The HTTP server passes this
   * through as `conventions` so the edit/chat handlers can decide whether
   * to ground the LLM in the repo's documented conventions.
   */
  conventions?: ProjectKnowledgeConfig
  /**
   * Editor runtime tunables from project config. Forwarded to the
   * client via the bootstrap script so the shell can read them off
   * `window.__DESDE_CLI__.editor`.
   */
  editor?: {
    reloadBackstop?: boolean
    /**
     * Canvas + screenshot-plan surface gate. DORMANT by product decision
     * 2026-08-04 (undertested; see CLAUDE.md § "Screenshot Capture").
     * Default false (opt-IN) — the inverse of `chatQuotas.detachedSessions`'
     * opt-out default. `EDITOR_CANVAS=1` also enables (either wins).
     */
    canvas?: boolean
  }
  /**
   * One-line warnings the CLI can surface to the user about why the
   * association is in a degraded state. Empty when fully wired.
   */
  warnings: string[]
}

export interface SmokeReport {
  bridgeTagPresent: boolean
  dataPtSrcPresent: boolean
  /** First problem encountered, or null if both checks passed. */
  problem: string | null
  /**
   * Per-MODULE stamping problems, already filtered against the host's declared
   * coverage gaps. Empty on a healthy boot.
   *
   * A SEPARATE field from `problem`, not a second way to set it. `problem` means
   * "this check is in trouble as a whole" and makes the CLI print a warning
   * instead of a pass; this means "the check passed AND these specific files are
   * not editable". Collapsing them would either hide that most of the app works
   * or hide that part of it does not. See `hosts/stamp-notices.ts`.
   */
  stampNotices: ModuleStampNotice[]
}

/**
 * Compose the runtime: resolve paths, build plugins, boot the Vite
 * supervisor with plugins injected, start the HTTP server with the
 * security context, run the smoke check.
 *
 * On smoke failure we still return the handle (with the problem
 * surfaced in `smokeReport.problem`) so the caller can decide whether
 * to keep the server running for diagnosis or shut down. The CLI entry
 * (`cli.ts`) treats a smoke failure as a clear error message + exit
 * non-zero.
 */
export async function startCore(opts: CoreOptions): Promise<CoreHandle> {
  const canonicalRoot = isAbsolute(opts.repoPath)
    ? opts.repoPath
    : resolvePath(process.cwd(), opts.repoPath)
  if (!existsSync(canonicalRoot)) {
    throw new Error(`Repo path not found: ${canonicalRoot}`)
  }

  const bridgeBundlePath =
    opts.bridgeBundlePath ?? resolveBridgeBundlePath()
  if (!existsSync(bridgeBundlePath)) {
    throw new Error(
      `Bridge bundle not found at ${bridgeBundlePath}. Build it with \`npm run build:bridge\` from the repo root or pass --bridge-bundle.`,
    )
  }

  const uiBundleRoot = opts.uiBundleRoot ?? resolveUiBundleRoot()
  if (!existsSync(uiBundleRoot)) {
    throw new Error(
      `Editor UI bundle not found at ${uiBundleRoot}. Build it with \`npm run build:ui\` in editor-cli/ first.`,
    )
  }

  // Framework gate runs against the CANONICAL root (it reads
  // package.json + node_modules there — branch mode has no separate
  // worktree to create, but the canonical root may sit above a
  // monorepo subdir prototype's `repoRoot`). This keeps the "Vue 2
  // isn't supported" message fast, before the rest of boot proceeds.
  // Detection observes; `resolveHost` decides. The `--force` escape hatch
  // (`skipFrameworkDetection`) exists for in-tree Vite fixtures, so it
  // synthesizes the evidence a plain Vite repo would have produced rather than
  // leaving the fields to defaults scattered down the function.
  const detection: HostDetection = opts.skipFrameworkDetection
    ? {
        candidates: [
          { hostId: "vite", confidence: "likely", because: ["framework detection was skipped"] },
        ],
        languages: ["vue-sfc"],
        framework: "vue3",
        warnings: [],
      }
    : await (async () => {
        const result = await detectFramework(canonicalRoot)
        if (!result.ok) throw new FrameworkUnsupportedError(result)
        return result
      })()
  const frameworkWarnings = detection.warnings
  // Selects which source-tag plugin + icon-set scan to use below.
  const framework = detection.framework

  // Attach mode. `--attach` wins wherever it is passed (a developer running
  // their own `vite dev` is welcome to it); without it, a host Editor cannot
  // boot — or has not been asked to boot — refuses here with the commands to
  // run, BEFORE any of the expensive boot work below.
  const attachUrl = opts.attachUrl ? parseAttachUrl(opts.attachUrl) : undefined
  // Resolved ONCE, here, and carried down to the boot branch. Two calls would
  // be pure (the function is), but two calls is also two places for the gate
  // and the boot to disagree about which host this repo is.
  //
  // Resolved on BOTH lanes, unlike before. An ambiguous repo — two frameworks
  // each with their own config file on disk — is ambiguous for attach mode too:
  // the stamping preflight below has to pick one config to read, and it would
  // pick with the same coin-flip the refusal exists to stop.
  const resolution = resolveHost(detection, { hostId: opts.host, attachUrl })
  if (!resolution.ok) {
    if (resolution.failure.code === "ambiguous-host") {
      throw new HostAmbiguousError(resolution.failure)
    }
    // The `unknown` downgrade, and the unbuilt-`--host` refusal. Both mean "no
    // in-process host will serve this", which is the message attach mode's
    // instructions already are.
    //
    // The override outranks detection here for the same reason it does in
    // `resolveHost`: if the user named a host, the message they get back must be
    // about the host they named, not about the one we would have picked.
    throw new AttachRequiredError(
      opts.host ?? detection.candidates[0]?.hostId ?? null,
      opts.repoPath,
    )
  }
  if (resolution.hostId !== "attach") {
    const enabledHosts = await loadEnabledHosts(canonicalRoot)
    for (const warning of enabledHosts.warnings) {
      console.warn(`[editor-cli] ${warning}`)
    }
    // A host can EXIST and still not be on. The two facts are separate on
    // purpose (see `enabled-hosts.ts`): a host lands in the registry when its
    // code exists and its live boot passed, and becomes the default for an
    // unconfigured repo only after the full product test. A repo that has not
    // opted in keeps exactly the shipped behaviour — this message, with its dev
    // command and its `--attach` line.
    if (!enabledHosts.enabled.has(resolution.hostId)) {
      throw new AttachRequiredError(resolution.hostId, opts.repoPath)
    }
  }

  // Prototype location within its git repo. Editor edits whole-repo
  // scaffolding, so when `canonicalRoot` is a SUBDIRECTORY of a larger
  // repo (a monorepo package, or Editor's own `editor-cli/self-host`
  // harness) `repoRoot` must be the git ROOT — that's where
  // `node_modules` + `.desde/` scaffolding work — while Vite is
  // rooted at `<repoRoot>/<subdirOffset>`. `sessionRoot` is the git
  // root; `subdirOffset` is "" for the common prototype-is-repo-root
  // case, in which everything below collapses to prior behavior. A
  // non-git path leaves sessionRoot=canonicalRoot, which surfaces as a
  // friendly "needs a git repository" error further down.
  let sessionRoot = canonicalRoot
  let subdirOffset = ""
  try {
    const loc = await resolvePrototypeLocation(canonicalRoot)
    sessionRoot = loc.gitRoot
    subdirOffset = loc.subdirOffset
  } catch {
    /* not a git repo / git unavailable */
  }

  // Styling system — selects which inline-style edit shape the shell builds for
  // React (Tailwind className splice vs inline style object). Best-effort, never
  // throws; defaults to "inline". Unused on the Vue path (scoped-css-override).
  //
  // The APP SUBDIR is authoritative — we deliberately do NOT inherit a
  // workspace/git-root Tailwind dependency. In a monorepo that dep may belong to
  // a sibling package; splicing utility classes into an app that doesn't compile
  // Tailwind would render nothing (the edit silently disappears after refresh).
  // A genuine Tailwind app always carries a LOCAL signal regardless of where the
  // dependency is hoisted — its own CSS entry imports Tailwind
  // (`@import "tailwindcss"` / `@tailwind`) or it ships a per-app config — and
  // `detectStylingSystem` scans both. When the app subdir shows no signal we
  // keep the always-correct inline default rather than guess from the root.
  const stylingSystem = await detectStylingSystem(canonicalRoot)

  // Substrate STYLE capabilities — neutral facts about how the prototype's own
  // CSS competes with the rules Editor writes. Today: does it compile its
  // utilities `!important` (Tailwind global important mode)? If so, the
  // inspector's ELEMENT style scope can't win the properties those utilities
  // declare, and the scope dialog deprioritises it instead of letting the user
  // loop on an edit that verification will keep reporting as `css-overridden`
  // (see tasks/editor-edit-verification.md § "Cascade oracle"). Same app-subdir
  // reasoning as `detectStylingSystem` above; never throws — an undetectable
  // substrate reports every capability false, i.e. today's behavior.
  const styleCapabilityDetection = await detectSubstrateStyleCapabilities(canonicalRoot)
  const styleCapabilities = styleCapabilityDetection.capabilities
  if (styleCapabilityDetection.note) {
    console.log(`  Substrate style capabilities: ${styleCapabilityDetection.note}`)
  }

  // Edit substrate: branch mode is the only substrate now
  // (tasks/branches-vs-worktree.md). Editor edits the user's current
  // working tree in place — no worktree, no session, no auto-commit — so
  // uncommitted state is shared with the user's IDE and boot skips `git
  // worktree add`. `isBranchMode()` always returns true; the variable is
  // kept because `RouteContext`/the bootstrap payload still carry it.
  const branchMode = isBranchMode()

  // Canonical-state preflight. Only an in-progress merge/rebase
  // (genuinely unsafe to edit over) refuses; dirty + detached are
  // legitimate states to edit in place. Runs against the git root, not
  // the prototype subdir.
  const preflight = await preflightCanonicalRoot(sessionRoot)
  if (!preflight.ok) {
    throw new Error(preflight.reason)
  }

  // No worktree session — Editor edits the git root of the real
  // checkout directly, and `repoRoot` is the canonical git root.
  // `data-desde-src` stays git-root-relative.
  const repoRoot = sessionRoot
  // The SAME root with symlinks resolved. Needed because Vite defaults to
  // `preserveSymlinks: false`, so for a checkout reached through a symlink its
  // module ids (`data-vite-dev-id`, which the bridge reports as a stylesheet's
  // `sourceHint`) can be anchored at the real path while `repoRoot` is the path
  // the user typed. The shell resolves a token's source file by prefix-matching
  // that hint against the root, and it has no filesystem access — so the realpath
  // happens here, once, and both roots go into the bootstrap for it to try.
  // Best-effort: on failure the shell simply falls back to `repoRoot` alone,
  // which is exactly the previous behavior.
  let repoRootReal: string | undefined
  try {
    const resolved = await fsRealpath(repoRoot)
    repoRootReal = resolved === repoRoot ? undefined : resolved
  } catch {
    repoRootReal = undefined
  }
  // Where a `scoped-css-override` rule goes on a substrate with no
  // `<style scoped>` block to carry it (React). Two of that ladder's four
  // rungs are filesystem questions the shell cannot ask — the configured
  // destination, and the file that already holds the managed block — so they
  // are answered here, once, and checked against the page's LOADED
  // stylesheets shell-side before either is used. A file on disk is not a
  // file the app imports, and only the second kind can carry a rule that
  // renders. See `src/editor/edit-service/detect-override-stylesheet.ts`.
  //
  // Walks the APP (bounded) but reports paths relative to the PROTOTYPE root,
  // because that is what `data-desde-src` and the edit handler are anchored at.
  // Never throws: an unreadable config or an unwalkable tree costs the ladder
  // a rung and falls through to document order.
  let overrideStylesheet: OverrideStylesheetFacts = {}
  try {
    overrideStylesheet = detectOverrideStylesheetFacts({
      appRoot: canonicalRoot,
      prototypeRoot: repoRoot,
      configRoot: canonicalRoot,
    })
  } catch {
    /* boot must not fail over an optional styling hint */
  }

  // Keep Editor scaffolding out of the user's `git status`. Best-
  // effort — failure is cosmetic (entries show as untracked).
  await ensureLocallyIgnored(sessionRoot, ".desde/")

  // Credentials must reach the environment BEFORE the HTTP server starts, so
  // the first chat turn or LLM lane sees them without a restart. Never throws:
  // the store degrades to typed defaults on any read failure.
  await applyLlmCredentialsAtBoot()
  // Same moment, same reason: `.mcp.json` carries `${VAR}` references the
  // loader resolves from `process.env`, so a saved extension key has to be
  // there before the first turn builds its server list.
  await applyExtensionSecretsAtBoot()

  console.log(
    `[editor-cli] branch mode: editing the current working tree in place at ${sessionRoot} (no worktree, no auto-commit)`,
  )

  // Where Vite roots + loads the prototype's vite.config. Branch mode
  // edits the user's working tree in place (no worktree) — for a
  // prototype that IS the repo root this equals `repoRoot`; for a
  // subdir prototype it's `<repoRoot>/<subdirOffset>`. The injected
  // plugins keep using `repoRoot`, so `data-desde-src` stamps stay
  // repo-root-relative — including shared files imported across the
  // prototype's `@`-alias boundary, which live above the subdir but
  // inside the same working tree.
  const prototypeViteRoot = subdirOffset
    ? resolvePath(repoRoot, subdirOffset)
    : repoRoot

  // ATTACH MODE — the stamping gate. Editor cannot inject a build plugin into a
  // config it never loads, so the stamper is the user's own config change; this
  // is where we prove it happened and write the file that change imports. It
  // REFUSES the boot when the config is not wired, because the alternative is a
  // prototype that looks healthy and refuses every edit.
  //
  // Placed here rather than beside `startAttachProxy` below: everything it
  // needs is already resolved (the prototype root, the framework, the host),
  // and everything after this line — the chdir, the stale-session sweep, port
  // allocation, the proxy — is work a refused boot should not pay for. The one
  // thing that must precede it is `ensureLocallyIgnored` above, which keeps the
  // `.desde/stamp/` files it writes out of the user's `git status`.
  //
  // `viteHost` is read straight from the options rather than from the bound
  // listener, and that is exact: Next compares `allowedDevOrigins` entries
  // against the origin's HOSTNAME with the port discarded, so the port the
  // proxy ends up on cannot change the generated block.
  let attachHandle: CoreHandle["attach"]
  if (attachUrl) {
    assertStampableLayout(subdirOffset, opts.repoPath)
    const stamping = await runAttachStampingGate({
      prototypeRoot: prototypeViteRoot,
      // The framework whose config file has to carry our stamper — read off
      // detection's own ranking now, instead of translated out of a boot-path
      // tier by the deleted `attachHostFor`.
      host: attachConfigHostFor(detection),
      framework,
      proxyOrigin: `http://${opts.viteHost ?? "localhost"}`,
    })
    console.log(
      `[editor-cli] attach mode: ${stamping.configFile} wires the source stamper; ` +
        `${stamping.rebuilt ? "wrote" : "verified"} ${stamping.stamperFiles.join(", ")}`,
    )
    for (const w of stamping.warnings) console.warn(`[editor-cli] ${w}`)
    attachHandle = { upstreamUrl: attachUrl, stamping }
  }

  // Make the PROCESS working directory the prototype's Vite root, not
  // wherever the CLI happened to be launched from.
  //
  // Setting Vite's `root` option is not enough. A `vite.config.ts` is ordinary
  // user code, and `process.cwd()` is the canonical idiom in it — Vite's own
  // docs use `loadEnv(mode, process.cwd())`. Any config that derives paths that
  // way (aliases, envDir, glob roots) resolved them against the DESDE
  // checkout instead, so a perfectly normal prototype failed to serve:
  //
  //     ENOENT: no such file or directory, open
  //       '<desde>/src/views/Authorization/Department/Department.vue'
  //
  // Found by the 2026-08-08 E2E against vue-element-plus-admin, whose config
  // line 19 is `const root = process.cwd()`.
  //
  // Safe in-process: tsx reads its tsconfig ONCE at loader init from the LAUNCH
  // cwd, so a later chdir is invisible to the CLI's own module resolution.
  // (An earlier report claimed the opposite; that came from `cd <prototype> &&
  // node bin/…`, which changes the launch cwd — a different thing.) Every child
  // process this CLI spawns already passes an explicit `cwd`.
  //
  // ORDER IS LOAD-BEARING: this must run before `tracerPlugins` is constructed
  // below, because the tracer's path base is computed at plugin-construction
  // time.
  // Everything launch-directory relative must already have captured it: the
  // chdir is permanent and process-global, and the breadcrumb "home" launcher
  // starts LAZILY IN THIS PROCESS long afterwards. `launch-cwd.ts` snapshots
  // it at module load for exactly that reason — see its docblock for what
  // broke (Home → Clone creating the clone inside the edited repo).
  process.chdir(prototypeViteRoot)

  // Phase 5 of tasks/editor-detached-sessions.md — restart-clear
  // for stale in-flight chat sessions. Sweeps the repo's
  // `.desde/chat-sessions/` for any records left as `in-flight`
  // by a prior CLI process that crashed mid-turn; rewrites those to
  // `status: 'cancelled', statusReason: 'restart-clear'`. A fresh repo
  // (the common case for a clean boot) has no chat-sessions dir yet
  // and returns zero scanned — the cleanup is a fast no-op.
  try {
    const { runRestartClear } = await import(
      "../../src/editor/agent-chat/restart-clear.js"
    )
    const result = await runRestartClear(repoRoot)
    if (result.cleared > 0) {
      console.log(
        `[editor-cli] restart-clear: marked ${result.cleared} stale in-flight chat session(s) as cancelled`,
      )
    }
    if (result.errors.length > 0) {
      console.warn(
        `[editor-cli] restart-clear: ${result.errors.length} file(s) skipped:`,
        result.errors,
      )
    }
  } catch (err) {
    // Restart-clear must never block CLI boot. Log and move on.
    console.warn(
      `[editor-cli] restart-clear failed (non-fatal): ${(err as Error).message}`,
    )
  }

  // Everything from here through smoke-check + session-info write is
  // wrapped: any throw needs to tear down whatever we managed to bring
  // up (branch mode has no worktree to discard — see the catch below —
  // but the Vite supervisor and HTTP server still need closing). The
  // supervisor and HTTP handles are torn down inside the catch in
  // dependency order (HTTP first because it references the
  // supervisor's URL).
  let prototypeServer: PrototypeServerHandle | null = null
  // The in-process run, when there is one. Attach mode leaves it null, and that
  // is the exact discriminator the stamp gate needs: it decides what zero
  // stamps MEAN, and the two lanes answer differently (see `stampVerifyFor`).
  let hostRun: HostRun | null = null
  let httpHandle: HttpServerHandle | null = null
  try {
  const shellHost = opts.shellHost ?? "127.0.0.1"
  // MEASURED (Next 16.3, no allowedDevOrigins configured at all): an internal
  // endpoint answers 200 to `Origin: http://localhost:9999` and 403 to
  // `Origin: http://127.0.0.1:9999`. Next's default allowlist is
  // ['**.localhost', 'localhost'], so binding the ATTACH proxy to localhost
  // removes the need for an allowedDevOrigins entry entirely — one fewer line
  // in the user's committed config, and one fewer thing that can be wrong.
  // Supervised mode keeps 127.0.0.1: it has no such guard to satisfy, and
  // changing it there would alter an origin users already have working.
  const viteHost = opts.viteHost ?? (attachUrl ? "localhost" : "127.0.0.1")
  // Port allocation. If the user-requested port is in use, fall back
  // to an OS-picked free port. This makes `desde` Just Work
  // when a second instance is already running, instead of failing
  // with EADDRINUSE. The user-requested port is still tried first so
  // bookmarks / IDE configurations referring to it survive when only
  // one instance is running.
  //
  // Pick BOTH ports together to avoid a collision when both fall back
  // to OS-picked: `pickPort(0)` twice in sequence can return the same
  // ephemeral port (each probe closes immediately, releasing the port
  // for the next probe). pickTwoPorts holds the first probe open until
  // the second is selected, guaranteeing distinct results (codex P2
  // round 2).
  const { port1: shellPort, port2: vitePort } = await pickTwoPorts(
    shellHost,
    opts.shellPort ?? 4321,
    viteHost,
    opts.vitePort ?? 5173,
  )

  const shellOrigin = `http://${shellHost}:${shellPort}`
  const security = newSecurityContext(shellOrigin)
  const bridgeVersion = readBridgeVersion(bridgeBundlePath)

  if (attachUrl) {
    // ATTACH MODE — the user owns the dev server; we own a proxy in front of
    // it. No Vite anywhere on our side, so none of the plugin wiring below
    // applies: the bridge is injected by the proxy into a response we did not
    // author, and `data-desde-src` comes from a stamper the user added to their
    // own config (Vite plugin) or `next.config` (Turbopack loader).
    prototypeServer = await startAttachProxy({
      upstreamUrl: attachUrl,
      host: viteHost,
      port: vitePort,
      bridgeBundlePath,
      html2canvasPath: resolveHtml2canvasPath(),
      shellOrigin,
    })
    console.log(`[editor-cli] attach mode: proxying ${attachUrl} at ${prototypeServer.url}`)
    // § 4 S11: a host that cannot narrow the dev server's own config must say so
    // at boot. Attach narrows nothing, and until now it was the one host that
    // stayed quiet about the widest gaps of any of them. The strings come from
    // `hosts/attach/host.ts`, which is also what `--doctor` renders, so the
    // session log and the report cannot disagree.
    for (const gap of ATTACH_SECURITY_GAPS) console.warn(`[host:attach] ${gap}`)
    console.warn(
      `[host:attach] ${attachUrl} is your own dev server. It stays reachable directly and serves ` +
        "pages with no bridge injected and none of the proxy's guards.",
    )
  } else {
  // IN-PROCESS BOOT — dispatched through the host registry rather than calling
  // one framework's boot function directly. Which host was decided at the
  // `AttachRequiredError` gate above, which is also where "this project opted
  // in" was checked; reaching here means both answered yes. Nuxt / Astro / Next
  // arrive as registry entries, not as branches here.
  hostRun = await runHost({
    hostId: resolution.hostId,
    repoRoot,
    // The REAL root travels with it. Vite defaults to `preserveSymlinks:
    // false`, so on a checkout reached through a symlink every module id the
    // stamper sees is anchored at the REAL path while `repoRoot` is the path
    // the user typed — macOS makes anything under `/tmp` exactly that
    // (`/tmp` → `/private/tmp`). Relativising against the typed root emitted
    // `../../private/tmp/…/App.vue` for every file in the repo, and
    // `resolve-editable-path.ts` refuses every one of those with "File path
    // escapes prototype root": a server that serves 200s and stamps garbage,
    // discovered mid-click.
    repoRootReal,
    prototypeRoot: prototypeViteRoot,
    framework,
    // MEASURED, not defaulted. `runHost` still falls back to a single language
    // derived from `framework`; detection now supplies the real set, which for
    // an Astro project is `["astro", <island dialect>]` — and that is what turns
    // "`.astro` files are inspect-only" from something the user discovers by
    // clicking into a line printed at boot.
    languages: detection.languages,
    frontDoor: { host: viteHost, port: vitePort },
    // For a host the pipeline has to front (React Router and every other
    // framework that binds its own listener), these are what the proxy serves
    // of its own and what rides on the injected `data-shell-origin`. The
    // `direct` Vite host never reads them — its bridge comes from
    // `bridgePlugin.transformIndexHtml` below.
    bridge: {
      bundlePath: bridgeBundlePath,
      html2canvasPath: resolveHtml2canvasPath(),
      shellOrigin,
    },
    // The pipeline owns the stamp policy, because its build-directory denials
    // come from the host — which is why the plugins that need the policy are
    // built here rather than passed in ready-made.
    plugins: (stampPolicy, hostFacts) => [
      // Order: source-tag first (`enforce: pre`), bridge after (`enforce: post`).
      // The plugin objects encode their own enforce directives; Vite respects
      // both regardless of array order, but listing pre before post here also
      // makes the intent legible to a future reader.
      // Framework-specific source-tag plugin: Vue SFCs vs JSX. Both stamp the
      // same `data-desde-src="file:line:col"` the bridge reads at inspect time.
      framework === "react"
        ? jsxSourceTagPlugin({ policy: stampPolicy })
        : sourceTagPlugin({ policy: stampPolicy }),
      // Off-the-shelf source-map attribution (antfu's vite-plugin-vue-tracer).
      // Injected by editor — the prototype needs no dependency and no
      // stamper of its own. Authoritative when present; `data-desde-src` (from
      // sourceTag above, or a prototype's own plugin) remains a fallback.
      // VUE-ONLY: the tracer is Vue-SFC-specific (antfu ships no React build);
      // a React app relies on the jsxSourceTagPlugin `data-desde-src` stamp.
      ...(framework === "react"
        ? []
        : tracerPlugins({ repoRoot, viteRoot: prototypeViteRoot })),
      // The composed plugin (serve the bundle + inject the `<script>` tags) on
      // the one host where `transformIndexHtml` fires, and the SERVING HALF
      // ALONE everywhere else. MEASURED: that hook fires zero times on Astro,
      // Nuxt and React Router, whose tags come from the proxy's streaming
      // injector instead — so the composed plugin there would name an injection
      // it never performs, and would double-inject the day a Vite release
      // changed that.
      hostFacts.bridgeTags === "vite-transform-index-html"
        ? bridgePlugin({
            bridgeBundlePath,
            shellOrigin,
            html2canvasPath: resolveHtml2canvasPath(),
          })
        : bridgeAssetsPlugin({
            bridgeBundlePath,
            html2canvasPath: resolveHtml2canvasPath(),
          }),
      // Imported from `./plugins/compose-isolation.js`, which owns the cast
      // between the root package's `Plugin` type and editor-cli's — two physical
      // Vite installs, currently a major apart. That wrapper exists so this file
      // names no Vite type at all (§ 4, S12); its header has the full reason.
      //
      // VUE-ONLY (same gate as the tracer plugin above): the isolation
      // page's mount script hardcodes `import { createApp, h } from 'vue'`
      // (vite-plugin-compose-isolation.ts) — it cannot mount a React
      // component. Phase 4 probing is scoped to Vue substrates for now;
      // React probing is future work (per the generalized-product rule,
      // that's a new mount-script variant behind the same adapter
      // boundary, not a hardcoded assumption baked in here) once the
      // plugin grows a React mount script.
      ...(framework === "react"
        ? []
        : [
            composeIsolationPlugin({
              cssImports: resolveProbeCssImports(prototypeViteRoot),
            }),
          ]),
    ],
  }).catch((err: unknown) => {
    // A probe refusal — "@react-router/dev is declared but not installed", a
    // moved private seam, an untested version under --strict-versions — is
    // exactly what the ladder renders: `attachCovers` is true for all of them,
    // so the user is one flag away from a working session and should be told
    // which flag, with their framework's own dev command. Without this it
    // surfaced as a bare "Failed to start editor" on exit 1.
    if (err instanceof HostBootError) {
      const decision = decide(opts.hostMode ?? "auto", err.failure, err.host)
      if (decision.action !== "run-in-process") throw new HostLadderError(decision)
    }
    throw err
  })
  prototypeServer = hostRun
  }

  // Project association bootstrap. Reads from `.desde/` which is
  // locally git-ignored and therefore not part of the git-tracked
  // prototype content — it has to use the canonical root (which may sit
  // above a monorepo subdir prototype's `repoRoot`) or it'll silently
  // fall into degraded mode (no projectSlug).
  const projectAssociation = await bootstrapProjectAssociation(canonicalRoot)

  // Audit Task 15 — best-effort retention sweep, fired non-blocking so a
  // slow or failing GC pass never delays "time to interactive" (same
  // `void (async () => {...})()` pattern the design-system reconciliation
  // block below uses). Runs against `repoRoot` (the git ROOT), NOT
  // `canonicalRoot` — codex review round 1 caught this: `.desde/`
  // (backups, chat-sessions) lives under `repoRoot` per the comment above
  // `sessionRoot`/`repoRoot`'s derivation (~line 304); in a monorepo
  // subdirectory or the editor-cli/self-host harness, `canonicalRoot`
  // is a DIFFERENT, deeper path and the sweep would silently ENOENT
  // against a directory that's never the one edits/backups/sessions
  // actually write to.
  void runRetentionGc(repoRoot, projectAssociation.retention).catch((err) => {
    console.warn(`[retention-gc] boot sweep failed: ${(err as Error).message}`)
  })

  // Load read-roots from `desde.config.json` in the
  // CANONICAL root (which may sit above a monorepo subdir prototype's
  // `repoRoot` — config travels with the user's repo, not the
  // subdir). External git repos declared here become readable to the
  // chat agent's git tools. A bad config fails session start outright;
  // a missing config is fine and just yields an empty registry.
  // (`worktreeRoot` below is the read-roots loader's own param name — a
  // historical holdover from the removed worktree-session substrate;
  // it's just "the root to resolve config from" now.)
  const readRootsResult = await loadReadRoots({ worktreeRoot: canonicalRoot })
  if (!readRootsResult.ok) {
    throw new Error(
      `desde.config.json invalid:\n  ${readRootsResult.errors.join("\n  ")}`,
    )
  }
  const readRoots = readRootsResult.registry
  const readRootsWarnings = readRootsResult.warnings
  // Live box the settings dialog swaps after a write, so a reference
  // directory added mid-session reaches the next chat turn. `readRoots`
  // above stays the boot-time snapshot for everything that only needs one.
  const readRootsHolder = { current: readRoots, warnings: readRootsWarnings }

  // Dormant edit lanes this prototype opted back in to — the `lanes` block of
  // the SAME config file, read once here so the offering (client bootstrap)
  // and the two dispatch surfaces (edit handler, repair lane) all get one
  // answer. Default is nothing enabled; see `server/enabled-lanes.ts` for why
  // detach and swap are dormant. Warn-and-ignore on a malformed block, like
  // `hosts`: an opt-in flag failing to turn something on must never fail a boot.
  const enabledLanesResult = await loadEnabledLanes(canonicalRoot)
  for (const warning of enabledLanesResult.warnings) {
    console.warn(`[editor-cli] ${warning}`)
  }
  const enabledLanes = enabledLanesResult.enabled
  if (enabledLanes.size > 0) {
    console.log(
      `[editor-cli] dormant edit lanes enabled by config: ${[...enabledLanes].join(", ")}`,
    )
  }

  // Icon-set registry: auto-detect installed icon packages from the
  // canonical root's package.json. Pass the detected framework so the
  // right icon sets surface (a Vue icon package never reaches a React
  // @heroicons/react) and don't cross-pollute. Enumeration + preview
  // rendering is lazy: the adapter doesn't touch disk or spawn
  // subprocesses until the inspector requests icons via
  // GET /api/editor/icon-sets.
  const iconSetRegistry = new InMemoryIconSetRegistry()
  try {
    const detectedSources = await autoDetectIconSets({
      prototypeRoot: canonicalRoot,
      framework,
    })
    for (const source of detectedSources) iconSetRegistry.register(source)
    if (detectedSources.length > 0) {
      console.log(
        `[editor-cli] auto-detected icon sets: ${detectedSources.map((s) => s.id).join(", ")}`,
      )
    }
  } catch (err) {
    console.warn(
      `[editor-cli] icon-set auto-detect failed (continuing without icon picker): ${(err as Error).message}`,
    )
  }

  // Phase 3 attach/refresh — mutable box the boot-time reconciliation pass
  // (kicked off below, AFTER the server is listening) writes into. Created
  // up front so it can be handed to `startHttpServer`; the design-systems GET
  // route reads `.current` per request.
  const reconciliationStatusHolder: ReconciliationStatusHolder = { current: null }
  // Phase 3 refresh — same pattern, warmed by the staleness pass chained
  // after reconciliation below. `GET …/updates` reads/writes `.current` as
  // its per-process TTL cache.
  const stalenessCacheHolder: StalenessCacheHolder = { current: null }

  httpHandle = await startHttpServer({
    host: shellHost,
    port: shellPort,
    repoRoot,
    repoRootReal,
    canonicalRoot,
    uiBundleRoot,
    html2canvasPath: resolveHtml2canvasPath(),
    viteUrl: prototypeServer.url,
    viteBase: prototypeServer.base,
    framework,
    stylingSystem,
    styleCapabilities,
    overrideStylesheet,
    // Deterministic post-write invalidation, so the dev server reflects an edit
    // without waiting on the OS watcher.
    //
    // Taken from the HOST, not from a Vite handle, because the number of dev
    // servers is a per-host fact. This was `prototypeServer.vite?.server`,
    // which `run.ts` sets to the FIRST captured server; on Nuxt that is the
    // client lane, so an edit hot-updated the client while the SSR lane went on
    // serving stale HTML with stale stamps — "the stamp moved but the edit did
    // nothing". `hmr.invalidate` is each host's own statement of how many lanes
    // it has, and the Nuxt one loops all of them.
    //
    // UNDEFINED IN ATTACH MODE, and that is the whole answer — not a stub. The
    // user's own dev server is already watching the files we write: MEASURED
    // end to end on Next (tasks/next-attach-mode-spike.md § "HMR works"), where
    // an edit hot-updated the running page with the `data-desde-src` stamp intact.
    // The invalidation exists because macOS fsevents can drop or delay OUR
    // watcher's event; we cannot replay an event into a watcher we don't own.
    invalidateFiles: hostRun?.boot.hmr.invalidate,
    security,
    mcp: {
      platformBaseUrl: projectAssociation.platformBaseUrl ?? undefined,
    },
    project: {
      projectId: projectAssociation.projectId,
      slug: projectAssociation.projectSlug ?? null,
      identity: projectAssociation.identity,
      platformBaseUrl: projectAssociation.platformBaseUrl,
    },
    chatQuotas: projectAssociation.chatQuotas,
    conventions: projectAssociation.conventions,
    editor: projectAssociation.editor,
    retention: projectAssociation.retention,
    readRoots,
    readRootsHolder,
    enabledLanes,
    branchMode,
    launcherForwardArgs: opts.launcherForwardArgs,
    iconSetRegistry,
    reconciliationStatusHolder,
    stalenessCacheHolder,
  })

  // Boot-time reconciliation of declared design systems (Phase 3 attach/
  // refresh). Kicked off AFTER the HTTP server is up, `void`-wrapped and
  // non-blocking — the whole point is a fresh clone with a `designSystems`
  // block boots usably immediately and gets grounded shortly after, not that
  // grounding gates the session. Unlike `loadReadRoots` above (a bad config
  // fails session start outright — read-roots feed the chat agent's git
  // tools and a silently-empty registry there is a worse failure mode than
  // a loud one), a malformed `designSystems` block only logs and skips:
  // this block is optional config a typo shouldn't be able to kill the
  // session over, and the GET route's `declared` flag still surfaces the
  // discrepancy to the user.
  void (async () => {
    const declResult = await loadDesignSystemDeclarations(canonicalRoot)
    if (!declResult.ok) {
      console.error(
        `[design-systems] declarations invalid, skipping boot reconciliation:\n  ${declResult.errors.join("\n  ")}`,
      )
    } else if (declResult.declarations.length > 0) {
      const onboardDeps = await createDefaultOnboardDeps(canonicalRoot)
      const status = await reconcileDesignSystems({
        prototypeRoot: canonicalRoot,
        declarations: declResult.declarations,
        deps: {
          listRegistry: () => createLocalRegistryStore(canonicalRoot).list(),
          onboard: async (req) => {
            const result = await onboardDesignSystem(req, onboardDeps)
            // Each successful onboard changes what manifest serving should
            // emit — drop the memoized grounding service so the next
            // manifest/catalog GET rebuilds against the updated registry.
            // Same invalidation the design-systems DELETE/POST routes trigger.
            resetGroundingCache()
            return result
          },
          onStatusChange: (s) => {
            reconciliationStatusHolder.current = s
          },
        },
      })
      reconciliationStatusHolder.current = status
      for (const entry of status.entries) {
        if (entry.state === "done") {
          console.log(`[design-systems] reconciled '${entry.label}' → registered (${entry.registryEntryId})`)
        } else if (entry.state === "failed") {
          console.error(`[design-systems] reconciliation failed for '${entry.label}': ${entry.reason}`)
        } else if (entry.state === "skipped") {
          console.log(`[design-systems] '${entry.label}' already registered: skipped`)
        }
      }
    }

    // Phase 3 refresh — warm the staleness cache once at boot, chained AFTER
    // reconciliation (so a freshly-reconciled entry is included) but never
    // gated on it: this runs for EVERY registered entry, declared or not,
    // and a malformed/empty `designSystems` block above must not skip it.
    // Non-blocking, never fails boot — same posture as reconciliation itself.
    try {
      const registry = await createLocalRegistryStore(canonicalRoot).list()
      const results: Record<string, StalenessResult> = {}
      await Promise.all(
        registry.map(async (entry) => {
          results[entry.id] = await checkDesignSystemStaleness(entry)
        }),
      )
      stalenessCacheHolder.current = { at: Date.now(), results }
    } catch (err) {
      console.error(`[design-systems] boot staleness check failed (non-fatal): ${(err as Error).message}`)
    }
  })().catch((err) => {
    console.error(`[design-systems] boot reconciliation crashed unexpectedly: ${(err as Error).message}`)
  })

  // Boot verification. ONE probe of the served output produces BOTH the gate's
  // verdict and the smoke line the CLI prints — see `runSmokeCheck` for why
  // these are one pass and not two overlapping checks.
  const verification = await verifyStamping(stampVerifyFor(prototypeServer, hostRun))
  const smokeReport = runSmokeCheck(
    verification,
    hostRun === null,
    hostRun?.boot.stampExpectation ?? null,
    // Read AFTER `verifyStamping`, never before: its module-graph walk is what
    // compiles the prototype's own source, and therefore what gives the
    // stampers a chance to declare anything at all. Reading first would return
    // an empty ledger on every boot and look exactly like a clean run.
    readModuleStampNotices(),
    hostRun?.coverage ?? null,
  )

  // Bound as a const so the gate's `close` callback sees a non-null handle
  // without an assertion — the `let` above is reassigned on the refusal path.
  const bootedHost = hostRun
  if (bootedHost !== null) {
    const gate = await applyStampGate({
      evidence: verification.evidence,
      mode: opts.hostMode ?? "auto",
      skipVerify: opts.skipStampVerify ?? false,
      host: bootedHost.host,
      close: () => bootedHost.close(),
    })
    if (gate.kind === "refuse") {
      // Already closed by the gate. Null it so the catch below does not close a
      // second time, and so the error that surfaces is the ladder's rendered
      // message rather than a teardown error stacked on top of it.
      prototypeServer = null
      hostRun = null
      throw new HostLadderError(gate.decision)
    }
    if (gate.warning) console.warn(`[editor-cli] ${gate.warning}`)
  }

  // Publish the session-info file so the `desde-mcp`
  // stdio proxy can locate this editor-cli. Best-effort: a failed
  // write is logged but doesn't fail boot (user can still drive the
  // editor via the browser UI, just not via the local `claude` CLI).
  try {
    writeSessionInfo({
      url: httpHandle.url,
      token: security.token,
      pid: process.pid,
      // Session-info advertises the canonical project root to external
      // tools (MCP proxy, IDE integrations) rather than `repoRoot` —
      // for a monorepo subdir prototype those differ, and consumers
      // reason about projects by their canonical root.
      repoRoot: canonicalRoot,
      mcpToolsAvailable: [...MCP_PROXY_TOOL_NAMES],
      bridgeVersion,
      writtenAt: new Date().toISOString(),
    })
    registerSessionInfoCleanup()
  } catch (err) {
    console.error(
      `[editor-cli] failed to write session-info file (MCP proxy auto-discovery will not work): ${(err as Error).message}`,
    )
  }

  // Record this checkout in the per-user project registry (recents +
  // "switch project" launcher source). Best-effort: a failed write
  // only costs a recents-list entry, never boot. Keyed by canonical
  // root (not `repoRoot`) so a monorepo subdir prototype's registry
  // entry points at the checkout the user actually opened.
  try {
    await upsertProjectRegistryEntry({
      path: canonicalRoot,
      projectId: projectAssociation.projectId ?? undefined,
      slug: projectAssociation.projectSlug ?? undefined,
      lastPort: shellPort,
      lastUrl: httpHandle.url,
    })
  } catch (err) {
    console.error(
      `[editor-cli] failed to update project registry (recents list may be stale): ${(err as Error).message}`,
    )
  }

  // Capture in narrowed const bindings so the close() callback's
  // closure can see them as non-null without per-call assertions. The
  // catch below guarantees we only reach here when both are assigned.
  const finalPrototypeServer = prototypeServer
  const finalHttpHandle = httpHandle

  return {
    shellUrl: finalHttpHandle.url,
    viteUrl: finalPrototypeServer.url,
    ...(attachHandle ? { attach: attachHandle } : {}),
    bridgeVersion,
    smokeReport,
    projectAssociation,
    frameworkWarnings,
    readRoots,
    readRootsWarnings,
    close: async () => {
      removeSessionInfo()
      await Promise.allSettled([finalHttpHandle.close(), finalPrototypeServer.close()])
      // Branch mode has no worktree to tear down — edits are already in
      // the user's real checkout. In attach mode the UPSTREAM dev server is
      // the user's process and is deliberately left running: we never started
      // it, so we do not get to stop it.
    },
  }
  } catch (err) {
    // Startup failed somewhere between the plugin/supervisor (or proxy) boot
    // and the session-info write. Tear down everything we managed to bring
    // up. Branch mode has no worktree to discard.
    if (httpHandle) await httpHandle.close().catch(() => undefined)
    if (prototypeServer) await prototypeServer.close().catch(() => undefined)
    throw err
  }
}

/**
 * Read `.desde/config.json`. Never throws — every failure path is
 * surfaced as a warning entry on the returned status.
 */
async function bootstrapProjectAssociation(
  repoRoot: string,
): Promise<ProjectAssociationStatus> {
  const warnings: string[] = []
  let projectSlug: string | null = null
  let projectId: string | null = null
  let identity: ProjectIdentity | null = null
  let platformBaseUrl: string | null = null
  let chatQuotas: ProjectAssociationStatus["chatQuotas"]
  let conventions: ProjectAssociationStatus["conventions"]
  let editor: ProjectAssociationStatus["editor"]
  let retention: ProjectAssociationStatus["retention"]

  const configResult = await readProjectConfig(repoRoot)
  if (configResult.ok) {
    projectSlug = configResult.config.projectSlug ?? null
    projectId = configResult.config.projectId ?? null
    identity = configResult.config.project ?? null
    platformBaseUrl = configResult.config.platformBaseUrl ?? null
    chatQuotas = configResult.config.chat
    conventions = configResult.config.conventions
    editor = configResult.config.editor
    retention = configResult.config.retention
  } else if (configResult.reason !== "missing") {
    // Malformed / unsupported version / missing-required: real errors
    // worth surfacing. "missing" is expected (user hasn't set up
    // association yet) — that warning lives in the project-config
    // module and would be noisy duplicated here.
    warnings.push(configResult.message)
  } else {
    // Soft-touch reminder so the user knows degraded mode is active.
    warnings.push(
      "No `.desde/config.json` in the repo. Running without project association. /mcp/status will report ahead_of_deployment as 'unknown'. Add the file to wire deployment lookup.",
    )
  }

  return {
    projectSlug,
    projectId,
    identity,
    platformBaseUrl,
    chatQuotas,
    conventions,
    editor,
    retention,
    warnings,
  }
}

/**
 * Build the verification request for whichever lane booted.
 *
 * The two lanes differ in exactly one thing that matters — **what zero stamps
 * MEANS** — and this is where that is decided:
 *
 * - **In-process:** the host computed its own `stampExpectation` from its
 *   resolved config, and supplies `moduleGraphEvidence()`. Its answer is
 *   authoritative and may reach the conclusive `unstamped` verdict.
 * - **Attach:** `post-hydration`, which by the § 6 teardown conjunction can
 *   NEVER conclude. Deliberate: the authoritative gate for "is the stamper
 *   wired into the user's own config" is the stamping preflight, which runs
 *   BEFORE boot and refuses with exit 5. A second, weaker gate here — one that
 *   could tear down a dev server we did not start, on evidence that is blind to
 *   a client-rendered app — would be strictly worse than the one we already
 *   have. It still WARNS, which is exactly what it did before this change.
 *
 * **The stamper seam rides along, and it is the whole reason this is exported.**
 * `verifyStamping` accepts `stamperSeam` for exactly the failure it can produce
 * — healthy server, zero stamps — and this function is the only place with a
 * booted host to read it from. MEASURED before it was passed: the rendered
 * refusal for a swallowed-write Next run named no seam at all, so the sentence
 * "Attach mode does not use this seam" pointed at nothing, and the paragraph
 * that says a private seam means "nothing is wrong with your project" never
 * fired. Attach mode passes none, and must not: it has no in-process seam, and
 * that branch can never reach the failure anyway.
 */
export function stampVerifyFor(
  handle: PrototypeServerHandle,
  hostRun: HostRun | null,
): Parameters<typeof verifyStamping>[0] {
  if (hostRun === null) {
    // The attach lane. Both values come from `hosts/attach/host.ts` rather than
    // being written here a second time: `attach` is a host now, and what zero
    // stamps mean for it is one of the facts a host declares. `post-hydration`
    // is the value that makes zero stamps `indeterminate` rather than
    // `unstamped` — the `unstamped` verdict tears the server down and tells the
    // user to switch to attach mode, and they are already in it.
    return {
      url: handle.url,
      stampExpectation: ATTACH_STAMP_EXPECTATION,
      hostDisplayName: ATTACH_DISPLAY_NAME,
    }
  }
  return {
    url: handle.url,
    stampExpectation: hostRun.boot.stampExpectation,
    probeRoutes: hostRun.boot.probeRoutes,
    moduleGraphEvidence: hostRun.boot.moduleGraphEvidence?.bind(hostRun.boot),
    stamperSeam: hostRun.stamperSeam,
    hostDisplayName: hostRun.host.displayName,
  }
}

/**
 * Project one {@link StampVerification} onto the boot-log smoke report.
 *
 * **Relationship to `verifyStamping` — stated, because two overlapping checks
 * with no stated relationship is how they drift.** This is no longer an
 * independent probe. It used to fetch `/` itself and walk the module graph
 * itself; `verifyStamping` now does both, once, and this function only
 * *renders* what that pass found. There is exactly one HTTP request and one
 * module-graph walk per boot, and the gate's verdict and the printed line
 * cannot disagree by construction.
 *
 * What survived from the old implementation is the WORDING — the attach-vs-
 * supervised phrasing below is the shipped text, because it is good advice and
 * because the CLI prints it verbatim. What did not survive is the second
 * source of truth.
 *
 * Caveat, unchanged: this is markup-level only. A strict CSP that blocks inline
 * scripts would let the bridge tag REACH the HTML but stop it EXECUTING, and
 * this would falsely pass. Real-handshake validation needs a browser harness.
 *
 * **The second caveat, closed 2026-08-11.** Every branch below is EXISTENTIAL
 * over modules: `evidence.verdict === "stamped"` means at least one module
 * carried a stamp, so a project where one file refuses and another succeeds
 * reported `problem: null`. `stampNotices` is the per-module half, and it is
 * carried alongside rather than folded into `problem` — see `SmokeReport`.
 *
 * Exported only so a test can drive the composition; nothing else calls it.
 */
export function runSmokeCheck(
  verification: StampVerification,
  attached: boolean,
  expectation: StampExpectation | null,
  notices: readonly ModuleStampNotice[],
  coverage: StampingCoverage | null,
): SmokeReport {
  const { evidence, bridgeTagPresent, probes } = verification
  const dataPtSrcPresent = evidence.verdict === "stamped"
  const root = probes[0]
  const prototypeUrl = root ? root.url.replace(/\/$/, "") : ""

  // Computed ONCE and carried on every branch below, including the failing
  // ones. A per-module refusal is orthogonal to whether the whole check
  // passed: a host can be unreachable AND have refused a file, and dropping
  // the second fact because the first is louder is how the two-facts-one-screen
  // contradiction got here in the first place.
  const stampNotices = visibleStampNotices(notices, coverage)
  const report = (problem: string | null): SmokeReport => ({
    bridgeTagPresent,
    dataPtSrcPresent,
    problem,
    stampNotices,
  })

  // Transport failure first: a server we could not reach explains every other
  // observation, and reporting a missing bridge tag on top of it would send the
  // reader after the wrong cause.
  if (root && root.error !== null) {
    return report(
      attached
        ? `Prototype unreachable through the proxy at ${prototypeUrl}/: ${root.error}. Is the dev server you attached to still running?`
        : `Vite served HTML unreachable at ${prototypeUrl}/: ${root.error}`,
    )
  }

  if (!bridgeTagPresent) {
    return report(
      attached
        ? `Bridge <script> tag not found in the HTML served through the proxy at ${prototypeUrl}/. The upstream response may not be text/html, or its </head> and </body> may both be absent.`
        : 'Bridge <script> tag not found in served HTML. A user `transformIndexHtml` hook may have stripped it. See docs/_archive/composer-runtime-architecture.md#vite-instrumentation.',
    )
  }

  if (dataPtSrcPresent) return report(null)

  if (expectation === "partial") {
    // A host that stamps only PART of its source needs its own sentence, and
    // this branch exists because the supervised one below is actively wrong
    // here: on Astro nothing is being skipped and the repo is full of
    // user-authored components — they are `.astro` files, which have no
    // stamper. Printing "the source-tag plugin is being skipped" would
    // contradict, two lines later, the coverage gap the host just declared
    // correctly. Keyed on the EXPECTATION rather than on a host id, so it is a
    // property of the stamping situation and not a special case.
    return report(
      `No data-desde-src in the HTML served at ${prototypeUrl}/. On this host that is the expected state for a page with no framework island: the page's own markup has no stamper, so it is inspect-only. If this page DOES render a .tsx/.jsx/.vue component and you still see this, the stamper is not running.`,
    )
  }

  if (attached) {
    return report(
      `No data-desde-src in the HTML served at ${prototypeUrl}/. If this app renders on the server, the source-tag stamper is not wired into your dev config and every edit will be refused. If it renders on the client, stamps appear only after hydration and this check cannot see them. Inspect an element to confirm.`,
    )
  }

  return report(
    "data-desde-src not found in any compiled source module (.vue/.tsx/.jsx). Either the source-tag plugin is being skipped, or this repo has no user-authored components yet. PropEdits will fail at the adapter.",
  )
}

/**
 * Pick two ports in a way that avoids the OS-picked collision: hold
 * the first probe socket OPEN while picking the second so the OS
 * can't reassign port1's number to port2. Both probes are closed
 * before returning; the small race between close and consumer-bind
 * is documented and accepted (the supervisor's own error surfaces if
 * it loses).
 *
 * Single-port `pickPort` would be simpler but a fallback-twice
 * scenario can return the same ephemeral port from the OS — fixed in
 * codex P2 round 2.
 */
async function pickTwoPorts(
  host1: string,
  requested1: number,
  host2: string,
  requested2: number,
): Promise<{ port1: number; port2: number }> {
  // Hold port 1's probe open. Use `bindHold` (returns the listening
  // server, doesn't close it) so the OS can't immediately reassign.
  let probe1: HeldProbe
  try {
    probe1 = await bindHold(host1, requested1)
  } catch {
    probe1 = await bindHold(host1, 0)
  }

  let probe2: HeldProbe | null = null
  try {
    try {
      probe2 = await bindHold(host2, requested2)
    } catch {
      probe2 = await bindHold(host2, 0)
    }
    // Both probes now hold distinct ports. Capture the numbers and
    // close (consumers will bind on these immediately after we
    // return).
    const port1 = probe1.port
    const port2 = probe2.port
    return { port1, port2 }
  } finally {
    await Promise.allSettled([
      closeServer(probe2),
      closeServer(probe1),
    ])
  }
}

interface HeldProbe {
  port: number
  server: ReturnType<typeof createNetServer>
}

function bindHold(host: string, port: number): Promise<HeldProbe> {
  return new Promise<HeldProbe>((resolve, reject) => {
    const probe = createNetServer()
    probe.unref()
    probe.once("error", (err) => {
      probe.close()
      reject(err)
    })
    probe.listen(port, host, () => {
      const addr = probe.address()
      const actual = typeof addr === "object" && addr ? addr.port : 0
      resolve({ port: actual, server: probe })
    })
  })
}

function closeServer(probe: HeldProbe | null): Promise<void> {
  if (!probe) return Promise.resolve()
  return new Promise<void>((resolve) => {
    probe.server.close(() => resolve())
  })
}

function resolveBridgeBundlePath(): string {
  // Delegates to payload-paths.ts: env-override (`EDITOR_PAYLOAD_ROOT`) in a
  // packaged app, else the checkout walk-up to <repo>/dist/bridge-bundle.js.
  // See that module's doc comment for why this can no longer be a local
  // walk-up — bundling this file to editor-cli/dist/cli.js collapses
  // import.meta.url to the bundle's own URL.
  return resolvePayloadBridgeBundlePath()
}

function resolveHtml2canvasPath(): string {
  // Served by bridgePlugin so the bridge's CAPTURE_ELEMENT_SCREENSHOT handler
  // can load it. Delegates to payload-paths.ts — see resolveBridgeBundlePath
  // above for why.
  return resolvePayloadHtml2canvasPath()
}
