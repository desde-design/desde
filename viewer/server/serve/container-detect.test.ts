import { describe, expect, it } from "vitest"
import { isLikelyContainerized } from "./container-detect"

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
