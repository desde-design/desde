import { describe, expect, it } from "vitest"
import {
  stepDuration,
  MAX_RENDERED_LOG_CHARS,
  appendLogDelta,
  buildBlockedReason,
  isDeploymentView,
  presentStatus,
  shortSha,
  shouldShowRootAbsoluteWarning,
} from "./build-log-utils"

const DEP = {
  id: "d",
  status: "building",
  commitSha: null,
  buildLog: "",
  warnings: null,
  createdAt: "2026-01-01T00:00:00Z",
}

const WARNING = {
  kind: "root-absolute-assets" as const,
  summary: "1 root-absolute asset reference found in 1 file",
  findings: [{ file: "index.html", kind: "html-attr" as const, sample: '<script src="/a.js">' }],
}

describe("isDeploymentView", () => {
  it("accepts a well-formed deployment", () => {
    expect(isDeploymentView(DEP)).toBe(true)
    expect(isDeploymentView({ ...DEP, commitSha: "abc", status: "deployed" })).toBe(true)
  })
  it("accepts warnings as null or an array, rejects anything else", () => {
    expect(isDeploymentView({ ...DEP, warnings: [WARNING] })).toBe(true)
    expect(isDeploymentView({ ...DEP, warnings: "nope" })).toBe(false)
    expect(isDeploymentView({ ...DEP, warnings: undefined })).toBe(false)
  })
  it("rejects an unknown status and a genuinely missing field", () => {
    expect(isDeploymentView({ ...DEP, status: "queued" })).toBe(false)
    const { createdAt: _createdAt, ...withoutCreatedAt } = DEP
    expect(isDeploymentView(withoutCreatedAt)).toBe(false)
    expect(isDeploymentView(null)).toBe(false)
  })

  it("ACCEPTS a row with no buildLog, which is what a non-owner is sent", () => {
    // This assertion used to say `false`, and that is what shipped the bug:
    // the route omits `buildLog` for anyone who is not an owner or admin
    // (S7), deliberately keeping the deployment HISTORY visible to every
    // project reader. Rejecting those rows here filtered the whole list away
    // client-side, so a member with read access saw "Never deployed" on a
    // project with a full history.
    const { buildLog: _buildLog, ...withoutLog } = DEP
    expect(isDeploymentView(withoutLog)).toBe(true)
  })
})

describe("shouldShowRootAbsoluteWarning", () => {
  const pathMode = { serveDomain: null }
  const subdomainMode = { serveDomain: "proto.example.com" }

  it("shows in path mode for an all-members or invited project", () => {
    expect(
      shouldShowRootAbsoluteWarning({ access: "all-members", publicLinksEnabled: true, ...pathMode }),
    ).toBe(true)
    expect(
      shouldShowRootAbsoluteWarning({ access: "invited", publicLinksEnabled: true, ...pathMode }),
    ).toBe(true)
  })

  it("hides in subdomain-isolation mode regardless of access — each prototype has its own origin", () => {
    expect(
      shouldShowRootAbsoluteWarning({ access: "all-members", publicLinksEnabled: true, ...subdomainMode }),
    ).toBe(false)
    expect(
      shouldShowRootAbsoluteWarning({ access: "public-link", publicLinksEnabled: true, ...subdomainMode }),
    ).toBe(false)
  })

  it("hides for a genuinely public-link project — no credential is needed to begin with", () => {
    expect(
      shouldShowRootAbsoluteWarning({ access: "public-link", publicLinksEnabled: true, ...pathMode }),
    ).toBe(false)
  })

  it("shows for a public-link project when the instance-wide kill switch is off — it behaves like all-members", () => {
    expect(
      shouldShowRootAbsoluteWarning({ access: "public-link", publicLinksEnabled: false, ...pathMode }),
    ).toBe(true)
  })
})

describe("shortSha", () => {
  it("shortens, and shows a dash when a build never resolved one", () => {
    expect(shortSha("0123456789abcdef")).toBe("0123456")
    expect(shortSha(null)).toBe("—")
  })
})

