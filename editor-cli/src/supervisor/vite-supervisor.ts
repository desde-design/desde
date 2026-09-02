import {
  createServer,
  defaultAllowedOrigins,
  loadConfigFromFile,
  mergeConfig,
  type InlineConfig,
  type Plugin,
  type ViteDevServer,
} from "vite"
import { resolve } from "node:path"
import { existsSync } from "node:fs"
import { hardenPlugin } from "./harden-plugin.js"

export interface SupervisorOptions {
  /** Absolute path to the user's repo root. */
  repoRoot: string
  /**
   * Directory Vite roots at + loads the user's `vite.config` from.
   * Defaults to `repoRoot`. Differs only when the prototype is a
   * **subdirectory** of the git repo (a monorepo package, or Editor's
   * self-host harness): the session worktree — and therefore `repoRoot`
   * — is the repo root, but the prototype's `index.html` + `vite.config`
   * live at `<repoRoot>/<subdir>`. The injected plugins still use
   * `repoRoot`, so `data-desde-src` stamps stay repo-root-relative and edits
   * resolve back into the worktree (including shared files reached across
   * a `@`-alias boundary, which live above the prototype subdir).
   */
  prototypeRoot?: string
  /** Plugins to inject into the user's Vite pipeline (bridge + source-tag). */
  plugins: Plugin[]
  /** Host to bind. Defaults to 127.0.0.1. */
  host?: string
  /** Port to bind. Defaults to 5173. */
  port?: number
}

/**
 * What `bootSupervisor` hands back: a listening Vite dev server, plus the two
 * facts its one caller needs about how it was configured.
 *
 * **Standalone, and no longer an extension of `PrototypeServerHandle`.** It was
 * one until the leak-plugging milestone, which is how a `ViteDevServer` came to
 * be reachable from the handle every downstream consumer holds. The direction
 * was backwards: this is a low-level Vite boot primitive, and the public handle
 * is something the `vite` HOST derives from it (`hosts/vite/host.ts`) alongside
 * the transport, the HMR lanes and the security report. Nothing outside
 * `hosts/vite/` and the supervisor's own tests sees this type.
 *
 * `url` is origin-only (`http://host:port`); `base` is the resolved Vite
 * `base` (e.g. `/` or `/app/`) and always ends with `/`.
 */
export interface SupervisorHandle {
  url: string
  base: string
  close(): Promise<void>
  vite: { server: ViteDevServer }
  /**
   * What `hardenServerConfig` had to take back from the repo's own config, so
   * a caller can report it as a fact about this boot instead of scraping the
   * console warning below. Additive: the warning remains the single reporter.
   */
  hardening: ServerHardeningReport
}

/**
 * Vite's own default `server.fs.deny`, restated here because we have to
 * carry it ourselves.
 *
 * Vite resolves `server.fs` with `mergeWithDefaults`, where a
 * user-supplied ARRAY *replaces* the default rather than extending it —
 * so the moment anyone (the repo, or us) sets `deny`, Vite's defaults are
 * gone unless the new list restates them. Losing `.env` / `*.{crt,pem}` /
 * `**\/.git/**` while adding `.desde` would be a net regression.
 */
const VITE_DEFAULT_FS_DENY = [".env", ".env.*", "*.{crt,pem}", "**/.git/**"] as const

/**
 * Editor's own private state directory, denied from HTTP serving (audit
 * S15). `.desde/` sits INSIDE the Vite root and holds the agent chat
 * transcripts, the per-edit source backup journal, the manifest cache and
 * the design-system registry — none of which the prototype imports, all of
 * which quote the developer's source and anything they pasted into chat.
 * Without this, a default-config boot serves
 * `GET /.desde/chat-sessions/<id>.json` with a 200.
 *
 * Both spellings are load-bearing. Vite expands a pattern with NO slash to
 * `**\/<pattern>`, so bare `.desde` matches the directory itself; a
 * pattern that already contains a slash is used verbatim against the
 * ABSOLUTE file path, so `.desde/**` would never match
 * `/Users/…/repo/.desde/chat-sessions/x.json` and only the
 * `**`-anchored spelling covers the files inside.
 */
const EDITOR_PRIVATE_FS_DENY = [".desde", "**/.desde/**"] as const

export interface ServerHardeningReport {
  /**
   * Dotted `server.*` keys the repo's own `vite.config` set that we
   * narrowed back down. Logged at boot — a developer whose config was
   * overridden should be told, not silently ignored.
   */
  overridden: string[]
}

