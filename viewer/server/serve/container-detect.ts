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
import { existsSync, readFileSync } from "node:fs"

export function isLikelyContainerized(fileExists: (path: string) => boolean = existsSync): boolean {
  return fileExists("/.dockerenv") || fileExists("/run/.containerenv")
}

/**
 * Best-effort detection of "this container shares the host's network
 * namespace" — `docker run --network host`. Used by `config.ts`, under
 * `VIEWER_LOOPBACK_BIND=auto`, to decide whether an already-detected
 * container still needs its loopback listeners to bind every interface.
 *
 * A container's `/proc/net/dev` lists every interface visible INSIDE its own
 * network namespace. With Docker's default bridged networking that is only
 * the container's own loopback (`lo`) and its one veth-backed interface
 * (usually named `eth0`) — the bridge itself (`docker0`) and the other side
 * of the veth pair (`br-...`, or a bare `veth...` name) live on the DOCKER
 * HOST's namespace, not the container's. So seeing one of those three names
 * from inside means there is no separate namespace at all: the container is
 * sharing the host's, which is exactly what `--network host` does.
 *
 * `readNetDev` is injectable so this is unit-testable without touching the
 * real filesystem; it defaults to reading `/proc/net/dev` with `readFileSync`.
 * Any read error (the file does not exist, e.g. not Linux) reads as false —
 * the safe direction, since a container that was already detected keeps
 * widening its bind either way, and this function only ever NARROWS that.
 *
 * MEASURED (Task 2, `desde-viewer-srv`, bridged): only `lo` and `eth0`.
 * INFERRED, not measured: the host-network listing. This Docker Desktop
 * cannot run `--network host` without changing its settings, so the
 * `docker0`/`br-`/`veth` markers above are read off Docker's own networking
 * documentation, not off a live container. See the codex-r6 report.
 */
export function isLikelyHostNetworking(
  readNetDev: (path: string) => string = (path) => readFileSync(path, "utf8"),
): boolean {
  let contents: string
  try {
    contents = readNetDev("/proc/net/dev")
  } catch {
    return false
  }
  return /^\s*(docker0|br-[^:\s]*|veth[^:\s]*):/m.test(contents)
}
