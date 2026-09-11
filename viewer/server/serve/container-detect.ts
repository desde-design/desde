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
 * Best-effort detection of "this container is on Docker's ordinary bridged
 * networking" — the layout `config.ts` needs before it widens a loopback
 * listener's bind to every interface. Used under `VIEWER_LOOPBACK_BIND=auto`
 * to decide whether an already-detected container still needs that wide
 * bind.
 *
 * ## Why this asks a POSITIVE question, not a negative one
 *
 * Codex round 6 asked the opposite question — `isLikelyHostNetworking`, true
 * only when `/proc/net/dev` listed one of Docker's own host-side names
 * (`docker0`, `br-*`, `veth*`). Everything that did not match read as "not
 * host networking", which under `auto` meant "widen the bind" — a default
 * that trusted an UNRECOGNISED listing the same as a genuinely bridged one.
 * `podman run --network host` breaks that: Podman's own interfaces are named
 * `podman0`, `cni-podman0`, or the host's physical NICs (`enp0s3`, `wlan0`)
 * — none of Docker's three names — so the round-6 check called it "not host
 * networking" and widened the bind on a namespace that was never bridged at
 * all, facing the predictable container port range at the LAN with no `-p`
 * boundary in the way.
 *
 * This function asks the other direction instead: true only on POSITIVE
 * evidence of Docker's bridged shape, so an unrecognised runtime reads as
 * false — the safe direction, since `auto` then leaves the bind on the
 * container's own loopback rather than widening it on a guess. A container
 * whose layout this function does not recognise still gets a real answer:
 * `VIEWER_LOOPBACK_BIND=all` widens it by explicit operator choice instead.
 *
 * ## What counts as bridged
 *
 * A container's `/proc/net/dev` lists every interface visible INSIDE its own
 * network namespace. True only when that listing is `lo` plus at least one
 * OTHER interface, every one of those other interfaces matches `^eth\d+$`
 * (Docker's own veth-backed naming), and none of them is one of the known
 * HOST-side names (`docker0`, `br-*`, `veth*`, `podman*`, `cni*`, `virbr*`) —
 * the second check is belt-and-braces over the first, since none of those
 * names matches `^eth\d+$` to begin with, but stating it separately is what
 * keeps a future relaxation of the `eth` pattern from silently admitting one
 * of them. A multi-network Compose setup (`eth0` AND `eth1`, both
 * veth-backed) reads as bridged too — correctly: that container has no
 * single external interface a wide bind would even need to distinguish, so
 * treating it the same as the one-interface case is right, not a gap.
 *
 * The one case this function cannot tell apart from "unrecognised": a
 * multi-network Compose container that ALSO happens to be `eth0` and `eth1`
 * with nothing else, which is exactly the bridged shape — there is nothing
 * to disambiguate here, and there does not need to be; either way the
 * container is bridged, and `VIEWER_LOOPBACK_BIND=all` remains the explicit
 * escape hatch for any layout an operator still needs to force.
 *
 * `readNetDev` is injectable so this is unit-testable without touching the
 * real filesystem; it defaults to reading `/proc/net/dev` with `readFileSync`.
 * Any read error (the file does not exist, e.g. not Linux) reads as false,
 * for the same "unrecognised widens nothing" reason as an unmatched listing.
 *
 * MEASURED (Task 2, `desde-viewer-srv`, bridged): only `lo` and `eth0`. Every
 * other listing above — the podman names, a physical NIC, a multi-`eth`
 * Compose setup — is INFERRED from Docker's and Podman's own networking
 * documentation, not measured against a live container. See the codex-r6 and
 * codex-r10 reports.
 */
/**
 * The kernel's fallback tunnel devices, created in every namespace once the
 * module is loaded on the host; never evidence of anything. Only those:
 * `dummy`, `bond`, `ifb` and the like are host-namespace devices, and
 * ignoring them would read a host-network container on a bonded host as
 * bridged (final review, N2).
 */
const KERNEL_PSEUDO_DEVICE = /^(tunl|gre|gretap|erspan|ip_vti|ip6_vti|sit|ip6tnl|ip6gre)\d+$/

export function isLikelyBridgedNamespace(
  readNetDev: (path: string) => string = (path) => readFileSync(path, "utf8"),
): boolean {
  let contents: string
  try {
    contents = readNetDev("/proc/net/dev")
  } catch {
    return false
  }
  const interfaceNames = [...contents.matchAll(/^\s*([^:\s]+):/gm)].map((match) => match[1])
  // The kernel creates fallback tunnel devices (`tunl0`, `gre0`, `sit0`,
  // `ip6tnl0` and their siblings) in every network namespace once the
  // matching module is loaded on the host. They say nothing about how the
  // namespace is attached, and a real Docker Desktop container lists nine of
  // them beside `lo` and `eth0` (MEASURED, live run 2026-09-11; `os
  // .networkInterfaces()` shows only `lo` and `eth0` because they carry no
  // address). Ignored here for the same reason `lo` is.
  const nonLoopback = interfaceNames.filter((name) => name !== "lo" && !KERNEL_PSEUDO_DEVICE.test(name))
  if (nonLoopback.length === 0) return false
  const hostSideName = /^(docker0|br-|veth|podman|cni|virbr)/
  return nonLoopback.every((name) => /^eth\d+$/.test(name) && !hostSideName.test(name))
}