/**
 * Force the security-relevant `server.*` keys AFTER the merge (audit S14 +
 * S15 — they are one fix, each inert without the other).
 *
 * `mergeConfig(userConfig, injected)` makes the REPO's config the base, and
 * its merge rules are shape-dependent in ways that make pre-merge pinning
 * unreliable for exactly these keys. MEASURED against the installed Vite:
 * `server.allowedHosts` has a dedicated rule where `true` on EITHER side
 * wins outright, so a pre-merge `[]` is simply discarded; elsewhere arrays
 * union and objects merge recursively. Hardening post-merge is one place,
 * one rule, and independent of what shape the repo happened to use.
 *
 * What each key buys, and why the repo must not be able to widen it:
 *  - `cors` — `cors: true` emits `Access-Control-Allow-Origin: *` on every
 *    response, so ANY page the developer visits can read `/src/*.js` (the
 *    private repo's source) cross-origin. Pinned to Vite's own default:
 *    localhost origins only, which is what the Editor shell is.
 *  - `allowedHosts` — `allowedHosts: true` makes Vite skip host validation
 *    entirely, so a DNS-rebound `http://evil.test:5173` becomes SAME-ORIGIN
 *    with the dev server and CORS stops mattering at all. Pinned to `[]`;
 *    IP-literal and `*.localhost` hosts are still allowed by Vite itself,
 *    so binding `--host` to a LAN address keeps working.
 *  - `fs.strict` — `strict: false` makes `isFileLoadingAllowed` return true
 *    BEFORE it consults either `fs.allow` or `fs.deny`, which serves
 *    `/.env` and `/@fs$HOME/.desde/editor-session.json` — the latter
 *    holding the live per-boot bearer for `:4321`. Pinned to `true`, which
 *    is also what makes the `fs.deny` entry above mean anything.
 *
 * Deliberately NOT pinned: `fs.allow`. Widening the allow LIST is the
 * supported escape hatch for a prototype that legitimately imports from a
 * sibling directory (the tracer plugin already uses that pattern), and it
 * grants reach without disabling the deny-glob.
 *
 * The one legitimate workflow this costs is tunnelling the dev server
 * (ngrok / Codespaces), whose standard fix is `allowedHosts: true`. Editor
 * is a localhost authoring tool whose edit API already refuses any request
 * whose Origin isn't the shell's, so a tunnelled prototype was never a
 * working configuration end-to-end — narrowing here loses nothing real.
 *
 * Mutates `merged` in place and returns what it had to take away.
 */
export function hardenServerConfig(
  merged: InlineConfig,
  userConfig: InlineConfig | null,
): ServerHardeningReport {
  const userServer = userConfig?.server
  const overridden: string[] = []

  const mergedServer = merged.server ?? {}
  const mergedFs = mergedServer.fs ?? {}

  if (userServer?.cors !== undefined) overridden.push("server.cors")

  // An explicit empty array is already our value — don't cry wolf over it.
  const userHosts = userServer?.allowedHosts
  if (userHosts !== undefined && !(Array.isArray(userHosts) && userHosts.length === 0)) {
    overridden.push("server.allowedHosts")
  }

  if (userServer?.fs?.strict === false) overridden.push("server.fs.strict")

  // `deny` is only ever WIDENED (union), never narrowed, so it is not an
  // override the developer needs to hear about.
  const mergedDeny = Array.isArray(mergedFs.deny) ? mergedFs.deny : []

  merged.server = {
    ...mergedServer,
    cors: { origin: defaultAllowedOrigins },
    allowedHosts: [],
    fs: {
      ...mergedFs,
      strict: true,
      deny: [...new Set([...VITE_DEFAULT_FS_DENY, ...EDITOR_PRIVATE_FS_DENY, ...mergedDeny])],
    },
  }

  return { overridden }
}

/**
 * Boots a Vite dev server against the user's repo using Vite's JS API
 * (`createServer`), not by spawning the `vite` CLI binary. Going through
 * the JS API is the reason we can inject our plugins programmatically —
 * the CLI binary has no plugin hook.
 *
 * Wrapper-config approach (per
 * [docs/_archive/composer-runtime-architecture.md](../../../docs/_archive/composer-runtime-architecture.md#vite-instrumentation)):
 *
 * 1. Locate the user's `vite.config.{ts,js,mjs}` if present.
 * 2. Load it via `loadConfigFromFile` so it executes in its own scope
 *    (defineConfig, function form, conditional configs all work).
 * 3. Merge our injected plugins ONTO the user's config (their plugins
 *    keep precedence on conflicts; our `transformIndexHtml` runs after).
 * 4. Pass the merged config to `createServer`.
 *
 * Smoke-test responsibility lives outside this module — the orchestrator
 * (core.ts) fetches `/` after `server.listen()` resolves and verifies
 * the bridge tag + at least one `data-desde-src` are present.
 */
