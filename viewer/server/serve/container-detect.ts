/**
 * Best-effort detection of "this process is probably running inside a
 * container." Used by `config.ts` to pick a default for
 * `ViewerConfig.loopbackAvailable` when `VIEWER_LOOPBACK_LISTENERS=auto`
 * (the default): a loopback prototype listener binds an address INSIDE the
 * container's own network namespace, which a browser on the host cannot
 * reach through the one published port, so a container should not try to
 * open one unless the operator says otherwise.
 *
 * This is a heuristic, not a proof. It checks for exactly two markers:
 *
 * - `/.dockerenv` — written by the Docker runtime.
 * - `/run/.containerenv` — written by Podman.
 *
 * Deliberately does NOT read `/proc/1/cgroup`. That file is noisy (it
 * matches unrelated substrings on plenty of non-container hosts) and
 * reading it does not close the gap this heuristic already has — a
 * container runtime that writes neither marker still goes undetected
 * either way. `VIEWER_LOOPBACK_LISTENERS=on`/`=off` is the documented
 * override for exactly that gap, not a bigger heuristic.
 *
 * `fileExists` is injectable so this is unit-testable without touching the
 * real filesystem; it defaults to `node:fs`'s `existsSync`.
 */
import { existsSync } from "node:fs"

export function isLikelyContainerized(fileExists: (path: string) => boolean = existsSync): boolean {
  return fileExists("/.dockerenv") || fileExists("/run/.containerenv")
}
