import { describe, expect, it } from "vitest"
import { shouldPromptMoveToApplications } from "../first-launch.js"

describe("shouldPromptMoveToApplications", () => {
  it("prompts when packaged, on mac, and not already in Applications", () => {
    expect(shouldPromptMoveToApplications("darwin", true, false)).toBe(true)
  })

  it("does not prompt in dev (not packaged), even on mac and not in Applications", () => {
    expect(shouldPromptMoveToApplications("darwin", false, false)).toBe(false)
  })

  it("does not prompt on non-mac platforms, even when packaged", () => {
    expect(shouldPromptMoveToApplications("win32", true, false)).toBe(false)
    expect(shouldPromptMoveToApplications("linux", true, false)).toBe(false)
  })

  it("does not prompt when already in Applications", () => {
    expect(shouldPromptMoveToApplications("darwin", true, true)).toBe(false)
  })
})