export async function bootSupervisor(opts: SupervisorOptions): Promise<SupervisorHandle> {
  const { repoRoot, prototypeRoot = repoRoot, plugins, host = "127.0.0.1", port = 5173 } = opts

  // Root Vite + load the user's vite.config from the PROTOTYPE root, which
  // is `repoRoot` for a normal single-package repo and `<repoRoot>/<subdir>`
  // when the prototype is a package inside a larger repo.
  const userConfig = await loadUserConfig(prototypeRoot)

  // Don't clobber user `root` if they set one explicitly (some projects
  // use `root: 'app'` to point Vite at a subfolder of the repo). Only
  // default to the prototype root when the user config doesn't specify root.
  const userHasRoot = !!(userConfig && typeof userConfig.root === "string")

  const injected: InlineConfig = {
    ...(userHasRoot ? {} : { root: prototypeRoot }),
    configFile: false, // We've already loaded + merged it; don't re-load.
    server: {
      host,
      port,
      strictPort: true,
      // Editor's own bookkeeping (audit Task 14's backup journal, chat
      // sessions, manifest cache) writes under `.desde/` inside the
      // repo — keep it out of Vite's watched set so a backup write never
      // triggers an HMR reload/full-reload for a file the prototype never
      // imports. `mergeConfig` concatenates array values, so a user config
      // that also sets `server.watch.ignored` keeps both entries.
      //
      // This is the WATCHER half only. Keeping `.desde/` out of HTTP
      // SERVING is `hardenServerConfig`'s `fs.deny` (audit S15) — the two
      // are unrelated mechanisms and the watcher one grants no protection.
      watch: { ignored: ["**/.desde/**"] },
    },
    // `hardenPlugin` re-applies the security pins from INSIDE Vite's plugin
    // pipeline. `hardenServerConfig` below pins them on this InlineConfig,
    // which every plugin hook then runs after — so a repo plugin's own
    // `configResolved` could undo all of them (MEASURED: `.env` and
    // `.desde/**` both served 200, `Host: evil.test` accepted). The two
    // are additive and idempotent, so the pre-merge call stays as the single
    // reporter and this is pure defence in depth.
    plugins: [...plugins, hardenPlugin()],
    clearScreen: false,
  }

  const merged: InlineConfig = userConfig
    ? mergeConfig(userConfig, injected)
    : injected

  // Security keys are forced AFTER the merge — see `hardenServerConfig`.
  const { overridden } = hardenServerConfig(merged, userConfig)
  if (overridden.length > 0) {
    console.warn(
      `[supervisor] Narrowed ${overridden.join(", ")} from this repo's vite.config. ` +
        "Editor pins these so the dev server can't be turned into cross-origin " +
        "read access to your filesystem. To widen filesystem reach legitimately, " +
        "add to server.fs.allow instead.",
    )
  }

  const server = await createServer(merged)
  await server.listen()

  const resolvedUrl = `http://${host}:${port}`

  return {
    url: resolvedUrl,
    // Vite resolves `base` to always have a leading+trailing slash.
    base: server.config.base,
    // Nested under `vite` for what it is worth as a label; the containment is
    // now structural rather than conventional. This type is no longer the
    // handle anything downstream holds — `hosts/vite/host.ts` is the ONLY
    // consumer, and what it hands on is the Vite-free `PrototypeServerHandle`.
    vite: { server },
    hardening: { overridden },
    close: async () => {
      await server.close()
    },
  }
}

async function loadUserConfig(repoRoot: string): Promise<InlineConfig | null> {
  // Vite's full default config filename set. `.cjs` and `.mts/.cts` are
  // valid in addition to `.ts/.js/.mjs`. Pre-filtering for existence is
  // an optimization to avoid `loadConfigFromFile`'s warn-on-not-found,
  // not a correctness boundary — keep this list in sync with Vite's own
  // defaults.
  const candidates = [
    "vite.config.ts",
    "vite.config.mts",
    "vite.config.cts",
    "vite.config.js",
    "vite.config.mjs",
    "vite.config.cjs",
  ]
  const present = candidates.find((c) => existsSync(resolve(repoRoot, c)))
  if (!present) return null

  // The 'serve' command + 'development' mode are right for a dev-server
  // boot. If the user's config branches on these (`if (mode === 'production')`
  // skip path), we want the dev branch.
  const result = await loadConfigFromFile(
    { command: "serve", mode: "development" },
    resolve(repoRoot, present),
    repoRoot,
  )
  return result?.config ?? null
}