describe("presentStatus", () => {
  it("marks only `building` active, and never returns a raw colour", () => {
    expect(presentStatus("building")).toEqual({ label: "Building", tone: "muted", active: true })
    expect(presentStatus("deployed").active).toBe(false)
    expect(presentStatus("failed").tone).toBe("destructive")
  })
})

describe("appendLogDelta", () => {
  it("appends", () => {
    expect(appendLogDelta("a", "b")).toBe("ab")
  })
  it("trims from the FRONT — the end of a failing build is the interesting part", () => {
    const long = "x".repeat(MAX_RENDERED_LOG_CHARS)
    const out = appendLogDelta(long, "TAIL")
    expect(out.length).toBe(MAX_RENDERED_LOG_CHARS)
    expect(out.endsWith("TAIL")).toBe(true)
    expect(out.startsWith("x")).toBe(true)
  })
})

describe("buildBlockedReason", () => {
  const base = { canManage: true, hasRepo: true, buildsEnabled: true, isBuilding: false }
  it("returns null when a build can start", () => {
    expect(buildBlockedReason(base)).toBeNull()
  })
  it("distinguishes every blocked case rather than returning a bare boolean", () => {
    expect(buildBlockedReason({ ...base, buildsEnabled: false })).toMatch(/GitHub App/)
    expect(buildBlockedReason({ ...base, hasRepo: false })).toMatch(/Connect a GitHub/)
    expect(buildBlockedReason({ ...base, canManage: false })).toMatch(/editors and admins/)
    expect(buildBlockedReason({ ...base, isBuilding: true })).toMatch(/already running/)
  })
  it("leads with the missing repo, not the missing App (Mo, 2026-08-30)", () => {
    // With nothing attached, the next step is the connect flow — which
    // handles the App itself. The App reason only stands where a repo WAS
    // attached (the App-config-lost state).
    expect(
      buildBlockedReason({ canManage: false, hasRepo: false, buildsEnabled: false, isBuilding: true }),
    ).toMatch(/Connect a GitHub/)
  })
})

describe("stepDuration", () => {
  const at = (iso: string) => Date.parse(iso)

  it("reads seconds under a minute and m/s above it", () => {
    expect(
      stepDuration({ name: "Clone", status: "succeeded", startedAt: "2026-08-22T10:00:00.000Z", endedAt: "2026-08-22T10:00:04.000Z" }),
    ).toBe("4s")
    expect(
      stepDuration({ name: "Build", status: "succeeded", startedAt: "2026-08-22T10:00:00.000Z", endedAt: "2026-08-22T10:01:07.000Z" }),
    ).toBe("1m 7s")
  })

  it("measures a RUNNING step against now, so it ticks up instead of reading blank", () => {
    expect(
      stepDuration(
        { name: "Install", status: "running", startedAt: "2026-08-22T10:00:00.000Z" },
        at("2026-08-22T10:00:12.000Z"),
      ),
    ).toBe("12s")
  })

  it("drops to h/m past an hour, because 4833m tells nobody anything", () => {
    // Reached in practice by a RUNNING step measured against now: the
    // gallery's running fixture rendered exactly that before this tier
    // existed.
    expect(
      stepDuration(
        { name: "Build", status: "running", startedAt: "2026-08-19T11:42:24.000Z" },
        at("2026-08-22T20:15:00.000Z"),
      ),
    ).toBe("80h 32m")
  })

  it("never goes negative when the clocks disagree", () => {
    // The timestamps come from the server and `now` from the browser. A
    // client running a few seconds behind would otherwise render "-3s".
    expect(
      stepDuration(
        { name: "Install", status: "running", startedAt: "2026-08-22T10:00:05.000Z" },
        at("2026-08-22T10:00:00.000Z"),
      ),
    ).toBe("0s")
  })

  it("returns null for unparseable timestamps rather than NaN", () => {
    expect(stepDuration({ name: "Clone", status: "succeeded", startedAt: "nope" })).toBeNull()
  })
})
