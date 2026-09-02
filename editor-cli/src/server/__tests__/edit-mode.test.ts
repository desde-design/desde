/**
 * Edit-substrate mode resolution. Worktree-session mode was removed
 * (tasks/worktree-mode-decommission.md) — branch mode is the only substrate,
 * so isBranchMode() is always true and the retired opt-out flags are ignored.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { isBranchMode } from "../edit-mode"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("isBranchMode", () => {
  it("is always true with no flags", () => {
    expect(isBranchMode({})).toBe(true)
  })

  it("ignores the retired worktree opt-out flags (still true) and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(isBranchMode({ EDITOR_WORKTREE_MODE: "1" })).toBe(true)
    expect(isBranchMode({ EDITOR_WORKTREE_MODE: "true" })).toBe(true)
    expect(isBranchMode({ EDITOR_BRANCH_MODE: "0" })).toBe(true)
    expect(isBranchMode({ EDITOR_BRANCH_MODE: "false" })).toBe(true)
    expect(warn).toHaveBeenCalled()
  })

  it("does not warn when no retired flag is set", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(isBranchMode({ EDITOR_BRANCH_MODE: "1" })).toBe(true)
    expect(isBranchMode({ EDITOR_WORKTREE_MODE: "" })).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })
})
