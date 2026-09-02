/**
 * Types for the attach-mode stamping preflight.
 *
 * Attach mode does not own the dev server, so it cannot inject a build plugin
 * into a config it never loads — the **user** adds the stamper to their own
 * config. That makes stamping an onboarding step, and an onboarding step that
 * is silently skipped is the worst failure mode this product has: a prototype
 * that boots without `data-desde-src` stamps is inspect-only and refuses every
 * edit, which the user only discovers after clicking something.
 *
 * So the preflight is loud and exact: it reads the config the user actually
 * has, decides whether our stamper is already referenced, and — when it is not
 * — hands back the literal text to paste and the file to paste it into.
 */
import type { HostId } from '../hosts/types.js'

/**
 * The thing whose config we have to modify. Not the same axis as the
 * framework: Nuxt hosts Vue, React Router and Next host React, and Astro hosts
 * whatever its islands are written in.
 *
 * - `next` — no Vite seam at all; a `turbopack.rules` loader plus
 *   `allowedDevOrigins`.
 * - `nuxt` / `astro` — Vite underneath, but the Vite config is a nested
 *   `vite.plugins` array inside the framework's own config.
 * - `react-router` — a real root `vite.config.*` with a plugins array.
 * - `vite` — a plain Vite app the user runs themselves (same shape as
 *   `react-router`).
 *
 * DERIVED from {@link HostId} rather than restated, so the five framework names
 * have ONE enumeration in the codebase. `attach` is excluded and that exclusion
 * is the whole content of this type: this axis names the framework whose CONFIG
 * FILE has to be edited, and "attach" is not a framework with a config file — it
 * is the mode in which we are reading someone else's.
 */
export type AttachHost = Exclude<HostId, 'attach'>

/** Which stamper the host needs. Selects the plugin file and its export. */
export type StamperFramework = 'vue3' | 'react'

export interface StampingPreflightRequest {
  /** Absolute path to the prototype repo root. */
  prototypeRoot: string
  host: AttachHost
  framework: StamperFramework
  /**
   * Origin the browser will load the prototype from — the attach proxy's, not
   * the upstream dev server's. Only consumed by the Next block, which needs the
   * hostname for `allowedDevOrigins`. Accepts a full origin
   * (`http://127.0.0.1:7411`), a host:port, or a bare hostname; the port is
   * stripped either way because Next compares hostnames only.
   */
  proxyOrigin?: string
}

/**
 * A file the CLI must have written into the prototype's `.desde/` before
 * the generated block can resolve. The preflight does not write them — it
 * declares them, so the CLI can (a) write them and (b) tell the user what to
 * commit if they commit the config change.
 *
 * v1 distribution is deliberately internal: no npm package exists (editor-cli
 * has no plugin build entry point), so the block imports a bundle the CLI
 * drops next to the prototype. The path is stable, which is the whole
 * requirement.
 */
export interface RequiredStamperFile {
  /** Path relative to the prototype root, POSIX separators. */
  path: string
  moduleFormat: 'esm' | 'cjs'
  /** What the file has to contain. */
  role: 'vite-plugin' | 'webpack-loader' | 'type-declaration'
  stamper: StamperFramework
  /**
   * The contract the generated block depends on. Stated in prose because the
   * bundler that produces these files lives outside this module.
   */
  contract: string
}

interface PreflightBase {
  host: AttachHost
  framework: StamperFramework
  /** Absolute path of the config file this result is about. */
  configFile: string
  /** Same path, relative to `prototypeRoot` — what to show a user. */
  configFileRelative: string
}

/**
 * The config already references our stamper. `warnings` is not decoration:
 * a Next config wired with only a `*.tsx` rule, or gated on `NODE_ENV` instead
 * of the build phase, is wired *wrongly* in a way that is invisible until
 * either `.jsx` files refuse to edit or a production build ships source paths
 * to end users. Both were measured.
 */
export interface AlreadyWiredResult extends PreflightBase {
  status: 'already-wired'
  /** The literal substring that matched. */
  marker: string
  warnings: string[]
}

export interface NeedsConfigResult extends PreflightBase {
  status: 'needs-config'
  /** False when we are generating a whole file rather than an edit. */
  configFileExists: boolean
  /** The exact text to paste (or to write, when the file does not exist). */
  block: string
  /** Ordered, human-readable instructions to go with the block. */
  steps: string[]
  requiredStamperFiles: RequiredStamperFile[]
}

/**
 * We know the host but there is no config file to modify and generating one
 * would be a guess. Only reachable for the `react-router` / `vite` hosts: a
 * root `vite.config` without the framework's own plugin is not a config we can
 * synthesize, and its absence means the project is not the shape we detected.
 */
export interface NoConfigFileResult {
  status: 'no-config-file'
  host: AttachHost
  framework: StamperFramework
  /** Absolute paths we looked for, in order. */
  searched: string[]
  message: string
}

export type StampingPreflightResult = AlreadyWiredResult | NeedsConfigResult | NoConfigFileResult
