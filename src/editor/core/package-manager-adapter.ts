/**
 * Adapter seam for managing the project's package dependencies in a
 * substrate-neutral way. The `manage_package` MCP tool delegates to an
 * instance of this interface so manifest mutation + install commands
 * are owned by the substrate adapter, not the tool.
 *
 * Day-one impl: `src/editor/adapters/node-npm/package-manager-adapter.ts`
 * for Node/npm (auto-detects pnpm / yarn from lockfile). The interface
 * is generic enough to plug Python/pip-style or cargo-style impls
 * behind later.
 */

import type { VerificationRunResult } from './verification-adapter'

/**
 * Manifest-mutation op the adapter knows how to translate into a
 * package.json edit. Pure / deterministic — no I/O at this layer.
 */
export type PackageOp =
  | { kind: 'add'; packageName: string; versionSpec?: string; dev?: boolean }
  | { kind: 'remove'; packageName: string }

/**
 * Result of {@link PackageManagerAdapter.applyManifestOp}. The string
 * `newSrc` is the byte-stable new package.json (JSON-formatted with
 * the original file's indentation preserved when feasible). Errors
 * are returned, not thrown.
 */
export type ApplyManifestOpResult =
  | { ok: true; newSrc: string }
  | { ok: false; reason: string }

export interface PackageManagerAdapter {
  /** Substrate label surfaced to the agent (e.g. `"npm"`). */
  readonly substrateLabel: string

  /**
   * Apply the mutation to the package.json source string. Pure —
   * no fs / no subprocess. Returns the new source bytes; the caller
   * decides whether to write them.
   *
   * Refuses if `op` would yield a no-op (e.g. add a dep that already
   * exists at the same version-spec) so the carrier never emits an
   * "identical content" overwrite.
   */
  applyManifestOp(manifestSrc: string, op: PackageOp): ApplyManifestOpResult

  /**
   * Run the package manager's install command. Used after the
   * manifest has been written to disk so node_modules + lockfile
   * catch up. Always returns a {@link VerificationRunResult}; never
   * throws.
   */
  install(opts?: { signal?: AbortSignal }): Promise<VerificationRunResult>
}
