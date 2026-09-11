import { describe, expect, it } from "vitest"
import { shouldRefreshAfterRebuild } from "../review/rebuild-refresh"

describe("shouldRefreshAfterRebuild", () => {
  it("does not refresh on mount, even though the crashed prototype's latest deployment is already 'deployed'", () => {
    expect(
      shouldRefreshAfterRebuild({ requested: false, sawBuilding: false, status: "deployed" }),
    ).toBe(false)
  })

  it("refreshes once a REQUESTED rebuild was seen building and has now deployed", () => {
    expect(
      shouldRefreshAfterRebuild({ requested: true, sawBuilding: true, status: "deployed" }),
    ).toBe(true)
  })

  it("does not refresh if requested but the build was never observed building", () => {
    expect(
      shouldRefreshAfterRebuild({ requested: true, sawBuilding: false, status: "deployed" }),
    ).toBe(false)
  })

  it("does not refresh when no rebuild was requested, even if building was observed and it's deployed", () => {
    expect(
      shouldRefreshAfterRebuild({ requested: false, sawBuilding: true, status: "deployed" }),
    ).toBe(false)
  })

  it("does not refresh while still building", () => {
    expect(
      shouldRefreshAfterRebuild({ requested: true, sawBuilding: true, status: "building" }),
    ).toBe(false)
  })

  it("does not refresh on a failed rebuild", () => {
    expect(
      shouldRefreshAfterRebuild({ requested: true, sawBuilding: true, status: "failed" }),
    ).toBe(false)
  })
})
