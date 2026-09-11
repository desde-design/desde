import { describe, expect, it } from "vitest"
import { isLikelyBridgedNamespace, isLikelyContainerized } from "./container-detect"

/** A bridged container's own listing: only its loopback and its one veth-backed `eth0`. */
const BRIDGED_NET_DEV =
  "Inter-|   Receive                                                |  Transmit\n" +
  " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n" +
  "    lo:    1296      16    0    0    0     0          0         0     1296      16    0    0    0     0       0          0\n" +
  "  eth0:    5000      50    0    0    0     0          0         0     5000      50    0    0    0     0       0          0\n"

/** The header lines alone, with no interfaces at all — for building a listing by hand below. */
const NET_DEV_HEADER =
  "Inter-|   Receive                                                |  Transmit\n" +
  " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n"

/** One interface's data line, in the shape `/proc/net/dev` actually prints. */
function netDevLine(name: string): string {
  return `${name.padStart(6)}:    648       8    0    0    0     0          0         0      648       8    0    0    0     0       0          0\n`
}

describe("isLikelyContainerized", () => {
  it("is true when /.dockerenv exists", () => {
    const fileExists = (p: string) => p === "/.dockerenv"
    expect(isLikelyContainerized(fileExists)).toBe(true)
  })

  it("is true when /run/.containerenv exists (Podman)", () => {
    const fileExists = (p: string) => p === "/run/.containerenv"
    expect(isLikelyContainerized(fileExists)).toBe(true)
  })

  it("is true when both markers exist", () => {
    const fileExists = () => true
    expect(isLikelyContainerized(fileExists)).toBe(true)
  })

  it("is false when neither marker exists", () => {
    const fileExists = () => false
    expect(isLikelyContainerized(fileExists)).toBe(false)
  })

  it("checks no other path than the two markers", () => {
    const checked: string[] = []
    const fileExists = (p: string) => {
      checked.push(p)
      return false
    }
    isLikelyContainerized(fileExists)
    expect(checked).toEqual(["/.dockerenv", "/run/.containerenv"])
  })

  it("defaults to the real filesystem when no fileExists is injected", () => {
    // Just proves it runs without throwing and returns a boolean — this
    // process is not running in a container, so the real answer is false,
    // but the point of this test is the default wiring, not the verdict.
    expect(typeof isLikelyContainerized()).toBe("boolean")
  })
})

/**
 * Codex round 10, Fix 2. Replaces `isLikelyHostNetworking` — see this
 * function's own doc comment in `container-detect.ts` for why the question
 * had to invert: a negative check ("not one of Docker's host-side names")
 * read Podman's `podman0`/`cni-podman0`/physical-NIC listings as "not host
 * networking" and widened the bind on a namespace that was never bridged.
 */
describe("isLikelyBridgedNamespace", () => {
  it("is true for lo + eth0 (MEASURED, Task 2, desde-viewer-srv)", () => {
    expect(isLikelyBridgedNamespace(() => BRIDGED_NET_DEV)).toBe(true)
  })

  it("is true for lo + eth0 + eth1 (a multi-network Compose container)", () => {
    const listing = NET_DEV_HEADER + netDevLine("lo") + netDevLine("eth0") + netDevLine("eth1")
    expect(isLikelyBridgedNamespace(() => listing)).toBe(true)
  })

  it("is false for lo + eth0 + docker0 (host networking alongside a bridge)", () => {
    const listing = BRIDGED_NET_DEV + netDevLine("docker0")
    expect(isLikelyBridgedNamespace(() => listing)).toBe(false)
  })

  it("is false for lo + podman0 (Podman's own bridge name, unrecognised)", () => {
    const listing = NET_DEV_HEADER + netDevLine("lo") + netDevLine("podman0")
    expect(isLikelyBridgedNamespace(() => listing)).toBe(false)
  })

  it("is false for lo + cni-podman0 + eth0 (a mixed, unrecognised listing)", () => {
    const listing = NET_DEV_HEADER + netDevLine("lo") + netDevLine("cni-podman0") + netDevLine("eth0")
    expect(isLikelyBridgedNamespace(() => listing)).toBe(false)
  })

  it("is false for lo + enp0s3 (a physical NIC — --network host under Podman/systemd-nspawn naming)", () => {
    const listing = NET_DEV_HEADER + netDevLine("lo") + netDevLine("enp0s3")
    expect(isLikelyBridgedNamespace(() => listing)).toBe(false)
  })

  it("is false when the reader throws (no /proc/net/dev, e.g. not Linux)", () => {
    expect(
      isLikelyBridgedNamespace(() => {
        throw new Error("ENOENT")
      }),
    ).toBe(false)
  })

  it("is false for lo alone (no other interface to call bridged)", () => {
    const listing = NET_DEV_HEADER + netDevLine("lo")
    expect(isLikelyBridgedNamespace(() => listing)).toBe(false)
  })

  it("defaults to the real filesystem when no reader is injected", () => {
    // Same point as isLikelyContainerized's own default-wiring test: proves
    // it runs without throwing and returns a boolean.
    expect(typeof isLikelyBridgedNamespace()).toBe("boolean")
  })
})
