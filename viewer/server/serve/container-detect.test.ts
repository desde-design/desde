import { describe, expect, it } from "vitest"
import { isLikelyContainerized, isLikelyHostNetworking } from "./container-detect"

/** A bridged container's own listing: only its loopback and its one veth-backed `eth0`. */
const BRIDGED_NET_DEV =
  "Inter-|   Receive                                                |  Transmit\n" +
  " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n" +
  "    lo:    1296      16    0    0    0     0          0         0     1296      16    0    0    0     0       0          0\n" +
  "  eth0:    5000      50    0    0    0     0          0         0     5000      50    0    0    0     0       0          0\n"

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

describe("isLikelyHostNetworking", () => {
  it("is false for a bridged container's own listing (only lo and eth0)", () => {
    expect(isLikelyHostNetworking(() => BRIDGED_NET_DEV)).toBe(false)
  })

  it("is true when docker0 is listed", () => {
    const listing = BRIDGED_NET_DEV + "docker0:    648       8    0    0    0     0          0         0      648       8    0    0    0     0       0          0\n"
    expect(isLikelyHostNetworking(() => listing)).toBe(true)
  })

  it("is true when a br- interface is listed", () => {
    const listing = BRIDGED_NET_DEV + "br-1a2b3c4d5e6f:    648       8    0    0    0     0          0         0      648       8    0    0    0     0       0          0\n"
    expect(isLikelyHostNetworking(() => listing)).toBe(true)
  })

  it("is true when a veth interface is listed", () => {
    const listing = BRIDGED_NET_DEV + "veth1234abcd:    648       8    0    0    0     0          0         0      648       8    0    0    0     0       0          0\n"
    expect(isLikelyHostNetworking(() => listing)).toBe(true)
  })

  it("is false when the reader throws (no /proc/net/dev, e.g. not Linux)", () => {
    expect(
      isLikelyHostNetworking(() => {
        throw new Error("ENOENT")
      }),
    ).toBe(false)
  })

  it("defaults to the real filesystem when no reader is injected", () => {
    // Same point as isLikelyContainerized's own default-wiring test: proves
    // it runs without throwing and returns a boolean.
    expect(typeof isLikelyHostNetworking()).toBe("boolean")
  })
})
